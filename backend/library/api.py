"""Library reads: exercises (with usage counts) and saved workouts. Writes go through the
change seam (add/update/archive/merge_exercise, add/update/delete_saved_workout)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import String, cast, select
from sqlalchemy.orm import Session

from db import get_session
from models import Exercise, SavedWorkout, Workout
from plan.types import MARKS
from plan.views import exercise_names, exercise_usage, items_view, planned

router = APIRouter(prefix="/api")


@router.get("/exercises")
def exercises(include_archived: bool = True, db: Session = Depends(get_session)) -> list[dict]:
    uses = exercise_usage(db)
    q = select(Exercise).order_by(Exercise.name)
    if not include_archived:
        q = q.where(Exercise.archived.is_(False))
    return [{"id": e.id, "version": e.version, "name": e.name, "type": e.type,
             "mark": MARKS.get(e.type, "OTH"), "default_measure": e.default_measure, "notes": e.notes,
             "media": e.media or [], "archived": bool(e.archived), "uses": uses.get(e.id, 0)}
            for e in db.scalars(q)]


@router.get("/saved-workouts")
def saved_workouts(db: Session = Depends(get_session)) -> list[dict]:
    names = exercise_names(db)
    return [{"id": s.id, "version": s.version, "title": s.title, "type": s.type,
             "mark": MARKS.get(s.type, "OTH"), "time": s.time, "tags": s.tags or [], "notes": s.notes,
             "items": items_view(s.items, names), "media": s.media or [], "planned": planned(s.items)}
            for s in db.scalars(select(SavedWorkout).order_by(SavedWorkout.title))]


@router.get("/exercises/{eid}/used-in")
def exercise_used_in(eid: str, limit: int = 5, db: Session = Depends(get_session)) -> list[dict]:
    """Workouts that use an exercise for the Library detail: the most recent ones up to today
    (newest first), then the next upcoming ones."""
    if db.get(Exercise, eid) is None:
        raise HTTPException(404, {"code": "exercise_not_found"})
    from plan import clock

    today = clock.today()
    rows = [w for w in db.scalars(select(Workout).where(cast(Workout.items, String).like(f'%"{eid}"%')))
            if any(i.get("exercise_id") == eid for i in w.items or [])]
    day = lambda w: w.date or w.week_monday  # noqa: E731
    past = sorted((w for w in rows if day(w) <= today), key=day, reverse=True)
    upcoming = sorted((w for w in rows if day(w) > today), key=day)
    n = min(max(limit, 1), 50)
    out = [{"id": w.id, "title": w.title, "type": w.type, "mark": MARKS.get(w.type, "OTH"),
            "date": w.date.isoformat() if w.date else None, "week_monday": w.week_monday.isoformat()}
           for w in (past + upcoming)[:n]]
    return out


@router.get("/exercises/{eid}/history")
def exercise_history(eid: str, limit: int = 20, db: Session = Depends(get_session)) -> list[dict]:
    """Sessions that logged sets of this exercise, newest first (library/progress.py)."""
    if db.get(Exercise, eid) is None:
        raise HTTPException(404, {"code": "exercise_not_found"})
    from library.progress import history

    return history(db, eid, min(max(limit, 1), 200))
