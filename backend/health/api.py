"""Health: the fixed overview's data (SIMPLIFY.md §2). No layouts — the page is a fixed design
plus Pinned analyses (analysis/api.py). Every range takes `start`/`end` (dates) or `days`
(ending today, default per endpoint); missing days are gaps, never zero (health/queries.py)."""

from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from db import get_session
from garmin.store import activity_view
from health import queries as q
from health.metrics import METRICS
from models import Activity, DailyMetric
from plan import clock
from plan.types import TYPES

router = APIRouter(prefix="/api/health")

OVERVIEW_METRICS = ("hrv_ms", "rhr_bpm", "sleep_h", "sleep_score", "stress_avg", "bb_max", "steps")
MAX_DAYS = 3660


def _range(start: date | None, end: date | None, days: int) -> tuple[date, date]:
    end = end or clock.today()
    s = start or end - timedelta(days=days - 1)
    if s > end:
        raise HTTPException(422, {"code": "bad_range", "detail": "start is after end"})
    if (end - s).days >= MAX_DAYS:
        raise HTTPException(422, {"code": "bad_range", "detail": f"at most {MAX_DAYS} days"})
    return s, end


def _base(s: date, e: date) -> dict:
    return {"start": s.isoformat(), "end": e.isoformat()}


@router.get("/metrics")
def metrics() -> list[dict]:
    """The metric catalogue: one definition per number."""
    return [{"key": m.key, "label": m.label, "unit": m.unit, "meaning": m.meaning, "better": m.better,
             "estimate": m.estimate} for m in METRICS.values()]


@router.get("/overview")
def overview(start: date | None = None, end: date | None = None, days: int = Query(28, ge=7, le=MAX_DAYS),
             db: Session = Depends(get_session)) -> dict:
    """Tiles (latest value vs personal baseline + a sparkline), this week's training load vs
    the previous four weeks, and the latest activities."""
    s, e = _range(start, end, days)
    tiles = []
    for key in OVERVIEW_METRICS:
        d = q.daily(db, key, s, e)
        base = next((b for b in reversed(d["baseline"]) if b[1] is not None), None)
        last = d["last"]
        tiles.append({"metric": key, "label": d["label"], "unit": d["unit"], "estimate": d["estimate"],
                      "better": METRICS[key].better, "latest": last,
                      "baseline": {"mean": base[1], "sd": base[2]} if base else None,
                      "delta": round(last["value"] - base[1], 2) if last and base else None,
                      "points": d["points"], "stats": d["stats"], "missing": d["missing"], "expected": d["expected"]})
    monday = e - timedelta(days=e.weekday())
    load = q.load_by_sport(db, monday - timedelta(weeks=4), e)
    this = next((w for w in load["weeks"] if w["monday"] == monday.isoformat()), None)
    prev = [w for w in load["weeks"] if w["monday"] != monday.isoformat()]
    hours = lambda w: round(sum(w.get(sp, 0) for sp in load["sports"]), 2) if w else 0.0  # noqa: E731
    recent = db.scalars(select(Activity).where(Activity.local_date <= e)
                        .order_by(Activity.start_utc.desc()).limit(5)).all()
    return {**_base(s, e), "tiles": tiles,
            "load": {"week_monday": monday.isoformat(), "hours": hours(this),
                     "by_type": {sp: this.get(sp, 0) for sp in load["sports"]} if this else {},
                     "prev4_mean_hours": round(sum(hours(w) for w in prev) / 4, 2),
                     "rule": "Hours of every activity (recorded or logged); previous four weeks averaged over 4."},
            "recent_activities": [activity_view(a) for a in recent],
            "data_through": (lambda d: d.isoformat() if d else None)(db.scalar(select(func.max(DailyMetric.day))))}


@router.get("/daily/{metric}")
def daily(metric: str, start: date | None = None, end: date | None = None, days: int = Query(90, ge=1, le=MAX_DAYS),
          db: Session = Depends(get_session)) -> dict:
    """One metric per calendar day (null = no data) with a personal baseline band (HRV, RHR…)."""
    if metric not in METRICS:
        raise HTTPException(404, {"code": "unknown_metric"})
    s, e = _range(start, end, days)
    return {**_base(s, e), **q.daily(db, metric, s, e)}


@router.get("/sleep")
def sleep(start: date | None = None, end: date | None = None, days: int = Query(28, ge=1, le=MAX_DAYS),
          db: Session = Depends(get_session)) -> dict:
    """Per night: bed/wake as local clock hours, total asleep and stages."""
    s, e = _range(start, end, days)
    return {**_base(s, e), **q.sleep_timeline(db, s, e)}


@router.get("/load")
def load(start: date | None = None, end: date | None = None, days: int = Query(84, ge=7, le=MAX_DAYS),
         db: Session = Depends(get_session)) -> dict:
    """Weekly hours per type plus session-RPE load."""
    s, e = _range(start, end, days)
    return {**_base(s, e), **q.load_by_sport(db, s, e)}


@router.get("/energy")
def energy(start: date | None = None, end: date | None = None, days: int = Query(84, ge=7, le=MAX_DAYS),
           db: Session = Depends(get_session)) -> dict:
    """Calories per week and per type, and one point per session (minutes vs kcal)."""
    s, e = _range(start, end, days)
    return {**_base(s, e), **q.energy_by_sport(db, s, e)}


