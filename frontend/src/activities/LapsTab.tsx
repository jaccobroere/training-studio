import { Fragment, useCallback, useMemo, useState } from "react";
import { useMobile } from "../app/useMedia";
import { niceStep } from "../charts/axis";
import { EChart, type EChartsType } from "../charts/EChart";
import { axisBase, baseOption, useTokens } from "../charts/theme";
import { Readout, fmt, hms, paceStr, touchTip } from "../health/charts/parts";
import type { ActivityDetail, ActivityStats, BlockLaps, BlockRow, Lap, LapSet } from "../health/types";
import { Choice, Fold, Note } from "./controls";
import { useInset } from "./inset";
import { LAP_LABEL, bestLapCell, deltaTime, fixed, halfSplit, lapAxis, lapTime, median, quantile, restsOf, signed, type SportView } from "./model";
import { RouteMap } from "./Route";
import { sameWindow, type Win } from "./selection";
import { SPEED_HR } from "./Trace";
import { TracePanel } from "./TracePanel";

const SHOW = 30;
const span = (l: Lap): Win => [l.start_s, l.start_s + l.time_s];

/** Laps from one source at a time (one control row), as a table you can read lap by lap, a chart of
 * every lap, and the trace with the laps banded. A lap you pick (table row or chart point) becomes the
 * window on the trace. With rests in the session the laps carry a "rest 1:40" divider where each
 * block starts; the per-block summary sits behind a disclosure. */
export function LapsTab({ d, st, v, stintDef, src, setSrc, win, setWin, cursor, setCursor }: {
  d: ActivityDetail; st: ActivityStats; v: SportView; stintDef: string; src: string; setSrc: (k: string) => void;
  win: Win | null; setWin: (w: Win | null) => void; cursor: number | null; setCursor: (t: number | null) => void;
}) {
  const L = st.lapsets;
  const keyOf = (k: string) => (k === "stints" ? `stints:${stintDef}` : k);
  const avail = v.laps.filter((k) => !!L.sets[keyOf(k)]);
  const key = avail.includes(src) ? src : avail[0];
  const set = key ? L.sets[keyOf(key)] : null;
  const rests = useMemo(() => restsOf(st), [st]);
  const areas = useMemo(() => (set ? set.laps.filter((l) => l.n % 2 === 1).map(span) : []), [set]);
  if (!set) return <div className="screen chart-screen"><p className="chart-note">No laps: the recording is shorter than one lap.</p></div>;
  return (
    <div className="av-stack">
      <div className="screen chart-screen">
        <div className="av-ctl">
          <span className="silk hide-narrow">Laps by</span>
          <Choice label="Lap source" value={key} onChange={setSrc} primary={avail.slice(0, 3)}
            options={avail.map((k) => ({ key: k, label: LAP_LABEL[k] ?? k }))} />
        </div>
        <LapReadout set={set} blocks={L.blocks.length} rest={L.rest_s} v={v} />
        <LapChart set={set} v={v} win={win} setWin={setWin} />
        <LapNote keyName={key} set={set} st={st} />
      </div>
      <TracePanel s={d.stream!} v={v} totals={st.totals} panels={SPEED_HR} areas={areas} shading="alternate laps" rests={rests}
        win={win} setWin={setWin} cursor={cursor} setCursor={setCursor} title={`${v.primary === "pace" ? "Pace" : "Speed"} · HR by lap`}
        help={<>Each shaded or plain stretch is one lap, so you can see where in the session a quick or slow lap happened. Pick a lap in the table to measure it here.</>} />
      {key === "gate" && st.route && L.gate && <GateFold st={st} />}
      <div className="screen chart-screen">
        <LapList laps={set.laps} set={set} v={v} blocks={L.blocks} win={win} setWin={setWin} />
      </div>
      {set.by_block && L.blocks.length > 1 && (
        <Fold title="By block" open hint={`${L.blocks.length} blocks · ${hms(L.rest_s)} rest`}>
          <Blocks set={set} blocks={L.blocks} v={v} win={win} setWin={setWin} />
        </Fold>
      )}
    </div>
  );
}

