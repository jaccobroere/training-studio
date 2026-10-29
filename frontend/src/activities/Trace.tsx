import { useCallback, useMemo } from "react";
import { niceStep, tickStep } from "../charts/axis";
import { EChart, type EChartsType } from "../charts/EChart";
import { axisBase, baseOption, useTokens } from "../charts/theme";
import { fmt, hms, paceStr, touchTip } from "../health/charts/parts";
import type { Stream } from "../health/types";
import { useInset } from "./inset";
import { indexAt, kmh, paceAxis, paceOf, rollingMean, type Primary } from "./model";
import { SelectableArea, type Plot } from "./SelectableArea";
import type { Win } from "./selection";

export type Panel = "speed" | "hr" | "alt" | "pow";

/** On touch screens a drag on the bare plot scrolls the page; a touch on the window drags it. */
export const coarsePointer = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
export type XMode = "time" | "dist";

const PANEL_H: Record<Panel, number> = { speed: 144, hr: 98, alt: 78, pow: 98 };
const PANEL_UNIT: Record<Panel, string> = { speed: "", hr: "bpm", alt: "m", pow: "W" };
const panelH = (p: Panel, tall: number) => PANEL_H[p] + (tall && (p === "speed" || p === "hr") ? tall : 0);
/** Grid offsets inside the plot, added to the card's inset (--av-pad): labels need ~30px on the
 * left, 12px of air on the right, and a 16px strip above each panel for its unit name — enough
 * that the name never touches the panel's own top tick label. */
const GRID = { left: 30, right: 12, top: 8, gap: 20, unit: 16 };

/** The panels every activity trace starts with: speed (or pace) and heart rate. A stable array, so
 * passing it does not rebuild the chart option on every render. */
export const SPEED_HR: Panel[] = ["speed", "hr"];

/** Stacked panels (speed or pace, HR, altitude, power) on one time or distance axis with a
 * shared cursor. Traces are smoothed over 10 s for display only. `areas` shade stretches (laps,
 * stints) in seconds. The window (`win`, seconds) is drawn across every panel in the signal colour
 * and can be dragged, resized and cleared there; it is reported through onWin. */
