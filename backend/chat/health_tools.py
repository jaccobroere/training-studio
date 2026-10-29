"""Assistant tool over recorded daily data (wellness metrics). Same metric catalogue and
queries as the Health screen, returned compactly with n, gaps, baseline and weekly means."""

from __future__ import annotations

from datetime import date, timedelta

from pydantic_ai import RunContext

import db
from chat.tools import GARMIN, ChatDeps, meta, short_date
from health import queries as q
from health.metrics import METRICS

MAX_DAYS = 730
DAILY_ROWS = 62  # per-day values are listed for short ranges only; longer ones get weekly means


def get_daily_metrics(ctx: RunContext[ChatDeps], start: str, end: str, fields: list[str]) -> dict:
    """Daily wellness metrics between two dates (max 2 years). `fields` are metric keys, e.g.
    hrv_ms, rhr_bpm, sleep_h, sleep_score, stress_avg, bb_max, steps, weight_kg, vo2max,
    readiness (an unknown key returns the catalogue). Per metric: summary stats, days with data
    vs days in range, latest value, personal baseline, weekly means, and the per-day values for
    ranges up to two months. Missing days are gaps, never zero. Garmin scores are estimates.
    Always tell the athlete the range and n behind a number."""
    unknown = [f for f in fields if f not in METRICS]
    if unknown or not fields:
        return meta("Read daily metrics", GARMIN, "Unknown metric", ok=False, error="unknown_metric",
                    unknown=unknown, known=[{"key": m.key, "label": m.label, "unit": m.unit,
                                             "estimate": m.estimate} for m in METRICS.values()])
    s, e = date.fromisoformat(start), date.fromisoformat(end)
    if e < s:
        s, e = e, s
    s = max(s, e - timedelta(days=MAX_DAYS))
    out = {}
    with db.get_db().session() as db_:
        for f in fields[:6]:
            d = q.daily(db_, f, s, e)
            weekly: dict[str, list[float]] = {}
            for day, v in d["points"]:
                if v is not None:
                    dd = date.fromisoformat(day)
                    weekly.setdefault((dd - timedelta(days=dd.weekday())).isoformat(), []).append(v)
            last_base = next((b for b in reversed(d["baseline"]) if b[1] is not None), None)
            row = {"label": d["label"], "unit": d["unit"], "estimate": d["estimate"], "stats": d["stats"],
                   "days_with_data": d["stats"]["n"], "days_in_range": d["expected"], "latest": d["last"],
                   "baseline_latest": {"mean": last_base[1], "sd": last_base[2]} if last_base else None,
                   "baseline_rule": d["baseline_rule"],
                   "weekly_mean": [{"week_monday": w, "mean": round(sum(v) / len(v), 2), "n": len(v)}
                                   for w, v in sorted(weekly.items())][-26:]}
            if len(d["points"]) <= DAILY_ROWS:
                row["daily"] = [{"date": day, "weekday": date.fromisoformat(day).strftime("%a"), "value": v}
                                for day, v in d["points"]]
            out[f] = row
    n = max((r["days_with_data"] for r in out.values()), default=0)
    return meta("Read daily metrics", GARMIN,
                f"{', '.join(out)} · {n} days · {short_date(s.isoformat())}–{short_date(e.isoformat())}",
                range=[s.isoformat(), e.isoformat()], metrics=out)


HEALTH_TOOLS = [get_daily_metrics]
