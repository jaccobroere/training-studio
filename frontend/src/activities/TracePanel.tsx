import { useMemo, useState, type ReactNode } from "react";
import { useCoarse } from "../app/useMedia";
import { Readout, fmt, hms, paceStr, type ReadoutItem } from "../health/charts/parts";
import type { ActivityStats, Stream } from "../health/types";
import { Note, Seg } from "./controls";
import { fixed, kmh, paceOf, type SportView } from "./model";
import { MIN_WINDOW_S, makeWindow, moveWindow, windowStats, type Win } from "./selection";
import { Trace, type Panel, type XMode } from "./Trace";

const swatch = (kind: "line" | "dash" | "band" | "sel") => (
  <svg width="16" height="10" aria-hidden="true">
    {kind === "line" && <line x1="0" y1="5" x2="16" y2="5" stroke="var(--s-ink)" strokeWidth="1.4" />}
    {kind === "dash" && <line x1="0" y1="5" x2="16" y2="5" stroke="var(--s-ink-2)" strokeDasharray="4 3" />}
    {kind === "band" && <rect width="16" height="10" fill="var(--s-band)" />}
    {kind === "sel" && <rect x="1" y="1" width="14" height="8" fill="none" stroke="var(--signal)" strokeWidth="1.5" />}
  </svg>
);

/** One trace card shared by every tab: the chart with its window (a stretch you pick to measure),
 * a labelled readout (the whole session, the point under the cursor, or the window — always the same
 * six cells, so touching the chart never moves it), a legend that says what each mark means and a
 * "how to read this" line. `shading` names what the grey bands are (laps, stints) when there are any. */
