# Development

Training Studio is a training and health app. A few fast, fully editable primitives
(exercises, workouts, repeating series, saved workouts, activities, one Markdown Profile)
plus an embedded assistant that does the complex planning by writing ordinary workouts
through the same primitives. A Garmin analysis workspace (Health) with pinned, live
analyses. Multi-user: every account has its own, completely separate data space
(decision 19).

Read first: [`PRODUCT.md`](PRODUCT.md) (who/why), [`SIMPLIFY.md`](SIMPLIFY.md) (the current
model; authoritative), [`DECISIONS.md`](DECISIONS.md) (locked choices, 32 is the redesign),
[`DESIGN.md`](DESIGN.md) (visual system), [`API.md`](API.md) (backend contract) and
[`design/SCREENS.md`](design/SCREENS.md) (screens). [`PLAN.md`](PLAN.md) is the architecture
overview. Running it on a server: [`self-hosting.md`](self-hosting.md).

## What is in the app

- **Plan**: Week (days as rows, an undated tray, one-tap Done, log sheet) and Weeks (multi-week
  planner, drag and multi-select, tag view). Workouts hold ordered items (exercise, sets,
  reps, load, duration, distance, intensity); series repeat weekly.
- **Library**: exercises (with media links and images) and saved workouts.
- **Inbox**: unlinked recordings and past workouts nobody logged.
- **Activities**: every recording with a list (sport, period, search) beside the chosen activity's
  full view: summary, trace with a measurable window, laps (400 m by default for skating), stints,
  splits, bests, route. Shareable URLs (`/activities/<id>?tab=laps&win=120-380`).
- **Health**: a fixed overview (sleep, HRV, resting HR, load, energy, an efficiency trend) and
  **Pinned** analyses that re-run on current data when opened.
- **Profile** (Settings → Profile): one versioned Markdown document about the athlete; new accounts
  get a template.
- **Assistant** (a dock on every page): reads the calendar, Garmin data, Profile and a coaching
  knowledge base; small asked edits apply live with Undo, large or speculative ones become a
  proposal with a calendar preview; runs analyses in a sandbox; accepts image and PDF
  attachments.
- **Settings**: one destination with four tabs: Profile · Connections (Garmin sync, schedule,
  backfill) · Data (uploads, imports, coverage, export) · Account (password, devices, assistant,
  feedback, delete).

## Layout

```
backend/            FastAPI + SQLite, one package per domain
  db.py             tenancy: auth.db + one app.db per user, ordered migrations (user_version)
  accounts/         sign-in, sessions, limits, the operator CLI (accounts.admin)
  plan/             primitives and ops. changes.py: apply_change(), the ONLY way plan data is
                    written (UI, assistant, import, undo). ops.py, series.py, link.py (auto-link
                    after sync), starter.py (starter exercises), clock.py (FAKE_TODAY)
  library/          exercise and saved-workout reads (writes are ops)
  profiles/         the versioned Profile
  media/            uploads: magic bytes, re-encode, PDF text/render; users/<id>/media/
  garmin/           sync, archive/FIT import, parsers
  health/           metrics and health queries
  chat/             assistant: agent, tools, proposals, attachments, limits (see chat/README.md)
  analysis/         datasets, chart spec v2, pinned analyses (see analysis/CHARTS.md)
  pyrunner/         the sandboxed analysis runner (separate container)
  export/           personal archive and restore
  feedback/         feedback capture + outbox to an optional webhook (Settings → Account → Feedback)
  jobs/             in-process job thread over import_run; also flushes the feedback outbox
  evals/            assistant evaluation harness (cases.json, run.py)
  tests/            pytest
frontend/           Vite + React 19, plain CSS tokens (src/ui/tokens.css), TanStack Query
  src/plan, library, inbox, profile, settings, health, activities, chat, log, editor, charts, ui
training/guide/     coaching knowledge base the assistant reads (hidden from users)
docs/               product, design and operator documentation
docs/design/        SCREENS.md and the approved Instrument Panel mockup (demo data only)
scripts/            check.sh (extra checks), smoke.sh, backup.sh, agent_preview.sh, dev_session.py
compose.yml         app, pyrunner, static, caddy (see docs/self-hosting.md)
Caddyfile           the bundled front door
```

