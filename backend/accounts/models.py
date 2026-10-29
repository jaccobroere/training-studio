"""Account-level tables. They live in their own database (`auth.db`), separate from every
user's data: this file knows who exists, never what they trained."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from models.base import utcnow


class AuthBase(DeclarativeBase):
    pass


class User(AuthBase):
    """One account. `username_canonical` (NFKC + casefold, ASCII-only) carries the unique
    index; `username_display` is what was typed. `password_hash` is a full argon2id PHC string
    (salt and parameters inside). Each user's data lives in `users/<id>/`."""

    __tablename__ = "user"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username_canonical: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    username_display: Mapped[str] = mapped_column(String(32))
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    disabled: Mapped[bool] = mapped_column(Boolean, default=False)
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)
    weekly_turn_limit: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )  # None = server default
    limit_updated_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    assistant_consent_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    onboarded_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    privacy_seen_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class UserSession(AuthBase):
    """A signed-in browser. Only the sha256 of the 256-bit token is stored."""

    __tablename__ = "user_session"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    user_agent: Mapped[str] = mapped_column(String(200), default="")


class RateLimit(AuthBase):
    """Weighted fixed window (adapted from Slidesearch): the window starts at the key's first
    hit; a denied check consumes nothing."""

    __tablename__ = "rate_limit"

    key: Mapped[str] = mapped_column(String(120), primary_key=True)
    count: Mapped[int] = mapped_column(Integer, default=0)
    window_start: Mapped[datetime] = mapped_column(DateTime)


class UsageEvent(AuthBase):
    """Append-only usage ledger (one row per successful assistant turn), summed at read time."""

    __tablename__ = "usage_event"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, index=True)
    kind: Mapped[str] = mapped_column(String(24))
    at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
