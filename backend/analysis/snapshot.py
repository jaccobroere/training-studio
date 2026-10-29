"""Scoped, read-only dataset snapshots for analysis jobs. Only what the job asked for is
exported (no routes, no credentials). Every dataset is a list of flat rows; the sandbox turns
each into a pandas DataFrame `data[name]`.

Ranges may be absolute ("2026-09-01") or relative to today, so a pinned analysis stays live:
"today", "yesterday", "-90d", "-12w", "-6m", "-1y" (that long before today), and as a start
only "last_90_days" / "last_12_weeks" / "last_6_months" / "last_1_years" (a window of that length
ending today, today included). `end` defaults to "today".

Kinds and their columns are listed in COLUMNS (and in the run_analysis tool description).
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from health.metrics import METRICS
from models import Activity, DailyMetric, Exercise, SleepNight, Workout

MAX_DAYS = 5 * 366
CAPS = {"daily": 5 * 366, "sleep": 5 * 366, "activities": 5000, "laps": 20000, "streams": 30000, "workouts": 3000,
        "workout_items": 10000, "sets": 30000}
STREAM_ACTIVITIES = 10  # at most this many activities per streams dataset
STREAM_DEFAULT = 3  # latest N activities with a stream when no ids are given
STREAM_POINTS = 3600  # per activity after sampling

DAILY_DERIVED = {
    "sleep_deep_h": "deep sleep (h, night ending on day)", "sleep_light_h": "light sleep (h)",
    "sleep_rem_h": "REM sleep (h)", "sleep_awake_h": "awake in bed (h)",
    "train_min": "minutes of recorded/logged activity that day (0 = none)",
    "train_km": "km of activity that day (0 = none)",
    "srpe": "session-RPE load that day = Σ RPE × minutes (null when no RPE given)",
}
COLUMNS = {
    "daily": ["day", "<metric keys>", *DAILY_DERIVED],
    "sleep": ["day", "bed_local", "wake_local", "bed_h", "wake_h", "asleep_h", "deep_h", "light_h", "rem_h",
              "awake_h", "score"],
    "activities": ["id", "local_date", "start_local", "type", "name", "source", "duration_min", "moving_min",
                   "distance_km", "pace_s_per_km", "speed_kmh", "avg_hr", "max_hr", "elevation_gain_m", "calories",
                   "n_laps", "has_stream", "rpe", "srpe", "notes", "workout_id", "planned"],
    "laps": ["activity_id", "local_date", "type", "lap", "start_s", "elapsed_s", "timer_s", "distance_m",
             "pace_s_per_km", "avg_hr", "max_hr"],
    "streams": ["activity_id", "local_date", "type", "t_s", "hr", "speed_ms", "pace_s_per_km", "power", "cadence",
                "altitude_m", "distance_m"],
    "workouts": ["id", "date", "week_monday", "time", "type", "title", "tags", "status", "series_id", "n_items",
                 "items", "planned_km", "planned_min", "activity_ids", "actual_km", "actual_min", "avg_hr", "rpe",
                 "recorded"],
    "workout_items": ["workout_id", "date", "week_monday", "type", "title", "status", "position", "exercise_id",
                      "exercise", "sets", "reps", "load", "duration_min", "distance_km", "intensity", "note"],
    "sets": ["activity_id", "local_date", "type", "workout_id", "exercise_id", "exercise", "item_id", "set_no",
             "reps", "kg", "secs", "volume_kg", "e1rm_kg", "planned_sets", "planned_reps", "planned_load"],
}
Kind = Literal["daily", "sleep", "activities", "laps", "streams", "workouts", "workout_items", "sets"]

_REL = re.compile(r"^-(\d{1,4})([dwmy])$")
_LAST = re.compile(r"^last_(\d{1,4})_(days|weeks|months|years)$")


class DatasetSpec(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str = Field(pattern=r"^[a-z][a-z0-9_]{0,30}$", description="variable name: data[name]")
    kind: Kind
    start: str = Field(description='"2026-09-01", "-90d", "-12w", "-6m", "-1y", "last_90_days", "today"')
    end: str = Field("today", description='same forms; default "today"')
    metrics: list[str] = Field(default_factory=list, description="daily: metric keys (empty = all)")
    type: str | None = Field(None, validation_alias=AliasChoices("type", "sport"),
                             description="activities/laps/streams/workouts: type filter, e.g. run")
    activity_ids: list[str] = Field(default_factory=list, max_length=STREAM_ACTIVITIES,
                                    description="laps/streams: these activities (else the range)")
    limit: int | None = Field(None, ge=1, le=STREAM_ACTIVITIES,
                              description=f"streams: latest N activities with a stream (default {STREAM_DEFAULT})")
    every_s: int | None = Field(None, ge=1, le=600, description="streams: one sample per N seconds (default auto)")

    def is_relative(self) -> bool:
        return not (_is_abs(self.start) and _is_abs(self.end))


def _is_abs(s: str) -> bool:
    return bool(re.match(r"^\d{4}-\d{2}-\d{2}$", s))


def _minus_months(d: date, n: int) -> date:
    y, m = divmod(d.year * 12 + d.month - 1 - n, 12)
    m += 1
    for day in (d.day, 30, 29, 28):
        try:
            return date(y, m, day)
        except ValueError:
            continue
    raise ValueError


def resolve_date(s: str, today: date, *, is_start: bool = False) -> date:
    s = (s or "").strip().lower()
    if s == "today":
        return today
    if s == "yesterday":
        return today - timedelta(days=1)
    if m := _REL.match(s):
        n, u = int(m[1]), m[2]
        if u == "d":
            return today - timedelta(days=n)
        if u == "w":
            return today - timedelta(weeks=n)
        return _minus_months(today, n * (12 if u == "y" else 1))
    if (m := _LAST.match(s)) and is_start:
        n, u = int(m[1]), m[2][0]
        return resolve_date(f"-{n}{u}", today) + timedelta(days=1)
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise ValueError(f"bad date {s!r}: use YYYY-MM-DD, 'today', '-90d', '-12w', '-6m', '-1y'"
                         + (" or 'last_90_days'" if is_start else "")) from None


def resolve(spec: DatasetSpec, today: date) -> tuple[date, date]:
    s, e = resolve_date(spec.start, today, is_start=True), resolve_date(spec.end, today)
    if e < s:
        raise ValueError(f"{spec.name}: end {e} is before start {s}")
    if (e - s).days > MAX_DAYS:
        raise ValueError(f"{spec.name}: range is {(e - s).days} days; at most {MAX_DAYS}")
    return s, e


def relativize(spec: DatasetSpec, ran_on: date) -> DatasetSpec:
    """For pinning: an absolute window that ended at (or just before) the day it ran becomes
    "-Nd … today", so the pinned analysis keeps showing the latest data. A window that ended
    earlier (a past block) stays absolute."""
    if spec.is_relative():
        return spec
    s, e = date.fromisoformat(spec.start), date.fromisoformat(spec.end)
    if e < ran_on - timedelta(days=1):
        return spec
    return spec.model_copy(update={"start": f"-{(ran_on - s).days}d", "end": "today"})


@dataclass
class Snapshot:
    data: dict[str, list[dict]]
    digest: str
    rows: dict[str, int]
    ranges: list[dict] = field(default_factory=list)


def _r(v, n=2):
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else round(float(v), n)


def _pace(seconds, metres):
    return round(seconds / (metres / 1000), 1) if seconds and metres and metres > 50 else None


def _cap(kind: str, rows: list, name: str) -> list:
    if len(rows) > CAPS[kind]:
        raise ValueError(f"{name}: {len(rows)} rows — at most {CAPS[kind]} for kind {kind}; shorten the range "
                         "or filter by type")
    return rows


def _local(dt, off) -> str | None:
    return (dt + timedelta(minutes=off or 0)).isoformat(timespec="seconds") if dt else None


def _activities(db: Session, spec: DatasetSpec, s: date, e: date) -> list[Activity]:
    q = select(Activity).where(Activity.local_date >= s).where(Activity.local_date <= e)
    if spec.type:
        q = q.where(Activity.sport == spec.type)
    if spec.activity_ids:
        q = select(Activity).where(Activity.id.in_(spec.activity_ids))
    return list(db.scalars(q.order_by(Activity.start_utc)))


def _daily(db: Session, spec: DatasetSpec, s: date, e: date) -> list[dict]:
    unknown = [m for m in spec.metrics if m not in METRICS and m not in DAILY_DERIVED]
    if unknown:
        raise ValueError(f"{spec.name}: unknown daily metric(s) {unknown}; known: "
                         f"{', '.join([*METRICS, *DAILY_DERIVED])}")
    metrics = spec.metrics or [*METRICS, *DAILY_DERIVED]
    base = [m for m in metrics if m in METRICS]
    by_day: dict[str, dict] = defaultdict(dict)
    if base:
        for d, m, v in db.execute(select(DailyMetric.day, DailyMetric.metric, DailyMetric.value)
                                  .where(DailyMetric.metric.in_(base)).where(DailyMetric.day >= s)
                                  .where(DailyMetric.day <= e)):
            by_day[d.isoformat()][m] = v
    if any(m.startswith("sleep_") and m in DAILY_DERIVED for m in metrics):
        for n in db.scalars(select(SleepNight).where(SleepNight.day >= s).where(SleepNight.day <= e)):
            row = by_day[n.day.isoformat()]
            for k, col in (("sleep_deep_h", n.deep_s), ("sleep_light_h", n.light_s), ("sleep_rem_h", n.rem_s),
                           ("sleep_awake_h", n.awake_s)):
                row.setdefault(k, _r(col / 3600) if col is not None else None)
    if {"train_min", "train_km", "srpe"} & set(metrics):
        for a in _activities(db, spec.model_copy(update={"type": None, "activity_ids": []}), s, e):
            row = by_day[a.local_date.isoformat()]
            mins = (a.moving_s or a.duration_s or 0) / 60
            row["train_min"] = row.get("train_min", 0) + mins
            row["train_km"] = row.get("train_km", 0) + (a.distance_m or 0) / 1000
            if a.rpe and mins:
                row["srpe"] = (row.get("srpe") or 0) + a.rpe * mins
    out = []
    for i in range((e - s).days + 1):  # every calendar day; missing values stay null
        k = (s + timedelta(days=i)).isoformat()
        got = by_day.get(k, {})
        row = {"day": k}
        for m in metrics:
            v = got.get(m)
            if m in ("train_min", "train_km"):
                v = round(v or 0, 2)  # no activity = zero training, not missing
            elif m == "srpe" and v is not None:
                v = round(v)
            row[m] = v
        out.append(row)
    return out


def _sleep(db: Session, s: date, e: date) -> list[dict]:
    seen: dict[date, SleepNight] = {}
    for n in db.scalars(select(SleepNight).where(SleepNight.day >= s).where(SleepNight.day <= e)
                        .order_by(SleepNight.day, SleepNight.source)):
        seen.setdefault(n.day, n)
    out = []
    for d, n in sorted(seen.items()):
        off = int(n.tz_offset_min or 0)
        midnight = d.toordinal()
        bed = wake = None
        if n.start_utc and n.end_utc:
            bl, wl = n.start_utc + timedelta(minutes=off), n.end_utc + timedelta(minutes=off)
            bed = round((bl.toordinal() - midnight) * 24 + bl.hour + bl.minute / 60, 2)
            wake = round((wl.toordinal() - midnight) * 24 + wl.hour + wl.minute / 60, 2)
        stages = [n.deep_s, n.light_s, n.rem_s]
        asleep = sum(x or 0 for x in stages) / 3600 if any(x is not None for x in stages) else None
        out.append({"day": d.isoformat(), "bed_local": _local(n.start_utc, off), "wake_local": _local(n.end_utc, off),
                    "bed_h": bed, "wake_h": wake, "asleep_h": _r(asleep),
                    **{k: _r(v / 3600) if v is not None else None
                       for k, v in (("deep_h", n.deep_s), ("light_h", n.light_s), ("rem_h", n.rem_s),
                                    ("awake_h", n.awake_s))},
                    "score": n.score})
    return out


def _activity_rows(acts: list[Activity]) -> list[dict]:
    out = []
    for a in acts:
        t = a.moving_s or a.duration_s
        mins = t / 60 if t else None
        out.append({"id": a.id, "local_date": a.local_date.isoformat(), "start_local": _local(a.start_utc, a.tz_offset_min),
                    "type": a.sport, "name": a.name, "source": a.source,
                    "duration_min": _r(a.duration_s / 60 if a.duration_s else None, 1), "moving_min": _r(mins, 1),
                    "distance_km": _r(a.distance_m / 1000 if a.distance_m else None, 3),
                    "pace_s_per_km": _pace(t, a.distance_m),
                    "speed_kmh": _r(a.distance_m / t * 3.6 if t and a.distance_m else None),
                    "avg_hr": a.avg_hr, "max_hr": a.max_hr, "elevation_gain_m": a.elevation_gain_m,
                    "calories": a.calories, "n_laps": len(a.laps or []), "has_stream": bool(a.stream_path),
                    "rpe": a.rpe, "srpe": round(a.rpe * mins) if a.rpe and mins else None, "notes": a.notes or "",
                    "workout_id": a.workout_id, "planned": bool(a.workout_id)})
    return out


def _laps(acts: list[Activity]) -> list[dict]:
    out = []
    for a in acts:
        for i, lap in enumerate(a.laps or [], 1):
            t = lap.get("timer_s") or lap.get("elapsed_s")
            out.append({"activity_id": a.id, "local_date": a.local_date.isoformat(), "type": a.sport, "lap": i,
                        "start_s": lap.get("start_s"), "elapsed_s": lap.get("elapsed_s"), "timer_s": lap.get("timer_s"),
                        "distance_m": lap.get("distance_m"), "pace_s_per_km": _pace(t, lap.get("distance_m")),
                        "avg_hr": lap.get("avg_hr"), "max_hr": lap.get("max_hr")})
    return out


def _streams(db: Session, spec: DatasetSpec, s: date, e: date) -> list[dict]:
    from garmin.store import load_stream

    if spec.activity_ids:
        acts = [a for a in _activities(db, spec, s, e) if a.stream_path]
    else:
        q = (select(Activity).where(Activity.stream_path.is_not(None)).where(Activity.local_date >= s)
             .where(Activity.local_date <= e))
        if spec.type:
            q = q.where(Activity.sport == spec.type)
        acts = list(db.scalars(q.order_by(Activity.start_utc.desc()).limit(spec.limit or STREAM_DEFAULT)))[::-1]
    out = []
    for a in acts:
        st = load_stream(a.stream_path) or {}
        ts = st.get("t") or []
        if not ts:
            continue
        span = (ts[-1] - ts[0]) or 1
        every = spec.every_s or max(1, math.ceil(span / STREAM_POINTS))
        nxt = None
        for i, t in enumerate(ts):
            if nxt is not None and t < nxt:
                continue
            nxt = t + every
            sp = (st.get("speed") or [None] * len(ts))[i]
            col = lambda k: (st.get(k) or [None] * len(ts))[i]  # noqa: E731
            out.append({"activity_id": a.id, "local_date": a.local_date.isoformat(), "type": a.sport, "t_s": t,
                        "hr": col("hr"), "speed_ms": _r(sp, 3),
                        "pace_s_per_km": round(1000 / sp, 1) if sp and sp > 0.3 else None,
                        "power": col("pow"), "cadence": col("cad"), "altitude_m": _r(col("alt"), 1),
                        "distance_m": _r(col("dist"), 1)})
            if len(out) > CAPS["streams"]:
                break
    return out


def _workouts(db: Session, spec: DatasetSpec, s: date, e: date, today: date) -> tuple[list[Workout], dict]:
    q = select(Workout).where(
        ((Workout.date >= s) & (Workout.date <= e))
        | (Workout.date.is_(None) & (Workout.week_monday >= s - timedelta(days=6)) & (Workout.week_monday <= e)))
    if spec.type:
        q = q.where(Workout.type == spec.type)
    rows = list(db.scalars(q.order_by(Workout.week_monday, Workout.date, Workout.position)))
    acts: dict[str, list[Activity]] = defaultdict(list)
    for a in db.scalars(select(Activity).where(Activity.workout_id.in_([w.id for w in rows]))):
        acts[a.workout_id].append(a)
    return rows, acts


def _status(w: Workout, acts: list, today: date) -> str:
    if acts:
        return "done"
    if w.status == "skipped":
        return "skipped"
    return "not_logged" if w.date and w.date < today else "planned"


def _workout_rows(db: Session, spec: DatasetSpec, s: date, e: date, today: date) -> list[dict]:
    from plan.views import planned

    rows, acts = _workouts(db, spec, s, e, today)
    names = dict(db.execute(select(Exercise.id, Exercise.name)).all())
    out = []
    for w in rows:
        aa = acts.get(w.id, [])
        p = planned(w.items)
        secs = sum((a.moving_s or a.duration_s or 0) for a in aa)
        km = sum((a.distance_m or 0) for a in aa) / 1000
        hrs = [a.avg_hr for a in aa if a.avg_hr]
        out.append({"id": w.id, "date": w.date.isoformat() if w.date else None, "week_monday": w.week_monday.isoformat(),
                    "time": w.time, "type": w.type, "title": w.title, "tags": w.tags or [],
                    "status": _status(w, aa, today), "series_id": w.series_id, "n_items": len(w.items or []),
                    "items": [{"exercise": names.get(i.get("exercise_id"), i.get("exercise_id")),
                               **{k: i.get(k) for k in ("exercise_id", "sets", "reps", "load", "duration_min",
                                                        "distance_km", "intensity")}} for i in w.items or []],
                    "planned_km": p["distance_km"], "planned_min": p["duration_min"],
                    "activity_ids": [a.id for a in aa], "actual_km": round(km, 2) if km else None,
                    "actual_min": round(secs / 60, 1) if secs else None,
                    "avg_hr": round(sum(hrs) / len(hrs), 1) if hrs else None,
                    "rpe": next((a.rpe for a in aa if a.rpe), None),
                    "recorded": any(a.source != "manual" for a in aa)})
    return out


def _item_rows(db: Session, spec: DatasetSpec, s: date, e: date, today: date) -> list[dict]:
    rows, acts = _workouts(db, spec, s, e, today)
    names = dict(db.execute(select(Exercise.id, Exercise.name)).all())
    out = []
    for w in rows:
        st = _status(w, acts.get(w.id, []), today)
        for pos, i in enumerate(w.items or []):
            out.append({"workout_id": w.id, "date": w.date.isoformat() if w.date else None,
                        "week_monday": w.week_monday.isoformat(), "type": w.type, "title": w.title, "status": st,
                        "position": pos, "exercise_id": i.get("exercise_id"),
                        "exercise": names.get(i.get("exercise_id"), i.get("exercise_id")),
                        **{k: i.get(k) for k in ("sets", "reps", "load", "duration_min", "distance_km", "intensity",
                                                 "note")}})
    return out


def _set_rows(db: Session, acts: list[Activity]) -> list[dict]:
    """Logged strength sets, one row per set, numbered per exercise within the activity; the
    planned item it answers sits beside it (text, as planned)."""
    from library.progress import e1rm

    names = dict(db.execute(select(Exercise.id, Exercise.name)).all())
    plans: dict[str, dict] = {}
    out = []
    for a in acts:
        if not a.sets:
            continue
        if a.workout_id and a.workout_id not in plans:
            w = db.get(Workout, a.workout_id)
            plans[a.workout_id] = {i["id"]: i for i in (w.items if w else []) or []}
        items = plans.get(a.workout_id or "", {})
        n: dict[str, int] = {}
        for st in a.sets:
            ex = st.get("exercise_id")
            n[ex] = n.get(ex, 0) + 1
            it = items.get(st.get("item_id") or "", {})
            reps, kg = st.get("reps"), st.get("kg")
            out.append({"activity_id": a.id, "local_date": a.local_date.isoformat(), "type": a.sport,
                        "workout_id": a.workout_id, "exercise_id": ex, "exercise": names.get(ex, ex),
                        "item_id": st.get("item_id"), "set_no": n[ex], "reps": reps, "kg": kg, "secs": st.get("secs"),
                        "volume_kg": round(reps * kg, 1) if reps and kg else None,
                        "e1rm_kg": e1rm(kg or 0, reps or 0), "planned_sets": it.get("sets"),
                        "planned_reps": it.get("reps"), "planned_load": it.get("load")})
    return out


def build(db: Session, specs: list[DatasetSpec], today: date | None = None) -> Snapshot:
    from plan import clock

    today = today or clock.today()
    if len({s.name for s in specs}) != len(specs):
        raise ValueError("dataset names must be unique")
    if not specs:
        raise ValueError("give at least one dataset")
    data: dict[str, list[dict]] = {}
    ranges = []
    for spec in specs:
        s, e = resolve(spec, today)
        k = spec.kind
        if k == "daily":
            rows = _daily(db, spec, s, e)
        elif k == "sleep":
            rows = _sleep(db, s, e)
        elif k == "activities":
            rows = _activity_rows(_activities(db, spec, s, e))
        elif k == "laps":
            rows = _laps(_activities(db, spec, s, e))
        elif k == "streams":
            rows = _streams(db, spec, s, e)
        elif k == "workouts":
            rows = _workout_rows(db, spec, s, e, today)
        elif k == "sets":
            rows = _set_rows(db, _activities(db, spec, s, e))
        else:
            rows = _item_rows(db, spec, s, e, today)
        data[spec.name] = _cap(k, rows, spec.name)
        ranges.append({"name": spec.name, "kind": k, "start": s.isoformat(), "end": e.isoformat()})
    digest = hashlib.sha256(json.dumps(data, sort_keys=True, default=str).encode()).hexdigest()
    return Snapshot(data, digest, {k: len(v) for k, v in data.items()}, ranges)
