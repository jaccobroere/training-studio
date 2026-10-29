# SCREENS.md — redesigned screens (Instrument Panel, simplified)

Status: spec for slices 2–4 of `SIMPLIFY.md`. The visual system in `DESIGN.md` is unchanged:
same tokens, keys, silk labels, screens, one signal per view. This file decides **what goes on
each screen and how quiet it is**. Where this file and the current frontend disagree, this
file wins. Where it and `SIMPLIFY.md` disagree, `SIMPLIFY.md` wins.

Brief: calm, professional, intuitive, clean. Rule of thumb for every screen: **one primary
object, one primary action, everything else one interaction away.**

---

## 0. Ground rules

- **Viewports.** Shell breakpoints: mobile `≤760px` (existing `MOBILE`), tablet
  `761–1279px`, desktop `≥1280px`. Page internals respond to their own width with container
  queries (`container: plan / inline-size`), never to the viewport, so "desktop with chat
  open" and "tablet" render the same.
- **Spacing** only from the DESIGN scale: 4 / 6 / 8 / 10 / 12 / 14 / 20 / 28. Radii 4 / 3 / 2.
- **Type** only from the scale: 11 / 12 / 13 / 15 / 17 / 20. Numbers, item prescriptions,
  dates and counts in Geist Mono with `tnum zero`. **No Doto on Plan, Library, Inbox,
  Profile.** Doto stays on Health only (≤2 readouts).
- **Silk labels** (`.silk`) only for control labels and column heads. Never above prose,
  never as decoration.
- **Signal** (`--signal`): Week = today's day label; Weeks = today's cell bar; chat/editor
  never. Remove it from the rail logo.
- **Borders.** Module edges `1px var(--rule-2)`; dividers inside modules `1px var(--rule)`;
  dividers between rows inside a day `1px solid var(--rule)` (drop the dashed row rules —
  dashed now means *proposed / not real yet*, see §3).
- **Dashed = not real yet.** Ghost proposal chips, drop targets, the empty tray. Nothing
  real is ever dashed.
- **Planned vs actual.** Planned = type mark badge (`.sport`, outlined). Actual = the actual
  mark `■` (8×8 ink square) on its own line. Never on the same line, never merged.

---

## 1. Shell and navigation

Destinations: **Plan** (home) · **Activity** · **Health** · **Library** · **Inbox** · **Settings**
(Profile · Connections · Data · Account) · **More** (phone only). On a phone **Inbox** moves under
More so the bar stays at five (Plan, Activity, Health, Library, More); its count shows on the More
tab and on the Inbox row.

| | Mobile ≤760 | Tablet 761–1279 | Desktop ≥1280 |
|---|---|---|---|
| Nav | `.tabbar`, 5 items, 48px + safe area | `.rail` 68px | `.rail` 68px |
| More | tab → sheet menu (Inbox + count, Settings, Theme, Sign out) | rail bottom: one Settings tile (avatar + label) | same as tablet |
| Chat | full-height `.sheet` | **overlay panel** from right | **docked** right column |
| Editor / log | sheet (§4, §5) | overlay panel (shares the chat slot) | dock column (shares the chat slot) |

**Rail.** Top: Plan, Activity, Health, Library, Inbox. `.spacer`. Bottom: exactly one **Settings**
tile — the athlete's initial in a `.avatar` (`22px`, `--r-key`, mono 600 10px, uppercase) over the
label, opening `/settings` and active on every `/settings/*` tab. There is no separate profile tile,
data tile, account key or popover: three bottom destinations with overlapping content are one
Settings area (decision 37). Labels are `white-space: nowrap`; the labels are singular category
names, and Activity is not "Activities" because that word overflows the 58px tile. Drop the `.mark`
logo (it spends the signal and adds nothing). Items stay 58px wide, icon 20px + silk label 9.5px;
active = ink key (existing).

**Inbox badge** `.nav-badge` (new): absolutely positioned top-right of the icon,
`min-width 16px; height 16px; padding 0 4px; border-radius 2px; background var(--ink);
color var(--face-2); font 600 10px/16px var(--mono)`. Hidden at 0 (no "0", no dot). Never
signal-coloured. Active rail item inverts it (`face-2` bg, `ink` text).

**Chat entry.** No floating bubble. A `key sq flat` with the chat icon at the right end of
every page toolbar, latched (`.is-latched`) while chat is open. Shortcut `⌘J` / `Ctrl J`.

**One right-hand slot.** Desktop and tablet have one right slot that shows exactly one of:
chat, workout editor, log sheet. Opening the editor stacks it on the chat; closing it (Esc,
Save, ×) returns to the chat if the chat was open. The header of a stacked panel shows a
`key flat` "‹ Chat" on the left. Never two panels side by side.

- **Desktop:** `.dock`, default 440px, resizable 360–620 (existing), persisted. Main content
  reflows (grid column).
- **Tablet:** `.dock.overlay` (new): `position: fixed; top 0; right 0; bottom 0;
  width min(440px, 100vw - 68px); z-index var(--z-sheet); border-left 1px var(--rule-2);
  box-shadow -8px 0 16px -10px oklch(0.2 0.01 250 / 0.3)`. No scrim; the page stays
  interactive (you can drag in the week while the editor is open). Slides in 200ms. At
  ≥1100px the overlay pins as a dock instead (content still ≥660px).
- **Mobile:** `.sheet` full height for chat and editor; log sheet is a bottom sheet (§5).

**Page toolbar** (`.strip`, kept): 54px desktop/tablet, sticky, `face` background,
`1px var(--rule)` bottom. Contents left → right, grouped with `.div` hairlines. **Maximum one
row on desktop/tablet, two on mobile.** Each page has at most one ink key in its toolbar.

Plan toolbar:

```
[ Week | Weeks ]  │  ‹  Wk 42 · 13–19 Oct  ›  TODAY  │  Tag ▾        [+ ADD]  [◫]
```

- `.seg` Week|Weeks (`W` toggles).
- Week nav: `key sq` ‹ › around the label key (`.wk-label`, opens a jump date picker).
  `TODAY` is a `key flat plain`, disabled when the current week is in view. On Weeks the
  label reads the visible range ("13 Oct – 23 Nov").
