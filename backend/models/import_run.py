from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base, utcnow


class ImportRun(Base):
    """One import job (archive upload, FIT upload, scheduled pull). Doubles as the job
    queue: the in-process worker picks up `queued` rows and survives restarts by re-queuing
    rows left `running`."""

    __tablename__ = "import_run"
    __table_args__ = (Index("ix_import_run_state_created_at", "state", "created_at"),)

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    kind: Mapped[str] = mapped_column(String(16))  # archive | fit | pull | backfill
    state: Mapped[str] = mapped_column(String(16), default="queued", index=True)
    # queued | running | paused (backfill waiting out a Garmin back-off) | done | partial | failed | cancelled
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    params: Mapped[dict] = mapped_column(default=dict)
    progress: Mapped[dict] = mapped_column(default=dict)
    report: Mapped[dict] = mapped_column(default=dict)
    cancel_requested: Mapped[bool] = mapped_column(default=False)