function GateFold({ st }: { st: ActivityStats }) {
  const mobile = useMobile();
  const g = st.lapsets.gate!;
  return (
    <Fold title="Gate" open={!mobile} hint={`${g.passes}× passed · heading ${g.heading_deg}°`}>
      <RouteMap r={st.route!} cursor={null} gate={g} h={160} />
      <Note>The point passed most often, nearest the start; a lap ends at each crossing in the main direction.</Note>
    </Fold>
  );
}

function LapNote({ keyName, set, st }: { keyName: string; set: LapSet; st: ActivityStats }) {
  const smp = st.sampling;
  const prec = smp.smart && smp.median_s ? ` About ±${fmt(smp.median_s / 2, 1)} s at ~${fmt(smp.median_s, 0)} s sampling.` : "";
  const head = /^d\d/.test(keyName) ? `Every ${LAP_LABEL[keyName]}${st.lapsets.blocks.length > 1 ? ", restarted after each rest" : ""}.`
    : keyName === "gate" ? "One lap per crossing of the gate." : keyName === "device" ? "The watch's own laps." : "Each stint as a lap.";
  return (
    <Note more={<>
      Boundaries are interpolated between samples. Consistency (CV) and fade use the {set.n_steady} steady lap{set.n_steady === 1 ? "" : "s"}: complete, under 5 % stopped; fade is the slope per lap.
      {set.spans_rest ? ` ${set.spans_rest} lap${set.spans_rest === 1 ? " spans" : "s span"} a rest and ${set.spans_rest === 1 ? "is" : "are"} left out.` : ""}
      {smp.smart && smp.median_s ? ` The watch recorded a sample every ~${fmt(smp.median_s, 1)} s (up to ${fmt(smp.p95_s, 0)} s), so a lap time is good to about ±${fmt(smp.median_s / 2, 1)} s.` : ""}
    </>}>{head}{prec}</Note>
  );
}

function LapReadout({ set, blocks, rest, v }: { set: LapSet; blocks: number; rest: number; v: SportView }) {
  const best = set.laps.find((l) => l.n === set.best_n);
  const time = set.compare === "time";
  const steady = set.laps.filter((l) => l.steady);
  const med = median(steady.map((l) => (time ? l.time_s : l.speed_kmh)));
  const bc = bestLapCell(set.compare, best);
  // Equal-length laps only: the second half of a run against the first (negative = got faster).
  const half = time ? halfSplit(steady.map((l) => l.time_s)) : null;
  return (
    <Readout compact items={[
      ["Laps", String(set.n_full), "", set.n > set.n_full ? `+ ${set.n - set.n_full} part` : ""],
      ["Best", bc.value, bc.unit, bc.note, true],
      ["Median", med == null ? "—" : time ? lapTime(med) : fixed(med), time ? "" : "km/h", time && v.both && best ? `${fixed(median(steady.map((l) => l.speed_kmh)))} km/h` : ""],
      ["CV", fmt(set.cv_pct, 1), "%", "lap to lap"],
      ["Fade", set.fade == null ? "—" : signed(set.fade, 2), time ? "s per lap" : "km/h per lap"],
      half != null && blocks <= 1 ? ["Halves", signed(half, 1), "s", "2nd vs 1st"] : blocks > 1 ? ["Blocks", String(blocks), "", `${hms(rest)} rest`] : ["Steady", String(set.n_steady), "laps"],
    ]} />
  );
}

