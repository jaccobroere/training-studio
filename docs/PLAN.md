# PLAN.md — Sports Training Studio (architecture overview)

Status (2026-10): the original plan (seasons, phases, packages, recipes, meter bank, Start
page) was **superseded by the primitives-first redesign**: see [`SIMPLIFY.md`](SIMPLIFY.md)
(authoritative) and decision 32 in [`DECISIONS.md`](DECISIONS.md). The original slice plan is
in Git history. This file keeps only what still describes
the system. Grug rules apply: one way to do each thing, boring tech, no layer without a job.

## 1. Shape of the system

```
         Caddy (bundled reverse proxy, TLS)
           │  static SPA from volume      │ /api/*, /health  (flush_interval -1 for SSE)
           ▼                              ▼
     ┌──────────────────────── one app image ──────────────────────────┐
     │  app      FastAPI ── SQLite: auth.db + users/<id>/app.db        │
     │     │                raw Garmin files, streams, media/          │
     │     ├── chat: Pydantic AI → Ollama Cloud (deepseek-v4.1-flash)  │
     │     │         tools = plain Python over the primitives          │
     │     └── HTTP ──► pyrunner  (same image, `python -m pyrunner.server`)
     │                   internal network only, read-only, no env      │
     └─────────────────────────────────────────────────────────────────┘
```

- **One image, two services** (`app`, `pyrunner`) in `compose.yml`. Garmin pulls and imports run
  in a job thread inside `app` over the `import_run` table (decision 16).
- **Auth**: independent, invite-only app accounts (decisions 19–20, 38); the app is its own
  gate. Only Caddy publishes host ports.
- **Persistence**: `auth.db` plus one folder per account in one named volume. Backups are SQLite
  snapshots plus the raw directory incl. `media/` ([`self-hosting.md`](self-hosting.md)).
- **Schema changes**: `create_all` plus ordered hand-written migrations keyed by
  `PRAGMA user_version` (`db.py`). Migration 1 drops the old plan tables, migration 2 resets
  analyses and Health layouts; Garmin data, accounts and files are kept.

## 2. Model (see SIMPLIFY.md §1 for fields)

Exercise, Workout (plan side only, items as JSON), Series (weekly rule, occurrences are real
rows), Saved workout, Activity (actual side only; Garmin or manual), Profile (versioned
Markdown), Media, Analysis and Pinned analysis, chat thread and proposal. Kept from before:
`daily_metric`, `sleep_night`, `raw_asset`, `import_run`, `setting`, `athlete`.

Invariants (tests for each): planned and actual are never merged; one activity counted once;
raw assets immutable; null is not 0; every plan write goes through `apply_change` (one change,
one undo, `expected` versions → 409 `stale`); past and logged rows are never rewritten by
series edits.

## 3. The change seam

`apply_change(ops, reason, source, expected, op_id)` in `backend/plan/changes.py`: validates,
snapshots touched rows before and after, applies atomically, bumps versions, stores one change
row. Undo is an inverse change (itself undoable). UI, assistant (`change`, or `propose` +
Apply by id), Garmin auto-link and Profile edits all use it. Contract: [`API.md`](API.md).

## 4. Assistant

One Pydantic AI agent behind `VercelAIAdapter` ↔ `useChat` (decision 15). Server owns history.
Reads (calendar, workouts, series, exercises, activities, daily metrics, Inbox, Profile,
guide, web), writes as change sets, analysis in `pyrunner`. Details, limits and proposal
lifecycle: [`backend/chat/README.md`](../backend/chat/README.md); charts:
[`backend/analysis/CHARTS.md`](../backend/analysis/CHARTS.md); knowledge base:
`training/guide/`; evaluation: `backend/evals/` ([`development.md`](development.md), "Tests").

## 5. Code interpreter

`run_analysis` builds scoped datasets from the user's own data and posts code plus data to
pyrunner: a fresh subprocess per job with rlimits, wall timeout, empty environment, in a
container with read-only rootfs, `cap_drop: ALL`, no-new-privileges, non-root, resource
limits and an `internal` network. Charts return as chart spec v2, re-validated by the app
before storing. Optional hardening: gVisor (`runtime: runsc`, [`self-hosting.md`](self-hosting.md)).

## 6. Status

The redesign is built on `feat/sports-simplify` in six slices (core model, week and editor,
weeks planner and Inbox, assistant, analysis and Pinned, docs). Backend and frontend tests
pass; a live eval run writes its report to `backend/evals/report.md` locally (not committed).

Needs the operator (not done in Git): the deploy steps in [`self-hosting.md`](self-hosting.md); connecting Garmin and
confirming the parsers against a real account; gVisor is optional and not enabled.
