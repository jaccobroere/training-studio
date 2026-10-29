"""The single history seam. Every plan-side write — UI, chat, Garmin auto-link, undo, series
top-up, new-account provisioning — goes through `apply_change`, so there is exactly one place
that validates, versions and records.

A change is a list of small ops (plan/ops.py registers them; payloads are pydantic models).
Inside one transaction every row an op touches is snapshotted on first touch (before), the
ops run, rows are snapshotted again (after), versions are bumped on rows that really changed,
and one immutable `plan_change` row is written. Bulk ops are just ops that touch many rows, so
a bulk action is one change and one undo. Undo is a *new* change built from the snapshots
(internal `_put` ops), so history is never rewritten and undo is itself undoable.

Entity keys: "workout:<id>", "series:<id>", "saved:<id>", "exercise:<id>", "activity:<id>",
and "profile:doc" (the Profile; its version is the document version).

Stale writes: callers pass `expected` = {key: version they read}; a mismatch is a 409 with
code "stale" and nothing is written. `dry_run` validates and diffs, then rolls back (chat
proposals, previews).

Activities: device values are the importer's; the seam only ever changes a recording's link
and annotations (workout_id, rpe, notes, skipped_items, kept_unplanned, type_override). Manual activities
are created and deleted here (one-tap Done, Log activity, the merge after auto-link).

Sources: ui, chat, import (auto-link after a Garmin import), undo, system. `system` is for
writes nobody asked for — series top-up and provisioning. They are recorded like everything
else (so undo conflict detection stays truthful), but `HIDDEN_SOURCES` keeps them out of the
history list and they cannot be undone. Top-up only runs when a series needs a new week (the
horizon is "Sunday of the week 12 weeks ahead", so at most about one hidden change per week),
and a no-op top-up writes nothing. Undoing "set up series" after the horizon moved still works:
`materialised_through` is bookkeeping (not drift), and the occurrences top-ups added later
go with the series (unless one was logged, which is a 409).
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any

from pydantic import BaseModel, ValidationError
from sqlalchemy import Date, DateTime, select
from sqlalchemy.orm import Session

from models import Activity, Exercise, PlanChange, ProfileDoc, SavedWorkout, Series, Workout
from models.base import utcnow
from plan.fmt import day_label

SOURCES = ("ui", "chat", "import", "undo", "system")
HIDDEN_SOURCES = ("system",)

ENTITIES: dict[str, tuple[type, tuple[str, ...]]] = {
    "workout": (Workout, ("id", "week_monday", "date", "time", "position", "title", "type", "tags", "notes",
                          "items", "media", "status", "skip_reason", "series_id", "series_date",
                          "customised")),
    "series": (Series, ("id", "title", "type", "time", "tags", "notes", "items", "media", "rule",
                        "start_date", "end_date", "materialised_through")),
    "saved": (SavedWorkout, ("id", "title", "type", "time", "tags", "notes", "items", "media")),
    "exercise": (Exercise, ("id", "name", "type", "default_measure", "notes", "media", "archived")),
    "activity": (Activity, ("id", "source", "source_id", "sport", "name", "local_date", "start_utc",
                            "tz_offset_min", "duration_s", "distance_m", "workout_id", "rpe", "notes",
                            "skipped_items", "kept_unplanned", "sets", "type_override")),
}
PROFILE_KEY = "profile:doc"
BOOKKEEPING = {"series": {"materialised_through"}}  # moved by top-ups, never by an athlete's edit


class ChangeError(Exception):
    """A change that cannot be applied. `code` is stable for clients; `detail` is for humans."""

    status = 422

    def __init__(self, code: str, detail: str = "", **extra: Any):
        super().__init__(detail or code)
        self.code, self.detail, self.extra = code, detail, extra

    def as_dict(self) -> dict:
        return {"code": self.code, "detail": self.detail, **self.extra}


class ChangeConflict(ChangeError):
    """The entity changed since the caller read it (stale version, or undo after later edits)."""

    status = 409


@dataclass
class ChangeResult:
    change_id: str | None
    summary: str
    diffs: list[dict]
    weeks: list[str]
    applied: bool
    at: str | None = None
    kept: list[dict] = field(default_factory=list)
    projected: Any = None

    def as_dict(self) -> dict:
        return {"change_id": self.change_id, "summary": self.summary, "diffs": self.diffs,
                "weeks": self.weeks, "applied": self.applied, "at": self.at, "kept": self.kept}


# ---------------------------------------------------------------- snapshots

def _iso(v: Any) -> Any:
    return v.isoformat() if isinstance(v, (date, datetime)) else v


def snap(kind: str, obj: Any) -> dict | None:
    if obj is None:
        return None
    d = {f: _iso(getattr(obj, f)) for f in ENTITIES[kind][1]}
    d["version"] = obj.version or 0
    return d


def coerce(model: type, f: str, v: Any) -> Any:
    """Snapshot value (ISO strings for dates) → column value."""
    if v is None or v == "":
        col = model.__table__.columns[f]
        return None if isinstance(col.type, (Date, DateTime)) else v
    col_type = model.__table__.columns[f].type
    if isinstance(col_type, DateTime) and not isinstance(v, datetime):
        return datetime.fromisoformat(str(v))
    if isinstance(col_type, Date) and not isinstance(v, date):
        return date.fromisoformat(str(v))
    return v


def monday_of(d: date) -> date:
    return d - timedelta(days=d.weekday())


def current_profile(db: Session) -> ProfileDoc | None:
    return db.scalars(select(ProfileDoc).order_by(ProfileDoc.version.desc())).first()


# ---------------------------------------------------------------- the transaction

class Tx:
    """One change in progress. Ops load rows through it so every touched row is snapshotted
    (and version-checked) exactly once, before its first modification."""

    def __init__(self, db: Session, expected: dict[str, int], source: str):
        self.db, self.expected, self.source = db, expected, source
        self.rows: dict[str, Any] = {}
        self.before: dict[str, dict | None] = {}
        self.kept: list[dict] = []
        self.profile_new: str | None = None

    def _check(self, key: str, actual: int | None) -> None:
        if key in self.expected and self.expected[key] != actual:
            raise ChangeConflict("stale", f"{key} changed since it was read", key=key,
                                 expected=self.expected[key], actual=actual)

    def _register(self, kind: str, obj: Any) -> Any:
        key = f"{kind}:{obj.id}"
        if key not in self.rows:
            self.rows[key] = obj
            self.before[key] = snap(kind, obj)
            self._check(key, obj.version or 0)
        return self.rows[key]

    def get(self, kind: str, ident: str, *, must_exist: bool = True) -> Any:
        key = f"{kind}:{ident}"
        if key not in self.rows:
            obj = self.db.get(ENTITIES[kind][0], ident)
            self.rows[key] = obj
            self.before[key] = snap(kind, obj)
            self._check(key, (obj.version or 0) if obj is not None else None)
        obj = self.rows[key]
        if obj is None and must_exist:
            raise ChangeError(f"{kind}_not_found", f"No {kind} {ident}", id=ident)
        return obj

    def query(self, kind: str, stmt) -> list:
        """Run a select over one entity and register every row it returns."""
        return [self._register(kind, o) for o in self.db.scalars(stmt).all()
                if f"{kind}:{o.id}" not in self.rows or self.rows[f"{kind}:{o.id}"] is not None]

    def add(self, kind: str, obj: Any) -> Any:
        if self.get(kind, obj.id, must_exist=False) is not None:
            raise ChangeError("duplicate_id", f"{kind} {obj.id} already exists", id=obj.id)
        obj.version = 0
        self.db.add(obj)
        self.rows[f"{kind}:{obj.id}"] = obj
        return obj

    def delete(self, kind: str, ident: str) -> None:
        obj = self.get(kind, ident)
        self.db.delete(obj)
        self.rows[f"{kind}:{ident}"] = None

    def profile(self) -> str:
        if PROFILE_KEY not in self.before:
            cur = current_profile(self.db)
            self.before[PROFILE_KEY] = {"markdown": cur.markdown, "version": cur.version} if cur else None
            self._check(PROFILE_KEY, cur.version if cur else None)
        if self.profile_new is not None:
            return self.profile_new
        b = self.before[PROFILE_KEY]
        return b["markdown"] if b else ""

    def set_profile(self, markdown: str) -> None:
        self.profile()
        self.profile_new = markdown

    def after(self, key: str) -> dict | None:
        if key == PROFILE_KEY:
            b = self.before[key]
            if self.profile_new is None or (b and b["markdown"] == self.profile_new):
                return b
            return {"markdown": self.profile_new, "version": (b["version"] if b else 0) + 1}
        return snap(key.split(":", 1)[0], self.rows[key])


# ---------------------------------------------------------------- op registry

OpFn = Callable[[Tx, Any], None]
OPS: dict[str, tuple[type[BaseModel], OpFn]] = {}
INTERNAL_OPS: dict[str, tuple[type[BaseModel] | None, OpFn, tuple[str, ...]]] = {}


def op(name: str, schema: type[BaseModel]):
    def deco(fn: OpFn) -> OpFn:
        OPS[name] = (schema, fn)
        return fn
    return deco


def internal(name: str, *sources: str):
    def deco(fn: OpFn) -> OpFn:
        INTERNAL_OPS[name] = (None, fn, sources)
        return fn
    return deco


def _run(tx: Tx, raw: dict, source: str) -> None:
    name = raw.get("op") if isinstance(raw, dict) else None
    if name in OPS:
        schema, fn = OPS[name]
        try:
            payload = schema.model_validate(raw)
        except ValidationError as e:
            errs = [{"loc": ".".join(str(x) for x in err["loc"]), "msg": err["msg"]}
                    for err in e.errors()[:5]]
            raise ChangeError("invalid_op", f"{name}: {errs[0]['loc']} {errs[0]['msg']}",
                              op=name, errors=errs) from e
        fn(tx, payload)
        return
    if name in INTERNAL_OPS and source in INTERNAL_OPS[name][2]:
        INTERNAL_OPS[name][1](tx, raw)
        return
    raise ChangeError("unknown_op", f"Unknown op {name!r}")


@internal("_put", "undo")
def _op_put(tx: Tx, raw: dict) -> None:
    """Write snapshot fields back verbatim (undo only). fields=None deletes the row."""
    key: str = raw["key"]
    kind, ident = key.split(":", 1)
    fields = raw.get("fields")
    if kind == "profile":
        tx.set_profile((fields or {}).get("markdown", ""))
        return
    model = ENTITIES[kind][0]
    obj = tx.get(kind, ident, must_exist=False)
    if fields is None:
        if obj is not None:
            tx.delete(kind, ident)
        return
    vals = {f: coerce(model, f, v) for f, v in fields.items() if f not in ("id", "version")}
    if obj is None:
        tx.add(kind, model(id=ident, **vals))
        return
    for f, v in vals.items():
        setattr(obj, f, v)


# ---------------------------------------------------------------- diffs + summaries

def _diff(key: str, before: dict | None, after: dict | None) -> dict | None:
    if before is None and after is None:
        return None
    if before is None:
        return {"key": key, "kind": "created", "before": None, "after": after, "fields": []}
    if after is None:
        return {"key": key, "kind": "deleted", "before": before, "after": None, "fields": []}
    fields = [f for f in after if f != "version" and before.get(f) != after.get(f)]
    if not fields:
        return None
    kind = "updated"
    if key.startswith("workout:") and ({"date", "week_monday"} & set(fields)
                                       or "time" in fields and set(fields) <= {"time", "position"}):
        kind = "moved"  # a new time of day is a move too
    elif key.startswith("workout:") and set(fields) <= {"status", "skip_reason"}:
        kind = "status"
    elif key.startswith("activity:") and "workout_id" in fields:
        kind = "linked" if after.get("workout_id") else "unlinked"
    return {"key": key, "kind": kind, "before": before, "after": after, "fields": fields}


def _place(s: dict) -> str:
    if s.get("date"):
        return day_label(date.fromisoformat(s["date"])) + (f" {s['time']}" if s.get("time") else "")
    return "no day (wk " + date.fromisoformat(s["week_monday"]).strftime("%-d %b") + ")"


def describe(d: dict) -> str:
    kind, b, a = d["kind"], d["before"], d["after"]
    s = a or b
    ent = d["key"].split(":", 1)[0]
    if ent == "profile":
        return "Edited the Profile"
    if ent == "workout":
        name = s["title"]
        if kind == "created":
            return f"Added {name} · {_place(a)}"
        if kind == "deleted":
            return f"Removed {name} · {_place(b)}"
        if kind == "moved":
            return f"Moved {name} · {_place(b)} → {_place(a)}"
        if kind == "status":
            return f"Skipped {name}" if a["status"] == "skipped" else f"Reset {name} to planned"
        return f"Edited {name} ({', '.join(d['fields'])})"
    if ent == "activity":
        name = s["name"] or s["sport"]
        if kind == "created":
            return f"Logged {name} · {day_label(date.fromisoformat(a['local_date']))}"
        if kind == "deleted":
            return f"Removed activity {name}"
        if kind == "linked":
            return f"Linked {name} to a workout"
        if kind == "unlinked":
            return f"Unlinked {name}"
        return f"Annotated {name}"
    label = {"series": "repeating workout", "saved": "saved workout", "exercise": "exercise"}[ent]
    name = s.get("title") or s.get("name")
    if kind == "created":
        return f"Added {label} {name}"
    if kind == "deleted":
        return f"Removed {label} {name}"
    if ent == "series" and d["fields"] == ["materialised_through"]:
        return f"Planned {name} ahead"
    if ent == "series" and "end_date" in d["fields"] and a.get("end_date"):
        return f"Ended {label} {name} after {day_label(date.fromisoformat(a['end_date']))}"
    if ent == "exercise" and d["fields"] == ["archived"]:
        return f"{'Archived' if a['archived'] else 'Restored'} exercise {name}"
    return f"Edited {label} {name}"


def summarise(diffs: list[dict]) -> str:
    workouts = [d for d in diffs if d["key"].startswith("workout:")]
    others = [d for d in diffs if not d["key"].startswith("workout:")]
    lines = [describe(d) for d in others[:3]]
    if len(others) > 3:
        lines.append(f"{len(others) - 3} more")
    if len(workouts) > 4:  # bulk: counts read better than a list
        kinds: dict[str, int] = {}
        for d in workouts:
            kinds[d["kind"]] = kinds.get(d["kind"], 0) + 1
        verbs = {"created": "added", "deleted": "removed", "moved": "moved", "status": "status changes",
                 "updated": "edited"}
        n_weeks = len({w for d in workouts for w in _weeks_of(d)})
        parts = ", ".join(f"{n} {verbs[k]}" for k, n in sorted(kinds.items(), key=lambda kv: -kv[1]))
        lines.append(f"{len(workouts)} workouts ({parts}) across {n_weeks} week"
                     + ("s" if n_weeks != 1 else ""))
    else:
        lines = [describe(d) for d in workouts] + lines
    return "; ".join(lines) if lines else "No changes"


def _weeks_of(d: dict) -> set[str]:
    ent = d["key"].split(":", 1)[0]
    out = set()
    for s in (d["before"], d["after"]):
        if not s:
            continue
        if ent == "workout":
            out.add(s["week_monday"])
        elif ent == "activity":
            out.add(monday_of(date.fromisoformat(s["local_date"])).isoformat())
    return out


def _sort_key(d: dict) -> tuple:
    order = ("profile", "series", "workout", "activity", "saved", "exercise")
    ent = d["key"].split(":", 1)[0]
    s = d["after"] or d["before"] or {}
    when = (s.get("date") or s.get("week_monday") or s.get("local_date") or "", s.get("time") or "") if ent in ("workout", "activity") else ("", "")
    return (order.index(ent), when, d["key"])


# ---------------------------------------------------------------- public API

def apply_change(db: Session, ops: list[dict], *, source: str, reason: str = "",
                 expected: dict[str, int] | None = None, op_id: str | None = None,
                 turn_id: str | None = None, dry_run: bool = False,
                 _undoes: str | None = None, inspect=None) -> ChangeResult:
    """Validate and apply `ops` atomically. `inspect(db, weeks)` runs before commit/rollback
    (e.g. projected week totals for a chat proposal)."""
    if source not in SOURCES:
        raise ChangeError("bad_source", f"source must be one of {SOURCES}")
    if not ops:
        raise ChangeError("no_ops", "Nothing to apply")
    if op_id and not dry_run:
        existing = db.scalars(select(PlanChange).where(PlanChange.op_id == op_id)).first()
        if existing is not None:
            return _result_from_row(existing)

    tx = Tx(db, expected or {}, source)
    try:
        for raw in ops:
            _run(tx, raw, source)
            db.flush()
        changed = {k for k in tx.before.keys() | tx.rows.keys()
                   if _diff(k, tx.before.get(k), tx.after(k))}
        if not changed:
            db.rollback()
            return ChangeResult(None, "No changes", [], [], applied=False, kept=tx.kept)

        now = utcnow()
        for key in changed:
            obj = tx.rows.get(key)
            if obj is not None:
                obj.version = (obj.version or 0) + 1
                if hasattr(obj, "updated_at") and not key.startswith("activity:"):
                    obj.updated_at = now
        db.flush()
        before = {k: tx.before.get(k) for k in changed}
        after = {k: tx.after(k) for k in changed}
        diffs = sorted((d for k in changed if (d := _diff(k, before[k], after[k]))), key=_sort_key)
        weeks = sorted({w for d in diffs for w in _weeks_of(d)})
        summary = summarise(diffs)
        seen = inspect(db, weeks) if inspect else None
        if dry_run:
            db.rollback()
            return ChangeResult(None, summary, diffs, weeks, applied=False, kept=tx.kept, projected=seen)

        if PROFILE_KEY in changed:
            db.add(ProfileDoc(version=after[PROFILE_KEY]["version"], markdown=tx.profile_new,
                              at=now, source=source, reason=reason[:500]))
        row = PlanChange(id=f"c-{uuid.uuid4().hex[:12]}", at=now, source=source,
                         reason=reason[:2000], summary=summary, weeks=weeks, ops=ops,
                         before=before, after=after, undoes_id=_undoes, op_id=op_id,
                         turn_id=turn_id)
        db.add(row)
        if _undoes:
            target = db.get(PlanChange, _undoes)
            if target is not None:
                target.undone_by_id = row.id
        db.commit()
        res = _result_from_row(row)
        res.kept, res.projected = tx.kept, seen
        return res
    except Exception:
        db.rollback()
        raise


def _result_from_row(row: PlanChange) -> ChangeResult:
    diffs = sorted((d for k in row.after if (d := _diff(k, row.before.get(k), row.after.get(k)))),
                   key=_sort_key)
    return ChangeResult(row.id, row.summary, diffs, list(row.weeks), applied=True,
                        at=row.at.isoformat() + "Z")


def _current(db: Session, key: str) -> dict | None:
    kind, ident = key.split(":", 1)
    if kind == "profile":
        cur = current_profile(db)
        return {"markdown": cur.markdown, "version": cur.version} if cur else None
    return snap(kind, db.get(ENTITIES[kind][0], ident))


def _later_occurrences(db: Session, series_id: str, logged_in_change: dict) -> list[dict]:
    """Delete ops for a series' rows that the undone change did not create (top-ups did).
    A logged one blocks the undo: the athlete's history is never deleted."""
    out = []
    for w in db.scalars(select(Workout).where(Workout.series_id == series_id)).all():
        if f"workout:{w.id}" in logged_in_change:
            continue
        if db.scalars(select(Activity.id).where(Activity.workout_id == w.id)).first() is not None:
            raise ChangeConflict("conflict", f"{w.title} was logged since", key=f"workout:{w.id}")
        out.append({"op": "_put", "key": f"workout:{w.id}", "fields": None})
    return out


