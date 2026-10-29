import { useCallback, useRef, useState } from "react";
import { readPref, writePref } from "../app/prefs";
import { chromeTop } from "../ui/chrome";
import { dayLabel, stamp } from "../ui/dates";
import { sportCode, sportLabel } from "../ui/sport";
import { useActivityStats } from "./api";
import { Unavailable, fmt, hms, paceStr } from "../health/charts/parts";
import type { ActivityDetail, ActivityStats } from "../health/types";
import { Seg } from "./controls";
import { InsetProvider } from "./inset";
import { makeWindow, type Win } from "./selection";
import { EffortsTab } from "./EffortsTab";
import { LapsTab } from "./LapsTab";
import { TAB_LABEL, lapTime, sportView, type SportView, type TabKey } from "./model";
import { OverviewTab } from "./OverviewTab";
import { TypeControl } from "./TypeControl";
import { StintsTab } from "./StintsTab";

/** A remembered choice (last lap source, last stint definition), per device. */
function usePref(key: string, fallback: string): [string, (v: string) => void] {
  const [v, set] = useState(() => readPref(key, fallback));
  return [v, useCallback((x: string) => { set(x); writePref(key, x); }, [key])];
}

/** One recorded activity: a summary that answers "how was it" at a glance, then a few tabs
 * (Overview · Laps · Stints · Efforts), never one long scroll. The tab lives in the URL
 * (`?tab=`), so it deep-links. */
export function ActivityView({ id, tab, setTab, win: winIn, setWin, days, words }: {
  id: string | null; tab: string | null; setTab: (t: TabKey) => void; win: Win | null; setWin: (w: Win | null) => void; days: number; words: string;
}) {
  const q = useActivityStats(id);
  const [cursor, setCursor] = useState<number | null>(null);
  const [stintDef, setStintDef] = usePref("health.stintdef", "rel");
  const [lapSrc, setLapSrc] = usePref("health.lapsrc", "");
  const card = useRef<HTMLElement>(null);
  if (q.isPending) return <div className="screen chart-screen"><div className="skel" style={{ height: 300, margin: 10 }} aria-label="Loading" /></div>;
  if (q.isError) return <div className="screen chart-screen"><div className="unavail" role="alert"><p>Couldn't load the activity.</p><button type="button" className="key" onClick={() => void q.refetch()}>Retry</button></div></div>;
  const d = q.data.activity, st = q.data.stats;
  if (!d) return <div className="screen chart-screen"><Unavailable what="Activity" why="No run, ride or skate with a recorded stream yet. Import one in Settings → Data." /></div>;
  const v = sportView(d.type ?? d.sport);
  const tabs = st && d.stream ? v.tabs : [];
  const end = d.stream ? d.stream.t[d.stream.t.length - 1] : 0;
  const win = winIn && makeWindow(winIn[0], winIn[1], end);
  const shared = { win, setWin, cursor, setCursor };
  const cur: TabKey = tabs.includes(tab as TabKey) ? (tab as TabKey) : "overview";
  const pick = (k: string) => {
    setTab(k as TabKey);
    // Land on the top of the view, so a short tab never opens scrolled past its own header.
    requestAnimationFrame(() => {
      const el = document.getElementById("av-top");
      const sc = el?.closest<HTMLElement>(".act-detail");
      if (el && sc && el.getBoundingClientRect().top < sc.getBoundingClientRect().top + chromeTop(sc)) {
        sc.scrollTo({ top: sc.scrollTop + el.getBoundingClientRect().top - sc.getBoundingClientRect().top - chromeTop(sc) - 8 });
      }
    });
  };
  return (
    <div className="av-wrap">
      <article className="av" aria-labelledby="av-title" id="av-top" ref={card}>
        <InsetProvider host={card}>
          <header className="av-hd">
            <span className="sport" title={sportLabel(d.type ?? d.sport)}>{sportCode(d.type ?? d.sport)}</span>
            <div className="av-hd-t">
              <h3 id="av-title">{d.name || sportLabel(d.type ?? d.sport)}</h3>
              <span className="mono">{dayLabel(d.local_date)} · {stamp(d.start_utc)}{d.device ? ` · ${d.device}` : d.source === "demo" ? " · demo" : ""}</span>
            </div>
            {d.workout && <span className="tag">plan: {d.workout.title}</span>}
            <TypeControl d={d} />
          </header>
          <Summary d={d} st={st} v={v} />
          {tabs.length > 1 && <Seg tab label="Activity views" className="av-tabs" value={cur} onChange={pick} options={tabs.map((k) => ({ key: k, label: TAB_LABEL[k] }))} />}
          <div id="av-panel" role="tabpanel" aria-labelledby={`av-tab-${cur}`} className="av-panel">
            {!st || !d.stream ? <div className="screen chart-screen"><Unavailable what="Detail" why="This activity has no per-second stream (summary only)." /></div>
              : cur === "overview" ? <OverviewTab d={d} st={st} v={v} {...shared} />
              : cur === "laps" ? <LapsTab d={d} st={st} v={v} stintDef={stintDef} src={lapSrc} setSrc={setLapSrc} {...shared} />
              : cur === "stints" ? <StintsTab d={d} st={st} v={v} def={stintDef} setDef={setStintDef} {...shared} />
              : <EffortsTab d={d} st={st} v={v} days={days} words={words} setWin={(w) => { setWin(w); setTab("overview"); }} />}
          </div>
          {st?.notes.length ? <p className="av-notes">{st.notes.join(" ")}</p> : null}
        </InsetProvider>
      </article>
    </div>
  );
}

