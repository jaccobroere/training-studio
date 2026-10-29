"""In-process job runner: one daemon thread that works through every user's `import_run`
rows, one user at a time, each inside that user's context (decision 19).

Deliberately not a separate service: a single athlete's imports and 2-hourly pulls fit in
one process, and SQLite WAL lets plan editing continue while an import writes. Jobs survive
navigation (they are rows, not requests) and restarts (rows left `running` are re-queued).
Set JOBS_ENABLED=0 to disable (tests drive `run_next` directly)."""

from __future__ import annotations

import logging
import threading
import time
import uuid
from datetime import timedelta
from pathlib import Path

from sqlalchemy import delete, func, select

import db
from core.settings import settings
from garmin import sync
from garmin.importer import ImportCancelled, Report, import_archive, import_fit
from models import ImportRun
from models.base import utcnow

log = logging.getLogger("sports.jobs")

# Defense in depth against a state bug (e.g. an unexpected exception that leaves `due()` true):
# a scheduled pull can never turn into a hot loop while this many failed pull rows exist for
# the hour.
PULLS_PER_HOUR_MAX = 12
# The loop ticks every 5 s: warn about a capped user at most hourly, not on every pass.
CAP_WARNING_EVERY_S = 3600
_cap_warned: dict[int, float] = {}

# Import history is an operator aid, not an archive: keep finished rows for 90 days and at most
# this many per kind (queued/running/paused rows are always kept).
IMPORT_RUN_KEEP_DAYS = 90
IMPORT_RUNS_PER_KIND = 500
FINISHED_STATES = ("done", "partial", "failed", "cancelled")


def enqueue(kind: str, params: dict) -> str:
    with db.get_db().session() as s:
        rid = f"imp-{uuid.uuid4().hex[:10]}"
        s.add(ImportRun(id=rid, kind=kind, state="queued", params=params, progress={}, report={}))
        s.commit()
        return rid


def _runner(rid: str):
    def progress(done: int, total: int) -> None:
        with db.get_db().session() as s:
            r = s.get(ImportRun, rid)
            if r:
                r.progress = {"done": done, "total": total}
                s.commit()

    def cancelled() -> bool:
        with db.get_db().session() as s:
            r = s.get(ImportRun, rid)
            return bool(r and r.cancel_requested)

    return progress, cancelled


BACKFILL_CHUNK_DAYS = 14


def _merge(a: dict, b: dict) -> dict:
    """Accumulate a backfill chunk's report into the run's running total."""
    out = {
        **a,
        "files": dict(a.get("files") or {}),
        "records": {k: dict(v) for k, v in (a.get("records") or {}).items()},
    }
    for k, v in (b.get("files") or {}).items():
        out["files"][k] = out["files"].get(k, 0) + v
    for kind, c in (b.get("records") or {}).items():
        cur = out["records"].setdefault(kind, {"new": 0, "updated": 0, "same": 0})
        for st, n in c.items():
            cur[st] = cur.get(st, 0) + n
    ranges = dict(a.get("ranges") or {})
    for kind, (lo, hi) in (b.get("ranges") or {}).items():
        r = ranges.get(kind)
        ranges[kind] = [min(r[0], lo), max(r[1], hi)] if r else [lo, hi]
    out["ranges"] = ranges
    out["errors"] = ((a.get("errors") or []) + (b.get("errors") or []))[-50:]
    out["n_errors"] = (a.get("n_errors") or 0) + (b.get("n_errors") or 0)
    return out


