from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base, utcnow


class MediaFile(Base):
    """An uploaded file in `users/<id>/media/` (media/store.py).

    purpose "entity": an image for an exercise / workout / series / saved workout, referenced
    from their `media` lists as {kind: "image", file: <file>}. purpose "chat": a file attached
    to an assistant message (image or PDF); `text` is the PDF's extracted text and `pages`
    the page images rendered for scanned PDFs (file names in the same folder). purpose
    "feedback": a screenshot attached to a feedback note (feedback/api.py); deleted a week
    after the note was forwarded, or a day after upload when no note claimed it."""

    __tablename__ = "media_file"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    file: Mapped[str] = mapped_column(String(120), unique=True)
    purpose: Mapped[str] = mapped_column(String(12), default="entity")
    media_type: Mapped[str] = mapped_column(String(40))
    filename: Mapped[str] = mapped_column(String(240), default="")
    size: Mapped[int] = mapped_column(Integer, default=0)
    sha256: Mapped[str] = mapped_column(String(64), default="")
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    n_pages: Mapped[int] = mapped_column(Integer, default=0)
    text: Mapped[str] = mapped_column(Text, default="")
    pages: Mapped[list] = mapped_column(default=list)
    thread_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
