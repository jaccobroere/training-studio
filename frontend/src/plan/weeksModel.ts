/** Pure logic for Plan → Weeks: loading chunks, selection, shifting, totals and the proposal
 * preview. No React, no DOM, so it is unit-tested directly. */
import type { Chip, Proposal, PreviewChip, Totals, WeeksRow } from "../api/types";
import { addDays, mondayOf, shortDate } from "../ui/dates";
import { TYPE_INFO } from "../ui/sport";
import type { WorkoutType } from "../api/types";
import { bump } from "./versions";

// ---------- Loading in fixed chunks (stable query keys) ----------

const CHUNK = 8; // weeks per request
const EPOCH = "2024-01-01"; // a Monday
const DAY = 86_400_000;

export const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

export const chunkIndex = (monday: string) => Math.floor(daysBetween(EPOCH, mondayOf(monday)) / (7 * CHUNK));
export const chunkFrom = (i: number) => addDays(EPOCH, i * 7 * CHUNK);
export const chunkTo = (i: number) => addDays(chunkFrom(i), 7 * (CHUNK - 1));

/** Every chunk index that covers weeks from `from` to `to` (Mondays). */
export function chunksFor(from: string, to: string): number[] {
  const out: number[] = [];
  for (let i = chunkIndex(from); i <= chunkIndex(to); i++) out.push(i);
  return out;
}

/** Mondays from `from` to `to`, inclusive. */
export function mondays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = mondayOf(from); m <= to; m = addDays(m, 7)) out.push(m);
  return out;
}

/** "13 Oct – 23 Nov" for the toolbar label (the Sunday of the last week). */
export function rangeLabel(from: string, to: string): string {
  return `${shortDate(from)} – ${shortDate(addDays(to, 6))}`;
}

/** Cap the loaded window so it can't grow forever while scrolling: when it holds more than
 * `max` weeks, keep the visible weeks plus an even margin either side (never less than the
 * margin that edge-loading needs, so it doesn't flap). Rows removed are far from the
 * viewport, so scroll anchoring on the first visible week is unaffected. */
export function capRange(r: { from: string; to: string }, first: string, last: string, max = 40): { from: string; to: string } {
  const total = daysBetween(r.from, r.to) / 7 + 1;
  if (total <= max) return r;
  const vis = daysBetween(first, last) / 7 + 1;
  const pad = Math.max(12, Math.floor((max - vis) / 2));
  const from = addDays(first, -7 * pad), to = addDays(last, 7 * pad);
  return { from: from > r.from ? from : r.from, to: to < r.to ? to : r.to };
}

// ---------- Selection ----------

export function toggleSel(sel: ReadonlySet<string>, id: string): Set<string> {
  const out = new Set(sel);
  if (out.has(id)) out.delete(id); else out.add(id);
  return out;
}

export interface Rect { left: number; top: number; right: number; bottom: number }

export const rectFrom = (a: { x: number; y: number }, b: { x: number; y: number }): Rect => ({
  left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y),
});

