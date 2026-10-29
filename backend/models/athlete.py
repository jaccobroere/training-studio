from __future__ import annotations

from sqlalchemy import String, Text
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base


class Athlete(Base):
    """The single athlete. Always row id=1."""

    __tablename__ = "athlete"

    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    name: Mapped[str] = mapped_column(String(80), default="Athlete")
    timezone: Mapped[str] = mapped_column(String(64), default="Europe/Amsterdam")
    # Free-text context the athlete wants the assistant to know (equipment, availability, …).
    equipment: Mapped[str] = mapped_column(Text, default="")
    availability: Mapped[str] = mapped_column(Text, default="")
    notes: Mapped[str] = mapped_column(Text, default="")
