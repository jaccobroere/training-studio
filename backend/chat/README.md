# The assistant (backend)

One Pydantic AI agent on Ollama Cloud (`deepseek-v4.1-flash:1017` by default; `OLLAMA_MODEL` or
`SPORTS_MODEL`, reasoning effort `OLLAMA_REASONING_EFFORT`, default `low`; all settings in
`core/settings.py`). The frontend's `useChat` talks the Vercel AI UI-message protocol v7
through `VercelAIAdapter`; history is stored server-side as Pydantic AI `ModelMessage`s on the
`conversation` row.

**Model layer.** `llm.py` is the only place that names a provider: `build_model()` wraps the
model in `LoggedModel`, which writes one `llm.call` log line per model request (streamed or
not): `operation`, `model`, `outcome` (`ok` / `truncated` / `aborted` when the client went away / `error`), `error_type`,
`latency_ms`, `finish_reason`, `input_tokens`, `output_tokens` and `prompt_version` (a hash of
`prompts/*.md`). Never prompt text, tool data or replies. The policy is
`prompts/system.md`, sent exactly as written (`{guide}` becomes the coaching-guide index).
A failed turn logs `chat.turn_failed` with `error_type`, `kind`, `status_code` and the stack with every exception
message removed (`llm.scrubbed_traceback`): a provider's error text can hold its response body, so it is never
logged, and the athlete sees one plain sentence (`plain_error`).

| File | What it does |
|---|---|
| `agent.py` | The agent: the policy (`prompts/system.md`) + coaching-guide index, per-turn context (date table, scope, Profile or "empty → interview", replay of earlier proposals/changes) |
| `llm.py` | `build_model`, `LoggedModel` (one `llm.call` line per request), `PROMPT_VERSION`, `configured()` |
| `prompts/system.md` | The policy, sent as written |
| `tools.py` | Plan tools (reads, `change`, `propose`, `undo_change`, `read_guide`) and the tool-step metadata |
| `health_tools.py` | `get_daily_metrics` |
| `research_tools.py` | `web_search`, `web_fetch` (untrusted fence) |
| `analysis_tools.py` | `run_analysis` (pyrunner, chart spec v2: `analysis/CHARTS.md`), `pin_analysis`, `list_pinned`, `update_pinned`, `unpin_analysis`; ≤3 sandbox runs per turn |
| `proposals.py` | Server-stored proposals: dry run, preview, apply / discard / stale / undone |
| `claims.py` | Strips claims ("I've moved…", "Moved…", "Done —") of a write kind that didn't land: plan / pin / proposal tracked separately (stream and stored history) |
| `trim.py` | History processor: last `ASSISTANT_KEEP_TURNS` (4) turns verbatim, older tool results and attachment text stubbed, older long call arguments shortened with the same keys (never an invented key), total character budget |
| `errors.py` | `FriendlyToolErrors`: failed tool-argument validation becomes a short retry message (what is missing / unknown / has no `op`) instead of pydantic's JSON dump; the model retries (3 per tool) and the card shows plain copy |
| `attachments.py` | Chat attachments upload and multimodal user content |
| `limits.py` | Per-minute window and global concurrency cap (plus the weekly quota) |
| `api.py` | `/api/chat` endpoints |

## Tools

Reads: `get_calendar(start, end, tag?)` (weeks → days with weekday, workouts with items, ids and
versions, unplanned activities, per-week planned vs actual totals by type), `get_workout`,
`list_series`, `list_exercises(query?)`, `list_saved_workouts`, `get_activities(start, end, type?)`,
`get_daily_metrics(start, end, fields)`, `get_inbox`, `get_profile`, `get_history`,
`read_guide(topic)`, `web_search`, `web_fetch`, `run_analysis` (datasets `daily`, `sleep`,
`activities`, `laps`, `streams`, `workouts`, `workout_items`, ranges absolute or relative like
`-90d`; the docstring lists every column and the chart helpers so no exploratory runs are
needed; a failed run returns the failing line + a hint for one retry; ≤3 runs per turn),
`list_pinned`. Pinned analyses: `pin_analysis(analysis_id)`, `update_pinned(id, title?, code?,
datasets?)` (test-runs new code before saving), `unpin_analysis(id)` — these count as landed
writes for the claim filter. Workouts, series and saved workouts carry an optional `time` ("HH:MM"); the calendar
lists untimed workouts first, then by time. Dates always come with weekdays and totals are computed server-side, so the model
never does date or weekly arithmetic.

