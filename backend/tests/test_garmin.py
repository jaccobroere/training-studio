"""Garmin ingestion and reconciliation (acceptance A04, A17, A18, A29 for recordings)."""

from __future__ import annotations

import io
import json
import random
import zipfile
from datetime import date, datetime

import pytest

from garmin.demo_export import _fit, build


def upload(client, name: str, data: bytes):
    r = client.post("/api/garmin/upload", files={"file": (name, data, "application/octet-stream")})
    assert r.status_code == 200, r.text
    from jobs import worker

    assert worker.run_next() == r.json()["id"]
    return client.get(f"/api/imports/{r.json()['id']}").json()


@pytest.fixture(scope="module")
def small_export() -> bytes:
    from datetime import date

    return build(days=14, end=date(2026, 9, 28), with_fit=False)


def test_archive_import_and_idempotent_reimport(client, small_export):  # A17
    run = upload(client, "export.zip", small_export)
    assert run["state"] == "done", run
    rep = run["report"]
    assert rep["demo"] is True and rep["files"]["failed"] == 0
    assert rep["records"]["rhr_bpm"]["new"] == 14 and rep["records"]["activities"]["new"] > 5
    assert rep["records"]["hrv_ms"] == {
        "new": 14,
        "updated": 0,
        "same": 0,
    }  # wrappers not double-counted
    assert "DI_CONNECT/DI-Connect-User/user_profile.json" in rep["unsupported"]
    n_act = client.get("/api/garmin/status").json()["activities"]["n"]
    again = upload(client, "export-again.zip", small_export)
    rec = again["report"]["records"]
    assert rec["rhr_bpm"] == {"new": 0, "updated": 0, "same": 14}
    assert rec["activities"]["new"] == 0
    assert client.get("/api/garmin/status").json()["activities"]["n"] == n_act  # no duplicates


def test_changed_source_record_updates_in_place(client, small_export):
    upload(client, "a.zip", small_export)
    zin = zipfile.ZipFile(io.BytesIO(small_export))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        for info in zin.infolist():
            data = zin.read(info)
            if info.filename.endswith("UDSFile_demo.json"):
                days = json.loads(data)
                days[-1]["restingHeartRate"] = 99
                data = json.dumps(days).encode()
            z.writestr(info.filename, data)
    run = upload(client, "b.zip", out.getvalue())
    assert run["report"]["records"]["rhr_bpm"] == {"new": 0, "updated": 1, "same": 13}


def test_malformed_archive_is_partial_not_fatal(client):  # A18
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        z.writestr("DI_CONNECT/x/broken.json", "{not json")
        z.writestr("DI_CONNECT/x/garbage.fit", b"\x00\x01nope")
        z.writestr(
            "DI_CONNECT/x/UDSFile_ok.json",
            json.dumps(
                [{"calendarDate": "2026-09-01", "restingHeartRate": 48, "totalSteps": 9000}]
            ),
        )
        z.writestr("readme.pdf", b"%PDF")
    run = upload(client, "odd.zip", out.getvalue())
    assert run["state"] == "partial"
    rep = run["report"]
    assert rep["files"] == {"parsed": 1, "unsupported": 1, "duplicate": 0, "failed": 2}
    assert any("broken.json" in e for e in rep["errors"]) and any(
        "garbage.fit" in e for e in rep["errors"]
    )
    assert client.get("/api/garmin/status").json()["coverage"][0]["metric"] in ("rhr_bpm", "steps")
    bad = upload(client, "notazip.zip", b"this is not a zip")
    assert bad["state"] == "failed" and bad["report"]["errors"]
    assert client.get("/api/week/2026-09-28").status_code == 200  # app unaffected


def test_rejects_other_file_types(client):
    r = client.post(
        "/api/garmin/upload", files={"file": ("x.exe", b"MZ", "application/octet-stream")}
    )
    assert r.status_code == 422