def _backfill_step(rid: str, params: dict, cancelled) -> str:
    """One chunk of a backfill (decision 26): fetch BACKFILL_CHUNK_DAYS, oldest first, save the
    cursor, and hand the queue back so other work (and other users) interleave. A Garmin 429
    pauses the run until the back-off ends; it then resumes where it stopped."""
    from datetime import date, timedelta

    start, end = date.fromisoformat(params["start"]), date.fromisoformat(params["end"])
    cur = date.fromisoformat(params.get("cursor") or params["start"])
    chunk_end = min(cur + timedelta(days=BACKFILL_CHUNK_DAYS - 1), end)
    total = (end - start).days + 1
    paused = False
    with db.get_db().session() as s:
        try:
            rep = sync.pull(
                s, rid, start=cur, end=chunk_end, cancelled=cancelled, raise_on_limit=True
            ).as_dict()
        except sync.RateLimited:
            paused, rep = True, {}
    with db.get_db().session() as s:
        r = s.get(ImportRun, rid)
        r.report = _merge(r.report or {}, rep)
        if r.cancel_requested:
            r.state, r.finished_at = "cancelled", utcnow()
        elif paused:
            r.state = "paused"
            r.params = {**params, "resume_at": sync.state(s).get("backoff_until")}
        elif rep.get("files", {}).get("failed") and not rep.get("files", {}).get("parsed"):
            r.state, r.finished_at = "failed", utcnow()  # e.g. the sign-in expired
        elif chunk_end >= end:
            r.state, r.finished_at = ("partial" if r.report.get("n_errors") else "done"), utcnow()
            r.progress = {"done": total, "total": total}
        else:
            nxt = chunk_end + timedelta(days=1)
            r.params = {**params, "cursor": nxt.isoformat()}
            r.progress = {"done": (nxt - start).days, "total": total}
            r.state = "queued"
        s.commit()
        return r.state


def run_next() -> str | None:
    """Run the oldest queued job (one chunk, for a backfill). Returns its id, or None if idle."""
    with db.get_db().session() as s:
        run = s.scalars(
            select(ImportRun).where(ImportRun.state == "queued").order_by(ImportRun.created_at)
        ).first()
        if run is None:
            return None
        run.state, run.started_at = "running", run.started_at or utcnow()
        s.commit()
        rid, kind, params = run.id, run.kind, dict(run.params)
    progress, cancelled = _runner(rid)
    if kind == "backfill":
        try:
            _backfill_step(rid, params, cancelled)
        except Exception as e:
            log.exception("backfill %s failed", rid)
            with db.get_db().session() as s:
                r = s.get(ImportRun, rid)
                r.state, r.finished_at = "failed", utcnow()
                r.report = _merge(
                    r.report or {},
                    {"errors": [f"{type(e).__name__}: {str(e)[:300]}"], "n_errors": 1},
                )
                s.commit()
        return rid
    state, report = "failed", Report()
    failure: Exception | str | None = None
    try:
        with db.get_db().session() as s:
            if kind == "archive":
                data = (db.data_dir() / params["path"]).read_bytes()
                report = import_archive(
                    s,
                    data,
                    filename=params.get("filename", "export.zip"),
                    import_id=rid,
                    progress=progress,
                    cancelled=cancelled,
                )
            elif kind == "fit":
                data = (db.data_dir() / params["path"]).read_bytes()
                report = Report()
                import_fit(
                    s,
                    data,
                    filename=params.get("filename", "activity.fit"),
                    source="garmin",
                    import_id=rid,
                    report=report,
                )
                report.files["parsed"] += 1
                s.commit()
            elif kind == "pull":
                start = params.get("start")
                from datetime import date

                report = sync.pull(
                    s,
                    rid,
                    start=date.fromisoformat(start) if start else None,
                    cancelled=cancelled,
                    progress=progress,
                )
            state = report.state
            if state in ("done", "partial"):
                from plan.link import autolink

                linked = autolink(s)
                if linked:
                    report.autolinked = linked["summary"]
    except ImportCancelled:
        state = "cancelled"
    except Exception as e:
        log.exception("job %s failed", rid)
        failure = e
        report.errors.append(f"{type(e).__name__}: {str(e)[:300]}")
        report.files["failed"] += 1
        state = "failed"
    finally:
        if kind in ("archive", "fit") and params.get("path"):
            Path(db.data_dir() / params["path"]).unlink(
                missing_ok=True
            )  # the raw copy is kept in raw/
    with db.get_db().session() as s:
        scheduled = bool(params.get("scheduled") or params.get("first"))
        if kind == "pull" and state == "failed" and scheduled:
            # A failed scheduled pull must postpone the next one; a cancelled pull never counts,
            # and a manual sync does not push the automatic retry out.
            error = failure or (report.errors[-1] if report.errors else "Garmin sync failed.")
            sync.record_failure(s, error)
        r = s.get(ImportRun, rid)
        r.state, r.finished_at, r.report = state, utcnow(), report.as_dict()
        s.commit()
    return rid


