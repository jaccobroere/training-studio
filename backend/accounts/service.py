"""Accounts, sessions, rate limits and the assistant usage ledger (decisions 20, 23, 25, 28).

Sessions: 256-bit CSPRNG tokens; only their sha256 is stored (a random token needs no slow
hash). A session slides: each use pushes `expires_at` out again, but never past a hard cap
from creation, so a stolen cookie cannot live forever.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import shutil
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

import db
from accounts import passwords
from accounts.models import RateLimit, UsageEvent, User, UserSession
from core.settings import settings
from models.base import utcnow
from plan import clock

TOKEN_BYTES = 32
SESSION_IDLE_DAYS = 30
SESSION_MAX_DAYS = 90


def sha256_hex(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


# ------------------------------------------------------------------ sessions


def start_session(s: Session, user: User, user_agent: str = "") -> str:
    raw = secrets.token_urlsafe(TOKEN_BYTES)
    now = utcnow()
    s.add(
        UserSession(
            token_hash=sha256_hex(raw),
            user_id=user.id,
            created_at=now,
            last_seen_at=now,
            expires_at=now + timedelta(days=SESSION_IDLE_DAYS),
            user_agent=user_agent[:200],
        )
    )
    user.last_login_at = now
    s.commit()
    return raw


def resolve(s: Session, raw: str | None) -> User | None:
    """Session cookie → active user, or None. Expired sessions are deleted on sight."""
    if not raw or len(raw) > 128:
        return None
    row = s.get(UserSession, sha256_hex(raw))
    if row is None:
        return None
    now = utcnow()
    if row.expires_at <= now or row.created_at + timedelta(days=SESSION_MAX_DAYS) <= now:
        s.delete(row)
        s.commit()
        return None
    user = s.get(User, row.user_id)
    if user is None or user.disabled:
        return None
    if now - row.last_seen_at > timedelta(minutes=10):  # slide, but don't write on every request
        row.last_seen_at = now
        row.expires_at = min(
            now + timedelta(days=SESSION_IDLE_DAYS),
            row.created_at + timedelta(days=SESSION_MAX_DAYS),
        )
        s.commit()
    return user


def end_session(s: Session, raw: str | None) -> None:
    if raw:
        s.execute(delete(UserSession).where(UserSession.token_hash == sha256_hex(raw)))
        s.commit()


def end_other_sessions(s: Session, user: User, keep_raw: str | None) -> int:
    keep = sha256_hex(keep_raw) if keep_raw else ""
    n = s.execute(
        delete(UserSession)
        .where(UserSession.user_id == user.id)
        .where(UserSession.token_hash != keep)
    ).rowcount
    s.commit()
    return n


# ------------------------------------------------------------------ credentials


class UsernameTaken(Exception):
    pass


class InvalidInput(Exception):
    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code, self.detail = code, detail


def check_new_password(password: str, username: str = "") -> None:
    if len(password) < passwords.ACCOUNT_PASSWORD_MIN:
        raise InvalidInput(
            "password_too_short", f"Use at least {passwords.ACCOUNT_PASSWORD_MIN} characters."
        )
    if len(password) > passwords.PASSWORD_MAX:
        raise InvalidInput("password_too_long", f"Use at most {passwords.PASSWORD_MAX} characters.")
    if username and passwords.canonical_username(password) == passwords.canonical_username(
        username
    ):
        raise InvalidInput("password_is_username", "The password can't be your username.")


async def register(s: Session, username: str, password: str) -> User:
    canonical = passwords.canonical_username(username)
    if not passwords.valid_username(canonical):
        raise InvalidInput(
            "bad_username", "3–32 characters: letters, digits, dot, dash or underscore."
        )
    check_new_password(password, username)
    if s.scalars(select(User).where(User.username_canonical == canonical)).first():
        raise UsernameTaken()
    user = User(
        username_canonical=canonical,
        username_display=username.strip()[: passwords.USERNAME_MAX],
        password_hash=await passwords.hash_password(password),
    )
    s.add(user)
    s.commit()
    provision(user.id)
    return user


def provision(uid: int) -> None:
    """Create the user's database and install the starter exercise list and the empty
    Profile template. Never a plan."""
    from plan import starter

    with db.as_user(uid):
        with db.get_db().session() as us:
            from athlete_api import get_athlete

            get_athlete(us)
            starter.install(us)


async def authenticate(s: Session, username: str, password: str) -> User | None:
    canonical = passwords.canonical_username(username)
    user = s.scalars(select(User).where(User.username_canonical == canonical)).first()
    ok = await passwords.verify(user.password_hash if user else None, password)
    if not ok or user is None or user.disabled:
        return None
    if passwords.needs_rehash(user.password_hash):
        user.password_hash = await passwords.hash_password(password)
        s.commit()
    return user


async def set_password(s: Session, user: User, new: str) -> None:
    check_new_password(new, user.username_display)
    user.password_hash = await passwords.hash_password(new)
    user.must_change_password = False
    s.commit()


def delete_user(s: Session, user: User, *, backup: bool = False) -> Path | None:
    """Remove the account and its folder. `backup=True` (operator CLI) keeps a copy first."""
    uid = user.id
    db.forget_user(uid)
    root = db.user_root(uid)
    kept = None
    if backup and root.exists():
        dest = db.data_root() / "deleted" / f"user-{uid}-{datetime.now(UTC):%Y%m%dT%H%M%S}"
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(root, dest)
        kept = dest
    s.execute(delete(UserSession).where(UserSession.user_id == uid))
    s.execute(delete(UsageEvent).where(UsageEvent.user_id == uid))
    s.execute(delete(RateLimit).where(RateLimit.key.like(f"%:user:{uid}:%")))
    s.delete(user)
    s.commit()
    shutil.rmtree(root, ignore_errors=True)
    return kept


DELETED_KEEP = timedelta(days=7)


def purge_deleted(older_than: timedelta = DELETED_KEEP) -> int:
    """Remove the safety copies `delete_user(backup=True)` keeps under data/deleted/ once they
    are older than a week (the privacy note promises it). Age comes from the folder's
    timestamp suffix, else its mtime. Returns how many were removed."""
    root = db.data_root() / "deleted"
    if not root.is_dir():
        return 0
    cutoff = datetime.now(UTC) - older_than
    n = 0
    for p in root.iterdir():
        try:
            made = datetime.strptime(p.name.rsplit("-", 1)[-1], "%Y%m%dT%H%M%S").replace(tzinfo=UTC)
        except ValueError:
            made = datetime.fromtimestamp(p.stat().st_mtime, UTC)
        if made < cutoff:
            if p.is_dir():
                shutil.rmtree(p, ignore_errors=True)
            else:
                p.unlink(missing_ok=True)
            n += 1
    return n


# ------------------------------------------------------------------ rate limits


@dataclass
class Limit:
    allowed: bool
    remaining: int
    reset_at: datetime

    @property
    def retry_after(self) -> int:
        return max(1, int((self.reset_at - utcnow()).total_seconds()))


def hit(s: Session, key: str, *, max_count: int, window: timedelta, cost: int = 1) -> Limit:
    """Weighted fixed window. The window starts at the first hit; a denied check consumes
    nothing. Single process + one SQLite writer at a time makes read-modify-write safe."""
    now = utcnow()
    row = s.get(RateLimit, key)
    if row is None:
        row = RateLimit(key=key, count=0, window_start=now)
        s.add(row)
    elif row.window_start + window <= now:
        row.count, row.window_start = 0, now
    allowed = row.count + cost <= max_count
    if allowed:
        row.count += cost
    s.commit()
    return Limit(allowed, max(0, max_count - row.count), row.window_start + window)


def purge_limits(s: Session, older_than: timedelta = timedelta(days=2)) -> None:
    s.execute(delete(RateLimit).where(RateLimit.window_start < utcnow() - older_than))
    s.commit()


# ------------------------------------------------------------------ assistant usage


def week_start_utc(now: datetime | None = None) -> datetime:
    """Monday 00:00 in the athlete timezone, as naive UTC (DST handled by zoneinfo)."""
    local = (now or clock.now()).astimezone(clock.tz())
    start = (local - timedelta(days=local.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    return start.astimezone(UTC).replace(tzinfo=None)


@dataclass
class Usage:
    used: int
    limit: int
    resets_at: datetime

    @property
    def exhausted(self) -> bool:
        return self.limit >= 0 and self.used >= self.limit

    def as_dict(self) -> dict:
        return {
            "used": self.used,
            "limit": self.limit,
            "resets_at": self.resets_at.isoformat() + "Z",
            "exhausted": self.exhausted,
        }


def usage(s: Session, user: User) -> Usage:
    start = week_start_utc()
    used = (
        s.scalar(
            select(func.count())
            .select_from(UsageEvent)
            .where(UsageEvent.user_id == user.id)
            .where(UsageEvent.kind == "assistant_turn")
            .where(UsageEvent.at >= start)
        )
        or 0
    )
    limit = (
        user.weekly_turn_limit
        if user.weekly_turn_limit is not None
        else settings().assistant_weekly_turns
    )
    return Usage(used, limit, start + timedelta(days=7))


def global_turns(s: Session) -> int:
    """Assistant turns this week across every account (the shared key's spend)."""
    return (
        s.scalar(
            select(func.count())
            .select_from(UsageEvent)
            .where(UsageEvent.kind == "assistant_turn")
            .where(UsageEvent.at >= week_start_utc())
        )
        or 0
    )


def record_turn(s: Session, user_id: int) -> None:
    s.add(UsageEvent(user_id=user_id, kind="assistant_turn"))
    s.commit()


def same(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())
