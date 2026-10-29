"""Assistant tools: thin, typed wrappers over the same domain functions the UI uses.

Reads return compact JSON with weekday-resolved dates, ids and versions, and per-week planned
vs actual totals computed here, so the model never does date or weekly arithmetic.

Writes are change sets over the UI's own ops (plan/ops.py is the one schema), through
`plan.changes.apply_change` with source="chat":
- `change(ops, reason)` applies a small, clearly asked change live (one change, one undo).
  A set touching more than 10 workouts is stored as a proposal instead.
- `propose(ops, summary)` dry-runs and stores a server-side proposal (chat/proposals.py) that
  the athlete applies or discards from the card; it replaces the thread's open proposal.
Chat-only guards: deleting a logged (manual) activity needs `delete_logged_confirmed`; image
media must be a file the athlete uploaded; `attach_link` adds a link to an entity's media
without having to resend the existing list.

Every result carries `label`, `source` and a one-line `summary` for the tool-step UI.
Tool output is data for the model, not instructions.
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass, field
from datetime import date, timedelta
from difflib import SequenceMatcher
from pathlib import Path
from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field
from pydantic_ai import RunContext
from sqlalchemy import func, select

import db
from chat import proposals as props
from models import Activity, Exercise, MediaFile, PlanChange, SavedWorkout, Series, Workout
from plan import changes, clock, link, series, views
from plan.changes import HIDDEN_SOURCES, ChangeError, current_profile, monday_of
from plan.ops import PUBLIC
from plan.types import TYPES

PLAN, GARMIN, GUIDE, WEB, PROFILE = "Your plan", "Garmin data", "Coaching guide", "Web", "Your profile"


PIN_TOOLS = ("pin_analysis", "update_pinned", "unpin_analysis")


def landed_kinds(tool_name: str, content: object) -> set[str]:
    """The kinds of write (chat/claims.py) a tool result stands for, if it landed: a `change` /
    `undo_change` that saved, a pin tool that wrote, a stored proposal (`propose`, or a `change`
    converted to one). The same rules ChatDeps.landed follows during a turn, so stored history
    can be judged from the results alone, reply by reply."""
    if not isinstance(content, dict):
        return set()
    if tool_name in ("change", "undo_change") and content.get("saved") is True and content.get("change_id"):
        return {"plan"}
    if tool_name in PIN_TOOLS and content.get("ok") is True and content.get("pinned_id"):
        return {"pin"}
    if tool_name in ("propose", "change") and content.get("proposal_id"):
        return {"proposal"}
    return set()


@dataclass
class ChatDeps:
    """Captured at the start of each turn. Tools act on explicit arguments; the scope is
    context only, so navigating away mid-turn can never redirect an edit."""

    conversation_id: str
    turn_id: str
    scope: dict[str, Any]
    now_local: str
    applied: list[str] = field(default_factory=list)  # change ids that landed this turn
    proposals: list[str] = field(default_factory=list)  # proposal ids stored this turn
    replay: str = ""  # status now of this thread's earlier proposals and changes
    # Sources seen this turn, so citation numbers are unique across parallel searches.
    sources: dict[str, int] = field(default_factory=dict)
    # URLs web_fetch may open this turn: web_search results (added as they arrive) and links
    # in the athlete's own message (chat/research_tools.py). Normalised, see `fetch_key`.
    fetchable: set[str] = field(default_factory=set)
    user_text: str = ""  # the athlete's message this turn (links in it are fetchable)
    analysis_runs: int = 0  # sandbox runs this turn (capped in chat/analysis_tools.py)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def cite(self, url: str) -> int:
        with self.lock:
            return self.sources.setdefault(url, len(self.sources) + 1)

    def landed(self) -> set[str]:
        """Kinds of write that landed this turn (chat/claims.py): plan edits, pins, proposals."""
        kinds = set()
        if any(not a.startswith("pin:") for a in self.applied):
            kinds.add("plan")
        if any(a.startswith("pin:") for a in self.applied):
            kinds.add("pin")
        if self.proposals:
            kinds.add("proposal")
        return kinds


class AttachLink(BaseModel):
    """Chat-only convenience: append a demo/reference link to an entity's media list."""

    model_config = ConfigDict(extra="forbid")
    op: Literal["attach_link"]
    target: Literal["exercise", "workout", "series", "saved"]
    id: str
    url: str = Field(pattern=r"^https?://\S+$", max_length=2000)
    title: str = Field("", max_length=200)