type Item = [label: string, value: string, unit?: string, note?: string];

/** The headline numbers, nine to a screen (three by three on a phone), per sport. Skate reads
 * km/h first with pace under it; run reads pace; ride reads speed and power. */
function Summary({ d, st, v }: { d: ActivityDetail; st: ActivityStats | null; v: SportView }) {
  const t = st?.totals;
  const km = (t?.distance_m ?? d.distance_m ?? 0) / 1000;
  const sport = d.type ?? d.sport;
  const sp = t?.avg_moving.speed_kmh ?? null, pc = t?.avg_moving.pace_s_km ?? null;
  const hr: Item = ["Avg HR", fmt(t?.avg_hr ?? d.avg_hr, 0), "bpm", t?.max_hr ? `max ${fmt(t.max_hr, 0)}` : ""];
  const items: Item[] = [["Distance", km ? fmt(km, 2) : "—", "km"], ["Moving", hms(t?.moving_s ?? d.moving_s ?? d.duration_s), "", t && t.stopped_s >= 60 ? `of ${hms(t.elapsed_s)}` : ""]];
  if (sport === "skate") {
    const L = st?.lapsets;
    const b4 = st?.best.distance.find((x) => x.distance_m === 400);
    const nStint = L?.stints?.sets[L.stints.defs.find((x) => x.key === "rel")?.key ?? "abs"]?.length;
    const tv = st?.turns;
    // Rest is standing time as a share of elapsed: the figure a skate's many stops deserve.
    const restPct = t?.elapsed_s ? Math.round((t.stopped_s / t.elapsed_s) * 100) : null;
    const restUnit = t ? `${restPct != null ? `${restPct} % · ` : ""}${t.stops} stop${t.stops === 1 ? "" : "s"}` : "";
    items.push(["Speed", fmt(sp, 1), "km/h", `${paceStr(pc)} /km`], ["Max", fmt(t?.max_speed_kmh, 1), "km/h"],
      ["Best 400 m", b4 ? lapTime(b4.time_s) : "—", "", b4 ? `${fmt(b4.speed_kmh, 1)} km/h` : ""],
      ["Turns", tv ? String(tv.n_turns) : "—", "", tv ? `${fmt(tv.turn.pct, 0)} % turning` : ""],
      ["Rest", t ? hms(t.stopped_s) : "—", "", restUnit],
      ["Stints", nStint != null ? String(nStint) : "—", "", "med +15 %"], hr);
  } else if (v.primary === "pace") {
    items.push(["Pace", paceStr(pc), "/km"]);
    if (t?.gap?.pace_s_km) items.push(["GAP", paceStr(t.gap.pace_s_km), "/km"]);
    if (t?.avg_cad) items.push(["Cadence", fmt(t.avg_cad, 0), t.cad_unit]);
    items.push(["Avg HR", fmt(t?.avg_hr ?? d.avg_hr, 0), "bpm"], ["Max HR", fmt(t?.max_hr ?? d.max_hr, 0), "bpm"]);
    if (t?.gain_m != null && t.max_m != null && t.min_m != null && t.max_m - t.min_m >= 6) items.push(["Climb", fmt(t.gain_m, 0), "m"]);
    if (d.calories) items.push(["Energy", fmt(d.calories, 0), "kcal"]);
  } else {
    items.push(["Speed", fmt(sp, 1), "km/h"], ["Max", fmt(t?.max_speed_kmh, 1), "km/h"]);
    if (t?.avg_power) items.push(["Power", fmt(t.avg_power, 0), "W", "avg"]);
    if (t?.avg_cad) items.push(["Cadence", fmt(t.avg_cad, 0), t.cad_unit]);
    items.push(hr);
    if (t?.gain_m != null && t.max_m != null && t.min_m != null && t.max_m - t.min_m >= 6) items.push(["Climb", fmt(t.gain_m, 0), "m"]);
    if (d.calories) items.push(["Energy", fmt(d.calories, 0), "kcal"]);
  }
  const shown = items.slice(0, 9); // three rows of three; the rest lives in the tabs
  return (
    <dl className="av-sum">
      {shown.map(([k, val, u, n]) => <div key={k}><dt>{k}</dt><dd>{val}{u ? <small className="unit">{u}</small> : null}{n ? <small className="note">{n}</small> : null}</dd></div>)}
    </dl>
  );
}
