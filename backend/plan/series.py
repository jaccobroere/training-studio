"""Series occurrences as real workout rows.

A series materialises its slots up to a horizon (Sunday of the week 12 weeks ahead, or further
when someone reads a later week, capped at a year). `materialised_through` remembers how far
it got, so a slot is created at most once: deleting one occurrence sticks, and repeated reads
create nothing (the unique (series_id, series_date) pair is the backstop for races).
Slots before today are never created; history is never back-filled.
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models import Activity, Series, Workout
from plan import clock
from plan.changes import ChangeResult, Tx, internal, monday_of

HORIZON_WEEKS = 12
MAX_WEEKS = 52


def horizon(today: date, until: date | None = None) -> date:
    h = monday_of(today) + timedelta(weeks=HORIZON_WEEKS, days=6)
    if until is not None:
        h = max(h, min(until, monday_of(today) + timedelta(weeks=MAX_WEEKS, days=6)))
    return h


def slots(rule: dict, start: date, first: date, last: date) -> list[date]:
    """Dates in [first, last] matching the weekly rule, counting intervals from `start`'s week."""
    out = []
    interval, weekdays = int(rule.get("interval") or 1), set(rule.get("weekdays") or [])
    anchor = monday_of(start)
    d = max(first, start)
    while d <= last:
        if d.weekday() in weekdays and ((monday_of(d) - anchor).days // 7) % interval == 0:
            out.append(d)
        d += timedelta(days=1)
    return out


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


def next_position(tx: Tx, monday: date, day: date | None, skip: str | None = None) -> int:
    q = select(Workout.position).where(Workout.week_monday == monday)
    q = q.where(Workout.date.is_(None) if day is None else Workout.date == day)
    if skip:
        q = q.where(Workout.id != skip)
    tx.db.flush()
    positions = list(tx.db.scalars(q))
    return (max(positions) + 1) if positions else 0


def occurrence(s: Series, d: date, position: int) -> Workout:
    return Workout(id=new_id("w"), week_monday=monday_of(d), date=d, position=position, time=s.time,
                   title=s.title, type=s.type, tags=list(s.tags or []), notes=s.notes,
                   items=[dict(i) for i in s.items or []], media=list(s.media or []),
                   status="planned", skip_reason="", series_id=s.id, series_date=d, customised=False)


def materialise(tx: Tx, s: Series, through: date) -> int:
    """Create the series' rows for unmaterialised slots up to `through`. Returns the count."""
    today = clock.today()
    first = max(s.start_date, today)
    if s.materialised_through is not None:
        first = max(first, s.materialised_through + timedelta(days=1))
    last = min(through, s.end_date) if s.end_date else through
    tx.db.flush()
    existing = set(tx.db.scalars(select(Workout.series_date).where(Workout.series_id == s.id)))
    n = 0
    for d in slots(s.rule, s.start_date, first, last):
        if d not in existing:
            tx.add("workout", occurrence(s, d, next_position(tx, monday_of(d), d)))
            n += 1
    if s.materialised_through is None or s.materialised_through < through:
        s.materialised_through = through
    return n


def has_activity(tx: Tx, workout_id: str) -> bool:
    tx.db.flush()
    return tx.db.scalars(select(Activity.id).where(Activity.workout_id == workout_id)).first() is not None


def removable(tx: Tx, w: Workout) -> bool:
    """Future (today counts) and not logged: the only rows series edits may delete."""
    return (w.date is None or w.date >= clock.today()) and not has_activity(tx, w.id)


def due(db: Session, through: date) -> list[Series]:
    return list(db.scalars(select(Series).where(or_(Series.materialised_through.is_(None),
                                                     Series.materialised_through < through))
                           .where(or_(Series.end_date.is_(None),
                                      Series.materialised_through.is_(None),
                                      Series.end_date > Series.materialised_through))))


@internal("_top_up", "system")
def _op_top_up(tx: Tx, raw: dict) -> None:
    through = date.fromisoformat(raw["through"])
    for s in due(tx.db, through):
        materialise(tx, tx.get("series", s.id), through)


def top_up(db: Session, until: date | None = None) -> ChangeResult | None:
    """Idempotent: called on every week read. Writes (as one hidden `system` change) only when
    some series has slots left to create before the horizon."""
    from plan.changes import apply_change

    through = horizon(clock.today(), until)
    if not due(db, through):
        return None
    try:
        return apply_change(db, [{"op": "_top_up", "through": through.isoformat()}], source="system",
                            reason="Planned repeating workouts ahead")
    except IntegrityError:  # a concurrent read topped up first
        db.rollback()
        return None
