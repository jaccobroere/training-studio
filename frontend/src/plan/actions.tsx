import { useState } from "react";
import { DateField } from "../ui/DateField";
import type { Day, Workout } from "../api/types";
import { useDock } from "../app/dock";
import { dayLabel, mondayOf, todayIso } from "../ui/dates";
import { moveInWeek, patchInWeek, useChange, type Op } from "./api";
import { DOW } from "./dates";

const ver = (w: Workout) => ({ [`workout:${w.id}`]: w.version });
const short = (d: string) => dayLabel(d).split(" ").slice(0, 2).join(" ");

/** Every one-step action on a workout, shared by the week rows, the editor and the inbox. */
export function useWorkoutActions() {
  const change = useChange();
  const dock = useDock();
  return {
    busy: change.isPending,
    done(w: Workout, date?: string) {
      change.mutate({
        ops: [{ op: "log_workout", workout_id: w.id, ...(date ? { date } : {}) }],
        toast: `Logged ${w.title}`,
        optimistic: { monday: w.week_monday, apply: (wk) => patchInWeek(wk, w.id, { state: "done", status: "planned" }) },
      });
    },
    /** Move to a day (or the tray). With `position` and the target day's current rows, the
     * whole day is renumbered in one change so the order is exact. */
    move(w: Workout, date: string | null, position?: number, siblings?: Workout[], weekMonday?: string) {
      const target = date ? mondayOf(date) : weekMonday ?? w.week_monday;
      const place = date ? { date } : { week_monday: target };
      let ops: Op[] = [{ op: "move_workout", id: w.id, ...place }];
      if (position != null && siblings) {
        const order = siblings.filter((x) => x.id !== w.id);
        order.splice(Math.min(position, order.length), 0, w);
        ops = order.flatMap((x, i) => (x.id === w.id ? [{ op: "move_workout", id: x.id, ...place, position: i }]
          : x.position === i ? [] : [{ op: "move_workout", id: x.id, ...place, position: i }]));
      }
      const sameDay = w.date === date && (date !== null || target === w.week_monday);
      change.mutate({
        ops,
        expected: ver(w),
        toast: sameDay ? `Reordered ${w.title}` : `Moved ${w.title} to ${date ? short(date) : "no day"}`,
        optimistic: target === w.week_monday ? { monday: w.week_monday, apply: (wk) => moveInWeek(wk, w.id, date, position) } : undefined,
      });
    },
    duplicate(w: Workout) {
      change.mutate({ ops: [{ op: "duplicate_workout", id: w.id }], toast: `Duplicated ${w.title}` });
    },
    copyTo(w: Workout, dates: string[]) {
      change.mutate({ ops: [{ op: "copy_workout", id: w.id, dates, week_mondays: [] }], toast: `Copied ${w.title} to ${dates.length} day${dates.length > 1 ? "s" : ""}` });
    },
    saveTemplate(w: Workout) {
      change.mutate({ ops: [{ op: "add_saved_workout", from_workout: w.id }], toast: `Saved ${w.title}` });
    },
    skip(w: Workout, reason: string) {
      change.mutate({
        ops: [{ op: "set_workout_status", id: w.id, status: "skipped", reason }], expected: ver(w), toast: `Skipped ${w.title}`,
        optimistic: { monday: w.week_monday, apply: (wk) => patchInWeek(wk, w.id, { state: "skipped", status: "skipped", skip_reason: reason }) },
      });
    },
    unskip(w: Workout) {
      change.mutate({ ops: [{ op: "set_workout_status", id: w.id, status: "planned" }], expected: ver(w), toast: `Reset ${w.title} to planned` });
    },
    remove(w: Workout, scope: "one" | "following" | "all" = "one", after?: () => void) {
      change.mutate({
        ops: [{ op: "delete_workout", id: w.id, scope }], expected: ver(w),
        toast: scope === "one" ? `Deleted ${w.title}` : scope === "all" ? `Deleted the series ${w.title}` : `Deleted ${w.title} and following`,
        optimistic: scope === "one" ? { monday: w.week_monday, apply: (wk) => ({
          ...wk, days: wk.days.map((d) => ({ ...d, workouts: d.workouts.filter((x) => x.id !== w.id) })), tray: wk.tray.filter((x) => x.id !== w.id),
        }) } : undefined,
      }, { onSuccess: after });
    },
    openEditor(w: Workout) { dock.open({ kind: "editor", id: w.id }); },
    openLog(w: Workout) { dock.open({ kind: "log", workoutId: w.id }); },
  };
}

