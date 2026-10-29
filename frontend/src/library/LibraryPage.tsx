import { useQuery } from "@tanstack/react-query";
import { Calendar, TimeField } from "../ui/DateField";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { api } from "../api/client";
import type { Exercise, Measure, SavedWorkout, WorkoutType } from "../api/types";
import { ChatKey } from "../app/ChatKey";
import { useDock } from "../app/dock";
import { useMobile } from "../app/useMedia";
import { usePublishScope } from "../chat/scope";
import { ExercisePicker, PickerSheet } from "../editor/ExercisePicker";
import { MediaList, TagInput } from "../editor/fields";
import { ItemList, focusItemField } from "../editor/ItemList";
import { ExerciseProgress } from "./Progress";
import { content, newKey, plannedOf, toEdItem, type EdItem } from "../editor/model";
import { useChange, useExercises, useSaved, useToday } from "../plan/api";
import { itemsLine } from "../plan/format";
import { fmtDistance, fmtDuration } from "../plan/quick";
import { autoFocus } from "../ui/autoFocus";
import { Icon } from "../ui/Icon";
import { MenuItem, MenuList, MenuSep, Popover } from "../ui/Popover";
import { dayLabel, mondayOf, todayIso } from "../ui/dates";
import { TYPE_LIST } from "../ui/sport";

type Tab = "exercises" | "saved";
const MEASURES: Measure[] = ["reps", "time", "distance"];

