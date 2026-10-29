import { useCallback, useMemo, useState } from "react";
import { EChart, type EChartsType } from "../charts/EChart";
import { axisBase, baseOption, useTokens } from "../charts/theme";
import { shortDate } from "../ui/dates";
import { useBests } from "./api";
import { fmt, hms, paceStr, touchTip } from "../health/charts/parts";
import type { ActivityDetail, ActivityStats, BestsData } from "../health/types";
import { Note, Seg } from "./controls";
import { useInset } from "./inset";
import { deltaTime, distLabel, fixed, lapTime, windowLabel, type SportView } from "./model";
import type { Win } from "./selection";

type Measure = "speed" | "power";

/** This activity's speed–duration curve against the best of the period and of all time, and
 * its fastest distances with the personal bests beside them. Picking one of this activity's efforts
 * (a point on the curve, a distance in the table) shows it as the window on the Overview trace. */
export function EffortsTab({ d, st, v, days, words, setWin }: {
  d: ActivityDetail; st: ActivityStats; v: SportView; days: number; words: string; setWin: (w: Win) => void;
}) {
  const q = useBests(d.type ?? d.sport, days);
  const power = !!st.best.time.some((b) => b.power);
  const [m, setM] = useState<Measure>("speed");
  const mm = power ? m : "speed";
  const b = q.data;
  return (
    <div className="av-stack">
      <div className="screen chart-screen">
        <div className="av-ctl">
          <span className="silk">Best {mm === "power" ? "power" : v.primary === "pace" ? "pace" : "speed"} by duration</span>
          <span className="fill" />
          {power && <Seg label="Measure" value={mm} onChange={(k) => setM(k as Measure)} options={[{ key: "speed", label: "Speed" }, { key: "power", label: "Power" }]} />}
        </div>
        <Curve st={st} b={b} v={v} m={mm} words={words} setWin={setWin} />
        <Note more={<>Best average over each window (distance ÷ time). {st.best.rest_cut ? `A window never spans a rest of a minute or more, so durations longer than your longest block (${hms(st.best.longest_block_s)}) are left out. ` : ""}{b ? `Period: ${words}, ${b.n_period} session${b.n_period === 1 ? "" : "s"}; all time: ${b.n_all}.` : ""}</>}>
          Higher is better: each point is your best average over that long. {st.best.rest_cut ? "Within one block: a window never spans a rest. " : ""}{b ? `Compared with your best of the ${words}.` : q.isPending ? "Loading your bests…" : ""} Click a point of this activity to see where it happened.
        </Note>
      </div>
      <DistTable st={st} b={b} v={v} self={d.id} setWin={setWin} />
    </div>
  );
}

