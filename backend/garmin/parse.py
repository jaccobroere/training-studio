"""Garmin JSON → our records. Pure functions, shared by the export-archive importer and the
API pull, because both carry the same concepts in slightly different shapes/units.

Export summaries use epoch-millisecond timestamps, milliseconds and centimetres; the live
API uses ISO strings, seconds and metres. We detect by type and normalise to SI. Unknown
fields are ignored (the raw file is kept), never guessed.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

from plan import clock
from plan.types import type_of


def sport_of(type_key: str | None) -> str:
    """Garmin type key → our fixed type (plan/types.py)."""
    return type_of(type_key)


def type_keys(a: dict) -> list[str]:
    """Every type key a Garmin summary carries, in preference order. The live API puts the
    precise key in `activityType.typeKey`; the export repeats it in `sportType` (`sportTypeKey`
    in some workout payloads). A custom/unknown profile can make one of them read "other" while
    the other still names the sport, so callers must not stop at the first present field."""
    out: list[str] = []
    for field in ("activityType", "sportType"):
        v = a.get(field)
        if isinstance(v, dict):
            v = v.get("typeKey") or v.get("sportTypeKey")
        if v:
            out.append(str(v))
    return out


def best_type_key(a: dict) -> str:
    """The first key that maps to a known type; otherwise the first one that exists."""
    keys = type_keys(a)
    for k in keys:
        if type_of(k) != "other":
            return k
    return keys[0] if keys else ""


def _ts(v: Any) -> datetime | None:
    """Epoch ms, epoch s, or ISO string → naive UTC datetime."""
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        secs = v / 1000 if v > 1e11 else v
        return datetime.fromtimestamp(secs, tz=timezone.utc).replace(tzinfo=None)
    s = str(v).replace("Z", "").replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(s[:26], fmt)
        except ValueError:
            continue
    return None


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f


def activity_from_summary(a: dict, *, source: str = "garmin") -> dict | None:
    """One Garmin activity summary (export or API) → activity fields."""
    aid = a.get("activityId")
    if aid is None:
        return None
    type_key = best_type_key(a)
    start_gmt = a.get("startTimeGmt", a.get("startTimeGMT"))
    start_local = a.get("startTimeLocal")
    export_units = isinstance(start_gmt, (int, float))  # export: ms / cm; API: s / m
    start = _ts(start_gmt)
    local = _ts(start_local)
    if start is None:
        return None
    if local is None:  # no device-local time: derive it from the athlete's timezone
        local = start.replace(tzinfo=timezone.utc).astimezone(clock.tz()).replace(tzinfo=None)
    offset = round((local - start).total_seconds() / 60)
    dur, mov, dist, elev = (_num(a.get(k)) for k in ("duration", "movingDuration", "distance", "elevationGain"))
    if export_units:
        dur = dur / 1000 if dur is not None else None
        mov = mov / 1000 if mov is not None else None
        dist = dist / 100 if dist is not None else None
        elev = elev / 100 if elev is not None else None
    return {
        "id": f"{source}:{aid}", "source": source, "source_id": f"{source}:{aid}",
        "sport": sport_of(type_key), "source_type": str(type_key), "name": a.get("activityName") or a.get("name") or "",
        "start_utc": start, "tz_offset_min": offset,
        "local_date": local.date(),
        "duration_s": dur, "moving_s": mov, "distance_m": dist,
        "avg_hr": _num(a.get("averageHR", a.get("avgHr"))), "max_hr": _num(a.get("maxHR", a.get("maxHr"))),
        "elevation_gain_m": elev, "calories": _num(a.get("calories")),
        "device": str(a.get("deviceName") or ""),
    }


def sleep_from(d: dict) -> dict | None:
    """Export sleepData entry or API dailySleepDTO → sleep night fields."""
    d = d.get("dailySleepDTO", d)
    day = d.get("calendarDate")
    if not day:
        return None
    start, end = _ts(d.get("sleepStartTimestampGMT")), _ts(d.get("sleepEndTimestampGMT"))
    start_l = _ts(d.get("sleepStartTimestampLocal"))
    scores = d.get("sleepScores") or {}
    score = scores.get("overall", {}).get("value") if isinstance(scores.get("overall"), dict) else scores.get("overallScore")
    out = {"day": date.fromisoformat(str(day)[:10]), "start_utc": start, "end_utc": end,
           "tz_offset_min": round((start_l - start).total_seconds() / 60) if start_l and start else None,
           "deep_s": _num(d.get("deepSleepSeconds")), "light_s": _num(d.get("lightSleepSeconds")),
           "rem_s": _num(d.get("remSleepSeconds")), "awake_s": _num(d.get("awakeSleepSeconds")),
           "score": _num(score)}
    if all(out[k] is None for k in ("deep_s", "light_s", "rem_s")) and not (start and end):
        return None  # a stub day with no sleep recorded
    return out


def sleep_hours(n: dict) -> float | None:
    parts = [n.get(k) for k in ("deep_s", "light_s", "rem_s")]
    if any(p is not None for p in parts):
        return round(sum(p or 0 for p in parts) / 3600, 2)
    if n.get("start_utc") and n.get("end_utc"):
        return round(((n["end_utc"] - n["start_utc"]).total_seconds() - (n.get("awake_s") or 0)) / 3600, 2)
    return None


def daily_from_summary(d: dict) -> tuple[date, dict[str, float]] | None:
    """Export UDS daily summary or API get_stats → metric values for that date."""
    day = d.get("calendarDate")
    if not day:
        return None
    vals: dict[str, float | None] = {
        "steps": _num(d.get("totalSteps")),
        "rhr_bpm": _num(d.get("restingHeartRate")),
        "stress_avg": _num(d.get("averageStressLevel")),
        "bb_max": _num(d.get("bodyBatteryHighestValue")),
        "bb_min": _num(d.get("bodyBatteryLowestValue")),
        "bb_charged": _num(d.get("bodyBatteryChargedValue")),
        "bb_drained": _num(d.get("bodyBatteryDrainedValue")),
        "respiration": _num(d.get("avgSleepRespirationValue", d.get("averageRespirationValue"))),
        "spo2": _num(d.get("averageSpo2")),
    }
    stress = d.get("allDayStress")
    if vals["stress_avg"] is None and isinstance(stress, dict):
        for agg in stress.get("aggregatorList") or []:
            if agg.get("type") == "TOTAL":
                vals["stress_avg"] = _num(agg.get("averageStressLevel"))
    bb = d.get("bodyBattery")
    if isinstance(bb, dict):
        for st in bb.get("bodyBatteryStatList") or []:
            key = {"HIGHEST": "bb_max", "LOWEST": "bb_min"}.get(st.get("bodyBatteryStatType"))
            if key and vals[key] is None:
                vals[key] = _num(st.get("statsValue"))
    # Garmin reports -1/-2 for "not measured" on some stress fields.
    clean = {k: v for k, v in vals.items() if v is not None and v >= 0}
    if clean.get("steps") == 0 and clean.get("rhr_bpm") is None:
        clean.pop("steps")  # a zero-step day with no heart data = watch not worn, not a rest day
    return date.fromisoformat(str(day)[:10]), clean


def hrv_from(d: dict) -> tuple[date, dict[str, float]] | None:
    s = d.get("hrvSummary", d)
    day = s.get("calendarDate")
    if not day:
        return None
    vals = {"hrv_ms": _num(s.get("lastNightAvg")), "hrv_weekly_ms": _num(s.get("weeklyAvg"))}
    return date.fromisoformat(str(day)[:10]), {k: v for k, v in vals.items() if v}


def weight_from(d: dict) -> tuple[date, dict[str, float]] | None:
    day = d.get("calendarDate") or (d.get("date") and _ts(d["date"]).date().isoformat())
    w = _num(d.get("weight"))
    if not day or not w:
        return None
    kg = w / 1000 if w > 500 else w  # Garmin stores grams
    vals = {"weight_kg": round(kg, 2)}
    if _num(d.get("bodyFat")):
        vals["body_fat_pct"] = _num(d.get("bodyFat"))
    return date.fromisoformat(str(day)[:10]), vals


def utc_to_local(dt: datetime, offset_min: int | None) -> datetime:
    return dt + timedelta(minutes=offset_min or 0)


def extras_from(ds: str, *, max_metrics=None, readiness=None, respiration=None, spo2=None) -> dict[str, float]:
    """VO2max, training readiness, respiration and SpO2 from their own API calls (decision
    26). Tolerant of Garmin's shape changes: a missing field is a gap, never a zero."""
    vals: dict[str, float | None] = {}
    mm = max_metrics[0] if isinstance(max_metrics, list) and max_metrics else max_metrics
    if isinstance(mm, dict):
        g = mm.get("generic") or {}
        vals["vo2max"] = _num(g.get("vo2MaxPreciseValue") or g.get("vo2MaxValue"))
    tr = readiness[0] if isinstance(readiness, list) and readiness else readiness
    if isinstance(tr, dict):
        vals["readiness"] = _num(tr.get("score"))
    if isinstance(respiration, dict):
        vals["respiration"] = _num(respiration.get("avgSleepRespirationValue"))
    if isinstance(spo2, dict):
        vals["spo2"] = _num(spo2.get("avgSleepSpO2") or spo2.get("averageSpO2"))
    return {k: v for k, v in vals.items() if v is not None and v > 0}
