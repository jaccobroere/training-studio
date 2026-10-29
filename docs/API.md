# API.md — backend contract

All routes are under `/api` (except `GET /health`, public), need the session cookie (401
`{"code": "signed_out"}` otherwise), and answer JSON. Dates are ISO `YYYY-MM-DD` in the athlete's
timezone; timestamps are UTC with a trailing `Z`. Errors: one envelope, `{"code", "detail", "request_id",
...extra}`, with 422 (invalid), 404 (not found) or 409 (stale / conflict); every response echoes
`X-Request-ID` (a valid incoming one is reused). Writes from the browser need same-origin
(`Sec-Fetch-Site` / `Origin`).

Sections: **Concepts** · **Plan** (reads, writes, ops, series, auto-link) · **Library** ·
**Profile** · **Inbox** · **Assistant** · **Media** · **Analysis and Pinned** · **Health** ·
**Other routes** · **Removed endpoints**.

## Concepts

- **Type** (fixed): `run ride swim skate strength mobility walk climb other`. Every object with a
  type also carries `mark`: `RUN RID SWM SKT STR MOB WLK CLB OTH`.
- **Workout** = plan side only. **Activity** = actual side only (Garmin, demo or manual). A workout
  is *done* when ≥1 activity links to it. Planned and actual numbers are never mixed.
- **Workout state** (computed): `done` (has an activity) · `skipped` · `not_logged` (dated before
  today, planned, no activity) · `planned`.
- **Planned values** = sum over items of `distance_km` and `duration_min`, each × `sets` (default 1).
- **Versions**: every entity has `version`. Send `expected: {"<kind>:<id>": version}` with a change to
  get 409 `stale` instead of overwriting someone else's edit. Kinds: `workout`, `series`, `saved`,
  `exercise`, `activity`, and `profile:doc` (the Profile; its version is the document version).

### Shapes

```jsonc
// Item (inside workouts, series, saved workouts) — ids are short and stable while editing
{"id": "a1b2c3", "exercise_id": "back-squat", "name": "Back squat",   // name: read-only, resolved
 "sets": 3, "reps": "5", "load": "80 kg", "duration_min": 1, "distance_km": 8,
 "intensity": "Z2", "note": "pause at the bottom"}                     // all but id/exercise_id optional

// Media
{"kind": "link", "url": "https://…", "title": "Demo"}  |  {"kind": "image", "file": "abc123.jpg", "title": ""}

// Activity (compact, as nested in week/workout views)
{"id": "garmin:123" | "manual:9f…", "version": 0, "source": "garmin|demo|manual", "type": "run", "mark": "RUN",
 "name": "Morning run", "date": "2026-09-29", "start_utc": "…Z", "duration_min": 50.0, "distance_km": 8.4,
 "avg_hr": 141, "workout_id": "w-…" | null, "rpe": 6 | null, "notes": "", "skipped_items": ["a1b2c3"],
 "sets": [{"exercise_id": "back-squat", "item_id": "a1b2c3", "reps": 5, "kg": 80}],
 "kept_unplanned": false, "has_stream": true}
// `GET /api/activities/{id}` and the health activity endpoints also carry type_override (the athlete's type | null)
// and device_type (what the device's own type maps to; null for manual). A recording whose Garmin summary is
// untyped keeps the precise sport of its kept FIT; a repair pass on database open re-reads those FITs for rows
// still left as `other`, unless the athlete overrode the type.

// Workout (full)
{"id": "w-…", "version": 3, "date": "2026-09-29" | null, "time": "19:30" | null, "week_monday": "2026-09-28", "position": 0,
 "title": "Easy run", "type": "run", "mark": "RUN", "tags": ["long"], "notes": "", "items": [Item],
 "media": [Media], "status": "planned|skipped", "skip_reason": "", "state": "done|skipped|not_logged|planned",
 "series_id": "s-…" | null, "customised": false,
 "planned": {"distance_km": 8.0 | null, "duration_min": null}, "activities": [Activity]}

// Chip (multi-week grid)
{"id", "version", "date", "time", "type", "mark", "title", "state", "tags", "series_id", "position"}

// Totals: per type present in the range
{"run": {"planned_n": 2, "planned_km": 24.0, "planned_min": 0, "actual_n": 1, "actual_km": 8.4, "actual_min": 50}}
```

`date: null` = "this week, no day yet" (the tray); then `week_monday` says which week.

