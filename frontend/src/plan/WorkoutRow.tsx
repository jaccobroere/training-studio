import { useDraggable, useDroppable } from "@dnd-kit/core";
import { DateField } from "../ui/DateField";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";
import type { Activity, Day, Workout } from "../api/types";
import { useDock } from "../app/dock";
import { Icon } from "../ui/Icon";
import { MenuItem, MenuList, MenuSep, Popover } from "../ui/Popover";
import { dayLabel } from "../ui/dates";
import { sportLabel } from "../ui/sport";
import { byTime } from "../editor/model";
import { CopyTo, DeleteScope, MoveMenu, SkipForm, useWorkoutActions } from "./actions";
import { actualValues, itemsLine, sourceLabel } from "./format";

/** After a keyboard move the row remounts under another day; focus follows it there. */
let focusAfterMove: string | null = null;
const followFocus = (id: string) => { focusAfterMove = id; };

function Status({ w }: { w: Workout }) {
  if (w.state === "done") return <span className="st done"><span className="g" aria-hidden="true">●</span><span className="w">Done</span></span>;
  if (w.state === "skipped") return <span className="st skipped" title={w.skip_reason || undefined}><span className="g" aria-hidden="true">⊘</span><span className="w">Skipped</span></span>;
  if (w.state === "not_logged") return <span className="st unlogged"><span className="g" aria-hidden="true">○</span><span className="w">Not logged</span></span>;
  return <span className="st" />;
}

/** One actual line: ■ GARMIN 10.4 km · 52:10 · 5:01/km · RPE 6. Opens the log sheet. */
export function ActLine({ a, withName, quiet, onOpen }: { a: Activity; withName?: boolean; quiet?: boolean; onOpen?: () => void }) {
  const nSkip = a.skipped_items?.length ?? 0;
  const base = actualValues(a);
  const vals = nSkip ? [base, `${nSkip} skipped`].filter(Boolean).join(" · ") : base;
  // On a plan row, a manual log with no numbers says nothing the Logged key does not: show no line.
  const manual = a.source === "manual";
  if (quiet && manual && !vals) return null;
  const body = <>
    <span className="act-mark" aria-hidden="true" />
    {withName && <span className="act-name">{a.name || sportLabel(a.type)}</span>}
    {!(quiet && manual) && <span className="silk act-src">{sourceLabel(a)}</span>}
    <span className="act-vals">{vals || "Logged"}</span>
  </>;
  if (!onOpen) return <span className="act-line">{body}</span>;
  return <button className="act-line" onClick={onOpen} aria-label={`${sourceLabel(a)} activity: ${vals || "logged"}. Open log`}>{body}</button>;
}

type Menu = "none" | "more" | "move" | "when" | "copy" | "skip" | "delete";