def recover() -> None:
    with db.get_db().session() as s:
        for r in s.scalars(select(ImportRun).where(ImportRun.state == "running")):
            r.state = "queued"
        s.commit()


def resume_paused() -> None:
    """Re-queue backfills whose Garmin back-off has passed."""
    from datetime import datetime

    with db.get_db().session() as s:
        for r in s.scalars(select(ImportRun).where(ImportRun.state == "paused")):
            at = (r.params or {}).get("resume_at")
            if r.cancel_requested:
                r.state, r.finished_at = "cancelled", utcnow()
            elif not at or datetime.fromisoformat(at) <= utcnow():
                r.state = "queued"
        s.commit()


def active_users() -> list[int]:
    from accounts.models import User

    with db.auth_db().session() as s:
        return list(s.scalars(select(User.id).where(User.disabled.is_(False)).order_by(User.id)))


def _failed_pulls_in_the_last_hour(s) -> int:
    since = utcnow() - timedelta(hours=1)
    return (
        s.scalar(
            select(func.count())
            .select_from(ImportRun)
            .where(ImportRun.kind == "pull")
            .where(ImportRun.state == "failed")
            .where(ImportRun.created_at >= since)
        )
        or 0
    )


def tick() -> bool:
    """One pass over all users: run each user's next queued job, or schedule a due sync.
    Returns True if any work was done."""
    worked = False
    for uid in active_users():
        try:
            with db.as_user(uid):
                # Feedback is tiny and time-sensitive; give it a chance before a long
                # Garmin import can occupy this user's turn.
                try:
                    from feedback import outbox as feedback_outbox

                    feedback_outbox.flush(limit=3)
                except Exception:
                    log.exception("feedback forwarding failed for user %s", uid)
                resume_paused()
                if run_next() is not None:
                    worked = True
                    continue
                with db.get_db().session() as s:
                    busy = s.scalars(
                        select(ImportRun.id)
                        .where(ImportRun.kind.in_(("pull", "backfill")))
                        .where(ImportRun.state.in_(("queued", "running")))
                    ).first()
                    if not busy and sync.due(s):
                        recent = _failed_pulls_in_the_last_hour(s)
                        if recent >= PULLS_PER_HOUR_MAX:
                            if time.monotonic() - _cap_warned.get(uid, 0.0) > CAP_WARNING_EVERY_S:
                                _cap_warned[uid] = time.monotonic()
                                log.warning(
                                    "not scheduling a Garmin pull for user %s: "
                                    "%s failed Garmin pulls in the last hour (cap %s)",
                                    uid,
                                    recent,
                                    PULLS_PER_HOUR_MAX,
                                )
                        else:
                            enqueue("pull", {"scheduled": True})
                            worked = True
        except Exception:
            log.exception("job error for user %s", uid)
    return worked


HOUSEKEEPING_EVERY_S = 86400


