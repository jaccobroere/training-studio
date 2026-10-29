"""Per-activity analysis from the stored per-second stream (pure: no database, no I/O).

`analyse(stream, sport, laps, hr_ref=…)` returns everything the activity view shows: totals
(moving vs stopped, speed and pace, cadence, power with NP/VI, elevation, grade-adjusted pace),
time in heart-rate zones, splits, device laps re-measured from the stream, best efforts,
aerobic decoupling, the whole-session efficiency factor, the turns-vs-straights split on skates,
the longest steady block's efficiency factor, time at speed and a projected route trace.

House rules: pace and speed over a window are distance ÷ time over that window (never a mean
of instantaneous pace); heart rate, cadence and power are time-weighted; a gap in the
recording longer than GAP_S is a pause (stopped, never interpolated); anything that cannot be
computed is None with the reason in `notes`, never zero.

Positions leave this module in two forms, both for the route card only (the per-second stream
still travels without `lat`/`lon`): the projected trace in metres around the route's centre
(`route.points`, drawn by the local SVG fallback) and the same thinned trace as absolute
degrees (`route.center`, `route.ll`, and `lat`/`lon` on each mark), so the browser can place
the line on map tiles. That makes OpenStreetMap the only third party the browser contacts —
tiles come straight from tile.openstreetmap.org, and the page works without them.

Kept open for later sport-specific analyses (e.g. skating stints): each block is its own
function over the same prepared `_S` samples; add one and register it in `analyse`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

GAP_S = 15.0  # a hole in the timestamps longer than this is a pause
EARTH_M = 6_371_000.0
ZONE_FRACTIONS = (0.5, 0.6, 0.7, 0.8, 0.9)  # zone n starts at this share of the reference max HR
# Below this speed (m/s) the athlete counts as stopped.
MOVING_MS = {"run": 1.0, "walk": 0.5, "ride": 1.5, "skate": 1.2, "swim": 0.2}
SPLIT_M = {"ride": 5000.0}  # everything else splits per km
BEST_DISTANCES = {"run": (400.0, 1000.0, 5000.0, 10000.0, 21097.5), "skate": (400.0, 1000.0, 5000.0, 10000.0),
                  "ride": (1000.0, 5000.0, 10000.0, 20000.0, 40000.0), "walk": (1000.0, 5000.0)}
# The speed–duration curve: best average speed (and power) over these windows.
CURVE_S = (10.0, 30.0, 60.0, 300.0, 1200.0, 3600.0)
BEST_TIMES = {"ride": CURVE_S, "skate": CURVE_S, "run": CURVE_S}
HIST_KMH = {"run": 1.0, "walk": 0.5, "ride": 3.0, "skate": 2.0}  # bin width of time-at-speed
ROUTE_POINTS = 2000
REST_S = 60.0  # a stop this long ends a block: best efforts and fixed laps never span it
TURN_WIN_S = 3.0  # a heading is the circular mean of the raw headings in this window
TURN_DEG_S = 4.0  # a sample turns when the heading changes faster than this
TURN_MIN_S = 3.0  # a contiguous turn this long counts as one turn
TURN_MIN_MOVING_S = 300.0  # turns vs straights needs this much movement…
TURN_MIN_N = 4  # …and at least this many turns
STEADY_MIN_S = 300.0  # the longest steady block is at least this long…
STEADY_CV_PCT = 10.0  # …and its 3 s-smoothed speed varies no more than this


@dataclass
class _S:
    """Prepared samples: elapsed t, cumulative distance cd (m, from 0), speed v (m/s), and per
    interval i (between sample i-1 and i): dt and whether it counts as moving."""
    t: list[float]
    cd: list[float]
    v: list[float | None]
    cols: dict[str, list]
    dt: list[float] = field(default_factory=list)
    moving: list[bool] = field(default_factory=list)
    paused: list[bool] = field(default_factory=list)

    def col(self, k: str) -> list:
        return self.cols.get(k) or [None] * len(self.t)


def _num(x: Any) -> float | None:
    if x is None or isinstance(x, bool):
        return None
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _r(x: float | None, d: int = 1) -> float | None:
    return None if x is None else round(x, d)


def prepare(stream: dict, sport: str) -> _S | None:
    t = [_num(x) for x in stream.get("t") or []]
    if len(t) < 2 or any(x is None for x in t):
        return None
    t = [float(x) for x in t]  # type: ignore[arg-type]
    n = len(t)
    cols = {k: [_num(x) for x in v] for k, v in stream.items() if isinstance(v, list) and len(v) == n and k != "t"}
    dist = cols.get("dist")
    sp = cols.get("speed")
    cd: list[float] = [0.0] * n
    if dist and any(x is not None for x in dist):
        first = next(x for x in dist if x is not None)
        last = first
        for i, x in enumerate(dist):
            if x is not None and x >= last:
                last = x
            cd[i] = last - first
    elif sp:
        for i in range(1, n):
            dt = t[i] - t[i - 1]
            cd[i] = cd[i - 1] + ((sp[i] or 0.0) * dt if dt <= GAP_S else 0.0)
    v: list[float | None] = []
    for i in range(n):
        s = sp[i] if sp else None
        if s is None and i > 0 and t[i] > t[i - 1]:
            s = (cd[i] - cd[i - 1]) / (t[i] - t[i - 1])
        v.append(s)
    s = _S(t=t, cd=cd, v=v, cols=cols)
    thr = MOVING_MS.get(sport, 0.6)
    s.dt, s.moving, s.paused = [0.0], [False], [False]
    for i in range(1, n):
        dt = max(0.0, t[i] - t[i - 1])
        paused = dt > GAP_S
        s.dt.append(dt)
        s.paused.append(paused)
        s.moving.append(not paused and v[i] is not None and v[i] >= thr)  # type: ignore[operator]
    return s


# ------------------------------------------------------------------ windows

def _wmean(s: _S, key: str, i0: int, i1: int, *, moving_only: bool = False, positive: bool = False) -> float | None:
    """Time-weighted mean of a column over intervals (i0, i1]; pauses never count."""
    col = s.col(key)
    tot = w = 0.0
    for i in range(i0 + 1, i1 + 1):
        x = col[i]
        if x is None or s.paused[i] or (moving_only and not s.moving[i]) or (positive and x <= 0):
            continue
        tot += x * s.dt[i]
        w += s.dt[i]
    return tot / w if w else None


def _max(s: _S, key: str, i0: int, i1: int) -> float | None:
    vals = [x for x in s.col(key)[i0:i1 + 1] if x is not None]
    return max(vals) if vals else None


def _idx_at(t: list[float], x: float) -> int:
    """Index of the last sample at or before x."""
    lo, hi = 0, len(t) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if t[mid] <= x:
            lo = mid
        else:
            hi = mid - 1
    return lo


def _time_at_dist(s: _S, d: float, j: int) -> float:
    """Interpolated elapsed time at which cumulative distance reaches d, given cd[j] >= d."""
    if j == 0 or s.cd[j] == s.cd[j - 1]:
        return s.t[j]
    f = (d - s.cd[j - 1]) / (s.cd[j] - s.cd[j - 1])
    return s.t[j - 1] + f * (s.t[j] - s.t[j - 1])


def _moving_s(s: _S, i0: int, i1: int) -> float:
    return sum(s.dt[i] for i in range(i0 + 1, i1 + 1) if s.moving[i])


def _speed_pace(dist: float | None, secs: float | None) -> dict:
    if not dist or not secs or dist <= 0 or secs <= 0:
        return {"speed_kmh": None, "pace_s_km": None}
    return {"speed_kmh": round(dist / secs * 3.6, 2), "pace_s_km": round(secs / (dist / 1000), 1)}


def _window(s: _S, i0: int, i1: int, sport: str, gapf: list[float] | None) -> dict:
    """Shared measures of one stretch (split or lap). Speed/pace use elapsed time; the moving
    figure is beside it."""
    dist = s.cd[i1] - s.cd[i0]
    secs = s.t[i1] - s.t[i0]
    alt = s.col("alt")
    a0 = next((alt[i] for i in range(i0, i1 + 1) if alt[i] is not None), None)
    a1 = next((alt[i] for i in range(i1, i0 - 1, -1) if alt[i] is not None), None)
    out = {"distance_m": round(dist, 1), "time_s": round(secs, 1), "moving_s": round(_moving_s(s, i0, i1), 1),
           **_speed_pace(dist, secs),
           "avg_hr": _r(_wmean(s, "hr", i0, i1), 0), "max_hr": _max(s, "hr", i0, i1),
           "max_speed_kmh": _r(_best_time_speed(s, 5.0, i0, i1), 1),
           "avg_cad": _r(_cad(s, i0, i1, sport), 0), "avg_power": _r(_wmean(s, "pow", i0, i1, moving_only=True), 0),
           "elev_delta_m": _r(a1 - a0 if a0 is not None and a1 is not None else None, 0)}
    if gapf is not None:
        gd = sum((s.cd[i] - s.cd[i - 1]) * gapf[i] for i in range(i0 + 1, i1 + 1))
        out["gap_s_km"] = round(secs / (gd / 1000), 1) if gd > 0 and secs > 0 else None
    return out


def _cad(s: _S, i0: int, i1: int, sport: str) -> float | None:
    """Running cadence: the FIT field counts one foot (strides/min); steps/min is double."""
    c = _wmean(s, "cad", i0, i1, moving_only=True, positive=True)
    return None if c is None else c * (2 if sport in ("run", "walk") else 1)


# ------------------------------------------------------------------ best efforts

def _best_time_speed(s: _S, secs: float, i0: int = 0, i1: int | None = None) -> float | None:
    """Highest average speed (km/h) over any window of `secs` elapsed seconds (distance ÷ time,
    window ends interpolated)."""
    r = _best_time(s, secs, i0, i1)
    return r["speed_kmh"] if r else None


def _best_time(s: _S, secs: float, i0: int = 0, i1: int | None = None) -> dict | None:
    i1 = len(s.t) - 1 if i1 is None else i1
    if s.t[i1] - s.t[i0] < secs:
        return None
    best, at = -1.0, 0.0
    j = i0
    for i in range(i0, i1 + 1):
        end = s.t[i] + secs
        if end > s.t[i1]:
            break
        while j < i1 and s.t[j + 1] < end:
            j += 1
        # distance at time `end`, interpolated between j and j+1
        k = min(j + 1, i1)
        span = s.t[k] - s.t[j]
        d_end = s.cd[j] + ((end - s.t[j]) / span * (s.cd[k] - s.cd[j]) if span > 0 else 0.0)
        d = d_end - s.cd[i]
        if d > best:
            best, at = d, s.t[i]
    if best <= 0:
        return None
    return {"secs": secs, "distance_m": round(best, 1), "start_s": round(at, 1), "end_s": round(at + secs, 1),
            **_speed_pace(best, secs)}


def rests(s: _S, min_s: float = REST_S) -> list[dict]:
    """Stops of at least `min_s` (not moving, or the watch paused), as sample ranges: the rest
    runs from sample `a` to sample `b`, and the intervals in between were all not moving."""
    out, a = [], None
    n = len(s.t)
    for i in range(1, n + 1):
        idle = i < n and not s.moving[i]
        if idle and a is None:
            a = i - 1
        elif not idle and a is not None:
            if s.t[i - 1] - s.t[a] >= min_s:
                out.append({"a": a, "b": i - 1, "start_s": s.t[a] - s.t[0], "time_s": s.t[i - 1] - s.t[a]})
            a = None
    return out


def blocks(s: _S, min_s: float = REST_S) -> list[dict]:
    """Stretches of riding/skating/running between rests: {i0, i1, rest_before_s}. The stretch
    starts where the previous rest ends and ends where the next one begins."""
    rs = rests(s, min_s)
    out, i0, before = [], 0, 0.0
    for r in rs:
        if r["a"] > i0:
            out.append({"i0": i0, "i1": r["a"], "rest_before_s": round(before, 1)})
        i0, before = r["b"], r["time_s"]
    if len(s.t) - 1 > i0:
        out.append({"i0": i0, "i1": len(s.t) - 1, "rest_before_s": round(before, 1)})
    # a leading rest is not "rest before" anything the reader can see: drop it from block 1
    if out and rs and rs[0]["a"] == 0:
        out[0]["rest_before_s"] = 0.0
    keep = [b for b in out if _moving_s(s, b["i0"], b["i1"]) >= 10]
    return keep or [{"i0": 0, "i1": len(s.t) - 1, "rest_before_s": 0.0}]


def _best_dist(s: _S, dist: float, i0: int = 0, i1: int | None = None) -> dict | None:
    """Fastest time to cover `dist` metres, starting at any sample in [i0, i1] (end interpolated)."""
    i1 = len(s.t) - 1 if i1 is None else i1
    if s.cd[i1] - s.cd[i0] < dist:
        return None
    best, at = math.inf, 0.0
    j = i0
    n = i1 + 1
    for i in range(i0, n):
        target = s.cd[i] + dist
        if target > s.cd[i1]:
            break
        while j < n - 1 and s.cd[j] < target:
            j += 1
        dt = _time_at_dist(s, target, j) - s.t[i]
        if 0 < dt < best:
            best, at = dt, s.t[i]
    if not math.isfinite(best):
        return None
    return {"distance_m": dist, "time_s": round(best, 1), "start_s": round(at, 1), "end_s": round(at + best, 1),
            **_speed_pace(dist, best)}


def _grid_1hz(s: _S, key: str, cuts: set[int] | None = None) -> list[list[float]]:
    """Column resampled to 1 Hz (step hold), one list per stretch between pauses (and `cuts`,
    sample indexes inside rests); None → 0 (a dropped power sample while coasting reads as zero,
    as the device records it)."""
    col = s.col(key)
    out: list[list[float]] = [[]]
    for i in range(1, len(s.t)):
        if s.paused[i] or (cuts and i in cuts):
            if out[-1]:
                out.append([])
            continue
        x = col[i] or 0.0
        out[-1].extend([x] * max(0, int(round(s.t[i])) - int(round(s.t[i - 1]))))
    return [seg for seg in out if seg]


def _best_power(segs: list[list[float]], secs: int) -> float | None:
    best = None
    for seg in segs:
        if len(seg) < secs:
            continue
        run = sum(seg[:secs])
        m = run
        for k in range(secs, len(seg)):
            run += seg[k] - seg[k - secs]
            m = max(m, run)
        best = max(best or 0.0, m / secs)
    return best


def _normalized_power(segs: list[list[float]]) -> float | None:
    """Coggan NP: 30 s rolling mean, to the 4th power, averaged, 4th root. Pauses excluded."""
    acc, n = 0.0, 0
    for seg in segs:
        if len(seg) < 30:
            continue
        run = sum(seg[:30])
        acc += (run / 30) ** 4
        n += 1
        for k in range(30, len(seg)):
            run += seg[k] - seg[k - 30]
            acc += (run / 30) ** 4
            n += 1
    return (acc / n) ** 0.25 if n else None


# ------------------------------------------------------------------ terrain

def _smooth_alt(s: _S, half: int = 5) -> list[float | None]:
    alt = s.col("alt")
    out: list[float | None] = []
    for i in range(len(alt)):
        w = [x for x in alt[max(0, i - half):i + half + 1] if x is not None]
        out.append(sum(w) / len(w) if w else None)
    return out


def elevation(s: _S, hysteresis: float = 3.0) -> dict:
    """Gain and loss with a dead band, so sensor noise does not add up to climbing."""
    alt = [x for x in _smooth_alt(s) if x is not None]
    if len(alt) < 2:
        return {"gain_m": None, "loss_m": None, "min_m": None, "max_m": None}
    gain = loss = 0.0
    ref = alt[0]
    for x in alt[1:]:
        if x - ref >= hysteresis:
            gain += x - ref
            ref = x
        elif ref - x >= hysteresis:
            loss += ref - x
            ref = x
    return {"gain_m": round(gain), "loss_m": round(loss), "min_m": round(min(alt)), "max_m": round(max(alt))}


def minetti_factor(grade: float) -> float:
    """Energy cost of running at a grade relative to flat (Minetti et al. 2002), grade clamped
    to ±45%. Multiplying distance by it gives the flat-equivalent distance."""
    g = max(-0.45, min(0.45, grade))
    c = 155.4 * g**5 - 30.4 * g**4 - 43.3 * g**3 + 46.3 * g**2 + 19.5 * g + 3.6
    return c / 3.6


def gap_factors(s: _S, span_m: float = 30.0) -> list[float] | None:
    """Per interval, the grade-cost factor from smoothed altitude over the last ≥ span_m metres."""
    alt = _smooth_alt(s)
    if sum(1 for x in alt if x is not None) < 10:
        return None
    out = [1.0]
    j = 0
    for i in range(1, len(s.t)):
        while j < i and s.cd[i] - s.cd[j + 1] >= span_m:
            j += 1
        dd = s.cd[i] - s.cd[j]
        if dd >= span_m * 0.5 and alt[i] is not None and alt[j] is not None:
            out.append(minetti_factor((alt[i] - alt[j]) / dd))  # type: ignore[operator]
        else:
            out.append(1.0)
    return out


# ------------------------------------------------------------------ blocks

def totals(s: _S, sport: str, gapf: list[float] | None) -> dict:
    n = len(s.t) - 1
    moving = _moving_s(s, 0, n)
    elapsed = s.t[-1] - s.t[0]
    dist = s.cd[-1]
    stops, run = 0, 0.0
    for i in range(1, len(s.t)):
        if s.moving[i]:
            if run >= 10:
                stops += 1
            run = 0.0
        else:
            run += s.dt[i]
    if run >= 10:
        stops += 1
    segs = _grid_1hz(s, "pow") if any(x for x in s.col("pow") if x) else []
    avg_p = _wmean(s, "pow", 0, n, moving_only=True)
    np_ = _normalized_power(segs) if segs else None
    work = sum((s.col("pow")[i] or 0.0) * s.dt[i] for i in range(1, len(s.t)) if not s.paused[i]) / 1000 if segs else None
    out = {"distance_m": round(dist, 1), "elapsed_s": round(elapsed, 1), "moving_s": round(moving, 1),
           "stopped_s": round(elapsed - moving, 1), "stops": stops,
           "avg_moving": _speed_pace(dist, moving), "avg_elapsed": _speed_pace(dist, elapsed),
           "max_speed_kmh": _r(_best_time_speed(s, 5.0), 1),
           "avg_hr": _r(_wmean(s, "hr", 0, n), 0), "max_hr": _max(s, "hr", 0, n),
           "avg_cad": _r(_cad(s, 0, n, sport), 0),
           "cad_unit": "spm" if sport in ("run", "walk") else "rpm",
           "avg_power": _r(avg_p, 0), "max_power": _max(s, "pow", 0, n),
           "np": _r(np_, 0), "vi": _r(np_ / avg_p, 2) if np_ and avg_p else None,
           "work_kj": _r(work, 0), **elevation(s)}
    if gapf is not None and moving > 0:
        gd = sum((s.cd[i] - s.cd[i - 1]) * gapf[i] for i in range(1, len(s.t)) if s.moving[i])
        out["gap"] = _speed_pace(gd, moving) if gd > 0 else None
    return out


def efficiency_factor(tot: dict, moving_hr: float | None) -> dict | None:
    """Output per heartbeat for the whole session: normalised power ÷ moving-time HR when power
    is recorded, else (grade-adjusted) speed ÷ HR. The same figure as the Health trend's
    per-activity card (`health/derived.py`), so the activity and the chart never disagree;
    None without heart rate or without output."""
    if not moving_hr:
        return None
    speed = (tot.get("gap") or tot.get("avg_moving") or {}).get("speed_kmh")
    power = tot.get("np") or None
    if power:
        return {"value": _r(power / moving_hr, 4), "unit": "W/bpm", "basis": "power"}
    if speed:
        return {"value": _r(speed / 3.6 * 60 / moving_hr, 4), "unit": "m/beat",
                "basis": "gap" if tot.get("gap") else "speed"}
    return None


def hr_zones(s: _S, hr_ref: float | None) -> dict | None:
    """Time in five zones of the reference max HR (Z1 50–60 %, …, Z5 ≥ 90 %)."""
    hr = s.col("hr")
    if not hr_ref or not any(x is not None for x in hr):
        return None
    bounds = [hr_ref * f for f in ZONE_FRACTIONS]
    secs = [0.0] * 5
    below = 0.0
    for i in range(1, len(s.t)):
        x = hr[i]
        if x is None or s.paused[i]:
            continue
        z = sum(1 for b in bounds if x >= b)
        if z == 0:
            below += s.dt[i]
        else:
            secs[z - 1] += s.dt[i]
    tot = sum(secs) + below
    if not tot:
        return None
    zones = [{"zone": k + 1, "lo_bpm": round(bounds[k]), "hi_bpm": round(bounds[k + 1]) if k < 4 else None,
              "s": round(secs[k]), "pct": round(secs[k] / tot * 100, 1)} for k in range(5)]
    return {"ref_bpm": round(hr_ref), "zones": zones, "below_s": round(below), "below_pct": round(below / tot * 100, 1)}


def splits(s: _S, sport: str, gapf: list[float] | None, size: float | None = None) -> dict:
    """Every `size` metres (default 1 km; 5 km for rides) by distance, boundary times
    interpolated between samples; the last part split if ≥ 10 % long."""
    size = size or SPLIT_M.get(sport, 1000.0)
    out = []
    i0, k = 0, 1
    for j in range(1, len(s.t)):
        while s.cd[j] >= k * size:
            # The boundary falls inside interval j: end this split at the nearer sample.
            jj = j if (s.cd[j] - k * size) <= (k * size - s.cd[j - 1]) else j - 1
            jj = max(jj, i0 + 1)
            w = _window(s, i0, jj, sport, gapf)
            t_cross = _time_at_dist(s, k * size, j)
            t_start = s.t[0] if k == 1 else out[-1]["_t_end"]
            w.update(n=k, distance_m=size, time_s=round(t_cross - t_start, 1), _t_end=t_cross,
                     start_s=round(t_start - s.t[0], 1), **_speed_pace(size, t_cross - t_start))
            out.append(w)
            i0, k = jj, k + 1
    rest = s.cd[-1] - (k - 1) * size
    if rest >= 0.1 * size and len(s.t) - 1 > i0:
        w = _window(s, i0, len(s.t) - 1, sport, gapf)
        t_start = out[-1]["_t_end"] if out else s.t[0]
        w.update(n=k, distance_m=round(rest, 1), time_s=round(s.t[-1] - t_start, 1), partial=True,
                 start_s=round(t_start - s.t[0], 1), **_speed_pace(rest, s.t[-1] - t_start))
        out.append(w)
    for w in out:
        w.pop("_t_end", None)
        w.setdefault("partial", False)
    return {"size_m": size, "splits": out}


def laps(s: _S, device_laps: list[dict], sport: str, gapf: list[float] | None) -> list[dict]:
    """Device laps re-measured from the stream; the device's own distance and timer win where given."""
    out = []
    for k, lap in enumerate(device_laps or []):
        a, el = _num(lap.get("start_s")), _num(lap.get("elapsed_s"))
        if a is None or not el:
            continue
        i0, i1 = _idx_at(s.t, s.t[0] + a), _idx_at(s.t, s.t[0] + a + el)
        if i1 <= i0:
            continue
        w = _window(s, i0, i1, sport, gapf)
        dist = _num(lap.get("distance_m")) or w["distance_m"]
        secs = _num(lap.get("timer_s")) or el
        w.update(n=k + 1, start_s=round(a, 1), distance_m=round(dist, 1), time_s=round(secs, 1), **_speed_pace(dist, secs))
        if lap.get("avg_hr") is not None:
            w["avg_hr"] = lap["avg_hr"]
        if lap.get("max_hr") is not None:
            w["max_hr"] = lap["max_hr"]
        out.append(w)
    return out