## Local development

```bash
# backend (port 8710 avoids clashing with other dev servers)
cd backend
DATA_DIR=/tmp/sports-dev uv run uvicorn main:app --port 8710 --reload

# frontend
cd frontend && pnpm install
SPORTS_API=http://127.0.0.1:8710 SPORTS_WEB_PORT=5710 pnpm exec vite
```

There is no sign-up screen: create the first account with the operator CLI against the same
data directory:
`cd backend && DATA_DIR=/tmp/sports-dev uv run python -m accounts.admin create <username>`.
A new account gets the starter exercise list and the empty Profile template; nothing else is
seeded.

For browser testing, sign in once, then mint session cookies instead of re-posting `/login`
(its per-name rate limit is a real control and stays on):
`cd backend && DATA_DIR=/tmp/sports-dev uv run python ../scripts/dev_session.py <username>` prints
`sts_session=<value>` to add as a cookie on `http://localhost`. It needs an explicit `DATA_DIR`
and refuses the production path.

To look at real screens without real data (agents, screenshots, quick QA):
`scripts/agent_preview.sh start` starts the backend and Vite on a throwaway data dir
(`/tmp/sports-preview`), signs in a `preview` account past the first-login screens, imports
six weeks of synthetic demo activities and health data, and prints `READY <url> cookie: …`.
`scripts/agent_preview.sh stop` stops both; delete the folder to start clean.

Environment (all optional locally; deployment values in `.env.example` and
[`self-hosting.md`](self-hosting.md)). Every variable is declared once, typed, in
`backend/core/settings.py`; an empty value counts as unset and a bad value stops startup with
one error naming the variable (never its value):

| Variable | Purpose |
|---|---|
| `DATA_DIR` | data root (`auth.db`, `users/<id>/…`); default `data` |
| `FAKE_TODAY=YYYY-MM-DD` | pins "today" for demos and tests |
| `OLLAMA_API_KEY` | Ollama Cloud key (assistant, web search/fetch); without it the assistant reports unavailable |
| `SPORTS_MODEL` / `OLLAMA_MODEL` | model name, default `deepseek-v4.1-flash:1017` (`SPORTS_MODEL` wins) |
| `OLLAMA_REASONING_EFFORT` | `low` (default), `medium`, `high` |
| `OLLAMA_BASE_URL`, `OLLAMA_WEB_API` | API endpoints (defaults point at ollama.com) |
| `SPORTS_MODEL_IMAGES` | `false` hides image attachments for text-only models |
| `ASSISTANT_WEEKLY_TURNS`, `ASSISTANT_PER_MINUTE`, `ASSISTANT_CONCURRENCY`, `ASSISTANT_MAX_STEPS` | assistant limits |
| `SPORTS_ANALYSIS_RUNS_PER_TURN` | sandbox runs per assistant turn (default 3) |
| `ASSISTANT_KEEP_TURNS`, `ASSISTANT_HISTORY_CHARS` | what the model sees of a thread (default 4 turns, 120 000 characters) |
| `PYRUNNER_URL` | analysis runner; unset = a local limited subprocess in dev and tests. With `APP_ENV=production` (compose) the app refuses to start without it, or with `FAKE_TODAY` set |
| `APP_ENV`, `APP_VERSION` | `dev` (default), `test`, `production`; stamped on every log line |
| `LOG_LEVEL`, `LOG_FORMAT` | `INFO`; `json` or `text` (default: text in dev, JSON otherwise) |
| `JOBS_ENABLED` | `false` stops the background job loop |
| `GARMIN_PULL_HOURS`, `GARMIN_PAUSE_S`, `MEDIA_WORKER_MEM_MB` | sync interval default, pause between Garmin calls, media worker memory |
| `GARMIN_TOKEN_KEY_FILE` | Fernet key file for Garmin tokens; unset = Garmin connect/sync off |
| `PUBLIC_URL` | address shown in invite messages; default `http://localhost:8080` |
| `FEEDBACK_WEBHOOK_URL`, `FEEDBACK_WEBHOOK_SECRET` | optional feedback forwarding; unset = stored locally only |
| `ALERT_WEBHOOK_URL`, `ALERT_WEBHOOK_TOKEN` | optional runaway alerts; unset = log only |
| `ATHLETE_TZ` | default `Europe/Amsterdam` |

