"""Sync settings (decisions 24, 26): in-app Garmin connect, schedule, backfill, delete."""

from __future__ import annotations

import os
from datetime import timedelta

import garminconnect
import pytest

import db
from garmin import sync, tokens
from jobs import worker

SECRET = "hunter2-garmin-pw"
_real_client = sync._client  # the fixture below replaces it; the token tests need the real one


TOKENS = '{"di_token": "tok", "di_refresh_token": "ref"}'


class FakeClient:
    def __init__(self):
        self.token = TOKENS

    def dumps(self):
        return self.token

    def dump(self, path):  # what garminconnect does with a path tokenstore; must never be reached
        raise AssertionError(f"plaintext token dump to {path}")


class FakeGarmin:
    """Stands in for garminconnect.Garmin: sign-in (with MFA for mfa@…) and the daily calls."""

    calls: list[str] = []
    limit_after: int | None = None

    def __init__(self, email=None, password=None, return_on_mfa=False, **_):
        self.email, self.password, self.client = email, password, FakeClient()

    def login(self, tokenstore=None):
        if tokenstore:
            return None, None
        if self.password != SECRET:
            raise garminconnect.GarminConnectAuthenticationError("401")
        return ("needs_mfa", {"csrf": "x"}) if self.email.startswith("mfa") else (None, None)

    def resume_login(self, state, code):
        if code != "123456":
            raise garminconnect.GarminConnectAuthenticationError("bad code")
        return None, None

    def _day(self, name, ds):
        FakeGarmin.calls.append(f"{name}:{ds}")
        if FakeGarmin.limit_after is not None and len(FakeGarmin.calls) > FakeGarmin.limit_after:
            raise garminconnect.GarminConnectTooManyRequestsError("429")
        return {}

    def get_stats(self, ds):
        self._day("stats", ds)
        return {"restingHeartRate": 50, "totalSteps": 9000}

    def get_sleep_data(self, ds):
        return self._day("sleep", ds)

    def get_hrv_data(self, ds):
        self._day("hrv", ds)
        return {"hrvSummary": {"calendarDate": ds, "lastNightAvg": 60}}

    def get_max_metrics(self, ds):
        self._day("vo2", ds)
        return [{"generic": {"vo2MaxPreciseValue": 51.3}}]

    def get_training_readiness(self, ds):
        self._day("tr", ds)
        return [{"score": 72}]

    def get_respiration_data(self, ds):
        self._day("resp", ds)
        return {"avgSleepRespirationValue": 14.2}

    def get_spo2_data(self, ds):
        self._day("spo2", ds)
        return {"avgSleepSpO2": 95}

    def get_body_composition(self, a, b):
        return {}

    def get_activities_by_date(self, a, b):
        return []


@pytest.fixture
def garmin(monkeypatch):
    FakeGarmin.calls, FakeGarmin.limit_after = [], None
    monkeypatch.setattr(garminconnect, "Garmin", FakeGarmin)
    monkeypatch.setenv("GARMIN_PAUSE_S", "0")
    monkeypatch.setattr(sync, "_client", lambda: FakeGarmin())
    return FakeGarmin


def test_connect_keeps_only_tokens(client, garmin, env):
    r = client.post(
        "/api/garmin/connect", json={"email": "me@example.com", "password": SECRET}
    ).json()
    assert r["state"] == "connected"
    p = tokens.path()
    assert p.exists() and oct(os.stat(p).st_mode & 0o777) == "0o600"
    assert b"tok" not in p.read_bytes() and tokens.load() == TOKENS  # encrypted at rest
    worker.run_next()  # the first pull runs straight away
    st = client.get("/api/garmin/status").json()
    assert (
        st["connected"]
        and st["state"]["last_pull"]
        and st["settings"] == {"auto": True, "interval_h": 2.0}
    )
    assert {t["key"] for t in st["synced_types"]} >= {"vo2max", "readiness", "respiration", "spo2"}
    # the password is nowhere on disk: not in the user's folder, not in auth.db
    for f in env.rglob("*"):
        if f.is_file():
            assert SECRET.encode() not in f.read_bytes(), f
    # the new daily calls were stored
    from models import DailyMetric

    with db.get_db().session() as s:
        got = {m.metric for m in s.query(DailyMetric).all()}
    assert {"vo2max", "readiness", "respiration", "spo2", "hrv_ms", "rhr_bpm"} <= got
    # the archive export never includes the tokens
    import io
    import zipfile

    z = zipfile.ZipFile(io.BytesIO(client.get("/api/export/archive").content))
    assert not any("tokens" in n for n in z.namelist())
    assert client.post("/api/garmin/disconnect").json()["ok"] and not p.exists()
    assert client.get("/api/garmin/status").json()["connected"] is False


