/** Strength logging (DECISIONS.md #33): which items get set rows, what a new row is pre-filled
 * with, and how one item's sets go back into the activity's single ordered list. Pure, tested. */
import type { Item, LoggedSet, Measure } from "../api/types";

export type SetMeasure = "reps" | "secs";

/** Reps for counted sets, seconds for held ones (planks), null for continuous work (a 10 km run,
 * a 12-minute block) which keeps the plain done/skipped tick. */
export function measureOf(it: Item, exercise?: Measure): SetMeasure | null {
  if (exercise === "distance" || it.distance_km != null) return null;
  if (it.reps) return "reps";
  if (it.duration_min != null) return it.sets ? "secs" : null;
  if (it.sets) return exercise === "time" ? "secs" : "reps";
  return null;
}

/** "5–8/leg" → 5, "8" → 8, "AMRAP" → undefined: the low end, the part you must reach. */
export function repsTarget(reps?: string | null): number | undefined {
  const m = reps?.match(/^\s*(\d+)/);
  return m ? Number(m[1]) : undefined;
}

/** "80 kg", "22.5kg" → a number; "BW", "BW+10 kg", "RPE 8" → undefined (typed in the log). */
export function kgOf(load?: string | null): number | undefined {
  const m = load?.match(/^\s*(\d+(?:[.,]\d+)?)\s*kg\s*$/i);
  return m ? Number(m[1].replace(",", ".")) : undefined;
}

export interface Row { reps?: number; kg?: number; secs?: number }

/** The values a set row starts with: the same set of the last session if there was one, else
 * the plan's target. */
export function prefill(it: Item, measure: SetMeasure, n: number, last?: Row[]): Row {
  const prev = last?.[n] ?? last?.[last.length - 1];
  if (prev) return measure === "reps" ? { reps: prev.reps, kg: prev.kg } : { secs: prev.secs, kg: prev.kg };
  if (measure === "secs") return { secs: it.duration_min != null ? Math.round(it.duration_min * 60) : undefined, kg: kgOf(it.load) };
  return { reps: repsTarget(it.reps), kg: kgOf(it.load) };
}

/** How many rows an item starts with: the plan's sets (at least one). */
export const plannedCount = (it: Item) => Math.max(1, it.sets ?? 1);

/** A row as stored: only the values that are set, and a count it must have. */
export function toSet(it: Item, measure: SetMeasure, r: Row): LoggedSet | null {
  const count = measure === "reps" ? r.reps : r.secs;
  if (count == null || !Number.isFinite(count)) return null;
  const s: LoggedSet = { exercise_id: it.exercise_id };
  if (it.id) s.item_id = it.id;
  if (measure === "reps") s.reps = Math.round(count);
  else s.secs = Math.round(count);
  if (r.kg != null && Number.isFinite(r.kg) && r.kg > 0) s.kg = Math.round(r.kg * 100) / 100;
  return s;
}

/** Put one item's sets back into the activity's list, kept in the workout's item order; sets of
 * exercises outside the plan stay at the end, as they were. */
export function replaceItemSets(all: LoggedSet[], items: Item[], itemId: string, next: LoggedSet[]): LoggedSet[] {
  const ids = new Set(items.map((i) => i.id));
  const byItem = (id: string) => (id === itemId ? next : all.filter((s) => s.item_id === id));
  return [...items.flatMap((i) => (i.id ? byItem(i.id) : [])), ...all.filter((s) => !s.item_id || !ids.has(s.item_id))];
}

/** A session's sets in one line: "3 × 8 · 60 kg" when all alike, "5, 5, 4 · 82.5 kg" when only
 * the count varies, else each set ("8 × 60 kg, 6 × 65 kg", "5 bw, 8 × 26 kg"). */
export function setsText(sets: Row[]): string {
  if (!sets.length) return "";
  const count = (s: Row) => (s.reps != null ? String(s.reps) : `${s.secs} s`);
  const kg = (s: Row) => (s.kg ? ` · ${s.kg} kg` : "");
  if (sets.every((s) => s.kg === sets[0].kg)) {
    const same = sets.every((s) => s.reps === sets[0].reps && s.secs === sets[0].secs);
    return same ? `${sets.length} × ${count(sets[0])}${kg(sets[0])}` : `${sets.map(count).join(", ")}${kg(sets[0])}`;
  }
  // Mixed loads: every set says its own, bodyweight included, so none borrows a neighbour's kilos.
  return sets.map((s) => `${count(s)}${s.kg ? ` × ${s.kg} kg` : " bw"}`).join(", ");
}

/** Exercises with logged sets that answer no planned item, in the order they were first logged:
 * the ones added while logging, or everything on an unplanned activity. */
export function extraIds(all: LoggedSet[], items: Item[]): string[] {
  const planned = new Set(items.map((i) => i.id));
  return [...new Set(all.filter((s) => !s.item_id || !planned.has(s.item_id)).map((s) => s.exercise_id))];
}

/** An added exercise as an item with no plan, so it gets set rows like any other. */
export const extraItem = (id: string, name: string): Item => ({ exercise_id: id, name });

/** Reps for most exercises, seconds for held ones; an added exercise has no plan to say. */
export const extraMeasure = (exercise?: Measure): SetMeasure => (exercise === "time" ? "secs" : "reps");

/** Put one added exercise's sets back into the list: every other set stays where it was, and
 * this exercise's sets sit with the added ones, in `order`. */
export function replaceExtraSets(all: LoggedSet[], items: Item[], exerciseId: string, next: LoggedSet[], order: string[]): LoggedSet[] {
  const planned = new Set(items.map((i) => i.id));
  const isExtra = (s: LoggedSet) => !s.item_id || !planned.has(s.item_id);
  const kept = all.filter((s) => !isExtra(s));
  const extras = all.filter(isExtra);
  return [...kept, ...order.flatMap((id) => (id === exerciseId ? next : extras.filter((s) => s.exercise_id === id)))];
}
