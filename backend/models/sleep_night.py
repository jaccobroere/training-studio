from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Date, DateTime, Float, String
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base


class SleepNight(Base):
    """A night of sleep, owned by its wake-up calendar date (Garmin's convention)."""

    __tablename__ = "sleep_night"

    day: Mapped[date] = mapped_column(Date, primary_key=True)
    source: Mapped[str] = mapped_column(String(16), primary_key=True)
    start_utc: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    end_utc: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    tz_offset_min: Mapped[float | None] = mapped_column(Float, nullable=True)
    deep_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    light_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    rem_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    awake_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    import_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
