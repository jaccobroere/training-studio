"""Accounts, sessions, tenant isolation, limits (decisions 19–25, 28)."""

from __future__ import annotations

from datetime import UTC

from conftest import PASSWORD, invite, seed_week, signup
from fastapi.testclient import TestClient


def other_browser():
    import main

    return TestClient(main.app)


def test_every_data_route_needs_a_session(anon):  # A30
    for path in (
        "/api/week/2026-09-28",
        "/api/profile",
        "/api/exercises",
        "/api/inbox",
        "/api/garmin/status",
        "/api/health/overview",
        "/api/pinned",
        "/api/export/archive",
        "/api/chat/threads",
        "/api/auth/me",
        "/api/analyses",
    ):
        r = anon.get(path)
        assert r.status_code == 401 and r.json()["code"] == "signed_out", path
    assert anon.get("/api/auth/status").json()["signed_in"] is False
    assert anon.get("/health").status_code == 200


def test_forged_headers_do_not_authenticate(anon):
    signup(anon)
    fresh = other_browser()
    for h in (
        {"Remote-User": "athlete"},
        {"Cookie": "sts_session=not-a-real-token"},
        {"Cookie": "__Host-sts_session=" + "x" * 200},
    ):
        assert fresh.get("/api/week/2026-09-28", headers=h).status_code == 401


def test_status_and_data_routes_agree_about_the_dev_cookie(anon):
    """The unprefixed cookie is a dev-server session only. Over HTTPS status must say
    signed out, exactly like the tenant middleware, or a stale dev cookie remounts the
    app while every data call 401s. It also expires the useless cookie so the browser
    heals without anyone clearing site data."""
    me = signup(anon)
    dev = anon.cookies.get("sts_session")
    assert dev and me["username"]

    cookie = {"Cookie": f"sts_session={dev}"}
    fresh = other_browser()
    # Plain HTTP is the local dev server, where the unprefixed cookie is valid.
    http = fresh.get("/api/auth/status", headers=cookie)
    assert http.json()["signed_in"] is True
    assert http.headers.get_list("set-cookie") == []

    # Behind Caddy over HTTPS the dev cookie is ignored by both routes.
    https = {**cookie, "X-Forwarded-Proto": "https"}
    r = fresh.get("/api/auth/status", headers=https)
    assert r.json()["signed_in"] is False
    deleted = r.headers.get_list("set-cookie")
    assert any("sts_session=" in v and "Max-Age=0" in v for v in deleted), deleted
    assert not any("__Host-sts_session=" in v for v in deleted), deleted
    data = fresh.get("/api/week/2026-09-28", headers=https)
    assert data.status_code == 401 and data.json()["code"] == "signed_out"


def test_status_and_data_routes_agree_on_every_cookie_combination(anon):
    """#292 made status and the tenant middleware disagree. One reader must accept exactly
    the same names on the same scheme for none / __Host- only / dev only / both."""
    import db
    from accounts import service
    from accounts.middleware import COOKIE, DEV_COOKIE
    from accounts.models import User

    me = signup(anon)
    with db.auth_db().session() as s:
        user = s.get(User, me["id"])
        assert user is not None
        token = service.start_session(s, user, "cookie-matrix")

    combinations = {
        "none": None,
        "__Host- only": f"{COOKIE}={token}",
        "dev only": f"{DEV_COOKIE}={token}",
        "both": f"{COOKIE}={token}; {DEV_COOKIE}={token}",
    }
    for scheme in ("http", "https"):
        for name, cookie in combinations.items():
            headers = {"X-Forwarded-Proto": scheme}
            if cookie:
                headers["Cookie"] = cookie
            fresh = other_browser()
            status = fresh.get("/api/auth/status", headers=headers)
            data = fresh.get("/api/auth/me", headers=headers)
            accepted = name in {"__Host- only", "both"} or (
                name == "dev only" and scheme == "http"
            )
            assert status.status_code == 200, (scheme, name, status.text)
            assert status.json()["signed_in"] is accepted, (scheme, name, status.json())
            assert (data.status_code == 200) is accepted, (scheme, name, data.status_code)
            deleted = status.headers.get_list("set-cookie")
            if scheme == "https" and name == "dev only":
                assert any(
                    f"{DEV_COOKIE}=" in value and "Max-Age=0" in value for value in deleted
                ), (scheme, name, deleted)
                assert not any(f"{COOKIE}=" in value for value in deleted), deleted
            else:
                assert deleted == [], (scheme, name, deleted)


