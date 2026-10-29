"""Account routes. Error bodies carry stable codes; login never says which half was wrong."""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

import db
from accounts import passwords, service
from accounts.middleware import COOKIE, DEV_COOKIE, request_scheme, session_token
from accounts.models import User, UserSession
from db import get_auth_session
from models.base import utcnow

router = APIRouter(prefix="/api/auth")

# Invite-only: accounts are created by the operator (`accounts.admin create`). The IP window
# is the real guard; the per-name one only backstops guesses spread over many addresses and
# is loose enough that a stranger can't easily lock a friend out. A wrong password is a 401
# (so a ban tool such as fail2ban or CrowdSec at the edge can count those).
LOGIN_PER_IP = (10, timedelta(minutes=15))
LOGIN_PER_NAME = (20, timedelta(hours=1))


class Credentials(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=passwords.PASSWORD_MAX)


class NewPassword(BaseModel):
    current: str = Field(min_length=1, max_length=passwords.PASSWORD_MAX)
    new: str = Field(min_length=1, max_length=passwords.PASSWORD_MAX)


class Confirm(BaseModel):
    password: str = Field(min_length=1, max_length=passwords.PASSWORD_MAX)
    confirm: str = ""


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _scheme(request: Request) -> str:
    return request_scheme(dict(request.headers), request.url.scheme)


def _secure(request: Request) -> bool:
    return _scheme(request) == "https"


def _token(request: Request) -> str | None:
    return session_token(dict(request.headers), scheme=_scheme(request))


def _set_cookie(response: Response, request: Request, raw: str) -> None:
    secure = _secure(request)
    response.set_cookie(
        COOKIE if secure else DEV_COOKIE,
        raw,
        httponly=True,
        secure=secure,
        samesite="lax",
        path="/",
        max_age=service.SESSION_MAX_DAYS * 86400,
    )


def _delete_cookie(response: Response, name: str, *, secure: bool) -> None:
    response.delete_cookie(name, path="/", httponly=True, secure=secure, samesite="lax")


def _clear_cookie(response: Response, request: Request) -> None:
    secure = _secure(request)
    for name in (COOKIE, DEV_COOKIE):
        _delete_cookie(response, name, secure=secure)


def _limited(lim: service.Limit, what: str):
    raise HTTPException(
        429,
        {
            "code": "rate_limited",
            "detail": f"Too many {what}. Try again later.",
            "retry_after": lim.retry_after,
        },
        headers={"Retry-After": str(lim.retry_after)},
    )


def limit_user(request: Request, key: str, limit: tuple[int, timedelta], what: str) -> None:
    """Per-user fixed window on an expensive endpoint. `key` is `<area>:<name>`; it becomes
    `<area>:user:<id>:<name>` so deleting the account purges it. 429 when spent."""
    area, name = key.split(":", 1)
    uid = request.scope["state"]["user_id"]
    with db.auth_db().session() as s:
        lim = service.hit(s, f"{area}:user:{uid}:{name}", max_count=limit[0], window=limit[1])
    if not lim.allowed:
        _limited(lim, what)


async def _busy(coro):
    try:
        return await coro
    except passwords.Busy as e:
        raise HTTPException(
            429,
            {"code": "busy", "detail": "The server is busy. Try again in a moment."},
            headers={"Retry-After": "2"},
        ) from e


def current(request: Request, s: Session = Depends(get_auth_session)) -> User:
    uid = request.scope.get("state", {}).get("user_id")
    user = s.get(User, uid) if uid else None
    if user is None:
        raise HTTPException(401, {"code": "signed_out"})
    return user


def me_view(s: Session, user: User) -> dict:
    return {
        "id": user.id,
        "username": user.username_display,
        "created_at": user.created_at.isoformat() + "Z",
        "must_change_password": user.must_change_password,
        "assistant_consent": user.assistant_consent_at is not None,
        "onboarded": user.onboarded_at is not None,
        "privacy_seen": user.privacy_seen_at is not None,
        "usage": service.usage(s, user).as_dict(),
    }


@router.get("/status")
def status(
    request: Request, response: Response, s: Session = Depends(get_auth_session)
) -> dict:
    headers = dict(request.headers)
    scheme = request_scheme(headers, request.url.scheme)
    user = service.resolve(s, session_token(headers, scheme=scheme))
    if scheme == "https" and user is None and DEV_COOKIE in request.cookies:
        # This origin can never accept the unprefixed cookie. Expire it so a browser
        # carrying an old dev session stops presenting it after the sign-in screen.
        # Only the dev name: a valid __Host- session is never touched (user is None here).
        _delete_cookie(response, DEV_COOKIE, secure=True)
    return {
        "signed_in": user is not None,
        "user": me_view(s, user) if user else None,
        "password_min": passwords.ACCOUNT_PASSWORD_MIN,
        "notice": "There is no email on accounts, so a forgotten password can only be reset by the operator.",
    }


