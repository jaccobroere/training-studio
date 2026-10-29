import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { ChatKey } from "../app/ChatKey";
import { useDock } from "../app/dock";
import { readPref, writePref } from "../app/prefs";
import { useMobile } from "../app/useMedia";
import { prefillChat } from "../chat/prefill";
import { usePublishScope } from "../chat/scope";
import { addDays, todayIso } from "../ui/dates";
import { Icon } from "../ui/Icon";
import { DateField } from "../ui/DateField";
import { sportLabel } from "../ui/sport";
import { ActivityList } from "./ActivityList";
import { ActivityView } from "./ActivityView";
import { useActivities } from "./api";
import { RANGES, filterParams, firstWithStream, periodOf, readFilters, searchActivities } from "./filter";
import { formatWindow, parseWindow, type Win } from "./selection";
import type { TabKey } from "./model";

/** Rows drawn at a time: "All" can be hundreds, and a phone should not lay them all out. */
const PAGE = 100;

/** Activities: every recording, with the list (sport, period, search) on one side and the chosen
 * activity's full view on the other. The activity is in the path (`/activities/<id>`), the view
 * (`?tab=`, `?win=`) and the filters in the query, so every state can be shared. On a phone it is
 * the list, then the activity with a back key. */
export function ActivitiesPage() {
  const { id = null } = useParams();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const mobile = useMobile();
  const f = readFilters(params, readPref("activities.range", "12w"));
  const { period, days, words } = periodOf(f);
  const q = useActivities(period, f.sport || null);
  const all = useMemo(() => q.data?.activities ?? [], [q.data]);
  const rows = useMemo(() => searchActivities(all, f.q), [all, f.q]);
  const types = useMemo(() => [...new Set(all.map((a) => a.type ?? a.sport))], [all]);
  const dock = useDock();
  const [shown, setShown] = useState(PAGE);
  const current = all.find((a) => a.id === id);
  usePublishScope({ page: "activities", activity: id ?? undefined, label: id ? `Activity · ${current?.name || "recording"}` : "Activities" });

  const set = (patch: Record<string, string | null>, replace = true) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v) p.set(k, v); else p.delete(k); }
    setParams(p, { replace });
  };
  const setRange = (key: string) => { writePref("activities.range", key); set({ range: key, from: null, to: null }); };
  const filtersOn = !!(f.sport || f.q || f.from);
  const href = (aid: string) => {
    const p = filterParams(params);
    if (params.get("tab")) p.set("tab", params.get("tab")!);
    return `/activities/${encodeURIComponent(aid)}${p.size ? `?${p}` : ""}`;
  };
  const listHref = `/activities${filterParams(params).size ? `?${filterParams(params)}` : ""}`;

  // A wide screen always shows an activity: open the newest one that has a stream.
  const first = firstWithStream(rows);
  if (!mobile && !id && first) return <Navigate to={href(first.id)} replace />;
  const showList = !mobile || !id;
  const showDetail = !mobile || !!id;
  return (
    <div className="page activities">
      <div className="strip" role="toolbar" aria-label="Activities">
        {mobile && id ? (
          <button type="button" className="key flat plain" onClick={() => nav(listHref)}><Icon name="back" />Activities</button>
        ) : (
          <>
            <h1 className="page-t">Activities</h1>
            {q.data && <span className="mono muted small">{rows.length}{rows.length !== all.length ? ` of ${all.length}` : ""} · {f.from ? "custom period" : words}</span>}
          </>
        )}
        <span className="fill" />
        {id && <button type="button" className="key flat plain" onClick={() => { prefillChat("About this activity: "); dock.open({ kind: "console" }); }}>Discuss</button>}
        <ChatKey />
      </div>
      <div className="act-body">
        {showList && (
          <section className="act-pane act-listpane" aria-label="All activities">
            <div className="act-filters">
              <div className="search"><Icon name="search" />
                <input className="input" type="search" value={f.q} placeholder="Search name, type or date" aria-label="Search activities" onChange={(e) => set({ q: e.target.value || null })} />
              </div>
              <div className="act-filter-row">
                <label className="sr-only" htmlFor="act-sport">Sport</label>
                <select id="act-sport" className="select" value={f.sport} onChange={(e) => set({ sport: e.target.value || null })}>
                  <option value="">All sports</option>
                  {(f.sport && !types.includes(f.sport) ? [...types, f.sport] : types).map((t) => <option key={t} value={t}>{sportLabel(t)}</option>)}
                </select>
                <div className="seg" role="radiogroup" aria-label="Period">
                  {RANGES.map((r) => (
                    <button type="button" key={r.key} role="radio" aria-checked={f.range === r.key} title={r.words}
                      className={`key ${f.range === r.key ? "is-on" : ""}`} onClick={() => setRange(r.key)}>{r.label}</button>
                  ))}
                  <button type="button" role="radio" aria-checked={f.range === "custom"} className={`key ${f.range === "custom" ? "is-on" : ""}`}
                    onClick={() => set({ range: null, from: addDays(todayIso(), -84), to: todayIso() })}>Dates</button>
                </div>
              </div>
              {f.range === "custom" && (
                <div className="act-filter-row act-dates">
                  <DateField label="From" value={f.from} max={f.to ?? undefined} onChange={(d) => d && set({ from: d })} />
                  <span className="muted">to</span>
                  <DateField label="To" value={f.to} min={f.from ?? undefined} onChange={(d) => d && set({ to: d })} />
                </div>
              )}
            </div>
            {q.isPending ? <div className="act-skel" aria-label="Loading">{Array.from({ length: 7 }, (_, i) => <div key={i} className="skel" />)}</div>
              : q.isError ? <div className="unavail" role="alert"><p>Couldn't load the activities.</p><button type="button" className="key" onClick={() => void q.refetch()}>Retry</button></div>
              : rows.length ? (
                <>
                  <ActivityList list={rows.slice(0, shown)} selected={id} href={href} />
                  {rows.length > shown && <button type="button" className="key flat act-more" onClick={() => setShown(shown + PAGE)}>Show {Math.min(PAGE, rows.length - shown)} more of {rows.length - shown}</button>}
                  {q.data.n >= 500 && <p className="tbl-note">The list holds the latest 500. Narrow the period to reach older ones.</p>}
                </>
              ) : (
                <div className="act-empty">
                  <p>{filtersOn || all.length ? "No activity matches these filters." : "No recordings in this period."}</p>
                  {filtersOn
                    ? <button type="button" className="key" onClick={() => setParams(new URLSearchParams(), { replace: true })}>Clear filters</button>
                    : <p className="hint-l"><Link to="/settings/connections">Connect Garmin</Link> or <Link to="/settings/data">upload an export</Link>, or try a longer period.</p>}
                </div>
              )}
          </section>
        )}
        {showDetail && (
          <section className="act-pane act-detail" aria-label="Activity">
            {id
              ? <ActivityPane key={id} id={id} params={params} set={set} days={days} words={words} />
              : <div className="act-empty"><p>Select an activity to see its laps, stints and splits.</p></div>}
          </section>
        )}
      </div>
    </div>
  );
}

/** The activity view with its window. The window is local state while it is being dragged and goes
 * to the URL (`?win=`) a moment after it settles, so a drag does not write history on every pixel. */
function ActivityPane({ id, params, set, days, words }: {
  id: string; params: URLSearchParams; set: (patch: Record<string, string | null>) => void; days: number; words: string;
}) {
  const [win, setWinState] = useState<Win | null>(() => parseWindow(params.get("win"), Infinity));
  const latest = useRef(set);
  const timer = useRef(0);
  useEffect(() => { latest.current = set; });
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const setWin = useCallback((w: Win | null) => {
    setWinState(w);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => latest.current({ win: w ? formatWindow(w) : null }), 300);
  }, []);
  return <ActivityView id={id} tab={params.get("tab")} setTab={(t: TabKey) => set({ tab: t })} win={win} setWin={setWin} days={days} words={words} />;
}
