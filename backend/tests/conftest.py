from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

TODAY = "2026-09-30"  # a Wednesday; its week starts Mon 2026-09-28
PASSWORD = "correct horse battery"


def invite(username: str) -> str:
    """Create an account the way the operator does (`accounts.admin create`); → the temporary
    password from the message it prints."""
    import contextlib
    import io

    from accounts import admin

    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        admin.main(["create", username])
    return out.getvalue().split("Temporary password: ", 1)[1].split()[0]


def signup(c, username: str = "athlete", password: str = PASSWORD) -> dict:
    """An invited account, signed in on `c` with its own password (the forced first-login
    change done). Returns /api/auth/me."""
    temp = invite(username)
    r = c.post("/api/auth/login", json={"username": username, "password": temp})
    assert r.status_code == 200, r.text
    r = c.post("/api/auth/password", json={"current": temp, "new": password})
    assert r.status_code == 200, r.text
    return c.get("/api/auth/me").json()


def seed_week(c) -> dict[str, str]:
    """A small plan in the week of Mon 28 Sep: title → workout id."""
    ops = [
        {
            "op": "add_workout",
            "id": "w-easy",
            "date": "2026-09-29",
            "title": "Easy run",
            "type": "run",
            "items": [{"exercise_id": "easy-run", "distance_km": 8, "intensity": "easy"}],
        },
        {
            "op": "add_workout",
            "id": "w-gym",
            "date": "2026-09-30",
            "title": "Gym A",
            "type": "strength",
            "tags": ["gym"],
            "items": [
                {"exercise_id": "back-squat", "sets": 3, "reps": "5", "load": "80 kg"},
                {"exercise_id": "plank", "sets": 3, "duration_min": 1},
            ],
        },
        {
            "op": "add_workout",
            "id": "w-long",
            "date": "2026-10-03",
            "title": "Long run",
            "type": "run",
            "tags": ["long"],
            "items": [{"exercise_id": "long-run", "distance_km": 16}],
        },
    ]
    r = c.post("/api/changes", json={"ops": ops, "reason": "seed"})
    assert r.status_code == 200, r.text
    return {"Easy run": "w-easy", "Gym A": "w-gym", "Long run": "w-long"}


@pytest.fixture(autouse=True)
def _settings_follow_env(monkeypatch):
    """Settings are cached per process and read at use time: forget them whenever a test
    changes the environment through monkeypatch, and around every test."""
    from core import settings as config

    set_, del_ = monkeypatch.setenv, monkeypatch.delenv

    def setenv(*a, **kw):
        set_(*a, **kw)
        config.reset()

    def delenv(*a, **kw):
        del_(*a, **kw)
        config.reset()

    monkeypatch.setenv, monkeypatch.delenv = setenv, delenv
    config.reset()
    yield
    config.reset()


@pytest.fixture()
def env(tmp_path, tmp_path_factory, monkeypatch):
    from cryptography.fernet import Fernet

    key = (
        tmp_path_factory.mktemp("secrets") / "garmin_token.key"
    )  # outside DATA_DIR, as in production
    key.write_bytes(Fernet.generate_key())
    monkeypatch.setenv("GARMIN_TOKEN_KEY_FILE", str(key))
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("FAKE_TODAY", TODAY)
    monkeypatch.setenv("JOBS_ENABLED", "0")
    return tmp_path


@pytest.fixture()
def anon(env):
    """A client with no account (for auth tests)."""
    from fastapi.testclient import TestClient

    import main

    with TestClient(main.app) as c:
        yield c


@pytest.fixture()
def client(anon):
    """Signed in as a fresh user (starter exercises + Profile template, no plan); the test
    body runs as that user so domain functions can be called directly."""
    import db

    me = signup(anon)
    assert anon.post("/api/auth/consent").status_code == 200
    token = db.current_user.set(me["id"])
    try:
        yield anon
    finally:
        db.current_user.reset(token)


@pytest.fixture()
def seeded(client):
    seed_week(client)
    return client


def post(client, ops, **kw):
    return client.post("/api/changes", json={"ops": ops, **kw})


def ok(client, ops, **kw) -> dict:
    r = post(client, ops, **kw)
    assert r.status_code == 200, r.text
    return r.json()