- **Tag filter** `key plain` "Tag ▾" → popover list of tags with counts. When active it
  becomes latched with the tag name and an inline × ("#marathon ×").
- **+ ADD** (`key ink`) → menu: Workout · Repeating workout · Activity (already done) · From
  saved workout…
- Mobile row 1: seg (left) + chat key (right). Row 2: ‹ label › full width + Tag + `+` as
  `key sq ink`. Keys 40px high on mobile.

---

## 2. Plan → Week (home)

### Anatomy

The board is one `.days` module: seven `.day` rows, then the tray. No column header row.

**Day row** `.day`: grid `64px 1fr`.
- Day label `.dlab` (sunk face, `1px var(--rule)` right): DOW silk 10px + date mono 17px
  (was 20). No session count. Today: signal fill + "TODAY" silk (existing) — **the** signal.
- Past days on desktop: label ink-3; rows unchanged. On mobile past days fold to `.day-fold`
  ("Mon 13 · 2/2 logged"), tap to expand; today and future always expanded.
- Empty day: 36px row, nothing in it. A `key sq flat` "+" (adds a workout on that day)
  fades in on row hover/focus-within; on touch it's always visible in ink-3.

**Workout row** `.wrow` (replaces `.sess`): grid
`16px 40px minmax(0,1fr) auto 32px 30px`, `column-gap 10px`, `min-height 44px`,
`padding 7px 0`, `1px solid var(--rule)` top between rows.

```
⋮⋮  RUN  Tempo 3×10 min                    #marathon       ○ ✓  ⋯
         Run 10 km · easy · Strides 6×20 s
         ■ GARMIN  10.4 km · 52:10 · 5:01/km · RPE 6
```

1. **Grip** (16px, ink-3) — visible only on row hover/focus-within (desktop/tablet), hidden
   on mobile (long-press 350ms drags the whole row).
2. **Type mark** `.sport` (existing badge, 22px).
3. **Body** (a single `<button class="what">` that opens the editor):
   - Title line: title 13px/600 ink, then tags.
   - **Items line** `.items` (new): `font 400 12px/1.35 var(--mono); color var(--ink-2);
     white-space nowrap; overflow hidden; text-overflow ellipsis`. Item chips are **text
     joined by " · "**, not boxes: "Squat 3×5 · 80 kg". After 3 items: "+2". Empty → no line.
   - Tags `.tag` but quieter: `border-color var(--rule); color var(--ink-3)`, max 2 then
     "+1". Hidden below 520px container width (shown in the editor).
4. **Status** `.st` glyph+word, only when it means something: `● Done`, `⊘ Skipped` (title
   struck through, ink-2), `○ Not logged` (ink-3, past only). Planned future rows show
   nothing. Below 640px container: glyph only.
5. **✓ key** `.key.sq.check` (new, 30px; 44×44 on mobile). Not done: outlined check.
   Done: latched (`.is-latched`, sunk, ink check). Press on a past/today workout = Done in
   one tap (toast "Logged · Details · Undo"). On a future workout it opens the existing
   `.when` popover ("Log for today?"). On a done workout it opens the log sheet.
6. **More** `key sq flat` ⋯ → menu: Edit `↵` · Log… `L` · Move to… `M` · Duplicate `D` ·
   Copy to… · Save as template · sep · Skip… · Delete `⌫`.

**Actual line** `.act-line` (new), one per linked activity, beneath the items line, in the
body column (aligned with the title): `display flex; gap 8px; align-items baseline;
padding-top 4px; font 500 12px var(--mono); color var(--ink)`.
- Mark `.act-mark` = `■` 8×8 `var(--ink)` square, then source silk (`GARMIN` / `MANUAL`),
  then values (distance · time · pace/HR · RPE) or, for a value-less manual log, "Logged".
- The whole line is a button → log sheet for that activity. Several activities → several
  lines.
- The planned line never shows actual numbers; the actual line never shows planned numbers.

**Unplanned activity row** `.arow` (new): same grid as `.wrow`, no grip, no ✓. Type column
shows `.sport.act` (new: `background var(--face-sunk); border-color transparent;
color var(--ink-2)`). Body = one actual line with the activity name in 13px/500 sans before
the values. More menu: Link to workout… · Log details… · Delete (manual only).

**Tray** "No day yet" (`.tray`, kept): last block inside the board, after Sunday, same row
anatomy. Header: silk "NO DAY YET" + mono count. Dashed border only when empty and a drag is
in progress (drop target); otherwise hidden when empty, solid `1px var(--rule-2)` when it has
rows.

**Today marker:** signal day label only. No horizontal "now" line, no highlighted rows.

**Changed by chat:** rows the assistant touched in the last change get `--changed` tint,
flashing once (opacity 0→1→0.6, 600ms) and fading out when the change card is out of view or
after the session. Drop the outline and the `chat · r42` tag.

### Empty states

- **Empty future week:** days render as empty rows (still drop targets). Above the days,
  one quiet line `.wk-empty` (13px, ink-2, 10px vertical padding):
  "Nothing planned. **Plan this week** · Add a workout". "Plan this week" is a text link
  (ink, underline offset 2px) that opens chat with the prompt "Plan week 42 (13–19 Oct)
  from my profile and recent training." prefilled, not sent.
- **New account** (no workouts, no series, no activities): replaces the `.wk-empty` line
  with a `.welcome` module (`.module`, padding 20, max-width 560): 17px title "Set up your
  plan", one 13px ink-2 sentence, then four `.welcome-row` buttons (44px, full width,
  left-aligned, `1px var(--rule)` between, icon 16px + label + ink-3 hint):
  Add a workout · Set up a repeating workout · Plan with the assistant · Connect Garmin.
  No illustration, no checklist progress.
- Past week with nothing: empty rows, no copy.

### Drag and keyboard

- Drag sources: grip (desktop/tablet), long-press on row (touch). Targets: any day row,
  the tray. Drop target highlight: `background color-mix(in oklch, var(--face-sunk) 70%,
  var(--face))` + 1px dashed `--rule-2` inset outline. Ghost: existing `.drag-ghost`
  (mark + title). Source row stays at `opacity 0.35`.
