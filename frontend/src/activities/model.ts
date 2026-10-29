/** Pure helpers for the activity view: what each sport reads first, unit conversions, the
 * route projection into a viewBox, cursor lookups. No React here (tested in model.test.ts). */

import type { Lap } from "../health/types";

export type Primary = "pace" | "speed";
export type LapAxis = "time" | "speed";

export interface SportView {
  /** The trace's main axis: runners read pace, riders and skaters speed. */
  primary: Primary;
  /** Show pace beside speed wherever speed is shown (skaters think in km/h but compare min/km too). */
  both: boolean;
  tabs: TabKey[];
  laps: string[]; // lap sources the switch offers, in order (the first is the default)
  /** The laps chart's y-axis when it must not follow the lap source. Skating always reads speed
   * (km/h), so switching between 400 m, gate, device and stint laps cannot flip the axis between
   * lap time and speed. Other sports keep the server's comparison for the chosen source. */
  lapsAxis: LapAxis | null;
}

export type TabKey = "overview" | "laps" | "stints" | "efforts";
export const TAB_LABEL: Record<TabKey, string> = { overview: "Overview", laps: "Laps", stints: "Stints", efforts: "Efforts" };

export function sportView(sport: string): SportView {
  if (sport === "skate") return { primary: "speed", both: true, tabs: ["overview", "laps", "stints", "efforts"], laps: ["d400", "gate", "device", "d200", "d1000", "stints"], lapsAxis: "speed" };
  if (sport === "ride") return { primary: "speed", both: false, tabs: ["overview", "laps", "efforts"], laps: ["d5000", "d1000", "device"], lapsAxis: null };
  if (sport === "run" || sport === "walk") return { primary: "pace", both: false, tabs: ["overview", "laps", "efforts"], laps: ["d1000", "d400", "device"], lapsAxis: null };
  return { primary: "speed", both: false, tabs: ["overview", "laps"], laps: ["d1000", "device"], lapsAxis: null };
}

/** The laps chart's y-axis: the sport's fixed metric when it has one, else the server's
 * comparison for that lap source (time for equal-length laps, speed for device and stint laps). */
export const lapAxis = (v: SportView, compare: LapAxis): LapAxis => v.lapsAxis ?? compare;

export const LAP_LABEL: Record<string, string> = { d200: "200 m", d400: "400 m", d1000: "1 km", d5000: "5 km", gate: "Gate", device: "Device", stints: "Stints" };

export const kmh = (ms: number | null | undefined) => (ms == null ? null : ms * 3.6);
/** s per km from m/s; null when standing (below 0.5 m/s a pace is meaningless). */
export const paceOf = (ms: number | null | undefined) => (ms == null || ms < 0.5 ? null : 1000 / ms);

