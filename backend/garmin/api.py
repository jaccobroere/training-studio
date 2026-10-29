"""Garmin + import endpoints: upload, runs, sync, coverage, activities. (The Inbox and linking
live on the plan side: GET /api/inbox and the link_activity op.)"""

from __future__ import annotations

import hashlib
import uuid
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

import db
from accounts.api import limit_user
from db import get_session
from garmin import sync, tokens
from garmin.store import activity_view, stream_for
from jobs import worker
from models import Activity, DailyMetric, ImportRun, RawAsset, SleepNight, Workout
from models.base import utcnow
from plan import changes, clock
from upload_limits import MAX_FILE_BYTES, UploadRoute, storage_denied

router = APIRouter(prefix="/api")
# Top-level (main.py includes it), not nested in `router`: current FastAPI keeps a nested
# router's own route object, so the access log's route template would lose the /api prefix.
upload_router = APIRouter(prefix="/api", route_class=UploadRoute)
MAX_UPLOAD = MAX_FILE_BYTES
CONNECT_PER_DAY = (3, timedelta(hours=24))  # decision 24: Garmin locks accounts after failures
UPLOADS_PER_HOUR = (10, timedelta(hours=1))  # each export ZIP is a long background import
MFA_TTL = timedelta(minutes=10)
_pending_mfa: dict[int, tuple[object, datetime]] = {}  # uid → (client state, expires); memory only

# What a sync fetches (decision 26: shown read-only, no per-type toggles).
SYNCED_TYPES = [
    {
        "key": "activities",
        "label": "Activities",
        "detail": "Every recorded workout, with the original FIT file (laps, HR, pace, power)",
    },
    {
        "key": "daily",
        "label": "Daily summary",
        "detail": "Steps, resting heart rate, stress, Body Battery",
    },
    {"key": "sleep", "label": "Sleep", "detail": "Duration, stages, score"},
    {"key": "hrv", "label": "HRV", "detail": "Overnight average and 7-day average"},
    {"key": "vo2max", "label": "VO2max", "detail": "Garmin's running estimate"},
    {"key": "readiness", "label": "Training readiness", "detail": "Garmin's daily score"},
    {
        "key": "respiration",
        "label": "Respiration",
        "detail": "Average breaths per minute during sleep",
    },
    {
        "key": "spo2",
        "label": "Pulse ox",
        "detail": "Average SpO2 during sleep (if your watch measures it)",
    },
    {
        "key": "weight",
        "label": "Weight",
        "detail": "From a Garmin scale or entered in Garmin Connect",
    },
]


def _run_view(r: ImportRun) -> dict:
    return {
        "id": r.id,
        "kind": r.kind,
        "state": r.state,
        "created_at": r.created_at.isoformat() + "Z",
        "started_at": r.started_at.isoformat() + "Z" if r.started_at else None,
        "finished_at": r.finished_at.isoformat() + "Z" if r.finished_at else None,
        "params": {k: v for k, v in (r.params or {}).items() if k != "path"},
        "progress": r.progress,
        "report": r.report,
    }


@router.get("/garmin/status")
def status(db_: Session = Depends(get_session)) -> dict:
    st = sync.state(db_)
    cov = []
    for metric, first, last, n in db_.execute(
        select(
            DailyMetric.metric, func.min(DailyMetric.day), func.max(DailyMetric.day), func.count()
        ).group_by(DailyMetric.metric)
    ).all():
        cov.append(
            {
                "metric": metric,
                "first": first.isoformat(),
                "last": last.isoformat(),
                "n": n,
                "expected": (last - first).days + 1,
            }
        )
    a_first, a_last, a_n = db_.execute(
        select(func.min(Activity.local_date), func.max(Activity.local_date), func.count())
    ).one()
    latest = db_.scalars(select(Activity.start_utc).order_by(Activity.start_utc.desc())).first()
    latest_metric = db_.scalars(select(DailyMetric.day).order_by(DailyMetric.day.desc())).first()
    demo = (
        db_.scalars(select(Activity.id).where(Activity.source == "demo")).first() is not None
        or db_.scalars(select(DailyMetric.day).where(DailyMetric.source == "demo")).first()
        is not None
    )
    backfill = db_.scalars(
        select(ImportRun)
        .where(ImportRun.kind == "backfill")
        .where(ImportRun.state.in_(("queued", "running", "paused")))
        .order_by(ImportRun.created_at.desc())
    ).first()
    nxt, off = sync.next_pull(db_), sync.backing_off(db_)
    return {
        "connected": sync.connected(db_),
        "token_present": tokens.present(),
        "token_key": tokens.available(),
        "state": {
            k: v for k, v in st.items() if k in ("auth", "last_pull", "last_error", "connected_at")
        },
        "settings": sync.settings(db_),
        "intervals_h": list(sync.INTERVALS_H),
        "next_pull": nxt.isoformat() + "Z" if nxt else None,
        "backoff_until": off.isoformat() + "Z" if off else None,
        "backfill": _run_view(backfill) if backfill else None,
        "backfill_max_days": sync.BACKFILL_MAX_DAYS,
        "synced_types": SYNCED_TYPES,
        "pull_every_h": sync.settings(db_)["interval_h"],
        "demo_present": demo,
        "activities": {
            "n": a_n,
            "first": a_first.isoformat() if a_first else None,
            "last": a_last.isoformat() if a_last else None,
        },
        "data_through": max(
            filter(None, [latest.date() if latest else None, latest_metric]), default=None
        ),
        "coverage": sorted(cov, key=lambda c: c["metric"]),
    }


