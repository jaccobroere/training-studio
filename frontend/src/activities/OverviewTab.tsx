import { useMemo } from "react";
import { useMobile } from "../app/useMedia";
import { Readout, fmt, hms } from "../health/charts/parts";
import type { ActivityDetail, ActivityStats } from "../health/types";
import { Fold, Note } from "./controls";
import { restsOf, type SportView } from "./model";
import type { Win } from "./selection";
import { HeadingRose, RouteLegend, RouteMap } from "./Route";
import { TracePanel } from "./TracePanel";
import type { Panel } from "./Trace";

export function OverviewTab({ d, st, v, win, setWin, cursor, setCursor }: {
  d: ActivityDetail; st: ActivityStats; v: SportView; win: Win | null; setWin: (w: Win | null) => void;
  cursor: number | null; setCursor: (t: number | null) => void;
}) {
  const s = d.stream!;
  const mobile = useMobile();
  const flat = st.totals.max_m != null && st.totals.min_m != null && st.totals.max_m - st.totals.min_m < 6;
  // No altitude in the stream (an ice rink, a treadmill) means no elevation panel — and no
  // "elevation" in the card title either.
  const hasAlt = st.totals.max_m != null;
  const panels = useMemo<Panel[]>(() => ["speed", "hr", ...(st.totals.avg_power ? ["pow" as Panel] : []), ...(flat || mobile || !hasAlt ? [] : ["alt" as Panel])], [st, flat, mobile, hasAlt]);
  const rests = useMemo(() => restsOf(st), [st]);
  const pace = v.primary === "pace";
  const tot = st.totals;
  const dc = st.decoupling;
  const tv = st.turns;
  // A steady block is only a readout once it exists; without one the payload still carries how
  // even the closest candidate was, which the note reports.
  const sb = st.steady?.available ? st.steady : null;
  const noSteady = st.steady && !st.steady.available ? st.steady : null;
  // Decoupling is only meaningful on a steady stretch: with a block it is read on that block, and
  // when every block was too short or too uneven it is not reported at all rather than passed off
  // as a whole-session figure (an interval skate "decouples" 8 % simply because the pace changed).
  // A payload without the steady analysis (cached before it existed) still shows the whole-session
  // figure, which is what the note explains.
  const onBlock = sb !== null;
  const dcPct = onBlock ? sb.decoupling_pct : noSteady ? null : dc && dc.available ? dc.pct : null;
  const drift = onBlock ? sb.hr_drift_bpm : (dc && dc.available ? dc.hr_drift_bpm : null);
  const steadyMin = sb ? Math.round(sb.moving_s / 60) : null;
  const noSteadyMin = noSteady ? Math.round(noSteady.min_s / 60) : null;
  const zTop = st.zones ? [...st.zones.zones].sort((a, b) => b.pct - a.pct)[0] : null;
  // The fold closes to one line on a phone, so the efficiency factor — the headline number —
  // leads the hint, and keeps that line to itself when there is no room for decoupling too:
  // at 390px the summary leaves the hint 148px, and "EF 1.62 m/beat · dec 2.1 %" needs 182px.
  const efHint = st.ef ? `EF ${fmt(st.ef.value, 2)} ${st.ef.unit}` : null;
  const effortHint = efHint
    ? mobile || !dcPct ? efHint : `${efHint} · dec ${fmt(dcPct, 1)} %`
    : dcPct ? `decoupling ${fmt(dcPct, 1)} %` : `${hms(tot.stopped_s)} stopped`;
  return (
    <div className="av-stack">
      <TracePanel s={s} v={v} totals={st.totals} panels={panels} rests={rests} win={win} setWin={setWin} cursor={cursor} setCursor={setCursor}
        title={`${pace ? "Pace" : "Speed"} · HR${panels.includes("pow") ? " · Power" : ""}${panels.includes("alt") ? " · Elevation" : ""}`}
        help={<>The whole session at a glance: how {pace ? "pace" : "speed"} and heart rate moved together.{rests.length ? " Grey bands are rests." : ""}</>} />

      {st.route && (
        <Fold title="Route" open={!mobile} hint={`${fmt((tot.distance_m) / 1000, 1)} km${st.heading?.spread_kmh != null ? ` · wind spread ${fmt(st.heading.spread_kmh, 1)} km/h` : ""}`}>
          <div className="av-route-body">
            <RouteMap r={st.route} cursor={cursor} />
            {st.heading && <HeadingRose hd={st.heading} />}
          </div>
          <RouteLegend r={st.route} rose={!!st.heading} />
          <Note>Basemap © OpenStreetMap contributors. Tiles are an aid: with them blocked, the trace and marks still draw on the screen.</Note>
        </Fold>
      )}
      {tv && (
        <Fold title="Turns and straights" open={!mobile} hint={`${tv.n_turns} turns`}>
          <Readout compact items={[
            ["Straight", fmt(tv.straight.speed_kmh, 1), "km/h"],
            ["Turn", fmt(tv.turn.speed_kmh, 1), "km/h"],
            ["Difference", fmt(tv.loss_kmh, 1), "km/h"],
            ["Turn share", fmt(tv.turn.pct, 1), "%"],
          ]} />
          <Note more={<>{st.rules.turns} Difference is straight speed minus turn speed: a negative figure means the turns were faster.</>}>
            {fmt(tv.turn.pct, 0)} % of the moving time was spent turning
            {tv.turn.speed_kmh != null && tv.straight.speed_kmh != null
              ? `, at ${fmt(tv.turn.speed_kmh, 1)} km/h against ${fmt(tv.straight.speed_kmh, 1)} km/h straight`
              : ""}.
            {tv.loss_kmh != null ? ` ${fmt(Math.abs(tv.loss_kmh), 1)} km/h ${tv.loss_kmh >= 0 ? "slower" : "faster"} in the turns.` : ""}
          </Note>
        </Fold>
      )}
      <Fold title="Heart-rate zones" open={!mobile} hint={zTop ? `mostly Z${zTop.zone} · ${fmt(zTop.pct, 0)} %` : "no heart rate"}>
        {st.zones ? <Zones z={st.zones} /> : <p className="chart-note">No heart rate, or no reference max HR yet.</p>}
        {st.zones && <Note more={<>{st.rules.zones} {st.hr_ref_rule}</>}>Zones are shares of your highest recorded HR ({st.zones.ref_bpm} bpm).</Note>}
      </Fold>
      <Fold title="Effort and efficiency" open={!mobile} hint={effortHint}>
        <Readout compact items={[
          ["Moving", hms(tot.moving_s), ""],
          ["Stopped", hms(tot.stopped_s), "", tot.stops ? `${tot.stops} stop${tot.stops === 1 ? "" : "s"}` : ""],
          ["Decoupling", dcPct == null ? "—" : fmt(dcPct, 1), dcPct == null ? "" : "%"],
          ...(st.ef ? [["EF", fmt(st.ef.value, 2), st.ef.unit] as [string, string, string]] : []),
          ...(sb && sb.ef != null ? [["Steady EF", fmt(sb.ef, 2), sb.ef_unit ?? ""] as [string, string, string]] : []),
          ["HR drift", drift == null ? "—" : `${drift > 0 ? "+" : ""}${fmt(drift, 0)}`, "bpm"],
          ...(tot.gain_m != null && !flat ? [["Climb", fmt(tot.gain_m, 0), "m ↑"] as [string, string, string]] : []),
        ]} />
        <Note more={<>{onBlock ? (sb.ef != null ? <>Decoupling is read on that steady block, first vs second half of its moving time: {fmt(dcPct, 1)} %. Its EF is {fmt(sb.ef, 2)} {sb.ef_unit ?? ""} over {steadyMin} min. </> : <>That steady block has no heart rate, so it has no efficiency factor and no decoupling. </>) : noSteady ? <>Decoupling needs a steady block, and this session has none: {noSteady.cv_pct == null ? `no block of ${noSteadyMin} min or more was recorded` : "every block long enough was too uneven in pace"}. </> : dc && dc.available ? <>{dc.basis === "power" ? "Power" : dc.basis === "gap" ? "Grade-adjusted speed" : "Speed"} per heartbeat, first vs second half of moving time: {fmt(dc.first.output, 1)} → {fmt(dc.second.output, 1)} {dc.output_unit} at {fmt(dc.first.hr, 0)} → {fmt(dc.second.hr, 0)} bpm. </> : null}{st.rules.decoupling} {st.rules.ef} {st.rules.steady} {st.rules.moving}{" "}<a href="https://help.trainingpeaks.com/hc/en-us/articles/204071724-Aerobic-Decoupling-Pw-Hr-and-Pa-HR-and-Efficiency-Factor-EF" target="_blank" rel="noopener noreferrer nofollow">Efficiency factor and decoupling (TrainingPeaks)</a></>}>
          {[
            st.ef
              ? `Efficiency factor ${fmt(st.ef.value, 2)} ${st.ef.unit} — ${st.ef.basis === "power" ? "power" : st.ef.basis === "gap" ? "grade-adjusted speed" : "speed"} per heartbeat.`
              : tot.avg_hr == null ? "Efficiency factor needs heart rate." : "Efficiency factor needs a recorded speed.",
            sb && sb.ef != null ? `Steady efficiency factor ${fmt(sb.ef, 2)} ${sb.ef_unit ?? ""} over the longest steady ${steadyMin} min.` : null,
            noSteady
              ? noSteady.cv_pct == null
                ? `No steady ${noSteadyMin} min block: no ${noSteadyMin} min block was recorded.`
                : `No steady ${noSteadyMin} min block: the most even one varies ${fmt(noSteady.cv_pct, 1)} % of speed.`
              : null,
            onBlock
              ? sb.ef != null ? "Decoupling is measured on that block." : "Decoupling needs heart rate."
              : noSteady ? "Decoupling is not reported." : dc && dc.available ? "Decoupling above 5 % means heart rate rose for the same output." : `Decoupling ${dc && !dc.available ? dc.why : "needs heart rate"}.`,
          ].filter(Boolean).join(" ")}
        </Note>
      </Fold>
    </div>
  );
}

function Zones({ z }: { z: NonNullable<ActivityStats["zones"]> }) {
  const rows = [...z.zones].reverse();
  return (
    <ul className="zones" aria-label="Time in heart-rate zones">
      {rows.map((r) => (
        <li key={r.zone}>
          <span className="z-l mono">Z{r.zone}</span>
          <span className="z-b mono">{r.lo_bpm}{r.hi_bpm ? `–${r.hi_bpm}` : "+"}</span>
          <span className="z-bar" aria-hidden="true"><i style={{ width: `${Math.max(r.pct, r.s ? 1 : 0)}%`, opacity: 0.35 + r.zone * 0.13 }} /></span>
          <span className="z-v mono">{hms(r.s)}</span>
          <span className="z-p mono">{fmt(r.pct, 0)}%</span>
        </li>
      ))}
      {z.below_s > 0 && <li className="z-below"><span className="z-l mono">&lt;Z1</span><span className="z-b mono">&lt;{z.zones[0].lo_bpm}</span><span className="z-bar" /><span className="z-v mono">{hms(z.below_s)}</span><span className="z-p mono">{fmt(z.below_pct, 0)}%</span></li>}
    </ul>
  );
}