OP_ALIASES = {"add": "add_workout", "create_workout": "add_workout", "new_workout": "add_workout",
              "update": "update_workout", "edit_workout": "update_workout", "move": "move_workout",
              "delete": "delete_workout", "remove_workout": "delete_workout"}


def infer_op(v: Any) -> Any:
    """Forgive a missing or loosely named `op` when the payload can only mean one thing: a dict
    with a title, a type and a place (date / week_monday / from_saved) is an add_workout; an id
    with `fields` is an update_workout. Anything else is left to validation (and its message)."""
    if not isinstance(v, dict):
        return v
    op = v.get("op")
    if isinstance(op, str):
        name = op.strip().lower().replace("-", "_").replace(" ", "_")
        return {**v, "op": OP_ALIASES.get(name, name)} if name != op or name in OP_ALIASES else v
    if op is None:
        if "fields" in v and "id" in v:
            return {**v, "op": "update_workout"}
        if "title" in v and "type" in v and any(k in v for k in ("date", "week_monday", "from_saved")):
            return {**v, "op": "add_workout"}
    return v


Op = Annotated[Union[tuple([*PUBLIC, AttachLink])], Field(discriminator="op"), BeforeValidator(infer_op)]  # noqa: UP007


# ------------------------------------------------------------------ helpers

def meta(label: str, source: str, summary: str, **out: Any) -> dict:
    """Tool-step metadata first, then the payload."""
    return {"label": label, "source": source, "summary": summary, **out}


ERR_HINTS = {"exercise_not_found": "Use one of the similar ids if given, else search list_exercises(query). "
                                   "Don't create a new exercise to get past this unless the athlete asked."}


def _err(e: ChangeError, label: str = "Change failed") -> dict:
    out = meta(label, PLAN, e.detail or e.code, ok=False, error=e.code, detail=e.detail, **e.extra)
    if e.code in ERR_HINTS:
        out["next"] = ERR_HINTS[e.code]
    return out


def week_no(monday: str | date) -> int:
    d = date.fromisoformat(monday) if isinstance(monday, str) else monday
    return d.isocalendar()[1]


def weeks_label(mondays: list[str]) -> str:
    if not mondays:
        return ""
    a, b = week_no(mondays[0]), week_no(mondays[-1])
    return f"week {a}" if a == b else f"weeks {a}–{b}"


def short_date(d: str) -> str:
    return date.fromisoformat(d).strftime("%-d %b")


def item_text(i: dict) -> str:
    return props.item_text(i)


def _workout(w: dict) -> dict:
    out = {"id": w["id"], "version": w["version"], "date": w["date"] or "no day",
           "weekday": date.fromisoformat(w["date"]).strftime("%a") if w["date"] else None,
           "type": w["type"], "title": w["title"], "state": w["state"],
           "items": [{"id": i["id"], "text": item_text(i)} for i in w["items"]]}
    if w.get("time"):
        out["time"] = w["time"]
    if not w["date"]:
        out["week_monday"] = w["week_monday"]
    for k in ("tags", "notes", "skip_reason", "series_id"):
        if w.get(k):
            out[k] = w[k]
    if w.get("media"):
        out["media"] = w["media"]
    if w["customised"]:
        out["customised"] = True
    p = {k: v for k, v in w["planned"].items() if v is not None}
    if p:
        out["planned"] = p
    if w["activities"]:
        out["activities"] = [_activity(a) for a in w["activities"]]
    return out


