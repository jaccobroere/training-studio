"""Lap engine, stint detector and speed by heading, over the prepared samples of
health/activity_stats.py (pure: no database, no I/O).

Watches may record "smart" (a sample every 1–several seconds), so nothing here assumes 1 Hz:
lap boundaries and gate crossings are interpolated in time and distance between samples, and
smoothed speed is distance over a time window. `sampling()` says how far apart samples are so
the screen can state how precise a lap boundary can be.

Lap sources (one table shape for all): fixed distance (`d400`, `d200`, `d1000`, `d5000`), a
location gate (`gate`: the most-passed point on a loop, split on every crossing in the main
direction), the device's own laps (`device`), and stints as laps (`stints:abs`, `stints:rel`).
"""

from __future__ import annotations

import math
import statistics

from health.activity_stats import (_S, _idx_at, _max, _moving_s, _speed_pace, _time_at_dist, _window, _wmean, blocks as find_blocks,
                                    gap_factors, laps as device_lap_rows, project, rests as find_rests)

LAP_SOURCES = {"skate": ("d400", "d200", "d1000", "gate", "device", "stints:abs", "stints:rel"),
               "run": ("d1000", "d400", "device"), "ride": ("d5000", "d1000", "device"),
               "walk": ("d1000", "device")}
STINT_KMH = 20.0  # default stint: above this for at least STINT_MIN_S
STINT_MIN_S = 15.0
STINT_REL = 0.15  # alternative: above the session's median moving speed + 15 %
GATE_CELL_M = 8.0
GATE_HALF_WIDTH_M = 20.0
SECTORS = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")


def sampling(s: _S) -> dict:
    gaps = sorted(s.dt[i] for i in range(1, len(s.t)) if not s.paused[i] and s.dt[i] > 0)
    if not gaps:
        return {"median_s": None, "p95_s": None, "smart": False}
    med = statistics.median(gaps)
    return {"median_s": round(med, 2), "p95_s": round(gaps[int(0.95 * (len(gaps) - 1))], 2), "smart": med > 1.2}


def dist_at(s: _S, tt: float) -> float:
    """Cumulative distance at elapsed time tt (s.t scale), interpolated."""
    i = _idx_at(s.t, tt)
    if i >= len(s.t) - 1 or s.t[i + 1] == s.t[i]:
        return s.cd[i]
    f = (tt - s.t[i]) / (s.t[i + 1] - s.t[i])
    return s.cd[i] + max(0.0, min(1.0, f)) * (s.cd[i + 1] - s.cd[i])


def smooth_speed(s: _S, win: float = 3.0) -> list[float]:
    """Distance ÷ time over a centred window of `win` seconds: robust to irregular sampling and
    single-sample dropouts. m/s per sample."""
    h = win / 2
    out = []
    for tt in s.t:
        a, b = max(s.t[0], tt - h), min(s.t[-1], tt + h)
        out.append((dist_at(s, b) - dist_at(s, a)) / (b - a) if b > a else 0.0)
    return out


def _lap(s: _S, n: int, t0: float, t1: float, *, partial: bool = False) -> dict:
    """One lap between two elapsed times (absolute on s.t), distance interpolated."""
    i0, i1 = _idx_at(s.t, t0), _idx_at(s.t, t1)
    dist = dist_at(s, t1) - dist_at(s, t0)
    moving = sum(s.dt[i] for i in range(i0 + 1, i1 + 1) if s.moving[i])
    return {"n": n, "start_s": round(t0 - s.t[0], 1), "time_s": round(t1 - t0, 1), "distance_m": round(dist, 1),
            **_speed_pace(dist, t1 - t0), "moving_s": round(min(moving, t1 - t0), 1),
            "avg_hr": _r0(_wmean(s, "hr", i0, max(i1, i0 + 1))), "max_hr": _max(s, "hr", i0, max(i1, i0 + 1)),
            "partial": partial}


