import { useMemo, useRef, useState } from "react";
import type { Exercise, WorkoutType } from "../api/types";
import { readPref, writePref } from "../app/prefs";
import { useChange, useExercises } from "../plan/api";
import { autoFocus } from "../ui/autoFocus";
import { Icon } from "../ui/Icon";
import { useFocusTrap } from "../ui/focusTrap";

const MEASURE: Record<string, string> = { reps: "reps", time: "time", distance: "dist" };

function rememberRecent(ids: string[]) {
  const prev = readPref<string[]>("recent.exercises", []);
  writePref("recent.exercises", [...ids, ...prev.filter((x) => !ids.includes(x))].slice(0, 12));
}

/** Phone presentation of the picker: a bottom sheet over a scrim, with a grabber; tapping the scrim closes it. */
export function PickerSheet({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, { onEscape: onClose });
  return <>
    <div className="scrim" aria-hidden="true" onClick={onClose} />
    <div ref={ref} className="sheet bottom picker-sheet" role="dialog" aria-modal="true" aria-label="Add exercises">
      <span className="grab" aria-hidden="true" />
      {children}
    </div>
  </>;
}

/** Search, tick several, add. No exact match → "+ Create '…'" with the workout's type. */
export function ExercisePicker({ type, onAdd, onClose }: {
  type: WorkoutType; onAdd: (ex: { id: string; name: string }[]) => void; onClose: () => void;
}) {
  const ex = useExercises();
  const change = useChange();
  const [q, setQ] = useState("");
  const [ticked, setTicked] = useState<string[]>([]);
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const all = useMemo(() => (ex.data ?? []).filter((e) => !e.archived), [ex.data]);
  const byId = useMemo(() => new Map((ex.data ?? []).map((e) => [e.id, e])), [ex.data]);
  const term = q.trim().toLowerCase();
  const rows: Exercise[] = useMemo(() => {
    if (term) {
      const hits = all.filter((e) => e.name.toLowerCase().includes(term));
      return hits.sort((a, b) => Number(b.name.toLowerCase().startsWith(term)) - Number(a.name.toLowerCase().startsWith(term)) || a.name.localeCompare(b.name));
    }
    const recent = readPref<string[]>("recent.exercises", []).map((id) => byId.get(id)).filter((e): e is Exercise => !!e && !e.archived).slice(0, 5);
    const rest = all.filter((e) => !recent.includes(e)).sort((a, b) => Number(b.type === type) - Number(a.type === type) || a.name.localeCompare(b.name));
    return [...recent, ...rest];
  }, [term, all, byId, type]);
  const exact = all.some((e) => e.name.toLowerCase() === term);
  const canCreate = !!term && !exact;
  const total = rows.length + (canCreate ? 1 : 0);
  // "+ Create" leads when nothing matches; otherwise it waits at the end so Enter picks a match.
  const createAt = canCreate ? (rows.length ? rows.length : 0) : -1;
  const rowIndex = (j: number) => (createAt === 0 ? j + 1 : j);

  const toggle = (id: string) => setTicked((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  const create = async () => {
    const name = q.trim();
    const res = await change.mutateAsync({
      ops: [{ op: "add_exercise", name, type, default_measure: type === "run" || type === "ride" || type === "swim" ? "distance" : "reps" }],
      toast: `Created ${name}`,
    });
    const id = res.diffs.find((d) => d.key.startsWith("exercise:") && d.kind === "created")?.key.slice(9);
    if (id) { setTicked((t) => [...t, id]); setQ(""); }
  };
  const commit = (ids = ticked) => {
    const list = ids.map((id) => byId.get(id)).filter((e): e is Exercise => !!e).map((e) => ({ id: e.id, name: e.name }));
    if (!list.length) return;
    rememberRecent(list.map((e) => e.id));
    onAdd(list);
  };
  const scrollTo = (i: number) => listRef.current?.children[i]?.scrollIntoView({ block: "nearest" });

  const createRow = canCreate && (
    <li id={`pk-${createAt}`} role="option" aria-selected={false} className={`pk-row create ${hi === createAt ? "hi" : ""}`}>
      <button onClick={() => void create()} disabled={change.isPending}><Icon name="plus" />Create “{q.trim()}”</button>
    </li>
  );
  return (
    <div className="picker" role="dialog" aria-label="Add exercises">
      <div className="search picker-search">
        <Icon name="search" />
        <input className="input" ref={autoFocus} value={q} placeholder="Search exercises" aria-label="Search exercises"
          aria-controls="picker-list" aria-activedescendant={total ? `pk-${hi}` : undefined}
          onChange={(e) => { setQ(e.target.value); setHi(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); const n = Math.min(total - 1, hi + 1); setHi(n); scrollTo(n); }
            else if (e.key === "ArrowUp") { e.preventDefault(); const n = Math.max(0, hi - 1); setHi(n); scrollTo(n); }
            else if (e.key === "Enter") {
              e.preventDefault();
              if (ticked.length) commit();
              else if (hi === createAt) void create();
              else { const r = rows[createAt === 0 ? hi - 1 : hi]; if (r) commit([r.id]); }
            } else if (e.key === "Escape") { e.stopPropagation(); onClose(); }
          }} />
      </div>
      <ul id="picker-list" ref={listRef} className="picker-list" role="listbox" aria-multiselectable="true" aria-label="Exercises">
        {createAt === 0 && createRow}
        {rows.map((e, j) => {
          const i = rowIndex(j);
          const on = ticked.includes(e.id);
          return (
            <li key={e.id} id={`pk-${i}`} role="option" aria-selected={on} className={`pk-row ${hi === i ? "hi" : ""} ${on ? "on" : ""}`}>
              <label>
                <input type="checkbox" checked={on} onChange={() => toggle(e.id)} />
                <span className="pk-name">{e.name}</span>
                <span className="pk-meta mono">{e.mark}</span>
                <span className="pk-meta mono">{MEASURE[e.default_measure]}</span>
              </label>
            </li>
          );
        })}
        {createAt > 0 && createRow}
        {!rows.length && !canCreate && <li className="muted small pad-s">No exercises</li>}
      </ul>
      <div className="picker-ft">
        <span className="mono muted">{ticked.length ? `${ticked.length} selected` : ""}</span>
        <span className="fill" />
        <button className="key flat" onClick={onClose}>Cancel</button>
        <button className="key ink" disabled={!ticked.length} onClick={() => commit()}>Add{ticked.length ? ` ${ticked.length}` : ""}</button>
      </div>
    </div>
  );
}
