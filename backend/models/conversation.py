from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base, utcnow


class Conversation(Base):
    """One assistant thread. `history` is Pydantic AI's serialized model messages (the
    server owns history; clients only send the new message). `scopes` maps each user
    message id to the scope it was sent with (page, week, selection)."""

    __tablename__ = "conversation"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    title: Mapped[str] = mapped_column(String(160), default="New chat")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    history: Mapped[str] = mapped_column(Text, default="[]")
    scopes: Mapped[dict] = mapped_column(default=dict)
    model: Mapped[str] = mapped_column(String(80), default="")
