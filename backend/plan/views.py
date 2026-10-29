"""Read models for the Plan screens. No writes here, except the idempotent series top-up the
callers run first (plan/series.py).

Planned and actual stay apart everywhere: planned totals come only from workout items, actual
totals only from activities (by the activity's own date and type).

Order within a day (and the tray): workouts without a time first, in their `position` order,
then timed workouts by time (ties by position)."""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import String, cast, func, select
from sqlalchemy.orm import Session

from models import Activity, Exercise, PlanChange, Series, Setting, Workout
from plan import clock
from plan.changes import HIDDEN_SOURCES, monday_of
from plan.types import MARKS

DOW = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def planned(items: list[dict]) -> dict:
    """A workout's planned values = the sum of its items; an item with `sets` counts that many
    times (6 × 0.8 km = 4.8 km)."""
    km = mins = 0.0
    for i in items or []:
        n = i.get("sets") or 1
        km += (i.get("distance_km") or 0) * n
        mins += (i.get("duration_min") or 0) * n
    return {
        "distance_km": round(km, 2) if km else None,
        "duration_min": round(mins, 1) if mins else None,
    }


def activity_view(a: Activity) -> dict:
    mins = a.moving_s or a.duration_s
    return {
        "id": a.id,
        "version": a.version or 0,
        "source": a.source,
        "type": a.sport,
        "mark": MARKS.get(a.sport, "OTH"),
        "name": a.name,
        "date": a.local_date.isoformat(),
        "start_utc": a.start_utc.isoformat() + "Z",
        "duration_min": round(mins / 60, 1) if mins else None,
        "distance_km": round(a.distance_m / 1000, 2) if a.distance_m else None,
        "avg_hr": a.avg_hr,
        "workout_id": a.workout_id,
        "rpe": a.rpe,
        "notes": a.notes or "",
        "skipped_items": a.skipped_items or [],
        "sets": a.sets or [],
        "kept_unplanned": bool(a.kept_unplanned),
        "has_stream": bool(a.stream_path),
    }


def exercise_names(db: Session) -> dict[str, str]:
    return dict(db.execute(select(Exercise.id, Exercise.name)).all())


def items_view(items: list[dict], names: dict[str, str]) -> list[dict]:
    return [
        {**i, "name": names.get(i.get("exercise_id"), i.get("exercise_id"))} for i in items or []
    ]


def state(w: Workout, acts: list, today: date) -> str:
    if acts:
        return "done"
    if w.status == "skipped":
        return "skipped"
    if w.date is not None and w.date < today:
        return "not_logged"
    return "planned"


def day_order(w: Workout) -> tuple:
    """Untimed first (by position), then by time of day."""
    return (w.date or date.min, w.time is not None, w.time or "", w.position, w.id)


def workout_view(w: Workout, acts: list[Activity], names: dict[str, str], today: date) -> dict:
    return {
        "id": w.id,
        "version": w.version,
        "date": w.date.isoformat() if w.date else None,
        "time": w.time,
        "week_monday": w.week_monday.isoformat(),
        "position": w.position,
        "title": w.title,
        "type": w.type,
        "mark": MARKS.get(w.type, "OTH"),
        "tags": w.tags or [],
        "notes": w.notes or "",
        "items": items_view(w.items, names),
        "media": w.media or [],
        "status": w.status,
        "skip_reason": w.skip_reason or "",
        "state": state(w, acts, today),
        "series_id": w.series_id,
        "customised": bool(w.customised),
        "planned": planned(w.items),
        "activities": [activity_view(a) for a in acts],
    }


def chip(w: Workout, acts: list, today: date) -> dict:
    return {
        "id": w.id,
        "version": w.version,
        "date": w.date.isoformat() if w.date else None,
        "time": w.time,
        "type": w.type,
        "mark": MARKS.get(w.type, "OTH"),
        "title": w.title,
        "state": state(w, acts, today),
        "tags": w.tags or [],
        "series_id": w.series_id,
        "position": w.position,
    }