def _activity(a: dict) -> dict:
    out = {k: v for k, v in a.items() if k in ("id", "version", "source", "type", "name", "date", "duration_min",
                                               "distance_km", "avg_hr", "rpe", "notes", "skipped_items", "sets",
                                               "workout_id") and v not in (None, "", [])}
    if a.get("date"):
        out["weekday"] = date.fromisoformat(a["date"]).strftime("%a")
    return out


def _lines(res: changes.ChangeResult) -> list[str]:
    return props.lines_of(res.diffs)


def _totals(db_, weeks_: list[str]) -> dict:
    """Per-type planned/actual totals of the touched weeks as they are after the change."""
    return {m: views.week_view(db_, date.fromisoformat(m))["totals"] for m in weeks_[:6]}


def _range(start: str, end: str, max_days: int) -> tuple[date, date]:
    s, e = date.fromisoformat(start), date.fromisoformat(end)
    if e < s:
        s, e = e, s
    return s, min(e, s + timedelta(days=max_days))


# ------------------------------------------------------------------ read tools

def get_calendar(ctx: RunContext[ChatDeps], start: str, end: str, tag: str | None = None) -> dict:
    """Planned workouts and activities between two dates (max 16 weeks), grouped by week:
    each day with its weekday, workouts (ids + versions for edits, time "HH:MM" if set — untimed
    ones are listed first, then by time — items, state:
    planned / done / skipped / not_logged, linked activities) and unplanned activities, plus
    per-week totals by type (planned_n/km/min from items vs actual_n/km/min from activities).
    Quote these totals; never add numbers up yourself. `tag` filters to one tag."""
    s, e = monday_of(date.fromisoformat(start)), monday_of(date.fromisoformat(end))
    if e < s:
        s, e = e, s
    e = min(e, s + timedelta(weeks=15))
    weeks_out, n = [], 0
    with db.get_db().session() as db_:
        series.top_up(db_, e + timedelta(days=6))
        m = s
        while m <= e:
            v = views.week_view(db_, m)

            def keep(w: dict) -> bool:
                return not tag or tag in w["tags"]
            days = [{"date": d["date"], "weekday": d["dow"],
                     "workouts": [_workout(w) for w in d["workouts"] if keep(w)],
                     "unplanned": [_activity(a) for a in d["activities"]]}
                    for d in v["days"]]
            days = [d for d in days if d["workouts"] or d["unplanned"]]
            tray = [_workout(w) for w in v["tray"] if keep(w)]
            n += sum(len(d["workouts"]) for d in days) + len(tray)
            weeks_out.append({"monday": v["monday"], "week": week_no(v["monday"]), "current": v["is_current"],
                              "totals": v["totals"], "days": days, "no_day": tray})
            m += timedelta(days=7)
    mondays = [w["monday"] for w in weeks_out]
    return meta("Read the calendar", PLAN, f"{n} workout{'s' if n != 1 else ''} · {weeks_label(mondays)}",
                today=clock.today().isoformat(), weeks=weeks_out)


def get_workout(ctx: RunContext[ChatDeps], workout_id: str) -> dict:
    """One workout in full: items with ids and every field, notes, media, its series, and
    linked activities."""
    with db.get_db().session() as db_:
        w = db_.get(Workout, workout_id)
        if w is None:
            return meta("Read a workout", PLAN, "Not found", ok=False, error="workout_not_found")
        d = views.workout_detail(db_, w)
    place = f"{d['date']} ({date.fromisoformat(d['date']).strftime('%a')})" if d["date"] else "no day"
    return meta("Read a workout", PLAN, f"{d['title']} · {place}", workout=_workout(d), items_full=d["items"],
                series=d["series"])