def best_efforts(s: _S, sport: str) -> dict:
    """Best windows and distances, each inside one block: a window never spans a rest of 60 s or
    more (it would carry the rest in its time). Durations longer than every block are left out."""
    bl = blocks(s)
    rs = rests(s)
    cuts = {i for r in rs for i in range(r["a"] + 1, r["b"] + 1)}
    dists = []
    for d in BEST_DISTANCES.get(sport, ()):
        got = [r for b in bl if (r := _best_dist(s, d, b["i0"], b["i1"]))]
        if got:
            dists.append(min(got, key=lambda r: r["time_s"]))
    times = []
    segs = _grid_1hz(s, "pow", cuts) if any(x for x in s.col("pow") if x) else []
    for secs in BEST_TIMES.get(sport, ()):
        got = [r for b in bl if (r := _best_time(s, secs, b["i0"], b["i1"]))]
        if not got:
            continue
        r = max(got, key=lambda r: r["distance_m"])
        if segs:
            r["power"] = _r(_best_power(segs, int(secs)), 0)
        times.append(r)
    longest = max((s.t[b["i1"]] - s.t[b["i0"]] for b in bl), default=0)
    return {"distance": dists, "time": times, "rest_cut": len(bl) > 1, "longest_block_s": round(longest),
            "blocks": len(bl)}