export function TracePanel({ s, v, totals, panels, areas, shading, rests, threshold, win, setWin, cursor, setCursor, help, title }: {
  s: Stream; v: SportView; totals?: ActivityStats["totals"]; panels: Panel[]; areas?: [number, number][]; shading?: string; rests: [number, number][];
  threshold?: number | null; win: Win | null; setWin: (w: Win | null) => void; cursor: number | null; setCursor: (t: number | null) => void;
  help: ReactNode; title: string;
}) {
  const [x, setX] = useState<XMode>("time");
  const touch = useCoarse();
  const end = s.t[s.t.length - 1];
  const pace = v.primary === "pace";
  // With nothing picked the readout is the whole session, from the same moving-time figures as the
  // summary above the tabs (not distance ÷ elapsed, which would disagree with it).
  const session = useMemo(() => (totals ? {
    a: 0, b: totals.elapsed_s, dt: totals.moving_s,
    dist: totals.distance_m, ms: totals.avg_moving.speed_kmh != null ? totals.avg_moving.speed_kmh / 3.6 : null,
    pace: totals.avg_moving.pace_s_km,
    hr: totals.avg_hr, hrMax: totals.max_hr, pow: totals.avg_power, cad: totals.avg_cad,
    moving: totals.moving_s, elapsed: totals.elapsed_s, stopped: totals.stopped_s,
  } : null), [totals]);
  const w = useMemo(() => (win ? windowStats(s, win[0], win[1])
    : cursor != null ? windowStats(s, cursor - 5, cursor + 5)
    : session ?? windowStats(s, 0, end)), [s, win, cursor, end, session]);
  // The Select key (the only way to pick a window with a finger or the keyboard) drops one in at the cursor.
  const select = () => {
    const span = Math.max(30, end / 10), mid = cursor ?? end / 2;
    const fresh = makeWindow(mid - span / 2, mid + span / 2, end);
    if (fresh) setWin(moveWindow(fresh, 0, end));
  };
  const ms = w?.ms;
  const whole = !win && cursor == null;
  const paceSec = whole && session ? session.pace : paceOf(ms);
  // The stream's cadence is per foot for runs (the backend doubles it for the totals); a ride's is rpm.
  const cadUnit = totals?.cad_unit ?? "spm";
  const cadScale = cadUnit === "spm" ? 2 : 1;
  const items: ReadoutItem[] = w ? [
    [win ? "Window" : cursor != null ? "At" : "Session",
      win ? `${hms(w.a)}–${hms(w.b)}` : hms(whole && session ? session.moving : cursor ?? end),
      "",
      win ? hms(w.dt) : session && whole && session.stopped >= 60 ? `of ${hms(session.elapsed)}` : "",
      !!win],
    ["Distance", fmt(w.dist != null ? w.dist / 1000 : null, 2), "km"],
    [pace ? "Pace" : "Speed", pace ? paceStr(paceSec) : fixed(kmh(ms)), pace ? "/km" : "km/h"],
    [pace ? "Speed" : "Pace", pace ? fixed(kmh(ms)) : paceStr(paceSec), pace ? "km/h" : "/km"],
    ["Heart rate", fmt(w.hr, 0), "bpm", w.hrMax ? `max ${fmt(w.hrMax, 0)}` : ""],
    w.pow != null ? ["Power", fmt(w.pow, 0), "W"]
      : w.cad != null ? ["Cadence", fmt(whole && session ? session.cad : w.cad * cadScale, 0), cadUnit]
      : whole && session ? (session.stopped >= 1 ? ["Stopped", hms(session.stopped), ""] : ["Elapsed", hms(session.elapsed), ""])
      : ["Duration", hms(w.dt), ""],
  ] : [["Reading", "", "", touch ? "tap the trace for a moment, or press Select range to measure a stretch" : "hover the trace for a moment, or drag across it to measure a range"]];
  return (
    <div className="screen chart-screen">
      <div className="av-ctl">
        <span className="silk">{title}</span>
        <span className="fill" />
        {win ? <button type="button" className="key flat" onClick={() => setWin(null)}>Clear window</button>
          : <button type="button" className="key flat" onClick={select}>Select range</button>}
        <Seg label="Horizontal axis" value={x} onChange={(k) => setX(k as XMode)} options={[{ key: "time", label: "Time" }, { key: "dist", label: "Distance" }]} />
      </div>
      <Readout compact items={items} />
      <Trace s={s} primary={v.primary} panels={panels} x={x} areas={areas} rests={rests} win={win} threshold={threshold}
        onCursor={setCursor} onWin={setWin} label={`${title} over ${hms(end)}${win ? `; window ${hms(win[0])} to ${hms(win[1])}` : ""}`} />
      <div className="legend" aria-hidden="true">
        <span className="lg-i">{swatch("line")}<span>{pace ? "pace, min/km" : "speed, km/h"}<small>10 s smoothing</small></span></span>
        {panels.includes("hr") && <span className="lg-i">{swatch("line")}heart rate, bpm</span>}
        {rests.length > 0 && <span className="lg-i">{swatch("band")}<span>rest<small>stopped 1 min or more</small></span></span>}
        {shading && <span className="lg-i">{swatch("band")}{shading}</span>}
        {threshold != null && <span className="lg-i">{swatch("dash")}{fixed(threshold, 1)} km/h threshold</span>}
        <span className="lg-i">{swatch("sel")}your window</span>
      </div>
      <Note title="How to read this" more={<span>
        The top panel is {pace ? "pace (faster is higher)" : "speed"}, the next heart rate{panels.includes("pow") ? ", then power" : ""}{panels.includes("alt") ? " and elevation" : ""}; all share one {x === "time" ? "time (minutes)" : "distance (km)"} axis, and the vertical orange line follows your pointer.
        {touch ? "To measure a stretch, press Select range, then drag the window or its grips." : "To measure a stretch, drag across the chart (or press Select range); drag the window to move it, its handles to resize, arrow keys to nudge a handle by 1 s (Shift 10 s), Esc or Clear to put it away."}
        The numbers above then describe only the window, from the raw samples. A lap, stint or effort you pick below becomes the window too. Windows under {MIN_WINDOW_S} s are ignored.
      </span>}>{touch ? "Tap the trace to read a point" : "Hover the trace to read a point"}; drag the window's grips to measure a stretch. {help}</Note>
    </div>
  );
}
