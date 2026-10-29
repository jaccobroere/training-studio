"""Send an analysis job to the sandbox: the pyrunner service in production (PYRUNNER_URL),
or a local limited subprocess in development and tests. Production without PYRUNNER_URL fails
closed: model-written code never runs in the app's container. Every chart that comes back is
re-validated (pyrunner/chartspec.py) before it is stored: the sandbox's output is not trusted."""

from __future__ import annotations

import hashlib
import logging
import threading
import uuid
from datetime import date

import httpx
from sqlalchemy.orm import Session

from analysis.snapshot import DatasetSpec, Snapshot, build
from core.settings import settings
from models import Analysis, PinnedAnalysis
from models.base import utcnow
from pyrunner import chartspec
from pyrunner.execute import run_job

log = logging.getLogger("sports.analysis")
KEEP = ("stdout", "truncated", "error", "error_brief", "charts", "tables")
# At most two sandbox runs at once across all users (each can take seconds of CPU); a third
# waits up to BUSY_WAIT_S, then gives up with AnalysisBusy (HTTP 503).
SLOTS = threading.BoundedSemaphore(2)
BUSY_WAIT_S = 30.0


class AnalysisBusy(RuntimeError):
    """Every sandbox slot stayed taken for BUSY_WAIT_S."""


def sandbox(code: str, data: dict) -> tuple[dict, str]:
    """→ (result with status ok|error|failed|timeout, runner name). Raises AnalysisBusy."""
    if not SLOTS.acquire(timeout=BUSY_WAIT_S):
        raise AnalysisBusy()
    try:
        return _sandbox(code, data)
    finally:
        SLOTS.release()


def _sandbox(code: str, data: dict) -> tuple[dict, str]:
    url = settings().pyrunner_url
    if not url and settings().app_env == "production":
        # Fail closed: model-written code never runs in the app's own container.
        log.error("analysis runner not configured", extra={"event": "analysis.runner_missing"})
        return {
            "status": "failed",
            "error": "analysis runner unavailable (not configured)",
            "charts": [],
        }, "none"
    if url:
        try:
            r = httpx.post(f"{url.rstrip('/')}/run", json={"code": code, "data": data}, timeout=40)
            out = (
                r.json()
                if r.status_code == 200
                else {"status": "failed", "error": f"runner HTTP {r.status_code}"}
            )
        except httpx.HTTPError as e:
            out = {"status": "failed", "error": f"analysis runner unavailable ({type(e).__name__})"}
        runner = "pyrunner-service"
    else:
        out = run_job(code, data)
        runner = "local-subprocess"
    charts = []
    for c in out.get("charts") or []:
        try:
            charts.append(chartspec.validate(c))
        except chartspec.ChartError as e:
            out.setdefault("warnings", []).append(f"a chart was dropped: {e}")
    out["charts"] = charts
    return out, runner


def execute(
    db: Session,
    *,
    question: str,
    code: str,
    datasets: list[DatasetSpec],
    title: str = "",
    conversation_id: str | None = None,
) -> Analysis:
    """Build the snapshot (ValueError on a bad dataset request), run, store a new row."""
    from plan import clock

    today = clock.today()
    snap = build(db, datasets, today=today)
    out, runner = sandbox(code, snap.data)
    row = Analysis(
        id=f"a-{uuid.uuid4().hex[:10]}",
        question=question[:2000],
        title=title[:160],
        code=code[:20000],
        datasets=[d.model_dump() for d in datasets],
        ranges=snap.ranges,
        dataset_hash=snap.digest,
        rows=snap.rows,
        status=out.get("status", "failed"),
        result={k: out[k] for k in (*KEEP, "warnings") if k in out},
        duration_s=out.get("duration_s", 0),
        conversation_id=conversation_id,
        runner=runner,
        ran_on=today,
    )
    db.add(row)
    db.commit()
    return row


def specs_of(raw: list[dict]) -> list[DatasetSpec]:
    return [DatasetSpec(**d) for d in raw]


def view(a: Analysis) -> dict:
    return {
        "id": a.id,
        "question": a.question,
        "title": a.title or chart_title(a.result) or a.question[:80],
        "code": a.code,
        "datasets": a.datasets,
        "ranges": a.ranges,
        "dataset_hash": a.dataset_hash,
        "rows": a.rows,
        "status": a.status,
        "result": a.result,
        "duration_s": a.duration_s,
        "runner": a.runner,
        "at": a.at.isoformat() + "Z",
    }


def chart_title(result: dict | None) -> str:
    return next((c.get("title") for c in (result or {}).get("charts") or [] if c.get("title")), "")


def brief_error(result: dict, rows: dict | None = None) -> dict:
    """The compact, actionable error the model gets back (it fixes its code from this)."""
    b = result.get("error_brief") or {}
    if b:
        out = {
            "error": b.get("message"),
            "line": b.get("line"),
            "code_line": b.get("code"),
            "hint": b.get("hint"),
        }
    else:
        err = (result.get("error") or "").strip()
        out = {"error": err.splitlines()[-1][:400] if err else "the analysis did not finish"}
        if "time limit" in err or "CPU" in err:
            out["hint"] = (
                "Too slow: vectorise with pandas (no Python loops over rows), sample streams (every_s)."
            )
    return {k: v for k, v in out.items() if v is not None}


# ------------------------------------------------------------------ pinned


def cache_key(code: str, digest: str) -> str:
    return hashlib.sha256(f"{code}\0{digest}".encode()).hexdigest()


def run_pinned(
    db: Session, p: PinnedAnalysis, *, force: bool = False, today: date | None = None
) -> dict:
    """Re-run a pinned analysis on today's data, or return the cached result when neither the
    code nor the snapshot changed. Infrastructure failures (timeout, runner down) aren't cached."""
    try:
        snap: Snapshot = build(db, specs_of(p.datasets), today=today)
    except ValueError as e:
        return {
            "status": "error",
            "cached": False,
            "result": {"error": str(e)},
            "rows": {},
            "ranges": [],
        }
    key = cache_key(p.code, snap.digest)
    if not force and p.cache_key == key and p.cache:
        return {**p.cache, "cached": True}
    out, _ = sandbox(p.code, snap.data)
    status = out.get("status", "failed")
    entry = {
        "status": status,
        "result": {k: out[k] for k in (*KEEP, "warnings") if k in out},
        "rows": snap.rows,
        "ranges": snap.ranges,
        "dataset_hash": snap.digest,
        "duration_s": out.get("duration_s", 0),
        "ran_at": utcnow().isoformat() + "Z",
    }
    if status in ("ok", "error"):
        p.cache_key, p.cache = key, entry
        db.commit()
    return {**entry, "cached": False}


def pinned_view(p: PinnedAnalysis) -> dict:
    return {
        "id": p.id,
        "title": p.title,
        "code": p.code,
        "datasets": p.datasets,
        "position": p.position,
        "created_from": p.created_from,
        "version": p.version,
        "created_at": p.created_at.isoformat() + "Z",
        "updated_at": p.updated_at.isoformat() + "Z",
    }
