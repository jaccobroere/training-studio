from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from accounts.api import current
from accounts.models import User
from core.settings import settings
from db import get_session
from media import store
from media.api import error, limit_uploads, read_upload
from models import Feedback, MediaFile
from models.base import utcnow
from upload_limits import UploadRoute

router = APIRouter(prefix="/api/feedback")
# Upload first, then send the ids with the note (the chat attachment pattern):
#   POST /api/feedback/attachments   multipart, field `file` → {id, url, …}
#   POST /api/feedback {..., attachments: ["<id>", …]}   (≤ MAX_ATTACHMENTS)
attachments_router = APIRouter(prefix="/api/feedback/attachments", route_class=UploadRoute)

KINDS = ("bug", "idea", "other")
MAX_ATTACHMENTS = 3


class FeedbackIn(BaseModel):
    kind: Literal["bug", "idea", "other"] = "other"
    message: str = Field(min_length=3, max_length=4000)
    path: str | None = Field(default=None, max_length=300)
    viewport: str | None = Field(default=None, max_length=40)
    user_agent: str | None = Field(default=None, max_length=300)
    include_context: bool = True
    attachments: list[str] = Field(default_factory=list, max_length=MAX_ATTACHMENTS)


class FeedbackOut(BaseModel):
    id: str
    kind: str
    message: str
    created_at: str
    state: str
    attachments: int = 0


def _out(row: Feedback) -> FeedbackOut:
    return FeedbackOut(
        id=row.id,
        kind=row.kind,
        message=row.message,
        created_at=row.created_at.isoformat(timespec="seconds") + "Z",
        state=row.state,
        attachments=len(row.attachments or []),
    )


@attachments_router.post("")
async def upload_attachment(
    request: Request, file: UploadFile, db_: Annotated[Session, Depends(get_session)]
):
    """One screenshot for a note that is still being written. Images only; re-encoded and
    stripped of metadata by media/store.py. Unclaimed uploads are purged after a day."""
    if (denied := limit_uploads(request)) is not None:
        return denied
    try:
        row = await store.save_async(
            db_, await read_upload(file), file.filename or "screenshot", purpose="feedback"
        )
    except store.MediaError as e:
        return error(e)
    return store.info(row)


def _claim(db: Session, ids: list[str]) -> list[str]:
    """The attachment ids for a new note: each one an unclaimed feedback upload."""
    ids = list(dict.fromkeys(i for i in ids if i))
    if not ids:
        return []
    claimed = {i for row in db.scalars(select(Feedback.attachments)).all() for i in (row or [])}
    for i in ids:
        media = db.get(MediaFile, i)
        if media is None or media.purpose != "feedback" or i in claimed:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "unknown_attachment",
                    "detail": "A screenshot is no longer available. Remove it and add it again.",
                },
            )
    return ids


@router.post("", status_code=201)
def submit(
    body: FeedbackIn,
    request: Request,
    user: Annotated[User, Depends(current)],
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    """Store one note for this account and let the outbox worker forward it.

    A per-account daily cap keeps a broken client or an angry afternoon from turning
    into an unbounded queue. The response says whether forwarding is configured; the
    note is stored either way (without FEEDBACK_WEBHOOK_URL it is never forwarded).
    """
    s = settings()
    since = utcnow() - timedelta(hours=24)
    used = db.scalar(select(func.count()).select_from(Feedback).where(Feedback.created_at >= since))
    if (used or 0) >= s.feedback_daily_limit:
        raise HTTPException(
            status_code=429,
            detail={
                "code": "feedback_limit",
                "detail": "You've sent a lot of feedback today. Try again tomorrow.",
            },
        )

    message = body.message.strip()
    if len(message) < 3:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_request", "detail": "Add a little more detail."},
        )

    context: dict = {"app_version": s.app_version, "username": user.username_display}
    if body.include_context:
        path = (body.path or request.headers.get("referer") or "").strip()
        if path.startswith("/") and len(path) <= 300:
            context["path"] = path
        if body.viewport:
            context["viewport"] = body.viewport[:40]
        if body.user_agent:
            context["user_agent"] = body.user_agent[:300]

    row = Feedback(
        id=f"fb-{uuid.uuid4().hex[:12]}",
        kind=body.kind,
        message=message,
        context=context,
        attachments=_claim(db, body.attachments),
    )
    db.add(row)
    db.commit()
    return {
        "id": row.id,
        "queued": bool(s.feedback_webhook_url),
        "remaining": max(0, s.feedback_daily_limit - (used or 0) - 1),
    }


@router.get("", response_model=list[FeedbackOut])
def recent(db: Annotated[Session, Depends(get_session)]) -> list[FeedbackOut]:
    """The athlete's own recent notes, newest first. This is not an operator queue;
    whatever the webhook receiver makes of a note lives there."""
    rows = db.scalars(select(Feedback).order_by(Feedback.created_at.desc()).limit(10)).all()
    return [_out(r) for r in rows]


@router.post("/{feedback_id}/retry")
def retry(
    feedback_id: str,
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    """Put one failed note back in the outbox.

    Only a note that the outbox gave up on can be retried. A note that is already queued or
    sent is not touched, so this cannot create a duplicate delivery. The background job
    loop picks the row up on its next tick (about five seconds); the API stays fast and
    does not hold a request open while the webhook responds.
    """
    row = db.get(Feedback, feedback_id)
    if row is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "feedback_not_found", "detail": "That note no longer exists."},
        )
    if row.state != "failed":
        raise HTTPException(
            status_code=409,
            detail={
                "code": "feedback_not_failed",
                "detail": "Only a note that couldn't send can be retried.",
            },
        )

    row.state = "queued"
    row.attempts = 0
    row.last_error = None
    row.next_attempt_at = None
    row.forwarded_at = None
    db.commit()
    return {"id": row.id, "state": row.state}