def test_mfa_flow(client, garmin):
    r = client.post(
        "/api/garmin/connect", json={"email": "mfa@example.com", "password": SECRET}
    ).json()
    assert r["state"] == "needs_mfa" and not tokens.present()
    bad = client.post("/api/garmin/connect/mfa", json={"code": "000000"})
    assert bad.status_code == 401
    assert (
        client.post("/api/garmin/connect/mfa", json={"code": "123456"}).status_code == 409
    )  # one try per request
    client.post("/api/garmin/connect", json={"email": "mfa@example.com", "password": SECRET})
    assert (
        client.post("/api/garmin/connect/mfa", json={"code": "123456"}).json()["state"]
        == "connected"
    )


def test_three_connect_attempts_a_day(client, garmin):
    codes = []
    for _ in range(4):
        r = client.post(
            "/api/garmin/connect", json={"email": "me@example.com", "password": "wrong"}
        )
        codes.append((r.status_code, r.json().get("attempts_left")))
    assert codes[:3] == [(401, 2), (401, 1), (401, 0)] and codes[3][0] == 429
    r = client.post("/api/garmin/connect", json={"email": "me@example.com", "password": SECRET})
    assert r.status_code == 429  # even the right password waits


def test_schedule_settings(client, garmin):
    client.post("/api/garmin/connect", json={"email": "me@example.com", "password": SECRET})
    worker.run_next()
    with db.get_db().session() as s:
        assert not sync.due(s)
    assert client.patch("/api/garmin/settings", json={"interval_h": 5}).status_code == 422
    assert client.patch("/api/garmin/settings", json={"interval_h": 6, "auto": False}).json() == {
        "auto": False,
        "interval_h": 6,
    }
    with db.get_db().session() as s:
        sync.set_state(s, last_pull="2020-01-01T00:00:00")
        assert not sync.due(s)  # automatic sync is off
        sync.set_state(s, auto=True)
        assert sync.due(s)
    assert client.get("/api/garmin/status").json()["next_pull"]


def test_backfill_chunks_pauses_on_429_and_resumes(client, garmin, monkeypatch):
    from plan import clock

    client.post("/api/garmin/connect", json={"email": "me@example.com", "password": SECRET})
    worker.run_next()
    start = clock.today() - timedelta(days=40)
    assert (
        client.post(
            "/api/garmin/backfill",
            json={"start": (clock.today() - timedelta(days=1900)).isoformat()},
        ).status_code
        == 422
    )
    rid = client.post("/api/garmin/backfill", json={"start": start.isoformat()}).json()["id"]
    assert client.post("/api/garmin/backfill", json={"start": start.isoformat()}).status_code == 409
    worker.run_next()  # chunk 1: 14 days
    r = client.get(f"/api/imports/{rid}").json()
    assert r["state"] == "queued" and r["progress"] == {"done": 14, "total": 41}
    garmin.calls, garmin.limit_after = [], 20  # Garmin starts refusing mid-chunk
    worker.run_next()
    r = client.get(f"/api/imports/{rid}").json()
    assert r["state"] == "paused" and r["params"]["resume_at"]
    worker.resume_paused()
    assert client.get(f"/api/imports/{rid}").json()["state"] == "paused"  # still backing off
    with db.get_db().session() as s:
        sync.set_state(s, backoff_until=None)
        from models import ImportRun

        s.get(ImportRun, rid).params = {**s.get(ImportRun, rid).params, "resume_at": None}
        s.commit()
    garmin.limit_after = None
    worker.resume_paused()
    for _ in range(3):
        worker.run_next()
    r = client.get(f"/api/imports/{rid}").json()
    assert r["state"] == "done" and r["progress"] == {"done": 41, "total": 41}
    # every day of the window is stored once; days fetched before the pause (and by the first
    # pull) come back as "same" when the chunk resumes
    from models import DailyMetric

    with db.get_db().session() as s:
        days = {m.day for m in s.query(DailyMetric).filter(DailyMetric.metric == "rhr_bpm")}
    assert days == {start + timedelta(days=i) for i in range(41)}
    rec = r["report"]["records"]["rhr_bpm"]
    assert rec["new"] + rec["same"] + rec["updated"] >= 41


