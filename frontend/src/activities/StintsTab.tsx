import { useMemo, useState } from "react";
import { Readout, fmt, hms, paceStr } from "../health/charts/parts";
import type { ActivityDetail, ActivityStats, Stint } from "../health/types";
import { Note, Seg } from "./controls";
import { fixed, mean, restsOf, signed, type SportView } from "./model";
import { sameWindow, type Win } from "./selection";
import { SPEED_HR } from "./Trace";
import { TracePanel } from "./TracePanel";

/** Stints (efforts above a threshold). One control row (the definition), one chart (speed and HR
 * with the stints shaded) and a ladder ranked by speed; a tapped rung becomes the window on the chart. */
export function StintsTab({ d, st, v, def, setDef, win, setWin, cursor, setCursor }: {
  d: ActivityDetail; st: ActivityStats; v: SportView; def: string; setDef: (k: string) => void;
  win: Win | null; setWin: (w: Win | null) => void; cursor: number | null; setCursor: (t: number | null) => void;
}) {
  const rests = useMemo(() => restsOf(st), [st]);
  const S = st.lapsets.stints;
  const [all, setAll] = useState(false);
  const [sort, setSort] = useState<"speed" | "time">("speed");
  const cur = S?.defs.find((x) => x.key === def) ?? S?.defs.find((x) => x.key === "rel") ?? S?.defs[0];
  const rows = useMemo(() => (cur && S ? S.sets[cur.key] ?? [] : []), [S, cur]);
  const areas = useMemo(() => rows.map((x) => [x.start_s, x.start_s + x.time_s] as [number, number]), [rows]);
  if (!S || !cur) return null;
  const span = (x: Stint): Win => [x.start_s, x.start_s + x.time_s];
  const ladder = [...rows].sort((a, b) => (sort === "speed" ? (b.speed_kmh ?? 0) - (a.speed_kmh ?? 0) : a.start_s - b.start_s));
  const inStints = rows.reduce((a, x) => a + x.time_s, 0);
  const top = ladder[0];
  const order = [...S.defs].sort((a) => (a.key === "rel" ? -1 : 1));
  return (
    <div className="av-stack">
      <div className="screen chart-screen">
        <div className="av-ctl">
          <span className="silk hide-narrow">Stint =</span>
          <Seg label="Stint definition" value={cur.key} onChange={(k) => { setDef(k); setWin(null); }}
            options={order.map((x) => ({ key: x.key, label: x.key === "rel" ? `Median + 15 % · ${fixed(x.threshold_kmh)}` : `≥ ${fixed(x.threshold_kmh, 0)} km/h` }))} />
        </div>
        <Readout compact items={[
          ["Stints", String(rows.length)],
          ["In stints", hms(inStints), "", `${fmt((inStints / Math.max(1, st.totals.moving_s)) * 100, 0)}% moving`],
          ["Fastest", fixed(top?.speed_kmh), "km/h", "avg"],
          ["Peak", rows.length ? fixed(Math.max(...rows.map((x) => x.peak_kmh))) : "—", "km/h"],
          ["Median", rows.length ? hms([...rows].sort((a, b) => a.time_s - b.time_s)[Math.floor(rows.length / 2)].time_s) : "—", "", "length"],
          ["HR drop", fmt(mean(rows.map((x) => x.hr_drop_60)), 0), "bpm", "in 60 s"],
        ]} />
        <Note more={<>{cur.rule} Stints are found on speed smoothed over 3 s (distance ÷ time), so sparse samples do not split one. HR rise = start to peak (up to 20 s after the end, HR lags); the drop is peak to 60 s after the end.</>}>
          {cur.rule}
        </Note>
      </div>
      <TracePanel s={d.stream!} v={v} totals={st.totals} panels={SPEED_HR} areas={areas} shading="stint" rests={rests} threshold={cur.threshold_kmh}
        win={win} setWin={setWin} cursor={cursor} setCursor={setCursor} title={`Speed · HR with ${rows.length} stints`}
        help={<>Grey bands are stints: speed above the dashed line for long enough. Pick a stint below to measure it.</>} />
      {rows.length ? (
        <div className="screen chart-screen">
          <div className="av-ctl">
            <span className="silk">Ladder</span><span className="fill" />
            <Seg label="Order" value={sort} onChange={(k) => setSort(k as "speed" | "time")} options={[{ key: "speed", label: "Fastest" }, { key: "time", label: "In order" }]} />
          </div>
          <div className="laplist ladder" style={{ "--k": 6 } as React.CSSProperties}>
            <div className="lr lr-h silk" aria-hidden="true">
              <span>{sort === "speed" ? "Rank" : "#"}</span><span>Time</span><span>km/h</span>
              <span className="lr-sec"><span>min/km</span><span>Starts</span><span>Dist</span><span>Peak</span><span>HR in stint</span><span>HR 60 s later</span></span>
            </div>
            <ul>
              {(all ? ladder : ladder.slice(0, 12)).map((x: Stint, i) => (
                <li key={x.n}><button type="button" className={`lr ${sameWindow(win, span(x)) ? "sel" : ""}`} aria-pressed={sameWindow(win, span(x))}
                  onClick={() => setWin(sameWindow(win, span(x)) ? null : span(x))}
                  aria-label={`Stint ${x.n} at ${hms(x.start_s)}: ${fixed(x.speed_kmh)} km/h for ${hms(x.time_s)}, ${paceStr(x.pace_s_km)} per km`}>
                  <span className="mono lr-n">{sort === "speed" ? i + 1 : x.n}</span>
                  <span className="mono strong">{hms(x.time_s)}</span>
                  <span className="mono strong">{fixed(x.speed_kmh)}</span>
                  <span className="lr-sec mono">
                    <span>{paceStr(x.pace_s_km)}<u> /km</u></span>
                    <span><u>starts </u>{hms(x.start_s)}</span>
                    <span>{fmt(x.distance_m, 0)}<u> m</u></span>
                    <span><u>peak </u>{fixed(x.peak_kmh)}<u> km/h</u></span>
                    <i className="lr-brk" />
                    <span><u>HR </u>{signed(x.hr_rise, 0)}<u> in the stint</u></span>
                    <span><u>60 s later </u>{x.hr_drop_60 == null ? "—" : signed(-x.hr_drop_60, 0)}</span>
                  </span>
                </button></li>
              ))}
            </ul>
          </div>
          {ladder.length > 12 && (
            <button type="button" className="key flat act-more" aria-expanded={all} onClick={() => setAll(!all)}>{all ? "Show the top 12" : `Show all ${ladder.length} stints`}</button>
          )}
          <p className="tbl-note">Tap a stint to measure it on the chart. HR in the stint = start to peak; 60 s after = change from the peak.</p>
        </div>
      ) : <div className="screen chart-screen"><p className="chart-note">No stint by this definition. Try the other one.</p></div>}
    </div>
  );
}
