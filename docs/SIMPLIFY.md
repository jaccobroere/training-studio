# SIMPLIFY.md — primitives first, assistant-driven

Agreed in grilling on 2026-10-11 (decision 32). This file overrides earlier decisions where
they disagree. Kept from before: Garmin sync (12, 16, 24, 26), accounts and tenancy (19, 20,
23, 25, 28), export (18), the visual system (13, `DESIGN.md`), the `apply_change` seam with
undo (4), and the chat runtime (15: Pydantic AI `VercelAIAdapter` ↔ AI SDK `useChat`).

**Rule.** The app gives you a few primitives that are fast and fully editable. Complex
planning (a marathon block, a replan after an injury) is the assistant's job. It writes
ordinary workouts into the calendar through the same primitives. There is no special plan
machinery.

**Quality bar.** Calm and professional. Nothing busy or awkward. Every primitive supports
create / edit / delete / drag / duplicate and works on mobile (≤480 px), tablet (~820 px) and
desktop (≥1280 px), in both light and dark themes, with a full keyboard path.

---

## 1. Entities

| Entity | What it is | Fields |
|---|---|---|
| **Exercise** | A movement or activity in the user's library | `id`, `name`, `type`, `default_measure` (reps / time / distance), `notes` (cues), `media[]`, `archived` |
| **Workout** | **Plan side only.** One planned training | `id`, `date` (null = this week, no day yet → needs `week_monday`), `time?` ("HH:MM"), `position`, `title`, `type`, `tags[]`, `notes`, `items[]`, `media[]`, `status` (`planned` / `skipped`), `skip_reason`, `series_id?`, `customised` (bool), `version` |
| Workout item | One exercise in a workout, in order (stored as JSON on the workout) | `id` (short, stable in the list), `exercise_id`, `sets?` (int), `reps?` (text: "8–10", "5/leg"), `load?` (text: "60 kg", "BW+10"), `duration_min?`, `distance_km?`, `intensity?` (text: "easy", "Z2", "@MP", "RPE 8"), `note?` |
| **Series** | A repeating workout | `id`, `title`, `type`, `time?`, `tags[]`, `notes`, `items[]`, `media[]`, `rule` = `{freq: weekly, interval: 1..8, weekdays: [0..6]}`, `start_date`, `end_date?`, `version` |
| **Saved workout** | A template with no date | `id`, `title`, `type`, `time?`, `tags[]`, `notes`, `items[]`, `media[]` |
| **Activity** | **Actual side only.** What happened: Garmin or manual | existing columns, plus `workout_id?`, `rpe?`, `notes`, `skipped_items[]` (item ids), `sets[]` (performed sets, DECISIONS.md #33), `source` `garmin` / `manual` |
| **Profile** | One Markdown doc about the athlete, versioned | replaces `principle_doc` (same table shape: versions with restore) |
| Media | `{kind: link, url, title}` or `{kind: image, file, title}` | images stored in `users/<id>/media/`, re-encoded (≤2000 px, metadata stripped), included in export |

**Type** is a fixed set that maps to Garmin: `run, ride, swim, skate, strength, mobility,
walk, climb, other` (walk includes hiking). Each type has a three-letter mark (RUN, RID,
SWM, SKT, STR, MOB, WLK, CLB, OTH). Anything finer is a **tag**.

**Planned values** of a workout = the sum of its items (`distance_km`, `duration_min`). There
is no separate planned field.

### Planned vs actual (never blurred)

- A workout never stores actual values. An activity never stores planned values.
- **Done** = the workout has ≥1 linked activity. A workout can have several activities
  (Garmin splits). An activity links to at most one workout.
- **One-tap Done** creates a manual activity linked to the workout, with no numbers copied.
  Annotations (RPE, notes, skipped items) always live on the activity, whatever its source.
- **Skipped** is a plan-side status with an optional reason.
- A past workout with no activity and not skipped is **not logged**. It shows in the Inbox
  and never counts as done.
- **Auto-link after sync:** a recording with the same date and same type as exactly one
  candidate workout (unlinked, or done manually) is linked in one undoable `import` change.
  If the workout was done manually, annotations move to the Garmin activity and the empty
  manual activity is deleted. Ambiguous cases go to the Inbox.
- UI: planned and actual are separate marks on separate lines, everywhere.

### Series semantics

- Occurrences are **real workout rows**, created 12 weeks ahead and topped up when weeks are
  read (idempotent: no duplicates per series + date).
- Editing one occurrence's content (title, items, notes, type, tags) sets `customised`.
  Moving its date or changing its time does not.
- **This and following** splits the series: the old one gets `end_date = day before`, a new
  series starts with the new content, and future *planned, uncustomised, unlogged*
  occurrences are replaced. Customised ones are kept and reported ("2 customised weeks kept").
- Delete: this one / this and following (ends the series) / whole series. Every option
  removes only future, unlogged rows. History stays.
- Past or logged occurrences are never rewritten.

### Removed

Seasons, phases, goals, week targets / meter bank, A/B/C priority, versioned session
templates, week patterns, plan packages + YAML importer + plan file format, plan recipes,
plan drafts on threads (draft card, sha), race onboarding / Start page, `gym_status`,
personal sport codes, `training/personal/`, `training/format/`, `training/library/` YAML
(replaced by a Python/JSON starter exercise list), dashboard layout versioning / sizes /
per-chart options.

## 2. Screens

Navigation: **Plan** (home) · **Health** · **Library** · **Inbox** (count badge; quiet when
empty) · **More** (Profile, Data, sign out). On desktop, a slim left rail; Profile and Data
sit at the bottom of the rail. On mobile, a bottom tab bar. The chat is a dock available
everywhere; its scope follows the page (on the Weeks view: visible range + selection).

- **Plan → Week** (home): days as rows, plus a tray for undated workouts. A workout row shows
  the type mark, title, item chips ("Squat 3×5 · 80 kg", "Run 10 km · easy"), tag chips,
  status, and a one-tap ✓ button. Its activities are listed beneath on their own line with a
  different mark. Unplanned activities sit on their day. Drag a workout between days (and to
  the tray); keyboard "Move to…". Empty future week: a quiet "Plan this week" link that opens
  the chat with a prefilled prompt. New account with no workouts or series: a calm
  invitation block (Add a workout · Set up a repeating workout · Plan with the assistant ·
  Connect Garmin).
- **Plan → Weeks** (multi-week planner): rows are weeks, columns Mon–Sun, compact chips (type
  mark + short title + status glyph). Drag a chip to any day; click with Shift/⌘ or draw a
  box to multi-select → bulk move / shift by N days / delete / tag. Each row ends with a
  planned vs actual total per type. Scrolls back into history and forward. On mobile it
  becomes an agenda list with "Move to…". A tag filter turns it into the **tag view**.
- **Workout editor** (side panel on desktop, sheet on mobile): title, type, date (or "no
  day"), repeat (none / weekly on… / every N weeks, until…), tags, notes, media, items.
  - Items: drag to reorder. Quick-entry field per item ("3x8 60kg", "10k easy", "20 min")
    is parsed into fields, and the parsed result is shown. Fields can also be edited
    directly.
  - Add items with the exercise picker: search plus tick several, or "+ Create 'Nordic
    curl'". On desktop you can also drag from the Library sidebar.
  - Actions: Duplicate, Copy to…, Save as template, Delete. On a series occurrence, the
    edit scope is asked when saving content.
- **Log sheet**: Done / Skipped (+ reason). Items start ticked; untick what you skipped. Counted and held
  items have a row per set (reps or seconds, kg), pre-filled from last time, ✓ per set, saved as you go (#33).
  Optional RPE, duration, distance, notes. **Log activity** adds an unplanned manual
  activity.
- **Library**: Exercises (create / edit / archive / merge, media) · Saved workouts (create /
  edit / delete, drag or "Add to day").
- **Inbox**: unlinked recordings (link to a workout / keep as unplanned) and not-logged past
  workouts (Done / Skipped / open).
- **Health**: a fixed, well-designed overview (sleep, HRV, resting HR, load, activities, run
  detail) + **Pinned**: saved analyses that re-run on current data when opened. Remove and
  reorder by drag. To change one, you ask the assistant.
- **Profile**: one Markdown document. A new account gets five headings (Goals & events ·
  Availability · Current training · Injuries & constraints · Preferences) with grey
  one-line prompts. Version list with restore.
- **Data**: Sync (unchanged), Account (unchanged, plus export). The Plans tab is removed.

## 3. Assistant

Model: `deepseek-v4.1-flash:1017` on Ollama Cloud (env `SPORTS_MODEL`), a single tier.

- **Tools (read):** calendar(range) with weekday-resolved dates and per-week totals,
  workout(id), series list, exercises / saved workouts, activities(range, type), daily
  metrics, Inbox, Profile, `read_guide(topic)`, web search / fetch, `run_analysis`.
- **Writes are change sets** over the same ops as the UI (workout add / update / move /
  delete, series create / split / end, exercise create / update / merge, tags, media links,
  activity link, profile edit).
  - **Small and clearly asked** → applied live, change card in the chat (diff rows + Undo).
  - **Large (>10 workouts) or speculative** → a **proposal** stored on the server (ops +
    before-snapshots + readable lines + status). The card has a summary, **Preview in
    calendar** (Weeks view with ghost chips for adds, strike-through for removals), Apply and
    Discard. Re-proposing replaces the open proposal on that thread. Apply sends only the
    proposal id; the server refuses it as `stale` if any touched row changed since.
  - Proposal status (applied / discarded / undone / stale) is replayed into the model's
    context on later turns.
  - It never deletes logged work or edits the Profile without an explicit ask.
  - Replies must never claim a write that didn't happen (strip such claims server-side if no
    change landed).
- **Profile interview** on a new account's first chat. The assistant writes the Profile
  through a change card.
- **Links:** the assistant searches and attaches demo links to exercises (links only, no
  images).
- **Attachments in chat:** images and PDFs (magic-byte sniffing, images re-encoded, PDF text
  extracted, scanned PDFs rendered to page images). Sent as multimodal parts. The consent
  text says attachments go to Ollama Cloud. Hidden by config if the model can't take images.
- **Knowledge base** (`training/guide/`, hidden from users, read via a tool, index in the
  system prompt). Fewer, denser files: running structure for 5K/10K, half, marathon
  (trade-offs, options to tweak, short-block adjustments), progression and load, intensity
  distribution, long runs, taper, strength (for endurance athletes and general),
  periodisation basics, recovery and beginners and safety, short notes on skating, cycling
  and swimming. Every number is sourced or labelled as a heuristic; nothing duplicated.
- **Analysis (code interpreter, `pyrunner`):** kept and improved.
  - Chart kinds: line, bar, stacked bar, area/band, scatter, histogram; time axes;
    reference lines and annotations; dual units.
  - Datasets: daily metrics, sleep, activities (+ annotations), laps, streams, workouts with
    items.
  - Code errors are fed back for an automatic retry (bounded). Refining in follow-ups works.
  - Results render inline in the chat; **Pin** saves to Health → Pinned (re-runs live).
- Tool steps show a label, the data source and a one-line outcome summary.
- Limits: the weekly turn quota (200 by default, decision 25) plus a per-minute limit and a concurrency cap. Read
  transactions are closed before the model call.

## 4. Data and migration

One hand-written migration per user DB (in `db.py`'s ordered list):
- **Drops:** `planned_session`, `session_template`, `week`, `week_pattern`, `season`,
  `phase`, `goal`, `package_import`, `dashboard_layout`, `plan_change`, `conversation`,
  `analysis`, `principle_doc`.
- **Keeps:** `activity` (+ new nullable columns), `daily_metric`, `sleep_night`,
  `raw_asset`, `import_run`, `setting`, `athlete`, `exercise` (+ new columns), and all files
  on disk.
- `auth.db` is untouched.
- New accounts get the starter exercise list and the empty Profile template.

## 5. Delivery

Branch `feat/sports-simplify`, built in vertical slices, each leaving the app working and the
tests green:
1. Cut + core model + ops + migration + backend tests.
2. Week, workout editor, log sheet, Library (checkpoint: gallery screenshots).
3. Weeks planner, tag view, bulk actions, Inbox, auto-linking.
4. Assistant: tools, proposals with preview, Profile, links, attachments, knowledge base,
   eval harness (stenen-style `evals/cases.json` + `run.py` + report).
5. Analysis + Health Pinned board.
6. Docs (DECISIONS.md decision 32 → this file, README, PRODUCT.md), polish, screenshots.
