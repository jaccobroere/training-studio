from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base, utcnow


class ProfileDoc(Base):
    """The athlete's Profile (one Markdown document), one immutable row per version; the
    latest is current. Written only through the change seam (`update_profile`)."""

    __tablename__ = "profile_doc"

    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    markdown: Mapped[str] = mapped_column(Text)
    at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    source: Mapped[str] = mapped_column(String(16), default="ui")
    reason: Mapped[str] = mapped_column(Text, default="")
