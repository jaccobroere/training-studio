import { useMemo } from "react";
import { EChart } from "../../charts/EChart";
import { DECALS, axisBase, baseOption, useTokens } from "../../charts/theme";
import { shortDate } from "../../ui/dates";
import { sportCode, sportLabel } from "../../ui/sport";
import type { EnergyData } from "../types";
import { Note } from "../../activities/controls";
import { Readout, Unavailable, fmt, touchTip } from "./parts";

const SYMBOLS = ["circle", "rect", "triangle", "diamond", "pin", "arrow"] as const;
/** kcal per hour of the faint reference lines on the session plot. */
const RATES = [300, 600, 900];

const kcal = (v: number) => `${fmt(v, 0)}`;

/** Weekly calories stacked by type, with the rate each type burns at beside it. */
export function WeeklyEnergy({ d, size }: { d: EnergyData; size: "S" | "L" }) {
  const t = useTokens();
  const shades = useMemo(() => [t.ink, t.ink2, t.ink3, t.grat, t.ink2], [t]);
  const weeks = d.weeks;
  const sports = d.sports;
  const option = useMemo(() => ({
    ...baseOption(t),
    tooltip: { ...baseOption(t).tooltip, ...touchTip(), valueFormatter: (v: number) => `${kcal(v)} kcal` },
    aria: { enabled: true, decal: { show: true, decals: DECALS } },
    grid: { left: 44, right: 12, top: 28, bottom: 24 },
    xAxis: { type: "category", data: weeks.map((w) => shortDate(w.monday)), ...axisBase(t), splitLine: { show: false },
      axisLabel: { ...axisBase(t).axisLabel, hideOverlap: true } },
    yAxis: { type: "value", name: "kcal", nameGap: 10, ...axisBase(t), splitNumber: 4 },
    series: sports.map((sp, i) => ({ name: sportLabel(sp), type: "bar", stack: "kcal", data: weeks.map((w) => (w[sp] as number) || 0), barWidth: "56%",
      itemStyle: { color: shades[i % shades.length], borderColor: t.screen, borderWidth: 0.5, decal: DECALS[i % DECALS.length] } })),
  }), [weeks, sports, t, shades]);
  if (!weeks.length) return <Unavailable what="Weekly energy" why="No recordings with a calorie figure in this period." />;
  const totals = weeks.map((w) => sports.reduce((a, sp) => a + ((w[sp] as number) || 0), 0));
  const full = totals.slice(0, -1); // the running week is incomplete: left out of the mean
  const mean = full.length ? full.reduce((a, b) => a + b, 0) / full.length : null;
  const top = d.by_sport[0];
  return (
    <>
      <Readout items={[
        ["Total", kcal(d.by_sport.reduce((a, r) => a + r.kcal, 0)), "kcal"],
        ["Weekly mean", mean == null ? "—" : kcal(mean), "kcal"],
        ["Biggest week", kcal(Math.max(...totals)), "kcal"],
        ["Most from", top ? sportLabel(top.sport) : "—", "", top ? `${Math.round((top.kcal / d.by_sport.reduce((a, r) => a + r.kcal, 0)) * 100)}%` : ""],
      ]} compact={size === "S"} />
      <div className="legend" aria-hidden="true">{sports.map((sp, i) => (
        <span key={sp} className="lg-i"><svg width="14" height="10"><rect width="14" height="10" fill={shades[i % shades.length]} /></svg>{sportCode(sp)}</span>
      ))}</div>
      <EChart option={option} height={size === "L" ? 230 : 170} label={`Weekly calories by type for ${weeks.length} weeks`} />
      <Note more={<>{d.rule} The mean leaves out the running week.</>}>Kilocalories per week, by type.</Note>
    </>
  );
}

/** Per type: total calories as a bar, and how hard that type burns (kcal per hour) at its end. */
export function EnergyByType({ d }: { d: EnergyData }) {
  const t = useTokens();
  const rows = d.by_sport;
  const total = rows.reduce((a, r) => a + r.kcal, 0);
  const option = useMemo(() => ({
    ...baseOption(t),
    tooltip: { ...baseOption(t).tooltip, ...touchTip(), trigger: "item", formatter: (p: any) => {
      const r = rows[p.dataIndex];
      return `${sportLabel(r.sport)}<br/>${kcal(r.kcal)} kcal · ${r.n} session${r.n === 1 ? "" : "s"}<br/>${fmt(r.hours, 1)} h${r.kcal_per_h ? ` · ${kcal(r.kcal_per_h)} kcal/h` : ""}`;
    } },
    grid: { left: 44, right: 96, top: 6, bottom: 22 },
    xAxis: { type: "value", ...axisBase(t), splitNumber: 3, axisLabel: { ...axisBase(t).axisLabel, formatter: (v: number) => kcal(v) } },
    yAxis: { type: "category", inverse: true, data: rows.map((r) => sportCode(r.sport)), ...axisBase(t), splitLine: { show: false },
      axisLabel: { ...axisBase(t).axisLabel, color: t.ink2, fontWeight: 600 } },
    series: [{ type: "bar", barWidth: "58%", data: rows.map((r) => r.kcal), itemStyle: { color: t.ink2 },
      label: { show: true, position: "right", color: t.ink2, fontFamily: t.mono, fontSize: 10.5,
        formatter: (p: any) => { const r = rows[p.dataIndex]; return `${kcal(r.kcal)}  ${r.kcal_per_h ? `${kcal(r.kcal_per_h)}/h` : ""}`; } } }],
  }), [rows, t]);
  if (!rows.length) return <Unavailable what="Energy by type" why="No recordings with a calorie figure in this period." />;
  return (
    <>
      <EChart option={option} height={Math.max(110, rows.length * 34 + 34)} label={`Calories by type: ${rows.map((r) => `${sportLabel(r.sport)} ${r.kcal}`).join(", ")}`} />
      <Note>Total kcal; right of each bar, kcal per hour of recorded time. {total ? `${kcal(total)} kcal in all.` : ""}</Note>
    </>
  );
}

