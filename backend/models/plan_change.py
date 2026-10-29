from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base, utcnow


class PlanChange(Base):
    """One committed plan edit — the single history seam (see plan/changes.py).

    `before`/`after` map entity keys ("workout:<id>", "series:<id>", "activity:<id>", …) to
    row snapshots (None = did not exist). Rows are immutable once written, except that
    `undone_by_id` is set when a later change undoes this one.
    """

    __tablename__ = "plan_change"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    source: Mapped[str] = mapped_column(String(16))  # ui | chat | import | undo | system
    reason: Mapped[str] = mapped_column(Text, default="")
    summary: Mapped[str] = mapped_column(Text, default="")
    weeks: Mapped[list] = mapped_column(default=list)
    ops: Mapped[list] = mapped_column(default=list)
    before: Mapped[dict] = mapped_column(default=dict)
    after: Mapped[dict] = mapped_column(default=dict)
    undoes_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    undone_by_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    op_id: Mapped[str | None] = mapped_column(String(80), nullable=True, unique=True)
    turn_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
