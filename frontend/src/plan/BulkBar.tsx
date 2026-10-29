import { useEffect, useRef, useState } from "react";
import { autoFocus } from "../ui/autoFocus";
import { Calendar } from "../ui/DateField";
import { dayLabel, mondayOf } from "../ui/dates";
import { Icon } from "../ui/Icon";
import { Popover } from "../ui/Popover";
import { useChange, useTags, weeksMovePatch, weeksRemovePatch, type Op } from "./api";
import { shiftTargets, shiftWords, type Indexed } from "./weeksModel";

export type BulkAsk = "move" | "shift" | "tag" | "delete";

const norm = (t: string) => t.trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-").slice(0, 30);

/** Replaces the toolbar while something is selected: n selected │ Move… · Shift… · Tag… ·
 * Delete │ ×. Every action is one change with Undo. */
export function BulkBar({ chips, mobile, today, ask, onAsk, onClear, onShiftPreview }: {
  chips: Indexed[]; mobile: boolean; today?: string; ask: BulkAsk | null; onAsk: (a: BulkAsk | null) => void;
  onClear: () => void; onShiftPreview: (n: number) => void;
}) {
  const change = useChange();
  const moveRef = useRef<HTMLButtonElement>(null);
  const shiftRef = useRef<HTMLButtonElement>(null);
  const tagRef = useRef<HTMLButtonElement>(null);
  const [n, setN] = useState(7);
  const ids = chips.map((c) => c.id);
  const count = chips.length;
  const logged = chips.filter((c) => c.state === "done").length;
  const repeats = chips.some((c) => c.series_id);
  const expected = Object.fromEntries(chips.map((c) => [`workout:${c.id}`, c.version]));
  const what = count === 1 ? "1 workout" : `${count} workouts`;
  const close = () => { onAsk(null); onShiftPreview(0); };

  useEffect(() => { onShiftPreview(ask === "shift" ? n : 0); }, [ask, n, onShiftPreview]);

  const moveTo = (date: string) => {
    close();
    const moves = new Map(chips.map((c) => [c.id, { date, week_monday: mondayOf(date) }] as const));
    const ops: Op[] = chips.filter((c) => c.date !== date).map((c) => ({ op: "move_workout", id: c.id, date }));
    if (!ops.length) return;
    change.mutate({ ops, expected, toast: `Moved ${what} to ${dayLabel(date)}`, patches: [weeksMovePatch(moves)] });
  };
  const shift = () => {
    close();
    if (!n) return;
    change.mutate({ ops: [{ op: "shift_workouts", ids, days: n }], expected, toast: `Moved ${shiftWords(count, n)}`, patches: [weeksMovePatch(shiftTargets(chips, n))] });
  };
  const del = () => {
    close();
    change.mutate({
      ops: [{ op: "bulk_delete", ids }], expected, noKept: true,
      toast: (r) => { const gone = count - r.kept.length; return `Deleted ${gone === 1 ? "1 workout" : `${gone} workouts`}${r.kept.length ? ` · ${r.kept.length} logged kept` : ""}`; },
      patches: [weeksRemovePatch(new Set(chips.filter((c) => c.state !== "done").map((c) => c.id)))],
    }, { onSuccess: onClear });
  };

  if (ask === "delete") {
    return (
      <div className="bulkbar asking" role="toolbar" aria-label="Confirm delete">
        <span className="bb-q">Delete {what}?{logged ? <span className="bb-note"> {logged} logged {logged === 1 ? "is" : "are"} kept.</span> : null}
          {repeats ? <span className="bb-note"> Repeating workouts keep their other dates.</span> : null}</span>
        <span className="fill" />
        <button className="key flat" ref={autoFocus} onClick={() => onAsk(null)}>Cancel</button>
        <button className="key danger" disabled={logged === count} onClick={del}>Delete</button>
      </div>
    );
  }
  const keys = (
    <div className="bb-keys">
      <button ref={moveRef} className="key plain flat" aria-haspopup="dialog" aria-expanded={ask === "move"} onClick={() => onAsk(ask === "move" ? null : "move")}><Icon name="cal" />Move…</button>
      <button ref={shiftRef} className="key plain flat" aria-haspopup="dialog" aria-expanded={ask === "shift"} onClick={() => onAsk(ask === "shift" ? null : "shift")}><Icon name="move" />Shift…</button>
      <button ref={tagRef} className="key plain flat" aria-haspopup="dialog" aria-expanded={ask === "tag"} onClick={() => onAsk(ask === "tag" ? null : "tag")}><Icon name="tag" />Tag…</button>
      <button className="key plain flat" onClick={() => onAsk("delete")}><Icon name="trash" />Delete</button>
    </div>
  );
  const head = <>
    <span className="bb-n" aria-live="polite"><span className="mono">{count}</span> selected</span>
    {!mobile && <span className="div" />}
  </>;
  return (
    <div className="bulkbar" role="toolbar" aria-label={`${count} selected`}>
      {mobile ? <>
        <div className="strip-row">{head}<span className="fill" /><button className="key flat plain" onClick={onClear}>Done</button></div>
        <div className="strip-row">{keys}</div>
      </> : <>
        {head}{keys}<span className="fill" />
        <span className="bb-hint muted small">Esc to clear</span>
        <button className="key sq flat" aria-label="Clear selection" onClick={onClear}><Icon name="close" /></button>
      </>}

      <Popover anchor={moveRef} open={ask === "move"} onClose={close} label={`Move ${what}`} align="start" width={262}>
        <p className="pop-t">Move {what} to</p>
        <Calendar value={null} today={today} label="Move to" marks={new Set(chips.flatMap((c) => (c.date ? [c.date] : [])))} onPick={moveTo} />
      </Popover>
      <Popover anchor={shiftRef} open={ask === "shift"} onClose={close} label={`Shift ${what}`} align="start" width={264}>
        <form className="shift-pop" onSubmit={(e) => { e.preventDefault(); shift(); }}>
          <span className="silk">Shift by days</span>
          <div className="stepper big">
            <button type="button" className="key sq" aria-label="One day earlier" disabled={n <= -14} onClick={() => setN(n - 1 === 0 ? -1 : n - 1)}>−</button>
            <span className="mono" aria-live="polite">{n > 0 ? `+${n}` : n}</span>
            <button type="button" className="key sq" aria-label="One day later" disabled={n >= 14} onClick={() => setN(n + 1 === 0 ? 1 : n + 1)}>+</button>
          </div>
          <div className="row wrap">
            {[-7, -1, 1, 7, 14].map((x) => <button type="button" key={x} className={`key plain ${x === n ? "is-latched" : ""}`} onClick={() => setN(x)}>{x > 0 ? `+${x}` : x}</button>)}
          </div>
          <p className="pop-hint">{shiftWords(count, n)}. The dashed chips show where they land.</p>
          <div className="when-ft"><button type="button" className="key flat" onClick={close}>Cancel</button><button className="key ink" type="submit">Shift</button></div>
        </form>
      </Popover>
      <Popover anchor={tagRef} open={ask === "tag"} onClose={close} label={`Tag ${what}`} align="start" width={260}>
        <TagPicker chips={chips} onSet={(t, on) => change.mutate({
          // Adding/removing one tag commutes with other edits, so no version check (and no 409
          // when two tags are ticked back to back).
          ops: [{ op: "set_tags", ids, ...(on ? { add: [t] } : { remove: [t] }) }],
          toast: on ? `Tagged ${what} #${t}` : `Removed #${t} from ${what}`,
        })} />
      </Popover>
    </div>
  );
}

