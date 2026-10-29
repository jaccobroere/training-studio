from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Date, DateTime, Float, String
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base, utcnow


class DailyMetric(Base):
    """One value per (calendar date, metric, source). Absence of a row means "no data" —
    never zero. Metric definitions live in health/metrics.py."""

    __tablename__ = "daily_metric"

    day: Mapped[date] = mapped_column(Date, primary_key=True)
    metric: Mapped[str] = mapped_column(String(40), primary_key=True)
    source: Mapped[str] = mapped_column(String(16), primary_key=True)
    value: Mapped[float] = mapped_column(Float)
    import_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
