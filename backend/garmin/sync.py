"""Garmin Connect for one user (python-garminconnect), per decisions 12, 24 and 26.

Rules that keep the account safe: the worker only ever *loads* tokens; it never logs in
with a password and never retries a failed login (Garmin locks accounts for days after
repeated failures). The password is used once, in memory, by `connect()` when the athlete
presses Connect; only the refreshable tokens are kept, encrypted (garmin/tokens.py:
`users/<id>/garmin/tokens.enc`, 0600, outside the database so exports never include them;
the key is not in the backups). An auth failure sets
"needs_reauth" and stops until the athlete reconnects in Data → Sync. A 429 backs off for
hours. Raw JSON is kept."""

from __future__ import annotations

import io
import json
import time
import zipfile
from datetime import date, datetime, timedelta

from sqlalchemy.orm import Session

from core.settings import settings as app_settings
from garmin import parse, store, tokens
from garmin.importer import Report, import_fit
from models import Activity, Setting
from models.base import utcnow
from plan import clock

INTERVALS_H = (1, 2, 6, 12, 24)
BACKFILL_MAX_DAYS = 1826  # five years
REAUTH = "Garmin no longer accepts the saved sign-in. Reconnect in Data → Sync."


class RateLimited(Exception):
    pass


BACKOFF = timedelta(hours=6)
# Any failed pull waits before the next attempt: 5 min, doubling per consecutive failure, capped
# at the athlete's own sync interval (a permission error must never turn into a pull loop).
FAILURE_BACKOFF = timedelta(minutes=5)
FAILURE_EXPONENT_MAX = 10


def state(db: Session) -> dict:
    row = db.get(Setting, "garmin")
    return dict(row.value) if row else {}


def set_state(db: Session, **kw) -> dict:
    row = db.get(Setting, "garmin") or Setting(key="garmin", value={})
    row.value = {**(row.value or {}), **kw}
    db.merge(row)
    db.commit()
    return row.value


def connected(db: Session) -> bool:
    """Tokens are stored, the server can decrypt them, and Garmin last accepted them."""
    return tokens.present() and tokens.available() and state(db).get("auth") != "needs_reauth"


def settings(db: Session) -> dict:
    st = state(db)
    return {
        "auto": st.get("auto", True),
        "interval_h": st.get("interval_h", app_settings().garmin_pull_hours),
    }


def backing_off(db: Session) -> datetime | None:
    t = _parse(state(db).get("backoff_until"))
    return t if t and t > utcnow() else None


def _parse(value) -> datetime | None:
    try:
        return datetime.fromisoformat(value) if value else None
    except (TypeError, ValueError):
        return None


def failure_delay(db: Session, failures: int) -> timedelta:
    """How long to wait after `failures` consecutive failed pulls: 5 min, 10, 20 …, capped at
    the athlete's sync interval so a broken sign-in is retried at the normal cadence rather
    than never."""
    exponent = max(1, min(failures, FAILURE_EXPONENT_MAX)) - 1
    cap = timedelta(hours=settings(db)["interval_h"])
    return min(FAILURE_BACKOFF * (2**exponent), cap)


def _failure_message(error: Exception | str) -> str:
    if isinstance(error, str):
        return error.strip()[:300] or "Garmin sync failed."
    text = str(error).strip() or "failed"
    return f"{type(error).__name__}: {text}"[:300]


def record_failure(db: Session, error: Exception | str) -> None:
    """Account for a failed pull (worker or an unexpected exception). `backoff_until` stays the
    Garmin rate-limit pause only; the growing delay lives in `failure_count`/`last_attempt`."""
    count = int(state(db).get("failure_count") or 0) + 1
    set_state(
        db,
        failure_count=count,
        last_attempt=utcnow().isoformat(),
        last_error=_failure_message(error),
    )


def next_pull(db: Session) -> datetime | None:
    if not connected(db) or not settings(db)["auto"]:
        return None
    st = state(db)
    last = _parse(st.get("last_pull"))
    nxt = last + timedelta(hours=settings(db)["interval_h"]) if last else utcnow()
    nxt = max(nxt, backing_off(db) or nxt)
    failures = int(st.get("failure_count") or 0)
    attempted = _parse(st.get("last_attempt"))
    if failures > 0 and attempted is not None:
        nxt = max(nxt, attempted + failure_delay(db, failures))
    return nxt


