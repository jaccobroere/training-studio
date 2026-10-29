from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from db import get_session
from models import Athlete

router = APIRouter(prefix="/api/athlete")


def get_athlete(db: Session) -> Athlete:
    a = db.get(Athlete, 1)
    if a is None:
        a = Athlete(id=1)
        db.add(a)
        db.commit()
    return a


def _d(a: Athlete) -> dict:
    return {"name": a.name, "timezone": a.timezone, "equipment": a.equipment,
            "availability": a.availability, "notes": a.notes}


@router.get("")
def read(db: Session = Depends(get_session)) -> dict:
    return _d(get_athlete(db))


class AthleteIn(BaseModel):
    name: str | None = None
    equipment: str | None = None
    availability: str | None = None
    notes: str | None = None


@router.patch("")
def update(body: AthleteIn, db: Session = Depends(get_session)) -> dict:
    a = get_athlete(db)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(a, k, v)
    db.commit()
    return _d(a)