/** Tags in use with a tri-state mark for the selection; click adds to all or removes from all. */
function TagPicker({ chips, onSet }: { chips: Indexed[]; onSet: (tag: string, on: boolean) => void }) {
  const all = useTags();
  const [v, setV] = useState("");
  const names = [...new Set([...(all.data ?? []).map((t) => t.tag), ...chips.flatMap((c) => c.tags)])];
  const term = norm(v);
  const shown = names.filter((t) => !term || t.includes(term)).slice(0, 12);
  return (
    <div className="tagpick">
      <form onSubmit={(e) => { e.preventDefault(); if (term) { onSet(term, true); setV(""); } }}>
        <input className="input" ref={autoFocus} value={v} placeholder="Find or create a tag" aria-label="Tag" onChange={(e) => setV(e.target.value)} />
      </form>
      <ul className="tp-list" role="group" aria-label="Tags">
        {term && !names.includes(term) && (
          <li><button className="tp-row" onClick={() => { onSet(term, true); setV(""); }}><span className="tp-box" aria-hidden="true">+</span>Create <b>#{term}</b></button></li>
        )}
        {shown.map((t) => {
          const n = chips.filter((c) => c.tags.includes(t)).length;
          const state = n === 0 ? "none" : n === chips.length ? "all" : "some";
          return (
            <li key={t}>
              <button className={`tp-row ${state}`} role="checkbox" aria-checked={state === "all" ? true : state === "some" ? "mixed" : false}
                onClick={() => onSet(t, state !== "all")}>
                <span className="tp-box" aria-hidden="true">{state === "all" ? "✓" : state === "some" ? "–" : ""}</span>
                <span className="mono">#{t}</span>
                {state === "some" && <span className="tp-n mono">{n}/{chips.length}</span>}
              </button>
            </li>
          );
        })}
        {!shown.length && !term && <li className="muted small pad-s">No tags</li>}
      </ul>
    </div>
  );
}