def list_series(ctx: RunContext[ChatDeps]) -> dict:
    """Repeating workouts: rule (weekdays 0=Mon … 6=Sun, every `interval` weeks), start/end,
    items, and whether they are active."""
    with db.get_db().session() as db_:
        names = views.exercise_names(db_)
        rows = []
        for s in db_.scalars(select(Series).order_by(Series.start_date)):
            v = views.series_view(s, names)
            v["weekdays"] = [("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")[d] for d in s.rule.get("weekdays", [])]
            v["items"] = [{"id": i["id"], "text": item_text(i)} for i in v["items"]]
            rows.append({k: val for k, val in v.items() if k != "mark" and val not in (None, "", [])})
    active = sum(1 for r in rows if r.get("active"))
    return meta("Read repeating workouts", PLAN, f"{len(rows)} series ({active} active)", series=rows)


def _near(query: str, rows: list[Exercise], n: int = 8) -> list[Exercise]:
    """Exercises whose name, id or type is close to a word of the query ("running" → Easy run)."""
    words = [re.sub(r"(.)\1(ing|er|ers|s)$|(ing|er|ers|s)$", r"\1", w) for w in re.findall(r"[a-z0-9]+", query.lower())]
    scored = []
    for e in rows:
        have = re.findall(r"[a-z0-9]+", f"{e.name} {e.id} {e.type}".lower())
        best = max((SequenceMatcher(None, w, h).ratio() for w in words for h in have), default=0)
        if best >= 0.75:
            scored.append((best, e.name, e))
    return [e for _, _, e in sorted(scored, key=lambda t: (-t[0], t[1]))[:n]]


def list_exercises(ctx: RunContext[ChatDeps], query: str | None = None) -> dict:
    """Exercise library (ids for workout items: `exercise_id`), optionally filtered by a word
    in the name or type. Archived exercises are left out. With no exact match you get the
    closest names (`similar`): prefer one of those. Create a new exercise (add_exercise) only
    when the athlete asked for it or nothing in the library is the same activity; never invent
    a generic one just to get past an unknown id."""
    with db.get_db().session() as db_:
        uses = views.exercise_usage(db_)
        all_rows = list(db_.scalars(select(Exercise).order_by(Exercise.name)))

        def row(e: Exercise) -> dict:
            r = {"id": e.id, "version": e.version, "name": e.name, "type": e.type, "measure": e.default_measure}
            if e.media:
                r["media"] = e.media
            if uses.get(e.id):
                r["uses"] = uses[e.id]
            return r

        tokens = re.findall(r"[a-z0-9]+", (query or "").lower())

        def hit(e: Exercise) -> bool:  # every word of the query appears in the name, id or type
            text = f"{e.name} {e.id} {e.type}".lower()
            return all(t in text for t in tokens)

        live = [e for e in all_rows if not e.archived]
        rows = [e for e in live if hit(e)]
        extra: dict[str, Any] = {}
        if query and not rows:
            near = _near(query, live)
            extra["similar"] = [row(e) for e in near]
            gone = [e for e in all_rows if e.archived and hit(e)]
            if gone:
                extra["archived_matches"] = [{"id": e.id, "name": e.name} for e in gone[:5]]
            extra["note"] = ("No exact match; `similar` lists the closest exercises: use one of those ids if it is "
                             "the same activity." if near else
                             "Nothing like that in the library: ask the athlete before adding a new exercise.")
        out = [row(e) for e in rows]
    return meta("Searched exercises" if query else "Read the exercise library", PLAN,
                f"{len(out)} exercise{'s' if len(out) != 1 else ''}" + (f" matching “{query}”" if query else ""),
                exercises=out[:200], **extra)


def list_saved_workouts(ctx: RunContext[ChatDeps]) -> dict:
    """Saved workouts (templates with no date; use their id as add_workout.from_saved)."""
    with db.get_db().session() as db_:
        rows = [{"id": s.id, "version": s.version, "title": s.title, "type": s.type, "time": s.time,
                 "tags": s.tags or [],
                 "items": [item_text(i) for i in views.items_view(s.items, views.exercise_names(db_))]}
                for s in db_.scalars(select(SavedWorkout).order_by(SavedWorkout.title))]
    return meta("Read saved workouts", PLAN, f"{len(rows)} saved workout{'s' if len(rows) != 1 else ''}",
                saved_workouts=rows)


