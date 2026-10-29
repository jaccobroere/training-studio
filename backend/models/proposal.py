from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base, utcnow


class ChatProposal(Base):
    """A change set the assistant proposed but did not apply (chat/proposals.py).

    `ops` are the plan ops exactly as they will be applied; `expected` holds the version of
    every row the dry run touched, so Apply refuses with `stale` if any of them moved on.
    `preview` is the dry run's result in compact chip form (added / removed / changed
    workouts by date) for ghost rendering in the calendar. Status: open → applied |
    discarded | replaced (a newer proposal on the same thread) | stale. "undone" is computed:
    an applied proposal whose change was undone since."""

    __tablename__ = "chat_proposal"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    thread_id: Mapped[str] = mapped_column(String(64), index=True)
    turn_id: Mapped[str] = mapped_column(String(40), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    status: Mapped[str] = mapped_column(String(12), default="open")
    summary: Mapped[str] = mapped_column(Text, default="")
    title: Mapped[str] = mapped_column(Text, default="")
    counts: Mapped[dict] = mapped_column(default=dict)
    ops: Mapped[list] = mapped_column(default=list)
    expected: Mapped[dict] = mapped_column(default=dict)
    before: Mapped[dict] = mapped_column(default=dict)
    lines: Mapped[list] = mapped_column(default=list)
    weeks: Mapped[list] = mapped_column(default=list)
    dates: Mapped[list] = mapped_column(default=list)
    preview: Mapped[dict] = mapped_column(default=dict)
    kept: Mapped[list] = mapped_column(default=list)
    change_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
