import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";
import type { ExerciseSession, Item, LoggedSet } from "../api/types";
import { prescription } from "../plan/quick";
import { Icon } from "../ui/Icon";
import { shortDate } from "../ui/dates";
import { plannedCount, prefill, setsText, toSet, type Row, type SetMeasure } from "./sets";

/** The last session that logged this exercise, other than the one being logged now. */
function useLastSession(exerciseId: string, activityId?: string) {
  return useQuery({
    queryKey: ["exercise", exerciseId, "history", 3], staleTime: 60_000,
    queryFn: () => api<ExerciseSession[]>(`/api/exercises/${encodeURIComponent(exerciseId)}/history?limit=3`),
    select: (h) => h.find((s) => s.activity_id !== activityId),
  });
}

/** Pressing a key must not move focus or start a text selection (rapid taps used to select the sign). */
const keep = (e: React.PointerEvent) => e.preventDefault();

const STEP = { reps: 1, kg: 2.5, secs: 5 } as const;

/** A number with − and + keys either side: big targets for a phone between sets. */
function Stepper({ value, onChange, step, label, unit, decimal }: {
  value?: number; onChange: (v?: number) => void; step: number; label: string; unit?: string; decimal?: boolean;
}) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (value == null ? "" : String(value));
  const bump = (d: number) => { setText(null); onChange(Math.max(0, Math.round(((value ?? 0) + d) * 100) / 100)); };
  return (
    <span className="stp">
      <button type="button" className="stp-k" tabIndex={-1} onPointerDown={keep} aria-label={`${label} minus ${step}`} onClick={() => bump(-step)}>−</button>
      <span className="stp-mid">
        <input className="stp-in mono" inputMode={decimal ? "decimal" : "numeric"} aria-label={label} value={shown} placeholder="—"
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            setText(e.target.value);
            const v = e.target.value.trim().replace(",", ".");
            if (v === "") onChange(undefined);
            else if (Number.isFinite(Number(v))) onChange(Number(v));
          }}
          onBlur={() => setText(null)} />
        {unit && <span className="stp-u" aria-hidden="true">{unit}</span>}
      </span>
      <button type="button" className="stp-k" tabIndex={-1} onPointerDown={keep} aria-label={`${label} plus ${step}`} onClick={() => bump(step)}>+</button>
    </span>
  );
}

/** One exercise in the log: done/skipped tick, the plan beside it, and a row per set. Logged rows
 * are solid; the rest are the plan's (or last time's) numbers waiting for a tap on ○. Logging,
 * editing and removing a set saves at once (the caller debounces). */
