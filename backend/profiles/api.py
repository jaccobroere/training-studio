"""The Profile: one Markdown document about the athlete, versioned (latest = current).
Every save is an `update_profile` change through the seam, so it is undoable and shows in
history; restore is a save of an old version's text."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from db import get_session
from models import ProfileDoc
from plan.changes import PROFILE_KEY, apply_change, current_profile
from plan.starter import PROFILE_TEMPLATE

router = APIRouter(prefix="/api/profile")


def _d(p: ProfileDoc, body: bool = True) -> dict:
    d = {"version": p.version, "at": p.at.isoformat() + "Z", "source": p.source, "reason": p.reason}
    if body:
        d["markdown"] = p.markdown
    return d


@router.get("")
def get_profile(db: Session = Depends(get_session)) -> dict:
    p = current_profile(db)
    versions = db.scalars(select(ProfileDoc).order_by(ProfileDoc.version.desc()).limit(100)).all()
    out = {"current": _d(p) if p else None, "versions": [_d(v, body=False) for v in versions]}
    if p is None:  # accounts from before the Profile existed: offer the template to start from
        out["template"] = PROFILE_TEMPLATE
    return out


@router.get("/versions/{version}")
def get_version(version: int, db: Session = Depends(get_session)) -> dict:
    p = db.get(ProfileDoc, version)
    if p is None:
        raise HTTPException(404, {"code": "version_not_found"})
    return _d(p)


class SaveIn(BaseModel):
    markdown: str = Field(max_length=200_000)
    base_version: int | None = None
    reason: str = ""


def _save(db: Session, markdown: str, base: int | None, reason: str) -> dict:
    expected = {PROFILE_KEY: base} if base is not None else {}
    res = apply_change(db, [{"op": "update_profile", "markdown": markdown}], source="ui",
                       reason=reason, expected=expected)
    cur = current_profile(db)
    return {**res.as_dict(), "version": cur.version if cur else None, "unchanged": not res.applied}


@router.put("")
def put_profile(body: SaveIn, db: Session = Depends(get_session)) -> dict:
    return _save(db, body.markdown, body.base_version, body.reason or "Edited the Profile")


@router.post("/versions/{version}/restore")
def restore(version: int, db: Session = Depends(get_session)) -> dict:
    p = db.get(ProfileDoc, version)
    if p is None:
        raise HTTPException(404, {"code": "version_not_found"})
    return _save(db, p.markdown, None, f"Restored version {version}")
