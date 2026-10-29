"""Health and performance queries. Every result states what it is built from.

House rules (DECISIONS / handoff §10.3): missing days are gaps (None), never zero, and are
never interpolated; every aggregate carries n and coverage; baselines need enough prior
observations and say "unavailable" until then; averages of pace are computed from total
time over total distance, not by averaging instantaneous pace; associations are labelled
exploratory with their lag convention and pair count.
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from garmin.parse import utc_to_local
from health.metrics import METRICS
from models import Activity, DailyMetric, SleepNight, Workout


def _days(start: date, end: date) -> list[date]:
    return [start + timedelta(days=i) for i in range((end - start).days + 1)]


def _stats(vals: list[float]) -> dict:
    if not vals:
        return {"n": 0}
    out = {"n": len(vals), "mean": round(statistics.fmean(vals), 2), "min": min(vals), "max": max(vals),
           "median": round(statistics.median(vals), 2)}
    if len(vals) > 1:
        out["sd"] = round(statistics.stdev(vals), 2)
    return out


def daily(db: Session, metric: str, start: date, end: date, *, baseline_window: int = 28,
          baseline_min: int = 14) -> dict:
    """One value per calendar day (None = no data) plus a personal baseline band."""
    m = METRICS.get(metric)
    rows = db.execute(select(DailyMetric.day, DailyMetric.value, DailyMetric.source)
                      .where(DailyMetric.metric == metric)
                      .where(DailyMetric.day >= start - timedelta(days=baseline_window))
                      .where(DailyMetric.day <= end)).all()
    by_day: dict[date, float] = {}
    sources = set()
    for d, v, src in rows:
        by_day[d] = v  # one source per day in practice (garmin or demo)
        sources.add(src)
    points, base = [], []
    for d in _days(start, end):
        v = by_day.get(d)
        points.append([d.isoformat(), v])
        prior = [by_day[x] for x in _days(d - timedelta(days=baseline_window), d - timedelta(days=1)) if x in by_day]
        if len(prior) >= baseline_min:
            mu, sd = statistics.fmean(prior), statistics.stdev(prior)
            base.append([d.isoformat(), round(mu, 2), round(sd, 2)])
        else:
            base.append([d.isoformat(), None, None])
    vals = [v for _, v in points if v is not None]
    last = next(((d, v) for d, v in reversed(points) if v is not None), None)
    return {
        "metric": metric, "label": m.label if m else metric, "unit": m.unit if m else "",
        "meaning": m.meaning if m else "", "estimate": bool(m and m.estimate),
        "points": points, "baseline": base,
        "baseline_rule": f"mean ± 1 SD of the previous {baseline_window} recorded days (needs ≥ {baseline_min})",
        "stats": _stats(vals), "expected": len(points), "missing": len(points) - len(vals),
        "gaps": _gaps(points), "last": {"day": last[0], "value": last[1]} if last else None,
        "sources": sorted(sources),
    }


def _gaps(points: list[list]) -> list[list[str]]:
    out, run = [], None
    for d, v in points:
        if v is None:
            run = [run[0], d] if run else [d, d]
        elif run:
            out.append(run)
            run = None
    if run:
        out.append(run)
    return out


def sleep_timeline(db: Session, start: date, end: date) -> dict:
    """Bed and wake as local clock hours (bed before midnight is negative: 23:15 → -0.75)."""
    rows = {n.day: n for n in db.scalars(select(SleepNight).where(SleepNight.day >= start)
                                          .where(SleepNight.day <= end))}
    nights = []
    for d in _days(start, end):
        n = rows.get(d)
        if n is None or n.start_utc is None or n.end_utc is None:
            nights.append({"day": d.isoformat(), "bed": None, "wake": None, "hours": None})
            continue
        off = int(n.tz_offset_min or 0)
        bed_l, wake_l = utc_to_local(n.start_utc, off), utc_to_local(n.end_utc, off)
        midnight = datetime(d.year, d.month, d.day)  # the wake-up day's local midnight
        bed = (bed_l - midnight).total_seconds() / 3600
        wake = (wake_l - midnight).total_seconds() / 3600
        asleep = sum(x or 0 for x in (n.deep_s, n.light_s, n.rem_s)) / 3600 or None
        nights.append({"day": d.isoformat(), "bed": round(bed, 2), "wake": round(wake, 2),
                       "hours": round(asleep, 2) if asleep else None,
                       "deep": n.deep_s, "light": n.light_s, "rem": n.rem_s, "awake": n.awake_s})
    got = [x for x in nights if x["bed"] is not None]
    med = lambda k: round(statistics.median([x[k] for x in got]), 2) if got else None  # noqa: E731
    return {"nights": nights, "n": len(got), "expected": len(nights), "median_bed": med("bed"),
            "median_wake": med("wake"), "estimate_note": "Sleep stages are device estimates."}


def _week_monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def weekly_volume(db: Session, start: date, end: date, sport: str = "run") -> dict:
    """Per week: actual distance (every activity of the type, recorded or manual) and planned
    distance (workout items) — kept separate, never summed."""
    from plan.views import planned

    s0, s1 = _week_monday(start), _week_monday(end)
    acts = db.scalars(select(Activity).where(Activity.sport == sport).where(Activity.local_date >= s0)
                      .where(Activity.local_date <= s1 + timedelta(days=6))).all()
    workouts = db.scalars(select(Workout).where(Workout.type == sport).where(Workout.status == "planned")
                          .where(Workout.week_monday >= s0).where(Workout.week_monday <= s1)).all()
    weeks: dict[date, dict[str, Any]] = {}
    m = s0
    while m <= s1:
        weeks[m] = {"monday": m.isoformat(), "actual_km": 0.0, "planned_km": None, "n": 0, "long_km": 0.0}
        m += timedelta(days=7)
    for a in acts:
        w = weeks.get(_week_monday(a.local_date))
        if w is None or not a.distance_m:
            continue
        km = a.distance_m / 1000
        w["actual_km"] += km
        w["n"] += 1
        w["long_km"] = max(w["long_km"], km)
    for x in workouts:
        km = planned(x.items)["distance_km"]
        if km:
            w = weeks[x.week_monday]
            w["planned_km"] = (w["planned_km"] or 0) + km
    out = []
    for w in weeks.values():
        out.append({**w, "actual_km": round(w["actual_km"], 1), "long_km": round(w["long_km"], 1),
                    "planned_km": round(w["planned_km"], 1) if w["planned_km"] is not None else None})
    return {"sport": sport, "weeks": out, "n_weeks": len(out),
            "rule": "Actual = distance of every activity of this type (recorded or entered by hand); "
                    "planned = the sum of planned workouts' items."}


def energy_by_sport(db: Session, start: date, end: date) -> dict:
    """Calories the device reports, per week and per type, plus one point per session.
    Only recordings with a calorie figure count; the rest are reported as `without`, never zero.
    Garmin's figure is total energy (resting + active), an estimate."""
    acts = db.scalars(select(Activity).where(Activity.local_date >= start).where(Activity.local_date <= end)
                      .order_by(Activity.start_utc)).all()
    weeks: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    by: dict[str, dict[str, float]] = defaultdict(lambda: {"kcal": 0.0, "hours": 0.0, "n": 0})
    sessions: list[dict] = []
    without = 0
    for a in acts:
        if not a.calories or a.calories <= 0:
            without += 1
            continue
        secs = a.moving_s or a.duration_s or 0
        weeks[_week_monday(a.local_date).isoformat()][a.sport] += a.calories
        t = by[a.sport]
        t["kcal"] += a.calories
        t["hours"] += secs / 3600
        t["n"] += 1
        sessions.append({"id": a.id, "date": a.local_date.isoformat(), "sport": a.sport, "name": a.name,
                         "minutes": round(secs / 60, 1) if secs else None, "kcal": round(a.calories)})
    sports = sorted(by, key=lambda sp: -by[sp]["kcal"])
    return {"weeks": [{"monday": w, **{sp: round(weeks[w].get(sp, 0)) for sp in sports}} for w in sorted(weeks)],
            "sports": sports,
            "by_sport": [{"sport": sp, "kcal": round(by[sp]["kcal"]), "hours": round(by[sp]["hours"], 2), "n": int(by[sp]["n"]),
                          "kcal_per_h": round(by[sp]["kcal"] / by[sp]["hours"]) if by[sp]["hours"] else None} for sp in sports],
            "sessions": sessions, "n": len(sessions), "without": without,
            "rule": "Device calories (resting + active, an estimate) for recorded activities; sessions without a figure are left out, not counted as zero."}


def load_by_sport(db: Session, start: date, end: date) -> dict:
    """Weekly duration (hours) per type, plus session-RPE load where both are known."""
    acts = db.scalars(select(Activity).where(Activity.local_date >= start).where(Activity.local_date <= end)).all()
    weeks: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    srpe: dict[str, float] = defaultdict(float)
    srpe_n: dict[str, int] = defaultdict(int)
    for a in acts:
        wk = _week_monday(a.local_date).isoformat()
        h = (a.moving_s or a.duration_s or 0) / 3600
        weeks[wk][a.sport] += h
        if a.rpe and h:
            srpe[wk] += h * 60 * float(a.rpe)
            srpe_n[wk] += 1
    sports = sorted({sp for w in weeks.values() for sp in w})
    ordered = sorted(weeks)
    return {"weeks": [{"monday": w, **{sp: round(weeks[w].get(sp, 0), 2) for sp in sports},
                       "srpe": round(srpe[w]) if srpe_n[w] else None, "srpe_n": srpe_n[w]} for w in ordered],
            "sports": sports, "unit": "h",
            "srpe_rule": "session-RPE load = RPE × minutes, only for activities with both recorded"}
