import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { api } from "../api/client";
import type { WeekView } from "../api/types";
import { ChatKey } from "../app/ChatKey";
import { useDock } from "../app/dock";
import { useMobile } from "../app/useMedia";
import { prefillChat } from "../chat/prefill";
import { usePublishScope } from "../chat/scope";
import { Icon } from "../ui/Icon";
import { Popover } from "../ui/Popover";
import { Calendar } from "../ui/DateField";
import { addDays, mondayOf, todayIso } from "../ui/dates";
import { useToday, useWeek } from "./api";
import { AddMenu, LibKey, MobileBar, TagFilter, useLibDrawer, useTagParam, ViewSeg, withTag } from "./toolbar";
import { Board } from "./Board";
import { isoWeek, rangeShort } from "./dates";

export const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement;
  return t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || !!t.closest("[role=dialog], .dock, .sheet");
};

export function CurrentWeekRedirect() {
  const q = useToday();
  if (q.data) return <Navigate to={`/plan/week/${q.data.monday}`} replace />;
  if (q.isError) return <Navigate to={`/plan/week/${mondayOf(todayIso())}`} replace />;
  return <div className="page plan"><WeekSkeleton /></div>;
}

export function WeekPage() {
  const { monday: raw = "" } = useParams();
  const monday = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? mondayOf(raw) : null;
  if (!monday) return <Navigate to="/plan" replace />;
  if (monday !== raw) return <Navigate to={`/plan/week/${monday}`} replace />;
  return <Week monday={monday} />;
}

function Week({ monday }: { monday: string }) {
  const nav = useNavigate();
  const dock = useDock();
  const mobile = useMobile();
  const q = useWeek(monday);
  const today = useToday();
  const [tag] = useTagParam();
  const [lib, toggleLib] = useLibDrawer();
  const go = (m: string) => nav(withTag(`/plan/week/${m}`, tag));
  const prev = () => go(addDays(monday, -7));
  const next = () => go(addDays(monday, 7));
  const toToday = () => today.data && go(today.data.monday);
  const dayFor = () => {
    const t = today.data?.today;
    return t && mondayOf(t) === monday ? t : monday;
  };
  const addNew = (repeat = false) => dock.open({ kind: "editor", seed: { date: dayFor(), week_monday: monday, repeat } });
  const addSaved = (id: string) => dock.open({ kind: "editor", seed: { date: dayFor(), week_monday: monday, from_saved: id } });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "t") toToday();
      else if (e.key === "n") addNew();
      else if (e.key === "w") nav(withTag("/plan/weeks", tag) + `${tag ? "&" : "?"}at=${monday}`);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const w = q.data && q.data.monday === monday ? q.data : undefined;
  const wk = isoWeek(monday);
  usePublishScope({ page: "week", monday, week_no: wk, label: `Week ${wk}` });
  const isCurrent = today.data ? today.data.monday === monday : false;
  const showLib = lib && !mobile;

  return (
    <div className="page plan">
      <Toolbar monday={monday} mobile={mobile} isCurrent={isCurrent} lib={showLib} onLib={toggleLib}
        onPrev={prev} onNext={next} onToday={toToday} onJump={(d) => go(mondayOf(d))} onAdd={addNew} onAddSaved={addSaved} />
      {w ? (
        <Board w={w} tag={tag} lib={showLib} onCloseLib={toggleLib}
          lead={<Lead w={w} onAdd={() => addNew()} onRepeat={() => addNew(true)} />} />
      ) : (
        <div className="page-scroll week-scroll">
          {q.isError ? (
            <div className="board"><div className="state-err module" role="alert"><p>Couldn't load this week.</p>
              <button className="key" onClick={() => q.refetch()}>Retry</button></div></div>
          ) : <WeekSkeleton />}
        </div>
      )}
    </div>
  );
}