def test_delete_synced_data(client, garmin):
    client.post("/api/garmin/connect", json={"email": "me@example.com", "password": SECRET})
    worker.run_next()
    assert client.post("/api/garmin/delete-data", json={"confirm": "nope"}).status_code == 422
    out = client.post("/api/garmin/delete-data", json={"confirm": "delete"}).json()
    assert out["metrics"] > 0
    st = client.get("/api/garmin/status").json()
    assert st["coverage"] == [] and st["connected"]  # tokens untouched


# ------------------------------------------------------------------ encrypted tokens (B4)


class RotatingGarmin(FakeGarmin):
    """Uses the real `_client` path: records what login() got and rotates the token, as a
    refresh would."""

    seen: list = []

    def login(self, tokenstore=None):
        RotatingGarmin.seen.append(tokenstore)
        if tokenstore is not None:
            self.client.token = '{"di_token": "rotated", "di_refresh_token": "ref2"}'
        return super().login(tokenstore)


def _plaintext_tokens(root):
    return [
        f
        for f in root.rglob("*")
        if f.is_file() and (f.name == "tokens.json" or b"di_token" in f.read_bytes())
    ]


def test_tokens_stay_encrypted_through_connect_sync_and_refresh(client, garmin, monkeypatch, env):
    import json

    RotatingGarmin.seen = []
    monkeypatch.setattr(garminconnect, "Garmin", RotatingGarmin)
    monkeypatch.setattr(sync, "_client", _real_client)
    assert (
        client.post(
            "/api/garmin/connect", json={"email": "me@example.com", "password": SECRET}
        ).json()["state"]
        == "connected"
    )
    assert _plaintext_tokens(env) == []
    worker.run_next()  # the first pull: signs in from the stored tokens, then saves the rotated ones
    stored = [t for t in RotatingGarmin.seen if t is not None]
    assert stored and json.loads(stored[0])["di_token"] == "tok"  # a JSON string, never a path
    assert json.loads(tokens.load())["di_token"] == "rotated"
    assert _plaintext_tokens(env) == [] and oct(os.stat(tokens.path()).st_mode & 0o777) == "0o600"


def test_legacy_plaintext_tokens_are_migrated(client):
    legacy = tokens.legacy_path()
    legacy.write_text(TOKENS)
    assert tokens.present()
    assert tokens.load() == TOKENS
    assert (
        not legacy.exists() and tokens.path().exists() and b"tok" not in tokens.path().read_bytes()
    )


def test_missing_or_bad_key_fails_closed(client, garmin, monkeypatch, tmp_path_factory):
    client.post("/api/garmin/connect", json={"email": "me@example.com", "password": SECRET})
    monkeypatch.delenv("GARMIN_TOKEN_KEY_FILE")
    st = client.get("/api/garmin/status").json()
    assert st["connected"] is False and st["token_key"] is False and st["token_present"] is True
    r = client.post("/api/garmin/connect", json={"email": "me@example.com", "password": SECRET})
    assert r.status_code == 503 and r.json()["code"] == "garmin_unavailable"
    assert client.post("/api/garmin/sync", json={}).status_code == 409
    assert client.get("/api/week/2026-09-28").status_code == 200  # the rest of the app works
    with db.get_db().session() as s:
        assert not sync.due(s)  # no scheduled pulls looping on a missing key
    bad = tmp_path_factory.mktemp("bad") / "key"
    bad.write_text("not a fernet key")
    monkeypatch.setenv("GARMIN_TOKEN_KEY_FILE", str(bad))
    with pytest.raises(tokens.KeyMissing):
        tokens.load()
    monkeypatch.setattr(sync, "_client", _real_client)
    with db.get_db().session() as s:
        report = sync.pull(s, "imp-x")
        assert report.errors == [tokens.KEY_HELP] and sync.state(s)["auth"] != "needs_reauth"


def test_a_different_key_means_reconnect_not_a_crash(client, garmin, monkeypatch, tmp_path_factory):
    from cryptography.fernet import Fernet

    client.post("/api/garmin/connect", json={"email": "me@example.com", "password": SECRET})
    other = tmp_path_factory.mktemp("other") / "key"
    other.write_bytes(Fernet.generate_key() + b"\n")  # a trailing newline, like the generated file
    monkeypatch.setenv("GARMIN_TOKEN_KEY_FILE", str(other))
    assert tokens.load() is None
    monkeypatch.setattr(sync, "_client", _real_client)
    with db.get_db().session() as s:
        sync.pull(s, "imp-y")
        assert sync.state(s)["auth"] == "needs_reauth"
