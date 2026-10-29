/** The list's filters as they live in the URL (`?sport=skate&range=12w&q=ice`, or `from`/`to`
 * for a custom period). Pure, tested in filter.test.ts. */
import { sportLabel } from "../ui/sport";
import type { HealthActivity } from "../health/types";
import type { Period } from "./api";

export const RANGES = [
  { key: "4w", label: "4W", days: 28, words: "last 4 weeks" },
  { key: "12w", label: "12W", days: 84, words: "last 12 weeks" },
  { key: "1y", label: "1Y", days: 365, words: "last year" },
  { key: "all", label: "All", days: 3660, words: "all time" },
] as const;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export interface Filters { sport: string; range: string; from: string | null; to: string | null; q: string }

export function readFilters(p: URLSearchParams, fallbackRange: string): Filters {
  const from = p.get("from"), to = p.get("to");
  const custom = from && to && ISO.test(from) && ISO.test(to) && from <= to;
  const range = custom ? "custom" : RANGES.some((r) => r.key === p.get("range")) ? p.get("range")! : fallbackRange;
  return { sport: p.get("sport") ?? "", range, from: custom ? from : null, to: custom ? to : null, q: p.get("q") ?? "" };
}

/** What to ask the server for, and how to name it in a sentence. */
export function periodOf(f: Filters): { period: Period; days: number; words: string } {
  if (f.from && f.to) return { period: { start: f.from, end: f.to }, days: 365, words: "last year" };
  const r = RANGES.find((x) => x.key === f.range) ?? RANGES[1];
  return { period: { days: r.days }, days: r.days, words: r.words };
}

/** The search box: every word must appear in the name, the type or the date (as "2026-10-15"). */
export function searchActivities(list: HealthActivity[], q: string): HealthActivity[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((a) => {
    const hay = `${a.name ?? ""} ${sportLabel(a.type ?? a.sport)} ${a.local_date}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The first recording with a stream: what opens by itself on a wide screen. */
export const firstWithStream = (list: HealthActivity[]) => list.find((a) => a.has_stream) ?? null;

/** The query string to keep when moving between activities or back to the list (filters, not the view). */
export function filterParams(p: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const k of ["sport", "range", "from", "to", "q"]) { const v = p.get(k); if (v) out.set(k, v); }
  return out;
}

/** Where an old Health link goes: `/stats/activities?activity=<id>&tab=laps` → `/activities/<id>?tab=laps`. */
export function legacyActivityPath(search: string): string {
  const p = new URLSearchParams(search);
  const id = p.get("activity");
  p.delete("activity");
  return `/activities${id ? `/${encodeURIComponent(id)}` : ""}${p.size ? `?${p}` : ""}`;
}
