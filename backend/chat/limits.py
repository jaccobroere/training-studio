"""Assistant admission control (decisions 25 and 28, plus wbso-tracker's two extra guards).

Checked in this order, before anything slow happens:
0. a global weekly cap across all accounts (`ASSISTANT_GLOBAL_WEEKLY_TURNS`): one shared
   Ollama key is one bill, so past it the assistant pauses for everyone until Monday;
1. the weekly turn quota (usage ledger in auth.db, recorded only for completed turns);
2. a per-user per-minute window (`ASSISTANT_PER_MINUTE`) — the fixed-window
   limiter in accounts.service, so it survives restarts and is purged with the account;
3. a global concurrency cap (`ASSISTANT_CONCURRENCY`) on turns in flight across
   all users: excess turns are shed with 429 instead of queueing behind the model.
Each refusal is a 429 with `Retry-After` and a stable `code`.
"""

from __future__ import annotations

import threading
from datetime import timedelta

from fastapi.responses import JSONResponse

import db
from accounts import service as accounts
from accounts.models import User
from core.errors import error_response
from core.settings import settings
from models.base import utcnow


def per_minute() -> int:
    return settings().assistant_per_minute


def concurrency() -> int:
    return settings().assistant_concurrency


class Slots:
    """Non-blocking counter of turns in flight (one process, many threads/tasks)."""

    def __init__(self):
        self._lock = threading.Lock()
        self.active = 0

    def acquire(self) -> bool:
        with self._lock:
            if self.active >= concurrency():
                return False
            self.active += 1
            return True

    def release(self) -> None:
        with self._lock:
            self.active = max(0, self.active - 1)


SLOTS = Slots()


def _429(code: str, detail: str, retry_after: int, **extra) -> JSONResponse:
    return error_response(
        429,
        code,
        detail,
        headers={"Retry-After": str(max(1, retry_after))},
        retry_after=retry_after,
        **extra,
    )


def admit(uid: int) -> JSONResponse | None:
    """Quota + per-minute checks (the slot is taken separately, around the stream)."""
    with db.auth_db().session() as s:
        user = s.get(User, uid)
        use = accounts.usage(s, user)
        cap = settings().assistant_global_weekly_turns
        if cap >= 0 and accounts.global_turns(s) >= cap:
            return _429(
                "global_quota_exceeded",
                "The assistant is paused for everyone this week; it's back on Monday.",
                int((use.resets_at - utcnow()).total_seconds()),
            )
        if use.exhausted:
            return _429(
                "quota_exceeded",
                f"You've used all {use.limit} assistant turns this week.",
                int((use.resets_at - utcnow()).total_seconds()),
                **use.as_dict(),
            )
        lim = accounts.hit(
            s, f"assistant:user:{uid}:minute", max_count=per_minute(), window=timedelta(minutes=1)
        )
    if not lim.allowed:
        return _429(
            "rate_limited", "Too many messages in a minute; wait a moment.", lim.retry_after
        )
    return None


def busy() -> JSONResponse:
    return _429("busy", "The assistant is busy right now; try again in a few seconds.", 5)
