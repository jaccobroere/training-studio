import { chromeTop, holdChrome } from "../ui/chrome";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "../api/client";
import { ChatKey } from "../app/ChatKey";
import { useDock } from "../app/dock";
import { readPref, writePref } from "../app/prefs";
import { prefillChat } from "../chat/prefill";
import { usePublishScope } from "../chat/scope";
import { dayLabel } from "../ui/dates";
import { sportLabel } from "../ui/sport";
import { RANGES, rangeOf, useDaily, useEfficiency, useEnergy, useLoad, useOverview, usePinned, useSleep, useVolume } from "./api";
import { LoadChart, SleepTimeline, WeeklyVolume } from "./charts/Charts";
import { EnergyByType, EnergySessions, WeeklyEnergy } from "./charts/Energy";
import { DailyChart } from "./charts/DailyChart";
import { EfficiencyTrend } from "./charts/Efficiency";
import { OverviewModule } from "./Overview";
import { PinnedBoard } from "./Pinned";

const SECTIONS = [
  { id: "overview", title: "Overview" },
  { id: "sleep", title: "Sleep" },
  { id: "hrv", title: "HRV" },
  { id: "rhr", title: "Resting heart rate" },
  { id: "load", title: "Training load" },
  { id: "energy", title: "Energy" },
  { id: "efficiency", title: "Efficiency" },
  { id: "pinned", title: "Pinned" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

const DISTANCE_TYPES = ["run", "ride", "swim", "walk", "skate"];

export function HealthPage() {
  const { "*": rest = "" } = useParams();
  const want = rest.split("/")[0];
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [rangeKey, setRangeKey] = useState<string>(() => readPref("health.range", "12w"));
  const range = rangeOf(rangeKey);
  const [active, setActive] = useState<SectionId>("overview");
  const scroller = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const pinned = usePinned();
  const status = useQuery({ queryKey: ["garmin-status"], queryFn: () => api<{ data_through: string | null; demo_present: boolean }>("/api/garmin/status") });
  const title = SECTIONS.find((s) => s.id === active)?.title ?? "Health";
  usePublishScope({ page: "health", label: `Health · ${title} · ${range.words}` });

  const setRange = (k: string) => { setRangeKey(k); writePref("health.range", k); };
  const go = (id: string, smooth = true) => {
    const el = document.getElementById(`h-${id}`);
    const root = scroller.current;
    if (!el || !root) return;
    // Scroll only the Health column (scrollIntoView would also move the app shell).
    // On a phone the bars overlay the column; they stay put during the jump.
    holdChrome(smooth ? 900 : 300);
    const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - chromeTop(root) - 8;
    root.scrollTo({ top, behavior: smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto" });
    if (smooth) el.focus({ preventScroll: true });
  };
  // Deep links (/stats/pinned, /stats/sleep) land on their section once it has rendered.
  // Sections above it grow as their data arrives, so land again until the reader scrolls themselves.
  const touched = useRef(false);
  useEffect(() => {
    if (!want || !SECTIONS.some((s) => s.id === want)) return;
    touched.current = false;
    const ts = [60, 600, 1500, 3000].map((ms) => setTimeout(() => { if (!touched.current) go(want, false); }, ms));
    return () => ts.forEach(clearTimeout);
  }, [want]);
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const mark = () => { touched.current = true; };
    for (const ev of ["wheel", "touchstart", "keydown"]) root.addEventListener(ev, mark, { passive: true });
    return () => { for (const ev of ["wheel", "touchstart", "keydown"]) root.removeEventListener(ev, mark); };
  }, []);
  // The section in view is the one marked in the navigator.
  useEffect(() => {
    const root = scroller.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    // Observer entries only list what changed, so keep the set of sections in the band and mark the topmost.
    const inBand = new Set<string>();
    const io = new IntersectionObserver((es) => {
      for (const e of es) { if (e.isIntersecting) inBand.add(e.target.id); else inBand.delete(e.target.id); }
      const top = SECTIONS.find((s) => inBand.has(`h-${s.id}`));
      if (top) setActive(top.id);
    }, { root, rootMargin: `-${chromeTop(root)}px 0px -65% 0px` }); // under the phone bars counts as out of view
    for (const s of SECTIONS) { const el = document.getElementById(`h-${s.id}`); if (el) io.observe(el); }
    return () => io.disconnect();
  }, []);
  // On a phone the navigator is a sideways tab row: keep the current tab in view (its own scroll only).
  useEffect(() => {
    const nv = navRef.current;
    const el = nv?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!nv || !el || nv.scrollWidth <= nv.clientWidth) return;
    nv.scrollTo({ left: el.offsetLeft - (nv.clientWidth - el.offsetWidth) / 2, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [active]);
  // The tab row fades at its right edge only while tabs remain off-screen (health.css); `data-more`
  // keeps that out of React's render path.
  useEffect(() => {
    const nv = navRef.current;
    if (!nv) return;
    let live = true;
    const sync = () => {
      const more = nv.scrollWidth - nv.clientWidth - Math.abs(nv.scrollLeft) > 1;
      nv.dataset.more = more ? "1" : "0";
    };
    sync();
    void document.fonts?.ready.then(() => { if (live) sync(); });
    nv.addEventListener("scroll", sync, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    ro?.observe(nv);
    return () => { live = false; nv.removeEventListener("scroll", sync); ro?.disconnect(); };
  }, []);
  const pick = (id: string) => { nav(`/stats/${id}${params.toString() ? `?${params}` : ""}`, { replace: true }); go(id); };

  return (
    <div className="page health">
      <div className="strip" role="toolbar" aria-label="Health controls">
        <h1 className="page-t">Health</h1>
        <div className="seg" role="radiogroup" aria-label="Period">
          {RANGES.map((r) => (
            <button type="button" key={r.key} role="radio" aria-checked={range.key === r.key} title={r.words}
              className={`key ${range.key === r.key ? "is-on" : ""}`} onClick={() => setRange(r.key)}>{r.label}</button>
          ))}
        </div>
        <label className="h-jump">
          <span className="sr-only">Jump to section</span>
          <select className="select" value={active} onChange={(e) => pick(e.target.value)}>
            {SECTIONS.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        </label>
        <span className="fill" />
        {status.data?.demo_present && <span className="tag warn" title="Synthetic data generated for testing">demo data</span>}
        <div className="field thru"><span className="silk">Data through</span><span className="v mono">{status.data?.data_through ? dayLabel(status.data.data_through) : "no data yet"}</span></div>
        <ChatKey />
      </div>
      <div className="health-body">
        <nav className="sec-nav chrome-pin" aria-label="Health sections" ref={navRef}>
          {SECTIONS.map((s) => (
            <a key={s.id} href={`/stats/${s.id}`} className={active === s.id ? "on" : ""} aria-current={active === s.id ? "location" : undefined}
              onClick={(e) => { e.preventDefault(); pick(s.id); }}>
              <span>{s.title}</span>
              {s.id === "pinned" && !!pinned.data?.length && <span className="mono small">{pinned.data.length}</span>}
            </a>
          ))}
        </nav>
        <div className="health-scroll" ref={scroller}>
          <div className="health-col">
            <Overview days={range.days} />
            <SleepSection days={range.days} words={range.words} />
            <DailySection id="hrv" metric="hrv_ms" days={range.days} words={range.words} />
            <DailySection id="rhr" metric="rhr_bpm" days={range.days} words={range.words} />
            <LoadSection days={range.days} words={range.words} />
            <EnergySection days={range.days} words={range.words} />
            <EfficiencySection days={range.days} />
            <Section id="pinned" title="Pinned" meta={pinned.data ? `${pinned.data.length} of 24` : undefined}
              note="Saved analyses, re-run on your current data.">
              <PinnedBoard />
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ id, title, meta, note, discuss, children }: { id: string; title: string; meta?: ReactNode; note?: string; discuss?: string; children: ReactNode }) {
  const dock = useDock();
  return (
    <section id={`h-${id}`} className="h-sec" aria-labelledby={`h-${id}-t`} tabIndex={-1}>
      <div className="h-sec-hd">
        <h2 id={`h-${id}-t`}>{title}</h2>
        {meta && <span className="mono h-meta">{meta}</span>}
        <span className="fill" />
        {discuss && <button type="button" className="key flat plain" onClick={() => { prefillChat(discuss); dock.open({ kind: "console" }); }}>Discuss</button>}
      </div>
      {note && <p className="h-note">{note}</p>}
      {children}
    </section>
  );
}

function Loading({ h = 220 }: { h?: number }) {
  return <div className="screen chart-screen"><div className="skel" style={{ height: h, margin: 10 }} aria-label="Loading" /></div>;
}

function Failed({ what, retry }: { what: string; retry: () => void }) {
  return <div className="screen chart-screen"><div className="unavail" role="alert"><p>Couldn't load {what}.</p><button type="button" className="key" onClick={retry}>Retry</button></div></div>;
}

function Overview({ days }: { days: number }) {
  const q = useOverview(days);
  return (
    <Section id="overview" title="Overview" meta={q.data ? `${dayLabel(q.data.start)} – ${dayLabel(q.data.end)}` : undefined}>
      {q.isPending ? <Loading h={260} /> : q.isError ? <Failed what="the overview" retry={() => void q.refetch()} />
        : <div className="screen chart-screen"><OverviewModule d={q.data} /></div>}
      <p className="h-note">Laps, splits, stints, routes and bests for each recording are on the <Link className="link" to="/activities">Activities</Link> page.</p>
    </Section>
  );
}

function SleepSection({ days, words }: { days: number; words: string }) {
  const q = useSleep(days);
  return (
    <Section id="sleep" title="Sleep" discuss={`About my sleep over the ${words}: `}>
      {q.isPending ? <Loading /> : q.isError ? <Failed what="sleep" retry={() => void q.refetch()} />
        : <div className="screen chart-screen"><SleepTimeline d={q.data} size="L" /></div>}
    </Section>
  );
}

function DailySection({ id, metric, days, words }: { id: string; metric: string; days: number; words: string }) {
  const q = useDaily(metric, days);
  const d = q.data;
  const title = id === "hrv" ? "HRV" : "Resting heart rate";
  return (
    <Section id={id} title={title} meta={d ? <>{d.unit}{d.estimate ? " · estimate" : ""}</> : undefined}
      note={d ? `${d.meaning} Band: ${d.baseline_rule}.` : undefined} discuss={`About my ${title} over the ${words}: `}>
      {q.isPending ? <Loading /> : q.isError ? <Failed what={title} retry={() => void q.refetch()} />
        : <div className="screen chart-screen"><DailyChart d={d!} size="L" /></div>}
    </Section>
  );
}

function LoadSection({ days, words }: { days: number; words: string }) {
  const load = useLoad(days);
  const present = load.data?.sports.filter((s) => DISTANCE_TYPES.includes(s)) ?? [];
  const [type, setType] = useState<string | null>(null);
  const vt = type && present.includes(type) ? type : present[0] ?? "run";
  const vol = useVolume(vt, days);
  return (
    <Section id="load" title="Training load" meta={load.data ? "hours per week" : undefined} discuss={`About my training load over the ${words}: `}>
      {load.isPending ? <Loading /> : load.isError ? <Failed what="training load" retry={() => void load.refetch()} />
        : <div className="screen chart-screen"><LoadChart d={load.data} size="L" /></div>}
      <div className="h-sub">
        <h3>Distance per week</h3>
        {present.length > 1 && (
          <div className="seg" role="radiogroup" aria-label="Type">
            {present.map((s) => (
              <button type="button" key={s} role="radio" aria-checked={vt === s} className={`key ${vt === s ? "is-on" : ""}`} onClick={() => setType(s)}>{sportLabel(s)}</button>
            ))}
          </div>
        )}
        {present.length === 1 && <span className="muted small">{sportLabel(vt)}</span>}
      </div>
      {vol.isPending ? <Loading h={200} /> : vol.isError ? <Failed what="weekly distance" retry={() => void vol.refetch()} />
        : <div className="screen chart-screen"><WeeklyVolume d={vol.data} size="L" /></div>}
    </Section>
  );
}

function EnergySection({ days, words }: { days: number; words: string }) {
  const q = useEnergy(days);
  return (
    <Section id="energy" title="Energy" meta={q.data ? "kcal burned" : undefined} discuss={`About the calories I burned over the ${words}: `}>
      {q.isPending ? <Loading /> : q.isError ? <Failed what="energy" retry={() => void q.refetch()} />
        : <div className="screen chart-screen"><WeeklyEnergy d={q.data} size="L" /></div>}
      {q.data && q.data.n > 0 && <>
        <div className="h-sub"><h3>By type</h3></div>
        <div className="screen chart-screen"><EnergyByType d={q.data} /></div>
        <div className="h-sub"><h3>Every session</h3></div>
        <div className="screen chart-screen"><EnergySessions d={q.data} /></div>
      </>}
    </Section>
  );
}

const TREND_TYPES = ["run", "ride", "skate"];

function EfficiencySection({ days }: { days: number }) {
  const load = useLoad(Math.max(days, 365));
  const present = TREND_TYPES.filter((s) => load.data?.sports.includes(s));
  const [type, setType] = useState<string | null>(null);
  const vt = type && present.includes(type) ? type : present[0] ?? "run";
  const span = Math.max(days, 365);
  const q = useEfficiency(vt, span);
  return (
    <Section id="efficiency" title="Efficiency" meta={`last ${span >= 365 ? "12 months" : `${span} days`}`}
      note="Output per heartbeat on easy and steady sessions, and how much heart rate drifts within a session, month by month."
      discuss={`About my ${sportLabel(vt).toLowerCase()} efficiency trend: `}>
      {present.length > 1 && (
        <div className="h-sub">
          <div className="seg" role="radiogroup" aria-label="Type">
            {present.map((s) => (
              <button type="button" key={s} role="radio" aria-checked={vt === s} className={`key ${vt === s ? "is-on" : ""}`} onClick={() => setType(s)}>{sportLabel(s)}</button>
            ))}
          </div>
        </div>
      )}
      {q.isPending ? <Loading h={310} /> : q.isError ? <Failed what="efficiency" retry={() => void q.refetch()} />
        : <div className="screen chart-screen"><EfficiencyTrend d={q.data} /></div>}
    </Section>
  );
}
