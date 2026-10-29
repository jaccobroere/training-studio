"""Shared DeclarativeBase for all app models, plus small column helpers."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import JSON
from sqlalchemy.orm import DeclarativeBase


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Base(DeclarativeBase):
    type_annotation_map = {dict: JSON, list: JSON}
