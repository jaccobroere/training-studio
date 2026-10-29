"""Per-activity analysis (health/activity_stats.py) on deterministic synthetic streams, and the
/api/health/activity endpoints (route geometry in metres and degrees from FIT, lazy upgrade of
older streams)."""

from __future__ import annotations

import math
import random
from datetime import datetime

import pytest

from health import activity_stats as A
from test_garmin import upload


def stream(parts: list[tuple[int, float]], *, hr=None, pow_=None, alt=None, lat0: float | None = None, gap_after: dict | None = None) -> dict:
    """1 Hz samples from (seconds, speed m/s) parts; `gap_after` = {sample index: pause seconds}."""
    t, v, d = [], [], []
    clock, dist = 0.0, 0.0
    for secs, sp in parts:
        for _ in range(secs):
            t.append(clock)
            v.append(sp)
            d.append(dist)
            clock += 1 + (gap_after or {}).get(len(t) - 1, 0)
            dist += sp
    out = {"t": t, "speed": v, "dist": d}
    n = len(t)
    if hr is not None:
        out["hr"] = [hr(i) for i in range(n)]
    if pow_ is not None:
        out["pow"] = [pow_(i) for i in range(n)]
    if alt is not None:
        out["alt"] = [alt(d[i]) for i in range(n)]
    if lat0 is not None:  # due north
        out["lat"] = [lat0 + x / 111_195.0 for x in d]
        out["lon"] = [5.0] * n
    return out


def test_steady_run_totals_splits_and_best_efforts():
    st = A.analyse(stream([(1001, 4.0)]), "run")
    tot = st["totals"]
    assert tot["distance_m"] == 4000 and tot["moving_s"] == 1000 and tot["stopped_s"] == 0 and tot["stops"] == 0
    assert tot["avg_moving"] == {"speed_kmh": 14.4, "pace_s_km": 250.0} and tot["max_speed_kmh"] == 14.4
    sp = st["splits"]
    assert sp["size_m"] == 1000 and [s["time_s"] for s in sp["splits"]] == [250.0] * 4
    assert all(s["pace_s_km"] == 250.0 and not s["partial"] for s in sp["splits"])
    best = {b["distance_m"]: b["time_s"] for b in st["best"]["distance"]}
    assert best == {400.0: 100.0, 1000.0: 250.0}  # 5 km is longer than the run: left out
    assert "No heart rate in this recording." in st["notes"] and st["zones"] is None


def test_ride_splits_every_5km_and_last_partial_split():
    st = A.analyse(stream([(1801, 10.0)]), "ride")  # 18 km
    sp = st["splits"]
    assert sp["size_m"] == 5000 and len(sp["splits"]) == 4
    last = sp["splits"][-1]
    assert last["partial"] and last["distance_m"] == 3000 and last["speed_kmh"] == 36.0
    assert [b["distance_m"] for b in st["best"]["distance"]] == [1000.0, 5000.0, 10000.0]
    assert [b["secs"] for b in st["best"]["time"]] == [10.0, 30.0, 60.0, 300.0, 1200.0]


def test_stops_and_pauses_are_not_moving_time():
    # 300 s rolling, 60 s standing, the watch paused for 120 s, 300 s rolling
    s = stream([(300, 5.0), (60, 0.0), (301, 5.0)], gap_after={359: 120})
    tot = A.analyse(s, "skate")["totals"]
    # An interval counts by the speed at its end: the first rolling second after the stop is paused.
    assert tot["elapsed_s"] == 780 and tot["moving_s"] == 599
    assert tot["stopped_s"] == 181 and tot["stops"] == 1  # standing + pause run together: one stop
    assert tot["avg_moving"]["speed_kmh"] == round(3000 / 599 * 3.6, 2) and tot["avg_elapsed"]["speed_kmh"] == round(3000 / 780 * 3.6, 2)