@upload_router.post("/garmin/upload")
async def upload(file: UploadFile, request: Request, db_: Session = Depends(get_session)):
    name = (file.filename or "upload").rsplit("/", 1)[-1][:200]
    low = name.lower()
    if not low.endswith((".zip", ".fit")):
        raise HTTPException(
            422,
            {
                "code": "unsupported_file",
                "detail": "Upload a Garmin export .zip or an activity .fit file",
            },
        )
    limit_user(request, "garmin:upload", UPLOADS_PER_HOUR, "uploads this hour")
    if (denied := storage_denied(_uid(request))) is not None:
        return denied
    up = db.data_dir() / "uploads"
    up.mkdir(parents=True, exist_ok=True)
    tmp = up / f"{uuid.uuid4().hex}.part"
    h, size = hashlib.sha256(), 0
    try:
        with tmp.open("wb") as f:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD:
                    raise HTTPException(413, {"code": "too_large"})
                h.update(chunk)
                f.write(chunk)
        final = up / f"{h.hexdigest()}{'.zip' if low.endswith('.zip') else '.fit'}"
        tmp.replace(final)
    finally:
        # Errors/cancellation remove only this attempt's .part, never prior imports.
        tmp.unlink(missing_ok=True)
    rid = worker.enqueue(
        "archive" if low.endswith(".zip") else "fit",
        {"path": str(final.relative_to(db.data_dir())), "filename": name, "size": size},
    )
    return _run_view(db_.get(ImportRun, rid))


@router.get("/imports")
def runs(db_: Session = Depends(get_session)) -> list[dict]:
    return [
        _run_view(r)
        for r in db_.scalars(select(ImportRun).order_by(ImportRun.created_at.desc()).limit(30))
    ]


@router.get("/imports/{rid}")
def run(rid: str, db_: Session = Depends(get_session)) -> dict:
    r = db_.get(ImportRun, rid)
    if r is None:
        raise HTTPException(404, {"code": "run_not_found"})
    return _run_view(r)


@router.post("/imports/{rid}/cancel")
def cancel(rid: str, db_: Session = Depends(get_session)) -> dict:
    r = db_.get(ImportRun, rid)
    if r is None:
        raise HTTPException(404, {"code": "run_not_found"})
    if r.state == "queued":
        r.state = "cancelled"
    elif r.state == "running":
        r.cancel_requested = True
    db_.commit()
    return _run_view(r)


class SyncIn(BaseModel):
    start: date | None = None


@router.post("/garmin/sync")
def sync_now(body: SyncIn, db_: Session = Depends(get_session)) -> dict:
    if not sync.connected(db_):
        raise HTTPException(
            409, {"code": "not_connected", "detail": "Connect Garmin first (Data → Sync)."}
        )
    rid = worker.enqueue(
        "pull", {"start": body.start.isoformat() if body.start else None, "manual": True}
    )
    return _run_view(db_.get(ImportRun, rid))


@router.get("/activities")
def activities(start: date, end: date, db_: Session = Depends(get_session)) -> list[dict]:
    rows = db_.scalars(
        select(Activity)
        .where(Activity.local_date >= start)
        .where(Activity.local_date <= end)
        .order_by(Activity.start_utc.desc())
        .limit(500)
    ).all()
    return [activity_view(a) for a in rows]