function Curve({ st, b, v, m, words, setWin }: { st: ActivityStats; b: BestsData | undefined; v: SportView; m: Measure; words: string; setWin: (w: Win) => void }) {
  const t = useTokens();
  const inset = useInset();
  const pace = v.primary === "pace" && m === "speed";
  const wins = useMemo(() => (b ? b.windows.map((w) => w.secs) : st.best.time.map((x) => x.secs)), [b, st]);
  const option = useMemo(() => {
    const val = (sp: number | null | undefined, p: number | null | undefined) => (m === "power" ? p ?? null : pace ? (sp ? 3600 / sp : null) : sp ?? null);
    const mine = wins.map((s) => { const x = st.best.time.find((y) => y.secs === s); return x ? val(x.speed_kmh, x.power) : null; });
    const per = wins.map((s) => { const w = b?.windows.find((y) => y.secs === s); return w ? (m === "power" ? w.power_period?.power ?? null : val(w.period?.speed_kmh, null)) : null; });
    const all = wins.map((s) => { const w = b?.windows.find((y) => y.secs === s); return w ? (m === "power" ? w.power_all?.power ?? null : val(w.all?.speed_kmh, null)) : null; });
    const fmtV = (x: number) => (m === "power" ? `${fmt(x, 0)} W` : pace ? `${paceStr(x)} /km` : `${fmt(x, 1)} km/h`);
    const line = (name: string, data: (number | null)[], color: string, type: number[] | "solid", symbol: string, w: number) =>
      ({ name, type: "line", data, connectNulls: false, symbol, symbolSize: 7, lineStyle: { color, width: w, type }, itemStyle: { color, borderColor: color } });
    return {
      ...baseOption(t),
      tooltip: { ...baseOption(t).tooltip, ...touchTip(), valueFormatter: (x: number) => (x == null ? "—" : fmtV(x)) },
      grid: { left: inset + 20, right: inset + 10, top: 14, bottom: 24 },
      xAxis: { type: "category", data: wins.map(windowLabel), boundaryGap: false, ...axisBase(t), splitLine: { show: false } },
      yAxis: { type: "value", scale: true, inverse: pace, splitNumber: 4, ...axisBase(t),
        axisLabel: { ...axisBase(t).axisLabel, formatter: (x: number) => (pace ? paceStr(x) : fmt(x, 0)) } },
      series: [
        line("All time", all, t.ink3, [1, 3], "triangle", 1.2),
        line(`Best ${words}`, per, t.ink2, [5, 3], "rect", 1.2),
        line("This activity", mine, t.ink, "solid", "circle", 1.6),
      ],
    };
  }, [st, b, m, pace, t, words, wins, inset]);
  const onReady = useCallback((c: EChartsType) => {
    c.off("click");
    c.on("click", (p: { seriesName?: string; dataIndex?: number }) => {
      const x = p.seriesName === "This activity" ? st.best.time.find((y) => y.secs === wins[p.dataIndex ?? -1]) : null;
      if (x) setWin([x.start_s, x.end_s]);
    });
  }, [st, wins, setWin]);
  return (
    <>
      <EChart option={option} height={200} onReady={onReady} label="Speed–duration curve: this activity against the period best and the all-time best" />
      <div className="legend" aria-hidden="true">
        <span className="lg-i"><svg width="16" height="10"><line x1="0" y1="5" x2="16" y2="5" stroke="var(--s-ink)" strokeWidth="1.6" /><circle cx="8" cy="5" r="3" fill="var(--s-ink)" /></svg>this activity</span>
        <span className="lg-i"><svg width="16" height="10"><line x1="0" y1="5" x2="16" y2="5" stroke="var(--s-ink-2)" strokeDasharray="5 3" /><rect x="5.5" y="2" width="5" height="6" fill="var(--s-ink-2)" /></svg>period best</span>
        <span className="lg-i"><svg width="16" height="10"><line x1="0" y1="5" x2="16" y2="5" stroke="var(--s-ink-3)" strokeDasharray="1 3" /><path d="M8,1L12,9H4Z" fill="var(--s-ink-3)" /></svg>all time</span>
      </div>
    </>
  );
}

function DistTable({ st, b, v, self, setWin }: { st: ActivityStats; b: BestsData | undefined; v: SportView; self: string; setWin: (w: Win) => void }) {
  const rows = (b?.distances ?? st.best.distance.map((x) => ({ distance_m: x.distance_m, period: null, all: null })))
    .filter((r) => st.best.distance.some((x) => x.distance_m === r.distance_m) || r.all);
  if (!rows.length) return null;
  const pace = v.primary === "pace";
  return (
    <div className="tbl-wrap">
      <div className="av-ctl bare"><span className="silk">Fastest distances</span><span className="fill" /><span className="hint-l">tap a distance to see it on the trace</span></div>
      <table className="av-tbl">
        <thead>
          <tr><th scope="col">Dist</th><th scope="col">This</th><th scope="col">{pace ? "min/km" : "km/h"}</th>
            {v.both && <th scope="col" className="hide-s">min/km</th>}<th scope="col">PB</th><th scope="col">Δ PB</th><th scope="col" className="hide-s">PB on</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const mine = st.best.distance.find((x) => x.distance_m === r.distance_m);
            const isPb = r.all?.id === self;
            return (
              <tr key={r.distance_m} className={isPb ? "best" : ""}>
                <td className="mono">{mine
                  ? <button type="button" className="link" onClick={() => setWin([mine.start_s, mine.end_s])} aria-label={`Show the fastest ${distLabel(r.distance_m)} on the trace`}>{distLabel(r.distance_m)}</button>
                  : distLabel(r.distance_m)}</td>
                <td className="mono">{mine ? lapTime(mine.time_s) : "—"}{isPb && <span className="tag best-tag">PB</span>}</td>
                <td className="mono strong">{mine ? (pace ? paceStr(mine.pace_s_km) : fixed(mine.speed_kmh)) : "—"}</td>
                {v.both && <td className="mono hide-s">{mine ? paceStr(mine.pace_s_km) : "—"}</td>}
                <td className="mono">{r.all ? lapTime(r.all.time_s) : "—"}</td>
                <td className="mono">{mine && r.all && !isPb ? deltaTime(mine.time_s - r.all.time_s) : isPb ? "PB" : "—"}</td>
                <td className="mono hide-s">{r.all ? shortDate(r.all.date) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="tbl-note">Fastest stretch of each distance, never across a rest. PB = fastest of all recorded {v.primary === "pace" ? "runs" : "sessions"}.</p>
    </div>
  );
}