def undo(db: Session, change_id: str, *, op_id: str | None = None) -> ChangeResult:
    """Revert exactly the fields change `change_id` changed, if they still hold its values.
    Anything edited since is a conflict (409); nothing is half-undone."""
    row = db.get(PlanChange, change_id)
    if row is None:
        raise ChangeError("change_not_found", f"No change {change_id}")
    if row.source in HIDDEN_SOURCES:
        raise ChangeError("not_undoable", "Automatic changes cannot be undone")
    if row.undone_by_id:
        raise ChangeError("already_undone", "This change was already undone",
                          undone_by=row.undone_by_id)
    ops: list[dict] = []
    for key, after in row.after.items():
        before = row.before.get(key)
        cur = _current(db, key)
        name = (after or before or {}).get("title") or (after or before or {}).get("name") or key
        if key == PROFILE_KEY:
            if cur is None or cur["version"] != after["version"]:
                raise ChangeConflict("conflict", "The Profile was edited since", key=key)
            ops.append({"op": "_put", "key": key,
                        "fields": {"markdown": before["markdown"] if before else ""}})
            continue
        if after is None:
            if cur is not None:
                raise ChangeConflict("conflict", f"{name} was re-created since", key=key)
            ops.append({"op": "_put", "key": key, "fields": before})
            continue
        if before is None:
            if cur is None:
                continue
            skip = BOOKKEEPING.get(key.split(":", 1)[0], set())
            drift = [f for f in after if f != "version" and f not in skip and cur.get(f) != after.get(f)]
            if drift:
                raise ChangeConflict("conflict", f"{name} was edited since", key=key, fields=drift)
            ops.append({"op": "_put", "key": key, "fields": None})
            if key.startswith("series:"):  # rows top-ups created later belong to it too
                ops.extend(_later_occurrences(db, key.split(":", 1)[1], row.after))
            continue
        if cur is None:
            raise ChangeConflict("conflict", f"{name} was removed since", key=key)
        skip = BOOKKEEPING.get(key.split(":", 1)[0], set())
        changed = [f for f in after if f != "version" and f not in skip and before.get(f) != after.get(f)]
        drift = [f for f in changed if cur.get(f) != after.get(f)]
        if drift:
            raise ChangeConflict("conflict", f"{name} was edited since", key=key, fields=drift)
        ops.append({"op": "_put", "key": key, "fields": {f: before[f] for f in changed}})
    if not ops:
        raise ChangeError("nothing_to_undo", "Nothing left to undo")
    return apply_change(db, ops, source="undo", reason=f"Undo {row.summary}", op_id=op_id,
                        _undoes=row.id)


from plan import ops as _ops  # noqa: E402,F401  (registers the ops)
