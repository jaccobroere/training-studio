import {
  DndContext, DragOverlay, MouseSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragOverEvent,
} from "@dnd-kit/core";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Measure, WorkoutType } from "../api/types";
import { useExercises } from "../plan/api";
import { Icon } from "../ui/Icon";
import { MenuItem, MenuList, Popover } from "../ui/Popover";
import { describeFields, formatEntry, parseQuick, withoutNote, type ItemFields } from "../plan/quick";
import { FIELD_INFO, coreFields, shownFields, stepSets, type EdItem, type FieldKey } from "./model";

const NUMERIC = new Set(["sets", "duration_min", "distance_km"]);

/** A number field that keeps what is typed ("1.", "1,5") until it parses, then reports the number. */
function NumInput({ value, onValue, ...rest }: { value: number | null | undefined; onValue: (v: string) => void } & Omit<React.ComponentProps<"input">, "value" | "onChange">) {
  const [text, setText] = useState(value == null ? "" : String(value));
  useEffect(() => {
    const cur = Number(text.replace(",", "."));
    if (value == null ? text.trim() !== "" && Number.isFinite(cur) : cur !== value) setText(value == null ? "" : String(value));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return <input {...rest} value={text} onChange={(e) => { setText(e.target.value); onValue(e.target.value); }} />;
}

/** Keep the keyboard up when a key next to a field is tapped (otherwise iOS drops it and the sheet jumps). */
const keepFocus = { onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault() };

/** Focus the first field of the item at `index` (after a picker adds items). */
export function focusItemField(index: number) {
  requestAnimationFrame(() => document.querySelectorAll<HTMLElement>(".items-ed .irow")[index]?.querySelector<HTMLInputElement>(".ifield input")?.focus());
}

/** The typed prescription for one item ("3×5–8/leg 60kg"), read into fields as you type. Words it
 * does not recognise are added to the note when you leave the field, and the read-back under it
 * says what it understood. Blur or Enter hands control back to the fields via `onDone`. */
function QuickEntry({ it, onChange, onDone }: { it: EdItem; onChange: (it: EdItem) => void; onDone: () => void }) {
  const [text, setText] = useState(it.quick);
  const timer = useRef<number | undefined>(undefined);
  /** The note as it was when typing began; leftover words are appended to it, never replacing it. */
  const baseNote = useRef(it.f.note ?? "");
  const fieldsOf = (v: string): ItemFields => {
    const { note: extra, ...f } = parseQuick(v);
    const note = [baseNote.current, extra ?? ""].filter(Boolean).join(" ");
    return note ? { ...f, note } : f;
  };
  const type = (v: string) => {
    setText(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onChange({ ...it, quick: v, f: fieldsOf(v) }), 150);
  };
  // Leaving typing mode (blur, Enter or the pencil) unmounts this: settle the text into fields then,
  // so the entry shows in its canonical form and the leftover words land in the note.
  const settle = useRef(() => {});
  settle.current = () => {
    window.clearTimeout(timer.current);
    if (text === it.quick) return;
    const f = fieldsOf(text);
    onChange({ ...it, f, quick: formatEntry(f) });
  };
  useEffect(() => () => settle.current(), []);
  const leftover = parseQuick(text).note;
  const readback = [describeFields(withoutNote(it.f)), leftover && `Note: ${leftover}`].filter(Boolean).join(" · ");
  return (
    <div className="iquick">
      <input className="input mono" spellCheck={false} autoComplete="off" autoCapitalize="off" enterKeyHint="done" value={text}
        ref={(el) => el?.focus()} aria-label={`${it.name}: sets, reps, load`} placeholder="Type: 3x8 60kg, 10k easy, 5x1km Z4"
        onChange={(e) => type(e.target.value)} onBlur={onDone}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onDone(); } }} />
      <span className="parsed mono" aria-live="polite">{readback || "Sets × reps, load, km, min, intensity. Anything else becomes the note."}</span>
    </div>
  );
}

/** One exercise: number · name, then its prescription as labelled fields (sets, reps, load for a
 * lift; km, min, intensity for an endurance item), "+ Time" style keys for the rest, and the note
 * as prose underneath. "Type it" swaps the fields for one free-text entry ("3×5–8/leg 60kg");
 * words it does not recognise become the note when you leave it. */
