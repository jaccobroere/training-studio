"""Dev only: mint a session cookie for an existing local account without going through /login.

The sign-in rate limits (10 per IP per 15 min, 20 per name per hour) are a real security control, so local browser
testing should not fight it. Create the account once (`python -m accounts.admin create <name>`)
in a dev data dir, then:

    cd backend && DATA_DIR=/tmp/sports-dev uv run python ../scripts/dev_session.py alex

Prints the cookie `name=value` to set on http://localhost (Playwright: context.addCookies).
Needs an explicit DATA_DIR and refuses the production path (/app/data, resolved).
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.getcwd())

from sqlalchemy import select  # noqa: E402

import db  # noqa: E402
from accounts import passwords, service  # noqa: E402
from accounts.middleware import DEV_COOKIE  # noqa: E402
from accounts.models import User  # noqa: E402

_data = os.getenv("DATA_DIR")
if not _data:
    sys.exit("Refusing: set DATA_DIR explicitly to a local dev data directory.")
if os.path.realpath(_data) in ("/data", "/app/data") or os.path.realpath(
    _data
) == os.path.realpath("/app/data"):
    sys.exit("Refusing: DATA_DIR is a production data directory.")
if len(sys.argv) != 2:
    sys.exit("usage: dev_session.py <username>")

db.init()
with db.auth_db().session() as s:
    user = s.scalars(
        select(User).where(
            User.username_canonical == passwords.canonical_username(sys.argv[1])
        )
    ).first()
    if user is None:
        sys.exit(
            f"No such user: {sys.argv[1]} (create it with accounts.admin create first)"
        )
    print(f"{DEV_COOKIE}={service.start_session(s, user, 'dev-session')}")
