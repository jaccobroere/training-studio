import { chromeTop, holdChrome } from "../ui/chrome";
import {
  DndContext, DragOverlay, MouseSensor, TouchSensor, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { useEffect, useState, type ReactNode } from "react";
import type { Day, WeekView, Workout } from "../api/types";
import { useDock } from "../app/dock";
import { useMobile } from "../app/useMedia";
import { Icon } from "../ui/Icon";
import { dayLabel } from "../ui/dates";
import { useWorkoutActions } from "./actions";
import { ActivityRow } from "./ActivityRow";
import { byTime } from "../editor/model";
import { DOW } from "./dates";
import { WorkoutRow } from "./WorkoutRow";
import { LibSide, useAddFromLib, type LibDrag } from "./LibSide";

type Slot = { date: string | null; index: number };

function insertionFor({ over, date, n }: { over: Slot | null; date: string | null; n: number }) {
  return (i: number): "before" | "after" | null => {
    if (!over || over.date !== date) return null;
    if (over.index === i) return "before";
    if (over.index === n && i === n - 1) return "after";
    return null;
  };
}

/** Per-day load: one tick per planned workout (solid = logged, struck = skipped, hollow = still to do). */
function Load({ ws }: { ws: Workout[] }) {
  if (!ws.length) return null;
  const done = ws.filter((x) => x.state === "done").length;
  return (
    <span className="load" role="img" aria-label={`${done} of ${ws.length} logged`}>
      <span className="ticks">{ws.map((x) => <i key={x.id} className={x.state === "done" ? "on" : x.state === "skipped" ? "skip" : ""} />)}</span>
      <span className="mono n">{done}/{ws.length}</span>
    </span>
  );
}

function DayRow({ d, i, w, over, dragging, tag }: {
  d: Day; i: number; w: WeekView; over: Slot | null; dragging: boolean; tag: string | null;
}) {
  const dock = useDock();
  const mobile = useMobile();
  const drop = useDroppable({ id: `day:${d.date}`, data: { date: d.date } });
  const past = d.date < w.today;
  const workouts = byTime(d.workouts);
  const n = workouts.length + d.activities.length;
  const logged = workouts.filter((x) => x.state === "done").length;
  const [open, setOpen] = useState(false);
  const folded = mobile && past && !open && !dragging;
  const isOver = over?.date === d.date;
  const ins = insertionFor({ over, date: d.date, n: workouts.length });
  const add = () => dock.open({ kind: "editor", seed: { date: d.date, week_monday: w.monday } });
  const label = `${DOW[i]} ${Number(d.date.slice(8))}`;

  if (folded) {
    return (
      <div ref={drop.setNodeRef} className="day past folded">
        <button className="day-fold" aria-expanded={false} onClick={() => setOpen(true)}
          aria-label={`${dayLabel(d.date)}: ${workouts.length ? `${logged} of ${workouts.length} logged` : "nothing planned"}. Show`}>
          <span className="dow">{DOW[i]}</span><span className="dn mono">{Number(d.date.slice(8))}</span>
          <span className="marks mono">{workouts.map((x) => x.mark).join(" · ")}</span>
          {workouts.length ? <Load ws={workouts} /> : <span className="sum mono">{n ? `${n} unplanned` : ""}</span>}
          <Icon name="down" />
        </button>
      </div>
    );
  }
  return (
    <section ref={drop.setNodeRef} className={`day ${d.today ? "today" : ""} ${past ? "past" : ""} ${isOver ? "over" : ""} ${n ? "" : "empty"}`}
      aria-current={d.today ? "date" : undefined} aria-label={dayLabel(d.date)}>
      <div className="dlab">
        <span className="dow">{DOW[i]}</span>
        <span className="dn mono">{Number(d.date.slice(8))}</span>
        {d.today && <span className="tdy">Today</span>}
        <Load ws={workouts} />
        {mobile && past && <button className="key sq flat fold-k" aria-label={`Fold ${label}`} onClick={() => setOpen(false)}><Icon name="up" /></button>}
      </div>
      <div className="drows">
        {workouts.map((x, j) => (
          <WorkoutRow key={x.id} w={x} days={w.days} today={w.today} index={j} insert={ins(j)}
            dimmed={!!tag && !x.tags.includes(tag)} />
        ))}
        {!tag && d.activities.map((a) => <ActivityRow key={a.id} a={a} />)}
        {isOver && !workouts.length && <div className="ins-empty" aria-hidden="true" />}
        <button className="key sq flat add-day" onClick={add} aria-label={`Add a workout on ${dayLabel(d.date)}`}><Icon name="plus" /></button>
      </div>
    </section>
  );
}

function Tray({ w, over, dragging, tag }: { w: WeekView; over: Slot | null; dragging: boolean; tag: string | null }) {
  const drop = useDroppable({ id: "tray", data: { date: null } });
  const isOver = over?.date === null;
  if (!w.tray.length && !dragging) return null;
  const ins = insertionFor({ over, date: null, n: w.tray.length });
  return (
    <section ref={drop.setNodeRef} className={`tray ${w.tray.length ? "" : "empty"} ${isOver ? "over" : ""}`} aria-label="No day yet">
      <div className="dlab tray-lab"><span className="dow">No day yet</span><span className="tray-n mono">{w.tray.length}</span></div>
      <div className="drows">
        {w.tray.map((x, j) => <WorkoutRow key={x.id} w={x} days={w.days} today={w.today} index={j} insert={ins(j)}
          dimmed={!!tag && !x.tags.includes(tag)} />)}
        {!w.tray.length && <p className="tray-drop">Drop here for no day</p>}
      </div>
    </section>
  );
}

export function Board({ w, tag, lead, lib, onCloseLib }: {
  w: WeekView; tag: string | null; lead?: ReactNode; lib?: boolean; onCloseLib?: () => void;
}) {
  const act = useWorkoutActions();
  const addLib = useAddFromLib();
  const phone = useMobile();
  // Phone: a current week opens with today at the top of the list — but only when there is
  // something to land on. A first-run week leads with the "Set up your plan" card, and an empty
  // week with its quiet line; scrolling either under the bar hides the one thing worth reading.
  const land = !w.new_account && (w.days.some((d) => d.workouts.length > 0) || w.tray.length > 0);
  useEffect(() => {
    if (!land) return;
    const el = phone ? document.querySelector<HTMLElement>(".day.today") : null;
    const sc = el?.closest<HTMLElement>(".page-scroll");
    if (!el || !sc) return;
    holdChrome();
    sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - chromeTop(sc) - 8;
  }, [phone, w.monday, land]);
  const [libDrag, setLibDrag] = useState<LibDrag | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 350, tolerance: 8 } }),
  );
  const [dragging, setDragging] = useState<Workout | null>(null);
  const [over, setOver] = useState<Slot | null>(null);

  const listOf = (date: string | null) => (date === null ? w.tray : byTime(w.days.find((d) => d.date === date)?.workouts ?? []));
  const slotOf = (e: DragOverEvent | DragEndEvent): Slot | null => {
    const o = e.over;
    if (!o) return null;
    const id = String(o.id);
    if (id === "tray") return { date: null, index: w.tray.length };
    if (id.startsWith("day:")) { const date = id.slice(4); return { date, index: listOf(date).length }; }
    const data = o.data.current as { date: string | null; index: number };
    const r = e.active.rect.current.translated;
    const below = r ? r.top + r.height / 2 > o.rect.top + o.rect.height / 2 : false;
    return { date: data.date, index: data.index + (below ? 1 : 0) };
  };

  const onStart = (e: DragStartEvent) => {
    const d = e.active.data.current as { workout?: Workout; lib?: LibDrag };
    if (d.lib) setLibDrag(d.lib); else setDragging(d.workout!);
  };
  const onOver = (e: DragOverEvent) => setOver(slotOf(e));
  const onEnd = (e: DragEndEvent) => {
    const s = slotOf(e);
    const d = e.active.data.current as { workout?: Workout; lib?: LibDrag };
    setDragging(null);
    setLibDrag(null);
    setOver(null);
    if (!s) return;
    if (d.lib) { addLib(d.lib, s.date, w.monday); return; }
    const wk = d.workout!;
    const list = listOf(s.date);
    const from = list.findIndex((x) => x.id === wk.id);
    let index = s.index;
    if (from !== -1) {
      if (index === from || index === from + 1) return; // dropped where it was
      if (index > from) index -= 1;
    }
    const append = index >= list.filter((x) => x.id !== wk.id).length;
    act.move(wk, s.date, append && from === -1 ? undefined : index, append && from === -1 ? undefined : list);
  };

  return (
    <DndContext sensors={sensors} onDragStart={onStart} onDragOver={onOver} onDragEnd={onEnd}
      onDragCancel={() => { setDragging(null); setLibDrag(null); setOver(null); }}
      accessibility={{
        announcements: {
          onDragStart: () => "Picked up workout.",
          onDragOver: ({ over: o }) => (o ? `Over ${String(o.id).replace(/^(day|row):/, "")}` : "Not over a day"),
          onDragEnd: ({ over: o }) => (o ? "Dropped." : "Dropped nowhere; nothing moved"),
          onDragCancel: () => "Move cancelled",
        },
      }}>
      <div className="plan-body">
        {lib && <LibSide onClose={() => onCloseLib?.()} />}
        <div className="page-scroll week-scroll">
          <div className="board">
            {lead}
            <div className={`days ${dragging || libDrag ? "is-dragging" : ""}`}>
              {w.days.map((d, i) => <DayRow key={d.date} d={d} i={i} w={w} over={over} dragging={!!dragging || !!libDrag} tag={tag} />)}
              <Tray w={w} over={over} dragging={!!dragging || !!libDrag} tag={tag} />
            </div>
          </div>
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {dragging && <div className="drag-ghost"><span className="sport">{dragging.mark}</span><span className="ttl">{dragging.title}</span></div>}
        {libDrag && <div className="drag-ghost"><span className="sport">{libDrag.mark}</span><span className="ttl">{libDrag.title}</span></div>}
      </DragOverlay>
    </DndContext>
  );
}