def test_fit_upload_has_streams_laps_and_local_date(client):  # A29 for recordings
    rng = random.Random(1)
    # 22:30 UTC on 24 Oct 2026 = 00:30 CEST on 25 Oct (the night DST ends): owns the 25th.
    data = _fit(
        datetime(2026, 10, 24, 22, 30), "running", [(90, 3.0, 140), (60, 4.0, 165)], rng, [90]
    )
    run = upload(client, "night_123456789.fit", data)
    assert run["state"] == "done", run
    acts = client.get("/api/activities", params={"start": "2026-10-24", "end": "2026-10-26"}).json()
    assert len(acts) == 1 and acts[0]["local_date"] == "2026-10-25" and acts[0]["type"] == "run"
    detail = client.get(f"/api/activities/{acts[0]['id']}").json()
    assert detail["stream_points"]["stored"] == 150 and len(detail["laps"]) == 2
    assert {"t", "hr", "speed", "dist", "alt", "cad"} <= set(detail["stream"])


def _week(client):
    return client.get("/api/week/2026-09-28").json()


def _workout(client, wid):
    return next(w for d in _week(client)["days"] for w in d["workouts"] if w["id"] == wid)


def _run_export(date_: str, km: float, hour_utc: int = 16, ids=(555,)) -> bytes:
    start = int(datetime.fromisoformat(f"{date_}T{hour_utc:02d}:00:00+00:00").timestamp() * 1000)
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        z.writestr(
            "DI_CONNECT/DI-Connect-Fitness/a_summarizedActivities.json",
            json.dumps(
                [
                    {
                        "summarizedActivitiesExport": [
                            {
                                "activityId": aid,
                                "activityType": "running",
                                "name": "Run",
                                "startTimeGmt": start + i * 3600_000,
                                "startTimeLocal": start + i * 3600_000 + 2 * 3600 * 1000,
                                "duration": 3000 * 1000,
                                "distance": km * 100_000,
                            }
                            for i, aid in enumerate(ids)
                        ]
                    }
                ]
            ),
        )
    return out.getvalue()


def test_manual_done_then_import_merges_into_the_recording(seeded):  # A04
    client = seeded
    r = client.post(
        "/api/changes",
        json={
            "ops": [{"op": "log_workout", "workout_id": "w-easy", "rpe": 3, "notes": "legs fine"}]
        },
    )
    assert r.status_code == 200
    assert _workout(client, "w-easy")["activities"][0]["source"] == "manual"
    run = upload(client, "run.zip", _run_export("2026-09-29", 8.4))
    assert run["report"]["autolinked"]
    w = _week(client)
    easy = _workout(client, "w-easy")
    assert [a["id"] for a in easy["activities"]] == ["garmin:555"]  # the empty manual row is gone
    a = easy["activities"][0]
    assert a["rpe"] == 3 and a["notes"] == "legs fine" and a["distance_km"] == 8.4
    assert easy["state"] == "done" and easy["planned"]["distance_km"] == 8  # planned stays planned
    assert w["totals"]["run"]["actual_km"] == 8.4 and w["totals"]["run"]["planned_km"] == 24
    assert all(not d["activities"] for d in w["days"])  # nothing counted as unplanned
    hist = client.get("/api/changes").json()
    assert hist[0]["source"] == "import"  # visible and undoable
    client.post(f"/api/changes/{hist[0]['id']}/undo", json={})
    easy = _workout(client, "w-easy")
    assert [x["source"] for x in easy["activities"]] == ["manual"] and easy["activities"][0][
        "rpe"
    ] == 3
    assert any(x["id"] == "garmin:555" for d in _week(client)["days"] for x in d["activities"])
    assert (
        client.get("/api/garmin/status").json()["activities"]["n"] == 2
    )  # recording kept, manual back


