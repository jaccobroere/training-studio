"""Sandboxed analysis (pyrunner) and Pinned analyses (Health → Pinned).

A failed run returns a compact, actionable error (the failing line, the exception and a hint
such as the available columns) so the model can fix its code in one retry. Sandbox runs are
capped per turn (run_analysis and update_pinned together), server-side."""

from __future__ import annotations

from pydantic_ai import RunContext

import db
from analysis import pinned as pins
from analysis.runner import AnalysisBusy, brief_error, execute, sandbox, view
from analysis.snapshot import DatasetSpec, build
from chat.tools import GARMIN, ChatDeps, meta
from core.settings import settings

HEALTH = "Health"


def max_runs() -> int:
    return settings().sports_analysis_runs_per_turn


def _take_run(ctx: RunContext[ChatDeps]) -> dict | None:
    with ctx.deps.lock:
        if ctx.deps.analysis_runs >= max_runs():
            return meta(
                "Ran an analysis",
                GARMIN,
                "Run limit reached",
                ok=False,
                error="analysis_limit",
                detail=f"{max_runs()} analysis runs this turn already. Stop here: tell the athlete what you "
                "found (or the last error) and offer to continue in the next message.",
            )
        ctx.deps.analysis_runs += 1
        return None


def _left(ctx: RunContext[ChatDeps]) -> int:
    return max(0, max_runs() - ctx.deps.analysis_runs)


def _chart_summary(c: dict) -> dict:
    return {
        "title": c["title"],
        "kind": c["kind"],
        "x": c["x"]["type"],
        "series": [f"{s['name']} ({s['kind']}, {len(s['data'])} pts)" for s in c["series"]],
    }


