"""Idempotent writes of recorded data, plus reads the plan screens need.

Identity is the source record id (activity id, calendar date + metric). Re-importing the
same export or overlapping pulls updates rows in place — never duplicates them."""

from __future__ import annotations

import gzip
import hashlib
import json
from datetime import date
from pathlib import Path

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from db import data_dir
from models import Activity, DailyMetric, RawAsset, SleepNight
from models.base import utcnow
from garmin.parse import sleep_hours
from plan.types import normalise, type_of

ACTIVITY_FIELDS = ("sport", "source_type", "name", "start_utc", "tz_offset_min", "local_date", "duration_s",
                   "moving_s", "distance_m", "avg_hr", "max_hr", "elevation_gain_m", "calories", "device")


def raw_dir() -> Path:
    p = data_dir() / "raw"
    p.mkdir(parents=True, exist_ok=True)
    return p


def keep_raw(db: Session, data: bytes, *, kind: str, filename: str, import_id: str | None) -> RawAsset:
    """Store original bytes once (content-addressed); return the asset row."""
    digest = hashlib.sha256(data).hexdigest()
    row = db.get(RawAsset, digest)
    if row is not None:
        return row
    sub = raw_dir() / kind / digest[:2]
    sub.mkdir(parents=True, exist_ok=True)
    path = sub / f"{digest}{Path(filename).suffix[:12]}"
    if not path.exists():
        path.write_bytes(data)
    row = RawAsset(sha256=digest, kind=kind, filename=filename[:300], path=str(path.relative_to(data_dir())),
                   size=len(data), import_id=import_id)
    db.add(row)
    return row


def save_stream(activity_id: str, stream: dict) -> str:
    d = data_dir() / "streams"
    d.mkdir(parents=True, exist_ok=True)
    name = activity_id.replace(":", "_") + ".json.gz"
    with gzip.open(d / name, "wt") as f:
        json.dump(stream, f, separators=(",", ":"))
    return f"streams/{name}"


def load_stream(path: str | None) -> dict | None:
    if not path:
        return None
    p = data_dir() / path
    if not p.exists():
        return None
    with gzip.open(p, "rt") as f:
        return json.load(f)


def stream_for(db: Session, a: Activity) -> dict | None:
    """The activity's stored stream, upgraded once to the current format: a stream saved before
    positions were extracted is re-derived from the kept original FIT (never re-downloaded) and
    saved again. Without a kept FIT the old stream is returned as it is."""
    from garmin.fit import STREAM_VERSION, parse_fit

    stream = load_stream(a.stream_path)
    if stream is None or stream.get("v") == STREAM_VERSION or not a.raw_sha256:
        return stream
    asset = db.get(RawAsset, a.raw_sha256)
    p = data_dir() / asset.path if asset is not None and asset.kind == "fit" else None
    if p is None or not p.exists():
        return stream
    try:
        fresh = parse_fit(p.read_bytes())["stream"]
    except Exception:  # a file that parsed once but not now: keep the old stream, mark it checked
        fresh = None
    stream = fresh if fresh and len(fresh.get("t", [])) == len(stream["t"]) else {**stream, "v": STREAM_VERSION}
    save_stream(a.id, stream)
    return stream


def upsert_activity(db: Session, rec: dict, import_id: str | None) -> str:
    """Returns 'new' | 'updated' | 'same'."""
    row = db.get(Activity, rec["id"])
    if row is None:
        db.add(Activity(**{k: rec.get(k) for k in ("id", "source", "source_id", *ACTIVITY_FIELDS)},
                        laps=rec.get("laps") or [], stream_path=rec.get("stream_path"),
                        raw_sha256=rec.get("raw_sha256"), import_id=import_id))
        return "new"
    changed = False
    for k in ACTIVITY_FIELDS:
        v = rec.get(k)
        if v is None:
            continue
        cur = getattr(row, k)
        if k == "sport":
            if row.type_override:
                continue  # the athlete's type survives a re-sync
            if v == "other" and cur != "other":
                continue  # a summary without a usable type must not erase a precise FIT type
        if k == "source_type" and type_of(v) == "other" and cur:
            continue  # keep the key the FIT established (it may still be "other", but it is known)
        if cur != v:
            setattr(row, k, v)
            changed = True
    for k in ("laps", "stream_path", "raw_sha256"):
        if rec.get(k) and getattr(row, k) != rec[k]:
            setattr(row, k, rec[k])
            changed = True
    if changed:
        row.updated_at = utcnow()
        row.import_id = import_id
    return "updated" if changed else "same"


