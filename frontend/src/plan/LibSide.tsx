import { useDraggable } from "@dnd-kit/core";
import { useRef, useState } from "react";
import type { WorkoutType } from "../api/types";
import { Calendar } from "../ui/DateField";
import { dayLabel, mondayOf, todayIso } from "../ui/dates";
import { Icon } from "../ui/Icon";
import { Popover } from "../ui/Popover";
import { useChange, useExercises, useSaved, useToday, type Op } from "./api";
import { itemsLine } from "./format";

/** What a Library row carries while dragged onto a day. */
export interface LibDrag { kind: "saved" | "exercise"; id: string; title: string; mark: string; type: WorkoutType }

const newId = () => `w-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

/** Add a saved workout (or a one-exercise workout) on a day, or in a week's "no day yet". */
export function useAddFromLib() {
  const change = useChange();
  return (it: LibDrag, date: string | null, monday?: string) => {
    const place = date ? { date } : { week_monday: monday ?? mondayOf(todayIso()) };
    const op: Op = it.kind === "saved"
      ? { op: "add_workout", id: newId(), ...place, from_saved: it.id }
      : { op: "add_workout", id: newId(), ...place, title: it.title, type: it.type, items: [{ exercise_id: it.id }] };
    change.mutate({ ops: [op], toast: `Added ${it.title} to ${date ? dayLabel(date) : "no day"}` });
  };
}

function Row({ it, sub }: { it: LibDrag; sub: string }) {
  const drag = useDraggable({ id: `lib:${it.kind}:${it.id}`, data: { lib: it } });
  const ref = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const add = useAddFromLib();
  const today = useToday().data?.today;
  return (
    <li className={`ls-row ${drag.isDragging ? "dragging" : ""}`}>
      <button ref={(el) => { ref.current = el; drag.setNodeRef(el); }} {...drag.listeners} {...drag.attributes}
        className="ls-k" aria-haspopup="dialog" aria-expanded={open} aria-roledescription="draggable"
        aria-label={`${it.title}. Drag onto a day, or press Enter to pick a day`}
        onClick={() => setOpen(true)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(true); } }}>
        <span className="ls-mark mono">{it.mark}</span>
        <span className="ls-b"><span className="ls-t">{it.title}</span>{sub && <span className="ls-s mono">{sub}</span>}</span>
        <Icon name="grip" className="ls-grip" />
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} label={`Add ${it.title} to a day`} align="start" width={262}>
        <p className="pop-t">Add <b>{it.title}</b> to</p>
        <Calendar value={null} today={today} label="Day" onPick={(d) => { setOpen(false); add(it, d); }} />
      </Popover>
    </li>
  );
}

/** The 280px Library drawer on Plan (desktop/tablet). Rows drag onto days; Enter or a click
 * picks a day from a calendar instead. */
export function LibSide({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"saved" | "exercises">("saved");
  const [q, setQ] = useState("");
  const saved = useSaved();
  const ex = useExercises();
  const term = q.trim().toLowerCase();
  const rows: { it: LibDrag; sub: string }[] = tab === "saved"
    ? (saved.data ?? []).filter((s) => !term || s.title.toLowerCase().includes(term))
      .map((s) => ({ it: { kind: "saved", id: s.id, title: s.title, mark: s.mark, type: s.type }, sub: itemsLine(s.items, 2) }))
    : (ex.data ?? []).filter((e) => !e.archived && (!term || e.name.toLowerCase().includes(term)))
      .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name))
      .map((e) => ({ it: { kind: "exercise", id: e.id, title: e.name, mark: e.mark, type: e.type }, sub: e.default_measure }));
  return (
    <aside className="libside" aria-label="Library">
      <div className="ls-hd">
        <div className="seg" role="radiogroup" aria-label="Library list">
          <button role="radio" aria-checked={tab === "saved"} className={`key ${tab === "saved" ? "is-on" : ""}`} onClick={() => setTab("saved")}>Saved</button>
          <button role="radio" aria-checked={tab === "exercises"} className={`key ${tab === "exercises" ? "is-on" : ""}`} onClick={() => setTab("exercises")}>Exercises</button>
        </div>
        <span className="fill" />
        <button className="key sq flat" aria-label="Close library" onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="search ls-search"><Icon name="search" />
        <input className="input" value={q} placeholder={tab === "saved" ? "Search saved workouts" : "Search exercises"} aria-label="Search library" onChange={(e) => setQ(e.target.value)} />
      </div>
      <ul className="ls-list">
        {rows.map((r) => <Row key={`${r.it.kind}:${r.it.id}`} it={r.it} sub={r.sub} />)}
        {!rows.length && <li className="ls-none">{term ? "No matches" : tab === "saved" ? "No saved workouts" : "No exercises"}</li>}
      </ul>
    </aside>
  );
}
