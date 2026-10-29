"""Athlete-local "now". Week membership and "today" always use the athlete's timezone.

`FAKE_TODAY=YYYY-MM-DD` pins the date for demos and tests; it never reaches production.
"""

from __future__ import annotations

from datetime import date, datetime
from functools import lru_cache
from zoneinfo import ZoneInfo

from core.settings import settings


@lru_cache(maxsize=4)
def _zone(name: str) -> ZoneInfo:
    return ZoneInfo(name)


def tz() -> ZoneInfo:
    return _zone(settings().athlete_tz)


def now() -> datetime:
    real = datetime.now(tz())
    d = settings().fake_today
    if d:
        return real.replace(year=d.year, month=d.month, day=d.day)
    return real


def today() -> date:
    return now().date()