def run_analysis(
    ctx: RunContext[ChatDeps],
    question: str,
    code: str,
    datasets: list[DatasetSpec],
    title: str = "",
) -> dict:
    """Run pandas/numpy/scipy code in an isolated sandbox over a read-only snapshot and show
    charts/tables in the chat. Write the final computation directly: the columns are listed
    here, don't explore first. `title` = a short name for the result (used when pinned).

    datasets: [{name, kind, start, end?, metrics?, type?, activity_ids?, limit?, every_s?}] →
    data[name] is a DataFrame. Ranges: "YYYY-MM-DD" or relative to today: "-90d", "-12w", "-6m",
    "-1y", "today" (end defaults to today). Prefer relative ranges for "last N days" questions
    (a pinned result then stays live). Date columns are pandas datetimes. Missing = NaN, never 0.
    kinds and columns:
    - daily: one row per calendar day. day + metrics (empty = all): hrv_ms, hrv_weekly_ms,
      rhr_bpm, sleep_h, sleep_score, stress_avg, bb_max, bb_min, bb_charged, bb_drained, steps,
      weight_kg, body_fat_pct, vo2max, respiration, spo2, readiness, sleep_deep_h,
      sleep_light_h, sleep_rem_h, sleep_awake_h, train_min, train_km (0 = no activity), srpe.
      Sleep belongs to the night ending on `day`; "next morning" = shift(-1).
    - sleep: one row per night: day, bed_local, wake_local, bed_h/wake_h (clock hours; bed
      before midnight is negative, 23:15 → -0.75), asleep_h, deep_h, light_h, rem_h, awake_h, score.
    - activities (type filter optional, e.g. "run"): id, local_date, start_local, type, name,
      source, duration_min, moving_min, distance_km, pace_s_per_km, speed_kmh, avg_hr, max_hr,
      elevation_gain_m, calories, n_laps, has_stream, rpe, srpe, notes, workout_id, planned.
    - laps (range+type or activity_ids): activity_id, local_date, type, lap, start_s,
      elapsed_s, timer_s, distance_m, pace_s_per_km, avg_hr, max_hr.
    - streams (activity_ids, or the latest `limit` (default 3, max 10) activities with a
      stream in range+type; sampled to ≤3600 rows per activity or every_s): activity_id,
      local_date, type, t_s, hr, speed_ms, pace_s_per_km, power, cadence, altitude_m, distance_m.
    - workouts (the plan, incl. undated): id, date, week_monday, time, type, title, tags,
      status (planned / done / skipped / not_logged), series_id, n_items, items (list of
      {exercise, exercise_id, sets, reps, load, duration_min, distance_km, intensity}),
      planned_km, planned_min, activity_ids, actual_km, actual_min, avg_hr, rpe, recorded.
    - workout_items: one row per planned item: workout_id, date, week_monday, type, title,
      status, position, exercise_id, exercise, sets, reps, load, duration_min, distance_km,
      intensity, note.
    - sets (logged strength, actuals): one row per performed set: activity_id, local_date, type,
      workout_id, exercise_id, exercise, item_id, set_no, reps, kg (null = bodyweight), secs,
      volume_kg, e1rm_kg (Epley, 1–12 reps), planned_sets, planned_reps, planned_load (the plan
      it answers, as text). For progress: group by exercise and local_date.

    Output helpers (in scope with data, pd, np):
    - chart(kind, x, y, title=, x_label=, y_label=, unit=, y2_label=, y2_unit=, refs=, notes=,
      labels=, stacked=): kind line | area | bar | stacked_bar | scatter | band. x = values (a
      Series such as d["day"], never a column name); dates give a time axis. y = a Series
      (one series) or {name: Series}; every series has len(x) values (NaN = gap) — dropna the
      FRAME before taking x and y. Combos and options per series: {name: series(values,
      kind="line"|"bar"|"area"|"scatter", axis=2, style="dashed", muted=True, stack="g")};
      a band: series(kind="band", lower=lo, upper=hi). Scatter: numeric x, labels=d["day"]
      for point labels. refs=[{"y": 60, "label": "LT"}, {"y": (50, 70), "label": "Zone 2"},
      {"x": "2026-10-04", "label": "Race"}, {"x": (start, end), "label": "Taper"}];
      notes=[{"x": day, "y": value, "label": "PB"}]. ≤ 8 series, ≤ 5000 points per series.
      Example: chart("line", d["day"], {"HRV": d["hrv_ms"], "7-day avg":
      series(d["hrv_ms"].rolling(7, min_periods=4).mean(), style="dashed")}, title="HRV", unit="ms")
    - hist(values_or_{name: values}, bins=12, title=, x_label=, unit=, refs=): a histogram.
    - table(df, title): ≤ 200 rows. print() short numeric results (n, r, p, means).
    ≤ 6 charts. No network, no files, ~15 s CPU. On an error you get the failing line and a
    hint: fix and retry once. At most 3 runs per turn. Report the range and n behind numbers."""
    if (stop := _take_run(ctx)) is not None:
        return stop
    with db.get_db().session() as s:
        try:
            a = execute(
                s,
                question=question,
                title=title,
                code=code,
                datasets=datasets,
                conversation_id=ctx.deps.conversation_id,
            )
        except ValueError as e:
            return meta(
                "Ran an analysis",
                GARMIN,
                "Bad dataset request",
                ok=False,
                error="bad_dataset",
                detail=str(e),
                runs_left=_left(ctx),
            )
        except AnalysisBusy:
            return meta(
                "Ran an analysis",
                GARMIN,
                "Analysis busy",
                ok=False,
                error="analysis_busy",
                detail="The analysis sandbox is busy; tell the athlete to try again in a minute.",
            )
    v = view(a)
    res = v["result"]
    base = {
        "analysis_id": a.id,
        "status": a.status,
        "rows": a.rows,
        "ranges": a.ranges,
        "dataset_hash": a.dataset_hash[:12],
        "duration_s": a.duration_s,
    }
    if a.status != "ok":
        return meta(
            "Ran an analysis",
            GARMIN,
            f"Analysis {a.status}",
            ok=False,
            **base,
            **brief_error(res, a.rows),
            stdout=res.get("stdout", "")[:1500],
            runs_left=_left(ctx),
            next="Fix the code and call run_analysis again."
            if _left(ctx)
            else "No runs left this turn: explain the problem briefly.",
        )
    rows_n = sum((a.rows or {}).values())
    charts = res.get("charts", [])
    return meta(
        "Ran an analysis",
        GARMIN,
        f"{rows_n} rows · "
        + (f"{len(charts)} chart{'s' if len(charts) != 1 else ''}" if charts else "done"),
        ok=True,
        **base,
        title=v["title"],
        stdout=res.get("stdout", "")[:4000],
        charts=[_chart_summary(c) for c in charts],
        tables=[
            {"title": t["title"], "columns": t["columns"], "rows": t["rows"][:15]}
            for t in res.get("tables", [])
        ],
        warnings=res.get("warnings", []),
        note="The athlete sees the charts and tables in the card (with a Pin button); don't repeat them.",
    )