- Reorder within a day: drop between rows; a 2px ink insertion line marks the slot.
- Keyboard: rows are in tab order via the body button. `M` opens **Move to…** (existing
  `.move` popover: 7 day keys + "No day" + other date). Focus follows the row after the
  move (existing behaviour). `Alt ↑/↓` reorders within a day; `Alt ←/→` moves one day.
- Every move is undoable: toast "Moved to Thu · Undo".

### Wireframes

Desktop 1440, chat docked (main ≈ 930px):

```
┌rail┐┌─────────────────────────────────────────────────────┐┌ chat 440 ───────┐
│PLAN││[Week|Weeks] │ ‹ Wk 42 · 13–19 Oct › TODAY │ Tag ▾  [+ADD][◫]││ CHAT  Wk 42 plan │
│HLTH│├─────────────────────────────────────────────────────┤│                  │
│LIB ││MON │ STR  Lower A                       ● Done  ✓ ⋯ ││  …thread…        │
│INBX││ 13 │      Squat 3×5 · 80 kg · RDL 3×8 · 60 kg       ││                  │
│ ②  ││    │      ■ MANUAL  Logged · RPE 7                  ││                  │
│    ││────┼────────────────────────────────────────────────││                  │
│    ││TUE │ RUN  Easy                                  ✓ ⋯ ││                  │
│    ││▓14▓│      Run 8 km · Z2                              ││                  │
│    ││────┼────────────────────────────────────────────────││                  │
│    ││WED │                                                ││                  │
│PROF││ …  │                                                ││ [scope Wk 42] ▏  │
│DATA││NO DAY YET 1 │ MOB  Hips 20 min                ✓ ⋯ ││ [Ask…        ⏎]  │
└────┘└─────────────────────────────────────────────────────┘└──────────────────┘
```

Tablet 820 (rail + full-width week; chat/editor overlays from the right, 440px):

```
┌rail┐┌────────────────────────────────────────────────┐
│    ││[Week|Weeks] │ ‹ Wk 42 › TODAY │ Tag ▾  [+ADD][◫]│
│    ││TUE │ RUN  Easy                    #base   ✓ ⋯ │
│    ││ 14 │      Run 8 km · Z2                       │
└────┘└────────────────────────────────────────────────┘
```

Mobile 390:

```
┌──────────────────────────────┐
│ [Week|Weeks]             [◫] │
│ ‹  Wk 42 · 13–19 Oct  › Tag [+]│
├──────────────────────────────┤
│ MON 13            2/2 logged ›│  ← folded past day
│ TUE 14 · TODAY ▓▓▓▓▓▓▓▓▓▓▓▓▓ │  ← signal label bar
│ RUN  Easy                ┌──┐│
│      Run 8 km · Z2       │✓ ││
│                          └──┘│
│ WED 15                     + │
│ THU 16                       │
│ STR  Upper B             ┌──┐│
│      Bench 4×6 · 60 kg … │✓ ││
├──────────────────────────────┤
│ PLAN  HEALTH  LIB  INBOX② MORE│
└──────────────────────────────┘
```

Mobile row: grid `40px 1fr 44px`, padding `10px 10px 10px 12px`, title 15px/600, items
12px mono one line, ✓ 44×44, ⋯ moves into the editor (row tap = editor, long-press = drag
or Move to… sheet). Days are separate `.module` cards with 10px gap (existing).

---

## 3. Plan → Weeks (planner)

### Grid

`.weeks` grid columns: `76px repeat(7, minmax(0,1fr)) 148px`. Sticky header row (silk
MON…SUN, `face` bg, 28px). Rows = weeks, `min-height 64px`, `1px var(--rule)` between rows,
`1px var(--rule)` between day cells. Infinite scroll both directions (8 weeks rendered
around the anchor, more on scroll); history above, future below; opens with the current week
second from the top.

- **Week label cell** (sunk face): "W42" 12px mono 600 + "13 Oct" 11px mono ink-2. Click
  → Week view for that week.
- **Day cell**: `padding 4px; display flex; flex-direction column; gap 3px`. Today's cell
  has a 2px signal bar along its top edge (the signal). Past cells: `face-sunk` at 40%
  mix. Hover reveals a "+" corner key (20px).
- **Totals cell** `.wk-tot` (new): right column, `padding 6px 8px`, mono 11px, one line per
  type present, max 3 + "+2": `RUN  28.4 / 42 km` — actual in ink 600, "/ planned" in ink-2.
  Future weeks: planned only ("42 km"). Strength/mobility count sessions ("STR 2 / 3").
  Below 900px container the column drops and totals render as one line under the week
  label cell spanning the row (`grid-column: 1 / -1`, 11px, ink-2).

**Chip** `.wchip` (new): `height 22px; display grid; grid-template-columns auto 1fr auto;
gap 5px; align-items center; padding 0 5px; background var(--face-2); border 1px solid
var(--rule-2); border-radius 2px; font 500 11.5px/1 var(--sans)`.
- Mark: mono 9.5px/600 ink-2 (text only, no nested badge).
- Short title: ellipsis.
- Status glyph mono 11px: `●` done, `⊘` skipped (title struck, ink-3), `○` not logged
  (past, ink-3); none for planned future.
- Unplanned activity: `.wchip.act` — `face-sunk` bg, no border, `■` instead of status.
- Selected: `background var(--face-sunk); box-shadow inset 0 0 0 1.5px var(--ink)`.
  Focus-visible: the global 2px ink outline, offset 2px.
- Drag: same rules as Week. Drop target cell gets the dashed inset outline.

**Proposal preview** (from chat "Preview in calendar"):
- Add: `.wchip.ghost` — `background var(--changed); border 1px dashed var(--changed-rule);
  color var(--ink)`, a `+` before the mark.
- Remove: `.wchip.gone` — `opacity 0.55; text-decoration line-through`, border dashed.
- Edit: `.wchip.ghost` on the existing chip (tint + dashed), tooltip lists field changes.
- Ghosts are not draggable or selectable. The grid scrolls to the first affected week.
- **Preview bar** `.preview-bar` (new), sticky at the bottom of main, 48px, `ink` bg,
  `face-2` text (same skin as `.toast`): "Proposal · 24 workouts over 6 weeks  [Back to chat]
  [Discard] [Apply 24]". Same bar on all viewports; on tablet/mobile the chat closes to
  make room and "Back to chat" reopens it.

