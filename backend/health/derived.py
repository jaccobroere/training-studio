"""Across sessions: personal bests (speed–duration curve, fastest distances) and the efficiency
trend, from a small per-activity card computed from the stream once and cached on disk
(`derived/<activity>.json`, keyed by stream file, its mtime and CARD_VERSION)."""

from __future__ import annotations

import json
import statistics
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from db import data_dir
from garmin.store import stream_for
from health import activity_stats as A
from models import Activity

CARD_VERSION = 2
STEADY_HR = (0.6, 0.82)  # an easy/steady session: mean HR between these shares of the reference max
MIN_MOVING_S = 1200.0


def _path(aid: str):
    d = data_dir() / "derived"
    d.mkdir(parents=True, exist_ok=True)
    return d / (aid.replace(":", "_").replace("/", "_") + ".json")


def card(db: Session, a: Activity) -> dict | None:
    """Bests, decoupling and the efficiency inputs of one activity (None without a stream)."""
    if not a.stream_path:
        return None
    stream = stream_for(db, a)
    sp = data_dir() / a.stream_path
    key = [CARD_VERSION, a.stream_path, sp.stat().st_mtime if sp.exists() else None, a.sport]
    p = _path(a.id)
    if p.exists():
        try:
            got = json.loads(p.read_text())
            if got.get("key") == key:
                return got["card"]
        except (ValueError, OSError):
            pass
    out = None
    s = A.prepare(stream or {}, a.sport)
    if s is not None:
        gapf = A.gap_factors(s) if a.sport in ("run", "walk") else None
        tot = A.totals(s, a.sport, gapf)
        best = A.best_efforts(s, a.sport)
        dc = A.decoupling(s, a.sport, gapf)
        mv = A._wmean(s, "hr", 0, len(s.t) - 1, moving_only=True)
        ef = A.efficiency_factor(tot, mv)
        speed = (tot.get("gap") or tot["avg_moving"])["speed_kmh"]
        power = tot["np"] if tot["np"] else None
        out = {"moving_s": tot["moving_s"], "distance_m": tot["distance_m"], "avg_hr_moving": A._r(mv, 1),
               "speed_kmh": speed,
               "basis": ef["basis"] if ef else ("power" if power else ("gap" if tot.get("gap") else "speed")),
               "np": power, "ef": ef["value"] if ef else None, "ef_unit": ef["unit"] if ef else None,
               "decoupling_pct": dc["pct"] if dc and dc.get("available") else None,
               "best_time": best["time"], "best_distance": best["distance"]}
    p.write_text(json.dumps({"key": key, "card": out}))
    return out


def _acts(db: Session, sport: str) -> list[Activity]:
    return list(db.scalars(select(Activity).where(Activity.sport == sport).where(Activity.stream_path.is_not(None))
                           .order_by(Activity.start_utc)))


def _ref(e: dict) -> dict:
    return {"id": e["id"], "date": e["date"], "name": e["name"]}


def bests(db: Session, sport: str, start: date, end: date) -> dict:
    """Per window (speed–duration curve) and per distance: the best in [start, end] and of all time."""
    rows = []
    for a in _acts(db, sport):
        c = card(db, a)
        if c:
            rows.append(({"id": a.id, "date": a.local_date.isoformat(), "name": a.name}, a.local_date, c))
    win: dict[float, dict] = {}
    dist: dict[float, dict] = {}
    for meta, day, c in rows:
        inside = start <= day <= end
        for b in c["best_time"]:
            w = win.setdefault(b["secs"], {"secs": b["secs"], "period": None, "all": None, "power_period": None, "power_all": None})
            e = {**meta, "speed_kmh": b["speed_kmh"], "pace_s_km": b["pace_s_km"], "power": b.get("power")}
            for k, ok in (("all", True), ("period", inside)):
                if ok and (w[k] is None or (b["speed_kmh"] or 0) > (w[k]["speed_kmh"] or 0)):
                    w[k] = e
                if ok and b.get("power") and (w["power_" + k] is None or b["power"] > w["power_" + k]["power"]):
                    w["power_" + k] = {**_ref(e), "power": b["power"]}
        for b in c["best_distance"]:
            d = dist.setdefault(b["distance_m"], {"distance_m": b["distance_m"], "period": None, "all": None})
            e = {**meta, "time_s": b["time_s"], "speed_kmh": b["speed_kmh"], "pace_s_km": b["pace_s_km"]}
            for k, ok in (("all", True), ("period", inside)):
                if ok and (d[k] is None or b["time_s"] < d[k]["time_s"]):
                    d[k] = e
    return {"sport": sport, "windows": [win[k] for k in sorted(win)], "distances": [dist[k] for k in sorted(dist)],
            "n_all": len(rows), "n_period": sum(1 for _, day, _ in rows if start <= day <= end),
            "rule": "Best average speed over each window (distance ÷ time, pauses included) and the fastest time "
                    "over each distance, from the recorded streams."}


def efficiency(db: Session, sport: str, start: date, end: date, ref: float | None) -> dict:
    """Efficiency factor (output per heartbeat) and decoupling per session, easy/steady ones
    marked (mean HR as a share of the reference max `ref`), plus monthly medians."""
    pts = []
    skipped = 0
    for a in _acts(db, sport):
        if not start <= a.local_date <= end:
            continue
        c = card(db, a)
        if not c or c["ef"] is None:
            skipped += 1
            continue
        share = c["avg_hr_moving"] / ref if ref and c["avg_hr_moving"] else None
        steady = bool(share and STEADY_HR[0] <= share <= STEADY_HR[1] and c["moving_s"] >= MIN_MOVING_S)
        pts.append({"id": a.id, "date": a.local_date.isoformat(), "name": a.name, "ef": c["ef"], "ef_unit": c["ef_unit"],
                    "basis": c["basis"], "decoupling_pct": c["decoupling_pct"], "avg_hr": c["avg_hr_moving"],
                    "hr_share": round(share, 3) if share else None, "speed_kmh": c["speed_kmh"], "np": c["np"],
                    "moving_min": round(c["moving_s"] / 60, 1), "steady": steady})
    months: dict[str, list[dict]] = {}
    for p in pts:
        if p["steady"]:
            months.setdefault(p["date"][:7], []).append(p)
    unit = next((p["ef_unit"] for p in pts if p["steady"]), None)
    monthly = []
    for m in sorted(months):
        same = [p for p in months[m] if p["ef_unit"] == unit]
        dcs = [p["decoupling_pct"] for p in same if p["decoupling_pct"] is not None]
        monthly.append({"month": m, "n": len(same), "ef": round(statistics.median(p["ef"] for p in same), 4) if same else None,
                        "decoupling_pct": round(statistics.median(dcs), 1) if dcs else None})
    return {"sport": sport, "points": pts, "monthly": monthly, "unit": unit, "n": len(pts),
            "n_steady": sum(1 for p in pts if p["steady"]), "without": skipped,
            "rule": (f"Easy/steady = mean moving HR {STEADY_HR[0] * 100:.0f}–{STEADY_HR[1] * 100:.0f} % of the reference max "
                     f"and at least {MIN_MOVING_S / 60:.0f} min moving. Efficiency factor = output per heartbeat: "
                     "normalised power ÷ HR when power is recorded, else metres per beat (grade-adjusted for runs). "
                     "Monthly line = median of the steady sessions.")}
