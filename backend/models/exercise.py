from __future__ import annotations

from sqlalchemy import Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base


class Exercise(Base):
    """A movement or activity in the athlete's library. Workout items point at it by id.
    `default_measure` (reps | time | distance) only steers the editor's quick entry.
    Archived exercises stay resolvable for old workouts but leave the picker."""

    __tablename__ = "exercise"

    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    type: Mapped[str] = mapped_column(String(16), default="other")
    default_measure: Mapped[str] = mapped_column(String(12), default="reps")
    notes: Mapped[str] = mapped_column(Text, default="")
    media: Mapped[list] = mapped_column(default=list)
    archived: Mapped[bool] = mapped_column(default=False)
    version: Mapped[int] = mapped_column(Integer, default=0)