@router.get("/activities/{aid}")
def activity(aid: str, points: int = 1200, db_: Session = Depends(get_session)) -> dict:
    a = db_.get(Activity, aid)
    if a is None:
        raise HTTPException(404, {"code": "activity_not_found"})
    out = activity_view(a)
    stream = stream_for(db_, a)
    if stream:
        n = len(stream["t"])
        step = max(1, n // max(points, 50))  # display downsampling only; stored stream is untouched
        out["stream"] = {k: v[::step] for k, v in stream.items() if isinstance(v, list)}
        out["stream_points"] = {"stored": n, "shown": len(out["stream"]["t"])}
    w = db_.get(Workout, a.workout_id) if a.workout_id else None
    out["workout"] = (
        {
            "id": w.id,
            "title": w.title,
            "type": w.type,
            "date": w.date.isoformat() if w.date else None,
            "week_monday": w.week_monday.isoformat(),
            "items": w.items or [],
        }
        if w
        else None
    )
    return out


def _unlink(db_: Session, ids: list[str], reason: str) -> int:
    """Remove plan links to recordings that are about to be deleted, through the seam."""
    linked = (
        list(
            db_.scalars(
                select(Activity.id)
                .where(Activity.id.in_(ids))
                .where(Activity.workout_id.is_not(None))
            )
        )
        if ids
        else []
    )
    if linked:
        changes.apply_change(
            db_,
            [{"op": "unlink_activity", "activity_id": i} for i in linked],
            source="ui",
            reason=reason,
        )
    return len(linked)


@router.delete("/garmin/demo")
def remove_demo(db_: Session = Depends(get_session)) -> dict:
    """Delete every demo record (never real data). Plan links to demo activities are
    removed through the change seam so history stays truthful."""
    demo_ids = list(db_.scalars(select(Activity.id).where(Activity.source == "demo")))
    n_linked = _unlink(db_, demo_ids, "Removed demo data")
    n_a = db_.execute(delete(Activity).where(Activity.source == "demo")).rowcount
    n_m = db_.execute(delete(DailyMetric).where(DailyMetric.source == "demo")).rowcount
    n_s = db_.execute(delete(SleepNight).where(SleepNight.source == "demo")).rowcount
    db_.commit()
    import shutil

    shutil.rmtree(
        db.data_dir() / "derived", ignore_errors=True
    )  # per-activity caches (health/derived.py)
    return {"activities": n_a, "metrics": n_m, "nights": n_s, "unlinked": n_linked}


# ------------------------------------------------------------------ Sync settings (decisions 24, 26)


class ConnectIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=256)


class MfaIn(BaseModel):
    code: str = Field(min_length=4, max_length=12)


def _uid(request: Request) -> int:
    return request.scope["state"]["user_id"]


def _connected(db_: Session) -> dict:
    sync.set_state(
        db_,
        auth="ok",
        last_error=None,
        backoff_until=None,
        failure_count=0,
        connected_at=utcnow().isoformat(),
    )
    rid = worker.enqueue("pull", {"first": True})  # the last 3 days, right away
    return {"state": "connected", "run": rid}


def _garmin_error(e: Exception, left: int):
    from garminconnect import GarminConnectAuthenticationError, GarminConnectTooManyRequestsError

    if isinstance(e, tokens.KeyMissing):
        raise HTTPException(503, {"code": "garmin_unavailable", "detail": tokens.KEY_HELP}) from e
    if isinstance(e, PermissionError):
        # The same operator problem as the sync path (an unreadable token file), so it must not
        # look like "Garmin unreachable" or invite a retry.
        raise HTTPException(
            503, {"code": "garmin_unavailable", "detail": tokens.UNREADABLE_HELP}
        ) from e
    if isinstance(e, GarminConnectTooManyRequestsError):
        raise HTTPException(
            429,
            {
                "code": "garmin_busy",
                "detail": "Garmin is refusing sign-ins right now. Wait a few hours "
                "before trying again.",
            },
        ) from e
    if isinstance(e, GarminConnectAuthenticationError):
        raise HTTPException(
            401,
            {
                "code": "garmin_rejected",
                "attempts_left": left,
                "detail": "Garmin didn't accept that sign-in. Check it in the Garmin Connect app first; "
                f"{left} attempt{'s' if left != 1 else ''} left today.",
            },
        ) from e
    raise HTTPException(
        502,
        {
            "code": "garmin_unreachable",
            "attempts_left": left,
            "detail": "Couldn't reach Garmin. Nothing was saved; try again later.",
        },
    ) from e


@router.post("/garmin/connect")
def connect(body: ConnectIn, request: Request, db_: Session = Depends(get_session)) -> dict:
    """Sign in to Garmin once. The password is used in memory for this request only."""
    from accounts import service

    uid = _uid(request)
    if not tokens.available():  # nowhere safe to keep the tokens: don't spend an attempt
        raise HTTPException(503, {"code": "garmin_unavailable", "detail": tokens.KEY_HELP})
    with db.auth_db().session() as a:
        lim = service.hit(
            a, f"garmin:user:{uid}:connect", max_count=CONNECT_PER_DAY[0], window=CONNECT_PER_DAY[1]
        )
    if not lim.allowed:
        raise HTTPException(
            429,
            {
                "code": "rate_limited",
                "retry_after": lim.retry_after,
                "detail": "Three Garmin sign-in attempts per day, to keep your Garmin account from being "
                "locked. Try again tomorrow.",
            },
            headers={"Retry-After": str(lim.retry_after)},
        )
    try:
        status, pending = sync.connect(body.email.strip(), body.password)
    except Exception as e:
        _garmin_error(e, lim.remaining)
    if status == "needs_mfa":
        _pending_mfa[uid] = (pending, utcnow() + MFA_TTL)
        return {
            "state": "needs_mfa",
            "detail": "Garmin sent you a code (email or authenticator app).",
        }
    return _connected(db_)


