"""Per-exercise history from logged sets (DECISIONS.md #33): one row per session that logged the
exercise, newest first, with the numbers a lifter reads progress from. Actuals only; the plan
is never consulted."""

from __future__ import annotations

from sqlalchemy import String, cast, select
from sqlalchemy.orm import Session

from models import Activity, Workout


def e1rm(kg: float, reps: int) -> float | None:
    """Epley estimate of a one-rep max; only meaningful for loaded sets of 1–12 reps."""
    if not kg or not reps or reps > 12:
        return None
    return round(kg if reps == 1 else kg * (1 + reps / 30), 1)


def summary(sets: list[dict]) -> dict:
    """Sets, total reps or seconds, the top set (heaviest, then most reps), volume (kg × reps)
    and the best estimated 1RM."""
    reps = [s for s in sets if s.get("reps") is not None]
    top = max(reps, key=lambda s: (s.get("kg") or 0, s["reps"]), default=None)
    bests = [x for x in (e1rm(s.get("kg") or 0, s["reps"]) for s in reps) if x]
    return {
        "n": len(sets),
        "reps": sum(s["reps"] for s in reps) if reps else None,
        "secs": sum(s.get("secs") or 0 for s in sets) or None,
        "top": {"reps": top["reps"], "kg": top.get("kg")} if top else None,
        "volume_kg": round(sum((s.get("kg") or 0) * s["reps"] for s in reps), 1) or None,
        "e1rm": max(bests) if bests else None,
    }


def history(db: Session, eid: str, limit: int = 20) -> list[dict]:
    rows = db.scalars(select(Activity).where(cast(Activity.sets, String).like(f'%"{eid}"%'))
                      .order_by(Activity.local_date.desc(), Activity.start_utc.desc()))
    titles = {}
    out = []
    for a in rows:
        sets = [s for s in a.sets or [] if s.get("exercise_id") == eid]
        if not sets:
            continue
        if a.workout_id and a.workout_id not in titles:
            w = db.get(Workout, a.workout_id)
            titles[a.workout_id] = w.title if w else None
        out.append({"activity_id": a.id, "date": a.local_date.isoformat(), "workout_id": a.workout_id,
                    "title": titles.get(a.workout_id) or a.name,
                    "sets": [{k: s[k] for k in ("reps", "kg", "secs") if k in s} for s in sets], **summary(sets)})
        if len(out) >= limit:
            break
    return out
