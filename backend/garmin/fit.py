"""FIT activity file → session summary, laps and a columnar 1 Hz stream."""

from __future__ import annotations

import io
from datetime import datetime, timezone
from typing import Any

import fitdecode

from garmin.parse import sport_of

STREAM_FIELDS = {"heart_rate": "hr", "enhanced_speed": "speed", "speed": "speed", "distance": "dist",
                 "enhanced_altitude": "alt", "altitude": "alt", "cadence": "cad", "power": "pow",
                 "position_lat": "lat", "position_long": "lon"}
# Stream format: 2 = positions (lat/lon, degrees) are extracted when the file has them. A stored
# stream without `v` predates that and is re-derived from the kept FIT on first detail view.
STREAM_VERSION = 2
SEMI = 180 / 2**31


def _deg(v: Any) -> float | None:
    """FIT positions are semicircles (int32); 0x7FFFFFFF is 'invalid' and arrives as None."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    f = f * SEMI if abs(f) > 360 else f
    return round(f, 6) if -180 <= f <= 180 and f != 0 else None


def _naive(v: Any) -> datetime | None:
    if isinstance(v, datetime):
        return v.astimezone(timezone.utc).replace(tzinfo=None) if v.tzinfo else v
    return None


def parse_fit(data: bytes) -> dict:
    session: dict[str, Any] = {}
    laps: list[dict] = []
    rows: list[dict] = []
    device = ""
    with fitdecode.FitReader(io.BytesIO(data), check_crc=fitdecode.CrcCheck.WARN) as fr:
        for frame in fr:
            if not isinstance(frame, fitdecode.FitDataMessage):
                continue
            vals = {f.name: f.value for f in frame.fields}
            if frame.name == "record" and vals.get("timestamp") is not None:
                rows.append(vals)
            elif frame.name == "lap":
                laps.append({"start": _naive(vals.get("start_time")),
                             "elapsed_s": vals.get("total_elapsed_time"), "timer_s": vals.get("total_timer_time"),
                             "distance_m": vals.get("total_distance"), "avg_hr": vals.get("avg_heart_rate"),
                             "max_hr": vals.get("max_heart_rate")})
            elif frame.name == "session" and not session:
                session = vals
            elif frame.name == "device_info" and not device and vals.get("product_name"):
                device = str(vals.get("product_name"))
    t0 = _naive(session.get("start_time")) or (_naive(rows[0]["timestamp"]) if rows else None)
    good = [(r, _naive(r["timestamp"])) for r in rows]
    good = [(r, ts) for r, ts in good if ts is not None and t0 is not None]
    stream: dict[str, list] = {"t": [round((ts - t0).total_seconds(), 1) for _, ts in good]}
    for dst in dict.fromkeys(STREAM_FIELDS.values()):  # ordered, first source wins
        srcs = [src for src, d in STREAM_FIELDS.items() if d == dst]
        col = [next((r[x] for x in srcs if r.get(x) is not None), None) for r, _ in good]
        if dst in ("lat", "lon"):
            col = [_deg(v) for v in col]
        if any(v is not None for v in col):
            stream[dst] = col
    n = len(stream["t"])
    lap_out = []
    for lap in laps:
        start = lap.pop("start")
        lap["start_s"] = round((start - t0).total_seconds(), 1) if start and t0 else None
        lap_out.append(lap)
    # The precise discipline can sit in the sport or, on some devices, its sub-sport; never let
    # a generic sport hide a known one. Everything else is the same as before.
    key = str(session.get("sport") or "")
    sub = str(session.get("sub_sport") or "")
    if sport_of(key) == "other" and sub and sport_of(sub) != "other":
        key = sub  # a precise discipline in the sub-sport; otherwise keep the sport we were given
    return {
        "start_utc": t0,
        "sport": sport_of(key),
        "source_type": key,
        "duration_s": session.get("total_elapsed_time"),
        "moving_s": session.get("total_timer_time"),
        "distance_m": session.get("total_distance"),
        "avg_hr": session.get("avg_heart_rate"),
        "max_hr": session.get("max_heart_rate"),
        "elevation_gain_m": session.get("total_ascent"),
        "calories": session.get("total_calories"),
        "device": device,
        "laps": lap_out,
        "stream": {**stream, "v": STREAM_VERSION} if n else None,
    }
