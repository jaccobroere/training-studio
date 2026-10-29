"""Server-stored assistant proposals (ported from stenen's proposals.py, on sports' change seam).

The assistant's `propose(ops, summary)` dry-runs the ops through `plan.changes.apply_change`
(the same validation the UI gets), then stores a `chat_proposal` row with: the ops, the version
of every row they touch (`expected`) and those rows' before-snapshots, readable lines, a counts
summary, the affected weeks and dates, and a preview of the workouts it adds / removes /
changes in compact chip form, for ghost chips in the Weeks view. A new proposal on a thread
replaces the thread's open one (status `replaced`).

Apply sends only the id. The stored ops are applied as one `chat` change with the stored
`expected` versions, so if any touched row changed since, nothing is written and the proposal
becomes `stale` (409). One change, one undo; undoing it later shows the proposal as `undone`.
"""

from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import ChatProposal, PlanChange
from models.base import utcnow
from plan import changes, series
from plan.changes import (
    ENTITIES,
    PROFILE_KEY,
    ChangeConflict,
    ChangeError,
    current_profile,
    monday_of,
)
from plan.types import MARKS

LIVE_LIMIT = 10  # workouts a live `change` may touch; more becomes a proposal
MAX_LINES = 200

# Ops that name workouts by id list (bulk) and how many workouts each touches.
_BULK = {"set_tags": "ids", "shift_workouts": "ids", "bulk_delete": "ids"}
_ONE = {"add_workout", "update_workout", "move_workout", "delete_workout", "duplicate_workout",
        "set_workout_status", "log_workout", "create_series", "update_series", "end_series"}


def weight(ops: list[dict]) -> int:
    """How many workouts a change set touches, counted from the request (a new series or a
    'this and following' edit counts once, however many occurrences it rewrites)."""
    n = 0
    for o in ops:
        name = o.get("op")
        if name in _BULK:
            n += len(o.get(_BULK[name]) or [])
        elif name == "copy_workout":
            n += len(o.get("dates") or []) + len(o.get("week_mondays") or [])
        elif name in _ONE:
            n += 1
    return n


def is_noise(d: dict) -> bool:
    return d["key"].startswith("series:") and d["fields"] == ["materialised_through"]


def lines_of(diffs: list[dict]) -> list[str]:
    raw = [changes.describe(d) for d in diffs if not is_noise(d)]
    counts: dict[str, int] = {}
    for line in raw:  # identical "Edited X (tags)" lines read better as one line with a count
        counts[line] = counts.get(line, 0) + 1
    out = [f"{line} ×{counts[line]}" if counts[line] > 1 else line for line in dict.fromkeys(raw)]
    return out[:MAX_LINES] + ([f"… and {len(out) - MAX_LINES} more"] if len(out) > MAX_LINES else [])


def item_text(i: dict, names: dict[str, str] | None = None) -> str:
    """"Back squat 3×5 · 80 kg", "Easy run 8 km · easy" — how items read on chips."""
    out = i.get("name") or (names or {}).get(i.get("exercise_id"), i.get("exercise_id", ""))
    dose = ""
    if i.get("sets") and i.get("reps"):
        dose = f"{i['sets']}×{i['reps']}"
    elif i.get("sets"):
        dose = f"{i['sets']}×"
    elif i.get("reps"):
        dose = str(i["reps"])
    for k, unit in (("distance_km", "km"), ("duration_min", "min")):
        if i.get(k) is not None:
            dose = f"{dose} {i[k]:g} {unit}".strip()
    extra = " · ".join(str(i[k]) for k in ("load", "intensity") if i.get(k))
    return " ".join(x for x in (out, dose) if x) + (f" · {extra}" if extra else "")


def chip(snap: dict, names: dict[str, str]) -> dict:
    d = snap.get("date")
    return {"id": snap["id"], "date": d, "time": snap.get("time"), "week_monday": snap["week_monday"],
            "weekday": date.fromisoformat(d).strftime("%a") if d else None,
            "type": snap["type"], "mark": MARKS.get(snap["type"], "OTH"), "title": snap["title"],
            "tags": snap.get("tags") or [], "series_id": snap.get("series_id"),
            "status": snap.get("status", "planned"),
            "items": [item_text(i, names) for i in snap.get("items") or []][:8]}