## Tests

```bash
cd backend && uv run pytest -q
cd frontend && pnpm lint && pnpm type && pnpm test
bash scripts/check.sh        # extra checks
```

`scripts/check.sh` runs the extra checks: the assistant eval harness rescored offline (only
when a local `backend/evals/results.json` exists; no API calls), a check that every coaching
guide file in `training/guide/` is listed in its README, and the frontend unit tests.

**Assistant evals** drive the real `POST /api/chat` on a fresh backend with a fresh seeded
account per case and score tool calls, ops, landed writes and the answer text. They call the
live model, so they are not part of CI:

```bash
cd backend
OLLAMA_API_KEY=… uv run python -m evals.run --model deepseek-v4.1-flash:1017
uv run python -m evals.run --rescore      # score saved answers again, no API calls
```

Results are written locally to `backend/evals/results.json` and `report.md`; they are
generated output and not committed. Options: `--only id,id`, `--runs N`, repeatable
`--model`. A provider 401 or usage limit stops the run and keeps what was collected.

## Runtime and security

- **Logs and errors**: one JSON object per line on stdout with `request_id` and `user_id`;
  one `http.request` line per request with the route template, never the raw path (paths
  carry dates and ids of personal records); one `llm.call` line per model request, never
  content. Every error is one envelope, `{code, detail, request_id, ...extra}`
  (`backend/core/errors.py`), and every response echoes `X-Request-ID`.
- The bundled Caddy serves the SPA from the `static` volume and proxies `/api/*` and
  `/health`.
- The app is its own gate (decision 20): invite-only accounts with username + password
  (argon2id), a hashed session token in an HttpOnly cookie (`__Host-` and Secure over
  HTTPS), same-origin checks on writes, and rate-limited sign-in (per IP and per username;
  a wrong password is a 401). There is no public sign-up. The app never trusts
  `Remote-User`.
- Per-user guards: weekly assistant turns plus a global weekly cap, limits on analysis
  reruns, Garmin uploads and archive exports, two sandbox runs at once, and a storage quota
  (4 GB per account; uploads also stop when the host has under 5 GiB free).
- `data` volume: `auth.db` (accounts, sessions, limits, usage) and `users/<id>/` per
  account (`app.db`, raw Garmin files, streams, `media/`, `garmin/tokens.enc`:
  Fernet-encrypted, 0600, with the key outside the volume). `alerts-state.json` at the
  volume root holds only the alert uid/date/byte baselines (no training data). Boot
  snapshots under `backups/` are the app's own copies, so they are excluded from the
  per-account quota; they are taken at most once per 6 hours and kept within a 1 GiB budget
  per database (the newest is always kept).
- The analysis runner is a second container on an internal network (no egress, no secrets).
- Feedback (Settings → Account) is stored in the athlete's own `app.db`, triaged by the
  assistant model (or a rule-based fallback) and, when `FEEDBACK_WEBHOOK_URL` is set,
  forwarded by the job loop with `FEEDBACK_WEBHOOK_SECRET` as the `X-Sports-Token` header.
  No training or health data is attached automatically; the athlete can turn context off.
- Accounts are managed on the server with `python -m accounts.admin` (create, list, usage,
  reset-password, reset-usage, disable, enable, delete, set-limit, restore); there is no
  admin role in the app. See [`self-hosting.md`](self-hosting.md).