def get_activities(ctx: RunContext[ChatDeps], start: str, end: str, type: str | None = None) -> dict:
    """What actually happened between two dates (max 400 days): recordings and manual
    activities with duration, distance, avg HR, RPE, notes and the workout they belong to.
    `type` is one of run ride swim skate strength mobility walk climb other."""
    s, e = _range(start, end, 400)
    if type and type not in TYPES:
        return meta("Read activities", GARMIN, "Unknown type", ok=False, error="unknown_type", types=list(TYPES))
    with db.get_db().session() as db_:
        q = select(Activity).where(Activity.local_date >= s).where(Activity.local_date <= e)
        if type:
            q = q.where(Activity.sport == type)
        rows = [_activity(views.activity_view(a)) for a in db_.scalars(q.order_by(Activity.start_utc))]
    km = round(sum(r.get("distance_km") or 0 for r in rows), 1)
    mins = round(sum(r.get("duration_min") or 0 for r in rows))
    return meta("Read activities", GARMIN,
                f"{len(rows)} {type + ' ' if type else ''}activit{'ies' if len(rows) != 1 else 'y'} · "
                f"{short_date(s.isoformat())}–{short_date(e.isoformat())}",
                range=[s.isoformat(), e.isoformat()], n=len(rows), total_km=km, total_min=mins,
                activities=rows[-300:], truncated=len(rows) > 300)


def get_inbox(ctx: RunContext[ChatDeps]) -> dict:
    """Recordings waiting to be linked (with candidate workouts) and past workouts not logged."""
    with db.get_db().session() as db_:
        ib = link.inbox(db_)
    rec = [{"activity": _activity(r["activity"]), "ambiguous": r["ambiguous"],
            "candidates": [{"id": c["id"], "date": c["date"], "title": c["title"]} for c in r["candidates"]]}
           for r in ib["recordings"]]
    nl = [_workout(w) for w in ib["not_logged"]]
    return meta("Read the Inbox", PLAN, f"{len(rec)} recordings to link · {len(nl)} not logged",
                recordings=rec, not_logged=nl, window=ib["window"])


def profile_is_empty(markdown: str | None) -> bool:
    """The template's headings and grey prompts only (or nothing at all)."""
    body = re.sub(r"<!--.*?-->", "", markdown or "", flags=re.DOTALL)
    return not any(line.strip() and not line.lstrip().startswith("#") for line in body.splitlines())


def get_profile(ctx: RunContext[ChatDeps]) -> dict:
    """The athlete's Profile (their own goals, availability, training, injuries, preferences)
    with its version. Edit it only with an `update_profile` op the athlete asked for."""
    with db.get_db().session() as db_:
        p = current_profile(db_)
    md = p.markdown if p else ""
    empty = profile_is_empty(md)
    return meta("Read the Profile", PROFILE, "Profile is empty" if empty else f"Profile v{p.version}",
                version=p.version if p else None, empty=empty, markdown=md)


def get_history(ctx: RunContext[ChatDeps], limit: int = 10) -> dict:
    """Recent plan changes (newest first) with change ids for undo_change."""
    with db.get_db().session() as s:
        rows = s.scalars(select(PlanChange).where(PlanChange.source.not_in(HIDDEN_SOURCES))
                         .order_by(PlanChange.at.desc()).limit(min(limit, 30))).all()
        out = [{"change_id": r.id, "at": r.at.isoformat() + "Z", "source": r.source, "summary": r.summary,
                "undone": bool(r.undone_by_id)} for r in rows]
    return meta("Read change history", PLAN, f"{len(out)} recent change{'s' if len(out) != 1 else ''}",
                changes=out)


