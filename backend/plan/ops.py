"""Every plan-side op: a pydantic payload plus a function over the change transaction.

Payloads are flat JSON objects with an `op` field (API.md lists them). Dates are ISO strings.
Content fields shared by workouts, series and saved workouts: title, type, tags, notes,
items, media. Rules that hold everywhere:

- A workout never stores actual values; an activity never stores planned values.
- Editing an occurrence's content (title, type, tags, notes, items, media) sets `customised`;
  moving it does not, and neither does changing its time of day (`time`, "HH:MM" or null).
  Occurrences copy the series' time; a series time edit (one/following, like any series edit)
  carries to the occurrences that still have the old series time.
- "This and following" splits the series (old one ends the day before; a new series carries
  the new content); future planned, unlogged occurrences move to the new series. Uncustomised ones
  take its content; customised ones keep their own content (reported in `kept`), so deleting the
  new series later removes them too.
- Series deletes and splits only touch future (today counts), unlogged rows. Logged work is
  never deleted: deleting a workout with a linked activity is refused, bulk deletes skip it.
"""

from __future__ import annotations

import datetime as dt
import difflib
import re
import uuid
from datetime import date, datetime, time, timedelta, timezone
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import String, cast, select

from models import Activity, Exercise, SavedWorkout, Series, Workout
from plan import clock
from plan.changes import ChangeError, Tx, monday_of, op
from plan.series import has_activity, horizon, materialise, new_id, next_position, removable
from plan.types import MEASURES, TYPES, type_of

TypeName = Literal[TYPES]  # type: ignore[valid-type]
Scope = Literal["one", "following"]
CONTENT = ("title", "type", "tags", "notes", "items", "media")


