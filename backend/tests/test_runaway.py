"""Guards against a runaway Garmin pull (2026-10-21): failure back-off, the worker's circuit
breaker, import-run retention, quota accounting that ignores boot backups, and the alerts."""

from __future__ import annotations

import collections
import json
import shutil
import sqlite3
from datetime import UTC, datetime, timedelta

from test_sync_settings import SECRET, TOKENS, garmin  # noqa: F401 (fixture)

import alerts
import db
from garmin import sync, tokens
from jobs import worker
from models import ImportRun
from models.base import utcnow

PULL = "pull"


def _pull_rows() -> int:
    with db.get_db().session() as s:
        return s.query(ImportRun).filter(ImportRun.kind == PULL).count()


def test_a_permission_error_does_not_reenqueue_a_pull(client, garmin, monkeypatch):  # noqa: F811
    client.post("/api/garmin/connect", json={"email": "me@example.com", "password": SECRET})
    worker.run_next()  # the first pull succeeds and records last_pull
    with db.get_db().session() as s:
        sync.set_state(s, last_pull="2020-01-01T00:00:00", failure_count=0)
        assert sync.due(s)

    def unreadable():
        raise PermissionError("denied")

    monkeypatch.setattr(sync, "_client", unreadable)
    assert worker.tick() is True  # the scheduled pull is enqueued
    worker.tick()  # … and runs, and fails

    runs = client.get("/api/imports").json()
    failed = [r for r in runs if r["kind"] == PULL and r["state"] == "failed"]
    assert len(failed) == 1
    assert failed[0]["report"]["errors"] == [tokens.UNREADABLE_HELP]
    with db.get_db().session() as s:
        st = sync.state(s)
        assert st["last_error"] == tokens.UNREADABLE_HELP
        assert "denied" not in st["last_error"]  # never the raw path / exception text
        assert st["failure_count"] == 1
        assert not sync.due(s)
        assert sync.next_pull(s) > utcnow() + timedelta(minutes=4)

    before = _pull_rows()
    assert worker.tick() is False  # not due: no new pull row
    assert _pull_rows() == before


def test_a_manual_pull_failure_does_not_arm_the_scheduled_backoff(
    client,
    garmin,  # noqa: F811 (the fixture shadows the imported one)
    monkeypatch,
):
    """Sync-now is the athlete's own retry: it reports the error but must not postpone the
    scheduled pull (spec: the growing delay is for a scheduled pull)."""
    client.post("/api/garmin/connect", json={"email": "me@example.com", "password": SECRET})
    worker.run_next()  # the first pull succeeds
    with db.get_db().session() as s:
        sync.set_state(s, last_pull="2020-01-01T00:00:00", failure_count=0)

    def unreadable():
        raise PermissionError("denied")

    monkeypatch.setattr(sync, "_client", unreadable)
    rid = client.post("/api/garmin/sync", json={}).json()["id"]
    worker.run_next()

    assert client.get(f"/api/imports/{rid}").json()["state"] == "failed"
    with db.get_db().session() as s:
        st = sync.state(s)
        assert st["last_error"] == tokens.UNREADABLE_HELP
        assert st["failure_count"] == 0
        assert sync.due(s)  # the scheduled pull may still try once


def test_an_unexpected_error_also_records_a_backoff(client, garmin, monkeypatch):  # noqa: F811
    """The permission path is caught inside sync.pull; anything else must still arm the guard."""
    client.post("/api/garmin/connect", json={"email": "me@example.com", "password": SECRET})
    worker.run_next()
    with db.get_db().session() as s:
        sync.set_state(s, last_pull="2020-01-01T00:00:00", failure_count=0)

    def unexpected():
        raise RuntimeError("boom")

    monkeypatch.setattr(sync, "_client", unexpected)
    worker.tick()
    worker.tick()
    with db.get_db().session() as s:
        st = sync.state(s)
        assert st["failure_count"] == 1 and "RuntimeError" in st["last_error"]
        assert not sync.due(s)

    before = _pull_rows()
    assert worker.tick() is False
    assert _pull_rows() == before