def test_users_are_completely_isolated(anon):
    """The core guarantee: another account sees none of your plan, history, data, chats."""
    a = anon
    signup(a, "alice")
    seed_week(a)
    assert (
        a.put("/api/profile", json={"markdown": "# Alice only", "base_version": 1}).status_code
        == 200
    )
    b = other_browser()
    signup(b, "bob")
    wa, wb = a.get("/api/week/2026-09-28").json(), b.get("/api/week/2026-09-28").json()
    assert sum(len(d["workouts"]) for d in wa["days"]) == 3
    assert sum(len(d["workouts"]) for d in wb["days"]) == 0 and wb["new_account"] is True
    assert "Alice" not in b.get("/api/profile").json()["current"]["markdown"]
    assert b.get("/api/changes").json() == []
    r = b.post(
        "/api/changes",
        json={"ops": [{"op": "set_workout_status", "id": "w-easy", "status": "skipped"}]},
    )
    assert (
        r.status_code == 422 and r.json()["code"] == "workout_not_found"
    )  # can't reach Alice's rows
    assert len(b.get("/api/exercises").json()) >= 40  # bob got his own starter list


def test_login_logout_and_bad_credentials(anon):
    signup(anon, "Carol")
    anon.post("/api/auth/logout")
    assert anon.get("/api/auth/me").status_code == 401
    r = anon.post("/api/auth/login", json={"username": "carol", "password": "wrong password!"})
    assert r.status_code == 401 and r.json()["code"] == "bad_credentials"
    r = anon.post("/api/auth/login", json={"username": "nobody", "password": "wrong password!"})
    assert r.status_code == 401 and r.json()["code"] == "bad_credentials"  # same answer
    r = anon.post("/api/auth/login", json={"username": "CAROL", "password": PASSWORD})
    assert r.status_code == 200 and r.json()["username"] == "Carol"
    assert anon.get("/api/auth/me").status_code == 200


def test_percent_encoded_auth_paths_are_refused(anon):
    """ASGI decodes the path but a proxy logs the raw URI, so `/api/%61uth/login` would route to
    the login handler while the access log (and any ban rule matching `/api/auth`)
    never saw it. Encoded auth paths answer 404; the canonical path still reaches the route."""
    r = anon.post("/api/%61uth/login", json={"username": "nobody", "password": "wrong password!"})
    assert r.status_code == 404 and r.json()["code"] == "not_found"
    assert anon.get("/api/auth/%73tatus").status_code == 404
    r = anon.post("/api/auth/login", json={"username": "nobody", "password": "wrong password!"})
    assert r.status_code == 401 and r.json()["code"] == "bad_credentials"


def test_there_is_no_public_sign_up(anon, client):
    body = {"username": "mallory", "password": PASSWORD}
    fresh = other_browser()
    assert fresh.post("/api/auth/register", json=body).status_code == 401  # not public any more
    assert client.post("/api/auth/register", json=body).status_code == 404  # and no such route


def test_create_invites_with_a_forced_password_change(anon, capsys, monkeypatch):
    from accounts import admin

    monkeypatch.setenv("PUBLIC_URL", "https://training.example.com")
    admin.main(["create", "Nina"])
    out = capsys.readouterr().out
    assert (
        "https://training.example.com" in out and "Username: Nina" in out and "first login" in out
    )
    temp = out.split("Temporary password: ", 1)[1].split()[0]
    assert len(temp) >= 16
    r = anon.post("/api/auth/login", json={"username": "nina", "password": temp})
    assert r.status_code == 200 and r.json()["must_change_password"] is True
    assert r.json()["privacy_seen"] is False
    r = anon.get("/api/week/2026-09-28")
    assert r.status_code == 403 and r.json()["code"] == "password_change_required"
    assert (
        anon.post("/api/auth/password", json={"current": temp, "new": PASSWORD}).status_code == 200
    )
    assert anon.get("/api/week/2026-09-28").status_code == 200
    assert len(anon.get("/api/exercises").json()) >= 40  # provisioned like any account


def test_create_rules(anon):
    import pytest

    from accounts import admin

    for bad in ("ab", "has space"):
        with pytest.raises(SystemExit):
            admin.main(["create", bad])
    invite("frank")
    with pytest.raises(SystemExit, match="taken"):
        admin.main(["create", "FRANK"])


def test_privacy_note_is_acknowledged_once(client):
    assert client.get("/api/auth/me").json()["privacy_seen"] is False
    assert client.post("/api/auth/privacy-seen").json() == {"ok": True}
    assert client.get("/api/auth/status").json()["user"]["privacy_seen"] is True


def test_session_cookie_flags(anon):
    temp = invite("gina")
    r = anon.post("/api/auth/login", json={"username": "gina", "password": temp})
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie and "path=/" in cookie
    https = TestClient(__import__("main").app, base_url="https://testserver")
    r = https.post("/api/auth/login", json={"username": "gina", "password": temp})
    c = r.headers["set-cookie"]
    assert c.startswith("__Host-sts_session=") and "Secure" in c and "Domain" not in c