`time` = optional time of day, `"HH:MM"` (24 h, athlete's timezone), `null` = no time. Workouts,
series (`GET /api/series*`) and saved workouts (`GET /api/saved-workouts`) all carry it.
**Order within a day** (week days, weeks chips, the tray): workouts without a time first, in
`position` order, then timed ones by time (ties by `position`).

## Plan

### Reads

| Route | Returns |
|---|---|
| `GET /api/today` | `{today, monday, now, timezone}` |
| `GET /api/week/{date}` | Week containing `date` (see below). Tops up series first. |
| `GET /api/weeks?from=&to=&tag=` | Multi-week grid, ≤60 weeks (see below). |
| `GET /api/workouts/{id}` | Workout + `series` (series summary or null). |
| `GET /api/tags` | `[{tag, n}]` tags in use, most used first. |
| `GET /api/series` | `[Series]` |
| `GET /api/series/{id}` | Series + `items` with names, `upcoming: [Chip]` (≤20), `n_occurrences`. |
| `GET /api/inbox` | see **Inbox** |
| `GET /api/changes?week=&limit=30` | history, newest first: `[{id, at, source, summary, reason, weeks, undoes_id, undone_by_id, n}]`. Automatic (`system`) changes are never listed. |
| `GET /api/changes/{id}` | ChangeResult + `source, reason, undone_by_id, undoes_id` |
| `GET /api/activities/{id}/link-options` | `{workouts: [chip], saved: [{id, title, type, mark}]}`: planned workouts ±7 days with no recording yet (its type when any, nearest first), saved workouts (its type first). Link to a saved one = `add_workout {id, from_saved, date}` + `link_activity` in one change |
| `GET /api/activities?start=&end=` / `GET /api/activities/{id}` | full activity (also `type`, `rpe`, `notes`, `skipped_items`, `sets`, `workout_id`, laps, stream for detail) and `workout: {id, title, type, date, week_monday, items} | null` |

**Week** `GET /api/week/2026-09-30`:
```jsonc
{"monday", "sunday", "prev", "next", "today", "is_current",
 "days": [{"date", "dow": "Mon", "today": bool,
           "workouts": [Workout],          // linked activities are inside each workout
           "activities": [Activity]}],     // unplanned activities on that day
 "tray": [Workout], "totals": Totals,
 "empty": bool,          // no workouts this week → "Plan this week" link
 "new_account": bool,    // no workouts and no series at all → invitation block
 "last_change": HistoryRow | null}
```

**Weeks** `GET /api/weeks?from=2026-09-28&to=2026-11-30[&tag=long]`:
```jsonc
{"from", "to", "tag", "today",
 "weeks": [{"monday", "current", "tray": [Chip], "totals": Totals,
            "days": [{"date", "workouts": [Chip], "unplanned": [{"id", "type", "mark", "name"}]}]}]}
```
With `tag`, only that tag's workouts are listed, and actual totals count only activities linked to
them (the tag view).

### Writes: `POST /api/changes`

```jsonc
{"ops": [Op, …],                     // 1–500, applied in order, atomically: one change, one undo
 "reason": "",                       // optional, shown in history
 "expected": {"workout:w-1": 3},     // optional version checks → 409 stale
 "op_id": "uuid",                    // optional idempotency key (retries return the same change)
 "dry_run": false}                   // true: validate + diff, write nothing
```
**ChangeResult**: `{change_id | null, applied, summary, diffs: [{key, kind, before, after, fields}],
weeks: ["2026-09-28"], at, kept: [{id, title, date?, note}]}`. `kind`: `created deleted moved status
updated linked unlinked`. `applied: false` + `summary: "No changes"` when nothing changed. `kept`
lists rows deliberately left alone (customised occurrences on a split, logged workouts in a bulk
delete). Validation errors: 422 `invalid_op` with `errors: [{loc, msg}]`, or a specific code below.

**Undo**: `POST /api/changes/{id}/undo {op_id?}` → ChangeResult of the inverse change (itself
undoable). 409 `conflict` if a touched row was edited since; 422 `already_undone`, `not_undoable`
(automatic changes), `nothing_to_undo`.

#### Ops

Content fields (workouts, series, saved workouts): `title` (1–160), `type`, `time` (`"HH:MM"`
24 h, also accepts `"7:30"`; `null`/`""` clears; otherwise 422 `invalid_op`), `tags` (≤20, trimmed,
lower-cased, deduped), `notes`, `items` (≤60; `exercise_id` must exist → `exercise_not_found`),
`media` (≤20). In `fields` patches, send only what changes; `items` replaces the whole list (send
item ids back to keep them).

| Op | Payload | Notes |
|---|---|---|
| `add_workout` | `id?, date? \| week_monday?, position?, from_saved?,` content | needs title + type (from payload or saved workout) → `title_and_type_required`; `placement_required`, `not_monday`, `date_outside_week` |
| `update_workout` | `id, fields: {content…}, scope: "one"\|"following"` | on a series occurrence, `one` sets `customised` for content edits (a `time` change never does: it is a move); `following` splits the series (see Series) |
| `move_workout` | `id, date? \| week_monday?, position?, time?` | never sets `customised`; position defaults to last; `time` omitted = kept, `null` = cleared |
| `delete_workout` | `id, scope: "one"\|"following"\|"all"` | `one`: refused with `logged` if it has an activity. `following`/`all` (series): ends the series and removes only future (today counts), unlogged occurrences |
| `duplicate_workout` | `id` | copy on the same day (or tray), standalone (no series) |
| `copy_workout` | `id, dates: [..], week_mondays: [..]` | standalone copies on each date / in each week's tray |
| `set_workout_status` | `id, status: "planned"\|"skipped", reason?` | skipping a done workout → `logged` |
| `set_tags` | `ids: [..], add?: [..], remove?: [..], set?: [..]` | bulk; sets `customised` on occurrences |
| `shift_workouts` | `ids: [..], days: ±N` | bulk; undated ones move to the week N days later |
| `bulk_delete` | `ids: [..]` | logged workouts are skipped and reported in `kept` |
| `log_workout` | `workout_id, activity_id?, date?, rpe? (1–10), notes?, skipped_items?: [item ids], sets?: [{exercise_id, item_id?, reps?, kg?, secs?}] (≤300, replaces the list), duration_min?, distance_km?` | Done / Log sheet. Annotates the given linked activity, else its manual one, else its first recording; if none, creates an empty manual activity (date = `date` or the workout's date; future → `future`). Never copies plan numbers; duration/distance only for manual activities (`device_value`). Un-skips. `bad_item` for unknown item ids; a set needs reps or secs (`bad_set`), its item must be that exercise (`bad_set`), its exercise must exist (`unknown_exercise`) |
| `log_activity` | `id? ("manual:…"), type, date, title?, rpe?, notes?, duration_min?, distance_km?` | unplanned manual activity |
| `update_activity_annotations` | `id, rpe?, notes?, skipped_items?, sets?, kept_unplanned?, type_override?,` manual only: `title?, type?, date?, duration_min?, distance_km?` | `null` clears rpe/notes/skipped_items. `type_override` (recordings only; a manual activity gets 409 `not_recorded`, use `type`) sets the type the analysis uses (`sport` follows it, a later sync leaves it, and the type repair on database open never touches an overridden row); `null` puts the device's type back. Undoable like any change |
| `delete_activity` | `id` | manual activities only (`device_value` otherwise) — e.g. "un-Done" |
| `link_activity` | `activity_id, workout_id, merge_manual?: true` | re-links if linked elsewhere. Linking a recording to a workout done by hand moves the manual activity's rpe/notes/skipped items onto it and deletes the manual row. Un-skips |
| `unlink_activity` | `activity_id` | the activity stays (as unplanned) |
| `create_series` | `id?, rule: {freq: "weekly", interval: 1–8, weekdays: [0–6]}, start_date? (today), end_date?, from_workout?,` content | `from_workout` copies its content and makes it the first occurrence. Materialises occurrences from max(start, today) |
| `update_series` | `id, fields: {content…, rule?, end_date?}, from_date? (today)` | split at `from_date` (in place if that is the first slot). A rule change rebuilds future planned uncustomised occurrences; only `end_date` = end/extend, no split |
| `end_series` | `id, end_date? (today)` | last day; removes future unlogged occurrences after it |
| `add_exercise` | `id? (slug), name, type ("strength"), default_measure: "reps"\|"time"\|"distance", notes?, media?` | id defaults to a unique slug of the name |
| `update_exercise` | `id, fields: {name?, type?, default_measure?, notes?, media?}` | |
| `archive_exercise` | `id, archived?: true` | archived stays resolvable in old items; `false` restores |
| `merge_exercise` | `id, into` | rewrites every item (all workouts, series, saved) to `into`, deletes `id` |
| `add_saved_workout` | `id?, from_workout?,` content | "Save as template" |
| `update_saved_workout` | `id, fields: {content…}` | |
| `delete_saved_workout` | `id` | |
| `update_profile` | `markdown` | new Profile version (no-op if unchanged) |

### Series semantics

- Occurrences are real workouts (`series_id` set), created through Sunday of the week 12 weeks
  ahead and topped up when weeks are read (reading a later week extends to it, ≤1 year). Never
  before today. Deleting one occurrence sticks; top-ups never duplicate.
- **This and following** (`update_workout scope=following`, `update_series`): the old series ends the
  day before, a new series starts with the new content; future planned, uncustomised, unlogged
  occurrences move to the new series (same ids, new content). Customised ones are kept (listed in
  `kept`); past, logged and skipped ones are never rewritten.
- **Time**: occurrences copy the series' `time`. Changing one occurrence's time is a move (diff
  kind `moved`, not customised). A series time edit (this-and-following / `update_series`)
  carries to the occurrences that still have the old series time; one whose time was changed
  on its own keeps it, like a moved date.
- Top-ups are automatic `system` changes: hidden from history, not undoable. Undoing an older
  change whose rows a top-up has since touched answers 409 `conflict`.

### Auto-link after a Garmin import

After every import/sync, each new recording (never touched by the plan side) with the same date and
type as exactly one planned, not-skipped workout without a recording — and no other new recording
competing for it — is linked in one undoable `import` change (manual "done" activities are merged
into it as in `link_activity`). Everything else waits in the Inbox. The import run's report carries
`autolinked: "<summary>"`.

## Library

| Route | Returns |
|---|---|
| `GET /api/exercises?include_archived=true` | `[{id, version, name, type, mark, default_measure, notes, media, archived, uses}]` (`uses` = workouts + series + saved workouts using it) |
| `GET /api/exercises/{id}/history?limit=20` | `[{activity_id, date, workout_id, title, sets: [{reps?, kg?, secs?}], n, reps, secs, top: {reps, kg} | null, volume_kg, e1rm}]` sessions that logged the exercise, newest first; `e1rm` = Epley for loaded sets of 1–12 reps; `limit` 1–200. 404 `exercise_not_found` |
| `GET /api/exercises/{id}/used-in?limit=5` | `[{id, title, type, mark, date, week_monday}]` workouts using the exercise: the most recent up to today (newest first), then the next upcoming; `limit` 1–50 (default 5). 404 `exercise_not_found` |
| `GET /api/saved-workouts` | `[{id, version, title, type, mark, time, tags, notes, items, media, planned}]` |

Writes are ops on `POST /api/changes`: `add_exercise`, `update_exercise`, `archive_exercise`,
`merge_exercise`, `add_saved_workout`, `update_saved_workout`, `delete_saved_workout`.

## Profile

One Markdown document, versioned.

| Route | Returns |
|---|---|
| `GET /api/profile` | `{current: {version, at, source, reason, markdown} \| null, versions: [{version, at, source, reason}], template?}` (`template` only when there is no Profile yet) |
| `GET /api/profile/versions/{v}` | one version with `markdown` |
| `PUT /api/profile {markdown, base_version?, reason?}` | ChangeResult + `{version, unchanged}`; 409 `stale` if `base_version` isn't current |
| `POST /api/profile/versions/{v}/restore` | same shape (a new version with the old text) |

Both writes are `update_profile` changes, so they show in history and can be undone.

## Inbox

`GET /api/inbox` — window: last 28 days:
```jsonc
{"recordings": [{"activity": Activity, "ambiguous": bool, "candidates": [Chip]}],  // unlinked recordings
                                         // that could belong to a workout (same type, ±1 day)
 "not_logged": [Workout],                // past planned workouts with no activity, newest first
 "count": n, "window": [from, to]}
```
Recordings with no possible workout are simply unplanned and don't appear. "Keep as unplanned" =
`update_activity_annotations {kept_unplanned: true}`.

## Assistant

Proposals are stored on the server and applied by id (`POST /api/chat/apply-proposal` no longer
exists). Details: `backend/chat/README.md`.

| Route | Body → result |
|---|---|
| `GET /api/chat/status` | `{configured, provider, model, usage: {used, limit, resets_at, exhausted}, consent, note, attachments: {images, pdf, max_per_message, max_mb, types}, limits: {per_minute}}` — `note` is the consent text (messages, attachments and the data read go to Ollama Cloud) |
| `GET /api/chat/threads` · `POST /api/chat/threads` · `DELETE /api/chat/threads/{id}` | list, create, delete a thread (deleting discards its open proposal) |
| `GET /api/chat/threads/{id}` | `{id, title, updated_at, turns, scope, messages: [UIMessage], proposals: [{id, status, title, summary}]}`; user messages carry `metadata: {scope, attachments: [{id, filename, media_type, pages, url}]}` |
| `POST /api/chat` | `{id: threadId, messages: [newest user UIMessage], scope, attachments?: [attachmentId…] (≤4)}` → SSE (UI message stream v7). 403 `consent_required`, 409 `turn_in_progress`, 422 `message_required` / `bad_attachment`, 429 `quota_exceeded` / `rate_limited` / `busy` (+ `Retry-After`), 503 `assistant_unavailable` |
| `POST /api/chat/attachments` | multipart `file` (+ optional `thread_id`): PNG, JPEG, WebP, HEIC or PDF ≤ 20 MB → `Media` (below). 422 `unsupported_type` / `unreadable` / `empty_file` / `pdf_encrypted`, 413 `too_large`, 429 `rate_limited` (30 uploads/min) |
| `GET /api/chat/proposals/{id}` | `Proposal` (below); 404 `proposal_not_found` |
| `POST /api/chat/proposals/{id}/apply` | no body → `{proposal: Proposal, change: ChangeResult}` (one change; undo it with `/api/changes/{change_id}/undo`). 409 `stale` (a touched row changed since; status becomes `stale`), 409 `not_open` (`status` given), 422 for a plain op error |
| `POST /api/chat/proposals/{id}/discard` | no body → `Proposal` with `status: "discarded"` (open or stale only; else 409 `not_open`) |

**Tool parts in the stream.** Every tool output starts with `label`, `source` (`Your plan`,
`Garmin data`, `Coaching guide`, `Web`, `Your profile`) and `summary` (one line) for the step
row. `change` outputs: `{ok, saved, change_id, lines, weeks, totals_after, kept}` (a change card
with Undo); if it touched more than 10 workouts it comes back as a proposal (`converted`).
`propose` outputs: `{ok, saved: false, proposal_id, status, title, lines, counts, weeks,
totals_after, replaced: [ids]}` — render a proposal card and fetch `GET /api/chat/proposals/{id}`
for the preview. Errors: `{ok: false, error, detail}`.

`run_analysis` outputs: `{ok, analysis_id, status, rows: {name: n}, ranges: [{name, kind, start, end}],
title, stdout, charts: [{title, kind, x, series: ["HRV (line, 28 pts)"]}], tables (preview),
warnings, duration_s}` — render an analysis card from `GET /api/analyses/{analysis_id}` (full
charts) with a **Pin** button (`POST /api/pinned`). On failure: `{ok: false, analysis_id?, status:
"error"|"timeout"|"failed", error: "KeyError: 'hrv'", line, code_line, hint, runs_left, next}`, or
`error: "bad_dataset" | "analysis_limit"` with `detail`. `pin_analysis` → `{ok, created, pinned_id,
title, datasets}`; `update_pinned` → `{ok, updated, pinned_id, title, version, datasets}`;
`unpin_analysis` → `{ok, removed, pinned_id}`; `list_pinned` (a read step). Their `source` is
`Health`.

```jsonc
// Proposal
{"id": "p-…", "thread_id": "t-…", "status": "open|applied|discarded|replaced|stale|undone",
 "title": "10K block, weeks 43–50", "summary": "24 workouts (24 added) across 8 weeks",
 "counts": {"workouts": 24, "added": 24, "removed": 0, "moved": 0, "changed": 0, "other": 0, "weeks": 8},
 "lines": ["Added Easy run · Mon 19 Oct", …], "weeks": ["2026-10-19", …], "dates": ["2026-10-19", …],
 "range": {"from": "2026-10-19", "to": "2026-12-07"} | null,
 "preview": {"added": [PreviewChip], "removed": [PreviewChip],
             "changed": [{"kind": "moved|updated|status", "fields": [..], "before": PreviewChip, "after": PreviewChip}]},
 "kept": [...], "change_id": "c-…" | null, "created_at": "…Z", "decided_at": "…Z" | null}

// PreviewChip (ghost chips in the Weeks view; ids of added rows are preview-only)
{"id", "date": "2026-10-19" | null, "time": "07:30" | null, "week_monday", "weekday": "Mon" | null, "type", "mark", "title",
 "tags", "series_id", "status", "items": ["Easy run 8 km · easy", …]}
```

## Media

| Route | Body → result |
|---|---|
| `POST /api/media` | multipart `file`: PNG, JPEG, WebP or HEIC ≤ 20 MB → `Media` with `purpose: "entity"`. Put it on an entity as `{kind: "image", file: <Media.file>, title}` in `media` |
| `GET /api/media/{id or file}` | the stored file (session required; another user's id is 404). `GET /api/media/{id}/info` → `Media`; `GET /api/media/{id}/pages/{n}` → rendered page `n` (1-based) of a scanned PDF |

Chat attachments (`POST /api/chat/attachments`, see **Assistant**) use the same pipeline and return the same `Media`.

```jsonc
// Media (images are re-encoded: ≤2000 px, metadata stripped, always .jpg or .png)
{"id": "3f2a…", "file": "3f2a….jpg", "url": "/api/media/3f2a…", "purpose": "entity|chat",
 "media_type": "image/jpeg|image/png|application/pdf", "filename": "knee.jpg", "size": 182311,
 "sha256": "…", "width": 2000, "height": 1500, "pages": 1, "has_text": false,
 "rendered_pages": 0, "created_at": "…Z"}
```

## Analysis and Pinned

Charts are **chart spec v2** — the exact JSON and examples are in `backend/analysis/CHARTS.md`.

| Route | Body → result |
|---|---|
| `GET /api/analyses/{id}` | `Analysis` + `data_changed_since` (bool, or null if no longer buildable) + `pinned_id` (or null); 404 `analysis_not_found` |
| `GET /api/analyses/{id}/table/{n}.csv` · `GET /api/analyses/{id}/data.csv?dataset=0` | CSV downloads (the data on the same ranges, re-exported now) |
| `POST /api/analyses/{id}/rerun` | → a new `Analysis` on today's data (relative ranges move) |
| `GET /api/pinned` | `[Pinned]` in board order |
| `POST /api/pinned` | `{analysis_id, title?}` → `Pinned` + `created` (false = it was already pinned; same row). 404 `analysis_not_found`, 422 `analysis_failed`, 409 `too_many_pinned` (24) |
| `PUT /api/pinned/order` | `{ids: [every pinned id once]}` → `[Pinned]`; 422 `bad_order` |
| `DELETE /api/pinned/{id}` | → `{ok, id}`; 404 `pinned_not_found` |
| `GET /api/pinned/{id}/run?force=false` | `{pinned: Pinned, status: "ok"|"error"|"timeout"|"failed", result: {stdout, error, error_brief, charts: [ChartV2], tables: [{title, columns, rows}], warnings?}, rows, ranges: [{name, kind, start, end}], dataset_hash, duration_s, ran_at, cached}` — re-runs on current data; cached by (code, snapshot hash), so reopening on unchanged data costs no sandbox run |

```jsonc
// Analysis
{"id": "a-…", "question": "…", "title": "HRV", "code": "…", "datasets": [DatasetSpec], "ranges": [...],
 "dataset_hash": "…", "rows": {"d": 28}, "status": "ok|error|timeout|failed",
 "result": {"stdout", "truncated", "error", "error_brief": {message, line, code, hint}|null, "charts": [ChartV2], "tables": [...]},
 "duration_s": 1.2, "runner": "local-subprocess|pyrunner-service", "at": "…Z"}

// Pinned (changed only through the assistant; the UI can remove and reorder)
{"id": "pin-…", "title": "HRV trend", "code": "…", "datasets": [DatasetSpec], "position": 0,
 "created_from": "a-…" | null, "version": 1, "created_at": "…Z", "updated_at": "…Z"}

// DatasetSpec — start/end: "YYYY-MM-DD" | "today" | "yesterday" | "-90d" | "-12w" | "-6m" | "-1y";
// start also "last_90_days" (window ending today, today included). end defaults to "today".
{"name": "d", "kind": "daily|sleep|activities|laps|streams|workouts|workout_items|sets", "start": "-89d", "end": "today",
 "metrics": [], "type": "run" | null, "activity_ids": [], "limit": null, "every_s": null}
```

Pinning turns an absolute range that ended on the day the analysis ran into a relative one
(`-Nd … today`), so the pin keeps showing the latest data; a past window stays fixed. Dataset
columns per kind: `analysis/snapshot.py` `COLUMNS` (also in the `run_analysis` description).

## Health

A fixed overview; no layouts. Every range takes `start`/`end` (`YYYY-MM-DD`) or `days` (a window
ending today; default per route, ≤ 3660). Missing days are `null`, never 0; every series carries
`n`/coverage. All `GET`.

| Route | Result |
|---|---|
| `/api/health/overview?days=28` | `{start, end, tiles: [Tile], load: {week_monday, hours, by_type: {run: h…}, prev4_mean_hours, rule}, recent_activities: [Activity] (5), data_through}` — tiles for `hrv_ms, rhr_bpm, sleep_h, sleep_score, stress_avg, bb_max, steps` |
| `/api/health/metrics` | `[{key, label, unit, meaning, better: "up"|"down"|null, estimate}]` |
| `/api/health/daily/{metric}?days=90` | `{start, end, metric, label, unit, meaning, estimate, points: [[day, v|null]], baseline: [[day, mean|null, sd|null]], baseline_rule, stats: {n, mean, min, max, median, sd}, expected, missing, gaps: [[from, to]], last: {day, value}|null, sources}`; 404 `unknown_metric` |
| `/api/health/sleep?days=28` | `{start, end, nights: [{day, bed, wake, hours, deep, light, rem, awake}], n, expected, median_bed, median_wake, estimate_note}` — `bed`/`wake` are local clock hours of the wake-up day (23:15 → -0.75), stages in seconds |
| `/api/health/load?days=84` | `{start, end, weeks: [{monday, <type>: hours…, srpe, srpe_n}], sports, unit: "h", srpe_rule}` |
| `/api/health/energy?days=84` | `{start, end, weeks: [{monday, <type>: kcal…}], sports (most kcal first), by_sport: [{sport, kcal, hours, n, kcal_per_h}], sessions: [{id, date, sport, name, minutes, kcal}], n, without, rule}` — recordings with a calorie figure only; `without` counts the ones lacking it (never zero-filled) |
| `/api/health/volume?type=run&days=84` | `{start, end, sport, weeks: [{monday, actual_km, planned_km|null, n, long_km}], n_weeks, rule}` (actual and planned never summed); 422 `unknown_type` |
| `/api/health/activities?type=&days=90&limit=200` (or `start=&end=`; limit ≤ 500) | `{start, end, activities: [Activity], n}` newest first |
| `/api/health/activity/{id}?points=1500` / `/api/health/activity?type=` | `{activity: ActivityDetail (stream without lat/lon) | null, stats: ActivityStats | null}`; without an id, the latest run/ride/skate/walk (or `type`) with a stream; 404 `activity_not_found`. `ActivityStats` (`health/activity_stats.py`): `{sport, samples, sampling: {median_s, p95_s, smart}, totals: {distance_m, elapsed_s, moving_s, stopped_s, stops, avg_moving: {speed_kmh, pace_s_km}, avg_elapsed, max_speed_kmh (best 5 s), avg_hr, max_hr, avg_cad, cad_unit, avg_power, max_power, np, vi, work_kj, gain_m, loss_m, min_m, max_m, gap?}, zones: {ref_bpm, zones: [{zone, lo_bpm, hi_bpm, s, pct}], below_s, below_pct} | null, splits: {size_m, splits: [Split]}, laps: [device laps re-measured], lapsets: {sources, blocks: [{n, start_s, time_s, moving_s, distance_m, speed_kmh, pace_s_km, avg_hr, rest_before_s}] ([] without rests ≥ 60 s), rest_s, sets: {d400|d200|d1000|d5000|gate|device|stints:abs|stints:rel: {key, label, laps: [Lap (with block)], compare: "time"|"speed", best_n, cv_pct (≥ 3 steady laps), fade (≥ 4), mean, n_steady, spans_rest, by_block: [{block, n_laps, best_n, best, mean, fade, cv_pct}] (with blocks)}}, gate: {x, y, heading_deg, passes, crossings} | null, stints: {defs: [{key, label, threshold_kmh, rule}], sets: {abs: [Stint], rel: [Stint]}} | null (skate)}, best: {distance: [...], time: [{secs, distance_m, speed_kmh, pace_s_km, power?}], rest_cut, longest_block_s, blocks} (windows and distances are measured inside one block, never across a rest of 60 s or more; durations longer than any block are omitted), decoupling: {available, basis: power|gap|speed, pct, hr_drift_bpm, first, second} | {available: false, why} | null, ef: {value, unit, basis: power|gap|speed} | null (output per heartbeat: the same figure as the Health efficiency chart; null without heart rate or output), turns: {available, straight: {s, pct, speed_kmh}, turn: {s, pct, speed_kmh}, n_turns, loss_kmh} | null (skate with GPS: heading from consecutive fixes smoothed over ~3 s, a sample turning when the heading changes faster than 4 °/s, a turn a contiguous turn ≥ 3 s; needs 5 min of movement and 4 turns; loss_kmh = straight − turn speed, so a negative figure means the turns were faster), steady: {available: true, start_s, end_s, moving_s, distance_m, ef, ef_unit, basis, decoupling_pct, hr_drift_bpm, cv_pct} | {available: false, min_s: 300, cv_pct} | null (the longest maximal block — no stop ≥ 60 s — of at least 5 min whose 3 s-smoothed speed CV is ≤ 10 %; ef by the same efficiency factor, and decoupling measured on that window rather than over the whole session. Without such a block it reports what it needed — `min_s` — and the lowest CV any block at least that long reached (`cv_pct`, null without one); null only on a payload cached before this analysis), speed_hist, route: {points: [[x_m, y_m, t_s]], ll: [[lat, lon]] (1:1 with points), center: [lat, lon], bbox, marks: [{n, x, y, lat, lon}], mark_m, n} | null (the metres feed the local SVG fallback; the degrees place the same kept samples on OpenStreetMap tiles — the browser fetches tile.openstreetmap.org directly, the only third party it contacts, and the trace, marks and cursor still draw when tiles are blocked), heading: {sectors: [{dir, deg, s, pct, speed_kmh}], spread_kmh} | null, notes, rules, hr_ref_rule}`. Stint: `{n, start_s, time_s, distance_m, speed_kmh, pace_s_km, peak_kmh, to_peak_s, hr_start, hr_peak, hr_rise, hr_60, hr_drop_60}` |
| `/api/health/bests?type=skate&days=84` | `{start, end, sport, windows: [{secs, period, all, power_period, power_all}], distances: [{distance_m, period, all}], n_all, n_period, rule}` — each best `{id, date, name, speed_kmh, pace_s_km, time_s?, power?}`; from a per-activity card cached under `derived/`; 422 `unknown_type` |
| `/api/health/efficiency?type=run&days=365` | `{start, end, sport, hr_ref, unit: "m/beat"|"W/bpm", points: [{id, date, name, ef, ef_unit, basis, decoupling_pct, avg_hr, hr_share, speed_kmh, np, moving_min, steady}], monthly: [{month, n, ef, decoupling_pct}], n, n_steady, without, rule}` — steady = mean moving HR 60–82 % of `hr_ref` and ≥ 20 min moving |
| `/api/health/run?activity_id=&points=1200` | `{activity: ActivityDetail | null}` — without an id, the latest run with a stream. `ActivityDetail` = `GET /api/activities/{id}`: activity + `laps`, `stream: {t, hr, speed, dist, alt, cad, pow}` (display-downsampled), `stream_points: {stored, shown}`, `workout` |

```jsonc
// Tile
{"metric": "hrv_ms", "label": "HRV (overnight avg)", "unit": "ms", "estimate": false, "better": "up",
 "latest": {"day": "2026-09-29", "value": 69.0} | null, "baseline": {"mean": 68.4, "sd": 1.1} | null,
 "delta": 0.6 | null, "points": [["2026-09-03", 67.0], …], "stats": {...}, "missing": 1, "expected": 28}
```

## Feedback

| Route | Returns |
|---|---|
| `POST /api/feedback/attachments` | Multipart `file`: one screenshot (PNG, JPEG, WebP, HEIC; ≤ 20 MB) for a note being written. Re-encoded ≤ 2000 px without metadata (media/store.py); returns the media info (`{id, url, …}`). Shares the upload rate limit and storage quota. |
| `POST /api/feedback` | `{id, queued, remaining}`; stores a note in the caller's own database and queues it for the optional feedback webhook. Body: `{kind: "bug"|"idea"|"other", message, path?, viewport?, user_agent?, include_context?, attachments?}`. `message` 3–4000 chars. `attachments`: up to 3 ids from the route above, each usable once, else 422 `unknown_attachment`. Per-account daily cap (default 10) → 429 `feedback_limit`. |
| `GET /api/feedback` | The caller's 10 most recent notes, newest first: `[{id, kind, message, created_at, state, attachments}]`; `state` is `queued`, `sent` or `failed`, `attachments` the screenshot count. |

`queued: false` means the app stored the note but no `FEEDBACK_WEBHOOK_URL` is configured
(feedback is then kept locally only). With a webhook configured, the operator-facing record is
whatever the receiver makes of it, not this table.

Screenshots are forwarded inside the feedback webhook payload (`attachments: [{name, media_type, width,
height, data}]`, base64) and then deleted from the app: a week after the note was sent, a
month after it failed for good, or a day after upload when no note claimed them
(`feedback/outbox.py`).

## Other routes

Not part of the primitives; stable and documented in their code: `GET /health` (public),
`/api/auth/*` (status, login, logout, me, password, sessions, end-others, consent,
onboarded, privacy-seen, delete; no sign-up: the operator creates accounts), `/api/garmin/*`
(status, connect, connect/mfa, disconnect, settings, sync, backfill, delete-data, demo), `/api/imports*` (list, one, cancel; archive/FIT upload),
`/api/activities` (see Plan reads), `/api/export/archive`, `/api/athlete` (GET, PATCH).

## Removed endpoints

`/api/weeks/{monday}` (+ `/history`, `/at`, `/restore`, `/apply-pattern`), `/api/patterns`,
`/api/seasons*`, `/api/phases/*`, `/api/goals*`, `/api/templates*`, `/api/packages*`,
`/api/principles*` (→ `/api/profile`), `/api/garmin/inbox` (→ `/api/inbox`), `/api/garmin/link`
(→ `link_activity` / `unlink_activity` ops), `/api/export/package`, `/api/export/principles`,
`/api/chat/apply-proposal` (→ `/api/chat/proposals/{id}/apply`), `/api/chat/threads/{id}/draft*`,
`/api/health/sections`, `/api/health/layout/*` and the `/api/health/chart?chart=…` dispatcher
(→ the fixed Health routes and Pinned). Health chart `goals` is gone (VO2max stays).
