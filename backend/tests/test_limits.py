"""Operator limits and per-user guards for the friends rollout: the global assistant cap and
usage resets, per-user rate limits on expensive endpoints, the sandbox concurrency cap, the
storage quota and the cleanup the privacy note promises."""

from __future__ import annotations

import io
import os
import threading
import time
import zipfile
from datetime import timedelta

from conftest import signup

import db
from accounts import service

CHAT = {
    "id": "t1",
    "trigger": "submit-message",
    "messages": [{"id": "u", "role": "user", "parts": [{"type": "text", "text": "hi"}]}],
}


def _turns(uid: int, n: int) -> None:
    with db.auth_db().session() as s:
        for _ in range(n):
            service.record_turn(s, uid)


# ------------------------------------------------------------------ assistant (B2)


def test_global_weekly_cap_pauses_the_assistant_for_everyone(client, monkeypatch, capsys):
    from accounts import admin

    monkeypatch.setenv("OLLAMA_API_KEY", "test")
    monkeypatch.setenv("ASSISTANT_GLOBAL_WEEKLY_TURNS", "3")
    me = client.get("/api/auth/me").json()
    _turns(me["id"] + 1000, 3)  # someone else spent the shared budget
    r = client.post("/api/chat", json=CHAT)
    assert r.status_code == 429 and r.json()["code"] == "global_quota_exceeded"
    assert "everyone" in r.json()["detail"] and int(r.headers["retry-after"]) > 0
    admin.main(["usage"])
    assert "all accounts" in capsys.readouterr().out.splitlines()[-1]
    from chat import limits

    monkeypatch.setenv("ASSISTANT_GLOBAL_WEEKLY_TURNS", "-1")  # no cap
    assert limits.admit(me["id"]) is None


def test_reset_usage_forgets_only_this_weeks_turns_for_that_user(client, capsys):
    from accounts import admin, service
    from accounts.models import UsageEvent

    me = client.get("/api/auth/me").json()
    _turns(me["id"], 4)
    with db.auth_db().session() as s:
        s.add(
            UsageEvent(
                user_id=me["id"],
                kind="assistant_turn",
                at=service.week_start_utc() - timedelta(days=30),
            )
        )  # last month, relative to the pinned FAKE_TODAY week
        s.commit()
    _turns(me["id"] + 1000, 2)
    assert client.get("/api/auth/me").json()["usage"]["used"] == 4
    admin.main(["reset-usage", "athlete"])
    assert "forgot 4 assistant turns" in capsys.readouterr().out
    assert client.get("/api/auth/me").json()["usage"]["used"] == 0
    with db.auth_db().session() as s:
        assert service.global_turns(s) == 2
        assert (
            s.query(UsageEvent).filter(UsageEvent.user_id == me["id"]).count() == 1
        )  # history stays


# ------------------------------------------------------------------ per-user limits (B3)


def _analysis(monkeypatch):
    from analysis import runner
    from analysis.snapshot import DatasetSpec

    monkeypatch.setattr(
        runner,
        "_sandbox",
        lambda code, data: ({"status": "ok", "stdout": "1", "charts": []}, "fake"),
    )
    d = DatasetSpec(
        name="d", kind="daily", start="2026-09-01", end="2026-09-28", metrics=["hrv_ms"]
    )
    with db.get_db().session() as s:
        return runner.execute(s, question="q", code="print(1)", datasets=[d]).id


def test_reruns_are_limited_per_user(client, monkeypatch):
    aid = _analysis(monkeypatch)
    codes = [client.post(f"/api/analyses/{aid}/rerun").status_code for _ in range(21)]
    assert codes == [200] * 20 + [429]


def test_sandbox_runs_at_most_two_at_once_then_503(client, monkeypatch):
    from analysis import runner

    aid = _analysis(monkeypatch)
    monkeypatch.setattr(runner, "BUSY_WAIT_S", 0.05)
    assert runner.SLOTS.acquire(timeout=1) and runner.SLOTS.acquire(timeout=1)  # two runs in flight
    try:
        r = client.post(f"/api/analyses/{aid}/rerun")
        assert r.status_code == 503 and r.json()["code"] == "analysis_busy"
    finally:
        runner.SLOTS.release()
        runner.SLOTS.release()
    assert client.post(f"/api/analyses/{aid}/rerun").status_code == 200