def due(db: Session) -> bool:
    nxt = next_pull(db)
    return nxt is not None and nxt <= utcnow()


def connect(email: str, password: str, mfa: tuple | None = None, code: str | None = None):
    """Sign in once with the athlete's Garmin credentials and keep only the tokens. Returns
    ("needs_mfa", state) when Garmin asks for a code; call again with that state and the code.
    The password lives in this call's memory only; it is never logged or written. Raises
    tokens.KeyMissing before contacting Garmin when the tokens couldn't be stored."""
    from garminconnect import Garmin

    if not tokens.available():
        raise tokens.KeyMissing()
    if mfa is not None:
        g, client_state = mfa
        g.resume_login(client_state, code)
    else:
        g = Garmin(email, password, return_on_mfa=True)
        status, client_state = g.login()
        if status == "needs_mfa":
            return "needs_mfa", (g, client_state)
    tokens.save(g.client.dumps())
    return "ok", None


def disconnect(db: Session) -> None:
    """Forget the tokens (synced data stays)."""
    tokens.delete()
    set_state(db, auth=None, last_error=None, backoff_until=None, failure_count=0)


def _client():
    """Signed in from the stored tokens only (never a password). They go in as a JSON string,
    not a path, so garminconnect keeps no file to rewrite in plaintext on refresh."""
    from garminconnect import Garmin

    raw = tokens.load()  # KeyMissing without a key
    if raw is None:
        raise FileNotFoundError("no Garmin tokens")
    g = Garmin()
    g.login(tokenstore=raw)  # raises if they are invalid
    return g


def _keep_json(db: Session, payload: dict, label: str, import_id: str) -> None:
    store.keep_raw(
        db,
        json.dumps(payload, default=str, sort_keys=True).encode(),
        kind="json",
        filename=f"{label}.json",
        import_id=import_id,
    )


EXTRAS = (
    ("max_metrics", "get_max_metrics"),
    ("readiness", "get_training_readiness"),
    ("respiration", "get_respiration_data"),
    ("spo2", "get_spo2_data"),
)


