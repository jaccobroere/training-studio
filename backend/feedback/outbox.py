"""Forward queued feedback to the configured webhook (FEEDBACK_WEBHOOK_URL).

The row is the outbox item. Success means the receiver accepted the payload (2xx), not that it
has acted on it yet (for example, opened an issue). Authentication is a static capability
header, `X-Sports-Token`, which the receiver checks; a plain header rather than an HMAC keeps
the receiver simple (many webhook tools cannot verify one). Keep the receiver on a private
network where you can. Failures
back off exponentially and give up after ten attempts, leaving the note readable in
the athlete's history and in their export.

Screenshots travel inside the same JSON payload (base64, already re-encoded by
media/store.py), so a note and its images are delivered together or not at all. They are
not kept: `purge_attachments` deletes them a week after the note was sent (time enough to
re-deliver), after a month for a note that never could be, and a day after upload when no
note claimed them. The receiver keeps the operator copy.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from datetime import datetime, timedelta

import httpx
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

import db
from core.settings import settings
from feedback import enrich
from media import store
from models import Feedback, MediaFile
from models.base import utcnow

log = logging.getLogger("sports.feedback")

MAX_ATTEMPTS = 10
SENT_ATTACHMENT_DAYS = 7
FAILED_ATTACHMENT_DAYS = 30
UNCLAIMED_ATTACHMENT_HOURS = 24
PURGE_EVERY = timedelta(hours=1)
_last_purge: dict[int, datetime] = {}  # user id → last purge (per process)
_warned_missing_secret = False


def _attachments(session: Session, row: Feedback) -> list[dict]:
    """The note's screenshots that still exist, in the order the athlete added them."""
    out = []
    for n, mid in enumerate(row.attachments or [], start=1):
        media = session.get(MediaFile, mid)
        if media is None or media.purpose != "feedback":
            continue
        try:
            data = store.read_bytes(media.file)
        except OSError:
            continue
        out.append(
            {
                "name": f"{n}.{media.file.rsplit('.', 1)[-1]}",
                "media_type": media.media_type,
                "width": media.width,
                "height": media.height,
                "data": base64.b64encode(data).decode("ascii"),
            }
        )
    return out


def _body(row: Feedback, user_id: int, username: str, attachments: list[dict]) -> bytes:
    payload = {
        "event": "feedback.created",
        "feedback_id": row.id,
        "user_id": user_id,
        "username": username,
        "kind": row.kind,
        "message": row.message,
        "context": row.context or {},
        "triage": row.triage or {},
        "created_at": row.created_at.isoformat(timespec="seconds") + "Z",
        "attachments": attachments,
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()


def _pending(db_session: Session, limit: int) -> list[Feedback]:
    now = utcnow()
    return list(
        db_session.scalars(
            select(Feedback)
            .where(Feedback.state == "queued")
            .where(or_(Feedback.next_attempt_at.is_(None), Feedback.next_attempt_at <= now))
            .order_by(Feedback.created_at)
            .limit(limit)
        )
    )


def _fail(row: Feedback, error: str, *, permanent: bool = False) -> None:
    row.attempts += 1
    row.last_error = error[:500]
    if permanent or row.attempts >= MAX_ATTEMPTS:
        row.state = "failed"
        log.error("feedback %s permanently failed: %s", row.id, row.last_error)
        return
    delay = min(30 * (2**row.attempts), 3600)
    row.next_attempt_at = utcnow() + timedelta(seconds=delay)


def purge_attachments(session: Session) -> int:
    """Delete feedback screenshots nobody needs any more; returns how many were removed."""
    now = utcnow()
    media = list(session.scalars(select(MediaFile).where(MediaFile.purpose == "feedback")))
    if not media:
        return 0
    owner: dict[str, Feedback] = {}
    for row in session.scalars(select(Feedback)):
        for mid in row.attachments or []:
            owner[mid] = row
    removed = 0
    for m in media:
        row = owner.get(m.id)
        if row is None:
            due = m.created_at + timedelta(hours=UNCLAIMED_ATTACHMENT_HOURS)
        elif row.state == "sent":
            due = (row.forwarded_at or row.created_at) + timedelta(days=SENT_ATTACHMENT_DAYS)
        elif row.state == "failed":
            due = row.created_at + timedelta(days=FAILED_ATTACHMENT_DAYS)
        else:
            continue  # still queued: the outbox needs it
        if due > now:
            continue
        store.path_of(m.file).unlink(missing_ok=True)
        session.delete(m)
        removed += 1
    if removed:
        session.commit()
        log.info("feedback: purged %d screenshot(s)", removed)
    return removed


def flush(limit: int = 5) -> int:
    """Send up to `limit` due rows for the current user. Returns how many were accepted.

    Called from the existing in-process job loop, inside `db.as_user(uid)`. No-op when
    no webhook is configured, or when a URL is set without the shared secret (fail
    closed rather than send an unsigned payload).
    """
    s = settings()
    uid = db.user_id()
    last = _last_purge.get(uid)
    if last is None or utcnow() - last >= PURGE_EVERY:
        _last_purge[uid] = utcnow()
        with db.get_db().session() as session:
            purge_attachments(session)
    if not s.feedback_webhook_url:
        return 0
    secret = s.feedback_webhook_secret.get_secret_value() if s.feedback_webhook_secret else ""
    if not secret:
        global _warned_missing_secret
        if not _warned_missing_secret:
            log.warning(
                "FEEDBACK_WEBHOOK_URL is set without FEEDBACK_WEBHOOK_SECRET; not forwarding"
            )
            _warned_missing_secret = True
        return 0

    sent = 0
    with db.get_db().session() as session:
        for row in _pending(session, limit):
            if not row.triage:
                row.triage = asyncio.run(
                    enrich.triage(row.message, row.kind, row.context or {})
                ).model_dump()
                session.commit()
            username = str((row.context or {}).get("username") or f"user {uid}")
            body = _body(row, uid, username, _attachments(session, row))
            try:
                response = httpx.post(
                    s.feedback_webhook_url,
                    content=body,
                    headers={
                        "Content-Type": "application/json",
                        "X-Sports-Token": secret,
                        "X-Sports-Feedback-Id": row.id,
                    },
                    timeout=s.feedback_webhook_timeout_s,
                )
            except (httpx.HTTPError, OSError) as e:  # network/DNS/timeout: retry later
                _fail(row, f"{type(e).__name__}: {e}")
                session.commit()
                continue
            if 200 <= response.status_code < 300:
                row.state = "sent"
                row.forwarded_at = utcnow()
                row.last_error = None
                sent += 1
            elif 400 <= response.status_code < 500 and response.status_code != 429:
                _fail(
                    row,
                    f"webhook answered {response.status_code}: {response.text[:300]}",
                    permanent=True,
                )
            else:
                _fail(row, f"webhook answered {response.status_code}: {response.text[:300]}")
            session.commit()
    return sent