function Toolbar({ monday, mobile, isCurrent, lib, onLib, onPrev, onNext, onToday, onJump, onAdd, onAddSaved }: {
  monday: string; mobile: boolean; isCurrent: boolean; lib: boolean; onLib: () => void;
  onPrev: () => void; onNext: () => void; onToday: () => void; onJump: (d: string) => void;
  onAdd: (repeat?: boolean) => void; onAddSaved: (id: string) => void;
}) {
  const pickRef = useRef<HTMLButtonElement>(null);
  const [jump, setJump] = useState(false);
  const today = useToday();
  const label = `Wk ${isoWeek(monday)} · ${rangeShort(monday)}`;

  const navKeys = (
    <div className="grp wk-nav">
      <button className="key sq" aria-label="Previous week" onClick={onPrev}><Icon name="prev" /></button>
      <button ref={pickRef} className="key wk-label" aria-haspopup="dialog" aria-expanded={jump}
        onClick={() => setJump(!jump)} aria-label={`${label}. Jump to a date`}>
        <span className="mono">{label}</span>
      </button>
      <button className="key sq" aria-label="Next week" onClick={onNext}><Icon name="next" /></button>
      {!mobile && <button className="key flat plain today-k" onClick={onToday} disabled={isCurrent}>Today</button>}
    </div>
  );
  const addKey = <AddMenu mobile={mobile} onAdd={onAdd} onAddSaved={onAddSaved} />;

  return (
    <div className="strip" role="toolbar" aria-label="Week controls">
      {mobile ? <>
        <MobileBar view="week" monday={monday} top={rangeShort(monday)} sub={`Week ${isoWeek(monday)}`} pickRef={pickRef} jumpOpen={jump}
          onJump={() => setJump(!jump)} onPrev={onPrev} onNext={onNext} isCurrent={isCurrent} onToday={onToday} add={addKey} />
      </> : <>
        <ViewSeg view="week" monday={monday} />
        <span className="div" />
        {navKeys}
        <span className="div" />
        <TagFilter mobile={false} />
        <span className="fill" />
        <LibKey open={lib} onToggle={onLib} />
        {addKey}
        <ChatKey />
      </>}
      <Popover anchor={pickRef} open={jump} onClose={() => setJump(false)} label="Jump to a week" align="start" width={262}>
        <p className="pop-t">Jump to</p>
        <Calendar value={monday} today={today.data?.today} label="Week" onPick={(d) => { onJump(d); setJump(false); }} />
      </Popover>
    </div>
  );
}

/** Above the days: the first-run card on a fresh account (dismissable, never returns once
 *  there is any data), otherwise one quiet line on an empty current/future week. */
function Lead({ w, onAdd, onRepeat }: { w: WeekView; onAdd: () => void; onRepeat: () => void }) {
  const dock = useDock();
  const nav = useNavigate();
  const qc = useQueryClient();
  const ask = (text: string) => { prefillChat(text); dock.open({ kind: "console" }); };
  const wk = `week ${isoWeek(w.monday)} (${rangeShort(w.monday)})`;
  const dismiss = async () => {
    qc.setQueriesData<WeekView>({ queryKey: ["week"] }, (v) => v && { ...v, new_account: false });
    await api("/api/welcome/dismiss", { method: "POST" }).catch(() => undefined);
  };
  if (w.new_account) {
    return (
      <section className="module welcome" aria-labelledby="welcome-t">
        <h2 id="welcome-t">Set up your plan</h2>
        <button className="key sq flat plain welcome-x" aria-label="Dismiss" onClick={dismiss}><Icon name="close" /></button>
        <div className="welcome-rows">
          <button className="welcome-row" onClick={() => ask(`Plan ${wk} from my profile and recent training.`)}><Icon name="chat" /><span>Plan with the assistant</span></button>
          <button className="welcome-row" onClick={onAdd}><Icon name="plus" /><span>Add a workout</span></button>
          <button className="welcome-row" onClick={onRepeat}><Icon name="repeat" /><span>Add a repeating workout</span></button>
          <button className="welcome-row" onClick={() => nav("/settings/connections")}><Icon name="sync" /><span>Connect Garmin</span></button>
        </div>
      </section>
    );
  }
  if (!w.empty || w.sunday < w.today) return null;
  const fromLast = w.last_week_activities > 0;
  return (
    <div className="empty-week">
      <span>Nothing planned</span>
      <button className="key flat plain" onClick={() => ask(fromLast
        ? `Plan ${wk} from last week's training and my profile.`
        : `Plan ${wk} from my profile.`)}>
        <Icon name="chat" />{fromLast ? "Plan from last week" : "Plan with assistant"}
      </button>
    </div>
  );
}

function WeekSkeleton() {
  return (
    <div className="board" aria-busy="true" aria-label="Loading week">
      <div className="days">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="day skel-day"><div className="dlab" /><div className="drows"><div className="skel" style={{ width: "40%", height: 14 }} /></div></div>
        ))}
      </div>
    </div>
  );
}