export function LibraryPage() {
  const { tab: rawTab, id } = useParams();
  const tab: Tab | null = rawTab === "exercises" || rawTab === "saved" ? rawTab : null;
  const nav = useNavigate();
  const mobile = useMobile();
  const [q, setQ] = useState("");
  const [type, setType] = useState<WorkoutType | "">("");
  const [archived, setArchived] = useState(false);
  usePublishScope({ page: "library", label: tab === "saved" ? "Saved workouts" : "Exercises" });
  const exs = useExercises();
  const svs = useSaved();
  if (!tab) return <Navigate to="/library/exercises" replace />;
  // Wide layouts always show a detail pane: open the first item when none is chosen.
  const first = tab === "saved" ? svs.data?.[0]?.id : exs.data?.find((e) => !e.archived)?.id;
  if (!mobile && !id && first) return <Navigate to={`/library/${tab}/${first}`} replace />;
  const base = `/library/${tab}`;
  const showList = !mobile || !id;
  const showDetail = !mobile || !!id;
  return (
    <div className="page library">
      <div className="strip" role="toolbar" aria-label="Library">
        {mobile && id ? (
          <button className="key flat plain" onClick={() => nav(base)}><Icon name="back" />{tab === "saved" ? "Saved workouts" : "Exercises"}</button>
        ) : (
          <nav className="seg" aria-label="Library sections">
            <Link to="/library/exercises" className={`key ${tab === "exercises" ? "is-on" : ""}`} aria-current={tab === "exercises" ? "page" : undefined}>Exercises</Link>
            <Link to="/library/saved" className={`key ${tab === "saved" ? "is-on" : ""}`} aria-current={tab === "saved" ? "page" : undefined}>Saved{mobile ? "" : " workouts"}</Link>
          </nav>
        )}
        {!mobile && (
          <div className="search lib-search"><Icon name="search" />
            <input className="input" value={q} placeholder={tab === "saved" ? "Search saved workouts" : "Search exercises"} aria-label="Search" onChange={(e) => setQ(e.target.value)} />
          </div>
        )}
        <span className="fill" />
        {!(mobile && id) && <button className={`key ink ${mobile ? "sq" : ""}`} onClick={() => nav(`${base}/new`)} aria-label={tab === "saved" ? "New saved workout" : "New exercise"}>
          <Icon name="plus" />{!mobile && "New"}
        </button>}
        <ChatKey />
      </div>
      <div className="lib-body">
        {showList && (
          <div className="lib-list">
            {mobile && (
              <div className="search lib-search m"><Icon name="search" />
                <input className="input" value={q} placeholder="Search" aria-label="Search" onChange={(e) => setQ(e.target.value)} />
              </div>
            )}
            {tab === "exercises"
              ? <ExerciseList q={q} type={type} setType={setType} archived={archived} setArchived={setArchived} sel={id} />
              : <SavedList q={q} sel={id} />}
          </div>
        )}
        {showDetail && (
          <div className="lib-detail">
            {id ? (tab === "exercises" ? <ExerciseDetail key={id} id={id} /> : <SavedDetail key={id} id={id} />)
              : <p className="lib-empty">{tab === "exercises" ? "Select an exercise" : "Select a saved workout"}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function ExerciseList({ q, type, setType, archived, setArchived, sel }: {
  q: string; type: WorkoutType | ""; setType: (t: WorkoutType | "") => void; archived: boolean; setArchived: (b: boolean) => void; sel?: string;
}) {
  const ex = useExercises();
  const term = q.trim().toLowerCase();
  const rows = (ex.data ?? []).filter((e) => (archived || !e.archived) && (!type || e.type === type) && (!term || e.name.toLowerCase().includes(term)));
  const nArchived = (ex.data ?? []).filter((e) => e.archived).length;
  return (
    <>
      <div className="list-hd">
        <label className="sr" htmlFor="lib-type">Filter by type</label>
        <select id="lib-type" className="select sm" value={type} onChange={(e) => setType(e.target.value as WorkoutType | "")}>
          <option value="">All types</option>
          {TYPE_LIST.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <span className="fill" />
        <span className="mono muted small">{rows.length}</span>
      </div>
      {ex.isPending ? <ListSkel /> : (
        <ul className="lrows">
          {rows.map((e) => (
            <li key={e.id}>
              <Link to={`/library/exercises/${e.id}`} className={`lrow ex ${sel === e.id ? "on" : ""} ${e.archived ? "arch" : ""}`} aria-current={sel === e.id ? "true" : undefined}>
                <span className="lname">{e.name}</span>
                <span className="lmeta mono">{e.mark}</span>
                <span className="lmeta mono">{e.default_measure}</span>
                <span className="lmeta mono used">{e.uses ? `used ${e.uses}×` : ""}</span>
              </Link>
            </li>
          ))}
          {!rows.length && <li className="muted small pad-s">No matches</li>}
        </ul>
      )}
      {nArchived > 0 && (
        <button className="key flat plain show-arch" aria-pressed={archived} onClick={() => setArchived(!archived)}>
          {archived ? "Hide archived" : `Show archived (${nArchived})`}
        </button>
      )}
    </>
  );
}

function SavedList({ q, sel }: { q: string; sel?: string }) {
  const s = useSaved();
  const term = q.trim().toLowerCase();
  const rows = (s.data ?? []).filter((x) => !term || x.title.toLowerCase().includes(term));
  if (s.isPending) return <ListSkel />;
  return (
    <ul className="lrows">
      {rows.map((x) => (
        <li key={x.id}>
          <Link to={`/library/saved/${x.id}`} className={`lrow sv ${sel === x.id ? "on" : ""}`} aria-current={sel === x.id ? "true" : undefined}>
            <span className="sport">{x.mark}</span>
            <span className="lbody"><span className="lname">{x.title}</span><span className="litems mono">{itemsLine(x.items, 3) || "No items"}</span></span>
          </Link>
        </li>
      ))}
      {!rows.length && <li className="lib-none">{term ? "No matches" : "No saved workouts"}</li>}
    </ul>
  );
}

const ListSkel = () => <div className="pad-s">{Array.from({ length: 6 }, (_, i) => <div key={i} className="skel" style={{ height: 30, margin: "7px 0" }} />)}</div>;

/** Sticky footer that appears once something changed. */
function SaveBar({ dirty, busy, onSave, onReset, isNew }: { dirty: boolean; busy: boolean; onSave: () => void; onReset: () => void; isNew?: boolean }) {
  if (!dirty && !isNew) return null;
  return (
    <div className="panel-ft lib-ft">
      <button className="key flat" onClick={onReset}>{isNew ? "Cancel" : "Revert"}</button>
      <span className="fill" />
      <button className="key ink" disabled={busy || (!dirty && !isNew)} onClick={onSave}>{isNew ? "Create" : "Save"}</button>
    </div>
  );
}

function ExerciseDetail({ id }: { id: string }) {
  const ex = useExercises();
  const isNew = id === "new";
  const e = ex.data?.find((x) => x.id === id);
  if (!isNew && !e) return ex.isPending ? <div className="skel" style={{ margin: 20, height: 200 }} /> : <p className="lib-empty">This exercise no longer exists.</p>;
  return <ExerciseForm e={e} all={ex.data ?? []} />;
}

function ExerciseForm({ e, all }: { e?: Exercise; all: Exercise[] }) {
  const nav = useNavigate();
  const change = useChange();
  const init = { name: e?.name ?? "", type: e?.type ?? ("strength" as WorkoutType), default_measure: e?.default_measure ?? ("reps" as Measure), notes: e?.notes ?? "", media: e?.media ?? [] };
  const [f, setF] = useState(init);
  const [menu, setMenu] = useState<"none" | "more" | "merge">("none");
  const [into, setInto] = useState<Exercise | null>(null);
  const [mq, setMq] = useState("");
  const moreRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const used = useQuery({ queryKey: ["exercise", e?.id, "used"], enabled: !!e, queryFn: () => api<{ id: string; title: string; mark: string; date: string | null; week_monday: string }[]>(`/api/exercises/${e!.id}/used-in`) });
  const dirty = JSON.stringify(f) !== JSON.stringify(init);
  useEffect(() => { if (!e) nameRef.current?.focus(); }, [e]);
  const save = () => {
    if (!f.name.trim()) { nameRef.current?.focus(); return; }
    if (!e) {
      change.mutateAsync({ ops: [{ op: "add_exercise", name: f.name.trim(), type: f.type, default_measure: f.default_measure, notes: f.notes, media: f.media }], toast: `Created ${f.name.trim()}` })
        .then((r) => { const nid = r.diffs.find((d) => d.key.startsWith("exercise:"))?.key.slice(9); nav(`/library/exercises/${nid ?? ""}`, { replace: true }); })
        .catch(() => undefined);
      return;
    }
    change.mutate({ ops: [{ op: "update_exercise", id: e.id, fields: { ...f, name: f.name.trim() } }], expected: { [`exercise:${e.id}`]: e.version }, toast: `Saved ${f.name.trim()}` });
  };
  const merge = () => {
    if (!e || !into) return;
    change.mutate({ ops: [{ op: "merge_exercise", id: e.id, into: into.id }], toast: `Merged ${e.name} into ${into.name}` }, { onSuccess: () => nav(`/library/exercises/${into.id}`, { replace: true }) });
  };
  const candidates = all.filter((x) => x.id !== e?.id && !x.archived && x.name.toLowerCase().includes(mq.trim().toLowerCase())).slice(0, 30);
  return (
    <div className="detail">
      <div className="detail-bd">
        <div className="detail-hd">
          <input ref={nameRef} className="input ed-name" value={f.name} placeholder="Exercise name" aria-label="Name" onChange={(x) => setF({ ...f, name: x.target.value })} />
          {e && (
            <button ref={moreRef} className="key sq flat" aria-label="Exercise actions" aria-haspopup="menu" aria-expanded={menu === "more"}
              onClick={() => setMenu(menu === "more" ? "none" : "more")}><Icon name="more" /></button>
          )}
        </div>
        {e?.archived && <p className="note-l">Archived. <button className="link" onClick={() => change.mutate({ ops: [{ op: "archive_exercise", id: e.id, archived: false }], toast: `Restored ${e.name}` })}>Restore</button></p>}
        {into && e && (
          <div className="confirm-l" role="alert">
            <span>Merge “{e.name}” into “{into.name}”? {e.uses ? `${e.uses} workout${e.uses > 1 ? "s" : ""} and saved workouts update.` : "Nothing uses it yet."}</span>
            <span className="row"><button className="key flat" onClick={() => setInto(null)}>Cancel</button><button className="key ink" onClick={merge}>Merge</button></span>
          </div>
        )}
        <div className="ed-row2">
          <label className="field-l"><span className="silk">Type</span>
            <select className="select" value={f.type} onChange={(x) => setF({ ...f, type: x.target.value as WorkoutType })}>
              {TYPE_LIST.map((t) => <option key={t.value} value={t.value}>{t.mark} · {t.label}</option>)}
            </select>
          </label>
          <div className="field-l"><span className="silk" id="measure-l">Measured in</span>
            <div className="seg" role="radiogroup" aria-labelledby="measure-l">
              {MEASURES.map((m) => <button key={m} role="radio" aria-checked={f.default_measure === m} className={`key ${f.default_measure === m ? "is-on" : ""}`} onClick={() => setF({ ...f, default_measure: m })}>{m}</button>)}
            </div>
          </div>
        </div>
        <label className="field-l"><span className="silk">Cues</span>
          <textarea className="textarea" rows={3} value={f.notes} onChange={(x) => setF({ ...f, notes: x.target.value })} />
        </label>
        <div className="field-l"><span className="silk">Media</span><MediaList media={f.media} onChange={(media) => setF({ ...f, media })} /></div>
        {e && <div className="field-l"><span className="silk">Progress</span><ExerciseProgress e={e} /></div>}
        {e && (
          <div className="field-l"><span className="silk">Used in {e.uses ? <span className="mono muted">{e.uses}</span> : null}</span>
            {used.data?.length ? (
              <ul className="used-list">{used.data.map((w) => (
                <li key={w.id}><Link to={`/plan/week/${w.date ? mondayOf(w.date) : w.week_monday}`}>
                  <span className="mono muted">{w.date ? dayLabel(w.date) : "No day"}</span><span className="mono muted">{w.mark}</span><span>{w.title}</span></Link></li>
              ))}</ul>
            ) : <p className="muted small">{used.isPending ? "…" : e.uses ? "Only in saved workouts" : "Not used yet"}</p>}
          </div>
        )}
      </div>
      <SaveBar dirty={dirty} busy={change.isPending} isNew={!e} onSave={save} onReset={() => (e ? setF(init) : nav("/library/exercises"))} />
      {e && <>
        <Popover anchor={moreRef} open={menu === "more"} onClose={() => setMenu("none")} label="Exercise actions" width={220}>
          <MenuList label="Exercise actions">
            <MenuItem onSelect={() => setMenu("merge")}>Merge into…</MenuItem>
            <MenuSep />
            {e.archived
              ? <MenuItem onSelect={() => { setMenu("none"); change.mutate({ ops: [{ op: "archive_exercise", id: e.id, archived: false }], toast: `Restored ${e.name}` }); }}>Restore</MenuItem>
              : <MenuItem onSelect={() => { setMenu("none"); change.mutate({ ops: [{ op: "archive_exercise", id: e.id }], toast: `Archived ${e.name}` }); }}>Archive</MenuItem>}
          </MenuList>
        </Popover>
        <Popover anchor={moreRef} open={menu === "merge"} onClose={() => setMenu("none")} label="Merge into" width={300}>
          <div className="merge-pick">
            <input className="input" ref={autoFocus} value={mq} placeholder="Merge into…" aria-label="Find the exercise to keep" onChange={(x) => setMq(x.target.value)} />
            <MenuList label="Exercises">
              {candidates.map((c) => <MenuItem key={c.id} hint={c.mark} onSelect={() => { setInto(c); setMenu("none"); }}>{c.name}</MenuItem>)}
            </MenuList>
          </div>
        </Popover>
      </>}
    </div>
  );
}

function SavedDetail({ id }: { id: string }) {
  const s = useSaved();
  const isNew = id === "new";
  const x = s.data?.find((y) => y.id === id);
  if (!isNew && !x) return s.isPending ? <div className="skel" style={{ margin: 20, height: 200 }} /> : <p className="lib-empty">This saved workout no longer exists.</p>;
  return <SavedForm s={x} />;
}

function SavedForm({ s }: { s?: SavedWorkout }) {
  const nav = useNavigate();
  const dock = useDock();
  const mobile = useMobile();
  const change = useChange();
  const today = useToday().data?.today;
  const init = useMemo(() => ({ time: s?.time ?? null, title: s?.title ?? "", type: s?.type ?? ("strength" as WorkoutType), tags: s?.tags ?? [], notes: s?.notes ?? "", media: s?.media ?? [], items: (s?.items ?? []).map(toEdItem) }), [s]);
  const [f, setF] = useState(init);
  const [menu, setMenu] = useState<"none" | "more" | "day">("none");
  const [picker, setPicker] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const strip = (v: typeof f) => JSON.stringify({ ...content({ ...v, date: null, week_monday: "", repeat: { on: false, interval: 1, weekdays: [], until: null } }), time: v.time });
  const dirty = strip(f) !== strip(init);
  const planned = plannedOf(f.items);
  useEffect(() => { if (!s) titleRef.current?.focus(); }, [s]);
  const body = () => content({ ...f, date: null, week_monday: "", repeat: { on: false, interval: 1, weekdays: [], until: null } }, init);
  const save = () => {
    if (!f.title.trim()) { titleRef.current?.focus(); return; }
    if (!s) {
      const nid = `t-${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
      change.mutate({ ops: [{ op: "add_saved_workout", id: nid, ...body() }], toast: `Saved ${f.title.trim()}` }, { onSuccess: () => nav(`/library/saved/${nid}`, { replace: true }) });
      return;
    }
    change.mutate({ ops: [{ op: "update_saved_workout", id: s.id, fields: body() }], expected: { [`saved:${s.id}`]: s.version }, toast: `Saved ${f.title.trim()}` });
  };
  const addToDay = (date: string) => {
    if (!s) return;
    setMenu("none");
    change.mutate({ ops: [{ op: "add_workout", from_saved: s.id, date }], toast: `Added ${s.title} · ${dayLabel(date)}` });
  };
  const addItems = (list: { id: string; name: string }[]) => {
    setF({ ...f, items: [...f.items, ...list.map((e): EdItem => ({ key: newKey(), exercise_id: e.id, name: e.name, quick: "", f: {} }))] });
    setPicker(false);
    focusItemField(f.items.length);
  };
  return (
    <div className="detail">
      <div className="detail-bd">
        <div className="detail-hd">
          <span className="sport">{TYPE_LIST.find((t) => t.value === f.type)?.mark}</span>
          <input ref={titleRef} className="input ed-name" value={f.title} placeholder="Title" aria-label="Title" onChange={(x) => setF({ ...f, title: x.target.value })} />
          {s && <button className="key plain" onClick={() => setMenu("day")} ref={addRef}><Icon name="plus" />Add to day…</button>}
          {s && <button ref={moreRef} className="key sq flat" aria-label="Saved workout actions" aria-haspopup="menu" aria-expanded={menu === "more"}
            onClick={() => setMenu(menu === "more" ? "none" : "more")}><Icon name="more" /></button>}
        </div>
        <div className="ed-row2">
          <label className="field-l"><span className="silk">Type</span>
            <select className="select" value={f.type} onChange={(x) => setF({ ...f, type: x.target.value as WorkoutType })}>
              {TYPE_LIST.map((t) => <option key={t.value} value={t.value}>{t.mark} · {t.label}</option>)}
            </select>
          </label>
          <div className="field-l"><span className="silk">Time</span>
            <TimeField value={f.time ?? null} onChange={(t) => setF({ ...f, time: t })} />
          </div>
        </div>
        <section className="ed-sec">
          <div className="ed-sec-hd"><span className="silk">Items</span><span className="fill" />
            {(planned.km > 0 || planned.min >= 5) && <span className="planned mono">Planned {[planned.km ? fmtDistance(planned.km) : "", planned.min ? fmtDuration(planned.min) : ""].filter(Boolean).join(" · ")}</span>}
          </div>
          <ItemList items={f.items} type={f.type} onChange={(items) => setF({ ...f, items })} onRemove={(it) => setF({ ...f, items: f.items.filter((y) => y.key !== it.key) })} />
          <PickerKey open={picker} setOpen={setPicker} mobile={mobile} type={f.type} onAdd={addItems} />
        </section>
        <label className="field-l"><span className="silk">Notes</span>
          <textarea className="textarea" rows={3} value={f.notes} onChange={(x) => setF({ ...f, notes: x.target.value })} />
        </label>
        <div className="field-l"><span className="silk">Tags</span><TagInput tags={f.tags} onChange={(tags) => setF({ ...f, tags })} /></div>
        <div className="field-l"><span className="silk">Media</span><MediaList media={f.media} onChange={(media) => setF({ ...f, media })} /></div>
      </div>
      <SaveBar dirty={dirty} busy={change.isPending} isNew={!s} onSave={save} onReset={() => (s ? setF(init) : nav("/library/saved"))} />
      {s && <>
        <Popover anchor={moreRef} open={menu === "more"} onClose={() => setMenu("none")} label="Saved workout actions" width={220}>
          <MenuList label="Saved workout actions">
            <MenuItem onSelect={() => setMenu("day")}>Add to day…</MenuItem>
            <MenuItem onSelect={() => { setMenu("none"); dock.open({ kind: "editor", seed: { date: today ?? null, week_monday: mondayOf(today ?? todayIso()), from_saved: s.id } }); }}>Add and edit…</MenuItem>
            <MenuItem onSelect={() => { setMenu("none"); change.mutate({ ops: [{ op: "add_saved_workout", title: `${s.title} (copy)`, type: s.type, tags: s.tags, notes: s.notes, media: s.media, items: s.items.map((it) => { const c = { ...it }; delete c.id; delete c.name; return c; }) }], toast: `Duplicated ${s.title}` }); }}>Duplicate</MenuItem>
            <MenuSep />
            <MenuItem onSelect={() => { setMenu("none"); change.mutate({ ops: [{ op: "delete_saved_workout", id: s.id }], toast: `Deleted ${s.title}` }, { onSuccess: () => nav("/library/saved", { replace: true }) }); }}><span className="danger-t">Delete</span></MenuItem>
          </MenuList>
        </Popover>
        <Popover anchor={addRef} open={menu === "day"} onClose={() => setMenu("none")} label="Add to day" align="start" width={250}>
          <p className="pop-t">Add <b>{s.title}</b> to</p>
          <Calendar value={null} today={today} label="Day" onPick={(d) => addToDay(d)} />
        </Popover>
      </>}
    </div>
  );
}

function PickerKey({ open, setOpen, mobile, type, onAdd }: { open: boolean; setOpen: (b: boolean) => void; mobile: boolean; type: WorkoutType; onAdd: (l: { id: string; name: string }[]) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={ref} className="key plain add-ex" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}><Icon name="plus" />Add exercise</button>
    {open && !mobile && <Popover anchor={ref} open onClose={() => setOpen(false)} label="Add exercises" align="start" width={340}>
      <ExercisePicker type={type} onAdd={onAdd} onClose={() => setOpen(false)} />
    </Popover>}
    {open && mobile && <PickerSheet onClose={() => setOpen(false)}>
      <ExercisePicker type={type} onAdd={onAdd} onClose={() => setOpen(false)} />
    </PickerSheet>}
  </>;
}