### Selection and bulk

- Click chip = open editor. `Shift`/`⌘`-click = toggle selection. Drag on empty cell area
  = rubber-band box (`1px dashed var(--ink-2)`, `color-mix(ink 6%)` fill). `Esc` clears.
  `⌘A` selects the visible range. Mobile: "Select" `key plain` in the toolbar enters
  selection mode (checkboxes on rows).
- With ≥1 selected, the **bulk bar** `.bulkbar` (new) replaces the toolbar contents in
  place (same 54px strip, no layout shift): "3 selected  │ Move… · Shift days… · Tag… ·
  Delete │ ×". Move… = date picker; Shift days… = stepper −14…+14 with live ghost preview;
  Tag… = tag combobox (add/remove). Delete asks inline in the bar: "Delete 3 workouts?
  [Cancel] [Delete]". All bulk actions → one undoable change, toast with Undo.
- Chat scope while on Weeks: "W42–W47 · 3 selected" (scope chip in the composer).

### Tag view

The toolbar tag filter applies to both views. In Weeks, non-matching chips are hidden,
totals are recomputed for the tag, and the label column shows the tag's weekly count. The
latched filter key ("#marathon ×") is the only indicator. No separate page.

### Wireframes

Desktop 1440 (chat closed, main ≈ 1370):

```
[Week|Weeks] │ ‹ 13 Oct – 23 Nov › TODAY │ #marathon × │                 [+ADD][◫]
      MON        TUE         WED        THU        FRI   SAT        SUN     TOTAL
W41 │STR Lower ●│RUN Easy  ●│          │RUN Tempo●│     │RUN Long ●│MOB 20 ●│RUN 31.8/32 km
6Oct│           │           │          │          │     │          │        │STR 1/1
W42 │STR Lower ●│RUN Easy  ▓│          │RUN Tempo │     │RUN Long  │        │RUN 8.2/36 km
13O │           │           │          │+RUN Strid┆     │          │        │STR 1/2
W43 │STR Lower  │RUN Easy   │          │╌RUN Tempo╌│    │RUN Long  │        │RUN 38 km
```

Tablet 820: same grid, totals fold under each week; chips show mark + 6–8 chars of title.

Mobile 390 — **agenda** `.agenda` (not a grid):

```
│ [Week|Weeks]            [◫] │
│ ‹ 13 Oct – 23 Nov › Select [+]│
├──────────────────────────────┤
│ W42 · 13–19 Oct   RUN 8/36 km│  ← sticky week header (sunk)
│ Mon 13  STR Lower A        ● │
│ Tue 14  RUN Easy             │  ← 44px rows, tap = editor
│ Thu 16  RUN Tempo            │
│ W43 · 20–26 Oct   RUN 38 km  │
│ …                            │
```

Agenda row: `44px; grid 56px 40px 1fr 20px` (date mono 12px, mark, title, glyph). Days
with nothing are omitted. Long-press → menu with Move to…, Duplicate, Delete.

---

## 4. Workout editor

**Where.** Desktop: dock column. Tablet: overlay panel. Mobile: full sheet (slides up,
header has × left, Save right). Uses `.panel / .panel-hd / .panel-bd`.

**Save model.** Explicit. Footer (sticky, `1px var(--rule)` top, 52px): `[Cancel]` flat ·
spacer · `[Save]` ink (`⌘↵`). New workout: `[Add]`. Dirty + Esc/× → the footer turns into
"Discard changes?  [Keep editing] [Discard]". No autosave (series scope and version
conflicts need one decision point).

**Header** (54px): type mark · "Edit workout" / "New workout" (14px/600) · spacer · ⋯
actions menu · × close. Stacked over chat: "‹ Chat" flat key replaces ×'s neighbour.

**Field order** (one column, `gap 14px`, labels are `.silk` above controls):

1. **Title** — `.input` 15px/600, no visible label (placeholder "Title"), full width.
2. **Type · Date** — one row, `grid 1fr 1fr gap 8`. Type = `.select` listing the 9 types
   with mark. Date = date input + `key plain` "No day" toggle (latched → date disabled,
   "This week, no day").