def pin_analysis(ctx: RunContext[ChatDeps], analysis_id: str, title: str | None = None) -> dict:
    """Pin an analysis that ran ok to Health → Pinned, where it re-runs on current data when
    opened ("pin that", "save this chart"). Ranges that ended today become relative (e.g. the
    last 90 days) so it stays live. Pinning the same analysis twice keeps one pin."""
    with db.get_db().session() as s:
        try:
            p, created = pins.pin(s, analysis_id, title)
        except pins.PinError as e:
            return meta(
                "Pinned an analysis", HEALTH, e.detail, ok=False, error=e.code, detail=e.detail
            )
        ctx.deps.applied.append(f"pin:{p.id}")  # a real write: replies may say it was pinned
        return meta(
            "Pinned an analysis",
            HEALTH,
            f"“{p.title}” on Health → Pinned" if created else "Already pinned",
            ok=True,
            created=created,
            pinned_id=p.id,
            title=p.title,
            datasets=p.datasets,
        )


def list_pinned(ctx: RunContext[ChatDeps]) -> dict:
    """The athlete's pinned analyses (Health → Pinned) in board order, with code and datasets,
    so you can change one with update_pinned."""
    with db.get_db().session() as s:
        rows = pins.ordered(s)
        out = [
            {
                "id": p.id,
                "title": p.title,
                "datasets": p.datasets,
                "code": p.code[:4000],
                "version": p.version,
            }
            for p in rows
        ]
    return meta("Read pinned analyses", HEALTH, f"{len(out)} pinned", pinned=out)


def update_pinned(
    ctx: RunContext[ChatDeps],
    pinned_id: str,
    title: str | None = None,
    code: str | None = None,
    datasets: list[DatasetSpec] | None = None,
) -> dict:
    """Change a pinned analysis when the athlete asks ("make the HRV chart 90 days", "add a
    7-day average"): new title, code and/or datasets (same shapes as run_analysis; use relative
    ranges like start "-90d" so it stays live). Read it first with list_pinned. New code or
    datasets are test-run on current data and saved only if they run without errors (this
    counts as an analysis run)."""
    with db.get_db().session() as s:
        try:
            p = pins.get(s, pinned_id)
        except pins.PinError as e:
            return meta("Updated a pinned analysis", HEALTH, e.detail, ok=False, error=e.code)
        if code is not None or datasets is not None:
            if (stop := _take_run(ctx)) is not None:
                return stop
            try:
                snap = build(
                    s, datasets if datasets is not None else [DatasetSpec(**d) for d in p.datasets]
                )
            except ValueError as e:
                return meta(
                    "Updated a pinned analysis",
                    HEALTH,
                    "Bad dataset request",
                    ok=False,
                    error="bad_dataset",
                    detail=str(e),
                    runs_left=_left(ctx),
                )
            try:
                out, _ = sandbox(code if code is not None else p.code, snap.data)
            except AnalysisBusy:
                return meta(
                    "Updated a pinned analysis",
                    HEALTH,
                    "Analysis busy",
                    ok=False,
                    updated=False,
                    error="analysis_busy",
                    detail="The analysis sandbox is busy; try again in a minute.",
                )
            if out.get("status") != "ok":
                return meta(
                    "Updated a pinned analysis",
                    HEALTH,
                    "Not saved: the new code failed",
                    ok=False,
                    updated=False,
                    status=out.get("status"),
                    **brief_error(out),
                    runs_left=_left(ctx),
                )
            if not (out.get("charts") or out.get("tables") or (out.get("stdout") or "").strip()):
                return meta(
                    "Updated a pinned analysis",
                    HEALTH,
                    "Not saved: no output",
                    ok=False,
                    updated=False,
                    error="no_output",
                    detail="The code produced no chart, table or printed result.",
                )
        p = pins.update(s, p, title=title, code=code, datasets=datasets)
        ctx.deps.applied.append(f"pin:{p.id}")
        return meta(
            "Updated a pinned analysis",
            HEALTH,
            f"“{p.title}” updated",
            ok=True,
            updated=True,
            pinned_id=p.id,
            title=p.title,
            version=p.version,
            datasets=p.datasets,
        )


def unpin_analysis(ctx: RunContext[ChatDeps], pinned_id: str) -> dict:
    """Remove a pinned analysis from Health → Pinned (only when the athlete asks)."""
    with db.get_db().session() as s:
        try:
            p = pins.unpin(s, pinned_id)
        except pins.PinError as e:
            return meta("Unpinned an analysis", HEALTH, e.detail, ok=False, error=e.code)
        ctx.deps.applied.append(f"pin:{pinned_id}")
        return meta(
            "Unpinned an analysis",
            HEALTH,
            f"“{p.title}” removed",
            ok=True,
            removed=True,
            pinned_id=pinned_id,
        )


ANALYSIS_TOOLS = [run_analysis, pin_analysis, list_pinned, update_pinned, unpin_analysis]
