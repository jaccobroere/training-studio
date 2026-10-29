"""Dev only: a ready-to-use preview account for screenshots (agents, local QA).

Creates the account `preview` in an explicit local DATA_DIR if it is missing, marks it as
past the first-login screens (own password, onboarding, privacy notice), and prints a session
cookie `name=value` for http://localhost. Used by `agent_preview.sh`; refuses the production
data directory like `dev_session.py`.

    cd backend && DATA_DIR=/tmp/sports-preview uv run python ../scripts/agent_preview.py
"""

from __future__ import annotations

import asyncio
import os
import secrets
import sys

sys.path.insert(0, os.getcwd())

from sqlalchemy import select  # noqa: E402

import db  # noqa: E402
from accounts import passwords, service  # noqa: E402
from accounts.middleware import DEV_COOKIE  # noqa: E402
from accounts.models import User  # noqa: E402
from models.base import utcnow  # noqa: E402

USERNAME = "preview"

_data = os.getenv("DATA_DIR")
if not _data:
    sys.exit("Refusing: set DATA_DIR explicitly to a local preview data directory.")
if os.path.realpath(_data) in ("/data", os.path.realpath("/app/data")):
    sys.exit("Refusing: DATA_DIR is a production data directory.")

db.init()
with db.auth_db().session() as s:
    user = s.scalars(
        select(User).where(User.username_canonical == passwords.canonical_username(USERNAME))
    ).first()
    if user is None:
        user = asyncio.run(service.register(s, USERNAME, secrets.token_urlsafe(16)))
    now = utcnow()
    user.must_change_password = False
    user.onboarded_at = user.onboarded_at or now
    user.privacy_seen_at = user.privacy_seen_at or now
    s.commit()
    print(f"{DEV_COOKIE}={service.start_session(s, user, 'agent-preview')}")