export function WorkoutRow({ w, days, today, index, dimmed, insert }: {
  w: Workout; days: Day[]; today: string; index: number; dimmed?: boolean; insert?: "before" | "after" | null;
}) {
  const dock = useDock();
  const act = useWorkoutActions();
  const moreRef = useRef<HTMLButtonElement>(null);
  const checkRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<Menu>("none");
  const [when, setWhen] = useState(today);
  const drag = useDraggable({ id: `w:${w.id}`, data: { workout: w } });
  const drop = useDroppable({ id: `row:${w.id}`, data: { date: w.date, index } });
  const done = w.state === "done";
  const future = w.date == null || w.date > today;
  const close = () => setMenu("none");
  // Mouse drags start on the grip; touch drags on a long press anywhere on the row.
  const { onMouseDown, onTouchStart } = (drag.listeners ?? {}) as Record<string, (e: unknown) => void>;

  useEffect(() => {
    if (focusAfterMove === w.id) {
      focusAfterMove = null;
      bodyRef.current?.focus({ preventScroll: false });
    }
  });

  const check = () => {
    if (done) return act.openLog(w);
    if (future) { setWhen(today); setMenu("when"); return; }
    act.done(w);
  };
  const moveTo = (date: string | null) => { close(); followFocus(w.id); act.move(w, date); };
  const moveBy = (n: number) => {
    if (!w.date) return;
    const i = days.findIndex((d) => d.date === w.date);
    const t = days[i + n];
    if (t) moveTo(t.date);
  };
  const reorder = (n: number) => {
    const day = days.find((d) => d.date === w.date);
    const list = day ? byTime(day.workouts) : [];
    const to = index + n;
    if (to < 0 || to >= list.length) return;
    followFocus(w.id);
    act.move(w, w.date, to, list);
  };
  const del = () => (w.series_id ? setMenu("delete") : (close(), act.remove(w)));

  const onKey = (e: KeyboardEvent) => {
    if (e.altKey) {
      if (e.key === "ArrowUp") reorder(-1);
      else if (e.key === "ArrowDown") reorder(1);
      else if (e.key === "ArrowLeft") moveBy(-1);
      else if (e.key === "ArrowRight") moveBy(1);
      else return;
      e.preventDefault();
      return;
    }
    if (e.metaKey || e.ctrlKey) return;
    const k = e.key.toLowerCase();
    if (k === "l") act.openLog(w);
    else if (k === " ") check();
    else if (k === "m") setMenu("move");
    else if (k === "d") act.duplicate(w);
    else if (e.key === "Backspace" || e.key === "Delete") del();
    else return;
    e.preventDefault();
  };

  const items = itemsLine(w.items);
  const cls = ["wrow", `s-${w.state}`, drag.isDragging ? "dragging" : "", dimmed ? "dim" : "", insert ? `ins-${insert}` : ""].join(" ");
  return (
    <div ref={(el) => { drag.setNodeRef(el); drop.setNodeRef(el); }} className={cls} data-workout={w.id} onTouchStart={onTouchStart}>
      <button className="grip" tabIndex={-1} aria-hidden="true" onMouseDown={onMouseDown}><Icon name="grip" /></button>
      <span className="mk-col">
        <span className="sport" title={sportLabel(w.type)}>{w.mark}</span>
        {w.time && <span className="mk-time mono" aria-hidden="true">{w.time}</span>}
      </span>
      <button ref={bodyRef} className="what" onClick={() => act.openEditor(w)} onKeyDown={onKey}
        aria-label={`${w.title}${w.date ? `, ${dayLabel(w.date)}` : ", no day yet"}${w.time ? ` at ${w.time}` : ""}. Enter to edit, L log, M move`}>
        <span className="ttl">
          <span className="t">{w.title}</span>
          {w.series_id && <Icon name="repeat" className="rep" />}
        </span>
        {items && <span className="items">{items}</span>}
      </button>
      <div className="rt">
        {w.tags.length > 0 && <span className="tags">
          {w.tags.slice(0, 2).map((t) => <Link key={t} className="tag" to={`/plan/weeks?tag=${encodeURIComponent(t)}`} title={`Show all #${t} workouts`}>#{t}</Link>)}
          {w.tags.length > 2 && <span className="tag" title={w.tags.slice(2).map((t) => `#${t}`).join(" ")}>+{w.tags.length - 2}</span>}
        </span>}
        <Status w={w} />
      </div>
      <button ref={checkRef} className={`logkey ${done ? "is-done" : ""} ${w.state === "not_logged" ? "is-late" : ""}`} onClick={check}
        aria-label={done ? `${w.title} is logged. Open log` : `${w.state === "not_logged" ? "Not logged: mark" : "Mark"} ${w.title} done`} title={done ? "Logged · open log" : "Mark as done"}>
        <span className="lk-ring" aria-hidden="true"><Icon name="check" /></span>
        <span className="lk-cap">{done ? "Logged" : "Done"}</span>
      </button>
      <button ref={moreRef} className="key sq flat more" aria-label={`More for ${w.title}`}
        aria-haspopup="menu" aria-expanded={menu === "more"} onClick={() => setMenu(menu === "more" ? "none" : "more")}>
        <Icon name="more" />
      </button>
      {w.activities.length > 0 && (
        <div className="acts-col">
          {w.activities.map((a) => <ActLine key={a.id} a={a} quiet onOpen={() => dock.open({ kind: "log", workoutId: w.id, activityId: a.id })} />)}
        </div>
      )}

      <Popover anchor={moreRef} open={menu === "more"} onClose={close} label={`Actions for ${w.title}`} width={220}>
        <MenuList label={`Actions for ${w.title}`}>
          <MenuItem onSelect={() => { close(); act.openEditor(w); }} hint="↵">Edit</MenuItem>
          <MenuItem onSelect={() => { close(); act.openLog(w); }} hint="L">Log…</MenuItem>
          <MenuItem onSelect={() => setMenu("move")} hint="M">Move to…</MenuItem>
          <MenuItem onSelect={() => { close(); act.duplicate(w); }} hint="D">Duplicate</MenuItem>
          <MenuItem onSelect={() => setMenu("copy")}>Copy to…</MenuItem>
          <MenuItem onSelect={() => { close(); act.saveTemplate(w); }}>Add to saved workouts</MenuItem>
          <MenuSep />
          {w.state === "skipped"
            ? <MenuItem onSelect={() => { close(); act.unskip(w); }}>Reset to planned</MenuItem>
            : <MenuItem disabled={done} onSelect={() => setMenu("skip")}>Skip…</MenuItem>}
          <MenuItem disabled={done} onSelect={del} hint="⌫">{w.series_id ? "Delete…" : "Delete"}</MenuItem>
        </MenuList>
      </Popover>
      <Popover anchor={moreRef} open={menu === "move"} onClose={close} label={`Move ${w.title}`} width={264}>
        <MoveMenu w={w} days={days} onPick={moveTo} />
      </Popover>
      <Popover anchor={moreRef} open={menu === "copy"} onClose={close} label={`Copy ${w.title}`} width={264}>
        <CopyTo initial={w.date ?? today} onCopy={(d) => { close(); act.copyTo(w, d); }} />
      </Popover>
      <Popover anchor={moreRef} open={menu === "skip"} onClose={close} label={`Skip ${w.title}`} width={264}>
        <SkipForm onSkip={(r) => { close(); act.skip(w, r); }} />
      </Popover>
      <Popover anchor={moreRef} open={menu === "delete"} onClose={close} label={`Delete ${w.title}`} width={264}>
        <DeleteScope onPick={(s) => { close(); act.remove(w, s); }} />
      </Popover>
      <Popover anchor={checkRef} open={menu === "when"} onClose={close} label="When did you do it?" width={260}>
        <form className="when" onSubmit={(e) => { e.preventDefault(); close(); act.done(w, when); }}>
          <p className="when-t">{w.date ? <>{w.title} is planned for {dayLabel(w.date)}.</> : <>{w.title} has no day yet.</>} Log it for:</p>
          <div className="field-l"><span className="silk">Date done</span>
            <DateField value={when} max={today} today={today} label="Date done" onChange={(v) => v && setWhen(v)} />
          </div>
          <div className="when-ft">
            <button type="button" className="key flat" onClick={close}>Cancel</button>
            <button type="submit" className="key ink">Log</button>
          </div>
        </form>
      </Popover>
    </div>
  );
}
