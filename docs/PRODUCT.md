# Product

## Register

product

## Users

Data-literate multisport amateurs who train for themselves: running and other endurance
sports, strength, mobility. Private app for a handful of people, each with their own account
and their own Garmin. Two moments define use:

- **Planning**: an evening at a laptop, focused and unhurried: reviewing the week or several
  weeks, talking the plan through with the assistant, digging into Garmin history.
- **Logging**: on a phone right after a session, often tired or outdoors: one tap for
  Done, maybe an RPE, then gone.

## Product Purpose

A private training studio built on a few fast, fully editable primitives (exercises,
workouts, repeating series, saved workouts, one Profile document) and an embedded assistant
that does the complex planning by writing ordinary workouts into the calendar through those
same primitives. Nothing the assistant does is special: every plan can be edited, moved or
deleted by hand. Beside the plan sits a data-heavy Garmin analysis workspace (Health, with
pinned analyses that stay current). Success: the week is always clear at a glance, logging
costs one tap, the assistant's edits are trusted because they are visible and undoable, and
analysis is honest about what the data can and cannot say.

## Brand Personality

**Precise, candid, calm.** A good instrument, not a fitness app. States what the data shows
and what it doesn't; never cheerleads, never guilt-trips a skipped session, never invents
a readiness score. English UI, plain short sentences, metric units, 24-hour time.

## Anti-references

- Strava / Nike Run Club / WHOOP / Garmin Connect: energetic sports branding, volt accents,
  ring gauges, streak guilt, motivational copy, action photography.
- Generic SaaS dashboards: KPI tile grids, hero metrics, purple gradients, default
  shadcn cards, floating chat bubble with gradient avatar.
- Default chart-library styling: boxed legends, two-axis gridlines, hover-only values,
  entrance animations, gradient area fills, one loud colour per sport.

## Design Principles

1. **The week is the workspace.** Real plan content dominates every Plan screen;
   chrome and decoration stay out of its way.
2. **Planned and actual are never blurred.** Separate values, separate marks, always.
3. **Honest data.** Missing is not zero; estimates are labelled; every aggregate shows its
   sample and range.
4. **The assistant is attached, not floating.** Its context and its edits are visibly tied
   to what's on screen, and every edit shows its undo.
5. **Quiet by default, dense on demand.** Optional work stays visually quiet; detail is one
   interaction away.

## Accessibility & Inclusion

WCAG 2.1 AA in light and dark themes. Status and workout type never conveyed by colour
alone (text/glyph always present); colour-blind-safe palettes. Full keyboard path including
alternatives to drag; visible focus; `prefers-reduced-motion` honoured; touch targets ≥44px
on mobile.