/** One point per lap on a speed axis for skating (km/h for every lap source, so the axis cannot
 * flip between lap time and speed when you change source) or the server's lap-time/speed axis for
 * the other sports. Scaled to the comparable laps, so a 2 s difference shows: best = the signal, a
 * stop in the lap hollow, a gap where a rest was. A part lap is not comparable and stays in the
 * table. Dashed = the median; the thin line is each lap's heart rate (right axis). Picking a point
 * selects that lap as the window.
 *
 * The y-domain is anchored on the best lap and capped at the 9th decile (10th for speed), so one lap
 * that took a breather cannot flatten every other point onto the floor. Laps beyond that cap are not
 * drawn on the line — they would only be a spike — but keep their place on the x axis as a small
 * hollow triangle on the top gridline, and stay readable in the table. The x axis is the lap number
 * itself (a value axis), so the tick step is even and no label is dropped to avoid a collision. */
function LapChart({ set, v, win, setWin }: { set: LapSet; v: SportView; win: Win | null; setWin: (w: Win | null) => void }) {
  const t = useTokens();
  const inset = useInset();
  const time = lapAxis(v, set.compare) === "time";
  // A part lap is not comparable: it stays in the table. A rest leaves a break (a null point) between
  // the two blocks, so the line never joins across a stop.
  const pts = useMemo(() => {
    const out: { n: number; l: Lap | null }[] = [];
    const full = set.laps.filter((l) => !l.partial);
    full.forEach((l, i) => {
      if (i && l.block !== full[i - 1].block) out.push({ n: (full[i - 1].n + l.n) / 2, l: null });
      out.push({ n: l.n, l });
    });
    return out;
  }, [set]);
  const cells = useMemo(() => pts.map((p) => p.l), [pts]);
  const vals = useMemo(() => cells.map((l) => (l ? (time ? l.time_s : l.speed_kmh) : null)), [cells, time]);
  const med = useMemo(() => median(set.laps.filter((l) => l.steady).map((l) => (time ? l.time_s : l.speed_kmh))), [set, time]);
  const hasHr = set.laps.some((l) => l.avg_hr);
  // The scale, the laps that sit above it, and how many are worth a key line.
  const domain = useMemo(() => {
    const all = vals.filter((x): x is number => x != null);
    const steady = cells.filter((l): l is Lap => !!l && !!l.steady).map((l) => (time ? l.time_s : l.speed_kmh)).filter((x): x is number => x != null);
    const ok = steady.length >= 4 ? steady : all;
    if (!ok.length) return { lo: 0, hi: 1, step: 1 };
    const best = time ? Math.min(...ok) : Math.max(...ok);
    const far = ok.length >= 8 ? quantile(ok, time ? 0.9 : 0.1) : time ? Math.max(...ok) : Math.min(...ok);
    const lo0 = Math.min(best, far), hi0 = Math.max(best, far);
    const air = Math.max(time ? 2 : 0.3, (hi0 - lo0) * 0.14);
    const rawLo = Math.max(0, lo0 - air), rawHi = hi0 + air;
    const raw = rawHi - rawLo;
    // Ticks from a 1-2-5 ladder keep the labels on clean multiples (2:20, 2:30, …, never a rounded ":60").
    const ladder = time ? [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300, 600] : [0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];
    const step = ladder.find((s) => raw / s <= 5) ?? (time ? Math.ceil(raw / 240) * 60 : Math.ceil(raw / 200) * 50);
    // The fast end of a time axis is the best lap: start within one step of it, never a whole tick
    // below, so the best lap is not stranded in dead space. (For speed the fast end is the top, and
    // the top keeps its padding.)
    const lo = time ? Math.floor(lo0 / step) * step : Math.floor(rawLo / step) * step;
    return { lo: Math.max(0, lo), hi: Math.ceil(rawHi / step) * step, step };
  }, [vals, cells, time]);
  const offIdx = useMemo(() => vals.reduce<number[]>((out, x, i) => (x != null && (x > domain.hi || x < domain.lo) ? [...out, i] : out), []), [vals, domain]);
  const off = useMemo(() => new Set(offIdx), [offIdx]);
  const stops = useMemo(() => cells.filter((l, i) => l && l.steady === false && vals[i] != null && !off.has(i)).length, [cells, vals, off]);
  // Lap numbers every k-th, so eight or nine ticks whatever the source (25 laps or 121).
  const lastN = pts.length ? pts[pts.length - 1].n : 1;
  const every = Math.max(1, Math.ceil((lastN - 1) / 9));
  const height = 178 + Math.round((inset - 16) * 3);
  const option = useMemo(() => {
    const hr = cells.map((l) => l?.avg_hr ?? null);
    const hrOk = hr.filter((x): x is number => x != null);
    // Round, even heart-rate ticks: a raw floor/ceil of the data ("125 … 154") gives uneven steps.
    const hrStep = hrOk.length ? niceStep((Math.max(...hrOk) - Math.min(...hrOk)) / 3) : 10;
    const hrMin = hrOk.length ? Math.floor((Math.min(...hrOk) - hrStep * 0.5) / hrStep) * hrStep : undefined;
    const hrMax = hrOk.length ? Math.ceil((Math.max(...hrOk) + hrStep * 0.5) / hrStep) * hrStep : undefined;
    const sel = cells.findIndex((l) => l && sameWindow(win, span(l)));
    const bestIdx = cells.findIndex((l) => l?.n === set.best_n);
    return {
      ...baseOption(t),
      tooltip: { ...baseOption(t).tooltip, ...touchTip(), trigger: "axis", axisPointer: { type: "line", lineStyle: { color: t.signal } }, formatter: (ps: any) => {
        const i = (ps as { dataIndex?: number }[]).find((x) => x && cells[x.dataIndex ?? -1])?.dataIndex;
        const l = cells[i ?? -1];
        if (!l) return "";
        return `Lap ${l.n}${l.partial ? " (part)" : ""}${l.block != null && set.by_block ? ` · block ${l.block + 1}` : ""}<br/>${lapTime(l.time_s)} · ${fmt(l.distance_m, 0)} m<br/>${fixed(l.speed_kmh)} km/h · ${paceStr(l.pace_s_km)} /km${l.avg_hr ? `<br/>${l.avg_hr} bpm` : ""}`;
      } },
      grid: { left: inset + 30, right: inset + (hasHr ? 34 : 10), top: 30, bottom: 28 },
      xAxis: { type: "value", min: 1, max: Math.max(1, lastN), interval: every, ...axisBase(t), splitLine: { show: false },
        axisLabel: { ...axisBase(t).axisLabel, formatter: (x: number) => String(x) } },
      yAxis: [
        { type: "value", name: time ? "lap time" : "km/h", nameGap: 10, min: domain.lo, max: domain.hi, interval: domain.step, ...axisBase(t),
          axisLabel: { ...axisBase(t).axisLabel, formatter: (x: number) => (time ? hms(x) : fmt(x, 0)) } },
        ...(hasHr ? [{ type: "value", name: "bpm", nameGap: 10, min: hrMin, max: hrMax, interval: hrStep, ...axisBase(t), splitLine: { show: false },
          axisLabel: { ...axisBase(t).axisLabel, formatter: (x: number) => fmt(x, 0) } }] : []),
      ],
      series: [
        ...(hasHr ? [{ type: "line", yAxisIndex: 1, data: pts.map((p, i) => [p.n, hr[i] ?? null]), symbol: "none", connectNulls: false, silent: true, emphasis: { disabled: true }, lineStyle: { color: t.ink3, width: 1 }, z: 1 }] : []),
        { type: "line", yAxisIndex: 0, z: 3, connectNulls: false, symbol: "circle", symbolSize: 7, showAllSymbol: true,
          emphasis: { disabled: true }, itemStyle: { color: t.ink2, borderColor: t.ink2 }, lineStyle: { color: t.ink2, width: 1.2 },
          // A lap that included a stop is hollow (the key says so); a lap above the scale is not drawn
          // at all, so the line never dives to the floor and back for one outlier.
          data: pts.map((p, i) => {
            if (!p.l || off.has(i)) return [p.n, null];
            const stop = p.l.steady === false;
            return { value: [p.n, vals[i]], symbolSize: i === sel ? 11 : 7,
              ...(stop ? { itemStyle: { color: t.screen, borderColor: t.ink2, borderWidth: 1.5 } } : {}) };
          }),
          // The best lap and the laps above the scale are fixed markers: the symbol sampler may skip a
          // point among 60 dense ones, and the top-edge triangles need a style of their own.
          markPoint: { silent: true, symbol: "circle", symbolSize: 9, itemStyle: { color: t.signal, borderColor: t.signal },
            label: { show: false }, data: [
              ...(bestIdx >= 0 ? [{ coord: [pts[bestIdx].n, vals[bestIdx]] }] : []),
              ...offIdx.map((i) => {
                const v = vals[i] as number;
                const span = Math.max(1, lastN - 1), edge = Math.max(0.15, span * 0.01);
                const x = Math.min(Math.max(pts[i].n, 1 + edge), lastN - edge);
                return { coord: [x, v > domain.hi ? domain.hi : domain.lo], symbol: "triangle", symbolSize: 7,
                  symbolRotate: v < domain.lo ? 180 : 0,
                  itemStyle: { color: t.screen, borderColor: t.ink2, borderWidth: 1.3 } };
              }),
            ] },
          markLine: med != null ? { silent: true, symbol: "none", lineStyle: { color: t.ink, type: [4, 3], width: 1 }, label: { show: false }, data: [{ yAxis: med }] } : undefined },
      ],
      aria: { enabled: true, decal: { show: false } },
    };
  }, [cells, pts, vals, set, t, time, win, hasHr, med, domain, off, offIdx, every, lastN, inset]);
  const onReady = useCallback((c: EChartsType) => {
    c.off("click");
    c.on("click", (p: { dataIndex?: number }) => { const l = cells[p.dataIndex ?? -1]; if (l) setWin(sameWindow(win, span(l)) ? null : span(l)); });
  }, [cells, win, setWin]);
  return (
    <>
      <EChart option={option} height={height} onReady={onReady} label={`${time ? "Lap times" : "Lap speeds"} for ${set.n_full} laps; best lap ${set.best_n}${stops > 0 ? `; ${stops} lap${stops === 1 ? "" : "s"} include a stop` : ""}${offIdx.length ? `; ${offIdx.length} lap${offIdx.length === 1 ? "" : "s"} off the scale` : ""}`} />
      <div className="legend" aria-hidden="true">
        <span className="lg-i"><svg width="16" height="10"><circle cx="8" cy="5" r="3.5" fill="var(--signal)" /></svg>best lap</span>
        <span className="lg-i"><svg width="16" height="10"><circle cx="8" cy="5" r="3.5" fill="var(--s-ink-2)" /></svg>
          <span>{time ? "lap time" : "lap speed"}{v.both && time ? <small>km/h in the table</small> : null}</span></span>
        {stops > 0 && <span className="lg-i"><svg width="16" height="10"><circle cx="8" cy="5" r="3" fill="var(--screen)" stroke="var(--s-ink-2)" strokeWidth="1.5" /></svg>stopped during the lap</span>}
        <span className="lg-i"><svg width="16" height="10"><line x1="0" y1="5" x2="16" y2="5" stroke="var(--s-ink)" strokeDasharray="4 3" /></svg>median</span>
        {hasHr && <span className="lg-i"><svg width="16" height="10"><line x1="0" y1="5" x2="16" y2="5" stroke="var(--s-ink-3)" /></svg>average heart rate</span>}
        {offIdx.length > 0 && <span className="lg-i"><svg width="16" height="10"><path d="M8 1.6 12.5 8.4h-9Z" fill="none" stroke="var(--s-ink-2)" strokeWidth="1.3" /></svg>
          <span>{offIdx.length} off the scale</span></span>}
      </div>
    </>
  );
}