const overlaps = (a: Rect, b: Rect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** Ids of the items whose rectangles the rubber band touches. */
export function hitIds(box: Rect, items: { id: string; rect: Rect }[]): string[] {
  return items.filter((x) => overlaps(box, x.rect)).map((x) => x.id);
}

/** The selection after a box: replaces it, or adds to it with Shift/⌘ held. */
export function boxSelect(base: ReadonlySet<string>, hits: string[], additive: boolean): Set<string> {
  return new Set(additive ? [...base, ...hits] : hits);
}

// ---------- Shifting ----------

export interface Placed { id: string; date: string | null; week_monday: string }

/** Where each workout lands when shifted by `n` days. Undated ones move to the week `n` days
 * later (the server's `shift_workouts` rule). */
export function shiftTargets(list: Placed[], n: number): Map<string, { date: string | null; week_monday: string }> {
  const out = new Map<string, { date: string | null; week_monday: string }>();
  for (const w of list) {
    if (w.date) {
      const d = addDays(w.date, n);
      out.set(w.id, { date: d, week_monday: mondayOf(d) });
    } else out.set(w.id, { date: null, week_monday: mondayOf(addDays(w.week_monday, n)) });
  }
  return out;
}

/** "Moved 3 workouts 7 days later" / "…1 day earlier". */
export function shiftWords(count: number, n: number): string {
  const what = count === 1 ? "1 workout" : `${count} workouts`;
  const d = Math.abs(n) === 1 ? "1 day" : `${Math.abs(n)} days`;
  return `${what} ${d} ${n > 0 ? "later" : "earlier"}`;
}

// ---------- Totals ----------

/** Fixed order so a type sits on the same line week after week. */
const ORDER = ["run", "ride", "swim", "skate", "walk", "strength", "mobility", "climb", "other"];
const COUNTED = new Set<string>(["strength", "mobility", "climb", "other"]);

export interface TotalLine { type: string; mark: string; actual: string | null; planned: string | null; unit: string }

const km = (v: number) => (Math.round(v * 10) / 10).toString();
const hm = (min: number) => { const m = Math.round(min); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; };

/** One compact line per type: actual / planned. Distance types in km, timed-only types in
 * h:mm, strength-like types as session counts. Future weeks show planned only. The unit
 * follows the plan (so a skate session planned as 75 min compares against minutes). */
export function totalLines(t: Totals, when: "past" | "current" | "future", max = 3): { lines: TotalLine[]; rest: TotalLine[] } {
  const rows = Object.entries(t)
    .filter(([, r]) => r.planned_n || (when !== "future" && r.actual_n))
    .sort(([a], [b]) => ORDER.indexOf(a) - ORDER.indexOf(b) || a.localeCompare(b));
  const lines = rows.map(([type, r]): TotalLine => {
    const mark = TYPE_INFO[type as WorkoutType]?.mark ?? type.slice(0, 3).toUpperCase();
    const hasPlan = r.planned_n > 0;
    let unit: "km" | "h" | "" = "";
    if (!COUNTED.has(type)) {
      if (hasPlan) unit = r.planned_km > 0 ? "km" : r.planned_min > 0 ? "h" : "";
      else unit = r.actual_km > 0 ? "km" : r.actual_min > 0 ? "h" : "";
    }
    const fmt = (n: number, kmV: number, minV: number) => (unit === "km" ? km(kmV) : unit === "h" ? hm(minV) : String(n));
    return {
      type, mark, unit,
      planned: hasPlan ? fmt(r.planned_n, r.planned_km, r.planned_min) : null,
      actual: when === "future" ? null : fmt(r.actual_n, r.actual_km, r.actual_min),
    };
  });
  return { lines: lines.slice(0, max), rest: lines.slice(max) };
}

/** Plain-text form for titles, screen readers and the mobile agenda header. */
export function totalText(l: TotalLine): string {
  const v = l.actual != null && l.planned != null ? `${l.actual} / ${l.planned}` : (l.actual ?? l.planned ?? "");
  return `${l.mark} ${v}${l.unit ? ` ${l.unit}` : ""}`;
}

// ---------- Proposal preview ----------

export interface Ghost { key: string; kind: "add" | "move" | "edit"; chip: PreviewChip; fields: string[] }

export interface PreviewMap {
  /** Ghost chips per slot (a date, or `tray:<monday>` for "no day yet"). */
  ghosts: Map<string, Ghost[]>;
  /** Existing workouts shown struck through: removed, or moved away from here. */
  gone: Map<string, "remove" | "move">;
  /** Existing workouts edited in place (shown as a ghost on the real chip). */
  edited: Map<string, Ghost>;
  /** Removed rows (so they can be drawn even if the grid doesn't list them). */
  removed: PreviewChip[];
  /** First Monday the proposal touches, to scroll to. */
  first: string | null;
}

export const slotKey = (date: string | null, monday: string) => date ?? `tray:${monday}`;

export function previewMap(p: Pick<Proposal, "preview" | "weeks">): PreviewMap {
  const ghosts = new Map<string, Ghost[]>();
  const gone = new Map<string, "remove" | "move">();
  const edited = new Map<string, Ghost>();
  const put = (g: Ghost) => {
    const k = slotKey(g.chip.date, g.chip.week_monday);
    ghosts.set(k, [...(ghosts.get(k) ?? []), g]);
  };
  for (const c of p.preview.added) put({ key: `add:${c.id}`, kind: "add", chip: c, fields: [] });
  for (const c of p.preview.removed) gone.set(c.id, "remove");
  for (const ch of p.preview.changed) {
    const placeChanged = ch.before.date !== ch.after.date || ch.before.week_monday !== ch.after.week_monday;
    if (placeChanged) {
      gone.set(ch.before.id, "move");
      put({ key: `move:${ch.after.id}`, kind: "move", chip: ch.after, fields: ch.fields });
    } else edited.set(ch.after.id, { key: `edit:${ch.after.id}`, kind: "edit", chip: ch.after, fields: ch.fields });
  }
  const first = [...p.weeks].sort()[0] ?? null;
  return { ghosts, gone, edited, removed: p.preview.removed, first };
}

/** "Changed: title, items" for a ghost's tooltip. */
export function ghostTitle(g: Ghost): string {
  const head = g.kind === "add" ? "Proposed" : g.kind === "move" ? "Proposed move" : "Proposed change";
  const f = g.fields.filter((x) => x !== "version" && x !== "position");
  const items = g.chip.items.length ? ` · ${g.chip.items.slice(0, 3).join(" · ")}` : "";
  return `${head}: ${g.chip.title}${g.chip.time ? ` at ${g.chip.time}` : ""}${f.length && g.kind !== "add" ? ` (${f.join(", ")})` : ""}${items}`;
}

// ---------- Index of loaded chips ----------

export interface Indexed extends Chip { week_monday: string }

/** id → chip (with its week), over every loaded week row. */
export function indexRows(rows: WeeksRow[]): Map<string, Indexed> {
  const out = new Map<string, Indexed>();
  for (const r of rows) {
    for (const c of r.tray) out.set(c.id, { ...c, week_monday: r.monday });
    for (const d of r.days) for (const c of d.workouts) out.set(c.id, { ...c, week_monday: r.monday });
  }
  return out;
}

/** Optimistically place chips at new dates inside loaded week rows (drag / shift / move). */
export function placeChips(rows: WeeksRow[], moves: Map<string, { date: string | null; week_monday: string }>): WeeksRow[] {
  if (!moves.size) return rows;
  const moving = new Map<string, Chip>();
  const strip = (l: Chip[]) => l.filter((c) => (moves.has(c.id) ? (moving.set(c.id, c), false) : true));
  const stripped = rows.map((r) => ({ ...r, tray: strip(r.tray), days: r.days.map((d) => ({ ...d, workouts: strip(d.workouts) })) }));
  return stripped.map((r) => ({
    ...r,
    tray: [...r.tray, ...[...moves].filter(([id, t]) => moving.has(id) && !t.date && t.week_monday === r.monday).map(([id]) => bump({ ...moving.get(id)!, date: null }))],
    days: r.days.map((d) => ({
      ...d,
      workouts: [...d.workouts, ...[...moves].filter(([id, t]) => moving.has(id) && t.date === d.date).map(([id, t]) => bump({ ...moving.get(id)!, date: t.date }))],
    })),
  }));
}