def clear_tmp() -> None:
    """Empty DATA_DIR/tmp (production's TMPDIR: big export archives spool there, on the data
    volume rather than the small /tmp tmpfs). Startup only, when nothing can be using it.
    It sits outside users/<id>/, so it never counts towards anyone's storage."""
    import shutil

    tmp = db.data_root() / "tmp"
    if tmp.is_dir():
        for p in tmp.iterdir():
            if p.is_dir() and not p.is_symlink():
                shutil.rmtree(p, ignore_errors=True)
            else:
                p.unlink(missing_ok=True)


def prune_import_runs(
    *, keep_days: int = IMPORT_RUN_KEEP_DAYS, per_kind: int = IMPORT_RUNS_PER_KIND
) -> int:
    """Delete old finished import rows (inside the current user's database) by age and per kind.
    Queued, running and paused rows are the job queue and are never touched. Returns the count
    deleted."""
    deleted = 0
    with db.get_db().session() as s:
        done_at = func.coalesce(ImportRun.finished_at, ImportRun.created_at)
        cutoff = utcnow() - timedelta(days=keep_days)
        deleted += (
            s.execute(
                delete(ImportRun)
                .where(ImportRun.state.in_(FINISHED_STATES))
                .where(done_at < cutoff)
            ).rowcount
            or 0
        )
        kinds = list(s.scalars(select(ImportRun.kind).distinct()))
        for kind in kinds:
            boundary = s.scalar(
                select(done_at)
                .where(ImportRun.kind == kind)
                .where(ImportRun.state.in_(FINISHED_STATES))
                .order_by(done_at.desc())
                .offset(per_kind - 1)
                .limit(1)
            )
            if boundary is None:
                continue  # fewer than `per_kind` finished rows: nothing to trim
            deleted += (
                s.execute(
                    delete(ImportRun)
                    .where(ImportRun.kind == kind)
                    .where(ImportRun.state.in_(FINISHED_STATES))
                    .where(done_at < boundary)
                ).rowcount
                or 0
            )
        s.commit()
    return deleted


def housekeeping() -> None:
    """Daily (and at startup): drop deleted accounts' safety copies older than a week,
    rate-limit windows nobody has touched for days, and old import history for every account
    (disabled ones included, so a dormant runaway is cleaned up too)."""
    from accounts import service
    from accounts.models import User

    try:
        if n := service.purge_deleted():
            log.info("purged %s deleted-account cop%s", n, "y" if n == 1 else "ies")
    except Exception:
        log.exception("housekeeping failed")
    try:
        with db.auth_db().session() as s:
            service.purge_limits(s)
            uids = list(s.scalars(select(User.id).order_by(User.id)))
    except Exception:
        log.exception("housekeeping failed")
        return
    pruned = 0
    for uid in uids:
        try:
            with db.as_user(uid):
                pruned += prune_import_runs()
        except Exception:
            log.exception("housekeeping failed for user %s", uid)
    if pruned:
        log.info("pruned %s old import run%s", pruned, "" if pruned == 1 else "s")


def _loop(stop: threading.Event) -> None:
    # Imported here: alerts reads settings and models, and the worker must not create an import
    # cycle while the app is still wiring its routers.
    from alerts import CHECK_EVERY_S as ALERTS_EVERY_S
    from alerts import check as check_alerts

    for uid in active_users():
        with db.as_user(uid):
            recover()
    last_clean = time.monotonic()
    last_alerts = time.monotonic() - ALERTS_EVERY_S  # run soon after startup
    while not stop.is_set():
        try:
            if time.monotonic() - last_clean > HOUSEKEEPING_EVERY_S:
                housekeeping()
                last_clean = time.monotonic()
            if time.monotonic() - last_alerts > ALERTS_EVERY_S:
                check_alerts()
                last_alerts = time.monotonic()
            if not tick():
                stop.wait(5)
        except Exception:
            log.exception("job loop error")
            stop.wait(30)


_stop = threading.Event()


def start() -> None:
    if not settings().jobs_enabled:
        return
    threading.Thread(target=_loop, args=(_stop,), name="jobs", daemon=True).start()


def stop() -> None:
    _stop.set()
