import { addDays } from "../ui/dates";

/** ISO-8601 week number of a date. */
export function isoWeek(iso: string): number {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3); // Thursday of this week
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const diff = (d.getTime() - firstThu.getTime()) / 86_400_000;
  return 1 + Math.round((diff - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
}

const mon = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", month: "short" }).slice(0, 3);

/** "12–18 Oct" / "28 Sep – 4 Oct". */
export function rangeShort(monday: string): string {
  const sun = addDays(monday, 6);
  const a = Number(monday.slice(8)), b = Number(sun.slice(8));
  return monday.slice(5, 7) === sun.slice(5, 7) ? `${a}–${b} ${mon(sun)}` : `${a} ${mon(monday)} – ${b} ${mon(sun)}`;
}

/** Weekday index 0 (Mon) … 6 (Sun). */
export const weekday = (iso: string) => (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;
export const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const DOW1 = ["M", "T", "W", "T", "F", "S", "S"];