/** "Move to…": seven day keys, "No day", or any other date. */
export function MoveMenu({ w, days, onPick }: { w: Workout; days: Day[]; onPick: (d: string | null) => void }) {
  const [other, setOther] = useState("");
  return (
    <div className="move">
      <span className="silk">This week</span>
      <div className="move-days" role="toolbar" aria-label="Day" onKeyDown={(e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const btns = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        if (i < 0) return;
        e.preventDefault();
        btns[(i + (e.key === "ArrowRight" ? 1 : btns.length - 1)) % btns.length]?.focus();
      }}>
        {days.map((d, i) => (
          <button key={d.date} className={`key ${d.date === w.date ? "is-latched" : ""}`}
            disabled={d.date === w.date} onClick={() => onPick(d.date)} aria-label={dayLabel(d.date)}>
            <span>{DOW[i]}</span><span className="mono">{Number(d.date.slice(8))}</span>
          </button>
        ))}
      </div>
      <button className="key plain move-uns" disabled={w.date == null} onClick={() => onPick(null)}>No day yet</button>
      <div className="move-other">
        <div className="field-l"><span className="silk">Other date</span>
          <DateField value={other || null} label="Other date" placeholder="Pick a date" onChange={(v) => { if (v) { setOther(v); onPick(v); } }} />
        </div>
      </div>
    </div>
  );
}

/** "Copy to…": pick one or more dates. */
export function CopyTo({ onCopy, initial }: { onCopy: (dates: string[]) => void; initial?: string }) {
  const [dates, setDates] = useState<string[]>([]);
  const [d, setD] = useState(initial ?? todayIso());
  const add = () => { if (d && !dates.includes(d)) setDates([...dates, d].sort()); };
  return (
    <div className="copyto">
      <div className="move-other">
        <div className="field-l"><span className="silk">Copy to date</span>
          <DateField value={d} label="Copy to date" onChange={(v) => v && setD(v)} />
        </div>
        <button className="key" type="button" onClick={add} disabled={!d}>Add</button>
      </div>
      {dates.length > 0 && (
        <ul className="date-chips">
          {dates.map((x) => (
            <li key={x} className="tag">
              <span className="mono">{dayLabel(x)}</span>
              <button aria-label={`Remove ${dayLabel(x)}`} onClick={() => setDates(dates.filter((y) => y !== x))}>×</button>
            </li>
          ))}
        </ul>
      )}
      <div className="when-ft">
        <button className="key ink" disabled={!dates.length && !d} onClick={() => onCopy(dates.length ? dates : [d])}>
          Copy{dates.length > 1 ? ` to ${dates.length} days` : ""}
        </button>
      </div>
    </div>
  );
}

const REASONS = ["Sick", "Injured", "No time"];

export function SkipForm({ onSkip }: { onSkip: (reason: string) => void }) {
  const [r, setR] = useState("");
  return (
    <form className="when" onSubmit={(e) => { e.preventDefault(); onSkip(r.trim()); }}>
      <label className="field-l"><span className="silk">Reason</span>
        <input className="input" value={r} placeholder="Reason (optional)" onChange={(e) => setR(e.target.value)} />
      </label>
      <div className="row wrap">{REASONS.map((x) => <button key={x} type="button" className="key plain" onClick={() => onSkip(x)}>{x}</button>)}</div>
      <div className="when-ft"><button type="submit" className="key ink">Skip</button></div>
    </form>
  );
}

export function DeleteScope({ onPick }: { onPick: (s: "one" | "following" | "all") => void }) {
  return (
    <div className="when">
      <p className="when-t">Delete which?</p>
      <div className="scope-keys">
        <button className="key" onClick={() => onPick("one")}>This one</button>
        <button className="key" onClick={() => onPick("following")}>This and following</button>
        <button className="key danger" onClick={() => onPick("all")}>Whole series</button>
      </div>
      <p className="hint-l">Logged workouts are kept.</p>
    </div>
  );
}