3. **Repeat** — one line summary key ("Does not repeat" / "Weekly on Tue, Thu" / "Every 2
   weeks on Sat · until 4 Apr") that expands inline to: `.seg` Off|Weekly; interval stepper
   "every [1] week(s)"; weekday keys `.days7` (7 × `key sq` 30px, M T W T F S S, latched
   = on); "Until" optional date. Default weekday = the workout's date.
4. **Items** — the body of the editor (below).
5. **Notes** — `.textarea` 3 rows, autosize to 10.
6. **Tags** — token input: existing tags as `.tag` with ×, typing suggests existing tags,
   Enter creates.
7. **Media** — list (below).

Planned totals (sum of items) show as one mono 11px ink-2 line under the items list:
"Planned 14 km · 75 min". Linked activities show at the bottom as read-only actual lines
(same `.act-line`), never mixed into the form.

### Item list

`.items-ed` list, rows separated by `1px var(--rule)`, module-style border `1px
var(--rule-2)`, radius 3.

Collapsed row `.irow` (44px): grid `16px minmax(0,1fr) 150px 24px 24px`, gap 8.

```
⋮⋮ Back squat                   [3x5 80kg      ]  ▸  ×
                                 3 sets · 5 reps · 80 kg
```

- Grip (drag to reorder; `Alt ↑/↓` with keyboard).
- Exercise name 13px/500 (button → opens exercise in Library popover).
- **Quick-entry** `.input.mono` 12.5px, 150px (full width on mobile, on its own line).
  Parsed live on input (debounce 150ms) into the fields. Under it, `.parsed` mono 11px
  ink-3: "3 sets · 5 reps · 80 kg". Unparsed remainder goes to `note` and shows as
  "note: …". Grammar examples as placeholder: "3x8 60kg · 10k easy · 20 min".
- ▸ expands; × removes (toast Undo, no confirm).

Expanded: `.form-grid` of Sets · Reps · Load · Duration (min) · Distance (km) · Intensity
· Note, 8px gap, inputs 30px. Editing a field rewrites the quick-entry text. Only one row
expanded at a time.

Footer of the list: `key plain` "+ Add exercise" (`A`). On desktop with the Library side
drawer open (§6), exercises can be dragged into the list.

### Exercise picker

Desktop/tablet: popover anchored to "+ Add exercise", 340px wide, max-height 420. Mobile:
full sheet.
- Search `.input` autofocused. Results: recent 5 first, then alphabetical. Row 36px
  (44 mobile): checkbox · name · type mark (mono 9.5px ink-3) · default measure ink-3.
- `↑/↓` move, Space ticks, Enter adds ticked (or the highlighted one when none ticked).
- No exact match → first row "+ Create 'Nordic curl'" (ink, 500). Creates with the
  workout's type and `reps` measure, ticks it, keeps the picker open.
- Footer: count + `[Add 3]` ink key.

### Series edit scope

Saving a content change on a series occurrence turns the footer into the prompt
`.scope-ask` (new, same 52px footer, no modal):
"Apply changes to  [This workout]  [This and following]   Cancel". Date-only changes skip
the prompt. Result toast states what happened: "Updated 9 workouts · 2 customised weeks
kept · Undo". Delete on an occurrence asks in the same footer: "[This one] [This and
following] [Whole series]" with a one-line ink-3 note "Logged workouts are kept."

### Media

List of rows (36px): link icon · title (or host) · host mono ink-3 · ×. "+ Add link"
reveals one URL input (title fetched or editable). Images: thumbnail 32×32 radius 2 + title.
Links open in a new tab. No embeds.

### Actions menu (⋯)

Duplicate (same day, opens copy) · Copy to… (date picker popover, multi-date) · Save as
template · sep · Delete (danger text). Delete of a single workout: no confirm, toast Undo.

### Wireframes

Desktop dock 440:

```
┌───────────────────────────────────────┐
│ RUN  Edit workout              ⋯   ×  │
├───────────────────────────────────────┤
│ [Tempo 3×10 min                     ] │
│ TYPE            DATE                  │
│ [RUN Run    ▾] [Thu 16 Oct ▾][NO DAY] │
│ REPEAT  Weekly on Thu              ▸  │
│ ITEMS                                 │
│ ┌───────────────────────────────────┐ │
│ │⋮⋮ Warm-up        [15 min easy   ]▸×│ │
│ │                   15 min · easy    │ │
│ │⋮⋮ Tempo          [3x10min @T    ]▸×│ │
│ │⋮⋮ Cool-down      [10 min        ]▸×│ │
│ └───────────────────────────────────┘ │
│ + ADD EXERCISE     Planned 12 km · 65 min│
│ NOTES [                              ] │
│ TAGS  #marathon ×  [add tag…]          │
│ MEDIA + Add link                       │
├───────────────────────────────────────┤
│ CANCEL                        [ SAVE ] │
└───────────────────────────────────────┘
```

Mobile sheet: header `×  New workout  ⋯  SAVE`; same order; item quick-entry on its own
line under the name; footer hidden (Save in header) so the keyboard doesn't stack two bars.

---

## 5. Log sheet

**Where.** Mobile: bottom sheet `.sheet.bottom` (new: `top auto; max-height 90dvh;
border-radius 4px 4px 0 0; border-top 1px var(--rule-2)`; 4×32px grab bar in `--rule-2`;
drag down or Esc to close). Tablet: overlay panel. Desktop: dock column.

**Content** (one column, `gap 14`):

1. Header: type mark · workout title · date mono ink-2 · ×.
2. `.seg` **Done | Skipped**, full width, 36px (44 mobile). Default Done.
3. Skipped → reason `.input` ("Reason (optional)") + three `key plain` suggestions:
   Sick · Injured · No time. Fields below hide.
4. **Items** (`.sl-list`): one row per item, all ticked by default: checkbox · number · name ·
   prescription mono. Untick = skipped item. Hidden when the workout has no items.
   **Counted or held items** (reps, or sets of seconds; DECISIONS.md #33) add, under the name,
   "Last <date>: 3 × 8 · 60 kg" and a row per set: number · Reps (or Time) stepper · kg stepper ·
   a round log key · × (extra rows only). Rows start from the last session's same set, else
   the plan's low end; still-to-do rows are dashed with ink-3 numbers, logged rows solid with
   an ink key. ✓ logs, tapping it again un-logs; "+ Set" adds a row like the last one. Each
   change saves after a short pause (legend shows "Saving… / Sets saved"), no toast; the
   Save key is for outcome, RPE and notes. Steppers 32px (44px on mobile, − / + 38px wide).
5. **RPE** `.rpe` (new): label silk "RPE" + a `.seg` of 10 keys (1–10), each `26px` wide
   (`32px` on mobile, wraps to 2×5 below 360px), mono 12px; selected = `is-on` ink. A
   `key flat` "Clear" appears once set. No slider, no colour scale, no emoji.
6. **Duration · Distance**: two `.input.mono` side by side ("min", "km"). Hidden when a
   Garmin activity is linked; instead a `.screen` with a `.readout` row (distance, time,
   pace, avg HR) read-only.
7. **Notes** `.textarea` 2 rows.
8. Footer: `[Save]` ink full width on mobile, right-aligned on desktop. For an existing log,
   ⋯ menu adds "Unlink activity" / "Delete log".

**Log activity** (unplanned, from + ADD → Activity): same sheet, title "Log activity",
no Done/Skipped, no items; adds Type select, Date (default today), Title (default
"<Type>"), then RPE, Duration, Distance, Notes. An unlinked activity's ⋯ menu has
"Link to workout…" (the shared link menu below); linking opens that workout's log.

**Link menu** (week row ⋯, Inbox ▾, the activity sheet ⋯; one component): "Planned · within
a week" (its type when there are any, nearest day first, day as hint), then "From a saved
workout · on <day>" (creates it on the activity's day and links it; one change, one Undo).

Mobile wireframe:

```
│            ▬▬▬▬                │
│ RUN  Tempo 3×10 min  Thu 16  × │
│ [   DONE   |   SKIPPED   ]     │
│ ☑ 01 Warm-up      15 min easy  │
│ ☑ 02 Back squat   3×5 80 kg    │
│   Last 9 Oct: 3 × 5 · 77.5 kg  │
│ 1 [− 5 +] [− 80 kg +]  (●)     │
│ 2 [− 5 +] [− 80 kg +]  (○)     │
│ 3 [− 5 +] [− 80 kg +]  (○)     │
│ [+ Set]                        │
│ RPE                            │
│ [1][2][3][4][5][6][7][8][9][10]│
│ [ min ] [ km ]                 │
│ [Notes                       ] │
│ [            SAVE            ] │
```

Desktop: same content in the dock with `[Save]` right-aligned in a sticky footer.

---

## 6. Library, Inbox, Settings, Chat

### Library

Toolbar: `.seg` Exercises | Saved workouts · search `.input` (240px, full width mobile) ·
spacer · `+ NEW` ink · chat key.

- **Desktop/tablet:** two columns inside main: list (360px) | detail (rest), `1px
  var(--rule)` divider. Mobile: list → detail push (back key in header).
- **Exercise list row** (44px): name 13px/500 · type mark ink-3 · default measure mono
  ink-3 · "used 12×" mono ink-3 right. Archived hidden behind a "Show archived" toggle at
  the list bottom.
- **Exercise detail:** name (inline editable 17px/600), type, default measure (`.seg`
  reps|time|distance), Notes (cues), Media list (§4), **Progress** (from logged sets: a `.screen`
  readout Last top set · Best est. 1RM (or total reps / time) · Sessions, a line of that best per
  session when there are two or more, then the last 12 sessions: day · workout · "5, 5, 4 · 82.5 kg"),
  "Used in" (last 5 workouts, links).
  ⋯: Merge into… (picker, then inline confirm "Merge 'RDL' into 'Romanian deadlift'? 14
  workouts update."), Archive.
- **Saved workout** list row: mark · title · items summary mono ink-3. Detail = the workout
  editor body without date/repeat; ⋯: Add to day… · Duplicate · Delete. Rows are draggable
  onto Week days and Weeks cells.
- **Library drawer** on Plan (desktop only): `key sq flat` with the library icon in the
  Plan toolbar opens a 280px left drawer inside main (`.libside`, face, `1px var(--rule-2)`
  right) with search + both lists. Drag saved workouts onto days, exercises into an open
  editor. Closed by default; persisted.

### Inbox

One page, two sections, each a `.module` with a 42px `.module-hd` (title 14px/600 + mono
count). Empty section hidden; both empty → one line "Nothing to sort." (13px ink-2).

1. **Recordings to link** row (56px): `■` + type mark + activity name + date/time mono +
   values mono ink-2; right: `key` "Link to…" (popover with candidate workouts that week,
   best match first) and `key flat` "Keep as unplanned".
2. **Not logged** row: type mark · title · date · `key sq` ✓ (Done) · `key flat` "Skip…" ·
   row click → editor.
Resolved rows collapse (160ms height) with an Undo toast. Badge count updates.

### Settings (rail bottom · More → Settings)

`/settings` redirects to `/settings/profile`. Old `/profile` and `/principles` go to Profile,
`/data`, `/data/sync` and `/data/*` to Connections, `/data/account` to Account.

Strip: title "Settings" · `.seg .settings-tabs` Profile | Connections | Data | Account (icons
`profile`, `sync`, `data`, `user`) · spacer · chat key. On a phone the title and the tab icons drop
so the four labels and the chat key stay on one row. The two-column `settings-grid` /
`settings-col` (one column on a phone) holds every tab but Profile.

| Tab | Contents |
|---|---|
| **Profile** | The versioned document, embedded — its own second-row toolbar (silk "Training profile" · Edit \| Preview · spacer · Save / saved-at · Versions) and the body filling the rest. No title or chat key of its own: the Settings strip has them. |
| **Connections** | Garmin Connect (sign-in, schedule, Sync now) · Recent syncs (the last 3 pulls, time + outcome) · Backfill history · What is synced |
| **Data** | Uploads & imports (demo removal, recent imports) · Coverage (delete synced Garmin data) · Export (full archive) |
| **Account** | Training profile card (opens the Profile tab) · Sign-in / password · Signed-in devices · Assistant & appearance · Delete account |

**Profile tab.** Embedded (`.settings-profile`), so the document starts under the Settings strip:
- Editor: `.textarea` without chrome (no border, `face` background inside a `.module`),
  14px/1.6 Instrument Sans, max-width 72ch, centred, padding 20. Headings are plain `#`
  Markdown. New-account prompts are real placeholder lines in ink-3 that disappear on first
  keystroke in that section.
- Save: explicit `[Save]` ink key appears in the toolbar only when dirty ("Saved 14:02"
  mono ink-3 otherwise). Each save = a version.
- Versions: desktop right column 260px (mobile sheet): rows "v12 · 11 Oct 14:02 · you" /
  "· assistant", click previews read-only with a diff toggle (existing `diff.ts`), `[Restore]`
  → new version + Undo toast.

**Account profile card.** The Account tab starts with a one-paragraph card, "Training profile",
whose footer key opens `/settings/profile` in one click. The Profile tab stays, so existing
links and the editor's save/versions behaviour are unchanged; nothing is duplicated.

**Connections recent syncs.** Under Garmin Connect, a card lists the last three `pull` import
rows (the same persisted rows the Data tab shows): outcome tag ("Synced" / "Partial" /
"Failed" / "Cancelled" / "Syncing" / "Queued"), run label and the finish (or start) time,
newest first. Fewer than three shows what exists; none shows "No syncs yet…".

### Chat

- **Header** (54px, existing `.con-hd`): silk `CHAT` · thread title · history key · `+ NEW`
  · ×. Drop the `.scope` screen readout block under the header; scope lives only in the
  composer as the `.scope-chip` ("Week 42" / "W42–W47 · 3 selected" / "Health · Sleep").
- **Tool steps:** existing collapsed `.tools` line "› 2 steps · calendar, workouts".
- **Change card** (`.receipt.change`, applied live): header mono 10.5px "APPLIED · 3
  changes" · diff rows (existing `.d-row` ad/rm/ed, max 6, then "4 more" toggle) · footer:
  `key flat` "Show in plan" · spacer · `key` "Undo". Undone: header "UNDONE", diff struck,
  footer empty.
- **Proposal card** (`.receipt.proposal`, new skin on `.receipt`): header "PROPOSAL · 24
  workouts · 6 weeks"; summary 1–3 lines 12.5px ink (`.rc-note`); condensed diff grouped by
  week (one line per week: "W43  +4  −1  ~2"), expandable to rows; footer: `key flat`
  "Discard" · `key` "Preview in calendar" (latched while previewing) · spacer · `key ink`
  "Apply 24". States: applied → header "APPLIED · 24 workouts", footer "Show in plan · Undo";
  discarded → `opacity 0.6`, header "DISCARDED", no footer; stale → header "OUT OF DATE",
  note "The plan changed since this was proposed." + `key` "Ask again" (prefills the
  composer). Only the latest open proposal on a thread has live buttons.
- **Attachment chip** `.att` (new) in the composer above the textarea: `height 28px;
  display inline-flex; gap 6px; padding 0 4px 0 8px; border 1px solid var(--rule-2);
  border-radius 2px; background var(--face-2); font 500 12px var(--sans)`. Contents: file
  icon 14px · name (max 24ch, ellipsis) · size mono 10.5px ink-3 · `key sq flat` × (24px).
  Uploading: size slot shows "38%" mono; error: `border-color var(--danger)` + "Too large"
  ink text; image: 20×20 thumbnail replaces the icon. Paperclip `key sq flat` left of the
  send key; drag-drop onto the panel shows a dashed `--rule-2` inset outline "Drop to
  attach".
- **Empty thread:** one line "Ask about your plan, your data or your profile." + 3
  `key plain` starters relevant to the page. No avatar, no greeting.

---

### Activities (own page) and Efficiency

**Route** `/activities/<id>`; the view in the query (`?tab=overview|laps|stints|efforts`, `?win=120-380`
the window in seconds), the list filters too (`?sport=&range=4w|12w|1y|all`, `?from=&to=`, `?q=`).
Old links `/stats/activities?activity=<id>&tab=…` and `/health/activities…` redirect here.

**Layout.** Wide: two panes under a 54px strip (title, count, Discuss, chat): the **list pane**
(300–380px: search, sport select, period keys 4W 12W 1Y ALL DATES, then recordings grouped by
month (100 rows at a time, "Show more"), two lines per row: mark, name, date · time; distance · time, and km/h · min/km for skate and
ride, min/km · bpm for run) and the **activity pane** (the view below, ≤ 1040px). With no id the
newest recording with a stream opens. Phone: the list is the page; a row opens the activity with a
"‹ Activities" key in the strip that returns to the list with the same filters. Rows without a
stream say "summary only" and open the summary. Empty: "No activity matches these filters" +
Clear filters; "No recordings in this period" + links to Settings → Connections (Garmin) and Settings → Data (upload).

- **Header**: type mark, name, date · start time · device, plan tag when linked, and the **Type**
  control: a select (all types). On a recording it sets the type the analysis uses; the line "Set by
  you · Garmin says Other" and a Reset key show while it differs from the device. A toast offers Undo.
  The tabs, laps, stints and units follow the type at once.
- **Summary** `.av-sum`: one mono wrapping row (three by three on a phone). Run: distance, moving,
  pace, GAP, cadence (spm), energy, HR, climb. Ride: speed, max, power, cadence. **Skate: speed
  (km/h) and pace (min/km) side by side**, max, best 400 m, the turn count with the share of moving
  time spent turning, and rest (stopped time, its share of elapsed, the stop count).
- **Tabs** (one `.seg`, 44px keys and full width on a phone): **Overview · Laps · Stints (skate) ·
  Efforts**. Secondary charts sit behind a disclosure row (`.fold`).
- **Trace card** (`TracePanel`, the same on Overview, Laps and Stints): control row (title, **Select
  range** / **Clear window**, Time | Distance), a labelled readout, the stacked trace (speed or pace,
  HR, power, elevation; rests shaded), a legend that names every mark (line, rest band, lap or
  stint band, threshold, your window) and a "how to read this" line with the longer explanation
  behind a disclosure. The readout is **Session** (the whole recording, from the same moving-time
  figures as the summary) until you point at the trace, then **At** (cursor ± 5 s) and, with a
  window, **Window a–b** (signal label, length) — the same six cells in all three states, so the
  chart never moves under your finger — with distance, speed and pace (both, always), heart rate
  (avg, max), power or cadence.
- **Overview readout** ("Effort and efficiency" fold): moving, stopped, decoupling, EF (the whole
  session's output per heartbeat — power ÷ HR, else grade-adjusted speed ÷ HR — with the basis
  named in the note and the definition linked) and HR drift, then climb when recorded.
  A steady block (5 min or more, even pace) adds **Steady EF**, and the decoupling then read on
  that block; without one the decoupling cell says "—" rather than passing off an interval
  session's pace change as drift, and the note says how close the most even block came.
- **Turns and straights** (skate with GPS, behind a disclosure): straight speed, turn speed, their
  difference (a negative figure means the turns were faster) and the share of the moving time spent
  turning, with the heading rule behind the note.
- **The window**: drag across the plot (mouse, pen) to pick a stretch; it is drawn across every
  panel in the signal colour with its length on top. Drag the body to move it, its two grips to
  resize (44–48px hit areas, so a thumb can grab them); the grips are sliders: ← → move 1 s, Shift
  10 s. Click outside the window, **Clear window** or Esc on a grip puts it away. On touch a finger
  drags the window itself and bare plot keeps scrolling the page, so **Select range** drops a
  window at the cursor (or the middle) and the grips adjust it. Under 5 s is ignored. A lap row, a
  stint rung, a lap-chart point, a point on the efforts curve or a fastest distance sets the same
  window (efforts switch to Overview); the row that equals the window is outlined. The window is
  in the URL a moment after it settles.
- **Laps**: one control row (400 m · Gate · Device · 200 m · 1 km · Stints; on a phone three keys and
  a native More). Readout: laps, best, median, CV, fade, blocks (or the run's second half against
  the first). **Lap chart**: one point per full lap on an axis anchored to the best lap and capped
  at the 9th decile (10th for speed), so one outlier cannot flatten the plot; skating always reads
  **km/h** on this axis whatever the lap source, while the other sports use lap time for equal-length
  laps and km/h for device and stint laps; laps beyond the cap
  are hollow triangles on the nearest edge and the key says how many, the best lap is the signal,
  a stop in the lap hollow, median dashed, thin line = lap heart rate; the x axis is the lap
  number with even ticks; click a point to measure that lap. The trace follows with alternate laps banded. **Lap table**: all laps, time and
  the lead speed (km/h for skate and ride, min/km for run) with the other beside it, Δ best, Δ
  median, HR, cadence when recorded; a "rest 1:40" divider where a block starts; rows are buttons.
  Per-block summary (time, laps, best, km/h, fade) is the fold "By block", open when the session has rests.
- **Stints**: definition keys (Median + 15 % · ≥ 20 km/h), readout, the trace with stints banded and
  the threshold dashed, and a ladder (fastest or in order; min/km beside km/h); a rung is the window.
- **Efforts**: speed–duration curve (10 s … 1 h; pace for runs, a power switch for rides) against the
  period best and all-time best, and fastest distances with PB and Δ PB.
- **Efficiency** stays on Health: EF per session with the monthly median, decoupling bars against a
  5 % line; type switch run · ride · skate.

## 7. Interaction, motion, states, copy

**Motion.** 120–200ms, `var(--ease)`. Keys depress (existing). Panels/sheets slide 200ms
(translateX 24px / translateY 24px + opacity). Rows: no enter animation; removed rows fade
120ms. Changed rows flash tint once. Reduced motion → instant, no flash (existing global).

**Focus/keyboard.** Global 2px ink focus ring (existing); a lit segmented key uses the face
colour so the ring stays visible inside the clipped radius. Opening a panel focuses its first
field (editor: title for new, nothing-but-panel for existing → focus the panel heading);
closing returns focus to the invoking row. Esc closes the topmost layer only.
Shortcuts (shown in menus as `.menu-hint`, never as a footer line): `←/→` week · `T` today
· `W` Week/Weeks · `N` new workout · `⌘J` chat · on a focused row `↵` edit, `L` log,
`Space` toggle done, `M` move, `D` duplicate, `⌫` delete, `Alt+arrows` move/reorder.
`?` opens a shortcut list popover.

**Touch.** ≥44×44 on mobile for every tap target (✓, ⋯, nav, seg keys, checkboxes rows).
Desktop keys stay 30px. Long-press 350ms = drag/menu, with haptic-free visual lift
(`drag-ghost`).

**Loading.** Skeletons shaped like content: Week = 7 day rows with one `.skel` bar 40% wide
per row; Weeks = 6 week rows of empty cells; lists = 6 rows of 44px. Never a spinner on a
page; keys show `.busy` during mutations. Optimistic updates for done/move/reorder/delete.

**Toasts** (existing `.toast`): one at a time, bottom centre (above tab bar on mobile), 6s,
paused on hover/focus. Every destructive or bulk action toasts with `Undo` (and `⌘Z` while
the toast is visible). Format: "<Past-tense verb> <object> · Undo".

**Errors.**
- Mutation failed: row reverts, toast `.error` "Couldn't save. Retry".
- Version conflict: row shows a one-line inline note under it (12px ink-2, `1px var(--rule)`
  top) "Changed elsewhere. [Reload]".
- Page load failed: `.state-err` module "Couldn't load this week. [Retry]".
- Form validation: inline under the field, 11.5px `--danger`, field border `--danger`.
- Proposal apply refused (stale): card switches to the stale state; no toast.

**Copy.** Short, plain, sentence case in prose; keys uppercase via `.key` styling. No
exclamation marks, no "Great job", no streaks, no emoji. Verbs on buttons (Save, Add, Apply
24, Discard). States in plain words: "Not logged", "No day yet", "Nothing planned".
Numbers metric, 24-hour time, dates "Thu 16 Oct".

---

## 8. Remove or quiet down (current UI → new)

Remove:
- `MeterBank.tsx`, `.targets`, `.ch*`, `.meter*`, `.gym-l` — week targets are gone.
- `SeasonStrip.tsx`, `.season-strip`, `.ss-*`, `.lg-*`, `.ss-target` — no seasons.
- Strip clutter in `WeekPage.tsx`: `.field.countdown` + `.dotm` (Doto), `.phase-f`,
  `.div.cd` / `.div.ph`, `.hist-t` revision field, History key and `HistoryPanel.tsx`
  (undo lives on toasts and change cards).
- `.grid-hd` column header row and its silk labels.
- `.pa` P/A column in the row (`plannedText` / `actualText`) — replaced by the items line
  and the actual line.
- `.prio` and `.sess.prio-C` styling — priority is gone.
- In-title tags: `chat · r42` `.tag` and `⌁ recorded` `.rec-tag`; `.sport.rec` dashed
  badge.
- `.sess.changed` outline + tag (keep only the fading tint).
- Statuses Partial / Cancelled, `.status-seg` 5-way grid, "Mark partial", "Completed as
  prescribed" menu items.
- `AddSession.tsx` (replaced by the editor), `SessionDetail.tsx` `.pa-cols` / `.pa-body`
  plan-vs-actual screen.
- `.kbd-hint` footer line, `.ew-guide`, `.empty-week` two-column block with guide links.
- `DraftCard.tsx` and all `.dr-*` (plan drafts), `StartPage.tsx` onboarding redirect.
- `.scope.screen` readout block under the chat header.
- Rail `.mark` logo with the signal dot; `PrinciplesPage` nav item (→ Settings → Profile).

Quiet down:
- Day label date 20px → 17px; drop `.dlab .cnt`.
- Row dividers dashed → solid `--rule`; tray dashed only as a drop target.
- Grip visible on hover/focus only.
- Tags: `--rule` border, `--ink-3` text, max 2 per row.
- `.done-key` with "DONE"/"LOGGED" text → icon-only `.key.sq.check` (label via
  `aria-label`); mobile 44×44 icon key, not 64×44 with text.
- Toolbar: one ink key per page; `TODAY` as flat plain key.
- Chat cards: max 6 diff rows before "n more"; one ink key per card.
