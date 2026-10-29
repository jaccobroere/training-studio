"""Settings, the error envelope, request ids and JSON log lines."""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

import pytest

APP = Path(__file__).resolve().parents[2]


def test_bad_settings_fail_with_one_error_naming_variables_not_values(monkeypatch):
    from core import settings as config

    monkeypatch.setenv("ASSISTANT_PER_MINUTE", "lots")
    monkeypatch.setenv("APP_ENV", "staging-secret-ish")
    with pytest.raises(config.SettingsError) as e:
        config.load()
    msg = str(e.value)
    assert "ASSISTANT_PER_MINUTE" in msg and "APP_ENV" in msg
    assert "lots" not in msg and "staging-secret-ish" not in msg


def test_empty_values_count_as_unset(monkeypatch):
    from core.settings import settings

    monkeypatch.setenv("OLLAMA_MODEL", "")
    monkeypatch.setenv("OLLAMA_API_KEY", "")
    assert settings().model == "deepseek-v4.1-flash:1017" and settings().api_key is None


def _documented() -> set[str]:
    """Variables named in .env.example (set or commented) and in compose.yml's app service."""
    names = set(
        re.findall(r"^#?\s*([A-Z][A-Z0-9_]+)=", (APP / ".env.example").read_text(), re.MULTILINE)
    )
    compose = (APP / "compose.yml").read_text().split("\n  pyrunner:")[0]
    env_block = compose.split("environment:")[1].split("command:")[0]
    # HOME, XDG_CACHE_HOME and TMPDIR are for the OS and libraries, not app settings; the
    # rest are read by compose.yml itself (images, ports, the bundled Caddy), not the app.
    runtime = {"HOME", "XDG_CACHE_HOME", "TMPDIR"}
    compose_only = {
        "APP_IMAGE", "CADDY_IMAGE", "HTTP_PORT", "HTTPS_PORT", "SITE_ADDRESS", "TRUSTED_PROXIES"
    }
    found = names | set(re.findall(r"^\s+([A-Z][A-Z0-9_]+):", env_block, re.MULTILINE))
    return found - runtime - compose_only


def test_settings_env_example_and_compose_do_not_drift():
    from core.settings import Settings

    declared = {name.upper() for name in Settings.model_fields}
    documented = _documented()
    assert documented - declared == set(), "documented but not read by the app"
    assert declared - documented == set(), "read by the app but not documented in .env.example"


def test_every_error_has_the_envelope_and_the_request_id(client):
    r = client.get("/api/workouts/nope", headers={"X-Request-ID": "req-123"})
    assert r.status_code == 404 and r.headers["x-request-id"] == "req-123"
    assert r.json() == {"code": "workout_not_found", "detail": None, "request_id": "req-123"}

    r = client.get("/api/week/not-a-date")  # HTTPException with copy
    body = r.json()
    assert (
        r.status_code == 422
        and body["code"] == "bad_date"
        and body["request_id"] == r.headers["x-request-id"]
    )

    r = client.post("/api/changes", json={"ops": "not a list"})  # request validation
    assert r.status_code == 422 and r.json()["code"] == "invalid_request" and r.json()["errors"]

    r = client.post(
        "/api/changes", json={"ops": [{"op": "delete_workout", "id": "missing"}], "reason": "x"}
    )
    assert r.status_code >= 400 and set(r.json()) >= {"code", "detail", "request_id"}  # ChangeError


