import type { Activity, Item } from "../api/types";
import { prescription } from "./quick";

/** One item as row text: "Back squat 3×5 80 kg". */
function itemText(it: Item): string {
  const rx = prescription(it).replace(/ · /g, " ");
  return rx ? `${it.name ?? it.exercise_id} ${rx}` : (it.name ?? it.exercise_id);
}

/** The items line under a workout title: up to `max` items joined by " · ", then "+n". */
export function itemsLine(items: Item[], max = 3): string {
  if (!items.length) return "";
  const head = items.slice(0, max).map(itemText).join(" · ");
  return items.length > max ? `${head} · +${items.length - max}` : head;
}

/** "52:10" or "1:58:20". */
export function clock(min: number): string {
  const s = Math.round(min * 60);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0"), ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function pace(km: number | null, min: number | null): string | null {
  if (!km || !min) return null;
  const total = Math.round((min * 60) / km);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}/km`;
}

/** Actual values of an activity: "10.4 km · 52:10 · 5:01/km · 142 bpm · RPE 6", or "" if none. */
export function actualValues(a: Activity): string {
  const parts: string[] = [];
  if (a.distance_km) parts.push(`${Math.round(a.distance_km * 100) / 100} km`);
  if (a.duration_min) parts.push(clock(a.duration_min));
  const p = a.type === "run" || a.type === "walk" ? pace(a.distance_km, a.duration_min) : null;
  if (p) parts.push(p);
  if (a.avg_hr) parts.push(`${Math.round(a.avg_hr)} bpm`);
  if (a.sets?.length) parts.push(a.sets.length === 1 ? "1 set" : `${a.sets.length} sets`);
  if (a.rpe != null) parts.push(`RPE ${a.rpe}`);
  return parts.join(" · ");
}

export const sourceLabel = (a: Activity) => (a.source === "manual" ? "Manual" : a.source === "demo" ? "Demo" : "Garmin");