def test_export_is_limited_per_user(client):
    codes = [client.get("/api/export/archive").status_code for _ in range(6)]
    assert codes == [200] * 5 + [429]


def _fit_zip() -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        z.writestr("DI_CONNECT/x/UDSFile_ok.json", "[]")
    return out.getvalue()


def test_garmin_uploads_are_limited_per_user(client):
    codes = [
        client.post("/api/garmin/upload", files={"file": (f"e{i}.zip", _fit_zip())}).status_code
        for i in range(11)
    ]
    assert codes == [200] * 10 + [429]


def test_storage_quota_and_free_disk_floor(client, monkeypatch, env):
    import shutil

    import upload_limits

    me = client.get("/api/auth/me").json()
    monkeypatch.setenv("USER_STORAGE_QUOTA_MB", "1")
    (env / "users" / str(me["id"]) / "big.bin").write_bytes(b"\0" * (1024 * 1024))
    r = client.post("/api/garmin/upload", files={"file": ("e.zip", _fit_zip())})
    assert r.status_code == 413 and r.json()["code"] == "storage_full"
    r = client.post("/api/media", files={"file": ("a.png", b"x")})
    assert r.status_code == 413 and r.json()["code"] == "storage_full"
    r = client.post("/api/chat/attachments", files={"file": ("a.png", b"x")})
    assert r.status_code == 413 and r.json()["code"] == "storage_full"
    monkeypatch.setenv("USER_STORAGE_QUOTA_MB", "2048")
    total = shutil.disk_usage(env).total
    monkeypatch.setattr(upload_limits, "MIN_FREE_DISK_BYTES", total + 1)  # the host is "full"
    r = client.post("/api/garmin/upload", files={"file": ("e.zip", _fit_zip())})
    assert r.status_code == 507 and r.json()["code"] == "disk_full"


def test_admin_list_shows_storage(client, capsys):
    from accounts import admin

    admin.main(["list"])
    assert " MB of 4096 MB" in capsys.readouterr().out


def test_per_user_limits_are_purged_with_the_account(anon):
    from accounts.models import RateLimit

    me = signup(anon, "olga")
    anon.get("/api/export/archive")
    with db.auth_db().session() as s:
        assert s.get(RateLimit, f"export:user:{me['id']}:archive") is not None
    anon.post("/api/auth/delete", json={"password": "correct horse battery", "confirm": "olga"})
    with db.auth_db().session() as s:
        assert s.get(RateLimit, f"export:user:{me['id']}:archive") is None


# ------------------------------------------------------------------ cleanup (B5)


def test_deleted_account_copies_are_purged_after_a_week(env):
    root = env / "deleted"
    old, new, odd = root / "user-3-20200101T000000", root / "user-4-29991231T000000", root / "stray"
    for p in (old, new, odd):
        p.mkdir(parents=True)
        (p / "app.db").write_bytes(b"x")
    past = time.time() - 8 * 86400
    os.utime(odd, (past, past))
    assert service.purge_deleted() == 2
    assert not old.exists() and not odd.exists() and new.exists()


def test_startup_empties_the_data_tmp_dir(env):
    from fastapi.testclient import TestClient

    import main

    tmp = env / "tmp"
    (tmp / "sports-export-x").mkdir(parents=True)
    (tmp / "spool").write_bytes(b"x")
    keep = env / "deleted" / "user-9-29991231T000000"
    keep.mkdir(parents=True)
    with TestClient(main.app):
        assert tmp.is_dir() and not any(tmp.iterdir()) and keep.exists()


def test_concurrent_slot_waits_rather_than_failing(monkeypatch):
    """A third run waits for a slot (up to BUSY_WAIT_S) instead of failing straight away."""
    from analysis import runner

    monkeypatch.setattr(runner, "_sandbox", lambda code, data: ({"status": "ok"}, "fake"))
    runner.SLOTS.acquire()
    runner.SLOTS.acquire()
    threading.Timer(0.1, runner.SLOTS.release).start()
    try:
        assert runner.sandbox("print(1)", {})[0]["status"] == "ok"
    finally:
        runner.SLOTS.release()