def totals(workouts: list[Workout], activities: list[Activity]) -> dict[str, dict]:
    """Per type: planned (non-skipped workouts' items) and actual (activities), side by side."""
    out: dict[str, dict] = {}

    def row(t: str) -> dict:
        return out.setdefault(
            t,
            {
                "planned_n": 0,
                "planned_km": 0.0,
                "planned_min": 0.0,
                "actual_n": 0,
                "actual_km": 0.0,
                "actual_min": 0.0,
            },
        )

    for w in workouts:
        if w.status == "skipped":
            continue
        r, p = row(w.type), planned(w.items)
        r["planned_n"] += 1
        r["planned_km"] += p["distance_km"] or 0
        r["planned_min"] += p["duration_min"] or 0
    for a in activities:
        r = row(a.sport)
        r["actual_n"] += 1
        r["actual_km"] += (a.distance_m or 0) / 1000
        r["actual_min"] += (a.moving_s or a.duration_s or 0) / 60
    for r in out.values():
        for k in ("planned_km", "actual_km"):
            r[k] = round(r[k], 1)
        for k in ("planned_min", "actual_min"):
            r[k] = round(r[k])
    return dict(sorted(out.items()))


def _load(
    db: Session, start: date, end: date, tag: str | None = None
) -> tuple[list[Workout], dict[str, list[Activity]], list[Activity]]:
    """Workouts in weeks [start, end] (Mondays), their linked activities, and every activity
    dated in the range."""
    q = select(Workout).where(Workout.week_monday >= start).where(Workout.week_monday <= end)
    if tag:
        q = q.where(cast(Workout.tags, String).like(f'%"{tag}"%'))
    workouts = sorted((w for w in db.scalars(q) if not tag or tag in (w.tags or [])), key=day_order)
    ids = [w.id for w in workouts]
    in_range = list(
        db.scalars(
            select(Activity)
            .where(Activity.local_date >= start)
            .where(Activity.local_date <= end + timedelta(days=6))
            .order_by(Activity.start_utc)
        )
    )
    linked: dict[str, list[Activity]] = {}
    for a in in_range:
        if a.workout_id:
            linked.setdefault(a.workout_id, []).append(a)
    outside = [i for i in ids if i not in linked]
    if outside:
        for a in db.scalars(
            select(Activity).where(Activity.workout_id.in_(outside)).order_by(Activity.start_utc)
        ):
            linked.setdefault(a.workout_id, []).append(a)
    return workouts, linked, in_range


def last_change(db: Session, monday: date) -> dict | None:
    row = db.scalars(
        select(PlanChange)
        .where(PlanChange.source.not_in(HIDDEN_SOURCES))
        .where(cast(PlanChange.weeks, String).like(f'%"{monday.isoformat()}"%'))
        .order_by(PlanChange.at.desc())
    ).first()
    return change_brief(row) if row else None


def change_brief(r: PlanChange) -> dict:
    return {
        "id": r.id,
        "at": r.at.isoformat() + "Z",
        "source": r.source,
        "summary": r.summary,
        "reason": r.reason,
        "weeks": r.weeks,
        "undoes_id": r.undoes_id,
        "undone_by_id": r.undone_by_id,
        "n": len(r.after),
    }


def is_new(db: Session, has_workouts: bool = False) -> bool:
    """The first-run card shows only on a truly fresh account: no workouts, series or
    activities, Garmin never connected, and the card not dismissed. Once any of that exists it
    never returns, even if the plan is emptied later."""
    from garmin import tokens  # local: keeps plan importable without the Garmin stack

    row = db.get(Setting, "onboarding")
    if has_workouts or (row and row.value.get("dismissed")):
        return False
    return not (
        db.scalars(select(Workout.id)).first()
        or db.scalars(select(Series.id)).first()
        or db.scalars(select(Activity.id)).first()
        or tokens.present()
    )


