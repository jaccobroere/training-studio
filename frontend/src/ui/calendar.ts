/** Pure helpers for the calendar picker and the 24 h time field (no DOM). */
import { addDays, mondayOf } from "./dates";

/** The 6×7 grid of ISO dates shown for a month (Monday first). */
export function monthGrid(year: number, month: number): string[] {
  const first = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const start = mondayOf(first);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export function monthTitle(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 1)).toLocaleDateString("en-GB", { timeZone: "UTC", month: "long", year: "numeric" });
}

export function shiftMonth(year: number, month: number, n: number): [number, number] {
  const m = year * 12 + month + n;
  return [Math.floor(m / 12), ((m % 12) + 12) % 12];
}

/** Same day-of-month n months later, clamped to the month's last day. */
export function addMonths(iso: string, n: number): string {
  const [y, m] = shiftMonth(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, n);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const d = Math.min(Number(iso.slice(8, 10)), last);
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "Thu 15 Oct 2026" — the one way dates read in fields (en-GB, never US). */
export function fieldDate(iso: string, withYear = true): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    timeZone: "UTC", weekday: "short", day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}),
  }).replace(/,/g, "").replace(/\bSept\b/, "Sep");
}

/** Parse what people type into a time field: "7:30", "730", "19.30", "7", "1930" → "HH:MM";
 * "" → null (no time); anything else → undefined (invalid). */
export function parseTime(raw: string): string | null | undefined {
  const s = raw.trim();
  if (!s) return null;
  let h: number, m: number;
  const sep = /^(\d{1,2})[:.h ](\d{1,2})$/.exec(s);
  if (sep) { h = Number(sep[1]); m = Number(sep[2]); }
  else if (/^\d{1,2}$/.test(s)) { h = Number(s); m = 0; }
  else if (/^\d{3,4}$/.test(s)) { h = Number(s.slice(0, -2)); m = Number(s.slice(-2)); }
  else return undefined;
  if (h > 23 || m > 59) return undefined;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
