from __future__ import annotations

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base


class Setting(Base):
    """Small key → JSON store for operational state (Garmin sync status, back-off)."""

    __tablename__ = "setting"

    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    value: Mapped[dict] = mapped_column(default=dict)