def _decouple_window(s: _S, i0: int, i1: int, use_power: bool, gapf: list[float] | None) -> dict | None:
    """Efficiency factor in the first vs the second half of moving time between i0 and i1 (the
    shared maths of whole-session decoupling and of a steady block). None when either half has
    no heart rate."""
    total = _moving_s(s, i0, i1)
    halves = [{"s": 0.0, "out": 0.0, "hr": 0.0, "hr_s": 0.0} for _ in range(2)]
    acc = 0.0
    p = s.col("pow")
    hr = s.col("hr")
    for i in range(i0 + 1, i1 + 1):
        if not s.moving[i]:
            continue
        h = halves[0 if acc < total / 2 else 1]
        acc += s.dt[i]
        h["s"] += s.dt[i]
        if use_power:
            h["out"] += (p[i] or 0.0) * s.dt[i]
        else:
            h["out"] += (s.cd[i] - s.cd[i - 1]) * (gapf[i] if gapf is not None else 1.0)
        if hr[i] is not None:
            h["hr"] += hr[i] * s.dt[i]
            h["hr_s"] += s.dt[i]
    res = []
    for h in halves:
        if not h["hr_s"] or not h["s"]:
            return None
        out = h["out"] / h["s"]  # W, or m/s
        mean_hr = h["hr"] / h["hr_s"]
        res.append({"output": round(out if use_power else out * 3.6, 2), "hr": round(mean_hr, 1),
                    "ef": round(out / mean_hr * (1 if use_power else 60), 4), "moving_s": round(h["s"])})
    ef1, ef2 = res[0]["ef"], res[1]["ef"]
    return {"basis": "power" if use_power else ("gap" if gapf is not None else "speed"),
            "output_unit": "W" if use_power else "km/h", "ef_unit": "W/bpm" if use_power else "m per beat",
            "first": res[0], "second": res[1], "pct": round((ef1 - ef2) / ef1 * 100, 1) if ef1 else None,
            "hr_drift_bpm": round(res[1]["hr"] - res[0]["hr"], 1)}