/** Every session as a point: minutes against calories, one marker shape per type, with
 * faint lines of equal intensity so a hard short session reads differently from a long easy one. */
export function EnergySessions({ d }: { d: EnergyData }) {
  const t = useTokens();
  const sports = d.sports;
  const pts = d.sessions.filter((s) => s.minutes);
  const maxMin = Math.max(30, ...pts.map((s) => s.minutes as number));
  const xMax = Math.ceil(maxMin / 30) * 30;
  const option = useMemo(() => ({
    ...baseOption(t),
    tooltip: { ...baseOption(t).tooltip, ...touchTip(), trigger: "item", formatter: (p: any) => {
      const s = p.data?.s; if (!s) return "";
      return `${s.name || sportLabel(s.sport)}<br/>${shortDate(s.date)} · ${fmt(s.minutes, 0)} min<br/>${kcal(s.kcal)} kcal · ${kcal((s.kcal / s.minutes) * 60)} kcal/h`;
    } },
    grid: { left: 48, right: 56, top: 28, bottom: 40 },
    xAxis: { type: "value", name: "minutes", nameLocation: "middle", nameGap: 22, min: 0, max: xMax, ...axisBase(t), splitNumber: 4 },
    yAxis: { type: "value", name: "kcal", nameGap: 10, ...axisBase(t), splitNumber: 4 },
    series: [
      ...RATES.map((r) => ({ type: "line", silent: true, symbol: "none", z: 1, tooltip: { show: false }, lineStyle: { color: t.grat, type: [2, 3], width: 1 },
        data: [[0, 0], [xMax, (r * xMax) / 60]], endLabel: { show: true, formatter: `${r}/h`, color: t.ink3, fontFamily: t.mono, fontSize: 9.5 },
        clip: true })),
      ...sports.map((sp, i) => ({ name: sportLabel(sp), type: "scatter", z: 3, symbol: SYMBOLS[i % SYMBOLS.length], symbolSize: 9,
        itemStyle: { color: t.ink2, borderColor: t.screen, borderWidth: 1, opacity: 0.9 },
        data: pts.filter((s) => s.sport === sp).map((s) => ({ value: [s.minutes, s.kcal], s })) })),
    ],
  }), [pts, sports, t, xMax]);
  if (!pts.length) return <Unavailable what="Sessions" why="No recordings with a calorie figure and a duration in this period." />;
  const rate = (s: { kcal: number; minutes: number | null }) => (s.kcal / (s.minutes as number)) * 60;
  const hardest = pts.reduce((a, b) => (rate(b) > rate(a) ? b : a));
  const biggest = pts.reduce((a, b) => (b.kcal > a.kcal ? b : a));
  return (
    <>
      <Readout items={[
        ["Sessions", String(pts.length), "", d.without ? `${d.without} without kcal` : ""],
        ["Biggest", kcal(biggest.kcal), "kcal", sportCode(biggest.sport)],
        ["Hardest", kcal(rate(hardest)), "kcal/h", sportCode(hardest.sport)],
      ]} compact />
      <div className="legend" aria-hidden="true">{sports.map((sp, i) => (
        <span key={sp} className="lg-i"><svg width="12" height="12" viewBox="-6 -6 12 12"><path d={SHAPE_PATH[SYMBOLS[i % SYMBOLS.length]]} fill="var(--s-ink-2)" /></svg>{sportCode(sp)}</span>
      ))}</div>
      <EChart option={option} height={250} label={`Calories against minutes for ${pts.length} sessions`} />
      <Note>One point per session. Dotted lines are equal intensity (kcal per hour): up-left is harder.</Note>
    </>
  );
}

const SHAPE_PATH: Record<(typeof SYMBOLS)[number], string> = {
  circle: "M-5,0a5,5 0 1,0 10,0a5,5 0 1,0 -10,0", rect: "M-4.5,-4.5h9v9h-9z", triangle: "M0,-5.5L5.5,4.5H-5.5z",
  diamond: "M0,-6L6,0L0,6L-6,0z", pin: "M0,5.5C-6,-1 -4,-6 0,-6C4,-6 6,-1 0,5.5z", arrow: "M0,-6L5,5L0,2L-5,5z",
};
