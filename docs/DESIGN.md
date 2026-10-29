# DESIGN.md — Sports Training Studio

Locked 2026-09-29: **Direction C, "Instrument Panel"**, with light chart screens in the light
theme (owner request). The reference implementation is `design/mockup/c-instrument/`
(open its HTML files directly; demo data in `design/mockup/data.js`). The real frontend
ports those tokens and components into `frontend/src/ui/`. Where the mockup and this file
disagree, this file wins. The mockup predates the primitives-first redesign (its screens
still show seasons, targets and principles); use it for tokens and components only, and
`design/SCREENS.md` for the current screens.

## Theme

**A precision instrument for one athlete.** Dieter Rams/Braun calm × Tektronix measurement ×
Teenage Engineering control surfaces. Cool-grey chassis, raised keys, inset "screens" for
data, silk-screen labels, and **one safety-orange signal** per view. It reads as a tool
you trust, not a fitness app.

Scene: Sunday evening at a laptop in a lit room (light theme, default), or a phone after a
session (either theme). Light is the default; the system preference wins unless overridden in
Settings. **Both themes are first-class and internally consistent: light chassis → light
screens; dark chassis → dark screens.** Never mix a dark screen into the light theme.

Colour strategy: **Restrained.** Tinted neutrals (hue 250, chroma ≤ 0.01) carry everything.
The signal is used for exactly one thing per view: Today on Week, the measurement cursors on
a chart, the active import on Data. Primary actions are ink keys, not orange.

## Tokens (OKLCH)

### Light (default)

| Token | Value | Role |
|---|---|---|
| `--chassis` | `oklch(0.845 0.005 250)` | App background |
| `--face` | `oklch(0.915 0.004 250)` | Modules, rail, strips |
| `--face-2` | `oklch(0.95 0.003 250)` | Raised key faces |
| `--face-sunk` | `oklch(0.885 0.005 250)` | Recessed wells, day labels |
| `--rule` / `--rule-2` | `oklch(0.8 …)` / `oklch(0.66 …)` | Hairlines / key and module borders |
| `--ink` / `--ink-2` / `--ink-3` | `0.2` / `0.4` / `0.48` L | Text: primary / secondary / labels |
| `--lip` | `oklch(0.62 0.008 250)` | Key bottom lip (1.5px) |
| `--screen` | `oklch(0.985 0.002 250)` | Chart display surface (light LCD) |
| `--screen-2` | `oklch(0.955 0.004 250)` | Readout strip |
| `--grat` / `--grat-2` | `0.83` / `0.93` L | Graticule / no-data fill |
| `--s-ink` / `-2` / `-3` | `0.22` / `0.42` / `0.5` L | Traces and on-screen text |
| `--s-band` | `oklch(0.3 0.02 250 / 0.09)` | Baseline bands, rep segments |
| `--signal` | `oklch(0.67 0.2 42)` | The one signal (safety orange) |
| `--signal-ink` | `oklch(0.17 0.03 42)` | Text on signal |
| `--changed` / `--changed-rule` | `0.885 0.018` / `0.55 0.05` | "Changed by chat" row tint and dashed rule |

### Dark

Chassis `0.165`, face `0.215`, face-2 `0.265`, sunk `0.19`, rules `0.3`/`0.42`, ink
`0.94`/`0.78`/`0.68`; screen `0.13`, screen-2 `0.16`, graticule `0.27`/`0.21`, s-ink
`0.94`/`0.76`/`0.62`, band `oklch(0.94 0.004 250 / 0.12)`, signal `oklch(0.71 0.19 45)`.
Full values live in `c.css`. Dark is applied by `prefers-color-scheme` unless
`[data-theme="light"]` is set, and forced with `[data-theme="dark"]`.

All text pairs meet WCAG AA in both themes; re-verify after any token change.

## Typography

- **Instrument Sans** (400/500/600/700) for UI, titles and prose.
- **Geist Mono** (400/500/600) for every number, readout, prescription figure, revision id,
  diff and time. Always `font-feature-settings: "tnum", "zero"`.
