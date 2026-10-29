/** Chart spec v2 (backend/analysis/CHARTS.md) → ECharts option. Pure: no DOM, no React, so the
 * mapping is unit-tested per kind. Specs are data only; every string is rendered as plain text. */
import type { Tok } from "./theme";
import { DECALS, axisBase, baseOption } from "./theme";

type XType = "time" | "category" | "value";
type SeriesKind = "line" | "area" | "bar" | "scatter" | "band" | "histogram";
type XVal = string | number;

interface SeriesV2 {
  name: string;
  kind: SeriesKind;
  axis?: 0 | 1;
  /** line/area/bar: [x, y]; scatter: [x, y, label?]; band: [x, lower, upper]; histogram: [start, end, count]. */
  data: (XVal | number | null)[][];
  style?: "solid" | "dashed" | "dotted";
  muted?: boolean;
  stack?: string;
}

type RefV2 =
  | { axis: "y"; value: number; label?: string; y_axis?: 0 | 1 }
  | { axis: "y"; from: number; to: number; label?: string; y_axis?: 0 | 1 }
  | { axis: "x"; value: XVal; label?: string }
  | { axis: "x"; from: XVal; to: XVal; label?: string };

type NoteV2 =
  | { x: XVal; y: number; y_axis?: 0 | 1; label: string }
  | { x: XVal; label: string }
  | { x: [XVal, XVal]; label: string };

export interface ChartV2 {
  v: 2;
  kind: string;
  title: string;
  subtitle?: string;
  x: { type: XType; label?: string; unit?: string };
  y: { label?: string; unit?: string; min?: number; max?: number }[];
  series: SeriesV2[];
  refs?: RefV2[];
  notes?: NoteV2[];
}

/** Echarts series ids carry the spec series index and role so tooltips read the spec's own numbers. */
const sid = (i: number, role = "main") => `s${i}:${role}`;
const parseSid = (id: string | undefined) => {
  const m = /^s(\d+):(\w+)$/.exec(id ?? "");
  return m ? { i: Number(m[1]), role: m[2] } : null;
};

const fmtNum = (v: unknown): string => {
  if (v == null || v === "" || (typeof v === "number" && Number.isNaN(v))) return "—";
  if (typeof v !== "number") return String(v);
  const a = Math.abs(v);
  const d = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 10 ? 1 : a >= 1 ? 2 : 3;
  return Number(v.toFixed(d)).toLocaleString("en-GB");
};

const DASH: Record<string, number[] | "solid"> = { solid: "solid", dashed: [5, 3], dotted: [1.5, 2.5] };

const unitOf = (spec: ChartV2, axis: number) => spec.y[axis]?.unit ?? "";
const axisOf = (spec: ChartV2, s: SeriesV2) => (s.axis === 1 && spec.y.length > 1 ? 1 : 0);