def test_the_worker_stops_scheduling_after_twelve_failed_pulls_in_an_hour(client):
    tokens.save(TOKENS)
    with db.get_db().session() as s:
        for i in range(worker.PULLS_PER_HOUR_MAX):
            s.add(
                ImportRun(
                    id=f"recent-{i}",
                    kind=PULL,
                    state="failed",
                    created_at=utcnow(),
                    finished_at=utcnow(),
                )
            )
        sync.set_state(s, last_pull="2020-01-01T00:00:00", failure_count=0)
    before = _pull_rows()
    assert worker.tick() is False  # over the hourly cap: no new pull row
    assert _pull_rows() == before


def test_failure_backoff_grows_and_is_capped(client, monkeypatch):
    tokens.save(TOKENS)
    fixed = datetime(2026, 10, 1, 12)
    monkeypatch.setattr(sync, "utcnow", lambda: fixed)
    with db.get_db().session() as s:
        sync.set_state(
            s,
            auth="ok",
            auto=True,
            last_pull=(fixed - timedelta(hours=3)).isoformat(),
            failure_count=0,
            last_attempt=None,
            backoff_until=None,
        )
        for failures, minutes in ((1, 5), (2, 10), (3, 20)):
            sync.record_failure(s, RuntimeError("boom"))
            assert sync.state(s)["failure_count"] == failures
            assert sync.failure_delay(s, failures) == timedelta(minutes=minutes)
            assert sync.next_pull(s) == fixed + timedelta(minutes=minutes)
            assert not sync.due(s)
        cap = timedelta(hours=sync.settings(s)["interval_h"])
        for _ in range(20):
            sync.record_failure(s, "still broken")
        assert sync.failure_delay(s, 999) == cap
        assert sync.next_pull(s) == fixed + cap  # never later than the normal interval
        assert sync.state(s)["backoff_until"] is None  # the rate-limit pause is untouched


def test_a_corrupt_state_timestamp_does_not_crash_scheduling(client):
    tokens.save(TOKENS)
    with db.get_db().session() as s:
        sync.set_state(s, auth="ok", auto=True, last_pull="not a date", backoff_until="nope")
        assert sync.backing_off(s) is None
        assert sync.next_pull(s) is not None  # a corrupt value means "now", not an exception


def test_a_successful_pull_resets_the_failure_backoff(client, garmin):  # noqa: F811
    client.post("/api/garmin/connect", json={"email": "me@example.com", "password": SECRET})
    worker.run_next()
    with db.get_db().session() as s:
        sync.record_failure(s, PermissionError("denied"))
        sync.set_state(s, last_pull="2020-01-01T00:00:00")
        assert sync.state(s)["failure_count"] == 1

    rid = client.post("/api/garmin/sync", json={}).json()["id"]
    worker.run_next()
    assert client.get(f"/api/imports/{rid}").json()["state"] == "done"
    with db.get_db().session() as s:
        st = sync.state(s)
        assert st["failure_count"] == 0 and st["last_error"] is None
        assert not sync.due(s)  # last_pull is now, so the success also ends the back-off


def test_connect_permission_error_is_a_clear_503(client, monkeypatch):
    """An unreadable token file is an operator problem: a non-retrying 503, not "Garmin
    unreachable"."""

    def denied(*a, **kw):
        raise PermissionError("denied")

    monkeypatch.setattr(sync, "connect", denied)
    r = client.post("/api/garmin/connect", json={"email": "me@example.com", "password": SECRET})
    assert r.status_code == 503
    body = r.json()
    detail = body["detail"] if isinstance(body["detail"], dict) else body
    assert detail["code"] == "garmin_unavailable"
    assert tokens.UNREADABLE_HELP in detail["detail"]


def test_prune_import_runs_keeps_recent_and_active_rows(client):
    now = utcnow()
    old = now - timedelta(days=120)
    with db.get_db().session() as s:
        for i in range(3):  # finished outside the keep window
            s.add(
                ImportRun(id=f"old-{i}", kind=PULL, state="done", created_at=old, finished_at=old)
            )
        s.add(ImportRun(id="recent", kind=PULL, state="done", created_at=now, finished_at=now))
        for i in range(4):  # recent, but more than per_kind of them
            at = now - timedelta(minutes=4 - i)
            s.add(
                ImportRun(id=f"fit-{i}", kind="fit", state="failed", created_at=at, finished_at=at)
            )
        s.add(ImportRun(id="queued", kind=PULL, state="queued", created_at=old))
        s.add(ImportRun(id="running", kind=PULL, state="running", created_at=old))
        s.add(ImportRun(id="paused", kind="backfill", state="paused", created_at=old))
        s.commit()

    assert worker.prune_import_runs(keep_days=90, per_kind=2) == 5  # 3 by age, 2 by kind
    with db.get_db().session() as s:
        left = {r.id for r in s.query(ImportRun)}
        counts = {
            kind: s.query(ImportRun)
            .filter(ImportRun.kind == kind, ImportRun.state.in_(worker.FINISHED_STATES))
            .count()
            for kind in ("pull", "fit", "backfill")
        }
    assert {"recent", "queued", "running", "paused", "fit-2", "fit-3"} <= left
    assert {"old-0", "old-1", "old-2", "fit-0", "fit-1"}.isdisjoint(left)
    assert all(n <= 2 for n in counts.values())


