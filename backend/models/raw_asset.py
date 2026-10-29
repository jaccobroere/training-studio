from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base, utcnow


class RawAsset(Base):
    """Original bytes exactly as received (export ZIPs, FIT files, API JSON). Never edited;
    re-parsing a raw asset is always possible."""

    __tablename__ = "raw_asset"

    sha256: Mapped[str] = mapped_column(String(64), primary_key=True)
    kind: Mapped[str] = mapped_column(String(24))  # archive | fit | json
    filename: Mapped[str] = mapped_column(String(300), default="")
    path: Mapped[str] = mapped_column(String(400))
    size: Mapped[int] = mapped_column(Integer, default=0)
    import_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
