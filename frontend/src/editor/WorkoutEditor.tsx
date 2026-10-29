import { useEffect, useMemo, useRef, useState } from "react";
import type { Workout, WorkoutType } from "../api/types";
import { useDock, type WorkoutSeed } from "../app/dock";
import { useMobile } from "../app/useMedia";
import { useChange, useSaved, useToday, useWorkout, type Op } from "../plan/api";
import { CopyTo, useWorkoutActions } from "../plan/actions";
import { weekday } from "../plan/dates";
import { fmtDistance, fmtDuration } from "../plan/quick";
import { ActLine } from "../plan/WorkoutRow";
import { Icon } from "../ui/Icon";
import { MenuItem, MenuList, MenuSep, Popover } from "../ui/Popover";
import { mondayOf, todayIso } from "../ui/dates";
import { TYPE_LIST } from "../ui/sport";
import { useToast } from "../ui/toast";
import { ExercisePicker, PickerSheet } from "./ExercisePicker";
import { Calendar, DateField, TimeField } from "../ui/DateField";
import { MediaList, RepeatField, TagInput } from "./fields";
import { ItemList, focusItemField } from "./ItemList";
import { content, newKey, plannedOf, ruleOf, toEdItem, type Draft, type EdItem } from "./model";

const newId = () => `w-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

function fromWorkout(w: Workout): Draft {
  const s = w.series;
  return {
    title: w.title, type: w.type, date: w.date, week_monday: w.week_monday, time: w.time ?? null, tags: w.tags, notes: w.notes,
    items: w.items.map(toEdItem), media: w.media,
    repeat: s ? { on: true, interval: s.rule.interval, weekdays: s.rule.weekdays, until: s.end_date } : { on: false, interval: 1, weekdays: w.date ? [weekday(w.date)] : [], until: null },
  };
}

function fromSeed(seed: WorkoutSeed): Draft {
  return {
    title: "", type: seed.type ?? "run", date: seed.date, week_monday: seed.week_monday, time: null, tags: [], notes: "", items: [], media: [],
    repeat: { on: !!seed.repeat, interval: 1, weekdays: seed.date ? [weekday(seed.date)] : [0], until: null },
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const contentOf = (d: Draft) => JSON.stringify({ ...content(d), time: d.time ?? null });

export function WorkoutEditor({ id, seed }: { id?: string; seed?: WorkoutSeed }) {
  const q = useWorkout(id);
  const saved = useSaved();
  // A newer version while the editor is open (a 409 on save, or an edit elsewhere) reloads the
  // form from the server and says so inline.
  const firstVersion = useRef<number | null>(null);
  if (q.data && firstVersion.current === null) firstVersion.current = q.data.version;
  const changed = !!q.data && firstVersion.current !== null && q.data.version !== firstVersion.current;
  if (id && !q.data) {
    return (
      <div className="panel editor">
        <div className="panel-hd"><h2 className="ed-title">Edit workout</h2></div>
        {q.isError ? <p className="pad muted">This workout no longer exists.</p> : <div className="skel" style={{ margin: 14, height: 200 }} />}
      </div>
    );
  }
  if (!id && seed?.from_saved && !saved.data) return <div className="panel editor"><div className="skel" style={{ margin: 14, height: 200 }} /></div>;
  let init: Draft;
  if (q.data) init = fromWorkout(q.data);
  else {
    init = fromSeed(seed ?? { date: null, week_monday: mondayOf(todayIso()) });
    const s = seed?.from_saved ? saved.data?.find((x) => x.id === seed.from_saved) : undefined;
    if (s) Object.assign(init, { time: s.time ?? null, title: s.title, type: s.type, tags: s.tags, notes: s.notes, items: s.items.map((it) => ({ ...toEdItem(it), id: undefined })), media: s.media });
  }
  return <Editor key={q.data?.version ?? "new"} w={q.data} init={init} reloaded={changed} />;
}

type Footer = "normal" | "discard" | "scope" | "delete";

function Editor({ w, init, reloaded }: { w?: Workout; init: Draft; reloaded?: boolean }) {
  const dock = useDock();
  const mobile = useMobile();
  const change = useChange();
  const act = useWorkoutActions();
  const toast = useToast();
  const today = useToday().data?.today;
  const [d, setD] = useState<Draft>(init);
  const [base] = useState<Draft>(init);
  const [footer, setFooter] = useState<Footer>("normal");
  const [picker, setPicker] = useState(false);
  const [menu, setMenu] = useState<"none" | "more" | "copy" | "move">("none");
  const [note, setNote] = useState(!!reloaded);
  const [err, setErr] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const isNew = !w;
  const isOcc = !!w?.series_id;
  const dirty = !same(d, base);
  const set = (p: Partial<Draft>) => { setD((x) => ({ ...x, ...p })); setFooter((f) => (f === "discard" ? "normal" : f)); };

  useEffect(() => {
    if (isNew) titleRef.current?.focus();
    else headRef.current?.focus();
  }, [isNew]);

  const close = () => dock.close();
  const tryClose = () => (dirty ? setFooter("discard") : close());
  // Esc closes the editor (asking first when dirty); ⌘↵ saves.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented || picker || menu !== "none") return;
    if (e.key === "Escape") { e.preventDefault(); if (footer !== "normal") setFooter("normal"); else tryClose(); }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const planned = useMemo(() => plannedOf(d.items), [d.items]);
  const typeInfo = TYPE_LIST.find((t) => t.value === d.type)!;

  const addItems = (list: { id: string; name: string }[]) => {
    const add: EdItem[] = list.map((e) => ({ key: newKey(), exercise_id: e.id, name: e.name, quick: "", f: {} }));
    set({ items: [...d.items, ...add] });
    setPicker(false);
    focusItemField(d.items.length);
  };
  const removeItem = (it: EdItem, i: number) => {
    set({ items: d.items.filter((x) => x.key !== it.key) });
    const restore = () => setD((x) => (x.items.some((y) => y.key === it.key) ? x : { ...x, items: [...x.items.slice(0, i), it, ...x.items.slice(i)] }));
    toast({ text: `Removed ${it.name}`, action: { label: "Undo", run: restore } });
  };

  const validate = () => {
    if (!d.title.trim()) { setErr("Give the workout a title."); titleRef.current?.focus(); return false; }
    if (d.repeat.on && !d.date) { setErr("A repeating workout needs a date to start from."); return false; }
    setErr(null);
    return true;
  };

  /** Build and send the ops. `scope` answers the series question for content edits. */
  const save = (scope?: "one" | "following") => {
    if (!validate()) return;
    const ops: Op[] = [];
    const place = d.date ? { date: d.date } : { week_monday: d.week_monday };
    const rule = ruleOf(d.repeat);
    if (isNew) {
      const wid = newId();
      ops.push({ op: "add_workout", id: wid, ...place, ...content(d, base) });
      if (d.repeat.on) ops.push({ op: "create_series", rule, start_date: d.date, end_date: d.repeat.until, from_workout: wid });
      change.mutate({ ops, toast: d.repeat.on ? `Added ${d.title.trim()} · repeats` : `Added ${d.title.trim()}` }, { onSuccess: close });
      return;
    }
    const contentChanged = contentOf(d) !== contentOf(base);
    const moved = d.date !== base.date || (!d.date && d.week_monday !== base.week_monday);
    const ruleChanged = d.repeat.on !== base.repeat.on || !same(ruleOf(d.repeat), ruleOf(base.repeat));
    const untilChanged = d.repeat.until !== base.repeat.until;
    if (isOcc && contentChanged && !ruleChanged && !scope) { setFooter("scope"); return; }
    if (isOcc && w!.series_id) {
      if (!d.repeat.on) {
        if (contentChanged) ops.push({ op: "update_workout", id: w!.id, fields: content(d, base), scope: "one" });
        ops.push({ op: "end_series", id: w!.series_id, end_date: w!.date ?? today });
      } else if (ruleChanged) {
        ops.push({ op: "update_series", id: w!.series_id, fields: { ...(contentChanged ? content(d, base) : {}), rule, end_date: d.repeat.until }, from_date: w!.date && today && w!.date > today ? w!.date : today });
      } else {
        if (contentChanged) ops.push({ op: "update_workout", id: w!.id, fields: content(d, base), scope: scope ?? "one" });
        if (untilChanged) ops.push({ op: "update_series", id: w!.series_id, fields: { end_date: d.repeat.until } });
      }
      if (moved && !ruleChanged) ops.unshift({ op: "move_workout", id: w!.id, ...place });
    } else {
      if (contentChanged) ops.push({ op: "update_workout", id: w!.id, fields: content(d, base), scope: "one" });
      if (moved) ops.push({ op: "move_workout", id: w!.id, ...place });
      if (d.repeat.on) ops.push({ op: "create_series", rule, start_date: d.date, end_date: d.repeat.until, from_workout: w!.id });
    }
    if (!ops.length) { close(); return; }
    const title = d.title.trim();
    change.mutate({
      ops, expected: { [`workout:${w!.id}`]: w!.version }, quiet: ["stale"],
      toast: (r) => {
        const n = r.diffs.filter((x) => x.key.startsWith("workout:") && x.kind !== "deleted").length;
        return n > 1 ? `Updated ${n} workouts · ${title}` : `Saved ${title}`;
      },
    }, {
      onSuccess: close,
      onError: () => setFooter("normal"),
    });
  };

  const del = (scope: "one" | "following" | "all") => act.remove(w!, scope, close);
  const stacked = dock.consoleOpen && !mobile;

  return (
    <div className="panel editor" role="region" aria-label={isNew ? "New workout" : "Edit workout"}>
      <div className="panel-hd">
        {mobile && <button className="key sq flat" aria-label="Close" onClick={tryClose}><Icon name="close" /></button>}
        {stacked && <button className="key flat plain back-chat" onClick={tryClose}><Icon name="back" />Chat</button>}
        <span className="sport">{typeInfo.mark}</span>
        <h2 ref={headRef} tabIndex={-1} className="ed-title">{isNew ? "New workout" : "Edit workout"}</h2>
        <span className="fill" />
        {!isNew && (
          <button ref={moreRef} className="key sq flat" aria-label="Workout actions" aria-haspopup="menu" aria-expanded={menu === "more"}
            onClick={() => setMenu(menu === "more" ? "none" : "more")}><Icon name="more" /></button>
        )}
        {!mobile && <button className="key sq flat" aria-label="Close editor" onClick={tryClose}><Icon name="close" /></button>}
      </div>

      {note && (
        <div className="ed-conflict" role="status">
          <Icon name="alert" /><span>Changed elsewhere. Reloaded; your edit wasn’t saved.</span>
          <button className="key sq flat" aria-label="Dismiss" onClick={() => setNote(false)}><Icon name="close" /></button>
        </div>
      )}
      <div className="panel-bd ed-bd">
        <input ref={titleRef} className={`input ed-name ${err && !d.title.trim() ? "invalid" : ""}`} value={d.title} placeholder="Title"
          aria-label="Title" aria-invalid={!!err && !d.title.trim()} onChange={(e) => set({ title: e.target.value })} />
        {err && <p className="field-err" role="alert">{err}</p>}

        <div className="ed-row2 type-date">
          <label className="field-l"><span className="silk">Type</span>
            <select className="select" value={d.type} onChange={(e) => set({ type: e.target.value as WorkoutType })}>
              {TYPE_LIST.map((t) => <option key={t.value} value={t.value}>{t.mark} · {t.label}</option>)}
            </select>
          </label>
          <div className="field-l">
            <span className="silk" id="ed-date-l">Date</span>
            <div className="date-row">
              <DateField className="ed-date" value={d.date} label="Date" disabled={!d.date} today={today} placeholder="No day"
                onChange={(v) => {
                  if (!v) return;
                  const wd = weekday(v);
                  set({ date: v, week_monday: mondayOf(v), repeat: d.repeat.on && !isOcc ? d.repeat : { ...d.repeat, weekdays: d.repeat.on ? d.repeat.weekdays : [wd] } });
                }} />
              <TimeField value={d.time} disabled={!d.date} onChange={(t) => set({ time: t })} />
              <button className={`key plain ${d.date ? "" : "is-latched"}`} aria-pressed={!d.date} disabled={d.repeat.on}
                title={d.repeat.on ? "A repeating workout needs a day" : "This week, no day yet"}
                onClick={() => set(d.date ? { date: null, time: null } : { date: today && mondayOf(today) === d.week_monday ? today : d.week_monday })}>
                No day
              </button>
            </div>
            {!d.date && <span className="hint-l">Week of {d.week_monday.slice(8)} {new Date(`${d.week_monday}T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })}</span>}
          </div>
        </div>

        <RepeatField defaultOpen={isNew && d.repeat.on} time={d.time} value={d.repeat} onChange={(r) => set({ repeat: r })} defaultDay={d.date ? weekday(d.date) : 0}
          disabled={!d.date ? "Pick a day to repeat" : undefined} />

        <section className="ed-sec" aria-labelledby="ed-items">
          <div className="ed-sec-hd"><span id="ed-items" className="silk">Items</span>
            <span className="fill" />
            {(planned.km > 0 || planned.min >= 5) && (
              <span className="planned mono">Planned {[planned.km ? fmtDistance(planned.km) : "", planned.min ? fmtDuration(planned.min) : ""].filter(Boolean).join(" · ")}</span>
            )}
          </div>
          <ItemList items={d.items} type={d.type} onChange={(items) => set({ items })} onRemove={removeItem} />
          <button ref={addRef} className="key plain add-ex" onClick={() => setPicker(true)} aria-haspopup="dialog" aria-expanded={picker}>
            <Icon name="plus" />Add exercise
          </button>
          {picker && !mobile && (
            <Popover anchor={addRef} open onClose={() => setPicker(false)} label="Add exercises" align="start" width={340}>
              <ExercisePicker type={d.type} onAdd={addItems} onClose={() => setPicker(false)} />
            </Popover>
          )}
        </section>

        <label className="field-l"><span className="silk">Notes</span>
          <textarea className="textarea autosize" rows={3} value={d.notes}
            onChange={(e) => set({ notes: e.target.value })} />
        </label>

        <div className="field-l"><span className="silk">Tags</span><TagInput tags={d.tags} onChange={(tags) => set({ tags })} /></div>
        <div className="field-l"><span className="silk">Media</span><MediaList media={d.media} onChange={(media) => set({ media })} /></div>

        {w && w.activities.length > 0 && (
          <div className="field-l"><span className="silk">Logged</span>
            <div className="acts-ro">{w.activities.map((a) => <ActLine key={a.id} a={a} onOpen={() => dock.open({ kind: "log", workoutId: w.id, activityId: a.id })} />)}</div>
          </div>
        )}
        {isOcc && <p className="hint-l">Repeating workout. Moving it changes this one only.</p>}
      </div>

      {(
        <div className={`panel-ft ${footer}`}>
          {footer === "normal" && <>
            <button className="key flat" onClick={tryClose}>Cancel</button>
            <span className="fill" />
            <button className="key ink" title="Save (Ctrl/⌘ Enter)" disabled={change.isPending} onClick={() => save()}>{isNew ? "Add" : "Save"}</button>
          </>}
          {footer === "discard" && <>
            <span className="ft-q">Discard changes?</span>
            <span className="fill" />
            <button className="key flat" onClick={() => setFooter("normal")}>Keep editing</button>
            <button className="key ink" onClick={close}>Discard</button>
          </>}
          {footer === "scope" && <>
            <span className="ft-q">Apply to</span>
            <button className="key" onClick={() => save("one")}>This workout</button>
            <button className="key" onClick={() => save("following")}>This and following</button>
            <span className="fill" />
            <button className="key flat" onClick={() => setFooter("normal")}>Cancel</button>
          </>}
          {footer === "delete" && <>
            <div className="ft-stack">
              <div className="row wrap">
                <button className="key" onClick={() => del("one")}>This one</button>
                <button className="key" onClick={() => del("following")}>This and following</button>
                <button className="key danger" onClick={() => del("all")}>Whole series</button>
                <span className="fill" />
                <button className="key flat" onClick={() => setFooter("normal")}>Cancel</button>
              </div>
              <span className="hint-l">Logged workouts are kept.</span>
            </div>
          </>}
        </div>
      )}

      {picker && mobile && (
        <PickerSheet onClose={() => setPicker(false)}>
          <ExercisePicker type={d.type} onAdd={addItems} onClose={() => setPicker(false)} />
        </PickerSheet>
      )}

      {w && <>
        <Popover anchor={moreRef} open={menu === "more"} onClose={() => setMenu("none")} label="Workout actions" width={220}>
          <MenuList label="Workout actions">
            <MenuItem disabled={dirty} hint={dirty ? "Save first" : undefined} onSelect={() => { setMenu("none"); dock.open({ kind: "log", workoutId: w.id }); }}>Log…</MenuItem>
            <MenuItem onSelect={() => setMenu("move")}>Move to…</MenuItem>
            <MenuItem onSelect={() => { setMenu("none"); act.duplicate(w); close(); }}>Duplicate</MenuItem>
            <MenuItem onSelect={() => setMenu("copy")}>Copy to…</MenuItem>
            <MenuItem onSelect={() => { setMenu("none"); act.saveTemplate(w); }}>Add to saved workouts</MenuItem>
            <MenuSep />
            <MenuItem disabled={w.state === "done"} onSelect={() => { setMenu("none"); if (isOcc) setFooter("delete"); else del("one"); }}>
              <span className="danger-t">Delete{isOcc ? "…" : ""}</span>
            </MenuItem>
          </MenuList>
        </Popover>
        <Popover anchor={moreRef} open={menu === "move"} onClose={() => setMenu("none")} label={`Move ${w.title}`} width={262}>
          <p className="pop-t">Move <b>{w.title}</b> to</p>
          <Calendar value={w.date} today={today} label="Move to" onPick={(date) => { setMenu("none"); if (date !== w.date) act.move(w, date); close(); }} />
          <div className="pop-ft">
            <button className="key plain" disabled={w.date == null || !!w.series_id} title={w.series_id ? "A repeating workout keeps a day" : undefined}
              onClick={() => { setMenu("none"); act.move(w, null); close(); }}>No day yet</button>
          </div>
        </Popover>
        <Popover anchor={moreRef} open={menu === "copy"} onClose={() => setMenu("none")} label="Copy to" width={264}>
          <CopyTo initial={w.date ?? today} onCopy={(dates) => { setMenu("none"); act.copyTo(w, dates); }} />
        </Popover>
      </>}
    </div>
  );
}