def preview_of(diffs: list[dict], names: dict[str, str]) -> tuple[dict, dict, list[str], list[str]]:
    """(preview, counts, weeks, dates) from dry-run diffs."""
    added, removed, changed = [], [], []
    dates: set[str] = set()
    weeks: set[str] = set()
    other = 0
    for d in diffs:
        if is_noise(d):
            continue
        if not d["key"].startswith("workout:"):
            other += 1
            continue
        b, a = d["before"], d["after"]
        for s in (b, a):
            if s:
                weeks.add(s["week_monday"])
                if s.get("date"):
                    dates.add(s["date"])
        if d["kind"] == "created":
            added.append(chip(a, names))
        elif d["kind"] == "deleted":
            removed.append(chip(b, names))
        else:
            changed.append({"kind": d["kind"], "fields": d["fields"], "before": chip(b, names),
                            "after": chip(a, names)})
    key = lambda c: (c.get("date") or c.get("week_monday"), c.get("time") or "", c["title"])
    added.sort(key=key)
    removed.sort(key=key)
    changed.sort(key=lambda c: key(c["after"]))
    moved = sum(1 for c in changed if c["kind"] == "moved")
    counts = {"workouts": len(added) + len(removed) + len(changed), "added": len(added),
              "removed": len(removed), "moved": moved, "changed": len(changed) - moved,
              "other": other, "weeks": len(weeks)}
    return {"added": added, "removed": removed, "changed": changed}, counts, sorted(weeks), sorted(dates)


def counts_line(c: dict) -> str:
    parts = [f"{c[k]} {k}" for k in ("added", "moved", "changed", "removed") if c.get(k)]
    if not parts:
        return f"{c.get('other', 0)} library/profile edits" if c.get("other") else "No workout changes"
    s = f"{c['workouts']} workouts ({', '.join(parts)})"
    if c.get("weeks"):
        s += f" across {c['weeks']} week" + ("s" if c["weeks"] != 1 else "")
    return s


def top_up_for(s: Session, ops: list[dict]) -> None:
    """Materialise series up to the furthest date the ops mention, so neither the dry run
    nor the calendar preview triggers a top-up that would make the proposal stale."""
    far = None
    for o in ops:
        for k in ("date", "week_monday", "start_date", "end_date", "from_date"):
            v = o.get(k)
            if isinstance(v, str):
                try:
                    d = date.fromisoformat(v)
                except ValueError:
                    continue
                far = d if far is None or d > far else far
    if far is not None:
        series.top_up(s, monday_of(far))


def dry_run(s: Session, ops: list[dict], inspect=None) -> changes.ChangeResult:
    top_up_for(s, ops)
    return changes.apply_change(s, ops, source="chat", dry_run=True, inspect=inspect)


def create(s: Session, *, thread_id: str, turn_id: str, ops: list[dict], title: str,
           res: changes.ChangeResult) -> ChatProposal:
    names = _names(s)
    preview, counts, weeks, dates = preview_of(res.diffs, names)
    expected = {d["key"]: d["before"]["version"] for d in res.diffs if d["before"] and not is_noise(d)}
    before = {d["key"]: d["before"] for d in res.diffs if not is_noise(d)}
    now = utcnow()
    for old in s.scalars(select(ChatProposal).where(ChatProposal.thread_id == thread_id)
                         .where(ChatProposal.status == "open")):
        old.status, old.decided_at = "replaced", now
    p = ChatProposal(id=f"p-{uuid.uuid4().hex[:12]}", thread_id=thread_id, turn_id=turn_id, created_at=now,
                     status="open", title=title[:300], summary=counts_line(counts), counts=counts, ops=ops,
                     expected=expected, before=before, lines=lines_of(res.diffs), weeks=weeks, dates=dates,
                     preview=preview, kept=res.kept)
    s.add(p)
    s.commit()
    return p


def _names(s: Session) -> dict[str, str]:
    from plan.views import exercise_names

    return exercise_names(s)


def _version(s: Session, key: str) -> int | None:
    if key == PROFILE_KEY:
        cur = current_profile(s)
        return cur.version if cur else None
    kind, ident = key.split(":", 1)
    obj = s.get(ENTITIES[kind][0], ident)
    return (obj.version or 0) if obj is not None else None