/** Category values in first-seen order (the spec gives them in display order). */
export function categories(spec: ChartV2): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of spec.series) for (const p of s.data) {
    const k = String(p[0]);
    if (!seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}

/** The greys in order; muted series step back to the quietest. Past three, dashes tell them apart. */
function shadeOf(t: Tok, rank: number, muted: boolean) {
  if (muted) return t.ink3;
  return [t.ink, t.ink2, t.ink3][rank % 3];
}

/** Whether names sit at line ends (direct labels) or in a key row under the plot. */
export function labelMode(spec: ChartV2): "none" | "direct" | "key" {
  const named = spec.series.filter((s) => !s.muted || s.kind === "band");
  if (spec.series.length < 2) return "none";
  const lineish = spec.series.every((s) => s.kind === "line" || s.kind === "area" || s.kind === "band");
  if (lineish && spec.y.length < 2 && named.length <= 4) return "direct";
  return "key";
}

/** One key entry per series: what the mark looks like, for the key row under the plot. */
export interface KeyEntry { name: string; mark: "line" | "bar" | "ring" | "band"; shade: string; dash: "solid" | "dashed" | "dotted"; decal: number | null; soft?: boolean }

export function keyEntries(spec: ChartV2, t: Tok): KeyEntry[] {
  let rank = 0;
  const bars = spec.series.filter((s) => s.kind === "bar").length;
  let barRank = 0;
  return spec.series.map((s) => {
    const r = s.muted ? 0 : rank++;
    const isBar = s.kind === "bar" || s.kind === "histogram";
    const decal = s.kind === "bar" && bars > 1 ? barRank++ % DECALS.length : null;
    return {
      name: s.name,
      mark: s.kind === "scatter" ? "ring" : s.kind === "band" ? "band" : isBar ? "bar" : "line",
      shade: s.kind === "band" ? t.band : shadeOf(t, r, !!s.muted),
      dash: s.style ?? (r >= 3 && !isBar ? "dashed" : "solid"),
      decal,
      ...(s.kind === "histogram" ? { soft: true } : {}),
    };
  });
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** y extent per axis including refs and notes (markers don't widen ECharts axes by themselves). */
function markerExtent(spec: ChartV2, axis: number): [number, number] | null {
  const vals: number[] = [];
  for (const r of spec.refs ?? []) {
    if (r.axis !== "y" || (r.y_axis ?? 0) !== axis) continue;
    if ("value" in r) vals.push(r.value); else vals.push(r.from, r.to);
  }
  for (const n of spec.notes ?? []) if ("y" in n && (n.y_axis ?? 0) === axis && isNum(n.y)) vals.push(n.y);
  return vals.length ? [Math.min(...vals), Math.max(...vals)] : null;
}

export interface SpecOptions { compact?: boolean }

export function specOption(spec: ChartV2, t: Tok, opts: SpecOptions = {}): Record<string, any> {
  const base = baseOption(t);
  const ax = axisBase(t);
  const xType = spec.x.type;
  const cats = xType === "category" ? categories(spec) : null;
  const catIndex = cats ? new Map(cats.map((c, i) => [c, i])) : null;
  const mode = labelMode(spec);
  const twoAxes = spec.y.length > 1;
  const hasHist = spec.series.some((s) => s.kind === "histogram");
  const nHist = spec.series.filter((s) => s.kind === "histogram").length;
  const nBars = spec.series.filter((s) => s.kind === "bar").length;
  const onlyItems = spec.series.every((s) => s.kind === "scatter" || s.kind === "histogram");

  // Category data are aligned to the category list so stacks and groups line up by x.
  const align = (s: SeriesV2, pick: (p: any[]) => any) => {
    if (!cats || !catIndex) return s.data.map((p) => [p[0], pick(p)]);
    const arr: any[] = cats.map(() => null);
    for (const p of s.data) arr[catIndex.get(String(p[0]))!] = pick(p);
    return arr;
  };

  const out: any[] = [];
  const carriers: Record<number, any> = {};
  let rank = 0;
  let barRank = 0;
  spec.series.forEach((s, i) => {
    const axis = axisOf(spec, s);
    const r = s.muted ? 0 : rank++;
    const shade = shadeOf(t, r, !!s.muted);
    const dash = DASH[s.style ?? (r >= 3 ? "dashed" : "solid")];
    const direct = mode === "direct" && s.kind !== "band";
    const endLabel = direct ? { show: true, formatter: s.name, color: t.ink2, fontFamily: t.sans, fontSize: 11, distance: 6 } : undefined;
    const common = { id: sid(i), name: s.name, yAxisIndex: axis, z: s.muted ? 1 : 3 };
    switch (s.kind) {
      case "line":
      case "area": {
        const n = s.data.length;
        out.push({
          ...common, type: "line", data: align(s, (p) => p[1]), connectNulls: false,
          showSymbol: n <= 40, symbol: "circle", symbolSize: opts.compact ? 3 : 4,
          itemStyle: { color: t.screen, borderColor: shade, borderWidth: 1.2 },
          lineStyle: { color: shade, width: s.muted ? 1 : 1.25, type: dash },
          emphasis: { disabled: true },
          ...(s.stack ? { stack: `area:${s.stack}` } : {}),
          ...(s.kind === "area" ? { areaStyle: { color: shade, opacity: s.muted ? 0.08 : 0.14 } } : {}),
          ...(endLabel ? { endLabel, labelLayout: { moveOverlap: "shiftY" } } : {}),
        });
        break;
      }
      case "bar": {
        const decal = nBars > 1 ? DECALS[barRank % DECALS.length] : undefined;
        barRank++;
        out.push({
          ...common, type: "bar", data: align(s, (p) => p[1]),
          ...(s.stack ? { stack: `bar:${s.stack}` } : {}),
          barMaxWidth: 28, barGap: "12%",
          itemStyle: { color: shade, borderColor: s.stack ? t.screen : undefined, borderWidth: s.stack ? 1 : 0, ...(decal ? { decal } : {}) },
          emphasis: { disabled: true },
        });
        break;
      }
      case "scatter":
        out.push({
          ...common, type: "scatter",
          data: s.data.map((p) => (xType === "category" ? [String(p[0]), p[1], p[2] ?? null] : [p[0], p[1], p[2] ?? null])),
          symbolSize: opts.compact ? 5 : 6,
          itemStyle: { color: "transparent", borderColor: shade, borderWidth: 1.2 },
          emphasis: { scale: 1.6 },
        });
        break;
      case "band": {
        const ok = (p: any[]) => isNum(p[1]) && isNum(p[2]);
        const stack = `band:${i}`;
        out.push({
          id: sid(i, "lo"), name: s.name, yAxisIndex: axis, type: "line", stack, z: 1, silent: true,
          data: align(s, (p) => (ok(p) ? Math.min(p[1], p[2]) : null)),
          symbol: "none", lineStyle: { opacity: 0 }, connectNulls: false, tooltip: { show: false },
        });
        out.push({
          id: sid(i, "span"), name: s.name, yAxisIndex: axis, type: "line", stack, z: 1, silent: true,
          data: align(s, (p) => (ok(p) ? Math.abs(p[2] - p[1]) : null)),
          symbol: "none", lineStyle: { opacity: 0 }, connectNulls: false,
          areaStyle: { color: t.band, opacity: 1 },
        });
        break;
      }
      case "histogram": {
        const translucent = nHist > 1;
        out.push({
          ...common, type: "custom",
          data: s.data.map((p) => [p[0], p[1], p[2]]),
          encode: { x: [0, 1], y: 2, tooltip: [0, 1, 2] },
          renderItem: (_params: any, api: any) => {
            const x0 = api.value(0), x1 = api.value(1), c = api.value(2);
            if (!isNum(c)) return null;
            const [a, top] = api.coord([x0, c]);
            const [b, bottom] = api.coord([x1, 0]);
            return {
              type: "rect",
              shape: { x: a + 0.5, y: top, width: Math.max(1, b - a - 1), height: Math.max(0, bottom - top) },
              style: { fill: shade, opacity: translucent ? 0.5 : s.muted ? 0.6 : 0.9, stroke: translucent ? shade : undefined, lineWidth: translucent ? 1 : 0 },
            };
          },
        });
        break;
      }
    }
    const idx = out.length - 1;
    if (carriers[axis] === undefined && s.kind !== "band") carriers[axis] = idx;
  });

  // Refs and notes ride on one series per y axis (or a silent helper when an axis has none).
  const carrier = (axis: number) => {
    if (carriers[axis] === undefined) {
      out.push({ id: `refs:${axis}`, type: "line", yAxisIndex: axis, data: [], silent: true, tooltip: { show: false } });
      carriers[axis] = out.length - 1;
    }
    return out[carriers[axis]];
  };
  const refLabel = (text: string | undefined, position: string) => ({
    show: !!text, formatter: text ?? "", position, color: t.ink2, fontFamily: t.sans, fontSize: 10.5,
  });
  const lineStyle = { color: t.ink2, width: 1, type: [4, 3] as number[] };
  const push = (axis: number, key: "markLine" | "markArea" | "markPoint", item: any, extra: any) => {
    const c = carrier(axis);
    c[key] = c[key] ?? { silent: true, symbol: "none", ...extra, data: [] };
    c[key].data.push(item);
  };
  const xv = (v: XVal) => (cats ? String(v) : v);
  for (const ref of spec.refs ?? []) {
    if (ref.axis === "y") {
      const axis = twoAxes ? ref.y_axis ?? 0 : 0;
      if ("value" in ref) push(axis, "markLine", { yAxis: ref.value, label: refLabel(ref.label, "insideEndTop"), lineStyle }, {});
      else push(axis, "markArea", [{ yAxis: ref.from, label: refLabel(ref.label, "insideTopLeft"), itemStyle: { color: t.band } }, { yAxis: ref.to }], {});
    } else {
      if ("value" in ref) push(0, "markLine", { xAxis: xv(ref.value), label: refLabel(ref.label, "end"), lineStyle }, {});
      else push(0, "markArea", [{ xAxis: xv(ref.from), label: refLabel(ref.label, "insideTop"), itemStyle: { color: t.band } }, { xAxis: xv(ref.to) }], {});
    }
  }
  for (const n of spec.notes ?? []) {
    if (Array.isArray(n.x)) {
      push(0, "markArea", [{ xAxis: xv(n.x[0]), label: refLabel(n.label, "insideTop"), itemStyle: { color: "transparent", borderColor: t.ink3, borderWidth: 1, borderType: [2, 2] } }, { xAxis: xv(n.x[1]) }], {});
    } else if ("y" in n && isNum(n.y)) {
      const axis = twoAxes ? n.y_axis ?? 0 : 0;
      push(axis, "markPoint", {
        coord: [xv(n.x), n.y], symbol: "circle", symbolSize: 7,
        itemStyle: { color: t.screen, borderColor: t.ink, borderWidth: 1.5 },
        label: { show: true, formatter: n.label, position: "top", color: t.ink, fontFamily: t.sans, fontSize: 10.5, distance: 6 },
      }, {});
    } else {
      push(0, "markLine", { xAxis: xv(n.x), label: refLabel(n.label, "end"), lineStyle: { color: t.ink3, width: 1, type: [1.5, 2.5] } }, {});
    }
  }

  const barsOn = (axis: number) => spec.series.some((s) => axisOf(spec, s) === axis && (s.kind === "bar" || s.kind === "histogram" || (s.kind === "area" && !!s.stack)));
  const yAxis = spec.y.slice(0, 2).map((y, k) => {
    const ext = markerExtent(spec, k);
    // Refs and notes must be inside the axis: invisible points widen it (markers alone don't).
    const x0 = spec.series.find((ss) => ss.data.length)?.data[0]?.[0];
    if (ext && x0 != null) {
      out.push({ id: `ext:${k}`, type: "scatter", yAxisIndex: k, symbolSize: 0, silent: true, tooltip: { show: false },
        data: [[cats ? String(x0) : x0, ext[0]], [cats ? String(x0) : x0, ext[1]]] });
    }
    const name = [y.label, y.unit].filter(Boolean).join(" · ");
    return {
      ...ax,
      type: "value", position: k === 0 ? "left" : "right", name, nameGap: 8,
      nameTextStyle: { ...ax.nameTextStyle, align: k === 0 ? "left" : "right", padding: k === 0 ? [0, 0, 0, -36] : [0, -36, 0, 0] },
      scale: !barsOn(k),
      min: y.min ?? (barsOn(k) && !(ext && ext[0] < 0) ? 0 : undefined),
      max: y.max ?? undefined,
      splitNumber: opts.compact ? 3 : 4,
      axisLabel: { ...ax.axisLabel, formatter: (v: number) => fmtNum(v) },
      splitLine: k === 0 ? ax.splitLine : { show: false },
    };
  });

  const longest = Math.max(0, ...spec.series.filter((s) => s.kind !== "band").map((s) => s.name.length));
  const right = twoAxes ? 52 : mode === "direct" ? Math.min(120, 14 + longest * 6.2) : 16;
  const xName = [spec.x.label, spec.x.unit].filter(Boolean).join(" · ");
  const hasYName = spec.y.some((y) => y.label || y.unit);
  const xAxis: any = {
    type: xType, ...ax, name: xName, nameLocation: "middle", nameGap: 26,
    splitLine: { show: false },
    axisLabel: { ...ax.axisLabel, hideOverlap: true,
      ...(xType === "value" ? { formatter: (v: number) => fmtNum(v) } : {}),
      ...(xType === "time" ? { formatter: { year: "{yyyy}", month: "{d} {MMM}", day: "{d} {MMM}", hour: "{HH}:{mm}", minute: "{HH}:{mm}" } } : {}) },
  };
  if (cats) Object.assign(xAxis, { data: cats, boundaryGap: true });
  if (xType === "value") Object.assign(xAxis, { scale: true });
  if (xType === "time" || (xType === "value" && !hasHist)) xAxis.boundaryGap = nBars ? ["3%", "3%"] : false;

  return {
    ...base,
    aria: { enabled: true, decal: { show: nBars > 1 } },
    grid: { left: 48, right, top: hasYName ? 26 : 14, bottom: xName ? 40 : 26, containLabel: false },
    xAxis,
    yAxis,
    tooltip: {
      ...base.tooltip,
      trigger: onlyItems ? "item" : "axis",
      formatter: (p: any) => tooltipHtml(spec, Array.isArray(p) ? p : [p]),
    },
    series: out,
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Tooltip text from the spec's own values (a band reads lower–upper, not the stacked span).
 * Spec strings are escaped: ECharts tooltips are HTML. */
export function tooltipHtml(spec: ChartV2, params: { seriesId?: string; dataIndex: number; axisValueLabel?: string; axisValue?: unknown }[]): string {
  const rows: string[] = [];
  let head = "";
  for (const p of params) {
    const id = parseSid(p.seriesId);
    if (!id || id.role === "lo") continue;
    const s = spec.series[id.i];
    if (!s) continue;
    const point = pointAt(spec, s, p.dataIndex);
    if (!point) continue;
    const unit = unitOf(spec, axisOf(spec, s));
    const u = unit ? ` ${esc(unit)}` : "";
    if (!head) head = s.kind === "histogram" ? `${fmtNum(point[0])}–${fmtNum(point[1])}${spec.x.unit ? ` ${esc(spec.x.unit)}` : ""}` : esc(String(p.axisValueLabel ?? point[0]));
    if (s.kind === "band") rows.push(`${esc(s.name)} ${fmtNum(point[1])}–${fmtNum(point[2])}${u}`);
    else if (s.kind === "histogram") rows.push(`${esc(s.name)} ${fmtNum(point[2])}`);
    else if (s.kind === "scatter") {
      head = point[2] != null ? esc(String(point[2])) : head;
      rows.push(`${esc(spec.x.label || "x")} ${fmtNum(point[0])}${spec.x.unit ? ` ${esc(spec.x.unit)}` : ""} · ${esc(s.name)} ${fmtNum(point[1])}${u}`);
    } else rows.push(`${esc(s.name)} ${point[1] == null ? "no data" : fmtNum(point[1]) + u}`);
  }
  return [head && `<b>${head}</b>`, ...rows].filter(Boolean).join("<br/>");
}

/** The spec point behind an ECharts data index (category charts are aligned to the category list). */
function pointAt(spec: ChartV2, s: SeriesV2, dataIndex: number): any[] | null {
  if (spec.x.type === "category" && s.kind !== "scatter" && s.kind !== "histogram") {
    const cat = categories(spec)[dataIndex];
    return s.data.find((p) => String(p[0]) === cat) ?? [cat, null, null];
  }
  return s.data[dataIndex] ?? null;
}

/** The accessible table behind a chart: one row per x, one column per series (bands: low and high). */
export function specTable(spec: ChartV2): { columns: string[]; rows: string[][] } {
  const hist = spec.series.filter((s) => s.kind === "histogram");
  if (hist.length && hist.length === spec.series.length) {
    const bins = new Map<string, string[]>();
    hist.forEach((s, k) => {
      for (const p of s.data) {
        const key = `${fmtNum(p[0])}–${fmtNum(p[1])}`;
        if (!bins.has(key)) bins.set(key, hist.map(() => "—"));
        bins.get(key)![k] = fmtNum(p[2]);
      }
    });
    return { columns: [spec.x.label || "Bin", ...hist.map((s) => s.name)], rows: [...bins].map(([k, v]) => [k, ...v]) };
  }
  const cols: string[] = [spec.x.label || (spec.x.type === "time" ? "Date" : "x")];
  const getters: ((x: string) => string)[] = [];
  const order: string[] = [];
  const seen = new Set<string>();
  for (const s of spec.series) {
    if (s.kind === "histogram") continue;
    const unit = unitOf(spec, axisOf(spec, s));
    const by = new Map<string, any[]>();
    for (const p of s.data) {
      const k = String(p[0]);
      by.set(k, p);
      if (!seen.has(k)) { seen.add(k); order.push(k); }
    }
    const u = unit ? ` (${unit})` : "";
    if (s.kind === "band") {
      cols.push(`${s.name} low${u}`, `${s.name} high${u}`);
      getters.push((x) => fmtNum(by.get(x)?.[1]), (x) => fmtNum(by.get(x)?.[2]));
    } else {
      cols.push(`${s.name}${u}`);
      getters.push((x) => fmtNum(by.get(x)?.[1]));
      if (s.kind === "scatter" && s.data.some((p) => p[2] != null)) {
        cols.push(`${s.name} label`);
        getters.push((x) => String(by.get(x)?.[2] ?? ""));
      }
    }
  }
  if (spec.x.type !== "category") {
    order.sort((a, b) => (spec.x.type === "value" ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0));
  }
  return { columns: cols, rows: order.map((x) => [spec.x.type === "value" ? fmtNum(Number(x)) : x, ...getters.map((g) => g(x))]) };
}

/** A sentence for screen readers: what is plotted, against what, and how many points. */
export function specLabel(spec: ChartV2): string {
  const n = spec.series.reduce((a, s) => a + s.data.length, 0);
  const what = spec.series.map((s) => `${s.name} (${s.kind})`).join(", ");
  const x = spec.x.label || (spec.x.type === "time" ? "date" : "x");
  return `${spec.title || "Chart"}: ${what} by ${x}; ${n} points. Use "Show table" for the values.`;
}