def test_storage_bytes_excludes_boot_backups(client, env):
    uid = client.get("/api/auth/me").json()["id"]
    root = env / "users" / str(uid)
    before = db.storage_bytes(uid)
    before_all = db.folder_bytes(root)
    (root / "real.bin").write_bytes(b"\0" * 1000)
    (root / "backups").mkdir(exist_ok=True)
    (root / "backups" / "app-20260101T000000_000000Z.db").write_bytes(b"\0" * 5000)
    assert db.storage_bytes(uid) == before + 1000
    assert db.folder_bytes(root) == before_all + 6000


def test_backup_database_skips_within_the_minimum_interval(tmp_path):
    path = tmp_path / "app.db"
    with sqlite3.connect(path) as c:
        c.execute("CREATE TABLE t (x INTEGER)")
        c.execute("INSERT INTO t VALUES (1)")

    first = db.backup_database(str(path))
    assert first is not None and first.exists()
    assert db.backup_database(str(path)) is None  # inside the six-hour window

    backup_dir = path.parent / "backups"
    old = [backup_dir / f"app-2020{i + 1}01T000000_000000Z.db" for i in range(3)]
    for p in old:
        p.write_bytes(b"\0" * 500)
    newest = db.backup_database(str(path), force=True, max_bytes=2000)
    assert newest is not None and newest.exists()
    # the test database alone is > 2 KB, so only the snapshot just made fits the size cap
    assert set(backup_dir.glob("app-*.db")) == {newest}


# ------------------------------------------------------------------ alerts


class _Response:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return b"ok"


def _fake_webhook(monkeypatch, calls):
    monkeypatch.setenv("ALERT_WEBHOOK_URL", "https://hooks.example/webhook/sports-alerts")

    def fake(req, timeout):
        calls.append(req)
        return _Response()

    monkeypatch.setattr(alerts.request, "urlopen", fake)
    return calls


def _bodies(calls: list) -> list[tuple[str, str, str]]:
    """The captured webhook requests' JSON bodies as (app, title, message)."""
    out = []
    for req in calls:
        body = json.loads(req.data)
        out.append((body["app"], body["title"], body["message"]))
    return out


def test_alerts_failed_runs_notify_once_then_cool_down(client, monkeypatch):
    me = client.get("/api/auth/me").json()
    monkeypatch.setenv("ALERT_FAILED_RUNS_PER_HOUR", "3")
    monkeypatch.setenv("ALERT_FREE_DISK_MB", "1")  # the real disk is not part of this test
    calls: list = []
    _fake_webhook(monkeypatch, calls)
    alerts.reset()
    now = utcnow()
    with db.get_db().session() as s:
        for i, kind in enumerate(("pull", "pull", "fit")):
            at = now - timedelta(minutes=10 - i)
            s.add(
                ImportRun(
                    id=f"failed-{i}",
                    kind=kind,
                    state="failed",
                    created_at=at,
                    finished_at=at,
                    report={"errors": [f"boom {i}"]},
                )
            )
        s.commit()

    assert alerts.check() == [f"failed-runs:{me['id']}"]
    assert len(calls) == 1
    body = _bodies(calls)[0]
    assert "3 failed import runs" in body[2]
    assert "boom 2" in body[2]  # the latest run's error, not the first one's
    assert alerts.check() == []  # the cooldown suppresses the next pass
    assert len(calls) == 1