/** "1:23.4" for lap times under an hour, tenths kept (lap-to-lap differences are tenths). */
export function lapTime(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return "—";
  const tenths = Math.round(s * 10) / 10;
  if (tenths >= 3600) {
    const total = Math.round(tenths);
    const h = Math.floor(total / 3600), mm = Math.floor((total % 3600) / 60), ss = total % 60;
    return `${h}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }
  const m = Math.floor(tenths / 60);
  const r = +(tenths - m * 60).toFixed(1);
  const txt = r.toFixed(1).padStart(4, "0");
  return m ? `${m}:${txt}` : `${r.toFixed(1)}`;
}

export function signed(v: number | null | undefined, digits = 1, unit = ""): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (Math.abs(v) < 0.5 * 10 ** -digits) return `0${unit}`;
  return `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}${unit}`;
}

export function windowLabel(secs: number): string {
  return secs < 60 ? `${secs} s` : secs < 3600 ? `${secs / 60} min` : `${secs / 3600} h`;
}

export function distLabel(m: number): string {
  if (m === 21097.5) return "Half";
  return m < 1000 ? `${m} m` : `${+(m / 1000).toFixed(2)} km`;
}

/** Index of the last sample at or before t (binary search over ascending times). */
export function indexAt(ts: number[], t: number): number {
  let lo = 0, hi = ts.length - 1;
  if (hi < 0) return -1;
  if (t <= ts[0]) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ts[mid] <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** A gap in the recording longer than this is a pause: no positions, never interpolated. */
const PAUSE_S = 60;

/** Route points [x m, y m, t s] → SVG coordinates in a w×h box (north up, equal scale,
 * `pad` px margin). Returns the mapper and the path; a pause > 60 s starts a new subpath so
 * the line never joins across a gap, and the join is reported in `gaps` (screen coordinates +
 * the seconds that were not recorded) so the drawing can mark it as a pause. */
export function routeGeometry(points: [number, number, number][], bbox: [number, number, number, number], w: number, h: number, pad = 10) {
  const [x0, y0, x1, y1] = bbox;
  const sx = (w - 2 * pad) / Math.max(1, x1 - x0), sy = (h - 2 * pad) / Math.max(1, y1 - y0);
  const k = Math.min(sx, sy);
  const ox = pad + ((w - 2 * pad) - (x1 - x0) * k) / 2, oy = pad + ((h - 2 * pad) - (y1 - y0) * k) / 2;
  const map = (x: number, y: number): [number, number] => [ox + (x - x0) * k, h - (oy + (y - y0) * k)];
  let d = "";
  let lastT: number | null = null;
  let prev: [number, number] | null = null;
  const gaps: { ax: number; ay: number; bx: number; by: number; secs: number }[] = [];
  for (const [x, y, t] of points) {
    const [px, py] = map(x, y);
    const breakHere = lastT == null || t - lastT > PAUSE_S;
    if (breakHere && prev && lastT != null) gaps.push({ ax: prev[0], ay: prev[1], bx: px, by: py, secs: t - lastT });
    d += `${breakHere ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`;
    lastT = t;
    prev = [px, py];
  }
  return { map, d, gaps, scale: k };
}

/** "Recording pause · 2 min", from the seconds that were not recorded. */
export function pauseText(secs: number): string {
  const m = Math.max(1, Math.round(secs / 60));
  return m < 60 ? `Recording pause · ${m} min` : `Recording pause · ${+(m / 60).toFixed(1)} h`;
}

/** Contiguous stretches of the route, each with the pause that precedes it (null for the first). */
export function routeSegments(points: [number, number, number][], gapS = PAUSE_S): { i0: number; i1: number; gapBefore: number | null }[] {
  if (!points.length) return [];
  const out: { i0: number; i1: number; gapBefore: number | null }[] = [{ i0: 0, i1: 0, gapBefore: null }];
  for (let i = 1; i < points.length; i++) {
    const secs = points[i][2] - points[i - 1][2];
    if (secs > gapS) out.push({ i0: i, i1: i, gapBefore: secs });
    else out[out.length - 1].i1 = i;
  }
  return out;
}

/** The absolute coordinate nearest in time to t: `ll` is 1:1 with the route `points`. */
export function routeLlAt(points: [number, number, number][], ll: [number, number][], t: number): [number, number] | null {
  if (!points.length || points.length !== ll.length) return null;
  const i = indexAt(points.map((p) => p[2]), t);
  const a = points[i], b = points[Math.min(points.length - 1, i + 1)];
  return Math.abs(b[2] - t) < Math.abs(a[2] - t) ? ll[Math.min(ll.length - 1, i + 1)] : ll[i];
}

/** Absolute degrees for a metre offset around the route centre (x east, y north) — the same flat
 * projection the server used for the trace and the gate. */
export function latLonAt(x: number, y: number, center: [number, number]): [number, number] {
  const ky = (Math.PI / 180) * 6_371_000;
  const kx = Math.cos((center[0] * Math.PI) / 180) * ky;
  return [center[0] + y / ky, center[1] + x / kx];
}

/** A round scale-bar length (m) that is at most `maxPx` long at `scale` px per metre. */
export function scaleBar(scale: number, maxPx = 90): number {
  const raw = maxPx / Math.max(scale, 1e-6);
  const steps = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
  return [...steps].reverse().find((s) => s <= raw) ?? 10;
}

/** The route point nearest in time to t (for the shared cursor). */
export function routeAt(points: [number, number, number][], t: number): [number, number] | null {
  if (!points.length) return null;
  const i = indexAt(points.map((p) => p[2]), t);
  const a = points[i], b = points[Math.min(points.length - 1, i + 1)];
  return Math.abs(b[2] - t) < Math.abs(a[2] - t) ? [b[0], b[1]] : [a[0], a[1]];
}

/** Rolling mean over the last `secs` seconds (time-based, so irregular sampling is fine).
 * Display only: statistics always use raw samples. */
export function rollingMean(ts: number[], vs: (number | null | undefined)[], secs: number): (number | null)[] {
  const out: (number | null)[] = [];
  let j = 0, sum = 0, n = 0;
  for (let i = 0; i < ts.length; i++) {
    const v = vs[i];
    if (v != null) { sum += v; n++; }
    while (ts[i] - ts[j] > secs) {
      const u = vs[j];
      if (u != null) { sum -= u; n--; }
      j++;
    }
    out.push(n ? sum / n : null);
  }
  return out;
}

/** "nice" axis bounds for pace (s/km) from the 1st–99th percentile, in whole steps. */
export function paceAxis(paces: (number | null)[], slowest = 480): { min: number; max: number; step: number } {
  const pv = paces.filter((v): v is number => v != null && v <= slowest).sort((a, b) => a - b);
  if (!pv.length) return { min: 180, max: slowest, step: 60 };
  const q = (f: number) => pv[Math.min(pv.length - 1, Math.max(0, Math.floor(f * pv.length)))];
  const lo = q(0.01) - 10, hi = Math.min(slowest, q(0.99) + 10);
  const step = [5, 10, 15, 30, 60].find((st) => (hi - lo) / st <= 5) ?? 60;
  return { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step, step };
}

/** The rests (≥ 60 s) as [from, to] seconds, from the blocks the server found. */
export const restsOf = (st: { lapsets: { blocks: { start_s: number; rest_before_s: number }[] } }): [number, number][] =>
  st.lapsets.blocks.filter((b) => b.rest_before_s >= 60).map((b) => [b.start_s - b.rest_before_s, b.start_s]);

/** Fixed decimals, trailing zeros kept (18.0 km/h, not 18): columns of numbers line up. */
export const fixed = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));

/** The lap readout's Best cell: value, unit (behind the value) and note (below). A time
 * carries no unit, so the lap number is a note; a speed carries km/h right behind the value. */
export function bestLapCell(compare: "time" | "speed", best: Pick<Lap, "n" | "time_s" | "speed_kmh"> | undefined): { value: string; unit: string; note: string } {
  if (!best) return { value: "—", unit: "", note: "" };
  return compare === "time"
    ? { value: lapTime(best.time_s), unit: "", note: `lap ${best.n}` }
    : { value: fixed(best.speed_kmh), unit: "km/h", note: `lap ${best.n}` };
}

/** Seconds slower than a reference: tenths under a minute, m:ss.s above ("+4:01.5"). */
export const deltaTime = (s: number | null | undefined) =>
  s == null || !Number.isFinite(s) ? "—" : Math.abs(s) >= 60 ? `${s > 0 ? "+" : "−"}${lapTime(Math.abs(s))}` : signed(s, 1);

/** Mean of numbers, null when empty. */
export const mean = (xs: (number | null | undefined)[]) => {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/** Median of numbers, null when empty. */
export function median(xs: (number | null | undefined)[]): number | null {
  const v = xs.filter((x): x is number => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** A quantile with linear interpolation (the axis cap uses the 9th decile). */
export function quantile(xs: number[], q: number): number {
  const v = [...xs].sort((a, b) => a - b);
  if (!v.length) return NaN;
  const at = (v.length - 1) * Math.min(1, Math.max(0, q));
  const i = Math.floor(at), f = at - i;
  return i + 1 < v.length ? v[i] + (v[i + 1] - v[i]) * f : v[i];
}

/** Second half minus first half of a series (the middle value of an odd count belongs to neither):
 * negative for lap times means the second half was faster. Null under four values. */
export function halfSplit(xs: number[]): number | null {
  if (xs.length < 4) return null;
  const h = xs.length >> 1;
  return mean(xs.slice(xs.length - h))! - mean(xs.slice(0, h))!;
}

/** The line that says where an activity's type came from, or null when nothing was overridden:
 * "Set by you · Garmin says Other". */
export function typeOrigin(a: { type_override?: string | null; device_type?: string | null }, label: (t: string) => string): string | null {
  return a.type_override ? `Set by you${a.device_type ? ` · Garmin says ${label(a.device_type)}` : ""}` : null;
}