class _M(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Item(_M):
    id: str | None = Field(None, max_length=12, pattern=r"^[A-Za-z0-9_-]+$")
    exercise_id: str = Field(min_length=1, max_length=80)
    sets: int | None = Field(None, ge=1, le=100)
    reps: str | None = Field(None, max_length=40)
    load: str | None = Field(None, max_length=40)
    duration_min: float | None = Field(None, ge=0, le=1440)
    distance_km: float | None = Field(None, ge=0, le=1000)
    intensity: str | None = Field(None, max_length=60)
    note: str | None = Field(None, max_length=500)


class Media(_M):
    kind: Literal["link", "image"]
    url: str | None = Field(None, max_length=2000)
    file: str | None = Field(None, max_length=120)
    title: str = Field("", max_length=200)

    @model_validator(mode="after")
    def _check(self):
        if self.kind == "link" and not re.match(r"^https?://\S+$", self.url or ""):
            raise ValueError("a link needs an http(s) url")
        if self.kind == "image" and not re.match(r"^[A-Za-z0-9_-]{1,80}\.(jpg|jpeg|png|webp)$", self.file or ""):
            raise ValueError("an image needs a stored file name")
        return self


Tags = Annotated[list[Annotated[str, Field(min_length=1, max_length=30)]], Field(max_length=20)]
Title = Annotated[str, Field(min_length=1, max_length=160)]
Notes = Annotated[str, Field(max_length=20_000)]
def _dedupe(v):
    """Repeated ids act once (a double-listed id must not shift twice or fail a bulk delete)."""
    return list(dict.fromkeys(v)) if isinstance(v, list) else v


Ids = Annotated[list[str], BeforeValidator(_dedupe), Field(min_length=1, max_length=500)]


def _hhmm(v):
    """'7:30' / '07:30' / '19:30:00' → '07:30' / '19:30'; '' or None → None (no time)."""
    if v is None or (isinstance(v, str) and not v.strip()):
        return None
    m = re.fullmatch(r"([01]?\d|2[0-3])[:.h]([0-5]\d)(?::00)?", str(v).strip())
    if not m:
        raise ValueError("time is HH:MM (24 h), e.g. 07:30 or 19:30")
    return f"{int(m.group(1)):02d}:{m.group(2)}"


TimeOfDay = Annotated[str | None, BeforeValidator(_hhmm),
                      Field(description='time of day "HH:MM" (24 h); null = no time')]


class ContentPatch(_M):
    title: Title | None = None
    type: TypeName | None = None
    time: TimeOfDay = None
    tags: Tags | None = None
    notes: Notes | None = None
    items: list[Item] | None = Field(None, max_length=60)
    media: list[Media] | None = Field(None, max_length=20)


class Rule(_M):
    freq: Literal["weekly"] = "weekly"
    interval: int = Field(1, ge=1, le=8)
    weekdays: list[int] = Field(min_length=1, max_length=7)

    @field_validator("weekdays")
    @classmethod
    def _days(cls, v: list[int]) -> list[int]:
        if any(d < 0 or d > 6 for d in v):
            raise ValueError("weekdays are 0 (Mon) … 6 (Sun)")
        return sorted(set(v))


# ---------------------------------------------------------------- shared helpers

def _tags(tags: list[str] | None) -> list[str]:
    out: list[str] = []
    for t in tags or []:
        t = t.strip().lower()
        if t and t not in out:
            out.append(t)
    return out


def _similar_exercises(tx: Tx, wanted: str, n: int = 4) -> list[str]:
    """Ids of library exercises that look like an unknown `exercise_id` ("run" → easy-run)."""
    q = wanted.lower().strip()
    out = []
    for e in tx.db.scalars(select(Exercise).where(Exercise.archived.is_(False)).order_by(Exercise.id)):
        text = f"{e.id} {e.name}".lower()
        words = re.findall(r"[a-z0-9]+", text)
        if q in text or difflib.get_close_matches(q, words, n=1, cutoff=0.75):
            out.append(e.id)
    return out[:n]


def _items(tx: Tx, items: list[Item] | None) -> list[dict]:
    """Validate exercise references and give every item a short id, unique in the list."""
    out: list[dict] = []
    used: set[str] = set()
    for it in items or []:
        if tx.db.get(Exercise, it.exercise_id) is None:
            near = _similar_exercises(tx, it.exercise_id)
            raise ChangeError("exercise_not_found",
                              f"No exercise {it.exercise_id}" + (f". Similar: {', '.join(near)}" if near else ""),
                              id=it.exercise_id, similar=near)
        d = it.model_dump(exclude_none=True)
        while not d.get("id") or d["id"] in used:
            d["id"] = uuid.uuid4().hex[:6]
        used.add(d["id"])
        out.append(d)
    return out


def _content(tx: Tx, patch: ContentPatch | BaseModel) -> dict:
    """Patch → column values, only for fields the caller sent."""
    out = {}
    if "time" in patch.model_fields_set:
        out["time"] = patch.time
    for f in CONTENT:
        if f not in patch.model_fields_set:
            continue
        v = getattr(patch, f)
        if f == "title":
            if v is None or not str(v).strip():
                raise ChangeError("title_required", "Title cannot be empty")
            v = v.strip()
        elif f == "type":
            if v is None:
                raise ChangeError("type_required", "Type cannot be empty")
        elif f == "tags":
            v = _tags(v)
        elif f == "notes":
            v = v or ""
        elif f == "items":
            v = _items(tx, v)
        elif f == "media":
            v = [m.model_dump(exclude_none=True) for m in v or []]
        out[f] = v
    return out


def _copy_content(src) -> dict:
    return {"title": src.title, "type": src.type, "time": src.time, "tags": list(src.tags or []),
            "notes": src.notes or "",
            "items": [dict(i) for i in src.items or []], "media": [dict(m) for m in src.media or []]}


def _set(obj, values: dict) -> bool:
    changed = False
    for k, v in values.items():
        if getattr(obj, k) != v:
            setattr(obj, k, v)
            changed = True
    return changed


def _placement(day: date | None, week_monday: date | None) -> tuple[date, date | None]:
    if day is not None:
        if week_monday is not None and monday_of(day) != week_monday:
            raise ChangeError("date_outside_week", f"{day} is not in week {week_monday}")
        return monday_of(day), day
    if week_monday is None:
        raise ChangeError("placement_required", "Give a date, or week_monday for 'no day yet'")
    if week_monday.weekday() != 0:
        raise ChangeError("not_monday", f"{week_monday} is not a Monday")
    return week_monday, None


def _workout(tx: Tx, wid: str) -> Workout:
    return tx.get("workout", wid)


def _activities_of(tx: Tx, wid: str) -> list[Activity]:
    tx.db.flush()
    return tx.query("activity", select(Activity).where(Activity.workout_id == wid)
                    .order_by(Activity.start_utc))


def _local_noon_utc(d: date) -> datetime:
    return datetime.combine(d, time(12), tzinfo=clock.tz()).astimezone(timezone.utc).replace(tzinfo=None)


def _slug(tx: Tx, kind: str, name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60] or kind
    ident, n = base, 2
    while tx.get(kind, ident, must_exist=False) is not None:
        ident, n = f"{base}-{n}", n + 1
    return ident


# ---------------------------------------------------------------- workouts

class AddWorkout(ContentPatch):
    op: Literal["add_workout"]
    id: str | None = Field(None, max_length=40)
    date: dt.date | None = None
    week_monday: dt.date | None = None
    position: int | None = Field(None, ge=0)
    from_saved: str | None = None


@op("add_workout", AddWorkout)
def add_workout(tx: Tx, p: AddWorkout) -> None:
    monday, day = _placement(p.date, p.week_monday)
    values = _copy_content(tx.get("saved", p.from_saved)) if p.from_saved else {}
    values.update(_content(tx, p))
    if not values.get("title") or not values.get("type"):
        raise ChangeError("title_and_type_required", "A workout needs a title and a type")
    values.setdefault("tags", [])
    values.setdefault("notes", "")
    values.setdefault("items", [])
    values.setdefault("media", [])
    wid = p.id or new_id("w")
    tx.add("workout", Workout(id=wid, week_monday=monday, date=day, status="planned", skip_reason="",
                              customised=False, series_id=None, series_date=None,
                              position=p.position if p.position is not None
                              else next_position(tx, monday, day), **values))


class UpdateWorkout(_M):
    op: Literal["update_workout"]
    id: str
    fields: ContentPatch
    scope: Scope = "one"


@op("update_workout", UpdateWorkout)
def update_workout(tx: Tx, p: UpdateWorkout) -> None:
    w = _workout(tx, p.id)
    values = _content(tx, p.fields)
    if p.scope == "following" and w.series_id:
        s = tx.get("series", w.series_id)
        target = _split(tx, s, w.series_date or w.date or clock.today(), values)
        tx.kept = [k for k in tx.kept if k["id"] != w.id]  # the edited one itself follows
        _set(w, values)
        if removable(tx, w) and w.status == "planned":
            w.series_id, w.customised = target.id, False
        else:
            w.customised = True
        return
    when = {"time": values.pop("time")} if "time" in values else {}
    _set(w, when)  # a new time of day is a move: never customises
    if _set(w, values) and w.series_id:
        w.customised = True


class MoveWorkout(_M):
    op: Literal["move_workout"]
    id: str
    date: dt.date | None = None
    week_monday: dt.date | None = None
    position: int | None = Field(None, ge=0)
    time: TimeOfDay = Field(None, description="new time of day; omit to keep it, null to clear")


@op("move_workout", MoveWorkout)
def move_workout(tx: Tx, p: MoveWorkout) -> None:
    w = _workout(tx, p.id)
    monday, day = _placement(p.date, p.week_monday)
    w.week_monday, w.date = monday, day
    w.position = p.position if p.position is not None else next_position(tx, monday, day, skip=w.id)
    if "time" in p.model_fields_set:
        w.time = p.time


class DeleteWorkout(_M):
    op: Literal["delete_workout"]
    id: str
    scope: Literal["one", "following", "all"] = "one"


def _end_series_rows(tx: Tx, s: Series, cut: date) -> None:
    """Delete the series' future unlogged rows from slot `cut` on."""
    for w in tx.query("workout", select(Workout).where(Workout.series_id == s.id)
                      .where(Workout.series_date >= cut)):
        if removable(tx, w):
            tx.delete("workout", w.id)


def _drop_if_empty(tx: Tx, s: Series) -> None:
    tx.db.flush()
    left = tx.db.scalars(select(Workout.id).where(Workout.series_id == s.id)).first()
    if left is None and s.end_date is not None and s.end_date < max(s.start_date, clock.today()):
        tx.delete("series", s.id)


@op("delete_workout", DeleteWorkout)
def delete_workout(tx: Tx, p: DeleteWorkout) -> None:
    w = _workout(tx, p.id)
    if p.scope == "one" or not w.series_id:
        if has_activity(tx, w.id):
            raise ChangeError("logged", f"{w.title} has a logged activity; unlink it first", id=w.id)
        tx.delete("workout", w.id)
        return
    s = tx.get("series", w.series_id)
    today = clock.today()
    if p.scope == "following":
        cut = w.series_date or w.date or today
        if not has_activity(tx, w.id):
            tx.delete("workout", w.id)
        _end_series_rows(tx, s, cut)
        end = cut - timedelta(days=1)
    else:
        _end_series_rows(tx, s, date.min)
        end = today - timedelta(days=1)
    if s.end_date is None or s.end_date > end:
        s.end_date = end
    _drop_if_empty(tx, s)


class DuplicateWorkout(_M):
    op: Literal["duplicate_workout"]
    id: str


def _copy(tx: Tx, w: Workout, monday: date, day: date | None) -> None:
    tx.add("workout", Workout(id=new_id("w"), week_monday=monday, date=day,
                              position=next_position(tx, monday, day), status="planned",
                              skip_reason="", series_id=None, series_date=None, customised=False,
                              **_copy_content(w)))


@op("duplicate_workout", DuplicateWorkout)
def duplicate_workout(tx: Tx, p: DuplicateWorkout) -> None:
    w = _workout(tx, p.id)
    _copy(tx, w, w.week_monday, w.date)


class CopyWorkout(_M):
    op: Literal["copy_workout"]
    id: str
    dates: list[dt.date] = Field(default_factory=list, max_length=100)
    week_mondays: list[dt.date] = Field(default_factory=list, max_length=100,
                                     description="copies with no day yet, in these weeks")


@op("copy_workout", CopyWorkout)
def copy_workout(tx: Tx, p: CopyWorkout) -> None:
    if not p.dates and not p.week_mondays:
        raise ChangeError("placement_required", "Give dates or week_mondays to copy to")
    w = _workout(tx, p.id)
    for d in p.dates:
        _copy(tx, w, monday_of(d), d)
    for m in p.week_mondays:
        _copy(tx, w, *_placement(None, m))


class SetWorkoutStatus(_M):
    op: Literal["set_workout_status"]
    id: str
    status: Literal["planned", "skipped"]
    reason: str = Field("", max_length=300)


@op("set_workout_status", SetWorkoutStatus)
def set_workout_status(tx: Tx, p: SetWorkoutStatus) -> None:
    w = _workout(tx, p.id)
    if p.status == "skipped" and has_activity(tx, w.id):
        raise ChangeError("logged", f"{w.title} is done (it has an activity); unlink it first", id=w.id)
    w.status = p.status
    w.skip_reason = p.reason.strip() if p.status == "skipped" else ""


class SetTags(_M):
    op: Literal["set_tags"]
    ids: Ids
    add: Tags = Field(default_factory=list)
    remove: Tags = Field(default_factory=list)
    set: Tags | None = None


@op("set_tags", SetTags)
def set_tags(tx: Tx, p: SetTags) -> None:
    add, remove = _tags(p.add), set(_tags(p.remove))
    for wid in p.ids:
        w = _workout(tx, wid)
        tags = _tags(p.set) if p.set is not None else list(w.tags or [])
        tags = [t for t in tags if t not in remove] + [t for t in add if t not in tags]
        if tags != (w.tags or []):
            w.tags = tags
            if w.series_id:
                w.customised = True


class ShiftWorkouts(_M):
    op: Literal["shift_workouts"]
    ids: Ids
    days: int = Field(ge=-366, le=366)


@op("shift_workouts", ShiftWorkouts)
def shift_workouts(tx: Tx, p: ShiftWorkouts) -> None:
    """Dated workouts move by N days; undated ones move to the week N days later."""
    for wid in p.ids:
        w = _workout(tx, wid)
        if w.date is not None:
            w.date = w.date + timedelta(days=p.days)
            w.week_monday = monday_of(w.date)
        else:
            w.week_monday = monday_of(w.week_monday + timedelta(days=p.days))
        w.position = next_position(tx, w.week_monday, w.date, skip=w.id)


class BulkDelete(_M):
    op: Literal["bulk_delete"]
    ids: Ids


@op("bulk_delete", BulkDelete)
def bulk_delete(tx: Tx, p: BulkDelete) -> None:
    for wid in p.ids:
        w = _workout(tx, wid)
        if has_activity(tx, w.id):
            tx.kept.append({"id": w.id, "title": w.title, "note": "Logged; kept"})
            continue
        tx.delete("workout", w.id)


# ---------------------------------------------------------------- logging (the actual side)

class SetIn(_M):
    """One performed set. reps or secs says what was done; kg is the load (none = bodyweight)."""
    exercise_id: str = Field(min_length=1, max_length=80)
    item_id: str | None = Field(None, max_length=12, pattern=r"^[A-Za-z0-9_-]+$")
    reps: int | None = Field(None, ge=0, le=1000)
    kg: float | None = Field(None, ge=0, le=1000)
    secs: float | None = Field(None, ge=0, le=36000)


MAX_SETS = 300


class LogWorkout(_M):
    op: Literal["log_workout"]
    workout_id: str
    activity_id: str | None = None
    date: dt.date | None = None
    rpe: float | None = Field(None, ge=1, le=10)
    notes: str | None = Field(None, max_length=5000)
    skipped_items: list[str] | None = Field(None, max_length=60)
    sets: list[SetIn] | None = Field(None, max_length=MAX_SETS)
    duration_min: float | None = Field(None, ge=0, le=1440)
    distance_km: float | None = Field(None, ge=0, le=1000)


def _sets(tx: Tx, sets: list[SetIn], w: Workout | None) -> list[dict]:
    """Validate performed sets: real exercises, item ids of the linked workout, and a count
    (reps or seconds) on every set. Stored compactly: unset values are left out."""
    items = {i["id"]: i for i in (w.items if w is not None else []) or []}
    out = []
    for s in sets:
        if s.reps is None and s.secs is None:
            raise ChangeError("bad_set", "A set needs reps or seconds")
        if s.item_id is not None:
            it = items.get(s.item_id)
            if it is None:
                raise ChangeError("bad_item", f"Not an item of {w.title if w else 'an unlinked activity'}: {s.item_id}",
                                  items=[s.item_id])
            if it["exercise_id"] != s.exercise_id:
                raise ChangeError("bad_set", f"Item {s.item_id} is {it['exercise_id']}, not {s.exercise_id}")
        if tx.get("exercise", s.exercise_id, must_exist=False) is None:
            raise ChangeError("unknown_exercise", f"No exercise {s.exercise_id}")
        out.append(s.model_dump(exclude_none=True))
    return out


def _annotate(tx: Tx, a: Activity, p: BaseModel, w: Workout | None) -> None:
    sent = p.model_fields_set
    if "rpe" in sent:
        a.rpe = p.rpe
    if "notes" in sent:
        a.notes = (p.notes or "").strip()
    if "skipped_items" in sent:
        ids = list(dict.fromkeys(p.skipped_items or []))
        if w is not None:
            valid = {i["id"] for i in w.items or []}
            bad = [i for i in ids if i not in valid]
            if bad:
                raise ChangeError("bad_item", f"Not an item of {w.title}: {bad}", items=bad)
        a.skipped_items = ids
    if "sets" in sent:
        a.sets = _sets(tx, p.sets or [], w)
    for f in ("duration_min", "distance_km"):
        if f in sent:
            if a.source != "manual":
                raise ChangeError("device_value", "Recorded values come from the device")
            v = getattr(p, f)
            if f == "duration_min":
                a.duration_s = v * 60 if v is not None else None
            else:
                a.distance_m = v * 1000 if v is not None else None


def _manual(tx: Tx, *, type_: str, name: str, day: date, workout_id: str | None,
            ident: str | None = None) -> Activity:
    if day > clock.today():
        raise ChangeError("future", "An activity cannot be in the future; give the date it happened")
    aid = ident or f"manual:{uuid.uuid4().hex[:12]}"
    return tx.add("activity", Activity(id=aid, source="manual", source_id=aid, sport=type_, source_type="",
                                       name=name, start_utc=_local_noon_utc(day), local_date=day,
                                       workout_id=workout_id, notes="", skipped_items=[], sets=[], laps=[],
                                       kept_unplanned=False, device=""))


@op("log_workout", LogWorkout)
def log_workout(tx: Tx, p: LogWorkout) -> None:
    """Done: annotate the workout's activity (the given one, else its manual one, else its
    first recording), or create an empty manual activity linked to it. No plan numbers are
    copied; duration/distance are only what the athlete typed."""
    w = _workout(tx, p.workout_id)
    linked = _activities_of(tx, w.id)
    if p.activity_id:
        a = next((x for x in linked if x.id == p.activity_id), None)
        if a is None:
            raise ChangeError("not_linked", "That activity is not linked to this workout")
    else:
        a = next((x for x in linked if x.source == "manual"), None) or (linked[0] if linked else None)
    if a is None:
        day = p.date or w.date or clock.today()
        a = _manual(tx, type_=w.type, name=w.title, day=day, workout_id=w.id)
    _annotate(tx, a, p, w)
    if w.status == "skipped":
        w.status, w.skip_reason = "planned", ""


class LogActivity(_M):
    op: Literal["log_activity"]
    id: str | None = Field(None, pattern=r"^manual:[A-Za-z0-9_-]{4,40}$")
    type: TypeName
    date: dt.date
    title: str = Field("", max_length=200)
    rpe: float | None = Field(None, ge=1, le=10)
    notes: str | None = Field(None, max_length=5000)
    sets: list[SetIn] | None = Field(None, max_length=MAX_SETS)
    duration_min: float | None = Field(None, ge=0, le=1440)
    distance_km: float | None = Field(None, ge=0, le=1000)


@op("log_activity", LogActivity)
def log_activity(tx: Tx, p: LogActivity) -> None:
    a = _manual(tx, type_=p.type, name=p.title.strip(), day=p.date, workout_id=None, ident=p.id)
    _annotate(tx, a, p, None)


class UpdateActivity(_M):
    op: Literal["update_activity_annotations"]
    id: str
    rpe: float | None = Field(None, ge=1, le=10)
    notes: str | None = Field(None, max_length=5000)
    skipped_items: list[str] | None = Field(None, max_length=60)
    kept_unplanned: bool | None = None
    sets: list[SetIn] | None = Field(None, max_length=MAX_SETS)
    duration_min: float | None = Field(None, ge=0, le=1440)
    distance_km: float | None = Field(None, ge=0, le=1000)
    title: str | None = Field(None, max_length=200)
    type: TypeName | None = None
    # A recording's type, when the device's is wrong; null puts the device's type back.
    type_override: TypeName | None = None
    date: dt.date | None = None


@op("update_activity_annotations", UpdateActivity)
def update_activity(tx: Tx, p: UpdateActivity) -> None:
    a = tx.get("activity", p.id)
    w = tx.get("workout", a.workout_id) if a.workout_id else None
    _annotate(tx, a, p, w)
    if "kept_unplanned" in p.model_fields_set:
        a.kept_unplanned = bool(p.kept_unplanned)
    if "type_override" in p.model_fields_set:
        if a.source == "manual":
            raise ChangeError("not_recorded", "A hand-logged activity has no device type; change its type instead")
        a.type_override = p.type_override
        a.sport = p.type_override or type_of(a.source_type)
    for f in ("title", "type", "date"):
        if f in p.model_fields_set and getattr(p, f) is not None:
            if a.source != "manual":
                raise ChangeError("device_value", "Recorded values come from the device")
            if f == "title":
                a.name = p.title.strip()
            elif f == "type":
                a.sport = p.type
            else:
                if p.date > clock.today():
                    raise ChangeError("future", "An activity cannot be in the future")
                a.local_date, a.start_utc = p.date, _local_noon_utc(p.date)


class DeleteActivity(_M):
    op: Literal["delete_activity"]
    id: str


@op("delete_activity", DeleteActivity)
def delete_activity(tx: Tx, p: DeleteActivity) -> None:
    a = tx.get("activity", p.id)
    if a.source != "manual":
        raise ChangeError("device_value", "Recordings are removed from Data → Sync, not here")
    tx.delete("activity", a.id)


class LinkActivity(_M):
    op: Literal["link_activity"]
    activity_id: str
    workout_id: str
    merge_manual: bool = True


def link(tx: Tx, a: Activity, w: Workout, merge_manual: bool = True) -> None:
    """Link a to w. When a recording joins a workout that was done by hand, the manual
    activity's annotations move onto the recording and the empty manual row is deleted."""
    if merge_manual and a.source != "manual":
        for m in _activities_of(tx, w.id):
            if m.source != "manual" or m.id == a.id:
                continue
            if a.rpe is None:
                a.rpe = m.rpe
            if m.notes and m.notes not in (a.notes or ""):
                a.notes = f"{a.notes or ''}\n{m.notes}".strip()
            a.skipped_items = list(dict.fromkeys([*(a.skipped_items or []), *(m.skipped_items or [])]))
            if not a.sets and m.sets:
                a.sets = list(m.sets)
            tx.delete("activity", m.id)
    # Linking elsewhere: sets keep their exercise but only point at items this workout has, and
    # skipped items of another workout mean nothing here.
    if a.workout_id != w.id:
        ids = {i["id"]: i["exercise_id"] for i in w.items or []}
        if a.sets:
            a.sets = [s if ids.get(s.get("item_id")) == s["exercise_id"] else {k: v for k, v in s.items() if k != "item_id"}
                      for s in a.sets]
        a.skipped_items = [i for i in a.skipped_items or [] if i in ids]
    a.workout_id = w.id
    a.kept_unplanned = False
    if w.status == "skipped":
        w.status, w.skip_reason = "planned", ""


@op("link_activity", LinkActivity)
def link_activity(tx: Tx, p: LinkActivity) -> None:
    link(tx, tx.get("activity", p.activity_id), _workout(tx, p.workout_id), p.merge_manual)


class UnlinkActivity(_M):
    op: Literal["unlink_activity"]
    activity_id: str


@op("unlink_activity", UnlinkActivity)
def unlink_activity(tx: Tx, p: UnlinkActivity) -> None:
    a = tx.get("activity", p.activity_id)
    a.workout_id = None


# ---------------------------------------------------------------- series

class CreateSeries(ContentPatch):
    op: Literal["create_series"]
    id: str | None = Field(None, max_length=40)
    rule: Rule
    start_date: dt.date | None = None
    end_date: dt.date | None = None
    from_workout: str | None = Field(None, description="turn this workout into the first occurrence")


@op("create_series", CreateSeries)
def create_series(tx: Tx, p: CreateSeries) -> None:
    src = _workout(tx, p.from_workout) if p.from_workout else None
    values = _copy_content(src) if src else \
        {"time": None, "tags": [], "notes": "", "items": [], "media": []}
    values.update(_content(tx, p))
    if not values.get("title") or not values.get("type"):
        raise ChangeError("title_and_type_required", "A repeating workout needs a title and a type")
    start = p.start_date or (src.date if src and src.date else None) or clock.today()
    if p.end_date and p.end_date < start:
        raise ChangeError("bad_range", "The series ends before it starts")
    s = tx.add("series", Series(id=p.id or new_id("s"), rule=p.rule.model_dump(), start_date=start,
                                end_date=p.end_date, materialised_through=None, **values))
    if src is not None and src.date and src.date.weekday() in s.rule["weekdays"] and src.date >= start:
        src.series_id, src.series_date, src.customised = s.id, src.date, False
        _set(src, values)
    materialise(tx, s, horizon(clock.today()))


def _split(tx: Tx, s: Series, at: date, values: dict, rule: dict | None = None,
           end_date: date | None | Literal["keep"] = "keep") -> Series:
    """New content (and/or rule) for the series' slots from `at` on. Returns the series that
    now owns those slots: `s` itself when `at` is its first slot, else a new series that starts
    at `at` while `s` ends the day before."""
    old_rule, old_time = dict(s.rule), s.time
    if at <= s.start_date:
        target = s
        _set(s, values)
        if rule is not None:
            s.rule = rule
        if end_date != "keep":
            s.end_date = end_date
    else:
        content = {**_copy_content(s), **values}
        target = tx.add("series", Series(
            id=new_id("s"), rule=rule or old_rule, start_date=at,
            end_date=s.end_date if end_date == "keep" else end_date,
            materialised_through=s.materialised_through, **content))
        s.end_date = at - timedelta(days=1)
    rule_changed = rule is not None and rule != old_rule
    for w in tx.query("workout", select(Workout).where(Workout.series_id == s.id)
                      .where(Workout.series_date >= at)):
        if w.status != "planned" or not removable(tx, w):
            continue  # past, logged or skipped: history, never rewritten
        if w.customised:
            tx.kept.append({"id": w.id, "title": w.title, "date": w.date.isoformat() if w.date else None,
                            "note": "Customised; kept"})
            w.series_id = target.id  # stays customised, but belongs to the series that now owns its slot
            continue
        if rule_changed:
            tx.delete("workout", w.id)
        else:
            w.series_id = target.id
            content = _copy_content(target)
            if w.time != old_time:  # its own time (moved): kept, like a moved date
                content.pop("time")
            _set(w, content)
    if target.end_date is not None:
        for w in tx.query("workout", select(Workout).where(Workout.series_id == target.id)
                          .where(Workout.series_date > target.end_date)):
            if removable(tx, w) and w.status == "planned" and not w.customised:
                tx.delete("workout", w.id)
    if rule_changed:
        target.materialised_through = max(at, clock.today()) - timedelta(days=1)
    materialise(tx, target, max(horizon(clock.today()), s.materialised_through or at))
    if target is not s:
        _drop_if_empty(tx, s)
    return target


class SeriesPatch(ContentPatch):
    rule: Rule | None = None
    end_date: dt.date | None = None


class UpdateSeries(_M):
    op: Literal["update_series"]
    id: str
    fields: SeriesPatch
    from_date: dt.date | None = Field(None, description="first slot that gets the new content; default today")


@op("update_series", UpdateSeries)
def update_series(tx: Tx, p: UpdateSeries) -> None:
    s = tx.get("series", p.id)
    values = _content(tx, p.fields)
    rule = p.fields.rule.model_dump() if p.fields.rule is not None else None
    sent = p.fields.model_fields_set
    if not values and rule is None:  # only the end date: no split needed
        if "end_date" in sent:
            _end(tx, s, p.fields.end_date)
        return
    at = max(p.from_date or clock.today(), s.start_date)
    _split(tx, s, at, values, rule, p.fields.end_date if "end_date" in sent else "keep")


def _end(tx: Tx, s: Series, end: date | None) -> None:
    if end is not None and end < s.start_date - timedelta(days=1):
        end = s.start_date - timedelta(days=1)
    old, s.end_date = s.end_date, end
    if old is not None and (end is None or end > old):  # extended: slots after the old end come back
        floor = max(old, clock.today() - timedelta(days=1))
        if s.materialised_through is not None and s.materialised_through > floor:
            s.materialised_through = floor
        materialise(tx, s, horizon(clock.today()))
    if end is None:
        return
    _end_series_rows(tx, s, end + timedelta(days=1))
    _drop_if_empty(tx, s)


class EndSeries(_M):
    op: Literal["end_series"]
    id: str
    end_date: dt.date | None = Field(None, description="last day of the series; default today")


@op("end_series", EndSeries)
def end_series(tx: Tx, p: EndSeries) -> None:
    _end(tx, tx.get("series", p.id), p.end_date or clock.today())


# ---------------------------------------------------------------- exercises

class AddExercise(_M):
    op: Literal["add_exercise"]
    id: str | None = Field(None, max_length=80, pattern=r"^[a-z0-9][a-z0-9-]*$")
    name: str = Field(min_length=1, max_length=120)
    type: TypeName = "strength"
    default_measure: Literal[MEASURES] = "reps"  # type: ignore[valid-type]
    notes: Notes = ""
    media: list[Media] = Field(default_factory=list, max_length=20)


@op("add_exercise", AddExercise)
def add_exercise(tx: Tx, p: AddExercise) -> None:
    tx.add("exercise", Exercise(id=p.id or _slug(tx, "exercise", p.name), name=p.name.strip(), type=p.type,
                                default_measure=p.default_measure, notes=p.notes, archived=False,
                                media=[m.model_dump(exclude_none=True) for m in p.media]))


class ExercisePatch(_M):
    name: str | None = Field(None, min_length=1, max_length=120)
    type: TypeName | None = None
    default_measure: Literal[MEASURES] | None = None  # type: ignore[valid-type]
    notes: Notes | None = None
    media: list[Media] | None = Field(None, max_length=20)


class UpdateExercise(_M):
    op: Literal["update_exercise"]
    id: str
    fields: ExercisePatch


@op("update_exercise", UpdateExercise)
def update_exercise(tx: Tx, p: UpdateExercise) -> None:
    e = tx.get("exercise", p.id)
    for f in p.fields.model_fields_set:
        v = getattr(p.fields, f)
        if v is None:
            continue
        if f == "media":
            v = [m.model_dump(exclude_none=True) for m in v]
        setattr(e, f, v.strip() if f == "name" else v)


class ArchiveExercise(_M):
    op: Literal["archive_exercise"]
    id: str
    archived: bool = True


@op("archive_exercise", ArchiveExercise)
def archive_exercise(tx: Tx, p: ArchiveExercise) -> None:
    tx.get("exercise", p.id).archived = p.archived


class MergeExercise(_M):
    op: Literal["merge_exercise"]
    id: str = Field(description="the exercise that disappears")
    into: str


@op("merge_exercise", MergeExercise)
def merge_exercise(tx: Tx, p: MergeExercise) -> None:
    """Point every item (workouts, series, saved workouts, past and future) and every logged set
    at `into`, then delete `id`. A reference fix, not a content edit: occurrences don't become
    customised, and the merged exercise's history continues under `into`."""
    if p.id == p.into:
        raise ChangeError("same_exercise", "Pick two different exercises")
    tx.get("exercise", p.into)
    tx.get("exercise", p.id)
    for kind, model in (("workout", Workout), ("series", Series), ("saved", SavedWorkout)):
        rows = tx.query(kind, select(model).where(cast(model.items, String).like(f'%"{p.id}"%')))
        for r in rows:
            items = [{**i, "exercise_id": p.into} if i.get("exercise_id") == p.id else i
                     for i in r.items or []]
            if items != r.items:
                r.items = items
    for a in tx.query("activity", select(Activity).where(cast(Activity.sets, String).like(f'%"{p.id}"%'))):
        sets = [{**s, "exercise_id": p.into} if s.get("exercise_id") == p.id else s for s in a.sets or []]
        if sets != a.sets:
            a.sets = sets
    tx.delete("exercise", p.id)


# ---------------------------------------------------------------- saved workouts

class AddSavedWorkout(ContentPatch):
    op: Literal["add_saved_workout"]
    id: str | None = Field(None, max_length=40)
    from_workout: str | None = None


@op("add_saved_workout", AddSavedWorkout)
def add_saved_workout(tx: Tx, p: AddSavedWorkout) -> None:
    values = _copy_content(_workout(tx, p.from_workout)) if p.from_workout else \
        {"time": None, "tags": [], "notes": "", "items": [], "media": []}
    values.update(_content(tx, p))
    if not values.get("title") or not values.get("type"):
        raise ChangeError("title_and_type_required", "A saved workout needs a title and a type")
    tx.add("saved", SavedWorkout(id=p.id or new_id("t"), **values))


class UpdateSavedWorkout(_M):
    op: Literal["update_saved_workout"]
    id: str
    fields: ContentPatch


@op("update_saved_workout", UpdateSavedWorkout)
def update_saved_workout(tx: Tx, p: UpdateSavedWorkout) -> None:
    _set(tx.get("saved", p.id), _content(tx, p.fields))


class DeleteSavedWorkout(_M):
    op: Literal["delete_saved_workout"]
    id: str


@op("delete_saved_workout", DeleteSavedWorkout)
def delete_saved_workout(tx: Tx, p: DeleteSavedWorkout) -> None:
    tx.delete("saved", p.id)


# ---------------------------------------------------------------- profile

class UpdateProfile(_M):
    op: Literal["update_profile"]
    markdown: str = Field(max_length=200_000)


@op("update_profile", UpdateProfile)
def update_profile(tx: Tx, p: UpdateProfile) -> None:
    if tx.profile().strip() != p.markdown.strip():
        tx.set_profile(p.markdown)


PUBLIC = [AddWorkout, UpdateWorkout, MoveWorkout, DeleteWorkout, DuplicateWorkout, CopyWorkout,
          SetWorkoutStatus, SetTags, ShiftWorkouts, BulkDelete, LogWorkout, LogActivity,
          UpdateActivity, DeleteActivity, LinkActivity, UnlinkActivity, CreateSeries, UpdateSeries,
          EndSeries, AddExercise, UpdateExercise, ArchiveExercise, MergeExercise, AddSavedWorkout,
          UpdateSavedWorkout, DeleteSavedWorkout, UpdateProfile]
