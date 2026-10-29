"""Export and restore (acceptance A27)."""

from __future__ import annotations

import io
import json
import zipfile

from conftest import signup
from test_garmin import upload


def second_client():
    """Another browser, signed in as a different (fresh) user of the same app."""
    from fastapi.testclient import TestClient

    import main

    c = TestClient(main.app)
    me = signup(c, "second")
    return c, me


def test_full_archive_round_trip(seeded, tmp_path, monkeypatch):  # A27
    from datetime import date

    from garmin.demo_export import build

    client = seeded
    upload(client, "demo.zip", build(days=10, end=date(2026, 9, 28)))
    r = client.post("/api/changes", json={"ops": [{"op": "log_workout", "workout_id": "w-easy", "rpe": 4}]})
    assert r.status_code == 200
    recorded = next(x["id"] for x in client.get("/api/activities", params={"start": "2026-09-19", "end": "2026-09-28"}).json() if x["has_stream"])
    assert client.post("/api/changes", json={"ops": [{"op": "update_activity_annotations", "id": recorded, "type_override": "other"}]}).status_code == 200
    blob = client.get("/api/export/archive").content
    z = zipfile.ZipFile(io.BytesIO(blob))
    man = json.loads(z.read("manifest.json"))
    assert man["counts"]["activity"] > 0 and man["counts"]["plan_change"] >= 2 and man["counts"]["workout"] == 3
    assert any(n.startswith("raw/archive/") for n in man["files"]) and any(n.startswith("streams/") for n in man["files"])
    assert "README.md" in z.namelist() and not any(n.startswith("plans/") for n in z.namelist())
    assert not any("token" in n for n in z.namelist())
    # restore into another, empty account via the operator CLI path
    arch = tmp_path / "a.zip"
    arch.write_bytes(blob)
    c2, me2 = second_client()
    import db
    from export.restore import restore

    with db.as_user(me2["id"]):
        db.forget_user(me2["id"])
        out = restore(arch, force=True)
    assert out["rows"] == sum(man["counts"].values())
    with c2:
        w2 = next(x for d in c2.get("/api/week/2026-09-28").json()["days"] for x in d["workouts"] if x["id"] == "w-easy")
        assert w2["state"] == "done" and w2["activities"][0]["rpe"] == 4
        assert c2.get("/api/garmin/status").json()["activities"]["n"] == man["counts"]["activity"]
        assert c2.get(f"/api/activities/{recorded}").json()["type"] == "other"  # the athlete's type is exported
        assert len(c2.get("/api/changes").json()) == len(client.get("/api/changes").json())
        a = c2.get("/api/activities", params={"start": "2026-09-19", "end": "2026-09-28"}).json()
        assert any(c2.get(f"/api/activities/{x['id']}").json().get("stream") for x in a if x["has_stream"])


def test_archive_can_exclude_conversations(client):
    blob = client.get("/api/export/archive", params={"conversations": "false"}).content
    man = json.loads(zipfile.ZipFile(io.BytesIO(blob)).read("manifest.json"))
    assert man["counts"]["conversation"] == 0 and "table:conversation" in man["excluded"]