# ------------------------------------------------------------------ write tools

_MEDIA_TARGET = {"exercise": ("exercise", "update_exercise"), "workout": ("workout", "update_workout"),
                 "series": ("series", "update_series"), "saved": ("saved", "update_saved_workout")}


def _images_in(o: dict) -> list[str]:
    media = (o.get("fields") or {}).get("media") if "fields" in o else o.get("media")
    return [m.get("file", "") for m in media or [] if isinstance(m, dict) and m.get("kind") == "image"]


def prepare(db_, ops: list, delete_logged_confirmed: bool = False) -> list[dict]:
    """Model ops → raw op dicts, with the chat-only expansions and guards."""
    raw = [o.model_dump(mode="json", exclude_unset=True) if isinstance(o, BaseModel) else dict(o) for o in ops]
    out: list[dict] = []
    for o in raw:
        if o.get("op") == "attach_link":
            kind, op_name = _MEDIA_TARGET[o["target"]]
            obj = db_.get(changes.ENTITIES[kind][0], o["id"])
            if obj is None:
                raise ChangeError(f"{kind}_not_found", f"No {kind} {o['id']}", id=o["id"])
            media = [dict(m) for m in obj.media or []]
            if not any(m.get("url") == o["url"] for m in media):
                media.append({"kind": "link", "url": o["url"], "title": o.get("title", "")})
            new = {"op": op_name, "id": o["id"], "fields": {"media": media}}
            out.append(new)
            continue
        if o.get("op") == "delete_activity" and not delete_logged_confirmed:
            raise ChangeError("logged_work_protected", "Deleting a logged activity needs the athlete's explicit "
                              "request; pass delete_logged_confirmed=true only if they asked for exactly this.")
        for f in _images_in(o):
            if db_.scalars(select(func.count()).select_from(MediaFile).where(MediaFile.file == f)).one() == 0:
                raise ChangeError("unknown_image", f"{f} is not an uploaded image; attach links instead.")
        out.append(o)
    return out


def _propose(ctx: RunContext[ChatDeps], raw: list[dict], title: str, label: str) -> dict:
    with db.get_db().session() as s:
        res = props.dry_run(s, raw, inspect=_totals)
        if not res.diffs:
            return meta(label, PLAN, "Nothing to change", ok=True, proposal_id=None,
                        detail="The plan already matches; nothing was proposed.")
        replaced = [p for p in s.scalars(select(props.ChatProposal.id).where(
            props.ChatProposal.thread_id == ctx.deps.conversation_id).where(props.ChatProposal.status == "open"))]
        p = props.create(s, thread_id=ctx.deps.conversation_id, turn_id=ctx.deps.turn_id, ops=raw, title=title,
                         res=res)
        ctx.deps.proposals.append(p.id)
        return meta(label, PLAN, p.summary, ok=True, saved=False, proposal_id=p.id, status="open",
                    title=p.title, lines=p.lines[:25], n_lines=len(p.lines), counts=p.counts, weeks=p.weeks,
                    totals_after=res.projected, kept=res.kept, replaced=replaced,
                    note="Stored as a proposal: nothing is in the plan until the athlete presses Apply. "
                         "The card shows every session and week total: reply briefly (shape, key "
                         "decisions, at most two questions), without repeating them.")


def propose(ctx: RunContext[ChatDeps], ops: list[Op], summary: str) -> dict:
    """Store a change set as a PROPOSAL the athlete reviews (Preview in calendar, Apply,
    Discard) — for drafted blocks and any change touching more than 10 workouts, and for
    speculative or question-phrased requests ("could I…", "what if…"). Nothing is written.
    `summary` is the card's title, e.g. "10K block, weeks 43–52". Re-proposing replaces the
    thread's open proposal. Returns proposal_id, readable lines, counts and per-week totals
    as they would be after applying."""
    try:
        with db.get_db().session() as s:
            raw = prepare(s, ops)
        return _propose(ctx, raw, summary, "Drafted a proposal")
    except ChangeError as e:
        return _err(e, "Proposal failed")


