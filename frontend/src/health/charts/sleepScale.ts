/** Clock hours relative to the wake-up day's midnight (23:15 → -0.75, 08:30 → 8.5). */
export const clock = (h: number | null) => {
  if (h == null) return "—";
  // Round to whole minutes first, so 01:59.8 reads 02:00, not 01:60 or 01:00.
  const m = ((Math.round(h * 60) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** The usual window, 20:00 → 10:00; it widens in 2-hour steps to fit late nights and long lie-ins,
 * but never past one day (noon before → 18:00). The earliest and latest 2% of nights do not widen
 * it, so one odd recording in a year cannot flatten the rest; anything outside is clipped. */
const SLEEP_MIN = -4, SLEEP_MAX = 10, SLEEP_FLOOR = -12, SLEEP_CEIL = 18;

export interface SleepScale { min: number; max: number; interval: number }

export function sleepRange(nights: { bed: number | null; wake: number | null }[]): SleepScale {
  const ok = (v: number | null): v is number => v != null && Number.isFinite(v);
  const beds = nights.map((n) => n.bed).filter(ok).sort((a, b) => a - b);
  const wakes = nights.map((n) => n.wake).filter(ok).sort((a, b) => b - a);
  const trim = Math.floor(beds.length * 0.02);
  const lo = Math.min(SLEEP_MIN, beds[trim] ?? SLEEP_MIN), hi = Math.max(SLEEP_MAX, wakes[trim] ?? SLEEP_MAX);
  const min = Math.max(SLEEP_FLOOR, Math.floor(lo / 2) * 2), max = Math.min(SLEEP_CEIL, Math.ceil(hi / 2) * 2);
  return { min, max, interval: max - min > 16 ? 4 : 2 };
}

/** Show every nth day label so about `most` fit; ECharts' interval counts the labels skipped. */
export const labelEvery = (days: number, most: number) => Math.max(0, Math.ceil(days / most) - 1);
