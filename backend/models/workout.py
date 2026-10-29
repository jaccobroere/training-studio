from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Date, DateTime, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base, utcnow


class Workout(Base):
    """One planned training. Plan side only: it never stores actual values; what happened is
    an `activity` linked to it (done = at least one linked activity).

    `date` NULL = "this week, no day yet" (the tray); `week_monday` is always set.
    `items` = ordered [{id, exercise_id, sets?, reps?, load?, duration_min?, distance_km?,
    intensity?, note?}] with short ids that stay stable while the list is edited.
    Series occurrences carry `series_id` + `series_date` (the slot they were created for, which
    never changes when the row is moved); the unique pair is what makes top-up idempotent.
    """

    __tablename__ = "workout"
    __table_args__ = (UniqueConstraint("series_id", "series_date", name="uq_workout_series_date"),)

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    week_monday: Mapped[date] = mapped_column(Date, index=True)
    date: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    # Optional time of day, "HH:MM" (24 h, athlete's timezone); NULL = no time.
    time: Mapped[str | None] = mapped_column(String(5), nullable=True)
    title: Mapped[str] = mapped_column(String(160))
    type: Mapped[str] = mapped_column(String(16), index=True)
    tags: Mapped[list] = mapped_column(default=list)
    notes: Mapped[str] = mapped_column(Text, default="")
    items: Mapped[list] = mapped_column(default=list)
    media: Mapped[list] = mapped_column(default=list)
    status: Mapped[str] = mapped_column(String(12), default="planned")  # planned | skipped
    skip_reason: Mapped[str] = mapped_column(Text, default="")
    series_id: Mapped[str | None] = mapped_column(String(40), nullable=True, index=True)
    series_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    customised: Mapped[bool] = mapped_column(default=False)
    version: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Series(Base):
    """A repeating workout. `rule` = {freq: "weekly", interval: 1..8, weekdays: [0..6]}.
    Occurrences are real `workout` rows, materialised up to `materialised_through`; a slot at or
    before that date is never created again, so deleting one occurrence sticks."""

    __tablename__ = "series"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    title: Mapped[str] = mapped_column(String(160))
    type: Mapped[str] = mapped_column(String(16))
    time: Mapped[str | None] = mapped_column(String(5), nullable=True)  # "HH:MM" or NULL
    tags: Mapped[list] = mapped_column(default=list)
    notes: Mapped[str] = mapped_column(Text, default="")
    items: Mapped[list] = mapped_column(default=list)
    media: Mapped[list] = mapped_column(default=list)
    rule: Mapped[dict] = mapped_column(default=dict)
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    materialised_through: Mapped[date | None] = mapped_column(Date, nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class SavedWorkout(Base):
    """A workout template with no date ("Save as template", Library → Saved workouts)."""

    __tablename__ = "saved_workout"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    title: Mapped[str] = mapped_column(String(160))
    type: Mapped[str] = mapped_column(String(16))
    time: Mapped[str | None] = mapped_column(String(5), nullable=True)  # "HH:MM" or NULL
    tags: Mapped[list] = mapped_column(default=list)
    notes: Mapped[str] = mapped_column(Text, default="")
    items: Mapped[list] = mapped_column(default=list)
    media: Mapped[list] = mapped_column(default=list)
    version: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
