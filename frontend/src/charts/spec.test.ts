import { describe, expect, it } from "vitest";
import { categories, keyEntries, labelMode, specLabel, specOption, specTable, tooltipHtml, type ChartV2 } from "./spec";
import type { Tok } from "./theme";

const t: Tok = { ink: "#111", ink2: "#444", ink3: "#777", grat: "#ccc", grat2: "#eee", band: "rgba(0,0,0,.1)",
  screen: "#fff", signal: "#f60", face: "#fafafa", mono: "mono", sans: "sans" };

const base = (over: Partial<ChartV2>): ChartV2 => ({
  v: 2, kind: "line", title: "T", subtitle: "", x: { type: "time", label: "", unit: "" }, y: [{ label: "HRV", unit: "ms" }],
  series: [], refs: [], notes: [], ...over,
});

describe("specOption", () => {
  it("line: time axis, gaps kept, few points show symbols, unit on the axis", () => {
    const spec = base({ series: [{ name: "HRV", kind: "line", axis: 0, data: [["2026-09-01", 61], ["2026-09-02", null], ["2026-09-03", 63]] }] });
    const o = specOption(spec, t);
    expect(o.xAxis.type).toBe("time");
    expect(o.yAxis).toHaveLength(1);
    expect(o.yAxis[0].name).toBe("HRV · ms");
    expect(o.yAxis[0].scale).toBe(true);
    const s = o.series[0];
    expect(s.type).toBe("line");
    expect(s.connectNulls).toBe(false);
    expect(s.data[1]).toEqual(["2026-09-02", null]);
    expect(s.showSymbol).toBe(true);
    expect(s.lineStyle.color).toBe(t.ink);
    expect(labelMode(spec)).toBe("none");
    expect(s.endLabel).toBeUndefined();
  });

  it("line: many points hide symbols; dashed and muted styles; direct labels for 2+ series", () => {
    const pts = Array.from({ length: 60 }, (_, i) => [`2026-08-${String((i % 28) + 1).padStart(2, "0")}`, i]);
    const spec = base({ series: [
      { name: "HRV", kind: "line", data: pts },
      { name: "7-day avg", kind: "line", data: pts, style: "dashed" },
      { name: "Context", kind: "line", data: pts, muted: true },
    ] });
    const o = specOption(spec, t);
    expect(o.series[0].showSymbol).toBe(false);
    expect(o.series[1].lineStyle.type).toEqual([5, 3]);
    expect(o.series[1].lineStyle.color).toBe(t.ink2);
    expect(o.series[2].lineStyle.color).toBe(t.ink3);
    expect(o.series[0].endLabel.formatter).toBe("HRV");
    expect(o.grid.right).toBeGreaterThan(16);
  });

  it("area: filled, stacked areas share a stack and a zero baseline", () => {
    const spec = base({ kind: "area", series: [
      { name: "run", kind: "area", stack: "total", data: [["2026-09-01", 1], ["2026-09-08", 2]] },
      { name: "ride", kind: "area", stack: "total", data: [["2026-09-01", 0.5], ["2026-09-08", 1]] },
    ] });
    const o = specOption(spec, t);
    expect(o.series[0].areaStyle).toBeDefined();
    expect(o.series[0].stack).toBe("area:total");
    expect(o.series[1].stack).toBe("area:total");
    expect(o.yAxis[0].scale).toBe(false);
    expect(o.yAxis[0].min).toBe(0);
  });

  it("bar on category x: aligned by category, grouped without stack, decals for 2+ bars", () => {
    const spec = base({ kind: "bar", x: { type: "category", label: "", unit: "" }, y: [{ label: "", unit: "km" }], series: [
      { name: "Actual", kind: "bar", data: [["W1", 30], ["W2", 40]] },
      { name: "Planned", kind: "bar", data: [["W2", 42], ["W3", 45]] },
    ] });
    const o = specOption(spec, t);
    expect(o.xAxis.type).toBe("category");
    expect(o.xAxis.data).toEqual(["W1", "W2", "W3"]);
    expect(o.series[0].data).toEqual([30, 40, null]);
    expect(o.series[1].data).toEqual([null, 42, 45]);
    expect(o.series[0].stack).toBeUndefined();
    expect(o.series[1].itemStyle.decal).toBeDefined();
    expect(o.aria.decal.show).toBe(true);
    expect(labelMode(spec)).toBe("key");
    expect(o.yAxis[0].min).toBe(0);
  });

  it("stacked bar: same stack, surface gap between segments", () => {
    const spec = base({ kind: "bar", x: { type: "category" }, y: [{ unit: "h" }], series: [
      { name: "run", kind: "bar", stack: "total", data: [["7 Sep", 3]] },
      { name: "ride", kind: "bar", stack: "total", data: [["7 Sep", 2]] },
    ] });
    const o = specOption(spec, t);
    expect(o.series.map((s: any) => s.stack)).toEqual(["bar:total", "bar:total"]);
    expect(o.series[0].itemStyle.borderColor).toBe(t.screen);
  });

  it("combo: bars + a line on the right axis → two y axes, each with its unit", () => {
    const spec = base({ kind: "bar", y: [{ label: "", unit: "km" }, { label: "Avg HR", unit: "bpm" }], series: [
      { name: "km", kind: "bar", axis: 0, data: [["2026-09-07", 32.5], ["2026-09-14", 41]] },
      { name: "Avg HR", kind: "line", axis: 1, data: [["2026-09-07", 141], ["2026-09-14", null]] },
    ], refs: [{ axis: "y", value: 40, label: "target", y_axis: 0 }], notes: [{ x: "2026-09-21", label: "Taper" }] });
    const o = specOption(spec, t);
    expect(o.yAxis).toHaveLength(2);
    expect(o.yAxis[0].name).toBe("km");
    expect(o.yAxis[1].name).toBe("Avg HR · bpm");
    expect(o.yAxis[1].position).toBe("right");
    expect(o.series[1].yAxisIndex).toBe(1);
    expect(o.series[0].markLine.data.map((d: any) => d.yAxis ?? d.xAxis)).toEqual([40, "2026-09-21"]);
    expect(o.grid.right).toBe(52);
  });

  it("scatter: hollow rings, labels kept for the tooltip, item tooltip", () => {
    const spec = base({ kind: "scatter", x: { type: "value", label: "Sleep", unit: "h" }, y: [{ label: "HRV next day", unit: "ms" }],
      series: [{ name: "HRV next day", kind: "scatter", data: [[7.2, 60, "2026-09-01"], [6.1, 55, "2026-09-02"]] }] });
    const o = specOption(spec, t);
    expect(o.series[0].type).toBe("scatter");
    expect(o.series[0].itemStyle.color).toBe("transparent");
    expect(o.series[0].data[0]).toEqual([7.2, 60, "2026-09-01"]);
    expect(o.tooltip.trigger).toBe("item");
    expect(o.xAxis.name).toBe("Sleep · h");
    const html = tooltipHtml(spec, [{ seriesId: "s0:main", dataIndex: 0 }]);
    expect(html).toContain("2026-09-01");
    expect(html).toContain("60");
  });

  it("band: a transparent lower line and a filled span on one stack; tooltip reads lower–upper", () => {
    const spec = base({ series: [
      { name: "HRV", kind: "line", data: [["2026-09-01", 61], ["2026-09-02", 64]] },
      { name: "Normal range", kind: "band", muted: true, data: [["2026-09-01", 55, 70], ["2026-09-02", null, 71]] },
    ] });
    const o = specOption(spec, t);
    const lo = o.series.find((s: any) => s.id === "s1:lo");
    const span = o.series.find((s: any) => s.id === "s1:span");
    expect(lo.stack).toBe(span.stack);
    expect(lo.data).toEqual([["2026-09-01", 55], ["2026-09-02", null]]);
    expect(span.data).toEqual([["2026-09-01", 15], ["2026-09-02", null]]);
    expect(span.areaStyle.color).toBe(t.band);
    expect(lo.lineStyle.opacity).toBe(0);
    const html = tooltipHtml(spec, [
      { seriesId: "s0:main", dataIndex: 0, axisValueLabel: "1 Sep" },
      { seriesId: "s1:lo", dataIndex: 0 },
      { seriesId: "s1:span", dataIndex: 0 },
    ]);
    expect(html).toContain("Normal range 55–70 ms");
    expect(html).toContain("HRV 61 ms");
    expect(html.match(/Normal range/g)).toHaveLength(1);
  });

  it("histogram: custom bars spanning bins on a value axis; overlays are translucent", () => {
    const spec = base({ kind: "histogram", x: { type: "value", label: "Pace", unit: "min/km" }, y: [{ label: "", unit: "" }], series: [
      { name: "Easy", kind: "histogram", data: [[5, 5.5, 3], [5.5, 6, 7]] },
      { name: "Hard", kind: "histogram", data: [[5, 5.5, 4], [5.5, 6, 1]] },
    ] });
    const o = specOption(spec, t);
    expect(o.series[0].type).toBe("custom");
    expect(o.series[0].encode).toEqual({ x: [0, 1], y: 2, tooltip: [0, 1, 2] });
    expect(o.xAxis.type).toBe("value");
    expect(o.xAxis.scale).toBe(true);
    expect(o.yAxis[0].min).toBe(0);
    // renderItem draws a rect from bin start to bin end
    const api = { value: (k: number) => [5, 5.5, 3][k], coord: ([x, y]: number[]) => [x * 100, 300 - y * 10] };
    const el = o.series[0].renderItem({}, api);
    expect(el.type).toBe("rect");
    expect(el.shape.width).toBeCloseTo(49);
    expect(el.style.opacity).toBe(0.5);
    expect(tooltipHtml(spec, [{ seriesId: "s0:main", dataIndex: 1 }])).toContain("5.5–6 min/km");
  });

  it("refs and notes: y line, y band, x line, x band, point note, pin, range; axis widened to refs", () => {
    const spec = base({ series: [{ name: "HRV", kind: "line", data: [["2026-09-01", 61], ["2026-09-30", 64]] }],
      refs: [
        { axis: "y", value: 80, label: "LT" },
        { axis: "y", from: 50, to: 70, label: "Zone 2" },
        { axis: "x", value: "2026-10-04", label: "Race" },
        { axis: "x", from: "2026-09-20", to: "2026-10-03", label: "Taper" },
      ],
      notes: [{ x: "2026-09-06", y: 70, label: "PB" }, { x: "2026-09-12", label: "Ill" }, { x: ["2026-09-14", "2026-09-18"], label: "Camp" }] });
    const o = specOption(spec, t);
    const s = o.series[0];
    expect(s.markLine.data).toHaveLength(3);
    expect(s.markArea.data).toHaveLength(3);
    expect(s.markPoint.data[0].coord).toEqual(["2026-09-06", 70]);
    expect(s.markPoint.data[0].label.formatter).toBe("PB");
    const ext = o.series.find((x: any) => x.id === "ext:0");
    expect(ext.data.map((d: any) => d[1])).toEqual([50, 80]);
    expect(ext.symbolSize).toBe(0);
  });

  it("explicit y min/max win; refs on an axis without series get a silent carrier", () => {
    const spec = base({ y: [{ unit: "km", min: 0, max: 100 }, { unit: "bpm" }],
      series: [{ name: "km", kind: "line", axis: 0, data: [["2026-09-01", 3]] }],
      refs: [{ axis: "y", value: 150, label: "max", y_axis: 1 }] });
    const o = specOption(spec, t);
    expect(o.yAxis[0].min).toBe(0);
    expect(o.yAxis[0].max).toBe(100);
    const helper = o.series.find((s: any) => s.id === "refs:1");
    expect(helper.yAxisIndex).toBe(1);
    expect(helper.markLine.data[0].yAxis).toBe(150);
  });

  it("escapes spec text in tooltips", () => {
    const spec = base({ series: [{ name: "<img src=x>", kind: "line", data: [["2026-09-01", 1]] }] });
    expect(tooltipHtml(spec, [{ seriesId: "s0:main", dataIndex: 0 }])).not.toContain("<img");
  });
});