def week_view(db: Session, monday: date) -> dict:
    monday = monday_of(monday)
    today = clock.today()
    workouts, linked, acts = _load(db, monday, monday)
    names = exercise_names(db)
    days = []
    for i in range(7):
        d = monday + timedelta(days=i)
        days.append(
            {
                "date": d.isoformat(),
                "dow": DOW[i],
                "today": d == today,
                "workouts": [
                    workout_view(w, linked.get(w.id, []), names, today)
                    for w in workouts
                    if w.date == d
                ],
                "activities": [
                    activity_view(a) for a in acts if a.local_date == d and not a.workout_id
                ],
            }
        )
    prev_acts = db.scalar(
        select(func.count())
        .select_from(Activity)
        .where(Activity.local_date >= monday - timedelta(days=7), Activity.local_date < monday)
    )
    return {
        "monday": monday.isoformat(),
        "sunday": (monday + timedelta(days=6)).isoformat(),
        "prev": (monday - timedelta(days=7)).isoformat(),
        "next": (monday + timedelta(days=7)).isoformat(),
        "today": today.isoformat(),
        "is_current": monday == monday_of(today),
        "days": days,
        "tray": [
            workout_view(w, linked.get(w.id, []), names, today) for w in workouts if w.date is None
        ],
        "totals": totals(workouts, acts),
        "empty": not workouts,
        "new_account": is_new(db, bool(workouts)),
        "last_week_activities": prev_acts or 0,
        "last_change": last_change(db, monday),
    }


def weeks_view(db: Session, start: date, end: date, tag: str | None = None) -> dict:
    """Compact multi-week grid. With `tag`, only that tag's workouts are shown, and actual
    totals count only the activities linked to them (the tag view)."""
    start, end = monday_of(start), monday_of(end)
    today = clock.today()
    workouts, linked, acts = _load(db, start, end, tag)
    if tag:
        acts = [a for w in workouts for a in linked.get(w.id, [])]
    out = []
    m = start
    while m <= end:
        ws = [w for w in workouts if w.week_monday == m]
        wa = [a for a in acts if monday_of(a.local_date) == m]
        days = []
        for i in range(7):
            d = m + timedelta(days=i)
            days.append(
                {
                    "date": d.isoformat(),
                    "workouts": [chip(w, linked.get(w.id, []), today) for w in ws if w.date == d],
                    "unplanned": [
                        {
                            "id": a.id,
                            "type": a.sport,
                            "mark": MARKS.get(a.sport, "OTH"),
                            "name": a.name,
                        }
                        for a in wa
                        if a.local_date == d and not a.workout_id
                    ],
                }
            )
        out.append(
            {
                "monday": m.isoformat(),
                "current": m == monday_of(today),
                "days": days,
                "tray": [chip(w, linked.get(w.id, []), today) for w in ws if w.date is None],
                "totals": totals(ws, wa),
            }
        )
        m += timedelta(days=7)
    return {
        "from": start.isoformat(),
        "to": end.isoformat(),
        "tag": tag,
        "today": today.isoformat(),
        "weeks": out,
    }


def workout_detail(db: Session, w: Workout) -> dict:
    today = clock.today()
    acts = list(
        db.scalars(select(Activity).where(Activity.workout_id == w.id).order_by(Activity.start_utc))
    )
    out = workout_view(w, acts, exercise_names(db), today)
    s = db.get(Series, w.series_id) if w.series_id else None
    out["series"] = series_view(s) if s else None
    return out


def series_view(s: Series, names: dict[str, str] | None = None) -> dict:
    today = clock.today()
    d = {
        "id": s.id,
        "version": s.version,
        "title": s.title,
        "type": s.type,
        "mark": MARKS.get(s.type, "OTH"),
        "time": s.time,
        "tags": s.tags or [],
        "notes": s.notes or "",
        "rule": s.rule,
        "start_date": s.start_date.isoformat(),
        "end_date": s.end_date.isoformat() if s.end_date else None,
        "active": s.end_date is None or s.end_date >= today,
        "planned": planned(s.items),
        "items": items_view(s.items, names) if names is not None else s.items or [],
        "media": s.media or [],
    }
    return d


def tags_in_use(db: Session) -> list[dict]:
    counts: dict[str, int] = {}
    for tags in db.scalars(select(Workout.tags).where(cast(Workout.tags, String) != "[]")):
        for t in tags or []:
            counts[t] = counts.get(t, 0) + 1
    return [{"tag": t, "n": n} for t, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]


def exercise_usage(db: Session) -> dict[str, int]:
    """Exercise id → number of workouts, series and saved workouts that use it."""
    from models import SavedWorkout

    uses: dict[str, int] = {}
    for model in (Workout, Series, SavedWorkout):
        for items in db.scalars(select(model.items).where(cast(model.items, String) != "[]")):
            for eid in {i.get("exercise_id") for i in items or []}:
                uses[eid] = uses.get(eid, 0) + 1
    return uses
