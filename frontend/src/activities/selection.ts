/** The window: one stretch of an activity (seconds on the stream's clock) the reader has picked
 * on a trace, a lap, a stint or a best effort. Pure helpers (tested in selection.test.ts): clamping,
 * moving, nudging an edge, the URL form, and the numbers inside the window. */
import type { Stream } from "../health/types";
import { indexAt } from "./model";

export type Win = [number, number];

/** Shorter than this is a click, not a window. */
export const MIN_WINDOW_S = 5;

/** Order the two ends, clamp them to the recording and refuse a window that is too short. */
export function makeWindow(a: number, b: number, total: number): Win | null {
  const lo = Math.max(0, Math.min(a, b)), hi = Math.min(total, Math.max(a, b));
  return hi - lo >= MIN_WINDOW_S ? [lo, hi] : null;
}

/** Slide the whole window by `d` seconds; it keeps its length and stops at the ends. */
export function moveWindow([a, b]: Win, d: number, total: number): Win {
  const len = b - a;
  const lo = Math.min(Math.max(0, a + d), Math.max(0, total - len));
  return [lo, lo + len];
}

/** Move one edge by `d` seconds; the window never gets shorter than MIN_WINDOW_S or leaves the recording. */
export function nudgeEdge([a, b]: Win, edge: 0 | 1, d: number, total: number): Win {
  if (edge === 0) return [Math.min(Math.max(0, a + d), b - MIN_WINDOW_S), b];
  return [a, Math.max(Math.min(total, b + d), a + MIN_WINDOW_S)];
}

/** Whether two windows are the same stretch (a lap row against the window on the trace). */
export const sameWindow = (x: Win | null, y: Win | null, tol = 1) =>
  !!x && !!y && Math.abs(x[0] - y[0]) <= tol && Math.abs(x[1] - y[1]) <= tol;

/** `?win=120-380` (whole seconds); anything else is no window. */
export function parseWindow(raw: string | null, total: number): Win | null {
  const m = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(raw ?? "");
  return m ? makeWindow(Number(m[1]), Number(m[2]), total) : null;
}
export const formatWindow = ([a, b]: Win) => `${Math.round(a)}-${Math.round(b)}`;

export interface WindowStats {
  a: number; b: number; dt: number; dist: number | null; ms: number | null;
  hr: number | null; hrMax: number | null; pow: number | null; cad: number | null;
}

/** Window numbers from raw samples (never the smoothed trace): speed = distance ÷ time over the
 * window; HR, power and cadence are time-weighted, and a recording pause counts for nothing. */
export function windowStats(s: Stream, a: number, b: number): WindowStats | null {
  const i0 = indexAt(s.t, a), i1 = indexAt(s.t, b);
  if (i1 - i0 < 1) return null;
  const dt = s.t[i1] - s.t[i0];
  const d0 = s.dist?.[i0], d1 = s.dist?.[i1];
  const dist = d0 != null && d1 != null ? d1 - d0 : null;
  const avg = (col: (number | null)[] | undefined) => {
    let sum = 0, span = 0;
    for (let k = i0 + 1; k <= i1; k++) {
      const w = s.t[k] - s.t[k - 1];
      const x = col?.[k];
      if (w > 15 || x == null) continue; // a pause, or no sample
      sum += x * w; span += w;
    }
    return span ? sum / span : null;
  };
  const hrs = (s.hr ?? []).slice(i0 + 1, i1 + 1).filter((x): x is number => x != null);
  return { a: s.t[i0], b: s.t[i1], dt, dist, ms: dist && dt ? dist / dt : null,
    hr: avg(s.hr), hrMax: hrs.length ? Math.max(...hrs) : null, pow: avg(s.pow), cad: avg(s.cad) };
}