def decoupling(s: _S, sport: str, gapf: list[float] | None, min_moving_s: float = 1200.0) -> dict | None:
    """Aerobic decoupling: output per heartbeat (efficiency factor) in the first vs the second
    half of moving time. Output = power when recorded, else speed (grade-adjusted for runs)."""
    hr = s.col("hr")
    if not any(x is not None for x in hr):
        return None
    total = _moving_s(s, 0, len(s.t) - 1)
    if total < min_moving_s:
        return {"available": False, "why": f"needs at least {int(min_moving_s // 60)} min of moving time"}
    use_power = any(x for x in s.col("pow") if x)
    out = _decouple_window(s, 0, len(s.t) - 1, use_power, gapf)
    return {**out, "available": True} if out else None


def _dist_between(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance (m) between two fixes."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_M * math.asin(math.sqrt(a))


def _bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Bearing of travel (degrees clockwise from north) between two fixes."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return math.degrees(math.atan2(y, x)) % 360


def turns(s: _S, sport: str) -> dict | None:
    """Skating's turns vs straights: heading from consecutive GPS fixes, smoothed over ~3 s, and
    a sample is turning when the heading changes faster than 4 °/s. Moving seconds and distance
    are split between the two classes (speed = distance ÷ time in each), and a turn is a
    contiguous turn at least 3 s long. None without GPS, below 5 min of movement or under four
    distinct turns."""
    if sport != "skate":
        return None
    lat, lon = s.col("lat"), s.col("lon")
    if sum(1 for a, b in zip(lat, lon) if a is not None and b is not None) < 20:
        return None
    if _moving_s(s, 0, len(s.t) - 1) < TURN_MIN_MOVING_S:
        return None
    # Raw heading of every interval with a real fix-to-fix step (a sub-metre step is GPS noise).
    raw: list[tuple[int, float, float]] = []  # (interval index, midpoint time, heading)
    for i in range(1, len(s.t)):
        if s.paused[i] or s.dt[i] <= 0 or lat[i] is None or lon[i] is None or lat[i - 1] is None or lon[i - 1] is None:
            continue
        if _dist_between(lat[i - 1], lon[i - 1], lat[i], lon[i]) < 1.0:  # type: ignore[arg-type]
            continue
        raw.append((i, (s.t[i - 1] + s.t[i]) / 2, _bearing(lat[i - 1], lon[i - 1], lat[i], lon[i])))  # type: ignore[arg-type]
    if len(raw) < 10:
        return None
    # Circular mean over the ~3 s window: the raw headings at 1 s sampling are noisy.
    h = TURN_WIN_S / 2
    heading: dict[int, float] = {}
    j0 = 0
    for k, (i, tm, _) in enumerate(raw):
        while raw[j0][1] < tm - h:
            j0 += 1
        j1 = k
        while j1 + 1 < len(raw) and raw[j1 + 1][1] <= tm + h:
            j1 += 1
        ys = sum(math.sin(math.radians(raw[j][2])) for j in range(j0, j1 + 1))
        xs = sum(math.cos(math.radians(raw[j][2])) for j in range(j0, j1 + 1))
        heading[i] = math.degrees(math.atan2(ys, xs)) % 360
    # Turn rate between consecutive smoothed headings; a pause or a long gap starts afresh.
    rate: dict[int, float] = {}
    prev: tuple[float, float] | None = None  # (interval end time, heading)
    for i in range(1, len(s.t)):
        hh = heading.get(i)
        if hh is not None:
            if prev is not None:
                span = s.t[i] - prev[0]
                if 0 < span <= GAP_S:
                    rate[i] = ((hh - prev[1] + 180) % 360 - 180) / span
            prev = (s.t[i], hh)
        elif s.paused[i]:
            prev = None
    straight_s = straight_d = turn_s = turn_d = 0.0
    n_turns = 0
    run_s, was_turn = 0.0, False
    for i in range(1, len(s.t)):
        r = rate.get(i)
        turn = r is not None and s.moving[i] and not s.paused[i] and abs(r) > TURN_DEG_S
        if turn:
            d = s.cd[i] - s.cd[i - 1]
            turn_s += s.dt[i]
            turn_d += d
            run_s += s.dt[i]
        else:
            if was_turn and run_s >= TURN_MIN_S:
                n_turns += 1
            run_s = 0.0
            if r is not None and s.moving[i] and not s.paused[i]:
                straight_s += s.dt[i]
                straight_d += s.cd[i] - s.cd[i - 1]
        was_turn = turn
    if was_turn and run_s >= TURN_MIN_S:
        n_turns += 1
    if n_turns < TURN_MIN_N:
        return None
    total = straight_s + turn_s
    if not total:
        return None
    st_speed = straight_d / straight_s * 3.6 if straight_s else None
    tu_speed = turn_d / turn_s * 3.6 if turn_s else None
    return {"available": True,
            "straight": {"s": round(straight_s), "pct": round(straight_s / total * 100, 1),
                         "speed_kmh": _r(st_speed, 2)},
            "turn": {"s": round(turn_s), "pct": round(turn_s / total * 100, 1), "speed_kmh": _r(tu_speed, 2)},
            "n_turns": n_turns,
            "loss_kmh": _r(st_speed - tu_speed, 2) if st_speed is not None and tu_speed is not None else None}


def _window_totals(s: _S, i0: int, i1: int, gapf: list[float] | None) -> dict:
    """The totals `efficiency_factor()` reads, restricted to [i0, i1] (moving time for speed,
    NP from the window's own 1 Hz power samples)."""
    mv = _moving_s(s, i0, i1)
    out: dict = {"avg_moving": _speed_pace(s.cd[i1] - s.cd[i0], mv)}
    if gapf is not None and mv > 0:
        gd = sum((s.cd[i] - s.cd[i - 1]) * gapf[i] for i in range(i0 + 1, i1 + 1) if s.moving[i])
        out["gap"] = _speed_pace(gd, mv) if gd > 0 else None
    if any(x for x in s.col("pow") if x):
        cuts = set(range(1, i0 + 1)) | set(range(i1 + 1, len(s.t)))
        segs = _grid_1hz(s, "pow", cuts)
        out["np"] = _normalized_power(segs) if segs else None
    return out


def _weighted_cv(s: _S, v: list[float], i0: int, i1: int) -> float | None:
    """Time-weighted coefficient of variation (%) of an already smoothed speed over moving
    samples in [i0, i1]."""
    vals = [(v[i], s.dt[i]) for i in range(i0 + 1, i1 + 1) if s.moving[i] and v[i] > 0]
    w = sum(x[1] for x in vals)
    if not vals or not w:
        return None
    mean = sum(x * dt for x, dt in vals) / w
    if mean <= 0:
        return None
    var = sum(dt * (x - mean) ** 2 for x, dt in vals) / w
    return math.sqrt(var) / mean * 100


def steady_block(s: _S, gapf: list[float] | None) -> dict:
    """The longest maximal moving block (no stop of 60 s or more) of at least 5 min whose 3 s
    smoothed speed varies by at most 10 % (CV): the window the steady efficiency factor is read
    over. Its EF is `efficiency_factor()` and its decoupling the same maths, both restricted to
    the block. Without such a block it says so: `{available: false, min_s, cv_pct}` where
    `cv_pct` is the lowest CV any block of at least `min_s` reached (null when none was that
    long), so the reader learns how close the skate came."""
    from health.laps import smooth_speed  # laps imports this module: import at call time

    v3 = smooth_speed(s, 3.0)
    best: tuple[float, int, int, float] | None = None
    closest: float | None = None
    for b in blocks(s):
        i0, i1 = b["i0"], b["i1"]
        mv = _moving_s(s, i0, i1)
        if mv < STEADY_MIN_S:
            continue
        cv = _weighted_cv(s, v3, i0, i1)
        if cv is None:
            continue
        closest = cv if closest is None else min(closest, cv)
        if cv > STEADY_CV_PCT:
            continue
        if best is None or mv > best[0]:
            best = (mv, i0, i1, cv)
    if best is None:
        return {"available": False, "min_s": int(STEADY_MIN_S),
                "cv_pct": round(closest, 1) if closest is not None else None}
    mv, i0, i1, cv = best
    tot = _window_totals(s, i0, i1, gapf)
    ef = efficiency_factor(tot, _wmean(s, "hr", i0, i1, moving_only=True))
    use_power = any(x for x in s.col("pow")[i0:i1 + 1] if x)
    dc = _decouple_window(s, i0, i1, use_power, gapf)
    return {"available": True, "start_s": round(s.t[i0] - s.t[0], 1), "end_s": round(s.t[i1] - s.t[0], 1),
            "moving_s": round(mv, 1), "distance_m": round(s.cd[i1] - s.cd[i0], 1),
            "ef": ef["value"] if ef else None, "ef_unit": ef["unit"] if ef else None,
            "basis": ef["basis"] if ef else ("power" if use_power else ("gap" if gapf is not None else "speed")),
            "decoupling_pct": dc["pct"] if dc else None, "hr_drift_bpm": dc["hr_drift_bpm"] if dc else None,
            "cv_pct": round(cv, 1)}


def speed_histogram(s: _S, sport: str) -> dict | None:
    """Moving time per speed bin (km/h)."""
    step = HIST_KMH.get(sport, 1.0)
    vals = [(s.v[i] * 3.6, s.dt[i]) for i in range(1, len(s.t)) if s.moving[i] and s.v[i] is not None]  # type: ignore[operator]
    if len(vals) < 10:
        return None
    srt = sorted(v for v, _ in vals)
    lo = math.floor(srt[int(0.01 * (len(srt) - 1))] / step) * step
    hi = math.ceil(srt[int(0.995 * (len(srt) - 1))] / step) * step
    nb = max(1, min(60, int(round((hi - lo) / step))))
    secs = [0.0] * nb
    for v, dt in vals:
        k = min(nb - 1, max(0, int((v - lo) // step)))
        secs[k] += dt
    return {"step_kmh": step, "bins": [{"lo": round(lo + k * step, 2), "hi": round(lo + (k + 1) * step, 2), "s": round(secs[k])}
                                       for k in range(nb)]}


def _projected(s: _S) -> tuple[list[tuple[int, float, float]], float | None, float | None]:
    """(sample index, x east, y north) in metres around the mean position, together with that
    mean as (lat, lon) degrees; samples without a fix are left out."""
    lat, lon = s.col("lat"), s.col("lon")
    pts = [(i, la, lo) for i, (la, lo) in enumerate(zip(lat, lon)) if la is not None and lo is not None]
    if not pts:
        return [], None, None
    lat0 = sum(p[1] for p in pts) / len(pts)
    lon0 = sum(p[2] for p in pts) / len(pts)
    kx = math.cos(math.radians(lat0)) * math.pi / 180 * EARTH_M
    ky = math.pi / 180 * EARTH_M
    return [(i, (lo - lon0) * kx, (la - lat0) * ky) for i, la, lo in pts], lat0, lon0


def project(s: _S) -> list[tuple[int, float, float]]:
    """(sample index, x east, y north) in metres around the mean position; samples without a fix
    are left out."""
    return _projected(s)[0]


def route(s: _S, split_m: float, max_points: int = ROUTE_POINTS) -> dict | None:
    """The trace twice: `points` in metres around the route's centre (x east, y north), thinned by
    distance and each with its elapsed time for the shared cursor, and `ll` as the same kept
    samples in absolute degrees (1:1 with `points`), plus `center` and the split marks with their
    own lat/lon. The screen needs the degrees to fetch map tiles; the metres stay for the local
    SVG fallback."""
    xy, lat0, lon0 = _projected(s)
    if len(xy) < 10 or lat0 is None or lon0 is None:
        return None
    step = max(1.0, s.cd[-1] / max_points)
    keep = [xy[0]]
    for p in xy[1:-1]:
        if s.cd[p[0]] - s.cd[keep[-1][0]] >= step or s.paused[p[0]]:
            keep.append(p)
    keep.append(xy[-1])
    lat, lon = s.col("lat"), s.col("lon")
    marks = []
    k = 1
    for i, x, y in xy:
        if s.cd[i] >= k * split_m:
            marks.append({"n": k, "x": round(x), "y": round(y),
                          "lat": round(lat[i], 5), "lon": round(lon[i], 5)})  # type: ignore[arg-type]
            k += 1
    xs, ys = [p[1] for p in xy], [p[2] for p in xy]
    return {"points": [[round(x, 1), round(y, 1), round(s.t[i] - s.t[0], 1)] for i, x, y in keep],
            "ll": [[round(lat[i], 5), round(lon[i], 5)] for i, _, _ in keep],  # type: ignore[arg-type]
            "center": [round(lat0, 5), round(lon0, 5)],
            "bbox": [round(min(xs)), round(min(ys)), round(max(xs)), round(max(ys))],
            "marks": marks, "mark_m": split_m, "n": len(xy)}


def analyse(stream: dict | None, sport: str, device_laps: list[dict] | None = None, *, hr_ref: float | None = None) -> dict | None:
    """Everything the activity view reads. None when there is no usable stream."""
    s = prepare(stream or {}, sport)
    if s is None:
        return None
    gapf = gap_factors(s) if sport in ("run", "walk") else None
    sp = splits(s, sport, gapf)
    tot = totals(s, sport, gapf)
    mv = _wmean(s, "hr", 0, len(s.t) - 1, moving_only=True)
    notes = []
    if not any(x is not None for x in s.col("hr")):
        notes.append("No heart rate in this recording.")
    if gapf is None and sport in ("run", "walk"):
        notes.append("No altitude, so no grade-adjusted pace.")
    if not s.cols.get("lat"):
        notes.append("No GPS positions in this recording.")
    from health import laps as L

    return {"sport": sport, "samples": len(s.t), "sampling": L.sampling(s), "totals": tot,
            "ef": efficiency_factor(tot, mv),
            "zones": hr_zones(s, hr_ref), "splits": sp, "laps": laps(s, device_laps or [], sport, gapf),
            "lapsets": L.lap_sets(s, sport, device_laps or []), "best": best_efforts(s, sport),
            "decoupling": decoupling(s, sport, gapf), "turns": turns(s, sport),
            "steady": steady_block(s, gapf), "speed_hist": speed_histogram(s, sport),
            "route": route(s, sp["size_m"]), "heading": L.heading(s), "notes": notes,
            "rules": {"pace": "Pace and speed over any stretch are distance ÷ time; splits and laps use elapsed time.",
                      "moving": f"Moving = speed at least {MOVING_MS.get(sport, 0.6) * 3.6:.1f} km/h; a recording gap over {GAP_S:.0f} s is a pause.",
                      "gap": "Grade-adjusted pace: distance weighted by the energy cost of the grade (Minetti 2002).",
                      "zones": "Zones are shares of the reference max HR: Z1 50–60 %, Z2 60–70 %, Z3 70–80 %, Z4 80–90 %, Z5 ≥ 90 %.",
                      "decoupling": "Above 5 % suggests the effort drifted (heart rate rose for the same output).",
                      "ef": "Efficiency factor = output per heartbeat: normalised power ÷ HR when power is recorded, else (grade-adjusted) speed ÷ HR. It is only comparable across steady aerobic sessions.",
                      "blocks": f"A stop of {REST_S:.0f} s or more is a rest and ends a block; best efforts and fixed-distance laps never span one.",
                      "turns": "Turns and straights: heading from consecutive GPS fixes, smoothed over 3 s; a sample turns when the heading changes faster than 4 °/s. A turn is a contiguous turn of at least 3 s; the split needs 5 min of movement and four turns. Speed in each class is distance ÷ time.",
                      "steady": f"Steady EF is read over the longest block of at least 5 min (no stop of {REST_S:.0f} s or more) whose 3 s-smoothed speed varies by at most {STEADY_CV_PCT:.0f} % (CV).",
                      "max_speed": "Max speed = the best 5 s average, so a single GPS spike does not count."}}
