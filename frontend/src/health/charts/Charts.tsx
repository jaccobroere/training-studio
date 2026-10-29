import { useMemo } from "react";
import { EChart } from "../../charts/EChart";
import { DECALS, axisBase, baseOption, useTokens } from "../../charts/theme";
import { dayLabel, shortDate } from "../../ui/dates";
import { sportCode, sportLabel } from "../../ui/sport";
import type { LoadData, SleepData, VolumeData } from "../types";
import { Readout, Unavailable, fmt, touchTip } from "./parts";
import { clock, labelEvery, sleepRange } from "./sleepScale";

function median(vals: (number | null)[]): number | null {
  const v = vals.filter((x): x is number => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function SleepTimeline({ d, size }: { d: SleepData; size: "S" | "L" }) {
  const t = useTokens();
  const nights = d.nights;
  const { min: lo, max: hi, interval } = sleepRange(nights);
  const option = useMemo(() => ({
    ...baseOption(t),
    tooltip: { ...baseOption(t).tooltip, ...touchTip(), trigger: "item", formatter: (p: any) => {
      const n = nights[p.dataIndex];
      return n.bed == null ? `${dayLabel(n.day)} · no data` : `${dayLabel(n.day)}<br/>${clock(n.bed)} → ${clock(n.wake)} · ${fmt(n.hours)} h asleep`;
    } },
    grid: { left: 48, right: size === "L" ? 70 : 16, top: 10, bottom: 24 },
    xAxis: { type: "category", data: nights.map((n) => n.day), ...axisBase(t), splitLine: { show: false },
      axisLabel: { ...axisBase(t).axisLabel, formatter: (v: string) => shortDate(v), interval: labelEvery(nights.length, size === "L" ? 10 : 6), hideOverlap: true } },
    yAxis: { type: "value", inverse: true, min: lo, max: hi, interval, ...axisBase(t),
      axisLabel: { ...axisBase(t).axisLabel, formatter: (v: number) => clock(v) } },
    series: [
      { type: "custom", renderItem: (_: any, api: any) => {
        const i = api.value(0), b = api.value(1), w = api.value(2);
        if (Number.isNaN(b)) {
          const x = api.coord([i, lo])[0], y0 = api.coord([i, lo])[1], y1 = api.coord([i, hi])[1];
          const bw = Math.max(2, api.size([1, 0])[0] * 0.8);
          return { type: "rect", shape: { x: x - bw / 2, y: y0, width: bw, height: y1 - y0 }, style: { fill: t.grat2 } };
        }
        const [x, y0] = api.coord([i, b]); const y1 = api.coord([i, w])[1];
        const bw = Math.max(2, api.size([1, 0])[0] * 0.55);
        return { type: "rect", shape: { x: x - bw / 2, y: y0, width: bw, height: y1 - y0, r: 1 }, style: { fill: t.ink2 } };
      }, clip: true, data: nights.map((n, i) => [i, n.bed ?? NaN, n.wake ?? NaN]), encode: { x: 0, y: [1, 2] } },
      ...(d.median_bed != null ? [{ type: "line", data: [], markLine: { silent: true, symbol: "none", lineStyle: { color: t.ink3, type: [3, 3] },
        label: { color: t.ink2, fontFamily: t.mono, fontSize: 10, formatter: (p: any) => `${p.name} ${clock(p.value)}` },
        data: [{ yAxis: d.median_bed, name: "bed" }, { yAxis: d.median_wake, name: "wake" }] } }] : []),
    ],
  }), [d, t, size, nights, lo, hi, interval]);
  if (!d.n) return <Unavailable what="Sleep timeline" why="No data in this period." />;
  return (
    <>
      <Readout items={[["Median asleep", fmt(median(nights.map((n) => n.hours))), "h"], ["Median bed", clock(d.median_bed)], ["Median wake", clock(d.median_wake)], ["Nights", `${d.n}/${d.expected}`, "", d.expected - d.n ? `${d.expected - d.n} missing` : ""]]} compact={size === "S"} />
      <EChart option={option} height={size === "L" ? 250 : 190} label={`Bed and wake times for ${d.n} nights; median bed ${clock(d.median_bed)}, wake ${clock(d.median_wake)}`} />
      <p className="chart-note">One column per night, dated by the day you woke up. Grey: no data. {d.estimate_note}</p>
    </>
  );
}

export function WeeklyVolume({ d, size, longOnly }: { d: VolumeData; size: "S" | "L"; longOnly?: boolean }) {
  const t = useTokens();
  const weeks = d.weeks;
  const option = useMemo(() => ({
    ...baseOption(t),
    tooltip: { ...baseOption(t).tooltip, ...touchTip() },
    grid: { left: 40, right: 12, top: 28, bottom: 24 },
    xAxis: { type: "category", data: weeks.map((w) => shortDate(w.monday)), ...axisBase(t), splitLine: { show: false },
      axisLabel: { ...axisBase(t).axisLabel, hideOverlap: true } },
    yAxis: { type: "value", name: "km", nameGap: 10, ...axisBase(t), splitNumber: 4 },
    series: longOnly ? [
      { name: "Longest run", type: "bar", data: weeks.map((w) => w.long_km || null), barWidth: "45%", itemStyle: { color: t.ink2 },
        label: { show: size === "L", position: "top", color: t.ink2, fontFamily: t.mono, fontSize: 10 } },
    ] : [
      { name: "Planned", type: "bar", data: weeks.map((w) => w.planned_km), barGap: "-100%", barWidth: "58%",
        itemStyle: { color: "transparent", borderColor: t.ink, borderType: [3, 2], borderWidth: 1 },
        label: { show: size === "L", position: "top", formatter: (p: any) => (p.value != null ? `plan ${fmt(p.value, 0)}` : ""), color: t.ink3, fontFamily: t.mono, fontSize: 9.5 },
        labelLayout: { hideOverlap: true } },
      { name: "Actual", type: "bar", data: weeks.map((w) => w.actual_km || 0), barWidth: "42%", itemStyle: { color: t.ink2 },
        label: { show: size === "L", position: "top", formatter: (p: any) => (p.value ? fmt(p.value, 0) : ""), color: t.ink2, fontFamily: t.mono, fontSize: 9.5 },
        labelLayout: { hideOverlap: true } },
    ],
  }), [weeks, t, size, longOnly]);
  if (!weeks.length) return <Unavailable what="Weekly volume" why="No data in this period." />;
  const done = weeks.filter((w) => w.actual_km > 0);
  const last4 = done.slice(-4);
  const cur = weeks[weeks.length - 1];
  return (
    <>
      {longOnly ? (
        <Readout items={[["Longest", fmt(Math.max(0, ...weeks.map((w) => w.long_km))), "km"], ["Weeks", String(done.length)]]} compact />
      ) : (
        <Readout items={[
          ["This week", `${fmt(cur.actual_km)}`, "km", cur.planned_km != null ? `of ${fmt(cur.planned_km)} km plan` : ""],
          ["4-wk mean", last4.length ? fmt(last4.reduce((a, w) => a + w.actual_km, 0) / last4.length) : "—", "km"],
          ["Max", fmt(Math.max(0, ...weeks.map((w) => w.actual_km))), "km"],
          ["Weeks", `${done.length}/${weeks.length}`, "", `with ${sportLabel(d.sport).toLowerCase()}`],
        ]} compact={size === "S"} />
      )}
      <EChart option={option} height={size === "L" ? 240 : 180} label={`Weekly ${sportLabel(d.sport).toLowerCase()} kilometres for ${weeks.length} weeks`} />
      {!longOnly && <p className="chart-note"><span className="lg solid" /> actual <span className="lg dashed" /> planned. Bars are not stacked. {d.rule}</p>}
    </>
  );
}

export function LoadChart({ d, size, srpe }: { d: LoadData; size: "S" | "L"; srpe?: boolean }) {
  const t = useTokens();
  const shades = useMemo(() => [t.ink, t.ink2, t.ink3, t.grat, t.ink2], [t]);
  const weeks = d.weeks as Record<string, any>[];
  const sports = d.sports;
  const option = useMemo(() => ({
    ...baseOption(t),
    tooltip: { ...baseOption(t).tooltip, ...touchTip() },
    aria: { enabled: true, decal: { show: true, decals: DECALS } },
    grid: { left: 40, right: 12, top: 28, bottom: 24 },
    xAxis: { type: "category", data: weeks.map((w) => shortDate(w.monday)), ...axisBase(t), splitLine: { show: false },
      axisLabel: { ...axisBase(t).axisLabel, hideOverlap: true } },
    yAxis: { type: "value", name: srpe ? "AU" : "h", nameGap: 10, ...axisBase(t), splitNumber: 4 },
    series: srpe ? [{ name: "sRPE", type: "bar", data: weeks.map((w) => w.srpe), barWidth: "50%", itemStyle: { color: t.ink2 } }]
      : sports.map((sp, i) => ({ name: sportLabel(sp), type: "bar", stack: "h", data: weeks.map((w) => w[sp] || 0), barWidth: "56%",
        itemStyle: { color: shades[i % shades.length], borderColor: t.screen, borderWidth: 0.5, decal: DECALS[i % DECALS.length] } })),
  }), [weeks, sports, t, srpe, shades]);
  if (!weeks.length) return <Unavailable what="Training load" why="No sessions with a duration in this period." />;
  if (srpe && !weeks.some((w) => w.srpe)) return <Unavailable what="Session-RPE load" why="Needs sessions with an RPE and a duration." />;
  return (
    <>
      {!srpe && <div className="legend" aria-hidden="true">{sports.map((sp, i) => (
        <span key={sp} className="lg-i"><svg width="14" height="10"><rect width="14" height="10" fill={shades[i % shades.length]} /></svg>{sportCode(sp)}</span>
      ))}</div>}
      <EChart option={option} height={size === "L" ? 230 : 170} label={srpe ? "Weekly session-RPE load" : `Weekly hours by sport: ${sports.map(sportLabel).join(", ")}`} />
      <p className="chart-note">{srpe ? d.srpe_rule : "Recorded hours plus logged durations for sessions without a recording. Cardiovascular load is not leg stress."}</p>
    </>
  );
}