def test_cross_origin_writes_refused(client):
    r = client.post("/api/changes", json={"ops": []}, headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403 and r.json()["code"] == "cross_origin"
    r = client.post("/api/auth/logout", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    assert (
        client.get("/api/auth/me", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 200
    )  # reads fine


def test_login_rate_limit_per_ip(anon):
    """Ten attempts per 15 minutes from one address, whichever usernames they try; a wrong
    password is a 401 (an edge ban tool can count those), the 11th a 429."""
    codes = [
        anon.post(
            "/api/auth/login", json={"username": f"guess{i}", "password": "nope nope nope"}
        ).status_code
        for i in range(11)
    ]
    assert codes == [401] * 10 + [429]


def test_login_rate_limit_per_username(anon, monkeypatch):
    from datetime import timedelta

    from accounts import api

    monkeypatch.setattr(
        api, "LOGIN_PER_IP", (100, timedelta(minutes=15))
    )  # as if from many addresses
    signup(anon, "ivan")
    anon.post("/api/auth/logout")
    codes = [
        anon.post(
            "/api/auth/login", json={"username": "ivan", "password": "nope nope nope"}
        ).status_code
        for _ in range(20)
    ]
    assert codes == [401] * 19 + [429]  # signup's own sign-in used one of the 20
    r = anon.post("/api/auth/login", json={"username": "ivan", "password": PASSWORD})
    assert (
        r.status_code == 429 and int(r.headers["retry-after"]) > 0
    )  # even the right password waits


def test_change_password_ends_other_sessions(anon):
    signup(anon, "judy")
    other = other_browser()
    other.post("/api/auth/login", json={"username": "judy", "password": PASSWORD})
    assert other.get("/api/auth/me").status_code == 200
    r = anon.post(
        "/api/auth/password", json={"current": PASSWORD, "new": "a much better passphrase"}
    )
    assert r.status_code == 200 and r.json()["other_sessions_ended"] == 1
    assert (
        other.get("/api/auth/me").status_code == 401 and anon.get("/api/auth/me").status_code == 200
    )


def test_operator_reset_forces_change(anon, capsys):
    from accounts import admin

    signup(anon, "kim")
    admin.main(["reset-password", "kim"])
    temp = capsys.readouterr().out.split(": ", 1)[1].split()[0]
    assert anon.get("/api/auth/me").status_code == 401  # sessions ended
    anon.post("/api/auth/login", json={"username": "kim", "password": temp})
    r = anon.get("/api/week/2026-09-28")
    assert r.status_code == 403 and r.json()["code"] == "password_change_required"
    assert (
        anon.post(
            "/api/auth/password", json={"current": temp, "new": "brand new passphrase"}
        ).status_code
        == 200
    )
    assert anon.get("/api/week/2026-09-28").status_code == 200


def test_disable_and_delete(anon, env):
    from accounts import admin

    me = signup(anon, "leo")
    folder = env / "users" / str(me["id"])
    assert (folder / "app.db").exists()
    admin.main(["disable", "leo"])
    assert anon.get("/api/auth/me").status_code == 401
    admin.main(["enable", "leo"])
    anon.post("/api/auth/login", json={"username": "leo", "password": PASSWORD})
    r = anon.post("/api/auth/delete", json={"password": PASSWORD, "confirm": "wrong"})
    assert r.status_code == 422
    r = anon.post("/api/auth/delete", json={"password": PASSWORD, "confirm": "leo"})
    assert r.status_code == 200 and not folder.exists()
    assert (
        anon.post("/api/auth/login", json={"username": "leo", "password": PASSWORD}).status_code
        == 401
    )


def test_assistant_needs_consent_and_respects_weekly_limit(anon, monkeypatch):
    monkeypatch.setenv("OLLAMA_API_KEY", "test")
    signup(anon, "mia")
    body = {
        "id": "t1",
        "trigger": "submit-message",
        "messages": [{"id": "u", "role": "user", "parts": [{"type": "text", "text": "hi"}]}],
    }
    r = anon.post("/api/chat", json=body)
    assert r.status_code == 403 and r.json()["code"] == "consent_required"
    anon.post("/api/auth/consent")
    from accounts import admin

    admin.main(["set-limit", "mia", "0"])
    r = anon.post("/api/chat", json=body)
    assert r.status_code == 429 and r.json()["code"] == "quota_exceeded" and r.json()["limit"] == 0
    assert anon.get("/api/auth/me").json()["usage"]["limit"] == 0


def test_week_start_is_amsterdam_monday():
    from datetime import datetime

    from accounts.service import week_start_utc

    # Sunday 23:30 UTC in summer = Monday 01:30 Amsterdam → the week starts that Monday 00:00 CEST
    assert week_start_utc(datetime(2026, 9, 27, 23, 30, tzinfo=UTC)) == datetime(2026, 9, 27, 22, 0)
    # winter (CET, UTC+1)
    assert week_start_utc(datetime(2026, 11, 4, 12, 0, tzinfo=UTC)) == datetime(2026, 11, 1, 23, 0)


def test_a_dev_session_cookie_is_ignored_over_https(anon):
    """sts_session is for plain-HTTP local development only. A sibling subdomain
    can set a Domain cookie with that name; over HTTPS it must not authenticate."""
    from fastapi.testclient import TestClient

    signup(anon)
    token = anon.cookies.get("sts_session")
    assert token
    spoof = TestClient(anon.app, base_url="https://testserver", cookies={"sts_session": token})
    with spoof:
        assert spoof.get("/api/week/2026-09-28").status_code == 401