describe("specTable / labels", () => {
  it("one row per x, columns per series, bands as low/high, missing as a dash", () => {
    const spec = base({ series: [
      { name: "HRV", kind: "line", data: [["2026-09-02", 64], ["2026-09-01", null]] },
      { name: "Range", kind: "band", data: [["2026-09-01", 55, 70]] },
    ] });
    const tb = specTable(spec);
    expect(tb.columns).toEqual(["Date", "HRV (ms)", "Range low (ms)", "Range high (ms)"]);
    expect(tb.rows[0]).toEqual(["2026-09-01", "—", "55", "70"]);
    expect(tb.rows[1]).toEqual(["2026-09-02", "64", "—", "—"]);
  });

  it("histogram tables list bins", () => {
    const spec = base({ x: { type: "value", label: "Pace" }, series: [{ name: "Runs", kind: "histogram", data: [[5, 5.5, 3]] }] });
    expect(specTable(spec)).toEqual({ columns: ["Pace", "Runs"], rows: [["5–5.5", "3"]] });
  });

  it("categories keep first-seen order; key entries describe the marks", () => {
    const spec = base({ x: { type: "category" }, series: [
      { name: "a", kind: "bar", data: [["B", 1], ["A", 2]] },
      { name: "b", kind: "scatter", data: [["C", 1]] },
    ] });
    expect(categories(spec)).toEqual(["B", "A", "C"]);
    const keys = keyEntries(spec, t);
    expect(keys.map((k) => k.mark)).toEqual(["bar", "ring"]);
    expect(specLabel(spec)).toContain("a (bar)");
  });
});