/** Block summary rows (open one for its laps) with a thin "rest 4:12" divider between blocks. */
function Blocks({ set, blocks, v, win, setWin }: { set: LapSet; blocks: BlockRow[]; v: SportView; win: Win | null; setWin: (w: Win | null) => void }) {
  const per = set.by_block!;
  const time = set.compare === "time";
  const bestBlock = set.laps.find((l) => l.n === set.best_n)?.block;
  const [open, setOpen] = useState<Set<number>>(() => new Set(bestBlock != null ? [bestBlock] : []));
  const toggle = (k: number) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  return (
    <div className="blocks">
      <div className="bk-h silk" aria-hidden="true">
        <span>Block</span><span>Time</span><span>Laps</span><span>Best</span><span>km/h</span><span>Fade</span><span />
      </div>
      <ol className="bk-list">
        {blocks.map((b, k) => {
          const p: BlockLaps | undefined = per[k];
          const isOpen = open.has(k);
          const laps = set.laps.filter((l) => l.block === k);
          return (
            <li key={b.n}>
              {b.rest_before_s >= 60 && <div className="rest" role="separator" aria-label={`Rest ${hms(b.rest_before_s)}`}><span>rest {hms(b.rest_before_s)}</span></div>}
              <button type="button" className={`bk ${isOpen ? "open" : ""} ${bestBlock === k ? "best" : ""}`} aria-expanded={isOpen} aria-controls={`bk-${k}`} onClick={() => toggle(k)}
                aria-label={`Block ${b.n}, ${hms(b.time_s)}, ${p?.n_laps ?? 0} laps, ${fixed(b.speed_kmh)} km/h`}>
                <span className="mono bk-n">{b.n}</span>
                <span className="mono">{hms(b.time_s)}</span>
                <span className="mono">{p?.n_laps ?? 0}</span>
                <span className="mono">{p?.best == null ? "—" : time ? lapTime(p.best) : fixed(p.best)}</span>
                <span className="mono strong">{fixed(b.speed_kmh)}</span>
                <span className="mono">{p?.fade == null ? "—" : signed(p.fade, 1)}</span>
                <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" /></svg>
              </button>
              {isOpen && <div id={`bk-${k}`} className="bk-body"><LapList laps={laps} set={set} v={v} blocks={[]} win={win} setWin={setWin} /></div>}
            </li>
          );
        })}
      </ol>
      <p className="tbl-note">Time = the block from start to stop; km/h = its average while moving; fade = change in lap time per lap (+ slower).</p>
    </div>
  );
}

