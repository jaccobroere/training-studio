import { useMemo } from "react";
import { EChart } from "../../charts/EChart";
import { axisBase, baseOption, useTokens } from "../../charts/theme";
import { useMobile } from "../../app/useMedia";
import { shortDate } from "../../ui/dates";
import type { EfficiencyData } from "../types";
import { Note } from "../../activities/controls";
import { Readout, Unavailable, fmt, touchTip } from "./parts";

const ms = (iso: string) => Date.parse(`${iso}T12:00:00Z`);

/** Efficiency factor per session over months (steady sessions filled, the rest hollow) with the
 * monthly median, and aerobic decoupling of the steady ones against the 5 % line. */
export function EfficiencyTrend({ d }: { d: EfficiencyData }) {
  const t = useTokens();
  const mobile = useMobile();
  const unit = d.unit ?? "";
  const pts = d.points.filter((p) => p.ef_unit === d.unit);
  const option = useMemo(() => ({
    ...baseOption(t),
    tooltip: { ...baseOption(t).tooltip, ...touchTip(), trigger: "item", formatter: (p: any) => {
      const x = p.data?.p;
      if (!x) return p.data?.m ? `${p.data.m}: median ${fmt(p.value[1], 2)} ${unit}` : "";
      return `${x.name}<br/>${shortDate(x.date)} · ${fmt(x.moving_min, 0)} min<br/>EF ${fmt(x.ef, 2)} ${unit} · ${fmt(x.avg_hr, 0)} bpm${x.decoupling_pct != null ? `<br/>decoupling ${fmt(x.decoupling_pct, 1)} %` : ""}${x.steady ? "" : "<br/>not steady (HR)"}`;
    } },
    // Two grids on one canvas: the unit of each sits above its own plot (never on the top edge of
    // the canvas). The band between them fits the lower plot's name AND stays clear of the upper
    // plot's last tick label, which is centred on the upper grid's floor ("1.25" then "decoupling %").
    grid: [{ left: 48, right: 14, top: 24, height: 126 }, { left: 48, right: 14, top: 192, height: 88 }],
    xAxis: [0, 1].map((i) => ({ type: "time", gridIndex: i, ...axisBase(t), splitLine: { show: false },
      // Only the lower plot carries dates, so only it gets ticks: the upper plot's marks had no labels.
      axisTick: { ...axisBase(t).axisTick, show: i === 1 },
      // On a phone the default five splits put the axis end a few pixels from the month before it
      // ("1 Sep 17 Sep"); monthly ticks date a monthly trend better there. Wider cards keep the
      // default, where the same ticks have room.
      splitNumber: i === 1 && mobile ? 3 : undefined,
      axisLabel: i ? { ...axisBase(t).axisLabel, hideOverlap: true, formatter: (v: number) => shortDate(new Date(v).toISOString().slice(0, 10)) } : { show: false } })),
    yAxis: [
      { type: "value", gridIndex: 0, scale: true, splitNumber: 3, name: unit, nameLocation: "end", nameGap: 8, ...axisBase(t),
        nameTextStyle: { ...axisBase(t).nameTextStyle, align: "right", padding: [0, 4, 0, 0] }, axisLabel: { ...axisBase(t).axisLabel, formatter: (v: number) => fmt(v, 2) } },
      { type: "value", gridIndex: 1, splitNumber: 2, name: "decoupling %", nameLocation: "end", nameGap: 8, ...axisBase(t),
        nameTextStyle: { ...axisBase(t).nameTextStyle, align: "left", padding: [0, 0, 0, -40] } },
    ],
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    series: [
      { type: "scatter", xAxisIndex: 0, yAxisIndex: 0, symbolSize: 7, data: pts.filter((p) => !p.steady).map((p) => ({ value: [ms(p.date), p.ef], p })),
        itemStyle: { color: "transparent", borderColor: t.ink3, borderWidth: 1 } },
      { type: "scatter", xAxisIndex: 0, yAxisIndex: 0, symbolSize: 7, data: pts.filter((p) => p.steady).map((p) => ({ value: [ms(p.date), p.ef], p })),
        itemStyle: { color: t.ink2, borderColor: t.screen, borderWidth: 1 } },
      { type: "line", xAxisIndex: 0, yAxisIndex: 0, symbol: "rect", symbolSize: 6, data: d.monthly.filter((m) => m.ef != null).map((m) => ({ value: [ms(`${m.month}-15`), m.ef], m: m.month })),
        lineStyle: { color: t.ink, width: 1.4 }, itemStyle: { color: t.ink } },
      { type: "bar", xAxisIndex: 1, yAxisIndex: 1, barMaxWidth: 6, data: pts.filter((p) => p.steady && p.decoupling_pct != null).map((p) => ({ value: [ms(p.date), p.decoupling_pct], p })),
        itemStyle: { color: t.ink2 }, markLine: { silent: true, symbol: "none", lineStyle: { color: t.ink, type: [4, 3], width: 1 },
          label: { show: true, formatter: "5 %", color: t.ink2, fontFamily: t.mono, fontSize: 10, position: "insideEndTop" }, data: [{ yAxis: 5 }] } },
    ],
  }), [pts, d, t, unit, mobile]);
  if (!pts.length) return <Unavailable what="Efficiency" why="No sessions of this type with heart rate and a stream in this period." />;
  const months = d.monthly.filter((m) => m.ef != null);
  const first = months[0], last = months[months.length - 1];
  const change = first && last && first !== last && first.ef ? ((last.ef! - first.ef) / first.ef) * 100 : null;
  const dcs = pts.filter((p) => p.steady && p.decoupling_pct != null).map((p) => p.decoupling_pct!);
  return (
    <>
      <Readout compact items={[
        ["Sessions", String(pts.length), "", `of which ${d.n_steady} steady`],
        ["Latest month", fmt(last?.ef, 2), unit],
        ["Change", change == null ? "—" : `${change > 0 ? "+" : ""}${fmt(change, 1)}`, change == null ? "" : "%", change == null ? "" : `since ${first.month}`],
        ["Decoupling", dcs.length ? fmt(dcs.sort((a, b) => a - b)[Math.floor(dcs.length / 2)], 1) : "—", "%", "median"],
      ]} />
      <div className="legend" aria-hidden="true">
        <span className="lg-i"><svg width="10" height="10"><circle cx="5" cy="5" r="3.5" fill="var(--s-ink-2)" /></svg>steady session</span>
        <span className="lg-i"><svg width="10" height="10"><circle cx="5" cy="5" r="3.5" fill="none" stroke="var(--s-ink-3)" /></svg>other</span>
        <span className="lg-i"><svg width="18" height="10"><line x1="0" y1="5" x2="18" y2="5" stroke="var(--s-ink)" strokeWidth="1.4" /><rect x="6" y="2" width="6" height="6" fill="var(--s-ink)" /></svg>monthly median</span>
      </div>
      <EChart option={option} height={320} label={`Efficiency factor for ${pts.length} sessions with monthly medians; decoupling below`} />
      <Note more={<>{d.rule}</>}>Higher = more {unit === "W/bpm" ? "power" : "distance"} per heartbeat at the same effort; it rises as fitness builds.</Note>
    </>
  );
}