def _r0(x: float | None) -> float | None:
    return None if x is None else round(x)


def summarise(laps: list[dict], *, compare: str) -> dict:
    """Best lap, Δ to best, and consistency over the steady laps (complete, ≤ 5 % stopped):
    CV of lap time (or speed for laps of unequal length) and fade = the least-squares slope per lap."""
    for x in laps:
        x["steady"] = not x["partial"] and x["time_s"] > 0 and x["moving_s"] >= 0.95 * x["time_s"]
    full = [x for x in laps if not x["partial"] and x["speed_kmh"]]
    out: dict = {"compare": compare, "n": len(laps), "n_full": len(full), "best_n": None, "cv_pct": None,
                 "fade": None, "mean": None, "n_steady": 0}
    if not full:
        return out
    if compare == "time":
        best = min(full, key=lambda x: x["time_s"])
        for x in laps:
            x["delta"] = round(x["time_s"] - best["time_s"], 1) if not x["partial"] else None
    else:
        best = max(full, key=lambda x: x["speed_kmh"])
        for x in laps:
            x["delta"] = round(x["speed_kmh"] - best["speed_kmh"], 2) if not x["partial"] and x["speed_kmh"] else None
    out["best_n"] = best["n"]
    steady = [x for x in laps if x["steady"]]
    out["n_steady"] = len(steady)
    vals = [x["time_s"] if compare == "time" else x["speed_kmh"] for x in steady]
    if vals:
        out["mean"] = round(statistics.fmean(vals), 2)
    if len(vals) >= 3:  # fewer laps say nothing about consistency or fade
        mean = statistics.fmean(vals)
        out["cv_pct"] = round(statistics.stdev(vals) / mean * 100, 1) if mean else None
    if len(vals) >= 4:
        mean = statistics.fmean(vals)
        xs = list(range(len(vals)))
        mx = statistics.fmean(xs)
        den = sum((x - mx) ** 2 for x in xs)
        out["fade"] = round(sum((x - mx) * (v - mean) for x, v in zip(xs, vals)) / den, 3) if den else None
    return out


def fixed_laps(s: _S, sport: str, size: float, gapf: list[float] | None = None) -> list[dict]:
    """Laps of `size` metres by the distance stream, restarted after every rest so no lap carries
    a rest in its time (a block's last, short stretch is a part lap). Boundary times are
    interpolated between samples. Rows carry the splits' extras (GAP, cadence, power, climb)."""
    out: list[dict] = []
    for bi, b in enumerate(find_blocks(s)):
        i0, i1 = b["i0"], b["i1"]
        base = s.cd[i0]
        k, ia, t_a = 1, i0, s.t[i0]
        j = i0
        while True:
            target = base + k * size
            if target > s.cd[i1]:
                break
            while j < i1 and s.cd[j] < target:
                j += 1
            t_b = _time_at_dist(s, target, j)
            out.append(_fixed_row(s, sport, gapf, len(out) + 1, bi, ia, j, t_a, t_b, size, False))
            ia, t_a, k = j, t_b, k + 1
        rest = s.cd[i1] - (base + (k - 1) * size)
        if rest >= 0.1 * size and s.t[i1] > t_a:
            out.append(_fixed_row(s, sport, gapf, len(out) + 1, bi, ia, i1, t_a, s.t[i1], rest, True))
    return out


def _fixed_row(s: _S, sport: str, gapf, n: int, block: int, ia: int, ib: int, t0: float, t1: float, dist: float, part: bool) -> dict:
    ib = max(ib, ia + 1)
    w = _window(s, ia, ib, sport, gapf)
    w.update(n=n, block=block, start_s=round(t0 - s.t[0], 1), time_s=round(t1 - t0, 1), distance_m=round(dist, 1),
             partial=part, **_speed_pace(dist, t1 - t0))
    w["moving_s"] = round(min(w["moving_s"], t1 - t0), 1)
    return w