def test_planned_workout_is_linked_once_and_unlink_sticks(seeded):
    client = seeded
    upload(client, "run.zip", _run_export("2026-09-29", 8.4))
    easy = _workout(client, "w-easy")
    assert easy["state"] == "done" and easy["activities"][0]["id"] == "garmin:555"
    r = client.post(
        "/api/changes", json={"ops": [{"op": "unlink_activity", "activity_id": "garmin:555"}]}
    )
    assert r.status_code == 200
    upload(client, "run-again.zip", _run_export("2026-09-29", 8.4))  # re-import: not re-linked
    assert _workout(client, "w-easy")["state"] == "not_logged"
    assert (
        client.get("/api/garmin/status").json()["activities"]["n"] == 1
    )  # unlinking deletes nothing
    ib = client.get("/api/inbox").json()
    assert ib["recordings"][0]["candidates"][0]["id"] == "w-easy"


def test_ambiguous_day_goes_to_the_inbox(seeded):
    client = seeded
    upload(client, "two.zip", _run_export("2026-09-29", 5, hour_utc=6, ids=(1, 2)))
    assert _workout(client, "w-easy")["state"] == "not_logged"
    recs = client.get("/api/inbox").json()["recordings"]
    assert len(recs) == 2 and all(r["ambiguous"] for r in recs)
    r = client.post(
        "/api/changes",
        json={
            "ops": [
                {"op": "link_activity", "activity_id": "garmin:1", "workout_id": "w-easy"},
                {"op": "link_activity", "activity_id": "garmin:2", "workout_id": "w-easy"},
            ]
        },
    )  # a split recording
    assert r.status_code == 200 and len(_workout(client, "w-easy")["activities"]) == 2
    assert client.get("/api/inbox").json()["recordings"] == []


def test_legacy_and_garmin_types_map_to_the_fixed_set():
    from plan.types import normalise, type_of

    assert (
        type_of("road_biking") == "ride"
        and type_of("hiking") == "walk"
        and type_of("weird") == "other"
    )
    assert (
        normalise("bike") == "ride"
        and normalise("gym") == "strength"
        and normalise("ski") == "other"
    )


def test_remove_demo_data(client, small_export):
    upload(client, "demo.zip", small_export)
    assert client.get("/api/garmin/status").json()["demo_present"] is True
    r = client.delete("/api/garmin/demo").json()
    assert r["activities"] > 0 and r["metrics"] > 0
    st = client.get("/api/garmin/status").json()
    assert st["demo_present"] is False and st["activities"]["n"] == 0


def test_sync_without_tokens_never_tries_password_login(client, monkeypatch):
    import garminconnect

    calls = []

    class Fake:
        def __init__(self, *a, **k):
            calls.append((a, k))
            if a or k.get("email") or k.get("password"):
                raise AssertionError("password login attempted")

        def login(self, tokenstore=None):
            raise garminconnect.GarminConnectAuthenticationError("no tokens")

    monkeypatch.setattr(garminconnect, "Garmin", Fake)
    r = client.post("/api/garmin/sync", json={})
    assert r.status_code == 409  # not connected: nothing is even queued
    import db
    from garmin import sync, tokens

    tokens.save("{}")  # tokens exist but are rejected
    rid = client.post("/api/garmin/sync", json={}).json()["id"]
    from jobs import worker

    worker.run_next()
    run = client.get(f"/api/imports/{rid}").json()
    assert run["state"] == "failed" and "Reconnect in Data → Sync" in run["report"]["errors"][0]
    with db.get_db().session() as s:
        assert sync.state(s)["auth"] == "needs_reauth"
    assert (
        client.post("/api/garmin/sync", json={}).status_code == 409
    )  # stays stopped, no retry loop
    assert calls == [((), {})]