function Row({ it, i, n, type, measure, insert, onChange, onRemove, onMove }: {
  it: EdItem; i: number; n: number; type: WorkoutType; measure: Measure | undefined; insert: "before" | "after" | null;
  onChange: (it: EdItem) => void; onRemove: () => void; onMove: (to: number) => void;
}) {
  const drag = useDraggable({ id: `it:${it.key}`, data: { index: i } });
  const drop = useDroppable({ id: `itr:${it.key}`, data: { index: i } });
  const [typing, setTyping] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [added, setAdded] = useState<FieldKey[]>([]);
  const [menu, setMenu] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  /** The field just added from the menu; it takes focus once it exists. */
  const pending = useRef<string | null>(null);
  const { onMouseDown, onTouchStart } = (drag.listeners ?? {}) as Record<string, (e: unknown) => void>;

  const addField = (k: FieldKey | "note") => {
    setMenu(false);
    pending.current = k;
    if (k === "note") setNoteOpen(true);
    else setAdded([...added, k]);
  };
  const focusNew = (k: string) => (el: HTMLInputElement | null) => {
    if (el && pending.current === k) { pending.current = null; el.focus(); }
  };
  const setField = (k: keyof ItemFields, raw: string | number | null) => {
    const f: ItemFields = { ...it.f };
    const v = raw == null ? "" : String(raw).trim();
    if (!v) delete f[k];
    else if (NUMERIC.has(k)) {
      const num = Number(v.replace(",", "."));
      if (Number.isFinite(num)) (f as Record<string, unknown>)[k] = k === "sets" ? Math.round(num) : num;
    } else (f as Record<string, unknown>)[k] = String(raw);
    onChange({ ...it, f, quick: formatEntry(f) });
  };
  const moveKeys = (e: KeyboardEvent) => {
    if (e.altKey && e.key === "ArrowUp" && i > 0) { e.preventDefault(); onMove(i - 1); }
    if (e.altKey && e.key === "ArrowDown" && i < n - 1) { e.preventDefault(); onMove(i + 1); }
  };
  /** Enter walks to the next field (and on to the next exercise), so a whole list is typed in one go. */
  const nextField = (e: KeyboardEvent<HTMLInputElement>) => {
    moveKeys(e);
    if (e.key !== "Enter") return;
    e.preventDefault();
    const all = [...(e.currentTarget.closest(".items-ed") ?? document).querySelectorAll<HTMLInputElement>(".ifield input, .iquick input")];
    const at = all.indexOf(e.currentTarget);
    if (at >= 0 && at < all.length - 1) all[at + 1].focus();
    else e.currentTarget.blur();
  };

  const core = coreFields(measure, type);
  const shown = shownFields(core, it.f, added);
  const more = (Object.keys(FIELD_INFO) as FieldKey[]).filter((k) => !shown.includes(k));
  const showNote = !typing && (!!it.f.note || noteOpen);
  const sets = it.f.sets ?? null;
  const label = (k: FieldKey) => `${it.name}: ${FIELD_INFO[k].label.toLowerCase()}`;
  return (
    <li ref={drop.setNodeRef} className={`irow ${drag.isDragging ? "dragging" : ""} ${insert ? `ins-${insert}` : ""}`}>
      <div ref={drag.setNodeRef} className="irow-main">
        <button className="grip" aria-label={`Reorder ${it.name}. Alt and arrow keys move it`} onMouseDown={onMouseDown} onTouchStart={onTouchStart}
          onKeyDown={moveKeys}><Icon name="grip" /></button>
        <span className="inum mono" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
        <span className="iname">{it.name}</span>
        <button ref={addRef} className="key sq flat ik-a" aria-label={`Add a field to ${it.name}`} aria-haspopup="menu" aria-expanded={menu}
          title={typing ? "Back to fields to add more" : "Add time, distance, intensity, note…"} disabled={typing || (more.length === 0 && showNote)} {...keepFocus} onClick={() => setMenu(!menu)}>
          <Icon name="plus" />
        </button>
        <button className={`key sq flat ik-e ${typing ? "is-latched" : ""}`} aria-pressed={typing} {...keepFocus}
          aria-label={`Type the prescription for ${it.name} as text`} title={typing ? "Back to fields" : "Type it: 3×8 60kg"} onClick={() => setTyping(!typing)}>
          <Icon name="edit" />
        </button>
        <button className="key sq flat ik-x" aria-label={`Remove ${it.name}`} onClick={onRemove}><Icon name="close" /></button>
      </div>
      <div className="ibody">
        {typing ? (
          <QuickEntry it={it} onChange={onChange} onDone={() => setTyping(false)} />
        ) : (
          <div className={`ifs ${shown.length > 3 ? "many" : shown.includes("sets") ? "has-sets" : ""}`}>
            {shown.map((k) => k === "sets" ? (
              <div key={k} className="ifield sets">
                <span className="silk">Sets</span>
                <div className="stepper">
                  <button className="key sq" tabIndex={-1} {...keepFocus} aria-label={`Fewer sets for ${it.name}`} disabled={sets == null} onClick={() => setField("sets", stepSets(sets, -1))}>−</button>
                  <input className="input mono" inputMode="numeric" enterKeyHint="next" placeholder="–" value={sets ?? ""} aria-label={label(k)}
                    onFocus={(e) => e.currentTarget.select()} onChange={(e) => setField("sets", e.target.value)} onKeyDown={nextField} />
                  <button className="key sq" tabIndex={-1} {...keepFocus} aria-label={`More sets for ${it.name}`} onClick={() => setField("sets", stepSets(sets, 1))}>+</button>
                </div>
              </div>
            ) : (
              <label key={k} className="ifield"><span className="silk">{FIELD_INFO[k].label}</span>
                {NUMERIC.has(k) ? (
                  <NumInput ref={focusNew(k)} value={it.f[k] as number | null | undefined} onValue={(v) => setField(k, v)} className="input mono" inputMode={FIELD_INFO[k].mode} enterKeyHint="next"
                    autoComplete="off" placeholder={FIELD_INFO[k].ph} aria-label={label(k)} onKeyDown={nextField} />
                ) : <input ref={focusNew(k)} className="input mono" inputMode={FIELD_INFO[k].mode} enterKeyHint="next" autoComplete="off" autoCapitalize="off" spellCheck={false}
                  placeholder={FIELD_INFO[k].ph} aria-label={label(k)}
                  value={it.f[k] == null ? "" : String(it.f[k])} onChange={(e) => setField(k, e.target.value)} onKeyDown={nextField} />}
              </label>
            ))}
          </div>
        )}
        {showNote && (
          <textarea className="inote" rows={1} value={it.f.note ?? ""} placeholder="Note: cues, rest, how it should feel"
            ref={(el) => { if (el && pending.current === "note") { pending.current = null; el.focus(); } }}
            aria-label={`Note for ${it.name}`} onChange={(e) => setField("note", e.target.value)} />
        )}
      </div>
      <Popover anchor={addRef} open={menu} onClose={() => setMenu(false)} label={`Add to ${it.name}`} width={200}>
        <MenuList label={`Add to ${it.name}`}>
          {more.map((k) => <MenuItem key={k} onSelect={() => addField(k)}>{ADD_LABEL[k]}</MenuItem>)}
          {!showNote && <MenuItem onSelect={() => addField("note")}>Note</MenuItem>}
        </MenuList>
      </Popover>
    </li>
  );
}