def test_tenant_refusal_and_unknown_routes_use_the_envelope(anon):
    r = anon.get("/api/week/2026-09-28")
    assert r.status_code == 401 and r.json()["code"] == "signed_out" and r.json()["request_id"]
    r = anon.post("/api/auth/login", json={}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403 and r.json()["code"] == "cross_origin"


def test_unhandled_exception_is_a_500_envelope_and_one_logged_traceback(env, caplog):
    from fastapi.testclient import TestClient

    import main

    app = main.create_app()

    @app.get("/boom")
    def boom():
        raise RuntimeError("internal detail that must not leak")

    with TestClient(app, raise_server_exceptions=False) as c, caplog.at_level(logging.INFO):
        r = c.get("/boom")
    assert r.status_code == 500 and r.json()["code"] == "internal_error"
    assert "internal detail" not in r.text
    rec = [x for x in caplog.records if getattr(x, "event", None) == "http.unhandled_exception"]
    assert len(rec) == 1 and rec[0].exc_info


def test_json_log_lines_carry_request_and_user_ids_and_the_route_template(client):
    import io

    from core.logging import JsonFormatter
    from core.settings import settings

    buf = io.StringIO()
    handler = logging.StreamHandler(buf)
    handler.setFormatter(JsonFormatter(settings()))  # formats at emit time, inside the request
    http = logging.getLogger("sports.http")
    http.addHandler(handler)
    try:
        client.get("/api/week/2026-09-28", headers={"X-Request-ID": "trace-me"})
        client.post("/api/garmin/upload", files={"file": ("x.fit", b"x")})  # its own router
    finally:
        http.removeHandler(handler)
    out = [json.loads(line) for line in buf.getvalue().splitlines()]
    assert any(x.get("route") == "/api/garmin/upload" for x in out)
    line = next(x for x in out if x.get("route") == "/api/week/{monday}")
    assert line["event"] == "http.request" and "2026-09-28" not in line["msg"]
    assert (
        line["status"] == 200
        and line["service"] == "sports-api"
        and line["request_id"] == "trace-me"
    )
    assert line["user_id"] is not None and isinstance(line["duration_ms"], float)


def test_tenant_401_logs_the_api_area_not_unmatched(anon, caplog):
    with caplog.at_level(logging.INFO):
        anon.get("/api/week/2026-09-28/notes")
    line = next(
        x
        for x in caplog.records
        if getattr(x, "event", None) == "http.request" and getattr(x, "status", None) == 401
    )
    assert line.route == "/api/week"
    assert "2026-09-28" not in line.getMessage()


def test_log_formatter_drops_secret_looking_keys():
    from core.logging import JsonFormatter
    from core.settings import settings

    rec = logging.makeLogRecord(
        {"msg": "x", "api_key": "k", "session_token": "t", "input_tokens": 5}
    )
    out = json.loads(JsonFormatter(settings()).format(rec))
    assert "api_key" not in out and "session_token" not in out and out["input_tokens"] == 5


def test_eval_accounts_follow_each_runs_data_dir(tmp_path, monkeypatch):
    """`--model a --model b`: the second run's accounts go to the second run's data dir, not the
    first one cached in settings."""
    from evals import run

    monkeypatch.setenv("DATA_DIR", "x")  # restored on teardown; make_accounts sets the real values
    monkeypatch.setenv("FAKE_TODAY", "2026-10-14")
    first, second = tmp_path / "one", tmp_path / "two"
    assert len(run.make_accounts(first, 1)) == 1 and (first / "auth.db").exists()
    assert len(run.make_accounts(second, 2)) == 2 and (second / "auth.db").exists()


def test_production_refuses_to_start_without_the_runner_or_with_a_pinned_date(monkeypatch):
    import main
    from core import settings as config

    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.delenv("PYRUNNER_URL", raising=False)
    monkeypatch.delenv("FAKE_TODAY", raising=False)
    with pytest.raises(config.SettingsError, match="PYRUNNER_URL") as e:
        main.create_app()
    assert "FAKE_TODAY" not in str(e.value)

    monkeypatch.setenv("PYRUNNER_URL", "http://pyrunner:8090")
    monkeypatch.setenv("FAKE_TODAY", "2026-10-14")
    with pytest.raises(config.SettingsError, match="FAKE_TODAY") as e:
        main.create_app()
    assert "2026-10-14" not in str(e.value) and "pyrunner:8090" not in str(e.value)

    monkeypatch.delenv("FAKE_TODAY")
    main.create_app()  # a correctly configured production process starts

    monkeypatch.setenv("APP_ENV", "dev")  # development needs neither
    monkeypatch.delenv("PYRUNNER_URL")
    monkeypatch.setenv("FAKE_TODAY", "2026-10-14")
    main.create_app()
