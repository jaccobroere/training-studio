import { useMemo } from "react";
import { niceStep } from "../../charts/axis";
import { EChart } from "../../charts/EChart";
import { axisBase, baseOption, useTokens } from "../../charts/theme";
import { dayLabel, shortDate } from "../../ui/dates";
import type { DailySeries } from "../types";
import { Readout, Unavailable, fmt, touchTip } from "./parts";
import { labelEvery } from "./sleepScale";

export type DailyData = DailySeries;

export function DailyChart({ d, size }: { d: DailyData; size: "S" | "L" }) {
  const t = useTokens();
  const option = useMemo(() => {
    // A gap label is ~45px wide; only label gaps wide enough to hold it, so labels never overlap.
    const minGap = Math.max(4, Math.ceil((d.points.length * 50) / (window.innerWidth < 760 ? 280 : 900)));
    const lo = d.baseline.map(([day, mu, sd]) => [day, mu != null && sd != null ? mu - sd : null]);
    const span = d.baseline.map(([day, mu, sd]) => [day, mu != null && sd != null ? 2 * sd : null]);
    const mean = d.baseline.map(([day, mu]) => [day, mu]);
    const gapAreas = d.gaps.map(([a, b]) => [
      { xAxis: a, itemStyle: { color: t.grat2 }, label: { show: size === "L" && daysBetween(a, b) >= minGap, position: "insideTop" as const, formatter: `no data\n${daysBetween(a, b)} d`, color: t.ink3, fontSize: 10, fontFamily: t.mono, lineHeight: 13 } },
      { xAxis: b },
    ]);
    const vals = d.points.map((p) => p[1]).filter((v): v is number => v != null);
    const bands = d.baseline.flatMap(([, mu, sd]) => (mu != null && sd != null ? [mu - sd, mu + sd] : []));
    const all = [...vals, ...bands];
    // Even gridlines on round numbers, with half a step of air at each end so the line never sits
    // on the axis (an explicit floor/ceil min max gave ECharts lopsided ticks: 42, 50, 60, 70, 76).
    const step = all.length ? niceStep((Math.max(...all) - Math.min(...all)) / 4) : 1;
    const lo0 = all.length ? Math.min(...all) : 0, hi0 = all.length ? Math.max(...all) : 1;
    const yMin = lo0 >= 0 ? Math.max(0, Math.floor((lo0 - step * 0.5) / step) * step) : Math.floor((lo0 - step * 0.5) / step) * step;
    const yMax = Math.ceil((hi0 + step * 0.5) / step) * step;
    return {
      ...baseOption(t),
      tooltip: { ...baseOption(t).tooltip, ...touchTip(), formatter: (ps: any[]) => {
        const main = ps.find((p) => p.seriesName === d.label);
        if (!main) return "";
        const base = ps.find((p) => p.seriesName === "Baseline mean");
        const when = dayLabel(String(main.value[0]));
        return main.value[1] == null ? `${when}<br/>no data`
          : `${when}<br/>${fmt(main.value[1])} ${d.unit}${base && base.value[1] != null ? ` · baseline ${fmt(base.value[1])}` : ""}`;
      } },
      grid: { left: 40, right: size === "L" ? 64 : 40, top: Object.keys(touchTip()).length ? 44 : 16, bottom: 24 },
      xAxis: { type: "category", data: d.points.map((p) => p[0]), boundaryGap: false, ...axisBase(t),
        axisLabel: { ...axisBase(t).axisLabel, formatter: (v: string) => shortDate(v), interval: labelEvery(d.points.length, size === "L" ? 10 : 6), hideOverlap: true },
        splitLine: { show: false } },
      yAxis: { type: "value", scale: true, min: all.length ? yMin : undefined, max: all.length ? yMax : undefined,
        interval: all.length ? step : undefined, ...axisBase(t), splitNumber: 4 },
      series: [
        { name: "band-lo", type: "line", data: lo, stack: "band", symbol: "none", lineStyle: { opacity: 0 }, emphasis: { disabled: true }, silent: true, tooltip: { show: false } },
        { name: "Baseline ±1 SD", type: "line", data: span, stack: "band", symbol: "none", lineStyle: { opacity: 0 }, emphasis: { disabled: true },
          areaStyle: { color: t.band }, silent: true, tooltip: { show: false } },
        { name: "Baseline mean", type: "line", data: mean, symbol: "none", lineStyle: { color: t.ink3, width: 1, type: [4, 3] }, emphasis: { disabled: true }, silent: true },
        { name: d.label, type: "line", data: d.points, connectNulls: false, emphasis: { disabled: true }, symbol: "circle", symbolSize: size === "L" ? 3.5 : 2.5,
          showSymbol: d.points.length < 140, itemStyle: { color: t.ink }, lineStyle: { color: t.ink, width: 1.25 },
          markArea: { silent: true, data: gapAreas },
          markPoint: d.last ? { symbol: "circle", symbolSize: 8, itemStyle: { color: t.screen, borderColor: t.ink, borderWidth: 1.5 },
            label: { show: size === "L", position: "right", formatter: `${fmt(d.last.value)} ${d.unit}`, color: t.ink, fontFamily: t.mono, fontSize: 11 },
            data: [{ coord: [d.last.day, d.last.value] }] } : undefined },
      ],
    };
  }, [d, t, size]);
  if (!d.stats.n) return <Unavailable what={d.label} why={"No data in this period."} />;
  const lastBase = [...d.baseline].reverse().find((b) => b[1] != null);
  return (
    <>
      <Readout items={[
        [`Latest · ${d.last ? shortDate(d.last.day) : "—"}`, d.last ? fmt(d.last.value) : "—", d.unit],
        ["Baseline", lastBase ? `${fmt(lastBase[1]!)} ± ${fmt(lastBase[2]!)}` : "none yet", lastBase ? d.unit : ""],
        ["Median", fmt(d.stats.median), d.unit],
        ["Range", d.stats.min != null ? `${fmt(d.stats.min)}–${fmt(d.stats.max)}` : "—", d.unit],
        ["Days", `${d.stats.n}/${d.expected}`, "", d.missing ? `${d.missing} missing` : ""],
      ]} compact={size === "S"} />
      <EChart option={option} height={size === "L" ? 250 : 180}
        label={`${d.label}: ${d.stats.n} of ${d.expected} days, median ${fmt(d.stats.median)} ${d.unit}`} />
    </>
  );
}

function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1;
}
