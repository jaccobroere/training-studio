from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Date, DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base, utcnow


class Analysis(Base):
    """One sandboxed analysis run: the question, the exact code, the dataset specs as given
    (possibly relative, e.g. start "-90d"), the absolute ranges they resolved to, a hash of the
    snapshot it ran on (its data revision), and the result. Re-running creates a new row; an
    old result is never presented as current."""

    __tablename__ = "analysis"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    question: Mapped[str] = mapped_column(Text, default="")
    title: Mapped[str] = mapped_column(String(160), default="")
    code: Mapped[str] = mapped_column(Text)
    datasets: Mapped[list] = mapped_column(default=list)
    ranges: Mapped[list] = mapped_column(default=list)  # [{name, kind, start, end}] resolved
    dataset_hash: Mapped[str] = mapped_column(String(64))
    rows: Mapped[dict] = mapped_column(default=dict)  # rows per dataset
    status: Mapped[str] = mapped_column(String(16))
    result: Mapped[dict] = mapped_column(default=dict)
    duration_s: Mapped[float] = mapped_column(Float, default=0)
    conversation_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    runner: Mapped[str] = mapped_column(String(40), default="")
    at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    ran_on: Mapped[date | None] = mapped_column(Date, nullable=True)  # athlete-local "today" when it ran


class PinnedAnalysis(Base):
    """An analysis pinned to Health → Pinned. Holds its own code and dataset specs (ranges
    relative to today, so it stays live) and re-runs when opened; the last result is cached
    under a key of (code, snapshot hash), so reopening on unchanged data costs one snapshot
    build and no sandbox run. Changed only through the assistant (update_pinned)."""

    __tablename__ = "pinned_analysis"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    title: Mapped[str] = mapped_column(String(160))
    code: Mapped[str] = mapped_column(Text)
    datasets: Mapped[list] = mapped_column(default=list)
    position: Mapped[int] = mapped_column(Integer, default=0)
    created_from: Mapped[str | None] = mapped_column(String(40), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    version: Mapped[int] = mapped_column(Integer, default=1)
    cache_key: Mapped[str] = mapped_column(String(64), default="")
    cache: Mapped[dict] = mapped_column(default=dict)  # {status, result, rows, ranges, dataset_hash, duration_s, ran_at}