def change(ctx: RunContext[ChatDeps], ops: list[Op], reason: str, delete_logged_confirmed: bool = False) -> dict:
    """Apply a small, clearly requested change NOW, as one undoable change (the athlete sees
    a change card with Undo). Saved only if the result has saved=true and a change_id. A set
    touching more than 10 workouts is stored as a proposal instead (saved=false). Include
    every op of the request in one call. `delete_logged_confirmed`: only when the athlete
    explicitly asked to delete a logged activity."""
    try:
        with db.get_db().session() as s:
            raw = prepare(s, ops, delete_logged_confirmed)
        if props.weight(raw) > props.LIVE_LIMIT:
            out = _propose(ctx, raw, reason, "Drafted a proposal")
            out["converted"] = "More than 10 workouts: stored as a proposal for the athlete to Apply."
            return out
        with db.get_db().session() as s:
            res = changes.apply_change(s, raw, source="chat", reason=reason, inspect=_totals,
                                       turn_id=ctx.deps.turn_id, op_id=f"{ctx.deps.turn_id}:{ctx.tool_call_id}")
    except ChangeError as e:
        return _err(e)
    if not res.applied:
        return meta("Changed the plan", PLAN, "Nothing changed", ok=True, saved=False,
                    detail="Nothing changed — the plan already matches.")
    ctx.deps.applied.append(res.change_id)
    return meta("Changed the plan", PLAN, res.summary, ok=True, saved=True, change_id=res.change_id,
                lines=_lines(res)[:25], weeks=res.weeks, totals_after=res.projected, kept=res.kept)


def undo_change(ctx: RunContext[ChatDeps], change_id: str) -> dict:
    """Undo one earlier change by id (as a new, itself undoable change)."""
    try:
        with db.get_db().session() as s:
            res = changes.undo(s, change_id, op_id=f"{ctx.deps.turn_id}:{ctx.tool_call_id}")
    except ChangeError as e:
        return _err(e, "Undo failed")
    ctx.deps.applied.append(res.change_id)
    return meta("Undid a change", PLAN, res.summary, ok=True, saved=True, change_id=res.change_id,
                lines=_lines(res)[:25], weeks=res.weeks)


# ------------------------------------------------------------------ coaching guide

def guide_dir() -> Path:
    here = Path(__file__).resolve()
    for root in (here.parents[2] / "training", here.parents[1] / "training"):  # repo, image
        if root.is_dir():
            return root / "guide"
    return here.parents[2] / "training" / "guide"


def guide_topics() -> list[str]:
    return sorted(p.stem for p in guide_dir().glob("*.md") if p.stem != "README")


def guide_index() -> str:
    readme = guide_dir() / "README.md"
    return readme.read_text() if readme.exists() else ", ".join(guide_topics())


def read_guide(ctx: RunContext[ChatDeps], topic: str) -> dict:
    """Read one topic of the coaching guide (labels: [E] cited evidence, [C] coaching
    consensus, [H] heuristic). Read it before drafting training or answering method questions."""
    topics = guide_topics()
    topic = topic.strip().lower().removesuffix(".md")
    if topic not in topics:
        return meta("Read the coaching guide", GUIDE, "Unknown topic", error="unknown_topic", topics=topics)
    return meta("Read the coaching guide", GUIDE, topic, topic=topic,
                markdown=(guide_dir() / f"{topic}.md").read_text(),
                note="General coaching knowledge, not the athlete's Profile; cite as 'coaching guide: "
                     f"{topic}' with its [E]/[C]/[H] labels.")


PLAN_TOOLS = [get_calendar, get_workout, list_series, list_exercises, list_saved_workouts, get_activities,
              get_inbox, get_profile, get_history, read_guide, change, propose, undo_change]
