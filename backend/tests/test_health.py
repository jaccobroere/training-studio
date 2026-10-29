"""Health: the fixed overview's data endpoints (acceptance A19). Layouts are gone (slice 5)."""

from __future__ import annotations

import io
import json
import zipfile

from test_garmin import upload


def _export(days: dict[str, dict]) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        z.writestr("UDSFile.json", json.dumps([{"calendarDate": d, **v} for d, v in days.items()]))
        z.writestr("hrv.json", json.dumps([{"hrvSummary": {"calendarDate": d, "lastNightAvg": v["hrv"]}}
                                           for d, v in days.items() if "hrv" in v]))
    return out.getvalue()


def test_missing_night_is_a_gap_not_zero(client):  # A19
    days = {f"2026-09-{d:02d}": {"restingHeartRate": 48, "totalSteps": 9000, "hrv": 60 + d % 5} for d in range(1, 29)}
    days.pop("2026-09-10")  # not worn
    days["2026-09-11"] = {"restingHeartRate": 47, "totalSteps": 0}  # steps 0 but HR → worn, real zero? kept
    upload(client, "e.zip", _export(days))
    c = client.get("/api/health/daily/hrv_ms", params={"start": "2026-09-01", "end": "2026-09-28"}).json()
    pts = dict(c["points"])
    assert pts["2026-09-10"] is None and pts["2026-09-11"] is None  # absent, not 0
    assert c["missing"] == 2 and ["2026-09-10", "2026-09-11"] in c["gaps"]
    assert c["stats"]["n"] == 26 and c["baseline"][0][1] is None  # baseline unavailable at first
    assert c["baseline"][-1][1] is not None  # …available once 14 prior days exist
    steps = dict(client.get("/api/health/daily/steps", params={"start": "2026-09-01", "end": "2026-09-28"}).json()["points"])
    assert steps["2026-09-10"] is None
    assert client.get("/api/health/daily/nope").status_code == 404


def test_overview(client):
    days = {f"2026-09-{d:02d}": {"restingHeartRate": 45 + d % 4, "hrv": 70 - d % 4} for d in range(1, 30)}
    upload(client, "e.zip", _export(days))
    o = client.get("/api/health/overview").json()
    assert (o["start"], o["end"]) == ("2026-09-03", "2026-09-30") and o["data_through"] == "2026-09-29"
    hrv = next(t for t in o["tiles"] if t["metric"] == "hrv_ms")
    assert hrv["latest"] == {"day": "2026-09-29", "value": 69.0} and hrv["baseline"]["mean"] is not None
    assert hrv["better"] == "up" and len(hrv["points"]) == 28 and hrv["delta"] is not None
    assert o["load"]["week_monday"] == "2026-09-28" and o["recent_activities"] == []
    assert [m["key"] for m in client.get("/api/health/metrics").json()][:2] == ["hrv_ms", "hrv_weekly_ms"]


def test_weekly_volume_keeps_planned_and_actual_apart(seeded):
    client = seeded
    client.post("/api/changes", json={"ops": [{"op": "log_workout", "workout_id": "w-easy", "distance_km": 7.5}]})
    w = client.get("/api/health/volume", params={"type": "run", "start": "2026-09-28", "end": "2026-10-04"}).json()
    wk = w["weeks"][0]
    assert wk["planned_km"] == 24 and wk["actual_km"] == 7.5
    load = client.get("/api/health/load", params={"days": 7}).json()
    assert load["weeks"][0]["run"] > 0 or load["weeks"][0]["run"] == 0
    acts = client.get("/api/health/activities", params={"type": "run"}).json()
    assert acts["n"] == 1 and acts["activities"][0]["distance_km"] == 7.5
    assert client.get("/api/health/run").json() == {"activity": None}  # no run with a stream yet
    assert client.get("/api/health/volume", params={"type": "bogus"}).status_code == 422


def test_every_endpoint_answers_on_an_empty_account(client):
    for path in ("overview", "metrics", "daily/rhr_bpm", "sleep", "load", "energy", "volume", "activities", "run"):
        r = client.get(f"/api/health/{path}")
        assert r.status_code == 200, (path, r.text)
    assert client.get("/api/health/sections").status_code == 404  # layouts are gone


def _activities(rows: list[tuple[int, str, str, int, int | None]]) -> bytes:
    """(id, garmin type, local day, minutes, calories|None) → an export archive."""
    from datetime import datetime
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        items = []
        for aid, typ, day, mins, kcal in rows:
            ms = int(datetime.fromisoformat(f"{day}T10:00:00+00:00").timestamp() * 1000)
            a = {"activityId": aid, "activityType": typ, "name": typ, "startTimeGmt": ms,
                 "startTimeLocal": ms + 2 * 3600_000, "duration": mins * 60_000, "distance": 5_000_00}
            if kcal is not None:
                a["calories"] = kcal
            items.append(a)
        z.writestr("DI_CONNECT/DI-Connect-Fitness/a_summarizedActivities.json", json.dumps([{"summarizedActivitiesExport": items}]))
    return out.getvalue()


def test_energy_counts_only_sessions_with_calories(client):
    upload(client, "a.zip", _activities([
        (1, "running", "2026-09-29", 50, 600), (2, "running", "2026-10-01", 30, 350),
        (3, "cycling", "2026-10-02", 90, 800), (4, "running", "2026-10-03", 40, None)]))
    e = client.get("/api/health/energy", params={"start": "2026-09-28", "end": "2026-10-04"}).json()
    assert e["n"] == 3 and e["without"] == 1  # the one without a figure is reported, not counted as 0
    assert e["sports"][0] == "run" and e["by_sport"][0]["kcal"] == 950 and e["by_sport"][0]["kcal_per_h"] == 712
    assert e["weeks"] == [{"monday": "2026-09-28", "run": 950, "ride": 800}]
    assert sum(r["kcal"] for r in e["by_sport"]) == sum(x["kcal"] for x in e["sessions"]) == 1750
    assert client.get("/api/health/energy", params={"days": 3}).status_code == 422