Every tool result starts with `label` ("Read the calendar"), `source` ("Your plan", "Garmin
data", "Coaching guide", "Web", "Your profile") and a one-line `summary` ("3 workouts · weeks
40–41") for the tool-step UI.

## change vs propose

Both take ops from `plan/ops.py` (the UI's own schema) plus the chat-only `attach_link
{target: exercise|workout|series|saved, id, url, title}`, which appends a link to the entity's
current media list.

- `change(ops, reason)` applies a small, clearly asked edit live: one `chat` change, one undo,
  returns `change_id`, diff `lines` and `totals_after`. If the request touches more than 10
  workouts (counted per op: a new series or a "following" edit counts once), it is stored as a
  proposal instead (`converted`).
- `propose(ops, summary)` dry-runs and stores a proposal; nothing is written.

Server-side guards for chat: `delete_activity` needs `delete_logged_confirmed=true` (logged work
is never deleted unless the athlete asked; the ops already refuse deleting logged workouts);
image media must reference an uploaded file. Profile edits are `update_profile` ops, by policy
only when asked (and the first-chat interview writes the Profile through a change card).

Forgiving arguments: an op with no `op` is read as `add_workout` (title + type + date / week_monday /
from_saved) or `update_workout` (id + fields), and loose names (`add`, `move`) are normalised
(`infer_op`). An unknown `exercise_id` lists the close ids in the error; `list_exercises(query)` with
no exact match returns `similar` names (and says to ask before adding one when nothing is close). A tool
that still fails after its retries ends the turn with one plain sentence (`tool_retries`).

## Proposal lifecycle

`chat_proposal` row: thread, ops, `expected` versions + before-snapshots of every touched row,
readable `lines`, `counts` (added / moved / changed / removed / weeks), `weeks`, `dates`, and a
`preview` of added / removed / changed workouts as chips (date, weekday, mark, title, items).

`open` → `applied` (Apply: stored ops + expected versions, one change, op_id `proposal:<id>`) ·
`discarded` · `replaced` (a newer proposal on the thread) · `stale` (a touched row changed; found
on read or on Apply → 409). An applied proposal whose change was undone reads as `undone`.
Before the dry run, series are topped up through the proposal's dates so the calendar preview
can't make it stale.

Context replay: each turn, earlier `propose`/`change` tool results in the history get a
`status_now` line, and the instructions list the thread's proposals and changes with their
status now, so "apply it" / "why didn't you…" questions are answered from facts.

## Claims

Three kinds of write are tracked per turn: `plan` (a `change` / `undo_change` applied), `pin`
(`pin_analysis`, `update_pinned`, `unpin_analysis`) and `proposal` (a stored proposal, from
`propose` or a converted `change`). A sentence that claims a kind that did not land ("I've
moved…", "Moved your long run…", "Done —", "I've set up a draft") is dropped and a plain notice
for that kind is added ("Nothing has been changed in your plan yet."). A pin never excuses a plan
claim and a proposal never does either. Analysis output ("I created a chart…") is not a write.
Offers, questions and conditionals are never claims; modals and "if you" count only inside the
clause that holds the verb. Streaming passes text sentence by sentence; a claim (and what follows
it in that text part) is held until the part ends, then released if its kind has landed. The
stored history gets the same treatment, each reply judged with what had landed before it (`landed_kinds`
over the earlier tool results), so stored and streamed text match. A plan claim dropped next to a proposal
("I planned your Monday skate lesson…" in a drafted block) leaves no "nothing has been changed" notice: the proposal card says it.

## Bounded context

Stored history is complete; what the model sees (`chat/trim.py`, a `ProcessHistory` capability)
is the last `ASSISTANT_KEEP_TURNS` (4) turns verbatim, older tool results reduced to label /
source / summary / ids / status, older attachment text replaced by a stub, and whole oldest
turns dropped beyond `ASSISTANT_HISTORY_CHARS` (120 000).

## Step narration

Short text the model writes right before a tool call in the same response ("I'll read the guide
first.") is held back while streaming and dropped once the tool call arrives, and dropped from
the stored history too (`chat/api.py`, ≤ 40 words and no question). Each text part stays its own
part in the stream; the eval harness joins parts with a blank line.

## Attachments

`POST /api/chat/attachments` (multipart `file`, optional `thread_id`) → media/store.py: magic-byte
sniffing (PNG, JPEG, WebP, HEIC, PDF), ≤ 20 MB, images re-encoded ≤ 2000 px without metadata, PDF
text extracted (30 pages, 20 000 characters), scans rendered to ≤ 3 page PNGs; stored in
`users/<id>/media/` with a `media_file` row (sha256). The chat request carries `attachments:
[ids]` (≤ 4). Decoding runs in a worker process (`media/worker.py`: 2 GB address-space limit, 30 s timeout, 40 MP image cap, scan pages rendered to ≤ 1600 px, page side ≤ 5000 pt, ≤ 500 pages) off the event loop; extracted text is escaped so it cannot close the `<untrusted_attachment>` fence. The user turn becomes `[text, files block with fenced untrusted text, BinaryContent
images…]`. `SPORTS_MODEL_IMAGES=false` sends no image parts. Stored history replaces each image by
a note. Entity images use the same pipeline via `POST /api/media` (media/api.py).

## Limits

Weekly turn quota (`ASSISTANT_WEEKLY_TURNS`, per-user override; a turn counts once the model call has started, even if the client aborts), per-user per-minute window
(`ASSISTANT_PER_MINUTE`, 6), global turns in flight (`ASSISTANT_CONCURRENCY`, 4), one turn per user
at a time, ≤ `ASSISTANT_MAX_STEPS` (16) model requests per turn; uploads 30/min per user. All
refusals are 429 with `Retry-After` (409 `turn_in_progress` for the per-user lock). The turn's DB
reads happen in one short session that is closed before the model is called.

## Evals

`evals/cases.json` (22 cases: series, gym with exercises, move / skip, deload, 10K / half /
marathon blocks → must propose, demo links, profile interview and write, analysis, guide
citation, never deleting logged work, facts, ambiguity) and `evals/run.py`, which drives the
real `POST /api/chat` on a fresh backend per model with a fresh seeded account per case:

    OLLAMA_API_KEY=… uv run python -m evals.run --model deepseek-v4.1-flash:1017
    uv run python -m evals.run --rescore

Results are written locally to `evals/results.json` and `evals/report.md` (generated, not committed). A 401 or provider usage limit stops the
run early and keeps what was collected.