@router.get("/volume")
def volume(type: str = "run", start: date | None = None, end: date | None = None,
           days: int = Query(84, ge=7, le=MAX_DAYS), db: Session = Depends(get_session)) -> dict:
    """Weekly distance for one type: actual and planned, side by side, never summed."""
    if type not in TYPES:
        raise HTTPException(422, {"code": "unknown_type"})
    s, e = _range(start, end, days)
    return {**_base(s, e), **q.weekly_volume(db, s, e, type)}


@router.get("/activities")
def activities(type: str | None = None, start: date | None = None, end: date | None = None,
               days: int = Query(90, ge=1, le=MAX_DAYS), limit: int = Query(200, ge=1, le=500),
               db: Session = Depends(get_session)) -> dict:
    s, e = _range(start, end, days)
    qq = select(Activity).where(Activity.local_date >= s).where(Activity.local_date <= e)
    if type:
        qq = qq.where(Activity.sport == type)
    rows = db.scalars(qq.order_by(Activity.start_utc.desc()).limit(limit)).all()
    return {**_base(s, e), "activities": [activity_view(a) for a in rows], "n": len(rows)}


@router.get("/run")
def run_detail(activity_id: str | None = None, points: int = Query(1200, ge=50, le=5000),
               db: Session = Depends(get_session)) -> dict:
    """One activity with laps and its (display-downsampled) stream; without an id, the latest
    run that has a stream. `activity: null` when there is none."""
    from garmin.api import activity as activity_detail

    if activity_id is None:
        activity_id = db.scalar(select(Activity.id).where(Activity.sport == "run")
                                .where(Activity.stream_path.is_not(None)).order_by(Activity.start_utc.desc()))
        if activity_id is None:
            return {"activity": None}
    return {"activity": activity_detail(activity_id, points, db)}


ANALYSED = ("run", "ride", "skate", "walk")  # the latest-activity default looks among these


@router.get("/bests")
def bests(type: str = "run", start: date | None = None, end: date | None = None,
          days: int = Query(84, ge=7, le=MAX_DAYS), db: Session = Depends(get_session)) -> dict:
    """Personal bests for one type: the speed–duration curve and fastest distances, in the
    period and of all time (health/derived.py)."""
    from health.derived import bests as compute

    if type not in TYPES:
        raise HTTPException(422, {"code": "unknown_type"})
    s, e = _range(start, end, days)
    return {**_base(s, e), **compute(db, type, s, e)}


@router.get("/efficiency")
def efficiency(type: str = "run", start: date | None = None, end: date | None = None,
               days: int = Query(365, ge=28, le=MAX_DAYS), db: Session = Depends(get_session)) -> dict:
    """Efficiency factor and decoupling per session, easy/steady ones marked, monthly medians."""
    from health.derived import efficiency as compute

    if type not in TYPES:
        raise HTTPException(422, {"code": "unknown_type"})
    s, e = _range(start, end, days)
    # One reference for the whole trend: the highest HR in the 365 days up to the period's end.
    ref = db.scalar(select(func.max(Activity.max_hr)).where(Activity.local_date <= e)
                    .where(Activity.local_date > e - timedelta(days=365)))
    return {**_base(s, e), "hr_ref": ref, **compute(db, type, s, e, ref)}


def hr_reference(db: Session, a: Activity, stream_max: float | None) -> float | None:
    """The max HR zones are measured against: the highest heart rate recorded in the 365 days up
    to this activity (device max HR per activity, and this activity's own stream)."""
    top = db.scalar(select(func.max(Activity.max_hr)).where(Activity.local_date <= a.local_date)
                    .where(Activity.local_date > a.local_date - timedelta(days=365)))
    return max([x for x in (top, stream_max) if x], default=None)


@router.get("/activity")
def activity_latest(type: str | None = None, points: int = Query(1500, ge=50, le=5000),
                    db: Session = Depends(get_session)) -> dict:
    """The latest run, ride, skate or walk (or of `type`) that has a stream, analysed."""
    qq = select(Activity.id).where(Activity.stream_path.is_not(None))
    qq = qq.where(Activity.sport == type) if type else qq.where(Activity.sport.in_(ANALYSED))
    aid = db.scalar(qq.order_by(Activity.start_utc.desc()))
    return activity_analysis(aid, points, db) if aid else {"activity": None, "stats": None}


@router.get("/activity/{aid}")
def activity_analysis(aid: str, points: int = Query(1500, ge=50, le=5000), db: Session = Depends(get_session)) -> dict:
    """One activity (as /api/activities/{id}, display-downsampled stream without positions) plus
    the stream analysis (health/activity_stats.py). `stats: null` without a stream."""
    from garmin.api import activity as activity_detail
    from garmin.store import stream_for
    from health.activity_stats import analyse

    a = db.get(Activity, aid)
    if a is None:
        raise HTTPException(404, {"code": "activity_not_found"})
    stream = stream_for(db, a)
    detail = activity_detail(aid, points, db)
    if detail.get("stream"):  # the per-second stream stays without positions; the route card gets absolute degrees in stats.route
        detail["stream"] = {k: v for k, v in detail["stream"].items() if k not in ("lat", "lon")}
    hr = [x for x in (stream or {}).get("hr") or [] if x is not None]
    ref = hr_reference(db, a, max(hr) if hr else None)
    stats = analyse(stream, a.sport, a.laps or [], hr_ref=ref)
    if stats is not None:
        stats["hr_ref_rule"] = "Reference max HR = the highest heart rate recorded in the 365 days up to this activity."
    return {"activity": detail, "stats": stats}