/** One row per lap. Skaters and riders read km/h first with min/km beside it; runners read min/km
 * first with km/h beside it. Δ best and Δ median are against the steady laps; cadence shows when
 * the watch recorded it. Rows are buttons: a picked lap becomes the window. On a phone the second
 * line holds everything but time and the lead speed. */
function LapList({ laps, set, v, blocks, win, setWin }: {
  laps: Lap[]; set: LapSet; v: SportView; blocks: BlockRow[]; win: Win | null; setWin: (w: Win | null) => void;
}) {
  const [all, setAll] = useState(false);
  const rows = all ? laps : laps.slice(0, SHOW);
  const time = set.compare === "time";
  const pace = v.primary === "pace";
  const gap = laps.some((l) => l.gap_s_km != null);
  const elev = laps.some((l) => Math.abs(l.elev_delta_m ?? 0) >= 3);
  const cad = laps.some((l) => l.avg_cad);
  const ref = median(laps.filter((l) => l.steady).map((l) => (time ? l.time_s : l.speed_kmh)));
  const cols = 4 + (time ? 0 : 1) + (gap ? 1 : 0) + (elev ? 1 : 0) + (cad ? 1 : 0);
  const cls = `${gap ? "gap" : ""} ${elev ? "elev" : ""}`;
  return (
    <div className="laplist" style={{ "--k": cols } as React.CSSProperties}>
      <div className={`lr lr-h silk ${cls}`} aria-hidden="true">
        <span>Lap</span><span>Time</span><span>{pace ? "min/km" : "km/h"}</span>
        <span className="lr-sec">
          <span>{pace ? "km/h" : "min/km"}</span>{!time && <span>Dist</span>}{gap && <span>GAP</span>}<span>Δ best</span><span>Δ median</span><span>HR</span>{cad && <span>Cad</span>}{elev && <span>Elev</span>}
        </span>
      </div>
      <ul>
        {rows.map((l) => {
          const best = l.n === set.best_n;
          const stop = l.steady === false && !l.partial;
          const on = sameWindow(win, span(l));
          const first = l === laps.find((x) => x.block === l.block);
          const restBefore = first ? blocks[l.block ?? 0]?.rest_before_s ?? 0 : 0;
          const dBest = l.partial ? "part" : best ? "—" : time ? deltaTime(l.delta) : signed(l.delta, 1);
          const dMed = l.partial || ref == null ? "—" : time ? deltaTime(l.time_s - ref) : signed(l.speed_kmh! - ref, 1);
          return (
            <Fragment key={l.n}>
              {restBefore >= 60 && <li className="rest" role="separator" aria-label={`Rest ${hms(restBefore)}`}><span>rest {hms(restBefore)}</span></li>}
              <li>
                <button type="button" className={`lr ${best ? "best" : ""} ${l.partial ? "part" : ""} ${stop ? "stop" : ""} ${on ? "sel" : ""} ${cls}`} aria-pressed={on}
                  onClick={() => setWin(on ? null : span(l))}
                  aria-label={`Lap ${l.n}: ${lapTime(l.time_s)}, ${fixed(l.speed_kmh)} km/h, ${paceStr(l.pace_s_km)} per km${best ? ", best lap" : ""}${stop ? ", had a stop" : ""}. Measure it on the trace`}>
                  <span className="mono lr-n">{l.n}{best ? <i className="best-tag">best</i> : stop ? <i className="best-tag">stop</i> : null}</span>
                  <span className="mono strong">{lapTime(l.time_s)}</span>
                  <span className="mono strong">{pace ? paceStr(l.pace_s_km) : fixed(l.speed_kmh)}</span>
                  <span className="lr-sec mono">
                    <span>{pace ? fixed(l.speed_kmh) : paceStr(l.pace_s_km)}<u>{pace ? " km/h" : " /km"}</u></span>
                    {!time && <span>{fmt(l.distance_m, 0)}<u> m</u></span>}
                    {gap && <span>{paceStr(l.gap_s_km)}<u> gap</u></span>}
                    <span><u>vs best </u>{dBest}</span>
                    <span><u>vs median </u>{dMed}</span>
                    <span>{l.avg_hr ?? "—"}<u> bpm</u></span>
                    {cad && <span>{l.avg_cad ? fmt(l.avg_cad, 0) : "—"}<u> spm</u></span>}
                    {elev && <span>{l.elev_delta_m != null ? signed(l.elev_delta_m, 0) : "—"}<u> m</u></span>}
                  </span>
                </button>
              </li>
            </Fragment>
          );
        })}
      </ul>
      {laps.length > SHOW && (
        <button type="button" className="key flat act-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? `Show the first ${SHOW}` : `Show all ${laps.length} laps`}
        </button>
      )}
      <p className="tbl-note">Tap a lap to measure it on the trace. Δ is this lap minus the best, and minus the median of the steady laps (a lap with a stop is left out of the median); {time ? "positive = slower." : "negative = slower."}</p>
    </div>
  );
}
