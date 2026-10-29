from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Date, DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base, utcnow


class Activity(Base):
    """What actually happened: a recording (Garmin, demo) or a manual entry. Actual side only:
    it never stores planned values. `workout_id` links it to at most one planned workout.

    Device values are written only by the importer. The athlete's annotations (rpe, notes,
    skipped_items = workout item ids left out, type_override) live here whatever the source, and are written
    only through the change seam, which also bumps `version`. `sport` holds the fixed type
    (plan/types.py). `kept_unplanned` = the athlete said "keep as unplanned" in the Inbox.

    `local_date` is the athlete-local owning date (start time in the athlete's timezone);
    the real UTC interval is kept in start_utc + duration_s."""

    __tablename__ = "activity"

    id: Mapped[str] = mapped_column(String(80), primary_key=True)  # "garmin:<activityId>"
    source: Mapped[str] = mapped_column(String(16))  # garmin | demo | manual
    source_id: Mapped[str] = mapped_column(String(80), unique=True)
    sport: Mapped[str] = mapped_column(String(24), index=True)  # the type: run, ride, skate, …
    source_type: Mapped[str] = mapped_column(String(60), default="")  # device's own type key
    name: Mapped[str] = mapped_column(String(200), default="")
    start_utc: Mapped[datetime] = mapped_column(DateTime, index=True)
    tz_offset_min: Mapped[int | None] = mapped_column(Integer, nullable=True)
    local_date: Mapped[date] = mapped_column(Date, index=True)
    duration_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    moving_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    distance_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    avg_hr: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_hr: Mapped[float | None] = mapped_column(Float, nullable=True)
    elevation_gain_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    calories: Mapped[float | None] = mapped_column(Float, nullable=True)
    device: Mapped[str] = mapped_column(String(80), default="")
    laps: Mapped[list] = mapped_column(default=list)
    stream_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    raw_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    import_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    workout_id: Mapped[str | None] = mapped_column(String(40), nullable=True, index=True)
    rpe: Mapped[float | None] = mapped_column(Float, nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    skipped_items: Mapped[list] = mapped_column(default=list)
    # What was actually done, one entry per set, in order: {exercise_id, item_id?, reps?, kg?, secs?}.
    # item_id points into the linked workout's items when the set answers one of them.
    sets: Mapped[list] = mapped_column(default=list)
    kept_unplanned: Mapped[bool] = mapped_column(default=False)
    # The athlete's own type for a recording, when the device's is wrong (an oval session recorded
    # as "other"). While set, `sport` holds it and the importer leaves `sport` alone; clearing it
    # puts the device's type (from source_type) back.
    type_override: Mapped[str | None] = mapped_column(String(24), nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=0)
