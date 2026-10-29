"""Operator CLI (decision 23). There is no admin role in the app; account operations happen
here, on the server:

    docker compose exec app python -m accounts.admin list
    … create <user>                invite: a temporary password and a message to send them
    … reset-password <user>        one-time password, must be changed at next sign-in
    … disable <user> | enable <user>
    … delete <user>                keeps a copy of the folder under data/deleted/ first
    … set-limit <user> <n|default> weekly assistant turns (-1 = unlimited)
    … usage                        this week's assistant turns per user, and the total
    … reset-usage <user>           forget this week's assistant turns for one user
    … restore <user> <archive.zip> restore a personal archive into an EMPTY account

It never prints anyone's training or health data. Sign-up is invite-only (no public route):
see docs/self-hosting.md for the message template and the rest of the routine.
"""

from __future__ import annotations

import argparse
import asyncio
import secrets
import sys
from pathlib import Path

from sqlalchemy import delete, select

import db
from accounts import passwords, service
from accounts.models import UsageEvent, User, UserSession
from core.settings import settings

INVITE = """Hi! Here's your account for Training Studio.

  {url}
  Username: {username}
  Temporary password: {password}

You'll pick your own password on first login."""


def _user(s, name: str) -> User:
    u = s.scalars(
        select(User).where(User.username_canonical == passwords.canonical_username(name))
    ).first()
    if u is None:
        sys.exit(f"No such user: {name}")
    return u


def _size(uid: int) -> str:
    return f"{db.storage_bytes(uid) / 1e6:.1f} MB"


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="accounts.admin")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    sub.add_parser("usage")
    for c in ("create", "reset-password", "reset-usage", "disable", "enable", "delete"):
        sub.add_parser(c).add_argument("user")
    sl = sub.add_parser("set-limit")
    sl.add_argument("user")
    sl.add_argument("turns")
    rs = sub.add_parser("restore")
    rs.add_argument("user")
    rs.add_argument("archive", type=Path)
    a = ap.parse_args(argv)
    db.init()
    with db.auth_db().session() as s:
        if a.cmd == "create":
            temp = secrets.token_urlsafe(12)
            try:
                u = asyncio.run(service.register(s, a.user, temp))
            except service.UsernameTaken:
                sys.exit(f"Username taken: {a.user}")
            except service.InvalidInput as e:
                sys.exit(e.detail)
            u.must_change_password = True
            s.commit()
            print(f"Created {u.username_display} (id {u.id}). Send them this:\n")
            print(INVITE.format(url=settings().public_url, username=u.username_display, password=temp))
        elif a.cmd == "list":
            for u in s.scalars(select(User).order_by(User.id)):
                flags = [
                    f
                    for f, on in (
                        ("disabled", u.disabled),
                        ("must-change-password", u.must_change_password),
                    )
                    if on
                ]
                print(
                    f"{u.id:>3}  {u.username_display:<20} created {u.created_at:%Y-%m-%d}  "
                    f"last login {u.last_login_at:%Y-%m-%d %H:%M}"
                    if u.last_login_at
                    else f"{u.id:>3}  {u.username_display:<20} created {u.created_at:%Y-%m-%d}  never signed in",
                    f" {_size(u.id)} of {settings().user_storage_quota_mb} MB",
                    " ".join(flags),
                )
        elif a.cmd == "usage":
            for u in s.scalars(select(User).order_by(User.id)):
                use = service.usage(s, u)
                lim = "unlimited" if use.limit < 0 else use.limit
                src = (
                    f"(set by {u.limit_updated_by})"
                    if u.weekly_turn_limit is not None
                    else "(default)"
                )
                print(f"{u.username_display:<20} {use.used:>4} / {lim} {src}")
            cap = settings().assistant_global_weekly_turns
            print(
                f"{'all accounts':<20} {service.global_turns(s):>4} / {'unlimited' if cap < 0 else cap} (global cap)"
            )
        else:
            u = _user(s, a.user)
            if a.cmd == "reset-password":
                temp = secrets.token_urlsafe(12)
                asyncio.run(service.set_password(s, u, temp))
                u.must_change_password = True
                s.execute(delete(UserSession).where(UserSession.user_id == u.id))
                s.commit()
                print(
                    f"Temporary password for {u.username_display}: {temp}\nIt must be changed at next sign-in; "
                    "all their sessions were signed out."
                )
            elif a.cmd == "reset-usage":
                n = s.execute(
                    delete(UsageEvent)
                    .where(UsageEvent.user_id == u.id)
                    .where(UsageEvent.kind == "assistant_turn")
                    .where(UsageEvent.at >= service.week_start_utc())
                ).rowcount
                s.commit()
                print(
                    f"{u.username_display}: forgot {n} assistant turn{'s' if n != 1 else ''} this week"
                )
            elif a.cmd in ("disable", "enable"):
                u.disabled = a.cmd == "disable"
                if u.disabled:
                    s.execute(delete(UserSession).where(UserSession.user_id == u.id))
                s.commit()
                print(f"{u.username_display}: {'disabled' if u.disabled else 'enabled'}")
            elif a.cmd == "delete":
                if (
                    input(
                        f"Type '{u.username_canonical}' to delete this account and its data: "
                    ).strip()
                    != u.username_canonical
                ):
                    sys.exit("Not confirmed.")
                kept = service.delete_user(s, u, backup=True)
                print(
                    f"Deleted. A copy of their folder is at {kept}"
                    if kept
                    else "Deleted (no data folder)."
                )
            elif a.cmd == "set-limit":
                u.weekly_turn_limit = None if a.turns == "default" else int(a.turns)
                u.limit_updated_by = "operator-cli"
                s.commit()
                print(f"{u.username_display}: weekly turns = {a.turns}")
            elif a.cmd == "restore":
                from export.restore import restore

                db.forget_user(u.id)
                with db.as_user(u.id):
                    print(restore(a.archive))


if __name__ == "__main__":
    main()