export function Trace({ s, primary, panels, x, areas, rests, win, threshold, onCursor, onWin, label }: {
  s: Stream; primary: Primary; panels: Panel[]; x: XMode;
  areas?: [number, number][]; rests?: [number, number][]; win?: Win | null; threshold?: number | null;
  onCursor?: (t: number | null) => void; onWin?: (w: Win | null) => void; label: string;
}) {
  const t = useTokens();
  const inset = useInset();
  // A wide card gets a little more height in the two panels that carry the reading (speed and HR),
  // so the screen is not a stack of thin bands beside an expensive chart.
  const tall = inset >= 24 ? 14 : 0;
  const left = inset + GRID.left, right = inset + GRID.right;
  const xs = useMemo(() => (x === "dist" && s.dist ? s.dist.map((d) => (d ?? 0) / 1000) : s.t.map((v) => v / 60)), [s, x]);
  const xMax = useMemo(() => { const last = xs[xs.length - 1] || 1; return x === "time" ? Math.ceil(last) : Math.ceil(last * 10) / 10; }, [xs, x]);
  const toX = useCallback((secs: number) => (x === "time" ? secs / 60 : xs[Math.max(0, indexAt(s.t, secs))] ?? 0), [s, xs, x]);
  const toT = useCallback((xv: number) => (x === "time" ? xv * 60 : s.t[Math.max(0, indexAt(xs, xv))]), [s, xs, x]);
  const shown = useMemo(() => panels.filter((k) => k === "speed" ? !!s.speed : k === "hr" ? !!s.hr?.some((v) => v != null)
    : k === "alt" ? !!s.alt?.some((v) => v != null) : !!s.pow?.some((v) => v)), [s, panels]);
  const total = shown.reduce((a, p) => a + panelH(p, tall), 0);

  const option = useMemo(() => {
    const sm = rollingMean(s.t, s.speed ?? [], 10);
    const speed = sm.map((v) => (v == null ? null : kmh(v)));
    const pace = sm.map((v) => { const p = paceOf(v); return p != null && p <= 480 ? p : null; });
    const pa = paceAxis(pace);
    let top = GRID.top;
    const grids = shown.map((p) => {
      const g = { left, right, top: top + GRID.unit, height: panelH(p, tall) - GRID.unit - GRID.gap };
      top += panelH(p, tall);
      return g;
    });
    const common = { type: "value" as const, min: 0, max: xMax, ...axisBase(t) };
    // Each panel's plotted values, smoothed once and shared by the line and its axis cap (power is
    // only smoothed when a power panel is drawn).
    const cache = new Map<Panel, (number | null)[]>();
    const valueOf = (p: Panel) => {
      let v = cache.get(p);
      if (!v) {
        v = p === "speed" ? (primary === "pace" ? pace : speed)
          : p === "hr" ? s.hr ?? [] : p === "alt" ? s.alt ?? [] : rollingMean(s.t, s.pow ?? [], 10);
        cache.set(p, v);
      }
      return v;
    };
    // ECharts labels the axis end on top of the round ticks, and most sessions end a little past the
    // last round minute, so the two labels crowd each other ("100′ 104′"). Fix the step, and label the
    // end only when it stands clear of that last tick.
    const xStep = tickStep(xMax);
    const endClear = xMax % xStep === 0 || xMax % xStep > xStep * 0.45;
    const shade = (areas ?? []).map(([a, b]) => [{ xAxis: toX(a) }, { xAxis: toX(b) }]);
    const idle = (rests ?? []).map(([a, b]) => [{ xAxis: toX(a), itemStyle: { color: t.grat2, opacity: 0.9 } }, { xAxis: toX(b) }]);
    const data = (p: Panel) => {
      const ys = valueOf(p);
      // A hole in the recording (watch paused, rest) is a break in the line, never a joined stretch.
      const out: (number | null)[][] = [];
      xs.forEach((xv, i) => { if (i && s.t[i] - s.t[i - 1] > 15) out.push([(xs[i - 1] + xv) / 2, null]); out.push([xv, ys[i] ?? null]); });
      return out;
    };
    // An inverted (pace) axis has its "end" at the bottom: name it at the start so it sits on top.
    const name = (p: Panel) => ({ name: p === "speed" ? (primary === "pace" ? "min/km" : "km/h") : PANEL_UNIT[p],
      nameLocation: (p === "speed" && primary === "pace" ? "start" : "end") as "start" | "end", nameGap: 4,
      nameTextStyle: { ...axisBase(t).nameTextStyle, align: "right" as const, padding: [0, 4, 0, 0] } });
    // A speed line that touches the top gridline reads as cut off (the smoothed peak of a fast stint
    // lands on it), so the axis keeps a tick of air above the fastest sample. The pace axis already
    // carries its own margin, and the other panels scale themselves.
    const speedTop = (() => {
      if (shown.indexOf("speed") < 0 || primary === "pace") return undefined;
      const fastest = speed.reduce<number>((a, v) => (v != null && v > a ? v : a), 0);
      if (!(fastest > 0)) return undefined;
      const step = niceStep(fastest / 4);
      return Math.ceil((fastest + step * 0.15) / step) * step;
    })();
    // One absurd sample (a power meter spitting out 12 kW for a second) would otherwise flatten the
    // whole panel onto its floor. When a single sample sits far above the rest, the axis stops at a
    // robust high and the line clips at the panel's top edge; the readout and tooltip keep the value.
    const robustTop = (p: Panel) => {
      if (p === "speed") return null;
      const v = valueOf(p).filter((x): x is number => x != null && x > 0).sort((a, b) => a - b);
      if (v.length < 8) return null;
      const near = v[Math.min(v.length - 1, Math.floor(v.length * 0.995))];
      if (!(v[v.length - 1] > near * 2.5)) return null;
      const step = niceStep(near / 3);
      return { max: Math.ceil((near * 1.08) / step) * step, step };
    };
    const yAxis = shown.map((p, i) => {
      if (p === "speed" && primary === "pace") return { ...name(p), type: "value", gridIndex: i, inverse: true, min: pa.min, max: pa.max, interval: pa.step, ...axisBase(t), axisLabel: { ...axisBase(t).axisLabel, formatter: (v: number) => paceStr(v) } };
      const cap = robustTop(p);
      return { ...name(p), type: "value", gridIndex: i, scale: p !== "speed",
        min: p === "speed" ? 0 : undefined,
        max: p === "speed" ? speedTop : cap?.max,
        interval: cap?.step,
        splitNumber: p === "speed" ? 4 : cap ? 3 : 2, ...axisBase(t),
        axisLabel: { ...axisBase(t).axisLabel, formatter: (v: number) => fmt(v, 0) } };
    });
    return {
      ...baseOption(t),
      tooltip: { ...baseOption(t).tooltip, ...touchTip(), showContent: !coarsePointer(), formatter: (items: any[]) => {
        const i = items[0]?.dataIndex ?? 0;
        const v = s.speed?.[i];
        const rows = [`${hms(s.t[i])}${s.dist?.[i] != null ? ` · ${fmt((s.dist[i] as number) / 1000, 2)} km` : ""}`];
        if (sm[i] != null) rows.push(`${fmt(kmh(sm[i]), 1)} km/h · ${paceStr(paceOf(sm[i]))} /km`);
        else if (v != null) rows.push(`${fmt(kmh(v), 1)} km/h`);
        if (s.hr?.[i] != null) rows.push(`${s.hr[i]} bpm`);
        if (s.pow?.[i] != null) rows.push(`${s.pow[i]} W`);
        if (s.alt?.[i] != null) rows.push(`${fmt(s.alt[i], 0)} m`);
        return rows.join("<br/>");
      } },
      axisPointer: { link: [{ xAxisIndex: "all" }], lineStyle: { color: t.signal, width: 1 } },
      grid: grids,
      xAxis: shown.map((_, i) => ({ ...common, gridIndex: i, interval: xStep, splitLine: { show: false },
        axisLabel: i === shown.length - 1
          ? { ...axisBase(t).axisLabel, hideOverlap: true, showMaxLabel: endClear, formatter: (v: number) => x === "time" ? `${v}′` : `${v}` }
          : { show: false } })),
      yAxis,
      toolbox: { show: false },
      series: shown.map((p, i) => ({
        name: p, type: "line", xAxisIndex: i, yAxisIndex: i, data: data(p), symbol: "none", connectNulls: false,
        // A capped axis must clip here, or an off-the-scale sample is drawn over the panel above.
        clip: true,
        // An axis-triggered highlight must never restyle the line: echarts 6 drops `stroke` in the
        // emphasis state for symbol-less lines and the whole trace disappears under the finger.
        emphasis: { disabled: true },
        lineStyle: { color: p === "speed" ? t.ink : t.ink2, width: p === "speed" ? 1.2 : 1 },
        markArea: { silent: true, itemStyle: { color: t.band }, data: [...idle, ...shade] },
        ...(p === "speed" && threshold != null ? { markLine: { silent: true, symbol: "none", label: { show: true, position: "insideStartTop", color: t.ink2, fontFamily: t.mono, fontSize: 10, formatter: `${fmt(threshold, 1)} km/h` },
          lineStyle: { color: t.ink2, type: [4, 3], width: 1 }, data: [{ yAxis: primary === "pace" ? 3600 / threshold : threshold }] } } : {}),
      })),
    };
  }, [s, xs, xMax, primary, shown, x, areas, rests, threshold, t, toX, left, right, tall]);

  const onReady = useCallback((c: EChartsType) => {
    c.off("updateAxisPointer");
    c.off("globalout");
    if (!onCursor) return;
    let raf = 0;
    c.on("updateAxisPointer", (e: any) => {
      const xi = e.axesInfo?.find((a: any) => a.axisDim === "x");
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => onCursor(xi ? toT(xi.value) : null));
    });
    c.on("globalout", () => onCursor(null));
  }, [onCursor, toT]);

  const plot: Plot = { left, right, top: GRID.top + GRID.unit, height: Math.max(0, total - GRID.unit - GRID.gap) };
  const chart = <EChart option={option} height={total + GRID.gap} onReady={onReady} label={label} />;
  if (!onWin) return chart;
  const end = s.t[s.t.length - 1];
  return (
    <SelectableArea plot={plot} win={win ?? null} total={end} onWin={onWin}
      toFrac={(secs) => toX(secs) / xMax} fromFrac={(f) => Math.min(end, Math.max(0, toT(f * xMax)))}>
      {chart}
    </SelectableArea>
  );
}
