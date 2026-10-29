"""Tenant middleware (pure ASGI, so the context variable reaches every endpoint, thread and
streamed response). For each /api request it resolves the session cookie to a user and runs
the request as that user; anything without a valid session gets 401. Unsafe methods must
come from this origin (Sec-Fetch-Site / Origin), which, with SameSite=Lax cookies, closes
CSRF without tokens."""

from __future__ import annotations

import json
from http.cookies import SimpleCookie

import db
from accounts import service
from core.errors import envelope
from core.logging import bind_log_context

COOKIE = "__Host-sts_session"
DEV_COOKIE = "sts_session"
PUBLIC = ("/api/auth/login", "/api/auth/status")  # invite-only: no sign-up route
PASSWORD_CHANGE_OK = ("/api/auth/",)
UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}


def _cookie_token(headers: dict[str, str], *, allow_dev: bool) -> str | None:
    raw = headers.get("cookie")
    if not raw:
        return None
    c = SimpleCookie()
    try:
        c.load(raw)
    except Exception:  # noqa: BLE001 - malformed Cookie header means no token
        return None
    names = (COOKIE, DEV_COOKIE) if allow_dev else (COOKIE,)
    for name in names:
        if name in c:
            return c[name].value
    return None


def request_scheme(headers: dict[str, str], fallback: str = "") -> str:
    """The scheme Caddy saw. X-Forwarded-Proto wins because uvicorn runs with
    --proxy-headers in production; the fallback keeps tests and a direct ASGI run on
    the same rule instead of quietly trusting a different value."""
    return (
        (headers.get("x-forwarded-proto") or fallback or "http")
        .split(",", 1)[0]
        .strip()
        .lower()
    )


def session_token(headers: dict[str, str], *, scheme: str = "") -> str | None:
    """The session token this request may use. One reader for the public /status route
    and the tenant middleware: the unprefixed dev cookie is accepted only over plain
    HTTP (a sibling subdomain could otherwise fixate a browser without __Host-)."""
    return _cookie_token(headers, allow_dev=request_scheme(headers, scheme) != "https")


def same_origin(method: str, headers: dict[str, str], host: str) -> bool:
    if method not in UNSAFE:
        return True
    site = headers.get("sec-fetch-site")
    if site is not None:
        return site in ("same-origin", "none")
    origin = headers.get("origin")
    if origin is None:
        return True  # not a browser (curl, tests); cookies still required
    return origin.split("://", 1)[-1] == host


async def _deny(send, status: int, code: str, detail: str):
    body = json.dumps(envelope(code, detail)).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


class TenantMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/api/"):
            return await self.app(scope, receive, send)
        path = scope["path"]
        # An edge ban tool counts failed sign-ins by the URI the proxy *logged*.
        # `/api/%61uth/login` is decoded by ASGI and would route here, but it is logged verbatim,
        # so a rule matching `/api/auth` would never see it. Refuse any encoded `/api/auth/` path
        # (404, not a refusal that hints at a route) so every real attempt is logged as `/api/auth`; raw_path excludes the query string.
        if path.startswith("/api/auth/") and b"%" in (scope.get("raw_path") or b""):
            return await _deny(send, 404, "not_found", "Not found.")
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        host = headers.get("x-forwarded-host") or headers.get("host", "")
        if not same_origin(scope["method"], headers, host):
            return await _deny(send, 403, "cross_origin", "Cross-site request refused.")
        if path.startswith(PUBLIC):
            return await self.app(scope, receive, send)
        scheme = request_scheme(headers, scope.get("scheme") or "")
        with db.auth_db().session() as s:
            user = service.resolve(s, session_token(headers, scheme=scheme))
            uid = user.id if user else None
            must_change = bool(user and user.must_change_password)
        if uid is None:
            return await _deny(send, 401, "signed_out", "Sign in to continue.")
        if must_change and not path.startswith(PASSWORD_CHANGE_OK):
            return await _deny(
                send, 403, "password_change_required", "Choose a new password first."
            )
        scope.setdefault("state", {})["user_id"] = uid
        bind_log_context(user_id=uid)
        with db.as_user(uid):
            await self.app(scope, receive, send)