def test_imported_resting_hr_reaches_the_assistant_tool(client, small_export):
    """The importer's metric keys are the ones get_daily_metrics reads (no key mismatch)."""
    from chat.health_tools import get_daily_metrics
    from chat.tools import ChatDeps

    assert upload(client, "export.zip", small_export)["state"] == "done"

    class Ctx:
        deps = ChatDeps("t", "turn", {}, "now")

    out = get_daily_metrics(Ctx(), "2026-09-15", "2026-09-28", ["rhr_bpm", "hrv_ms"])
    rhr = out["metrics"]["rhr_bpm"]
    assert rhr["unit"] == "bpm" and rhr["days_with_data"] == 14 and 40 < rhr["stats"]["mean"] < 60
    assert out["metrics"]["hrv_ms"]["days_with_data"] == 14


def test_a_summary_type_of_other_uses_the_sport_type():
    """A custom profile can leave activityType as "other" while sportType names the sport.
    The summary must resolve the precise key, not stop at the first field that exists."""
    from garmin.parse import activity_from_summary

    ms = 1_760_000_000_000
    rec = activity_from_summary(
        {
            "activityId": 5,
            "activityType": "other",
            "sportType": "ice_skating",
            "startTimeGmt": ms,
            "startTimeLocal": ms,
        }
    )
    assert rec["sport"] == "skate" and rec["source_type"] == "ice_skating"


def test_a_summary_without_a_type_does_not_downgrade_a_recording(client):
    """A later sync must not turn a FIT-classified skate into "other" (the FIT is not re-imported
    once the activity has a stream, so the wrong type would stick)."""
    import db
    from garmin.store import upsert_activity
    from models import Activity

    s = db.get_db().session()
    base = {
        "id": "garmin:9",
        "source": "garmin",
        "source_id": "garmin:9",
        "sport": "skate",
        "source_type": "ice_skating",
        "name": "Ice Skating",
        "start_utc": datetime(2026, 10, 19, 10),
        "local_date": date(2026, 10, 19),
    }
    assert upsert_activity(s, base, "a") == "new"
    upsert_activity(
        s, {**base, "sport": "other", "source_type": "other", "name": "Ice Skating (sync)"}, "b"
    )
    s.commit()
    a = s.get(Activity, "garmin:9")
    assert (a.sport, a.source_type, a.name) == ("skate", "ice_skating", "Ice Skating (sync)")


def test_a_recording_left_as_other_is_repaired_from_its_kept_fit(client):
    """The repair pass reads the original FIT for rows the summary left untyped."""
    import db
    from garmin.store import repair_other_types
    from models import Activity

    fit = _fit(datetime(2026, 10, 19, 10, 0), "ice_skating", [(60, 6.0, 140)], random.Random(3))
    assert upload(client, "24783116742.fit", fit)["state"] == "done"

    s = db.get_db().session()
    a = s.get(Activity, "garmin:24783116742")
    assert (a.sport, a.source_type) == ("skate", "ice_skating")

    # The old summary overwrite, simulated directly (the upsert guard now prevents it).
    a.sport, a.source_type = "other", "other"
    s.commit()

    assert repair_other_types(s, db.data_dir()) == 1
    s.refresh(a)
    assert (a.sport, a.source_type) == ("skate", "ice_skating")

    # A sport that was reset while the device key survived is fixed without reading the file.
    a.sport = "other"
    s.commit()
    assert repair_other_types(s, db.data_dir()) == 1
    s.refresh(a)
    assert (a.sport, a.source_type) == ("skate", "ice_skating")


def test_the_type_repair_leaves_an_override_alone(client):
    """The athlete's explicit type wins over the surviving device key and the kept FIT."""
    import db
    from garmin.store import repair_other_types
    from models import Activity

    s = db.get_db().session()
    s.add(
        Activity(
            id="garmin:10",
            source="garmin",
            source_id="garmin:10",
            sport="other",
            source_type="ice_skating",
            type_override="other",
            start_utc=datetime(2026, 10, 19, 12),
            local_date=date(2026, 10, 19),
        )
    )
    s.commit()
    assert repair_other_types(s, db.data_dir()) == 0
    a = s.get(Activity, "garmin:10")
    assert (a.sport, a.source_type, a.type_override) == ("other", "ice_skating", "other")