def test_skate_sprint_sets_max_speed_and_best_10s():
    st = A.analyse(stream([(600, 5.0), (30, 10.0), (601, 5.0)]), "skate")
    assert st["totals"]["max_speed_kmh"] == 36.0
    ten = next(b for b in st["best"]["time"] if b["secs"] == 10.0)
    assert ten["speed_kmh"] == 36.0 and 600 <= ten["start_s"] <= 620
    four = next(b for b in st["best"]["distance"] if b["distance_m"] == 400.0)
    assert four["time_s"] == 50.0  # 300 m at 10 m/s + 100 m at 5 m/s


def test_hr_zones_are_shares_of_the_reference():
    s = stream([(201, 3.0)], hr=lambda i: 100 if i <= 100 else 150)
    z = A.analyse(s, "run", hr_ref=200)["zones"]
    assert z["ref_bpm"] == 200 and [x["lo_bpm"] for x in z["zones"]] == [100, 120, 140, 160, 180]
    secs = {x["zone"]: x["s"] for x in z["zones"]}
    assert secs == {1: 100, 2: 0, 3: 100, 4: 0, 5: 0} and z["below_s"] == 0
    assert A.analyse(s, "run")["zones"] is None  # no reference, no zones


def test_power_np_vi_work_and_best_power():
    steady = A.analyse(stream([(1201, 9.0)], pow_=lambda i: 200), "ride")["totals"]
    assert steady["avg_power"] == 200 and steady["np"] == 200 and steady["vi"] == 1.0 and steady["work_kj"] == 240
    surges = A.analyse(stream([(1201, 9.0)], pow_=lambda i: 400 if (i // 60) % 2 else 0), "ride")
    t = surges["totals"]
    assert t["avg_power"] == pytest.approx(200, abs=1) and t["np"] > 250 and t["vi"] > 1.2
    one_min = next(b for b in surges["best"]["time"] if b["secs"] == 60.0)
    assert one_min["power"] == 400


def test_decoupling_compares_halves_of_moving_time():
    s = stream([(2401, 3.0)], hr=lambda i: 140 if i < 1200 else 154)
    dc = A.analyse(s, "ride")["decoupling"]
    assert dc["available"] and dc["basis"] == "speed" and dc["hr_drift_bpm"] == 14.0
    assert dc["pct"] == pytest.approx((1 - 140 / 154) * 100, abs=0.2)
    short = A.analyse(stream([(600, 3.0)], hr=lambda i: 140), "ride")["decoupling"]
    assert short["available"] is False


# ------------------------------------------------------------------ turns and steady blocks

def path_stream(parts: list[tuple[int, float, float]]) -> dict:
    """1 Hz samples along a path: (seconds, speed m/s, turn rate °/s). The heading starts north
    and turns by `rate` every second, so straight parts read a steady bearing and arcs a known
    heading turn rate."""
    t, v, d, lat, lon = [], [], [], [], []
    clock, dist, heading = 0.0, 0.0, 0.0
    la, lo = 52.0, 5.0
    for secs, sp, rate in parts:
        for _ in range(secs):
            t.append(clock)
            v.append(sp)
            d.append(dist)
            lat.append(la)
            lon.append(lo)
            clock += 1
            heading = (heading + rate) % 360
            dist += sp
            la += sp * math.cos(math.radians(heading)) / 111_195.0
            lo += sp * math.sin(math.radians(heading)) / (111_195.0 * math.cos(math.radians(la)))
    return {"t": t, "speed": v, "dist": d, "lat": lat, "lon": lon}


def test_turns_and_straights_from_a_circular_stream():
    # Six 80 s straights at 8 m/s, each followed by a 90° arc in 10 s at 6 m/s (9 °/s).
    turns = A.analyse(path_stream([(80, 8.0, 0.0), (10, 6.0, 9.0)] * 6), "skate")["turns"]
    assert turns["available"] is True and turns["n_turns"] == 6
    assert turns["straight"]["speed_kmh"] == pytest.approx(28.8, abs=0.2)
    assert turns["turn"]["speed_kmh"] == pytest.approx(21.6, abs=0.3)
    assert turns["loss_kmh"] == pytest.approx(7.2, abs=0.4)
    assert turns["turn"]["pct"] == pytest.approx(11, abs=1)
    assert turns["straight"]["pct"] + turns["turn"]["pct"] == 100
    assert turns["straight"]["s"] + turns["turn"]["s"] == pytest.approx(538, abs=3)


def test_turns_faster_than_straights_give_a_negative_loss():
    # 6 m/s straights, 9 m/s arcs: the turns carry more speed, so the difference is the other way.
    t = A.analyse(path_stream([(80, 6.0, 0.0), (10, 9.0, 9.0)] * 6), "skate")["turns"]
    assert t["available"] is True and t["n_turns"] == 6
    assert t["straight"]["speed_kmh"] == pytest.approx(21.6, abs=0.2)
    assert t["loss_kmh"] == pytest.approx(-10.8, abs=0.4)


def test_turns_need_a_gps_skate_with_enough_turning():
    ring = path_stream([(80, 8.0, 0.0), (10, 6.0, 9.0)] * 6)
    assert A.analyse(ring, "run")["turns"] is None  # skate only
    no_gps = {k: v for k, v in ring.items() if k not in ("lat", "lon")}
    assert A.analyse(no_gps, "skate")["turns"] is None
    assert A.analyse(path_stream([(80, 8.0, 0.0), (10, 6.0, 9.0)] * 2), "skate")["turns"] is None  # under 5 min
    assert A.analyse(path_stream([(600, 8.0, 0.0)]), "skate")["turns"] is None  # no turns


def test_steady_block_is_the_longest_steady_stretch():
    s = stream([(300, 4.0), (60, 0.0), (601, 5.0), (60, 0.0), (300, 4.5)], hr=lambda i: 140)
    b = A.analyse(s, "skate")["steady"]
    assert b["available"] is True and b["moving_s"] == 601 and b["distance_m"] == 3000  # the 10 min block
    assert b["start_s"] in (359.0, 360.0) and b["end_s"] == 960.0
    speed = round(b["distance_m"] / b["moving_s"] * 3.6, 2)
    assert b["ef"] == round(speed / 3.6 * 60 / 140, 4) and b["ef_unit"] == "m/beat" and b["basis"] == "speed"
    assert b["cv_pct"] <= 5 and abs(b["decoupling_pct"]) < 1 and b["hr_drift_bpm"] == 0


def test_steady_block_explains_when_there_is_none():
    # Every block is under 5 min: no candidate, so only the length it asks for comes back.
    stop_start = A.analyse(stream([(120, 4.0), (60, 0.0)] * 4, hr=lambda i: 140), "skate")["steady"]
    assert stop_start == {"available": False, "min_s": 300, "cv_pct": None}
    # One 10 min block that surges 4 / 8 m/s: it says how uneven the closest candidate was.
    surges = A.analyse(stream([(60, 4.0), (60, 8.0)] * 5, hr=lambda i: 140), "skate")["steady"]
    assert surges["available"] is False and surges["min_s"] == 300 and surges["cv_pct"] > 10
    no_hr = A.analyse(stream([(601, 5.0)]), "skate")["steady"]
    assert no_hr["available"] is True and no_hr["ef"] is None and no_hr["decoupling_pct"] is None


def test_steady_block_reports_the_lowest_cv_among_candidates():
    # Two long blocks, both too uneven: the gentler 4 / 5.4 m/s one is the figure the note quotes.
    s = stream([(60, 4.0), (60, 8.0)] * 5 + [(60, 0.0)] + [(60, 4.0), (60, 5.4)] * 5)
    u = A.analyse(s, "skate")["steady"]
    assert u["available"] is False and u["min_s"] == 300
    assert 10 < u["cv_pct"] < 20  # the 4 / 5.4 block, not the 4 / 8 one (over 30 %)


def test_steady_ef_and_decoupling_are_measured_on_that_block():
    # Two equal steady blocks; heart rate rises 20 bpm between them, so only the block's own
    # decoupling is flat while the whole-session figure shows the drift.
    s = stream([(601, 5.0), (60, 0.0), (601, 5.0)], hr=lambda i: 140 if i < 601 else 160)
    st = A.analyse(s, "skate")
    b = st["steady"]
    assert b["decoupling_pct"] == pytest.approx(0, abs=1) and b["hr_drift_bpm"] == 0
    assert st["decoupling"]["pct"] > 5 and st["decoupling"]["hr_drift_bpm"] == 20.0


def test_steady_ef_reuses_the_power_basis():
    b = A.analyse(stream([(601, 9.0)], pow_=lambda i: 210, hr=lambda i: 150), "ride")["steady"]
    assert b["basis"] == "power" and b["ef_unit"] == "W/bpm" and b["ef"] == round(210 / 150, 4)


def test_grade_adjusted_pace_and_elevation():
    assert A.minetti_factor(0) == 1.0 and A.minetti_factor(0.1) > 1.4 and A.minetti_factor(-0.1) < 1
    climb = stream([(1001, 3.0)], alt=lambda d: d * 0.05)  # 5 % up for 3 km
    st = A.analyse(climb, "run")
    tot = st["totals"]
    assert tot["gain_m"] == pytest.approx(150, abs=4) and tot["loss_m"] == 0
    assert tot["gap"]["pace_s_km"] < tot["avg_moving"]["pace_s_km"] * 0.85  # uphill: flat-equivalent is faster
    assert all(s["gap_s_km"] < s["pace_s_km"] for s in st["splits"]["splits"])
    rng = random.Random(4)
    noisy = stream([(1001, 3.0)], alt=lambda d: 10 + rng.uniform(-1, 1))
    assert A.analyse(noisy, "run")["totals"]["gain_m"] == 0  # noise inside the dead band never climbs
    assert A.analyse(stream([(300, 3.0)]), "ride")["totals"].get("gap") is None  # rides: no GAP


def test_device_laps_are_remeasured_from_the_stream():
    s = stream([(300, 4.0), (300, 5.0)], hr=lambda i: 130 if i < 300 else 160)
    laps = [{"start_s": 0, "elapsed_s": 300, "timer_s": 300, "distance_m": 1200, "avg_hr": None, "max_hr": None},
            {"start_s": 300, "elapsed_s": 299, "timer_s": 299, "distance_m": None, "avg_hr": 161, "max_hr": 165}]
    out = A.analyse(s, "skate", laps)["laps"]
    assert [x["n"] for x in out] == [1, 2]
    assert out[0]["distance_m"] == 1200 and out[0]["speed_kmh"] == 14.4 and out[0]["avg_hr"] == 130
    assert out[1]["distance_m"] == pytest.approx(1495, abs=5) and out[1]["avg_hr"] == 161  # the device's own figure wins


def test_route_is_relative_metres_plus_absolute_degrees_for_the_map():
    st = A.analyse(stream([(1001, 3.0)], lat0=52.0), "run")
    r = st["route"]
    x0, y0, x1, y1 = r["bbox"]
    assert abs(x1 - x0) <= 1 and y1 - y0 == pytest.approx(3000, abs=5)
    assert [m["n"] for m in r["marks"]] == [1, 2, 3] and r["mark_m"] == 1000
    assert all(abs(p[1]) < 1600 for p in r["points"]) and r["points"][-1][2] == 1000
    assert len(r["points"]) <= A.ROUTE_POINTS + 2
    # The map needs the same kept samples in degrees; 1:1 with the metres, near the test route.
    assert len(r["ll"]) == len(r["points"])
    lat0, lon0 = r["center"]
    assert lat0 == pytest.approx(52.0 + 1500 / 111_195, abs=1e-4) and lon0 == pytest.approx(5.0, abs=1e-4)
    assert all(52.0 <= la <= 52.03 and lo == pytest.approx(5.0, abs=1e-4) for la, lo in r["ll"])
    assert r["ll"][0][0] == pytest.approx(52.0, abs=1e-4) and r["ll"][-1][0] == pytest.approx(52.0 + 3000 / 111_195, abs=1e-4)
    assert [m["lat"] for m in r["marks"]] == pytest.approx([52.009, 52.018, 52.027], abs=1e-3)
    assert all(m["lon"] == pytest.approx(5.0, abs=1e-4) for m in r["marks"])
    assert A.analyse(stream([(100, 3.0)]), "run")["route"] is None


def test_route_ll_stays_aligned_across_a_recording_pause():
    # A 120 s hole in the recording: the trace keeps both sides, and ll keeps the same indexing.
    s = stream([(300, 3.0), (301, 3.0)], lat0=52.0, gap_after={299: 120})
    r = A.analyse(s, "run")["route"]
    ts = [p[2] for p in r["points"]]
    assert any(b - a > 60 for a, b in zip(ts, ts[1:]))
    assert len(r["ll"]) == len(r["points"]) and len(r["ll"]) > 10
    assert all(52.0 <= la <= 52.03 for la, _ in r["ll"])


def test_speed_histogram_and_unusable_streams():
    h = A.analyse(stream([(600, 5.0), (601, 7.0)]), "skate")["speed_hist"]
    assert h["step_kmh"] == 2.0 and sum(b["s"] for b in h["bins"]) == 1200
    assert A.analyse(None, "run") is None and A.analyse({"t": [0]}, "run") is None


# ------------------------------------------------------------------ endpoints

def _ride_fit() -> bytes:
    from garmin.demo_export import _fit, loop_route

    rng = random.Random(5)
    return _fit(datetime(2026, 9, 27, 8, 0), "cycling", [(900, 8.0, 135), (60, 12.0, 160), (600, 8.0, 140)], rng,
                route=loop_route(12000, 5), power=True)


def test_activity_endpoint_returns_stats_and_route_map_coordinates_without_stream_positions(client):
    run = upload(client, "ride_900000001.fit", _ride_fit())
    assert run["state"] == "done", run
    got = client.get("/api/health/activity").json()  # the latest analysed activity
    a, st = got["activity"], got["stats"]
    assert a["type"] == "ride" and st["sport"] == "ride"
    # The per-second stream still carries no positions (Data page's detail keeps them).
    assert "lat" not in a["stream"] and "lon" not in a["stream"] and {"t", "speed", "pow"} <= set(a["stream"])
    route = st["route"]
    assert route and len(route["points"]) > 50
    assert len(route["ll"]) == len(route["points"])
    assert 51 < route["center"][0] < 53 and route["center"][1] == pytest.approx(5.0, abs=1)
    assert all(51 < la < 53 for la, _ in route["ll"])
    assert route["marks"] and all(51 < m["lat"] < 53 and "lon" in m for m in route["marks"])
    assert st["totals"]["np"] and st["totals"]["avg_cad"] and st["splits"]["size_m"] == 5000
    assert st["zones"]["ref_bpm"] >= st["totals"]["max_hr"]
    assert client.get(f"/api/health/activity/{a['id']}").json()["stats"]["totals"] == st["totals"]
    assert client.get("/api/health/activity/nope").status_code == 404
    assert client.get("/api/health/activity", params={"type": "run"}).json() == {"activity": None, "stats": None}
    # The Data page's detail keeps positions (degrees) for the analysis datasets.
    full = client.get(f"/api/activities/{a['id']}").json()["stream"]
    assert 51 < next(x for x in full["lat"] if x is not None) < 53


def test_older_stream_is_upgraded_from_the_kept_fit(client):
    import db
    from garmin.store import load_stream, save_stream
    from models import Activity

    upload(client, "ride_900000002.fit", _ride_fit())
    with db.get_db().session() as s:
        a = s.get(Activity, "garmin:900000002")
        old = {k: v for k, v in load_stream(a.stream_path).items() if k not in ("lat", "lon", "v")}
        save_stream(a.id, old)  # as stored before positions were kept
    st = client.get("/api/health/activity/garmin:900000002").json()["stats"]
    assert st["route"] is not None
    with db.get_db().session() as s:
        again = load_stream(s.get(Activity, "garmin:900000002").stream_path)
    assert again["v"] == 2 and "lat" in again and len(again["lat"]) == len(old["t"])
    assert not math.isnan(st["totals"]["distance_m"])


def _skate_fit(day: int, cruise: float, hr: float, month: int = 9) -> bytes:
    from garmin.demo_export import _fit, oval_route

    return _fit(datetime(2026, month, day, 17, 0), "skating", [(1500, cruise, hr)], random.Random(day), route=oval_route())


def test_bests_period_vs_all_time_and_cache(client):
    upload(client, "skate_700000001.fit", _skate_fit(1, 7.5, 150, month=6))  # fast, but in June
    upload(client, "skate_700000002.fit", _skate_fit(20, 6.5, 140))
    b = client.get("/api/health/bests", params={"type": "skate", "days": 28}).json()
    assert b["n_all"] == 2 and b["n_period"] == 1
    four = next(d for d in b["distances"] if d["distance_m"] == 400.0)
    assert four["all"]["id"] == "garmin:700000001" and four["period"]["id"] == "garmin:700000002"
    assert four["all"]["time_s"] < four["period"]["time_s"]
    w = next(x for x in b["windows"] if x["secs"] == 60.0)
    assert w["all"]["speed_kmh"] > w["period"]["speed_kmh"] > 20
    import db

    assert len(list((db.data_dir() / "derived").glob("*.json"))) == 2  # cached per activity
    assert client.get("/api/health/bests", params={"type": "skate", "days": 28}).json()["windows"] == b["windows"]
    assert client.get("/api/health/bests", params={"type": "nope"}).status_code == 422


def test_efficiency_marks_steady_sessions(client):
    upload(client, "skate_700000003.fit", _skate_fit(10, 6.5, 140))
    upload(client, "skate_700000004.fit", _skate_fit(24, 6.8, 139))
    upload(client, "skate_700000005.fit", _skate_fit(26, 7.6, 182))  # near max: not steady
    e = client.get("/api/health/efficiency", params={"type": "skate"}).json()
    assert e["n"] == 3 and e["n_steady"] == 2 and e["unit"] == "m/beat"
    by = {p["id"]: p for p in e["points"]}
    assert by["garmin:700000004"]["ef"] > by["garmin:700000003"]["ef"]  # faster at the same HR
    assert not by["garmin:700000005"]["steady"]
    assert e["monthly"] == [{"month": "2026-09", "n": 2, "ef": e["monthly"][0]["ef"], "decoupling_pct": e["monthly"][0]["decoupling_pct"]}]
    assert e["monthly"][0]["decoupling_pct"] is not None


def test_type_override_changes_the_analysis_survives_resync_and_undoes(client):
    from tests.conftest import ok, post

    upload(client, "skate_700000010.fit", _skate_fit(12, 6.8, 140))
    aid = "garmin:700000010"

    def view():
        got = client.get(f"/api/health/activity/{aid}").json()
        return got["activity"], got["stats"]

    a, st = view()
    assert a["type"] == "skate" and a["type_override"] is None and a["device_type"] == "skate"
    assert st["lapsets"]["stints"] is not None and "d400" in st["lapsets"]["sets"]

    ch = ok(client, [{"op": "update_activity_annotations", "id": aid, "type_override": "run"}])
    a, st = view()
    assert a["type"] == "run" and a["type_override"] == "run" and a["device_type"] == "skate"
    assert st["sport"] == "run" and st["lapsets"]["stints"] is None and "d1000" in st["lapsets"]["sets"]

    upload(client, "skate_700000010.fit", _skate_fit(12, 6.8, 140))  # the same recording synced again
    assert view()[0]["type"] == "run"

    client.post(f"/api/changes/{ch['change_id']}/undo", json={})
    assert view()[0]["type"] == "skate"

    ok(client, [{"op": "update_activity_annotations", "id": aid, "type_override": "walk"}])
    ok(client, [{"op": "update_activity_annotations", "id": aid, "type_override": None}])  # reset to the device's type
    a, _ = view()
    assert a["type"] == "skate" and a["type_override"] is None

    assert post(client, [{"op": "update_activity_annotations", "id": aid, "type_override": "nope"}]).status_code == 422


def test_type_override_is_for_recordings_not_hand_logged_activities(client):
    from tests.conftest import ok, post

    ok(client, [{"op": "log_activity", "id": "manual:swim1", "title": "Swim", "type": "swim", "date": "2026-09-20"}])
    r = post(client, [{"op": "update_activity_annotations", "id": "manual:swim1", "type_override": "run"}])
    assert r.json()["code"] == "not_recorded"
    ok(client, [{"op": "update_activity_annotations", "id": "manual:swim1", "type": "run"}])  # a manual activity's own type


def test_garmin_sync_does_not_overwrite_an_overridden_type(client):
    import db
    from garmin.store import upsert_activity
    from models import Activity
    from tests.conftest import ok

    upload(client, "skate_700000011.fit", _skate_fit(13, 6.8, 140))
    ok(client, [{"op": "update_activity_annotations", "id": "garmin:700000011", "type_override": "ride"}])
    with db.get_db().session() as s:
        upsert_activity(s, {"id": "garmin:700000011", "sport": "other", "name": "Renamed by Garmin"}, None)
        s.commit()
        a = s.get(Activity, "garmin:700000011")
        assert a.sport == "ride" and a.name == "Renamed by Garmin"


def _both_view(client, sport: str, s: dict, aid: str) -> tuple[dict, dict]:
    """One stream read both ways: the activity payload and the Health trend's cached card."""
    from datetime import date

    import db
    from garmin.store import save_stream
    from health.derived import card
    from models import Activity

    with db.get_db().session() as sess:
        sess.add(Activity(id=aid, source="garmin", source_id=aid, sport=sport, name=aid,
                          start_utc=datetime(2026, 9, 20, 9), local_date=date(2026, 9, 20),
                          stream_path=save_stream(aid, s)))
        sess.commit()
        return A.analyse(s, sport), card(sess, sess.get(Activity, aid))


def test_efficiency_factor_parity_with_the_health_card(client):
    """The activity's EF is the Health trend's number: same stream, same rounding, same basis."""
    climb = stream([(1801, 3.0)], hr=lambda i: 150, alt=lambda d: d * 0.05)
    st, c = _both_view(client, "run", climb, "garmin:ef-run")
    assert st["ef"]["basis"] == "gap" and st["ef"]["unit"] == "m/beat"
    assert st["ef"]["value"] == c["ef"] == round(c["speed_kmh"] / 3.6 * 60 / 150, 4)

    ride = stream([(1801, 9.0)], hr=lambda i: 150, pow_=lambda i: 210)
    st, c = _both_view(client, "ride", ride, "garmin:ef-ride")
    assert st["ef"] == {"value": round(210 / 150, 4), "unit": "W/bpm", "basis": "power"}
    assert (st["ef"]["value"], st["ef"]["unit"], c["basis"]) == (c["ef"], c["ef_unit"], "power")

    skate = stream([(1201, 5.0)], hr=lambda i: 140)
    st, c = _both_view(client, "skate", skate, "garmin:ef-skate")
    assert st["ef"] == {"value": round(18.0 / 3.6 * 60 / 140, 4), "unit": "m/beat", "basis": "speed"}
    assert (st["ef"]["value"], st["ef"]["unit"]) == (c["ef"], c["ef_unit"])


def test_efficiency_factor_needs_heart_rate(client):
    st, c = _both_view(client, "run", stream([(1201, 4.0)]), "garmin:ef-nohr")
    assert st["ef"] is None and c["ef"] is None and c["ef_unit"] is None