# ------------------------------------------------------------------ location gate

def _unit_vectors(xy: list[tuple[int, float, float]]) -> list[tuple[float, float] | None]:
    out: list[tuple[float, float] | None] = []
    for k in range(len(xy)):
        a, b = xy[max(0, k - 1)], xy[min(len(xy) - 1, k + 1)]
        dx, dy = b[1] - a[1], b[2] - a[2]
        n = math.hypot(dx, dy)
        out.append((dx / n, dy / n) if n > 0.5 else None)
    return out


def find_gate(s: _S, xy: list[tuple[int, float, float]], min_revisit_s: float = 20.0) -> dict | None:
    """The point on a loop passed most often (8 m cells; a pass = a visit ≥ 20 s after the last),
    nearest the start among the cells passed nearly as often, with the main direction of travel
    there. None when no point is passed at least three times (not a loop)."""
    # Rasterise the path between samples (4 m steps), so a sparse sample never skips a cell.
    cells: dict[tuple[int, int], list[tuple[float, int]]] = {}
    for k in range(1, len(xy)):
        (ia, xa, ya), (ib, xb, yb) = xy[k - 1], xy[k]
        if not s.moving[ib] or any(s.paused[ia + 1:ib + 1]):
            continue
        steps = max(1, int(math.hypot(xb - xa, yb - ya) // 4))
        for j in range(steps):
            f = j / steps
            c = (int((xa + f * (xb - xa)) // GATE_CELL_M), int((ya + f * (yb - ya)) // GATE_CELL_M))
            cells.setdefault(c, []).append((s.t[ia] + f * (s.t[ib] - s.t[ia]), k))
    passes: dict[tuple[int, int], int] = {}
    for c, visits in cells.items():
        n, last = 0, -1e9
        for tt, _ in visits:
            if tt - last >= min_revisit_s:
                n += 1
            last = tt
        passes[c] = n
    if not passes or max(passes.values()) < 3:
        return None
    top = max(passes.values())
    near = [c for c, n in passes.items() if n >= 0.9 * top]
    cell = min(near, key=lambda c: cells[c][0][0])  # first reached: the start of the first lap
    ks = sorted({k for _, k in cells[cell]})
    units = _unit_vectors(xy)
    vs = [units[k] for k in ks if units[k] is not None]
    if not vs:
        return None
    ref = vs[0]
    same = [v for v in vs if v[0] * ref[0] + v[1] * ref[1] > 0]
    other = [v for v in vs if v[0] * ref[0] + v[1] * ref[1] <= 0]
    main = same if len(same) >= len(other) else other  # the direction most passes go
    ux, uy = sum(v[0] for v in main), sum(v[1] for v in main)
    n = math.hypot(ux, uy) or 1.0
    gx, gy = (cell[0] + 0.5) * GATE_CELL_M, (cell[1] + 0.5) * GATE_CELL_M
    return {"x": round(gx, 1), "y": round(gy, 1), "dir": (ux / n, uy / n), "passes": top,
            "heading_deg": round(math.degrees(math.atan2(ux, uy)) % 360)}


def gate_laps(s: _S, min_lap_m: float = 100.0) -> tuple[list[dict], dict | None]:
    """Laps between successive crossings of the gate line (perpendicular to the main direction,
    ±20 m wide), crossing times interpolated; a crossing within 100 m of the last is ignored."""
    xy = project(s)
    if len(xy) < 20:
        return [], None
    g = find_gate(s, xy)
    if g is None:
        return [], None
    ux, uy = g["dir"]
    cross: list[float] = []
    last_d = -1e9
    for (ia, xa, ya), (ib, xb, yb) in zip(xy, xy[1:]):
        if ib <= ia or any(s.paused[ia + 1:ib + 1]):
            continue
        aa = (xa - g["x"]) * ux + (ya - g["y"]) * uy
        ab = (xb - g["x"]) * ux + (yb - g["y"]) * uy
        if not (aa < 0 <= ab):
            continue
        f = -aa / (ab - aa)
        lx, ly = xa + f * (xb - xa) - g["x"], ya + f * (yb - ya) - g["y"]
        if abs(-lx * uy + ly * ux) > GATE_HALF_WIDTH_M:
            continue
        tt = s.t[ia] + f * (s.t[ib] - s.t[ia])
        d = dist_at(s, tt)
        if d - last_d < min_lap_m:
            continue
        cross.append(tt)
        last_d = d
    laps = [_lap(s, k + 1, a, b) for k, (a, b) in enumerate(zip(cross, cross[1:]))]
    gate = {k: v for k, v in g.items() if k != "dir"}
    gate["crossings"] = len(cross)
    return laps, gate


# ------------------------------------------------------------------ stints

def stint_defs(s: _S) -> list[dict]:
    """The two stint definitions with their thresholds for this session."""
    mv = sorted(s.v[i] for i in range(1, len(s.t)) if s.moving[i] and s.v[i] is not None)  # type: ignore[misc]
    med = statistics.median(mv) * 3.6 if mv else None
    out = [{"key": "abs", "label": f"≥ {STINT_KMH:.0f} km/h", "threshold_kmh": STINT_KMH,
            "rule": f"Above {STINT_KMH:.0f} km/h for at least {STINT_MIN_S:.0f} s."}]
    if med:
        thr = med * (1 + STINT_REL)
        out.append({"key": "rel", "label": f"Median + {STINT_REL * 100:.0f} %", "threshold_kmh": round(thr, 1),
                    "rule": f"Above the session's median moving speed ({med:.1f} km/h) + {STINT_REL * 100:.0f} % "
                            f"= {thr:.1f} km/h, for at least {STINT_MIN_S:.0f} s."})
    return out


def _hr_at(s: _S, tt: float) -> float | None:
    """HR at elapsed time tt: the nearest sample within 5 s."""
    hr = s.col("hr")
    i = _idx_at(s.t, tt)
    best = None
    for j in (i, i + 1):
        if 0 <= j < len(s.t) and hr[j] is not None and abs(s.t[j] - tt) <= 5:
            if best is None or abs(s.t[j] - tt) < abs(s.t[best] - tt):
                best = j
    return hr[best] if best is not None else None


def stints(s: _S, threshold_kmh: float, *, min_s: float = STINT_MIN_S, merge_s: float = 3.0,
           v3: list[float] | None = None) -> list[dict]:
    """Stretches with 3 s smoothed speed at or above the threshold for at least `min_s`; dips
    shorter than `merge_s` do not end a stint. Per stint: time, distance, average and peak speed,
    time to peak, HR at start and its peak (up to 20 s after the end, HR lags), and the HR drop
    in the 60 s after the end (None when the recording ends first)."""
    v3 = v3 if v3 is not None else smooth_speed(s)
    thr = threshold_kmh / 3.6
    runs: list[list[int]] = []
    for i in range(len(s.t)):
        if v3[i] >= thr and not s.paused[i]:
            # contiguous samples extend the stint however far apart they are (smart recording);
            # after a dip below, only a short one is bridged
            if runs and (runs[-1][1] == i - 1 or s.t[i] - s.t[runs[-1][1]] <= merge_s) \
                    and not any(s.paused[runs[-1][1] + 1:i + 1]):
                runs[-1][1] = i
            else:
                runs.append([i, i])
    hr = s.col("hr")
    out = []
    for a, b in runs:
        t0, t1 = s.t[a], s.t[b]
        if t1 - t0 < min_s:
            continue
        pk = max(range(a, b + 1), key=lambda k: v3[k])
        dist = s.cd[b] - s.cd[a]
        j1 = _idx_at(s.t, t1 + 20)
        hrs = [hr[k] for k in range(a, j1 + 1) if hr[k] is not None]
        h_start = _hr_at(s, t0)
        h_peak = max(hrs) if hrs else None
        h_60 = _hr_at(s, t1 + 60) if t1 + 60 <= s.t[-1] else None
        out.append({"n": len(out) + 1, "start_s": round(t0 - s.t[0], 1), "time_s": round(t1 - t0, 1),
                    "distance_m": round(dist, 1), **_speed_pace(dist, t1 - t0), "peak_kmh": round(v3[pk] * 3.6, 1),
                    "to_peak_s": round(s.t[pk] - t0, 1), "hr_start": h_start, "hr_peak": h_peak,
                    "hr_rise": round(h_peak - h_start) if h_peak is not None and h_start is not None else None,
                    "hr_60": h_60, "hr_drop_60": round(h_peak - h_60) if h_peak is not None and h_60 is not None else None})
    return out


def stints_as_laps(s: _S, rows: list[dict]) -> list[dict]:
    return [_lap(s, x["n"], s.t[0] + x["start_s"], s.t[0] + x["start_s"] + x["time_s"]) for x in rows]


# ------------------------------------------------------------------ heading

def heading(s: _S, min_s: float = 30.0) -> dict | None:
    """Moving speed per compass sector (8 × 45°, bearing of travel from GPS): on a loop the
    straights into and with the wind read differently."""
    xy = project(s)
    if len(xy) < 20:
        return None
    acc = [[0.0, 0.0] for _ in SECTORS]  # metres, seconds
    for (ia, xa, ya), (ib, xb, yb) in zip(xy, xy[1:]):
        if ib != ia + 1 or not s.moving[ib]:
            continue
        dx, dy = xb - xa, yb - ya
        if math.hypot(dx, dy) < 1.0:
            continue
        k = int(((math.degrees(math.atan2(dx, dy)) % 360) + 22.5) // 45) % 8
        acc[k][0] += s.cd[ib] - s.cd[ia]
        acc[k][1] += s.dt[ib]
    total = sum(a[1] for a in acc)
    if total < 120:
        return None
    sec = [{"dir": SECTORS[k], "deg": k * 45, "s": round(acc[k][1]), "pct": round(acc[k][1] / total * 100, 1),
            "speed_kmh": round(acc[k][0] / acc[k][1] * 3.6, 1) if acc[k][1] >= min_s else None} for k in range(8)]
    sp = [x["speed_kmh"] for x in sec if x["speed_kmh"] is not None]
    return {"sectors": sec, "spread_kmh": round(max(sp) - min(sp), 1) if len(sp) >= 2 else None,
            "rule": f"Mean moving speed per direction of travel (sectors with at least {min_s:.0f} s)."}


# ------------------------------------------------------------------ all lap sets

def _tag_blocks(s: _S, rows: list[dict], bl: list[dict], rs: list[dict]) -> None:
    """Give every lap its block (by its start) and flag laps that span a rest (their time holds
    the rest: they are left out of statistics and of the lap list)."""
    for r in rows:
        a = s.t[0] + r["start_s"]
        b = a + r["time_s"]
        r["rest_s"] = round(sum(min(b, s.t[x["b"]]) - max(a, s.t[x["a"]]) for x in rs
                                if min(b, s.t[x["b"]]) > max(a, s.t[x["a"]])), 1) or None
        if "block" not in r:
            mid = (a + b) / 2
            r["block"] = next((k for k, x in enumerate(bl) if s.t[x["i0"]] <= mid <= s.t[x["i1"]]),
                              next((k for k, x in enumerate(bl) if s.t[x["i1"]] >= a), len(bl) - 1))


def block_rows(s: _S, bl: list[dict]) -> list[dict]:
    out = []
    for k, b in enumerate(bl):
        i0, i1 = b["i0"], b["i1"]
        dist, el = s.cd[i1] - s.cd[i0], s.t[i1] - s.t[i0]
        mv = _moving_s(s, i0, i1)
        out.append({"n": k + 1, "start_s": round(s.t[i0] - s.t[0], 1), "time_s": round(el, 1), "moving_s": round(mv, 1),
                    "distance_m": round(dist, 1), **_speed_pace(dist, mv), "avg_hr": _r0(_wmean(s, "hr", i0, i1)),
                    "rest_before_s": b["rest_before_s"]})
    return out


def lap_sets(s: _S, sport: str, device_laps: list[dict]) -> dict:
    """Every lap source for the sport, each summarised (overall and per block); plus the stint
    ladder, the gate and the blocks (stretches between rests of 60 s or more)."""
    keys = LAP_SOURCES.get(sport, ("d1000", "device"))
    sets: dict[str, dict] = {}
    gate = None
    bl, rs = find_blocks(s), find_rests(s)
    gapf = gap_factors(s) if sport in ("run", "walk") else None
    defs = stint_defs(s) if sport == "skate" else []
    v3 = smooth_speed(s) if defs else None
    stint_rows = {d["key"]: stints(s, d["threshold_kmh"], v3=v3) for d in defs}
    for key in keys:
        compare = "time"
        if key[0] == "d" and key[1:].isdigit():
            size = float(key[1:])
            if s.cd[-1] < size:
                continue
            rows, label = fixed_laps(s, sport, size, gapf), (f"{size / 1000:g} km" if size >= 1000 else f"{size:.0f} m")
        elif key == "gate":
            rows, gate = gate_laps(s)
            label = "Gate"
        elif key == "device":
            rows = [{k: r.get(k) for k in ("n", "start_s", "time_s", "distance_m", "speed_kmh", "pace_s_km", "moving_s",
                                             "avg_hr", "max_hr")} | {"partial": False}
                    for r in device_lap_rows(s, device_laps, sport, None)]
            label, compare = "Device", "speed"
        else:
            d = key.split(":")[1]
            if d not in stint_rows:
                continue
            rows, label, compare = stints_as_laps(s, stint_rows[d]), "Stints", "speed"
        if key in ("device",) and len(rows) < 2:
            continue
        if not rows:
            continue
        if compare == "time" and key == "gate":
            compare = "time" if _similar([r["distance_m"] for r in rows]) else "speed"
        _tag_blocks(s, rows, bl, rs)
        spanning = [r for r in rows if r["rest_s"] and not key.startswith("stints")]
        rows = [r for r in rows if r not in spanning]  # laps that carry a rest in their time
        for r in rows:
            r.pop("rest_s", None)
        out = {"key": key, "label": label, "laps": rows, "spans_rest": len(spanning), **summarise(rows, compare=compare)}
        if len(bl) > 1:
            per = []
            for k in range(len(bl)):
                mine = [dict(r) for r in rows if r["block"] == k]
                sm = summarise(mine, compare=compare) if mine else None
                per.append({"block": k + 1, "n_laps": len([r for r in mine if not r["partial"]]),
                            "best_n": sm["best_n"] if sm else None,
                            "best": next((r["time_s"] if compare == "time" else r["speed_kmh"] for r in mine if sm and r["n"] == sm["best_n"]), None),
                            "mean": sm["mean"] if sm else None, "fade": sm["fade"] if sm else None, "cv_pct": sm["cv_pct"] if sm else None})
            out["by_block"] = per
        sets[key] = out
    return {"sources": list(sets), "sets": sets, "gate": gate, "blocks": block_rows(s, bl) if len(bl) > 1 else [],
            "rest_s": round(sum(r["time_s"] for r in rs)),
            "stints": {"defs": defs, "sets": stint_rows} if defs else None}


def _similar(dists: list[float]) -> bool:
    if len(dists) < 2:
        return True
    med = statistics.median(dists)
    return all(abs(d - med) <= 0.1 * med for d in dists)
