"""Runaway alerts: the app has no operator mailer, so it posts one JSON body to
`ALERT_WEBHOOK_URL` when that is set (any webhook receiver: a chat bot, a push service, an
automation tool). Unset or unreachable means the warning is logged and nothing else
breaks: an alert must never take the worker down.

Three checks, each isolated: failed import runs in the last hour (the 2026-10-21 runaway), a
user's storage growing fast since yesterday, and the host's free disk. Every check is debounced
per key so a persistent problem pings at most once per `COOLDOWN_S` (6 hours)."""

from __future__ import annotations

import json
import logging
import os
import shutil
import time
from datetime import UTC, datetime, timedelta
from urllib import request

import db
from core.settings import settings
from models import ImportRun
from models.base import utcnow

log = logging.getLogger("sports.alerts")

CHECK_EVERY_S = 300
COOLDOWN_S = 6 * 3600
STATE_FILE = "alerts-state.json"
TIMEOUT_S = 5

# Monotonic send times per key. Only a successful POST (or a "no webhook configured" warning)
# arms the cooldown, so a broken webhook is retried on the next five-minute check.
_sent_at: dict[str, float] = {}


def _cool(key: str) -> bool:
    last = _sent_at.get(key)
    return last is not None and time.monotonic() - last < COOLDOWN_S


def notify(key: str, title: str, message: str) -> bool:
    """POST one alert. Debounced per key; False when there is no webhook or the POST failed."""
    if _cool(key):
        return False
    url = settings().alert_webhook_url
    if not url:
        _sent_at[key] = time.monotonic()  # one log line per cooldown, not every five minutes
        log.error("alert %s: %s: %s (no ALERT_WEBHOOK_URL set)", key, title, message)
        return False
    body = json.dumps(
        {"app": "sports", "title": title, "message": message, "at": utcnow().isoformat() + "Z"}
    ).encode()
    req = request.Request(url, data=body, headers={"Content-Type": "application/json"})
    token = settings().alert_webhook_token
    if token:
        req.add_header("X-Sports-Token", token.get_secret_value())
    try:
        with request.urlopen(req, timeout=TIMEOUT_S) as resp:
            resp.read()
    except Exception as e:  # noqa: BLE001 - the worker keeps running whatever the webhook does
        log.warning("alert webhook failed for %s: %s", key, e)
        return False  # no cooldown: the next check retries
    _sent_at[key] = time.monotonic()
    return True


def _offer(sent: list[str], key: str, title: str, message: str) -> bool:
    if notify(key, title, message):
        sent.append(key)
        return True
    return False


def _read_state() -> dict:
    try:
        data = json.loads((db.data_root() / STATE_FILE).read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}  # missing or corrupt: rebuild it from what is there now


def _write_state(state: dict) -> None:
    path = db.data_root() / STATE_FILE
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(state, sort_keys=True))
        tmp.replace(path)
    except OSError:
        log.warning("could not write alert state", exc_info=True)


def _uids() -> list[int]:
    from sqlalchemy import select

    from accounts.models import User

    with db.auth_db().session() as s:
        return list(s.scalars(select(User.id).order_by(User.id)))


def _failed_runs(sent: list[str]) -> None:
    from sqlalchemy import func, select

    threshold = settings().alert_failed_runs_per_hour
    since = utcnow() - timedelta(hours=1)
    for uid in _uids():
        key = f"failed-runs:{uid}"
        if _cool(key):
            continue  # skip the query entirely while cooling down
        try:
            with db.as_user(uid), db.get_db().session() as s:
                query = (
                    select(ImportRun)
                    .where(ImportRun.state == "failed")
                    .where(ImportRun.created_at >= since)
                )
                count = s.scalar(select(func.count()).select_from(query.subquery())) or 0
                latest = s.scalars(query.order_by(ImportRun.created_at.desc())).first()
                detail = ""
                if latest is not None:
                    errors = (latest.report or {}).get("errors") or []
                    detail = f" Latest error: {errors[-1] if errors else 'unknown'}"
        except Exception:
            log.exception("failed-run alert check failed for user %s", uid)
            continue
        if count < threshold:
            continue
        _offer(
            sent,
            key,
            "Import jobs are failing",
            f"{count} failed import runs in the last hour.{detail}",
        )


def _storage_growth(sent: list[str]) -> None:
    today = datetime.now(UTC).date().isoformat()
    state = _read_state()
    changed = False
    for uid in _uids():
        entry = state.get(str(uid))
        if isinstance(entry, dict) and entry.get("date") == today and "bytes" in entry:
            continue  # measured once a day, not on every five-minute check
        try:
            # Including backups/: runaway snapshots are what filled the disk on 2026-10-21.
            current = db.folder_bytes(db.user_root(uid))
        except OSError:
            log.warning("could not measure storage for user %s", uid, exc_info=True)
            continue
        if not isinstance(entry, dict) or not entry.get("date") or "bytes" not in entry:
            state[str(uid)] = {"date": today, "bytes": current}  # first sight: baseline only
            changed = True
            continue
        grown = current - int(entry.get("bytes") or 0)
        if grown >= settings().alert_storage_growth_mb * 1024**2 and not _offer(
            sent,
            f"storage-growth:{uid}",
            "Storage growing fast",
            f"Account {uid} grew by {grown / 1024**2:.0f} MB since {entry['date']} "
            f"(now {current / 1024**2:.0f} MB).",
        ):
            continue  # keep yesterday's baseline so the next check retries this alert
        state[str(uid)] = {"date": today, "bytes": current}
        changed = True
    if changed:
        _write_state(state)


def _free_disk(sent: list[str]) -> None:
    floor = settings().alert_free_disk_mb * 1024**2
    free = shutil.disk_usage(db.data_root()).free
    if free >= floor:
        return
    _offer(
        sent,
        "disk-free",
        "Server disk almost full",
        f"{free / 1024**2:.0f} MB free, below the {floor / 1024**2:.0f} MB alert floor.",
    )


def check() -> list[str]:
    """Run every check; return the keys that were actually sent."""
    sent: list[str] = []
    for fn in (_failed_runs, _storage_growth, _free_disk):
        try:
            fn(sent)
        except Exception:
            log.exception("alert check %s failed", fn.__name__)
    return sent


def reset() -> None:
    """Forget the in-memory cooldowns (tests)."""
    _sent_at.clear()