@router.post("/login")
async def login(
    body: Credentials, request: Request, response: Response, s: Session = Depends(get_auth_session)
) -> dict:
    ip = service.hit(
        s, f"login:ip:{client_ip(request)}", max_count=LOGIN_PER_IP[0], window=LOGIN_PER_IP[1]
    )
    name = service.hit(
        s,
        f"login:name:{passwords.canonical_username(body.username)[:40]}",
        max_count=LOGIN_PER_NAME[0],
        window=LOGIN_PER_NAME[1],
    )
    if not ip.allowed or not name.allowed:
        _limited(ip if not ip.allowed else name, "sign-in attempts")
    user = await _busy(service.authenticate(s, body.username, body.password))
    if user is None:
        raise HTTPException(
            401, {"code": "bad_credentials", "detail": "Wrong username or password."}
        )
    _set_cookie(
        response, request, service.start_session(s, user, request.headers.get("user-agent", ""))
    )
    return me_view(s, user)


@router.post("/logout")
def logout(request: Request, response: Response, s: Session = Depends(get_auth_session)) -> dict:
    service.end_session(s, _token(request))
    _clear_cookie(response, request)
    return {"ok": True}


@router.get("/me")
def me(user: User = Depends(current), s: Session = Depends(get_auth_session)) -> dict:
    return me_view(s, user)


@router.post("/password")
async def change_password(
    body: NewPassword,
    request: Request,
    user: User = Depends(current),
    s: Session = Depends(get_auth_session),
) -> dict:
    lim = service.hit(s, f"password:user:{user.id}:change", max_count=8, window=timedelta(hours=1))
    if not lim.allowed:
        _limited(lim, "password attempts")
    if not await _busy(service.passwords.verify(user.password_hash, body.current)):
        raise HTTPException(
            401, {"code": "bad_credentials", "detail": "Current password is wrong."}
        )
    try:
        await _busy(service.set_password(s, user, body.new))
    except service.InvalidInput as e:
        raise HTTPException(422, {"code": e.code, "detail": e.detail}) from e
    ended = service.end_other_sessions(s, user, _token(request))
    return {"ok": True, "other_sessions_ended": ended}


@router.get("/sessions")
def sessions(
    request: Request, user: User = Depends(current), s: Session = Depends(get_auth_session)
) -> list[dict]:
    mine = service.sha256_hex(_token(request) or "")
    rows = s.scalars(
        select(UserSession)
        .where(UserSession.user_id == user.id)
        .order_by(UserSession.last_seen_at.desc())
    ).all()
    return [
        {
            "current": r.token_hash == mine,
            "created_at": r.created_at.isoformat() + "Z",
            "last_seen_at": r.last_seen_at.isoformat() + "Z",
            "device": r.user_agent[:80],
        }
        for r in rows
    ]


@router.post("/sessions/end-others")
def end_others(
    request: Request, user: User = Depends(current), s: Session = Depends(get_auth_session)
) -> dict:
    return {"ended": service.end_other_sessions(s, user, _token(request))}


@router.post("/consent")
def consent(user: User = Depends(current), s: Session = Depends(get_auth_session)) -> dict:
    user.assistant_consent_at = user.assistant_consent_at or utcnow()
    s.commit()
    return {"ok": True}


@router.post("/privacy-seen")
def privacy_seen(user: User = Depends(current), s: Session = Depends(get_auth_session)) -> dict:
    """The privacy note is shown once, after the first sign-in; this records that it was read."""
    user.privacy_seen_at = user.privacy_seen_at or utcnow()
    s.commit()
    return {"ok": True}


@router.post("/delete")
async def delete_account(
    body: Confirm,
    request: Request,
    response: Response,
    user: User = Depends(current),
    s: Session = Depends(get_auth_session),
) -> dict:
    if body.confirm.strip().lower() != user.username_canonical:
        raise HTTPException(
            422, {"code": "confirm_mismatch", "detail": "Type your username to confirm."}
        )
    if not await _busy(service.passwords.verify(user.password_hash, body.password)):
        raise HTTPException(401, {"code": "bad_credentials", "detail": "Password is wrong."})
    service.delete_user(s, user)
    _clear_cookie(response, request)
    return {"ok": True}