def test_alerts_storage_growth_alerts_on_a_date_rollover(client, monkeypatch, env):
    me = client.get("/api/auth/me").json()
    monkeypatch.setenv("ALERT_STORAGE_GROWTH_MB", "1")
    monkeypatch.setenv("ALERT_FREE_DISK_MB", "1")
    calls: list = []
    _fake_webhook(monkeypatch, calls)
    alerts.reset()
    root = env / "users" / str(me["id"])
    baseline = db.folder_bytes(root)
    (env / "alerts-state.json").write_text(
        json.dumps({str(me["id"]): {"date": "2020-01-01", "bytes": baseline}})
    )
    (root / "grow.bin").write_bytes(b"\0" * (2 * 1024 * 1024))
    backups = root / "backups"
    backups.mkdir(exist_ok=True)
    (backups / "app-20260101T000000_000000Z.db").write_bytes(b"\0" * (1024 * 1024))

    assert alerts.check() == [f"storage-growth:{me['id']}"]
    assert len(calls) == 1 and "MB" in _bodies(calls)[0][2]
    state = json.loads((env / "alerts-state.json").read_text())
    assert state[str(me["id"])]["date"] == datetime.now(UTC).date().isoformat()
    # backups count too: that is what filled the disk on 2026-10-21
    assert state[str(me["id"])]["bytes"] == db.folder_bytes(root)


def test_a_failed_growth_alert_keeps_the_baseline_for_the_next_check(client, monkeypatch, env):
    me = client.get("/api/auth/me").json()
    monkeypatch.setenv("ALERT_STORAGE_GROWTH_MB", "1")
    monkeypatch.setenv("ALERT_FREE_DISK_MB", "1")
    monkeypatch.setenv("ALERT_WEBHOOK_URL", "https://hooks.example/webhook/sports-alerts")
    alerts.reset()

    def broken(req, timeout):
        raise OSError("connection refused")

    monkeypatch.setattr(alerts.request, "urlopen", broken)
    root = env / "users" / str(me["id"])
    baseline = db.folder_bytes(root)
    (env / "alerts-state.json").write_text(
        json.dumps({str(me["id"]): {"date": "2020-01-01", "bytes": baseline}})
    )
    (root / "grow.bin").write_bytes(b"\0" * (2 * 1024 * 1024))

    assert alerts.check() == []  # delivery failed, so nothing was sent
    state = json.loads((env / "alerts-state.json").read_text())
    assert state[str(me["id"])]["date"] == "2020-01-01"  # the next check retries the alert


def test_alerts_free_disk_below_the_threshold(client, monkeypatch):
    monkeypatch.setenv("ALERT_FREE_DISK_MB", "1000")
    calls: list = []
    _fake_webhook(monkeypatch, calls)
    alerts.reset()
    usage = collections.namedtuple("usage", "total used free")
    monkeypatch.setattr(shutil, "disk_usage", lambda p: usage(10**12, 10**12 - 10**6, 10**6))

    assert alerts.check() == ["disk-free"]
    assert len(calls) == 1 and "MB free" in _bodies(calls)[0][2]


def test_notify_posts_the_configured_webhook_with_the_token(client, monkeypatch):
    calls: list = []
    _fake_webhook(monkeypatch, calls)
    monkeypatch.setenv("ALERT_WEBHOOK_TOKEN", "s3cret")
    alerts.reset()

    assert alerts.notify("k", "Title", "Body") is True
    assert len(calls) == 1
    req = calls[0]
    assert req.full_url == "https://hooks.example/webhook/sports-alerts"
    assert req.get_header("X-sports-token") == "s3cret"
    body = json.loads(req.data)
    assert body["app"] == "sports" and body["title"] == "Title" and body["message"] == "Body"

    assert alerts.notify("k", "Title", "Body") is False  # cooled down
    assert len(calls) == 1


def test_a_failed_webhook_is_retried_on_the_next_check(client, monkeypatch):
    calls: list = []
    monkeypatch.setenv("ALERT_WEBHOOK_URL", "https://hooks.example/webhook/sports-alerts")
    alerts.reset()

    def broken(req, timeout):
        calls.append(req)
        raise OSError("connection refused")

    monkeypatch.setattr(alerts.request, "urlopen", broken)
    assert alerts.notify("k", "Title", "Body") is False
    assert alerts.notify("k", "Title", "Body") is False  # no cooldown was armed
    assert len(calls) == 2