export function ItemSets({ it, n, measure, logged, activityId, skipped, disabled, extra, onSkip, onChange }: {
  it: Item; n: number; measure: SetMeasure; logged: LoggedSet[]; activityId?: string; skipped: boolean; disabled?: boolean;
  /** An exercise with no plan: no skip tick; a × removes it while it has no logged sets. `added` marks it as added to a plan. */
  extra?: { onRemove: () => void; added: boolean };
  onSkip: (skipped: boolean) => void; onChange: (sets: LoggedSet[]) => void;
}) {
  const last = useLastSession(it.exercise_id, activityId).data;
  const lastRows: Row[] | undefined = last?.sets;
  const [pending, setPending] = useState<Row[] | null>(null);
  // Rows still to do: the plan's count minus what is logged, until the athlete adds or removes one.
  const todo = pending ?? Array.from({ length: Math.max(0, plannedCount(it) - logged.length) }, (_, i) => prefill(it, measure, logged.length + i, lastRows));
  const countKey = measure === "reps" ? "reps" : "secs";
  const showKg = measure === "reps" || logged.some((s) => s.kg) || !!it.load;

  const log = (i: number) => {
    const s = toSet(it, measure, todo[i]);
    if (!s) return;
    setPending(todo.filter((_, j) => j !== i));
    onChange([...logged, s]);
  };
  const unlog = (i: number) => {
    const s = logged[i];
    setPending([{ reps: s.reps, kg: s.kg, secs: s.secs }, ...todo]);
    onChange(logged.filter((_, j) => j !== i));
  };
  const editLogged = (i: number, r: Row) => {
    const s = toSet(it, measure, { ...logged[i], ...r });
    if (s) onChange(logged.map((x, j) => (j === i ? s : x)));
  };
  const editTodo = (i: number, r: Row) => setPending(todo.map((x, j) => (j === i ? { ...x, ...r } : x)));
  const add = () => {
    const prev = todo[todo.length - 1] ?? logged[logged.length - 1] ?? prefill(it, measure, logged.length, lastRows);
    setPending([...todo, { reps: prev.reps, kg: prev.kg, secs: prev.secs }]);
  };
  const remove = (i: number) => setPending(todo.filter((_, j) => j !== i));

  const row = (r: Row, i: number, done: boolean) => {
    const no = done ? i + 1 : logged.length + i + 1;
    const edit = (x: Row) => (done ? editLogged(i, x) : editTodo(i, x));
    return (
      <li key={`${done ? "d" : "t"}${i}`} className={`set-row ${done ? "is-done" : ""}`}>
        {!done && i >= Math.max(0, plannedCount(it) - logged.length)
          ? <button type="button" className="set-x mono" aria-label={`Remove ${it.name} set ${no}`} onClick={() => remove(i)}><Icon name="close" /></button>
          : <span className="set-no mono" aria-hidden="true">{no}</span>}
        <Stepper label={`${it.name} set ${no} ${measure === "reps" ? "reps" : "seconds"}`} unit={measure === "reps" ? undefined : "s"}
          value={r[countKey]} step={STEP[countKey]} onChange={(v) => edit({ [countKey]: v })} />
        {showKg ? <Stepper label={`${it.name} set ${no} kilograms`} unit="kg" decimal value={r.kg} step={STEP.kg} onChange={(v) => edit({ kg: v })} /> : <span />}
        <button type="button" className={`set-k ${done ? "on" : ""}`} disabled={disabled || (!done && r[countKey] == null)}
          aria-pressed={done} aria-label={done ? `${it.name} set ${no} done; tap to undo` : `Log ${it.name} set ${no}`} onClick={() => (done ? unlog(i) : log(i))}>
          <Icon name="check" />
        </button>
      </li>
    );
  };

  return (
    <li className={`sl-item ${skipped ? "off" : ""}`}>
      <div className="sl-hd">
        {extra ? (
          <span className="sl-ck">
            <span className="inum mono">{String(n).padStart(2, "0")}</span>
            <span className="sl-name">{it.name}</span>
            {extra.added && <span className="silk sl-added">Added</span>}
          </span>
        ) : (
          <label className="sl-ck">
            <input type="checkbox" checked={!skipped} disabled={disabled || (skipped ? false : logged.length > 0)}
              title={logged.length ? "Has logged sets" : undefined} onChange={() => onSkip(!skipped)} />
            <span className="inum mono">{String(n).padStart(2, "0")}</span>
            <span className="sl-name">{it.name}</span>
          </label>
        )}
        {extra
          ? <button type="button" className="key sq flat sl-rm" disabled={disabled || logged.length > 0} aria-label={`Remove ${it.name}`}
              title={logged.length ? "Has logged sets: undo them first" : `Remove ${it.name}`} onClick={extra.onRemove}><Icon name="close" /></button>
          : <span className="sl-rx mono">{prescription(it)}</span>}
      </div>
      {!skipped && <>
        {last && <p className="sl-last">Last {shortDate(last.date)}: <span className="mono">{setsText(last.sets)}</span></p>}
        <div className="sl-cols silk" aria-hidden="true"><span /><span>{measure === "reps" ? "Reps" : "Time"}</span>{showKg ? <span>kg</span> : <span />}<span /></div>
        <ul className="set-rows">
          {logged.map((s, i) => row({ reps: s.reps, kg: s.kg, secs: s.secs }, i, true))}
          {todo.map((r, i) => row(r, i, false))}
        </ul>
        <button type="button" className="key plain sl-add" disabled={disabled} aria-label={`Add a set of ${it.name}`} onClick={add}><Icon name="plus" />Set</button>
      </>}
    </li>
  );
}