def repair_other_types(db: Session, user_dir: Path, limit: int = 50) -> int:
    """Re-read the kept FIT for recordings the summary left as `other` (a custom profile or an
    unknown summary type). The FIT usually names the precise sport — that is how a skating
    session recorded as "Ice Skating Track" can still be classified. Sets `source_type` even
    when the FIT is untyped too, so each file is examined once; returns how many changed type."""
    from garmin.fit import parse_fit

    # The athlete's own type always wins; only rows with no override are repaired.
    own = Activity.type_override.is_(None)

    # A known device key on the row is enough; no file needs reading.
    fixed = 0
    for a in db.scalars(select(Activity).where(Activity.sport == "other").where(own)
                        .where(or_(Activity.source_type.is_(None), Activity.source_type != "")).limit(1000)):
        known = type_of(a.source_type)
        if known == "other":
            known = normalise(a.source_type)
        if known != "other":
            a.sport = known
            a.updated_at = utcnow()
            fixed += 1
    if fixed:
        db.commit()

    # Otherwise the original file may still name the sport (custom/unknown summary type).
    rows = list(db.scalars(select(Activity).where(Activity.sport == "other").where(own)
                           .where(or_(Activity.source_type.is_(None), Activity.source_type.in_(("", "other"))))
                           .where(Activity.raw_sha256.is_not(None)).limit(limit)))
    for a in rows:
        asset = db.get(RawAsset, a.raw_sha256)
        if asset is None or asset.kind != "fit":
            continue
        try:
            parsed = parse_fit((user_dir / asset.path).read_bytes())
        except Exception:  # an unreadable original must not break the repair (or the login)
            continue
        key = parsed.get("source_type")
        if key and key != a.source_type:
            a.source_type = key
            a.updated_at = utcnow()
        if parsed["sport"] != "other":
            a.sport = parsed["sport"]
            a.updated_at = utcnow()
            fixed += 1
    if rows:
        db.commit()
    return fixed


def upsert_metric(db: Session, day: date, metric: str, value: float, source: str, import_id: str | None) -> str:
    row = db.get(DailyMetric, (day, metric, source))
    if row is None:
        db.add(DailyMetric(day=day, metric=metric, source=source, value=value, import_id=import_id))
        return "new"
    if abs(row.value - value) > 1e-9:
        row.value, row.import_id, row.updated_at = value, import_id, utcnow()
        return "updated"
    return "same"


def upsert_sleep(db: Session, n: dict, source: str, import_id: str | None) -> str:
    row = db.get(SleepNight, (n["day"], source))
    fields = ("start_utc", "end_utc", "tz_offset_min", "deep_s", "light_s", "rem_s", "awake_s", "score")
    state = "same"
    if row is None:
        db.add(SleepNight(day=n["day"], source=source, import_id=import_id, **{k: n.get(k) for k in fields}))
        state = "new"
    else:
        for k in fields:
            if n.get(k) is not None and getattr(row, k) != n[k]:
                setattr(row, k, n[k])
                state = "updated"
    h = sleep_hours(n)
    if h is not None:
        upsert_metric(db, n["day"], "sleep_h", h, source, import_id)
    if n.get("score") is not None:
        upsert_metric(db, n["day"], "sleep_score", n["score"], source, import_id)
    return state


# ------------------------------------------------------------------ reads

def _amounts(a: Activity) -> dict:
    return {"distance_km": round(a.distance_m / 1000, 2) if a.distance_m else None,
            "duration_min": round((a.moving_s or a.duration_s) / 60, 1) if (a.moving_s or a.duration_s) else None}


def activity_view(a: Activity) -> dict:
    return {"id": a.id, "source": a.source, "type": a.sport, "sport": a.sport, "source_type": a.source_type, "name": a.name,
            "local_date": a.local_date.isoformat(), "start_utc": a.start_utc.isoformat() + "Z",
            "tz_offset_min": a.tz_offset_min, "duration_s": a.duration_s, "moving_s": a.moving_s,
            "distance_m": a.distance_m, "avg_hr": a.avg_hr, "max_hr": a.max_hr,
            "elevation_gain_m": a.elevation_gain_m, "calories": a.calories, "device": a.device,
            "laps": a.laps or [], "has_stream": bool(a.stream_path), "workout_id": a.workout_id, "rpe": a.rpe,
            "type_override": a.type_override, "device_type": type_of(a.source_type) if a.source != "manual" else None,
            "notes": a.notes or "", "skipped_items": a.skipped_items or [], "sets": a.sets or [], "version": a.version or 0, **_amounts(a)}