def pull(
    db: Session,
    import_id: str,
    *,
    start: date | None = None,
    end: date | None = None,
    cancelled=lambda: False,
    progress=lambda a, b: None,
    raise_on_limit: bool = False,
) -> Report:
    """Fetch [start, end] (default: the last 3 days). With raise_on_limit a 429 raises
    RateLimited so a backfill can pause and resume later instead of failing."""
    from garminconnect import (
        GarminConnectAuthenticationError,
        GarminConnectConnectionError,
        GarminConnectTooManyRequestsError,
    )

    report = Report()
    end = end or clock.today()
    start = start or end - timedelta(days=2)  # late watch syncs change recent days
    try:
        g = _client()
    except tokens.KeyMissing:
        set_state(db, last_error=tokens.KEY_HELP, last_attempt=utcnow().isoformat())
        report.files["failed"] += 1
        report.errors.append(tokens.KEY_HELP)
        return report
    except (GarminConnectAuthenticationError, FileNotFoundError, ValueError):
        set_state(
            db,
            auth="needs_reauth",
            last_error="The saved Garmin sign-in stopped working.",
            last_attempt=utcnow().isoformat(),
        )
        report.files["failed"] += 1
        report.errors.append(REAUTH)
        return report
    except PermissionError:
        # An unreadable token file is an operator problem, not a Garmin one: never retry it in
        # a loop and never put the path in the athlete's UI.
        set_state(db, last_error=tokens.UNREADABLE_HELP, last_attempt=utcnow().isoformat())
        report.files["failed"] += 1
        report.errors.append(tokens.UNREADABLE_HELP)
        return report
    days = [(start + timedelta(days=i)) for i in range((end - start).days + 1)]
    try:
        for i, d in enumerate(days):
            if cancelled():
                break
            ds = d.isoformat()
            payload = {}
            calls = [("stats", g.get_stats), ("sleep", g.get_sleep_data), ("hrv", g.get_hrv_data)]
            calls += [(k, getattr(g, fn)) for k, fn in EXTRAS if hasattr(g, fn)]
            for key, call in calls:
                try:
                    payload[key] = call(ds)
                except GarminConnectConnectionError as e:
                    report.errors.append(f"{ds} {key}: {str(e)[:120]}")
                time.sleep(app_settings().garmin_pause_s)
            _keep_json(db, payload, f"pull-{ds}", import_id)
            if payload.get("stats"):
                got = parse.daily_from_summary({**payload["stats"], "calendarDate": ds})
                if got:
                    for m, v in got[1].items():
                        report.count(
                            m, store.upsert_metric(db, got[0], m, v, "garmin", import_id), got[0]
                        )
            if payload.get("sleep"):
                night = parse.sleep_from(payload["sleep"])
                if night:
                    report.count(
                        "sleep", store.upsert_sleep(db, night, "garmin", import_id), night["day"]
                    )
            if payload.get("hrv"):
                got = parse.hrv_from(payload["hrv"])
                if got:
                    for m, v in got[1].items():
                        report.count(
                            m, store.upsert_metric(db, got[0], m, v, "garmin", import_id), got[0]
                        )
            for m, v in parse.extras_from(ds, **{k: payload.get(k) for k, _ in EXTRAS}).items():
                report.count(m, store.upsert_metric(db, d, m, v, "garmin", import_id), d)
            report.files["parsed"] += 1
            db.commit()
            progress(i + 1, len(days) + 1)
        try:
            comp = g.get_body_composition(start.isoformat(), end.isoformat()) or {}
            for w in comp.get("dateWeightList") or []:
                got = parse.weight_from(w)
                if got:
                    for m, v in got[1].items():
                        report.count(
                            m, store.upsert_metric(db, got[0], m, v, "garmin", import_id), got[0]
                        )
        except GarminConnectConnectionError as e:
            report.errors.append(f"weight: {str(e)[:120]}")
        acts = g.get_activities_by_date(start.isoformat(), end.isoformat()) or []
        _keep_json(db, {"activities": acts}, f"pull-activities-{start}-{end}", import_id)
        for a in acts:
            if cancelled():
                break
            rec = parse.activity_from_summary(a)
            if not rec:
                continue
            existing = db.get(Activity, rec["id"])
            report.count("activities", store.upsert_activity(db, rec, import_id), rec["local_date"])
            db.commit()
            if existing is None or not existing.stream_path:
                time.sleep(app_settings().garmin_pause_s)
                try:
                    blob = g.download_activity(
                        str(a["activityId"]), dl_fmt=g.ActivityDownloadFormat.ORIGINAL
                    )
                    with zipfile.ZipFile(io.BytesIO(blob)) as z:
                        for name in z.namelist():
                            if name.lower().endswith(".fit"):
                                import_fit(
                                    db,
                                    z.read(name),
                                    filename=f"{a['activityId']}.fit",
                                    source="garmin",
                                    import_id=import_id,
                                    report=report,
                                )
                    db.commit()
                except Exception as e:  # keep the summary even if the file fails
                    db.rollback()
                    report.errors.append(f"activity {a.get('activityId')} file: {str(e)[:120]}")
    except GarminConnectTooManyRequestsError:
        db.commit()  # keep what this chunk already stored
        set_state(
            db,
            backoff_until=(utcnow() + BACKOFF).isoformat(),
            last_error="Garmin asked the app to slow down (rate limit); syncing resumes after a pause.",
        )
        if raise_on_limit:
            raise RateLimited()
        report.errors.append("Garmin rate-limited the sync; backing off for 6 hours.")
        report.files["failed"] += 1
        return report
    except GarminConnectAuthenticationError:
        set_state(db, auth="needs_reauth", last_error="Garmin rejected the saved sign-in.")
        report.errors.append(REAUTH)
        report.files["failed"] += 1
        return report
    try:  # tokens may have been refreshed; keep the new ones (encrypted)
        tokens.save(g.client.dumps())
    except Exception:
        pass
    set_state(
        db,
        auth="ok",
        last_pull=utcnow().isoformat(),
        last_error=None,
        backoff_until=None,
        failure_count=0,
    )
    progress(1, 1)
    return report
