/** Date-only helpers. Plan dates are athlete-local calendar dates ("YYYY-MM-DD"); we format
 * them in UTC so the browser's own timezone can never shift a day. */
const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);
/** Some ICU builds spell September "Sept"; every other month is three letters. */
const threeLetterMonth = (s: string) => s.replace(/\bSept\b/, "Sep");
const fmt = (iso: string, o: Intl.DateTimeFormatOptions) =>
  threeLetterMonth(utc(iso).toLocaleDateString("en-GB", { timeZone: "UTC", ...o }));

export const dayLabel = (iso: string) => fmt(iso, { weekday: "short", day: "numeric", month: "short" });
export const shortDate = (iso: string) => fmt(iso, { day: "numeric", month: "short" });

export function addDays(iso: string, n: number): string {
  const d = utc(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function mondayOf(iso: string): string {
  const d = utc(iso);
  const wd = (d.getUTCDay() + 6) % 7;
  return addDays(iso, -wd);
}

export function weekRange(monday: string): string {
  const sun = addDays(monday, 6);
  const a = utc(monday), b = utc(sun);
  const m = (d: Date) => d.toLocaleDateString("en-GB", { timeZone: "UTC", month: "short" });
  const y = b.getUTCFullYear();
  return a.getUTCMonth() === b.getUTCMonth()
    ? `${a.getUTCDate()}–${b.getUTCDate()} ${m(b)} ${y}`
    : `${a.getUTCDate()} ${m(a)} – ${b.getUTCDate()} ${m(b)} ${y}`;
}

/** "14:02" or "Tue 14:02" for timestamps (ISO with Z), shown in the athlete's timezone. */
export function stamp(isoZ: string, tz = "Europe/Amsterdam", withDay = false): string {
  const d = new Date(isoZ);
  return d.toLocaleString("en-GB", {
    timeZone: tz, hour: "2-digit", minute: "2-digit",
    ...(withDay ? { weekday: "short", day: "numeric", month: "short" } : {}),
  });
}

export function todayIso(tz = "Europe/Amsterdam"): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

/** When a chat was last active, as short as it can be: "14:02" today, "Yesterday 09:10",
 * "Mon 18:30" within the week, "28 Sep" this year, "28 Sep 2025" before. */
export function sinceStamp(isoZ: string, now: Date = new Date(), tz = "Europe/Amsterdam"): string {
  const d = new Date(isoZ);
  const day = (x: Date) => x.toLocaleDateString("en-CA", { timeZone: tz });
  const days = Math.round((utc(day(now)).getTime() - utc(day(d)).getTime()) / 86_400_000);
  const time = d.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
  if (days <= 0) return time;
  if (days === 1) return `Yesterday ${time}`;
  if (days < 7) return `${d.toLocaleDateString("en-GB", { timeZone: tz, weekday: "short" })} ${time}`;
  const sameYear = day(d).slice(0, 4) === day(now).slice(0, 4);
  return threeLetterMonth(d.toLocaleDateString("en-GB", { timeZone: tz, day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) }));
}
