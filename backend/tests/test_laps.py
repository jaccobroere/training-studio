"""Lap engine, stints and heading (health/laps.py) on a synthetic 400 m oval with irregular
("smart") sampling."""

from __future__ import annotations

import math

import pytest

from health import laps as L
from health.activity_stats import analyse, prepare

R = 100 / math.pi  # 400 m oval: 100 m straights, half circles of radius 100/π


def oval_xy(d: float) -> tuple[float, float]:
    """First straight heads east (y = -R), the second west (y = +R)."""
    d %= 400
    if d < 100:
        return -50 + d, -R
    if d < 200:
        a = -math.pi / 2 + (d - 100) / R
        return 50 + R * math.cos(a), R * math.sin(a)
    if d < 300:
        return 50 - (d - 200), R
    a = math.pi / 2 + (d - 300) / R
    return -50 + R * math.cos(a), R * math.sin(a)


def oval(speed, total_s: float, *, steps=(1, 2, 3, 1, 3), hr=None, pos=oval_xy) -> dict:
    """Samples every 1–3 s (a repeating irregular pattern). speed(t, d) in m/s; distance is
    integrated second by second as the device would, positions follow the distance."""
    t, d, v, lat, lon, h = [], [], [], [], [], []
    clock, dist, k = 0.0, 0.0, 0
    kx = 111_195.0 * math.cos(math.radians(52.35))
    while clock <= total_s:
        x, y = pos(dist)
        t.append(clock)
        d.append(dist)
        v.append(speed(clock, dist))
        lat.append(52.35 + y / 111_195.0)
        lon.append(4.94 + x / kx)
        h.append(hr(clock) if hr else None)
        step = steps[k % len(steps)]
        k += 1
        for j in range(step):
            dist += speed(clock + j, dist)
        clock += step
    out = {"t": t, "dist": d, "speed": v, "lat": lat, "lon": lon}
    if hr:
        out["hr"] = h
    return out


def steady(v: float):
    return lambda t, d: v


def test_sampling_reports_smart_recording():
    smp = L.sampling(prepare(oval(steady(7.0), 600), "skate"))
    assert smp["median_s"] == 2 and smp["smart"] is True
    assert L.sampling(prepare(oval(steady(7.0), 600, steps=(1,)), "skate"))["smart"] is False


def test_fixed_400m_laps_interpolate_between_irregular_samples():
    s = prepare(oval(steady(7.0), 4000 / 7 + 30), "skate")
    full = [x for x in L.fixed_laps(s, "skate", 400.0) if not x["partial"]]
    assert len(full) == 10
    assert all(x["time_s"] == pytest.approx(400 / 7, abs=0.15) for x in full)  # 57.14 s, not a whole-sample time


def test_gate_finds_the_loop_and_splits_on_each_crossing():
    s = prepare(oval(steady(7.0), 12 * 400 / 7), "skate")
    laps, gate = L.gate_laps(s)
    assert gate is not None and gate["passes"] >= 11
    assert len(laps) >= 10
    assert all(x["time_s"] == pytest.approx(400 / 7, abs=0.6) for x in laps)
    assert all(x["distance_m"] == pytest.approx(400, abs=5) for x in laps)


def test_gate_counts_only_the_main_direction():
    flip = 8 * 400  # 8 laps one way, then 4 the other way round

    def pos(d):
        return oval_xy(d) if d < flip else oval_xy(-(d - flip))

    s = prepare(oval(steady(7.0), 12 * 400 / 7, pos=pos), "skate")
    laps, gate = L.gate_laps(s)
    assert gate is not None
    assert 6 <= len(laps) <= 7  # only crossings on the forward laps count
    assert all(x["distance_m"] == pytest.approx(400, abs=8) for x in laps)


def test_no_gate_without_a_loop():
    def line(d):
        return d, 0.0

    s = prepare(oval(steady(5.0), 900, pos=line), "skate")
    assert L.gate_laps(s) == ([], None)


def test_lap_summary_best_delta_cv_and_fade():
    # every lap 1 s slower than the one before: 50, 51, 52, …
    laps = [{"n": k + 1, "time_s": 50.0 + k, "distance_m": 400.0, "speed_kmh": 400 / (50 + k) * 3.6,
             "moving_s": 50.0 + k, "partial": False} for k in range(8)]
    laps.append({"n": 9, "time_s": 20.0, "distance_m": 150.0, "speed_kmh": 27.0, "moving_s": 20.0, "partial": True})
    sm = L.summarise(laps, compare="time")
    assert sm["best_n"] == 1 and laps[3]["delta"] == 3.0 and laps[-1]["delta"] is None
    assert sm["n_steady"] == 8 and sm["fade"] == pytest.approx(1.0) and sm["cv_pct"] == pytest.approx(4.6, abs=0.1)
    laps[2]["moving_s"] = 30.0  # a lap with a long stop is not steady: out of CV and fade
    assert L.summarise(laps, compare="time")["n_steady"] == 7


SPRINTS = [(300, 320), (600, 630), (900, 940), (1200, 1210)]  # the last is too short (10 s)


def sprint_speed(t, d):
    return 9.0 if any(a <= t < b for a, b in SPRINTS) else 6.5


def sprint_hr(t):
    """140 at rest; +1 bpm per second of sprint; afterwards falls 0.4 bpm/s back to 140."""
    done = [(a, b) for a, b in SPRINTS if a <= t]
    if not done:
        return 140.0
    a, b = done[-1]
    if t < b:
        return 140.0 + (t - a)
    return max(140.0, 140.0 + (b - a) - 0.4 * (t - b))