const ADD_LABEL: Record<FieldKey, string> = { sets: "Sets", reps: "Reps", load: "Load", duration_min: "Time (min)", distance_km: "Distance (km)", intensity: "Intensity" };

export function ItemList({ items, type, onChange, onRemove }: {
  items: EdItem[]; type: WorkoutType; onChange: (items: EdItem[]) => void; onRemove: (it: EdItem, index: number) => void;
}) {
  const measures = new Map((useExercises().data ?? []).map((e) => [e.id, e.default_measure]));
  const [over, setOver] = useState<number | null>(null);
  const [dragging, setDragging] = useState<EdItem | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );
  const move = (from: number, to: number) => {
    const next = [...items];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    onChange(next);
    requestAnimationFrame(() => {
      document.querySelectorAll<HTMLElement>(".items-ed .irow .grip")[to]?.focus();
    });
  };
  const slot = (e: DragOverEvent | DragEndEvent): number | null => {
    if (!e.over) return null;
    const idx = (e.over.data.current as { index: number }).index;
    const r = e.active.rect.current.translated;
    const below = r ? r.top + r.height / 2 > e.over.rect.top + e.over.rect.height / 2 : false;
    return idx + (below ? 1 : 0);
  };
  const onEnd = (e: DragEndEvent) => {
    const to = slot(e);
    const from = (e.active.data.current as { index: number }).index;
    setOver(null);
    setDragging(null);
    if (to == null || to === from || to === from + 1) return;
    move(from, to > from ? to - 1 : to);
  };
  if (!items.length) return null;
  return (
    <DndContext sensors={sensors} onDragStart={(e) => setDragging(items[(e.active.data.current as { index: number }).index])}
      onDragOver={(e) => setOver(slot(e))} onDragEnd={onEnd} onDragCancel={() => { setOver(null); setDragging(null); }}>
      <ul className="items-ed" aria-label="Items">
        {items.map((it, i) => (
          <Row key={it.key} it={it} i={i} n={items.length} type={type} measure={measures.get(it.exercise_id)}
            insert={over === i ? "before" : over === items.length && i === items.length - 1 ? "after" : null}
            onChange={(x) => onChange(items.map((y) => (y.key === x.key ? x : y)))}
            onRemove={() => onRemove(it, i)} onMove={(to) => move(i, to)} />
        ))}
      </ul>
      <DragOverlay dropAnimation={null}>
        {dragging && <div className="drag-ghost"><span className="ttl">{dragging.name}</span><span className="mono muted">{dragging.quick}</span></div>}
      </DragOverlay>
    </DndContext>
  );
}
