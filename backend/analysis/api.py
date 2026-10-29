"""Analyses (sandbox runs, inspectable from the chat card) and Pinned analyses (Health)."""

from __future__ import annotations

import csv
import io
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from accounts.api import limit_user
from analysis import pinned as pins
from analysis.runner import AnalysisBusy, execute, pinned_view, run_pinned, specs_of, view
from analysis.snapshot import DatasetSpec, build
from db import get_session
from models import Analysis

router = APIRouter(prefix="/api")
RUNS = (20, timedelta(minutes=10))  # forced sandbox runs per user (reruns, pinned force-refresh)


def _busy() -> HTTPException:
    return HTTPException(
        503,
        {"code": "analysis_busy", "detail": "Analysis is busy; try again in a moment."},
        headers={"Retry-After": "10"},
    )


def _analysis(db: Session, aid: str) -> Analysis:
    a = db.get(Analysis, aid)
    if a is None:
        raise HTTPException(404, {"code": "analysis_not_found"})
    return a


def _abs_specs(a: Analysis) -> list[DatasetSpec]:
    """The datasets exactly as they resolved when it ran (relative ranges pinned to that day)."""
    by = {r["name"]: r for r in a.ranges or []}
    return [
        s.model_copy(update={"start": by[s.name]["start"], "end": by[s.name]["end"]})
        if s.name in by
        else s
        for s in specs_of(a.datasets)
    ]


@router.get("/analyses")
def recent(db: Session = Depends(get_session)) -> list[dict]:
    return [
        {
            "id": a.id,
            "question": a.question,
            "title": a.title,
            "status": a.status,
            "at": a.at.isoformat() + "Z",
        }
        for a in db.scalars(select(Analysis).order_by(Analysis.at.desc()).limit(50))
    ]


@router.get("/analyses/{aid}")
def one(aid: str, db: Session = Depends(get_session)) -> dict:
    a = _analysis(db, aid)
    out = view(a)
    # Is the data it ran on still the data we have? (A32: never present old results as current)
    try:
        out["data_changed_since"] = build(db, _abs_specs(a)).digest != a.dataset_hash
    except ValueError:
        out["data_changed_since"] = None
    out["pinned_id"] = next((p.id for p in pins.ordered(db) if p.created_from == a.id), None)
    return out


@router.get("/analyses/{aid}/table/{n}.csv")
def table_csv(aid: str, n: int, db: Session = Depends(get_session)) -> Response:
    a = db.get(Analysis, aid)
    tables = (a.result or {}).get("tables", []) if a else []
    if not a or n >= len(tables):
        raise HTTPException(404, {"code": "table_not_found"})
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(tables[n]["columns"])
    w.writerows(tables[n]["rows"])
    return Response(
        buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{aid}-table-{n}.csv"'},
    )


@router.get("/analyses/{aid}/data.csv")
def data_csv(aid: str, dataset: int = 0, db: Session = Depends(get_session)) -> Response:
    """The dataset the analysis ran on (same ranges), re-exported now."""
    a = _analysis(db, aid)
    if dataset >= len(a.datasets):
        raise HTTPException(404, {"code": "dataset_not_found"})
    spec = _abs_specs(a)[dataset]
    rows = build(db, [spec]).data[spec.name]
    buf = io.StringIO()
    if rows:
        w = csv.DictWriter(buf, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    return Response(
        buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{aid}-{spec.name}.csv"'},
    )


@router.post("/analyses/{aid}/rerun")
def rerun(aid: str, request: Request, db: Session = Depends(get_session)) -> dict:
    """Run the same code on today's data (relative ranges move with today): a new result,
    the old one untouched."""
    a = _analysis(db, aid)
    limit_user(request, "analysis:runs", RUNS, "analysis runs")
    try:
        b = execute(
            db,
            question=a.question,
            title=a.title,
            code=a.code,
            datasets=specs_of(a.datasets),
            conversation_id=a.conversation_id,
        )
    except AnalysisBusy:
        raise _busy() from None
    return view(b)


# ------------------------------------------------------------------ pinned


def _err(e: pins.PinError) -> HTTPException:
    return HTTPException(e.status, {"code": e.code, "detail": e.detail})


class PinIn(BaseModel):
    analysis_id: str
    title: str | None = Field(None, max_length=160)


class OrderIn(BaseModel):
    ids: list[str] = Field(max_length=pins.MAX_PINNED)


@router.get("/pinned")
def pinned_list(db: Session = Depends(get_session)) -> list[dict]:
    return [pinned_view(p) for p in pins.ordered(db)]


@router.post("/pinned")
def pin(body: PinIn, db: Session = Depends(get_session)) -> dict:
    try:
        p, created = pins.pin(db, body.analysis_id, body.title)
    except pins.PinError as e:
        raise _err(e) from None
    return {**pinned_view(p), "created": created}


@router.put("/pinned/order")
def order(body: OrderIn, db: Session = Depends(get_session)) -> list[dict]:
    try:
        return [pinned_view(p) for p in pins.reorder(db, body.ids)]
    except pins.PinError as e:
        raise _err(e) from None


@router.delete("/pinned/{pid}")
def unpin(pid: str, db: Session = Depends(get_session)) -> dict:
    try:
        pins.unpin(db, pid)
    except pins.PinError as e:
        raise _err(e) from None
    return {"ok": True, "id": pid}


@router.get("/pinned/{pid}/run")
def run(
    pid: str, request: Request, force: bool = False, db: Session = Depends(get_session)
) -> dict:
    """Re-run on current data; cached by (code, snapshot hash), so reopening is cheap. Only a
    forced run (skipping the cache) counts against the per-user run limit."""
    try:
        p = pins.get(db, pid)
    except pins.PinError as e:
        raise _err(e) from None
    if force:
        limit_user(request, "analysis:runs", RUNS, "analysis runs")
    try:
        return {"pinned": pinned_view(p), **run_pinned(db, p, force=force)}
    except AnalysisBusy:
        raise _busy() from None