def test_stints_two_definitions_peak_hr_rise_and_recovery():
    lp = analyse(oval(sprint_speed, 1500, steps=(1,), hr=sprint_hr), "skate")["lapsets"]
    defs = {d["key"]: d for d in lp["stints"]["defs"]}
    assert defs["abs"]["threshold_kmh"] == 20.0
    assert defs["rel"]["threshold_kmh"] == pytest.approx(6.5 * 3.6 * 1.15, abs=0.1)
    assert len(lp["stints"]["sets"]["abs"]) == 1  # cruising at 23.4 km/h is one long stint above 20
    rel = lp["stints"]["sets"]["rel"]
    assert [x["time_s"] for x in rel] == pytest.approx([20, 30, 40], abs=2.5)
    third = rel[2]
    assert third["peak_kmh"] == pytest.approx(32.4, abs=0.2) and third["speed_kmh"] == pytest.approx(32.4, abs=1.5)
    assert third["hr_rise"] == pytest.approx(40, abs=3) and third["hr_drop_60"] == pytest.approx(24, abs=3)
    assert "stints:rel" in lp["sources"] and lp["sets"]["stints:rel"]["compare"] == "speed"


def test_stints_work_on_smart_sampling():
    rel = analyse(oval(sprint_speed, 1500, hr=sprint_hr), "skate")["lapsets"]["stints"]["sets"]["rel"]
    assert len(rel) == 3 and all(x["peak_kmh"] > 30 for x in rel)
    # samples 4 s apart: contiguous fast samples are one stint, not a stint per sample
    sparse = analyse(oval(sprint_speed, 1500, steps=(4,), hr=sprint_hr), "skate")["lapsets"]["stints"]["sets"]
    assert len(sparse["abs"]) == 1 and len(sparse["rel"]) == 3


def test_lap_sources_per_sport():
    skate = analyse(oval(steady(7.0), 900), "skate")["lapsets"]
    assert skate["sources"][:4] == ["d400", "d200", "d1000", "gate"] and skate["gate"] is not None
    run = analyse(oval(steady(3.5), 900), "run")["lapsets"]
    assert run["sources"] == ["d1000", "d400"] and run["stints"] is None


def test_heading_separates_the_straights():
    def speed(t, d):  # quick with the wind going east, slow into it going west
        x, y = oval_xy(d)
        return 8.0 if y < -R + 1 else 6.0 if y > R - 1 else 7.0

    hd = analyse(oval(speed, 1800, steps=(1,)), "skate")["heading"]
    sec = {x["dir"]: x for x in hd["sectors"]}
    assert sec["E"]["speed_kmh"] == pytest.approx(28.8, abs=0.8) and sec["W"]["speed_kmh"] == pytest.approx(21.6, abs=0.8)
    assert hd["spread_kmh"] >= 6


# A block-structured session: three 8 min blocks (7.0, 6.6, 6.2 m/s) split by 4 min standing rests.
REST_AT = [(480, 720), (1200, 1440)]


def blocky_speed(t, d):
    if any(a <= t < b for a, b in REST_AT):
        return 0.0
    return 7.0 if t < 480 else 6.6 if t < 1200 else 6.2


def blocky():
    return analyse(oval(blocky_speed, 1920, steps=(2,), hr=lambda t: 140.0), "skate")


def test_blocks_split_at_rests_and_report_them():
    ls = blocky()["lapsets"]
    bl = ls["blocks"]
    assert len(bl) == 3 and bl[0]["rest_before_s"] == 0
    assert bl[1]["rest_before_s"] == pytest.approx(240, abs=4) and bl[2]["rest_before_s"] == pytest.approx(240, abs=4)
    assert [b["speed_kmh"] for b in bl] == pytest.approx([25.2, 23.8, 22.3], abs=0.6)
    assert ls["rest_s"] == pytest.approx(480, abs=6)


def test_fixed_laps_restart_after_a_rest():
    d400 = blocky()["lapsets"]["sets"]["d400"]
    laps = d400["laps"]
    assert max(x["time_s"] for x in laps if not x["partial"]) < 70  # no lap carries a 4 min rest
    assert {x["block"] for x in laps} == {0, 1, 2}
    full = [x for x in laps if not x["partial"] and x["block"] == 0]
    assert len(full) == 8 and all(x["time_s"] == pytest.approx(400 / 7, abs=0.4) for x in full)
    assert d400["by_block"][0]["n_laps"] == 8 and d400["by_block"][2]["mean"] > d400["by_block"][0]["mean"]  # slower block, longer laps
    assert d400["by_block"][0]["best_n"] is not None


def test_best_efforts_never_span_a_rest():
    best = blocky()["best"]
    secs = [b["secs"] for b in best["time"]]
    assert 60.0 in secs and 300.0 in secs
    assert 1200.0 not in secs and 3600.0 not in secs  # no block is that long: left out, not padded with rests
    assert best["rest_cut"] and best["blocks"] == 3 and best["longest_block_s"] == pytest.approx(480, abs=4)
    five = next(b for b in best["time"] if b["secs"] == 300.0)
    assert five["speed_kmh"] == pytest.approx(25.2, abs=0.6)  # block 1, not a window averaged with rests
    assert 5000.0 not in [b["distance_m"] for b in best["distance"]]  # 9.2 km in all, but no block holds 5 km
    km = next(b for b in best["distance"] if b["distance_m"] == 1000.0)
    assert km["time_s"] == pytest.approx(1000 / 7, abs=2)
    assert all(b["end_s"] <= 482 or b["start_s"] >= 718 for b in best["time"])


def test_a_session_without_rests_has_no_block_rows():
    st = analyse(oval(steady(7.0), 900), "skate")
    assert st["lapsets"]["blocks"] == [] and st["best"]["rest_cut"] is False
    assert "by_block" not in st["lapsets"]["sets"]["d400"]