@router.post("/garmin/connect/mfa")
def connect_mfa(body: MfaIn, request: Request, db_: Session = Depends(get_session)) -> dict:
    uid = _uid(request)
    got = _pending_mfa.pop(uid, None)
    if got is None or got[1] < utcnow():
        raise HTTPException(
            409,
            {"code": "mfa_expired", "detail": "The code request expired. Start the sign-in again."},
        )
    try:
        sync.connect("", "", mfa=got[0], code=body.code.strip())
    except Exception as e:
        _garmin_error(e, 0)
    return _connected(db_)


@router.post("/garmin/disconnect")
def disconnect(request: Request, db_: Session = Depends(get_session)) -> dict:
    _pending_mfa.pop(_uid(request), None)
    sync.disconnect(db_)
    return {"ok": True}


class SettingsIn(BaseModel):
    auto: bool | None = None
    interval_h: float | None = None


@router.patch("/garmin/settings")
def patch_settings(body: SettingsIn, db_: Session = Depends(get_session)) -> dict:
    if body.interval_h is not None and body.interval_h not in sync.INTERVALS_H:
        raise HTTPException(
            422,
            {"code": "bad_interval", "detail": f"Choose one of {list(sync.INTERVALS_H)} hours."},
        )
    sync.set_state(db_, **{k: v for k, v in body.model_dump().items() if v is not None})
    return sync.settings(db_)


class BackfillIn(BaseModel):
    start: date


@router.post("/garmin/backfill")
def backfill(body: BackfillIn, db_: Session = Depends(get_session)) -> dict:
    """Fetch history from `start` to today as a slow background job (oldest first, 14 days per
    step, ~1 s between calls; pauses on Garmin rate limits and resumes on its own)."""
    if not sync.connected(db_):
        raise HTTPException(409, {"code": "not_connected", "detail": "Connect Garmin first."})
    today = clock.today()
    if body.start > today:
        raise HTTPException(422, {"code": "bad_start", "detail": "Pick a date in the past."})
    if (today - body.start).days > sync.BACKFILL_MAX_DAYS:
        raise HTTPException(
            422,
            {
                "code": "too_far_back",
                "detail": "At most five years back. For older history, upload a Garmin export ZIP.",
            },
        )
    if db_.scalars(
        select(ImportRun.id)
        .where(ImportRun.kind == "backfill")
        .where(ImportRun.state.in_(("queued", "running", "paused")))
    ).first():
        raise HTTPException(
            409, {"code": "backfill_running", "detail": "A backfill is already running."}
        )
    rid = worker.enqueue("backfill", {"start": body.start.isoformat(), "end": today.isoformat()})
    return _run_view(db_.get(ImportRun, rid))


class DeleteIn(BaseModel):
    confirm: str


@router.post("/garmin/delete-data")
def delete_synced(body: DeleteIn, db_: Session = Depends(get_session)) -> dict:
    """Delete everything that came from Garmin (sync and export uploads): activities, streams,
    daily metrics, sleep and the kept originals. Plans stay; links to deleted recordings are
    removed through the change seam so history stays truthful. Tokens are not touched."""
    import shutil

    if body.confirm.strip().lower() != "delete":
        raise HTTPException(422, {"code": "confirm_mismatch", "detail": "Type delete to confirm."})
    ids = list(db_.scalars(select(Activity.id).where(Activity.source == "garmin")))
    n_linked = _unlink(db_, ids, "Deleted synced Garmin data")
    paths = [
        p for p in db_.scalars(select(Activity.stream_path).where(Activity.source == "garmin")) if p
    ]
    n_a = db_.execute(delete(Activity).where(Activity.source == "garmin")).rowcount
    n_m = db_.execute(delete(DailyMetric).where(DailyMetric.source == "garmin")).rowcount
    n_s = db_.execute(delete(SleepNight).where(SleepNight.source == "garmin")).rowcount
    n_r = db_.execute(delete(RawAsset)).rowcount
    db_.commit()
    root = db.data_dir()
    for p in paths:
        (root / p).unlink(missing_ok=True)
    shutil.rmtree(root / "raw", ignore_errors=True)
    shutil.rmtree(root / "derived", ignore_errors=True)
    sync.set_state(db_, last_pull=None)
    return {
        "activities": n_a,
        "metrics": n_m,
        "nights": n_s,
        "originals": n_r,
        "unlinked": n_linked,
    }
