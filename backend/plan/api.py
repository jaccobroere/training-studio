"""HTTP routes for the Plan: week, weeks, workouts, series, inbox, and the change seam with
its history and undo. Routing and validation only; rules live in plan/ops.py and reads in
plan/views.py. Every read that shows dates runs the idempotent series top-up first."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import String, cast, select
from sqlalchemy.orm import Session

from db import get_session
from models import PlanChange, Series, Setting, Workout
from plan import changes, clock, link, series, views
from plan.changes import HIDDEN_SOURCES, monday_of

router = APIRouter(prefix="/api")
MAX_WEEKS = 60


class ChangeIn(BaseModel):
    ops: list[dict[str, Any]] = Field(min_length=1, max_length=500)
    reason: str = ""
    expected: dict[str, int] = Field(default_factory=dict)
    op_id: str | None = Field(default=None, max_length=80)
    dry_run: bool = False


class UndoIn(BaseModel):
    op_id: str | None = Field(default=None, max_length=80)


def _date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as e:
        raise HTTPException(422, {"code": "bad_date", "detail": value}) from e


@router.get("/today")
def today() -> dict:
    t = clock.today()
    return {"today": t.isoformat(), "monday": monday_of(t).isoformat(),
            "now": clock.now().isoformat(), "timezone": str(clock.tz())}


@router.get("/week/{monday}")
def get_week(monday: str, db: Session = Depends(get_session)) -> dict:
    m = monday_of(_date(monday))
    series.top_up(db, m + timedelta(days=6))
    return views.week_view(db, m)


@router.post("/welcome/dismiss")
def dismiss_welcome(db: Session = Depends(get_session)) -> dict:
    db.merge(Setting(key="onboarding", value={"dismissed": True}))
    db.commit()
    return {"ok": True}


@router.get("/weeks")
def get_weeks(start: str = Query(alias="from"), end: str = Query(alias="to"), tag: str | None = None,
              db: Session = Depends(get_session)) -> dict:
    s, e = monday_of(_date(start)), monday_of(_date(end))
    if e < s or (e - s).days // 7 >= MAX_WEEKS:
        raise HTTPException(422, {"code": "bad_range", "detail": f"from ≤ to, at most {MAX_WEEKS} weeks"})
    series.top_up(db, e + timedelta(days=6))
    return views.weeks_view(db, s, e, tag.strip().lower() if tag else None)


@router.get("/workouts/{wid}")
def get_workout(wid: str, db: Session = Depends(get_session)) -> dict:
    w = db.get(Workout, wid)
    if w is None:
        raise HTTPException(404, {"code": "workout_not_found"})
    return views.workout_detail(db, w)


@router.get("/tags")
def tags(db: Session = Depends(get_session)) -> list[dict]:
    return views.tags_in_use(db)


@router.get("/series")
def list_series(db: Session = Depends(get_session)) -> list[dict]:
    return [views.series_view(s) for s in db.scalars(select(Series).order_by(Series.start_date.desc()))]


@router.get("/series/{sid}")
def get_series(sid: str, db: Session = Depends(get_session)) -> dict:
    s = db.get(Series, sid)
    if s is None:
        raise HTTPException(404, {"code": "series_not_found"})
    series.top_up(db)
    names = views.exercise_names(db)
    t = clock.today()
    rows = db.scalars(select(Workout).where(Workout.series_id == sid)
                      .order_by(Workout.series_date)).all()
    return {**views.series_view(s, names),
            "upcoming": [views.chip(w, [], t) for w in rows if w.date is None or w.date >= t][:20],
            "n_occurrences": len(rows)}


@router.get("/inbox")
def inbox(db: Session = Depends(get_session)) -> dict:
    return link.inbox(db)


@router.get("/activities/{aid}/link-options")
def link_options(aid: str, db: Session = Depends(get_session)) -> dict:
    return link.options(db, aid)


# ------------------------------------------------------------------ the change seam

@router.post("/changes")
def post_change(body: ChangeIn, db: Session = Depends(get_session)) -> dict:
    if any(str(o.get("op", "")).startswith("_") for o in body.ops):
        raise HTTPException(422, {"code": "unknown_op"})
    return changes.apply_change(db, body.ops, source="ui", reason=body.reason, expected=body.expected,
                                op_id=body.op_id, dry_run=body.dry_run).as_dict()


@router.get("/changes")
def history(week: str | None = None, limit: int = Query(30, le=200),
            db: Session = Depends(get_session)) -> list[dict]:
    """Recent changes, newest first (automatic `system` changes are not listed)."""
    q = select(PlanChange).where(PlanChange.source.not_in(HIDDEN_SOURCES))
    if week:
        q = q.where(cast(PlanChange.weeks, String).like(f'%"{monday_of(_date(week)).isoformat()}"%'))
    return [views.change_brief(r) for r in db.scalars(q.order_by(PlanChange.at.desc()).limit(limit))]


@router.get("/changes/{change_id}")
def get_change(change_id: str, db: Session = Depends(get_session)) -> dict:
    row = db.get(PlanChange, change_id)
    if row is None:
        raise HTTPException(404, {"code": "change_not_found"})
    res = changes._result_from_row(row).as_dict()
    res.update(source=row.source, reason=row.reason, undone_by_id=row.undone_by_id,
               undoes_id=row.undoes_id)
    return res


@router.post("/changes/{change_id}/undo")
def undo(change_id: str, body: UndoIn, db: Session = Depends(get_session)) -> dict:
    return changes.undo(db, change_id, op_id=body.op_id).as_dict()
