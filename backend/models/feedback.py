from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base, utcnow


class Feedback(Base):
    """One piece of feedback from the signed-in athlete.

    Feedback is personal data, so it lives in the user's own database and follows
    the account's export/delete/backup rules. The row is also an outbox item: the
    in-process worker forwards unsent rows to FEEDBACK_WEBHOOK_URL when it is set.
    Whatever the receiver creates from it (an issue, a message), not this row, is the
    operator-facing record.
    """

    __tablename__ = "feedback"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    kind: Mapped[str] = mapped_column(String(16), default="other")  # bug | idea | other
    message: Mapped[str] = mapped_column(Text)
    # Context the athlete agreed to include: route, viewport, user agent. The server
    # adds app_version and the account name; it never adds training/health data.
    context: Mapped[dict] = mapped_column(default=dict)
    # Structured triage from feedback/enrich.py (LLM when configured, else rule-based).
    triage: Mapped[dict] = mapped_column(default=dict)
    # MediaFile ids (purpose "feedback") the athlete attached: screenshots, at most three.
    # The files are deleted a week after the note was sent (feedback/outbox.py); the ids
    # stay, so a purged attachment simply isn't forwarded again.
    attachments: Mapped[list] = mapped_column(default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    # Outbox state. sent = accepted by the webhook; failed = attempts exhausted, still readable
    # in the athlete's history and in the export.
    state: Mapped[str] = mapped_column(String(16), default="queued", index=True)
    attempts: Mapped[int] = mapped_column(default=0)
    last_error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    forwarded_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