def is_stale(s: Session, p: ChatProposal) -> bool:
    return any(_version(s, k) != v for k, v in (p.expected or {}).items())


def status(s: Session, p: ChatProposal, *, check: bool = True) -> str:
    """Current status; an open proposal whose rows moved on is marked stale on sight."""
    if p.status == "open" and check and is_stale(s, p):
        p.status, p.decided_at = "stale", utcnow()
        s.commit()
    if p.status == "applied" and p.change_id:
        row = s.get(PlanChange, p.change_id)
        if row is not None and row.undone_by_id:
            return "undone"
    return p.status


def view(s: Session, p: ChatProposal) -> dict:
    st = status(s, p)
    return {"id": p.id, "thread_id": p.thread_id, "status": st, "title": p.title, "summary": p.summary,
            "counts": p.counts, "lines": p.lines, "weeks": p.weeks, "dates": p.dates,
            "range": {"from": p.weeks[0], "to": p.weeks[-1]} if p.weeks else None,
            "preview": p.preview, "kept": p.kept, "change_id": p.change_id,
            "created_at": p.created_at.isoformat() + "Z",
            "decided_at": p.decided_at.isoformat() + "Z" if p.decided_at else None}


def brief(s: Session, p: ChatProposal) -> str:
    """One line for the model's replay of earlier turns."""
    st = status(s, p)
    words = {"open": "still open (not applied)", "applied": "applied by the athlete",
             "discarded": "discarded by the athlete", "replaced": "replaced by a newer proposal",
             "stale": "stale (the plan changed since; never applied)",
             "undone": "applied, then undone by the athlete"}
    return f"proposal {p.id} \"{p.title or p.summary}\": {words.get(st, st)}"


class ProposalError(Exception):
    def __init__(self, status_code: int, code: str, detail: str, **extra):
        super().__init__(detail)
        self.status_code, self.code, self.detail, self.extra = status_code, code, detail, extra

    def as_dict(self) -> dict:
        return {"code": self.code, "detail": self.detail, **self.extra}


def get(s: Session, pid: str) -> ChatProposal:
    p = s.get(ChatProposal, pid)
    if p is None:
        raise ProposalError(404, "proposal_not_found", "No such proposal")
    return p


def apply(s: Session, p: ChatProposal) -> dict:
    st = status(s, p)
    if st == "stale":
        raise ProposalError(409, "stale", "The plan changed since this was proposed; ask again.")
    if st != "open":
        raise ProposalError(409, "not_open", f"This proposal is {st}.", status=st)
    pid, title = p.id, p.title or p.summary
    try:
        res = changes.apply_change(s, p.ops, source="chat", reason=f"Assistant proposal: {title}"[:2000],
                                   expected=p.expected, op_id=f"proposal:{pid}")
    except ChangeConflict as e:
        p = s.get(ChatProposal, pid)
        p.status, p.decided_at = "stale", utcnow()
        s.commit()
        raise ProposalError(409, "stale", "The plan changed since this was proposed; ask again.",
                            key=e.extra.get("key")) from e
    except ChangeError as e:
        p = s.get(ChatProposal, pid)
        if e.code in ("duplicate_id",) or e.code.endswith("_not_found"):
            p.status, p.decided_at = "stale", utcnow()
            s.commit()
            raise ProposalError(409, "stale", "The plan changed since this was proposed; ask again.",
                                cause=e.code) from e
        raise ProposalError(422, e.code, e.detail, **e.extra) from e
    p = s.get(ChatProposal, pid)
    p.status, p.decided_at, p.change_id = "applied", utcnow(), res.change_id
    s.commit()
    return {"proposal": view(s, p), "change": res.as_dict()}


def discard(s: Session, p: ChatProposal) -> dict:
    st = status(s, p, check=False)
    if st not in ("open", "stale"):
        raise ProposalError(409, "not_open", f"This proposal is {st}.", status=st)
    p.status, p.decided_at = "discarded", utcnow()
    s.commit()
    return view(s, p)


def change_brief(s: Session, change_id: str) -> str | None:
    row = s.get(PlanChange, change_id)
    if row is None:
        return None
    st = "later undone" if row.undone_by_id else "still in place"
    return f"change {row.id} \"{row.summary}\": applied live, {st}"