- **Doto** (dot-matrix) for **at most two** small hero readouts per screen (e.g. latest HRV,
  this week's planned km). Never for body text or labels.
- Silk-screen labels: 10px, weight 600, uppercase, `letter-spacing: 0.08em`, `--ink-3`.
  Used only for control and column labels, never as section eyebrows over prose.
- Base size 13px; fixed rem scale at ratio about 1.2 (11 / 12 / 13 / 15 / 17 / 20 px). No fluid type.

## Layout

- **Desktop shell:** a 68px rail (icon + silk label; active = ink key) plus the content area.
  Five destinations (Plan, Activity, Health, Library, Inbox), then one bottom Settings tile whose
  icon is the athlete's initial in a key (`.avatar`, 22px): Profile, Connections, Data and Account
  are tabs there, not rail items.
  The chat panel docks right at about 32% width (380–560px, resizable, persisted). Health
  adds a 240px section navigator; Activities a 300–380px list pane beside the activity.
- **Mobile:** a bottom tab bar (5 items, ≥44px: Plan, Activity, Health, Library, More; Inbox and
  Settings live under More — Inbox's count on the More tab and its row). Chat is a full-height sheet whose header
  shows the scope. Past days collapse to a one-line summary ("3/3 logged").
- **Control strip** (week toolbar): 54px, grouped keys with 1px dividers: ‹ week › · TODAY ·
  view switch (Week / Weeks) · ADD WORKOUT · CHAT.
- **Weekly totals:** a quiet mono line per week (planned vs actual per type, never summed
  together); the Weeks planner ends each week row with it. No target meters.
- **Timetable:** a day-label column (sunk face, big mono date; Today = signal fill) and
  workout rows: grip · type mark · title and item chips · planned values · tags · status ·
  Done key + menu. Linked activities sit beneath the workout on their own line with a
  different mark; unplanned activities sit on their day.
- **Weeks planner:** one row per week, columns Mon–Sun, compact chips (type mark + short title +
  status glyph); on mobile an agenda list.
- **Page width:** content floats centred on the chassis with a margin all round, never pinned to
  one edge: Week ≤ 1080px, Health column ≤ 1040px, Weeks board ≤ 1440px (its column header sticks
  a gap below the toolbar).
- Spacing: 4 / 6 / 8 / 10 / 12 / 14 / 20 / 28 px. Radii: 4px modules, 3px keys, 2px
  badges. Nothing rounder.
- z-index scale: `--z-sticky` < `--z-dropdown` < `--z-sheet` < `--z-modal` < `--z-toast`.

## Components

Every interactive component ships default / hover / focus-visible / active / disabled /
loading / error.

- **Key** (`.key`): face-2, 1px rule-2 border, a 1.5px lip shadow, uppercase 11px/600.
  Press moves it down 1.5px and removes the lip. Variants: `ink` (primary), `signal` (rare),
  `flat`, `sq`, and latched (sunk with an LED). Segmented group (`.seg`) for period pickers.
- **Type mark**: a mono 10px/600 badge (RUN, RID, SWM, SKT, STR, MOB, WLK, CLB, OTH). Type is
  never shown by colour alone. Finer distinctions are tags (quiet chips).
- **Status**: glyph + word. ● Done (a linked activity exists), ○ Planned, ⊘ Skipped (with an
  optional reason); a past workout with no activity and not skipped is ○ with a "Not logged"
  label in ink-3. Never colour alone.
- **Changed row**: `--changed` tint, a dashed `--changed-rule` border, and a mono tag
  `chat · r42`. It fades after the workout ends; the history list keeps it. Proposal previews
  use ghost chips (adds) and strike-through (removals) in the Weeks view.
- **Screen** (`.screen`): the chart surface. Light LCD in the light theme with a 1px border and
  a faint inset shadow; dark inset in the dark theme. It contains a **readout strip** (dt/dd
  pairs, mono) above the plot.
- **Chart module**: module header (title, unit, `n = …`, PIN on analysis results), then the screen,
  then a legend footer with swatches (outlined, so light swatches stay visible).
- **Chat** (the assistant panel): a CHAT badge + thread title; the scope readout (SCOPE·WEEK /
  RANGE / SELECTION / DATA THROUGH); collapsed "› 2 tool calls" line; user bubbles on face-sunk with a
  scope chip; the **proposal card** (dashed separators, mono diff lines, DISCARD + APPLY n);
  the **change receipt** (APPLIED · UPDATED …, strike/add diff lines, revision, SHOW IN WEEK,
  UNDO); citation chips `[1]`; composer with a scope chip and key hints.
  The history key (latched while open) swaps the panel to **earlier chats**: a list, newest
  first, of title, last active, turns and first scope, the open chat marked `current`; picking
  one restores it in place. Back (or Esc) returns to the open chat. No popup.

## Charts (ECharts, themed from these tokens; SVG in the mockup)

- A scope-style **graticule**: dotted majors, minor ticks on the edges and centre line.
  Allowed here because charts are measurement screens.
- Traces use `--s-ink` at 1.2–1.25px; secondary series `--s-ink-2`; bands `--s-band`.
  **The signal is only for cursors and current selection.**
- **A/B cursors** with a readout strip (Δt, mean, max) instead of floating tooltips as the
  primary reading method. Keyboard: ←/→ moves the selected cursor.
- Gaps: missing data shown as a `--grat-2` column labelled "NO DATA · n nights". Lines are
  never joined across a gap, and nothing is interpolated.
- Every chart shows unit, `n`, period, and "data through"; the latest value gets a hollow
  marker plus a readout.
- Planned vs actual: actual = solid fill, planned = dashed outline (never stacked or summed).
- No entrance animation, no gradient fills, no boxed legends inside the plot.

## Motion

120–200ms, ease-out-quart. Keys depress, sheets slide, and changed rows flash their tint once
(opacity only). `prefers-reduced-motion` → instant state changes, no flash.

## Don'ts

- A dark chart screen in the light theme.
- Orange on more than one element per view, or as a primary-button colour.
- Skeuomorphic kitsch: screws, brushed-metal gradients, fake LEDs that glow.
- KPI tile grids, ring gauges, readiness scores, motivational copy.
- Colour-only status or workout type.
