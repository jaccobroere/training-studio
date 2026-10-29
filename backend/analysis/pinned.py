"""Pinned analyses (Health → Pinned): the domain functions behind the API and the assistant's
pin_analysis / update_pinned / unpin_analysis tools."""

from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from analysis.runner import chart_title, specs_of
from analysis.snapshot import DatasetSpec, relativize
from models import Analysis, PinnedAnalysis
from models.base import utcnow

MAX_PINNED = 24


class PinError(Exception):
    def __init__(self, code: str, detail: str, status: int = 422):
        super().__init__(detail)
        self.code, self.detail, self.status = code, detail, status


def ordered(db: Session) -> list[PinnedAnalysis]:
    return list(db.scalars(select(PinnedAnalysis).order_by(PinnedAnalysis.position, PinnedAnalysis.created_at)))


def pin(db: Session, analysis_id: str, title: str | None = None) -> tuple[PinnedAnalysis, bool]:
    """Pin an analysis (→ (row, created)). Absolute ranges that ended on the day it ran become
    relative ("-90d … today"). Pinning the same analysis twice returns the existing pin."""
    a = db.get(Analysis, analysis_id)
    if a is None:
        raise PinError("analysis_not_found", f"No analysis {analysis_id}", 404)
    if a.status != "ok":
        raise PinError("analysis_failed", "Only an analysis that ran without errors can be pinned")
    have = db.scalars(select(PinnedAnalysis).where(PinnedAnalysis.created_from == analysis_id)).first()
    if have is not None:
        return have, False
    if db.scalar(select(func.count()).select_from(PinnedAnalysis)) >= MAX_PINNED:
        raise PinError("too_many_pinned", f"At most {MAX_PINNED} pinned analyses; unpin one first", 409)
    ran_on = a.ran_on or a.at.date()
    specs = [relativize(s, ran_on).model_dump() for s in specs_of(a.datasets)]
    top = db.scalar(select(func.max(PinnedAnalysis.position)))
    p = PinnedAnalysis(id=f"pin-{uuid.uuid4().hex[:8]}",
                       title=(title or a.title or chart_title(a.result) or a.question or "Analysis")[:160],
                       code=a.code, datasets=specs, position=(top + 1) if top is not None else 0, created_from=a.id)
    db.add(p)
    db.commit()
    return p, True


def get(db: Session, pid: str) -> PinnedAnalysis:
    p = db.get(PinnedAnalysis, pid)
    if p is None:
        raise PinError("pinned_not_found", f"No pinned analysis {pid}", 404)
    return p


def unpin(db: Session, pid: str) -> PinnedAnalysis:
    p = get(db, pid)
    db.delete(p)
    db.commit()
    return p


def reorder(db: Session, ids: list[str]) -> list[PinnedAnalysis]:
    rows = ordered(db)
    if sorted(ids) != sorted(p.id for p in rows):
        raise PinError("bad_order", "Send every pinned id exactly once")
    pos = {pid: i for i, pid in enumerate(ids)}
    for p in rows:
        p.position = pos[p.id]
    db.commit()
    return ordered(db)


def update(db: Session, p: PinnedAnalysis, *, title: str | None = None, code: str | None = None,
           datasets: list[DatasetSpec] | None = None) -> PinnedAnalysis:
    if title is not None:
        p.title = title.strip()[:160] or p.title
    if code is not None:
        p.code = code[:20000]
    if datasets is not None:
        p.datasets = [d.model_dump() for d in datasets]
    p.version += 1
    p.updated_at = utcnow()
    p.cache_key, p.cache = "", {}
    db.commit()
    return p
