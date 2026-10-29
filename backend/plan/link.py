"""Recordings ↔ planned workouts: auto-link after a Garmin import, and the Inbox.

Auto-link is deliberately narrow: a recording is linked only when it has the same date and
type as exactly one candidate workout (planned, not skipped, with no recording yet — a manual
"done" is fine) and no other new recording competes for it. If the workout was done by hand,
the manual activity's annotations move to the recording and the empty manual row goes (see
ops.link). Everything else waits in the Inbox. Only recordings the plan side has never touched
(`version` 0) are considered, so a recording the athlete unlinked is never re-linked.
"""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from models import Activity, SavedWorkout, Workout
from plan import clock
from plan.changes import apply_change
from plan.types import MARKS
from plan.views import activity_view, chip, exercise_names, workout_view

AUTOLINK_DAYS = 60
INBOX_DAYS = 28


def _recordings(db: Session, since: date, today: date):
    return select(Activity).where(Activity.source != "manual").where(Activity.workout_id.is_(None)) \
        .where(Activity.kept_unplanned.is_not(True)).where(Activity.local_date >= since) \
        .where(Activity.local_date <= today)


def _open_workouts(db: Session, start: date, end: date) -> list[Workout]:
    """Planned workouts in [start, end] that no recording is linked to yet."""
    ws = list(db.scalars(select(Workout).where(Workout.date >= start).where(Workout.date <= end)
                         .where(Workout.status == "planned")))
    if not ws:
        return []
    taken = set(db.scalars(select(Activity.workout_id).where(Activity.workout_id.in_([w.id for w in ws]))
                           .where(Activity.source != "manual")))
    return [w for w in ws if w.id not in taken]


def autolink(db: Session, today: date | None = None) -> dict | None:
    today = today or clock.today()
    since = today - timedelta(days=AUTOLINK_DAYS)
    recs = list(db.scalars(_recordings(db, since, today)
                           .where(or_(Activity.version == 0, Activity.version.is_(None)))))
    if not recs:
        return None
    open_ws = _open_workouts(db, since, today)
    ops, expected = [], {}
    for a in recs:
        rivals = [r for r in recs if r.local_date == a.local_date and r.sport == a.sport]
        cands = [w for w in open_ws if w.date == a.local_date and w.type == a.sport]
        if len(rivals) == 1 and len(cands) == 1:
            w = cands[0]
            ops.append({"op": "link_activity", "activity_id": a.id, "workout_id": w.id})
            expected[f"workout:{w.id}"] = w.version
            expected[f"activity:{a.id}"] = a.version or 0
    if not ops:
        return None
    return apply_change(db, ops, source="import", expected=expected,
                        reason="Linked new recordings to their planned workouts").as_dict()


def inbox(db: Session, today: date | None = None, days: int = INBOX_DAYS) -> dict:
    """What needs a decision: unlinked recordings that could belong to a workout (same type,
    within a day), and past workouts that were neither done nor skipped."""
    today = today or clock.today()
    since = today - timedelta(days=days)
    recs = list(db.scalars(_recordings(db, since, today).order_by(Activity.start_utc.desc())))
    open_ws = _open_workouts(db, since - timedelta(days=1), today + timedelta(days=1))
    recordings = []
    for a in recs:
        cands = [w for w in open_ws if w.type == a.sport and w.date is not None
                 and abs((w.date - a.local_date).days) <= 1]
        if not cands:
            continue  # nothing it could belong to: simply unplanned, no decision needed
        cands.sort(key=lambda w: (w.date != a.local_date, abs((w.date - a.local_date).days)))
        same_day = [w for w in cands if w.date == a.local_date]
        rivals = [r for r in recs if r.local_date == a.local_date and r.sport == a.sport]
        recordings.append({"activity": activity_view(a), "ambiguous": len(same_day) > 1 or len(rivals) > 1,
                           "candidates": [chip(w, [], today) for w in cands[:5]]})
    linked = set(db.scalars(select(Activity.workout_id).where(Activity.workout_id.is_not(None))))
    names = exercise_names(db)
    not_logged = [workout_view(w, [], names, today) for w in db.scalars(
        select(Workout).where(Workout.date >= since).where(Workout.date < today)
        .where(Workout.status == "planned").order_by(Workout.date.desc(), Workout.position))
        if w.id not in linked]
    return {"recordings": recordings, "not_logged": not_logged, "count": len(recordings) + len(not_logged),
            "window": [since.isoformat(), today.isoformat()]}


LINK_DAYS = 7


def options(db: Session, activity_id: str, today: date | None = None) -> dict:
    """Where an activity can be linked: planned workouts within a week either side of it with no
    recording yet (of its type when there are any, nearest day first), and saved workouts to make a workout from
    on its day (same type first). One list for the week row, the Inbox and the log sheet."""
    a = db.get(Activity, activity_id)
    if a is None:
        return {"workouts": [], "saved": []}
    today = today or clock.today()
    ws = [w for w in _open_workouts(db, a.local_date - timedelta(days=LINK_DAYS), a.local_date + timedelta(days=LINK_DAYS))
          if w.id != a.workout_id]
    if any(w.type == a.sport for w in ws):
        ws = [w for w in ws if w.type == a.sport]  # a strength session goes with strength; others only as a fallback
    ws.sort(key=lambda w: (abs((w.date - a.local_date).days), w.date))
    saved = sorted(db.scalars(select(SavedWorkout)), key=lambda s: (s.type != a.sport, s.title.lower()))
    return {"workouts": [chip(w, [], today) for w in ws[:12]],
            "saved": [{"id": s.id, "title": s.title, "type": s.type, "mark": MARKS.get(s.type, "OTH")} for s in saved]}
