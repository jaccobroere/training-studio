import type { Item, Measure, Media, Rule, WorkoutType } from "../api/types";
import { formatEntry, type ItemFields } from "../plan/quick";

export interface EdItem {
  key: string;
  id?: string;
  exercise_id: string;
  name: string;
  /** The entry text: sets, reps, load and so on, without the note (formatEntry). */
  quick: string;
  f: ItemFields;
}

export interface Repeat { on: boolean; interval: number; weekdays: number[]; until: string | null }

export interface Draft {
  title: string;
  type: WorkoutType;
  date: string | null;
  week_monday: string;
  /** Optional start time "HH:MM"; null = any time that day. */
  time: string | null;
  tags: string[];
  notes: string;
  items: EdItem[];
  media: Media[];
  repeat: Repeat;
}

let n = 0;
export const newKey = () => `k${++n}`;

const FIELDS = ["sets", "reps", "load", "duration_min", "distance_km", "intensity", "note"] as const;

function fieldsOf(it: Item): ItemFields {
  const f: ItemFields = {};
  for (const k of FIELDS) {
    const v = it[k];
    if (v !== null && v !== undefined && v !== "") (f as Record<string, unknown>)[k] = v;
  }
  return f;
}

export function toEdItem(it: Item): EdItem {
  const f = fieldsOf(it);
  return { key: newKey(), id: it.id, exercise_id: it.exercise_id, name: it.name ?? it.exercise_id, quick: formatEntry(f), f };
}

/** Back to the API shape: only the fields that are set, item ids kept. */
export function toItem(e: EdItem): Item {
  const out: Item = { exercise_id: e.exercise_id };
  if (e.id) out.id = e.id;
  for (const k of FIELDS) {
    const v = e.f[k];
    if (v !== null && v !== undefined && v !== "") (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}

export function plannedOf(items: EdItem[]): { km: number; min: number } {
  let km = 0, min = 0;
  for (const it of items) {
    const sets = it.f.sets ?? 1;
    km += (it.f.distance_km ?? 0) * sets;
    min += (it.f.duration_min ?? 0) * sets;
  }
  return { km: Math.round(km * 100) / 100, min: Math.round(min) };
}

export const ruleOf = (r: Repeat): Rule => ({ freq: "weekly", interval: r.interval, weekdays: [...r.weekdays].sort() });

/** Content fields for the ops. `time` is sent only when set or changed (it is optional on the
 * server and older servers don't know it). */
export function content(d: Draft, base?: Pick<Draft, "time"> | null) {
  const c: Record<string, unknown> = { title: d.title.trim(), type: d.type, tags: d.tags, notes: d.notes, items: d.items.map(toItem), media: d.media };
  if (d.time || (base && (base.time ?? null) !== (d.time ?? null))) c.time = d.time || null;
  return c;
}

const DOWS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** "Does not repeat" / "Weekly on Tue, Thu" / "Every 2 weeks on Sat · until 4 Apr". */
export function repeatSummary(r: Repeat, fmtDate: (d: string) => string, time?: string | null): string {
  if (!r.on) return "Does not repeat";
  const days = [...r.weekdays].sort().map((d) => DOWS[d]).join(", ");
  const base = (r.interval === 1 ? `Weekly on ${days}` : `Every ${r.interval} weeks on ${days}`) + (time ? ` at ${time}` : "");
  return r.until ? `${base} · until ${fmtDate(r.until)}` : base;
}

/** Within a day: timed workouts in time order first, then the rest in their saved order. */
export function byTime<T extends { time?: string | null; position: number }>(list: T[]): T[] {
  return list.map((w, i) => ({ w, i })).sort((a, b) => {
    const ta = a.w.time ?? "", tb = b.w.time ?? "";
    if (ta && tb) return ta.localeCompare(tb) || a.i - b.i;
    if (ta) return -1;
    if (tb) return 1;
    return a.i - b.i;
  }).map((x) => x.w);
}


export type FieldKey = "sets" | "reps" | "load" | "duration_min" | "distance_km" | "intensity";

/** Every prescription field with how it is labelled and typed. */
export const FIELD_INFO: Record<FieldKey, { label: string; ph: string; mode: "numeric" | "decimal" | "text" }> = {
  sets: { label: "Sets", ph: "", mode: "numeric" },
  reps: { label: "Reps", ph: "e.g. 8–10", mode: "text" },
  load: { label: "Load", ph: "e.g. 60 kg", mode: "text" },
  duration_min: { label: "Time (min)", ph: "e.g. 20", mode: "decimal" },
  distance_km: { label: "Distance (km)", ph: "e.g. 10", mode: "decimal" },
  intensity: { label: "Intensity", ph: "e.g. Z2", mode: "text" },
};
const ALL_FIELDS: FieldKey[] = ["sets", "reps", "load", "duration_min", "distance_km", "intensity"];

/** The fields an item shows before anything is filled in: what its measure usually needs. */
export function coreFields(measure: Measure | undefined, type: WorkoutType): FieldKey[] {
  const m = measure ?? (type === "strength" || type === "mobility" ? "reps" : "distance");
  if (m === "reps") return ["sets", "reps", "load"];
  if (m === "time") return ["sets", "duration_min", "intensity"];
  return ["distance_km", "duration_min", "intensity"];
}

/** Shown fields in a stable order: the core ones, then any that hold a value or were added by hand. */
export function shownFields(core: FieldKey[], f: ItemFields, added: FieldKey[]): FieldKey[] {
  const on = (k: FieldKey) => core.includes(k) || added.includes(k) || (f[k] !== undefined && f[k] !== null && f[k] !== "");
  return ALL_FIELDS.filter(on);
}

/** The first tap on "+" on an empty set count lands on 3, the usual prescription. */
export const stepSets = (cur: number | null | undefined, by: 1 | -1): number | null => {
  if (cur == null) return by > 0 ? 3 : null;
  const n = cur + by;
  return n < 1 ? null : Math.min(n, 99);
};
