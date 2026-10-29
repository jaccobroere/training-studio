import { useQuery } from "@tanstack/react-query";
import { DateField } from "../ui/DateField";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api/client";
import type { Activity, LoggedSet, Workout, WorkoutType } from "../api/types";
import { useDock } from "../app/dock";
import { useMobile } from "../app/useMedia";
import { useChange, useExercises, useToday, useWorkout, type Op } from "../plan/api";
import { clock, pace, sourceLabel } from "../plan/format";
import { prescription } from "../plan/quick";
import { Icon } from "../ui/Icon";
import { MenuItem, MenuList, Popover } from "../ui/Popover";
import { dayLabel, todayIso } from "../ui/dates";
import { sportLabel, TYPE_LIST } from "../ui/sport";
import { LinkMenu, useLink } from "../plan/LinkPicker";
import { ExtraItems } from "./Extras";
import { ItemSets } from "./SetLog";
import { measureOf, replaceItemSets } from "./sets";

const REASONS = ["Sick", "Injured", "No time"];
const sameList = (x: string[], y: string[]) => x.length === y.length && x.every((v) => y.includes(v));
const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s.replace(",", ".")));

export function LogSheet({ workoutId, activityId, date }: { workoutId?: string; activityId?: string; date?: string }) {
  const wq = useWorkout(workoutId);
  const aq = useQuery({
    queryKey: ["activity", activityId], enabled: !!activityId && !workoutId,
    // The detail endpoint names the day `local_date` and omits the type mark.
    queryFn: () => api<Activity & { local_date?: string }>(`/api/activities/${encodeURIComponent(activityId!)}`).then((a) => ({
      ...a, date: a.date ?? a.local_date ?? "", mark: a.mark ?? TYPE_LIST.find((t) => t.value === a.type)?.mark ?? "",
    })),
  });
  if (workoutId) {
    if (!wq.data) return <Shell title="Log">{wq.isError ? <p className="pad muted">This workout no longer exists.</p> : <div className="skel" style={{ margin: 14, height: 160 }} />}</Shell>;
    const a = wq.data.activities.find((x) => x.id === activityId) ?? wq.data.activities[0];
    // Re-key on what the form was built from, so a link made elsewhere reloads it — but not on
    // every set saved from this sheet (that bumps the activity's version and would drop what is
    // being typed); a manual log that appears with the first set keeps the same form.
    const basis = !a || a.source === "manual" ? "manual" : a.id;
    return <WorkoutLog key={`${wq.data.version}:${basis}`} w={wq.data} a={a} />;
  }
  if (activityId) {
    if (!aq.data) return <Shell title="Activity">{aq.isError ? <p className="pad muted">This activity no longer exists.</p> : <div className="skel" style={{ margin: 14, height: 160 }} />}</Shell>;
    // Not re-keyed on every saved set (the version bumps), which would drop rows being typed.
    return <ActivityLog key={`${aq.data.id}:${aq.data.workout_id ?? ""}`} a={aq.data} />;
  }
  return <ActivityLog date={date} />;
}

function Shell({ title, mark, sub, menu, children, footer }: {
  title: string; mark?: string; sub?: string; menu?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode;
}) {
  const dock = useDock();
  const mobile = useMobile();
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => { head.current?.focus(); }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector(".popover")) { e.preventDefault(); dock.close(); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [dock]);
  return (
    <div className="panel logp" role="region" aria-label={title}>
      {mobile && <span className="grab" aria-hidden="true" />}
      <div className="panel-hd">
        {dock.consoleOpen && !mobile && <button className="key flat plain back-chat" onClick={dock.close}><Icon name="back" />Chat</button>}
        {mark && <span className="sport">{mark}</span>}
        <div className="panel-t"><h2 ref={head} tabIndex={-1}>{title}</h2>{sub && <span className="panel-sub mono">{sub}</span>}</div>
        <span className="fill" />
        {menu}
        <button className="key sq flat" aria-label="Close" onClick={dock.close}><Icon name="close" /></button>
      </div>
      <div className="panel-bd log-bd">{children}</div>
      {footer && <div className="panel-ft">{footer}</div>}
    </div>
  );
}

const RPE_WORD = ["", "Very easy", "Easy", "Easy", "Moderate", "Moderate", "Hard", "Hard", "Very hard", "Near max", "Max"];

function Rpe({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  return (
    <div className="field-l rpe">
      <div className="row rpe-hd"><span className="silk" id="rpe-l">RPE</span>
        {value != null && <span className="rpe-val mono" aria-hidden="true">{value} · {RPE_WORD[value]}</span>}
        <span className="fill" />
        {value != null && <button className="key flat plain rpe-clear" onClick={() => onChange(null)}>Clear</button>}</div>
      <div className="seg rpe-keys" role="radiogroup" aria-labelledby="rpe-l">
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
          <button key={n} role="radio" aria-checked={value === n} className={`key mono ${value === n ? "is-on" : ""}`}
            onClick={() => onChange(value === n ? null : n)}>{n}</button>
        ))}
      </div>
      <div className="rpe-ends" aria-hidden="true"><span>Easy</span><span>Max</span></div>
    </div>
  );
}

function Recorded({ a, named }: { a: Activity; named?: boolean }) {
  const p = pace(a.distance_km, a.duration_min);
  const dock = useDock();
  const nav = useNavigate();
  return (
    <div className="screen rec-screen">
      <dl className="readout">
        {named ? <div><dt>{sourceLabel(a)}</dt><dd>{a.name || sportLabel(a.type)}</dd></div> : <div><dt>Source</dt><dd>{sourceLabel(a)}</dd></div>}
        {a.distance_km != null && <div><dt>Distance</dt><dd>{Math.round(a.distance_km * 100) / 100}<small>km</small></dd></div>}
        {a.duration_min != null && <div><dt>Time</dt><dd>{clock(a.duration_min)}</dd></div>}
        {p && (a.type === "run" || a.type === "walk") && <div><dt>Pace</dt><dd>{p}</dd></div>}
        {a.avg_hr != null && <div><dt>Avg HR</dt><dd>{Math.round(a.avg_hr)}<small>bpm</small></dd></div>}
      </dl>
      {a.has_stream && (
        <a className="key flat plain rec-open" href={`/activities/${encodeURIComponent(a.id)}`}
          onClick={(e) => { e.preventDefault(); dock.close(); nav(`/activities/${encodeURIComponent(a.id)}`); }}>
          Laps, splits and charts ›
        </a>
      )}
    </div>
  );
}

function Amounts({ dur, dist, setDur, setDist }: { dur: string; dist: string; setDur: (v: string) => void; setDist: (v: string) => void }) {
  return (
    <div className="ed-row2 keep2">
      <label className="field-l"><span className="silk">Duration</span>
        <span className="unit-in"><input className="input mono" inputMode="decimal" value={dur} placeholder="—" onChange={(e) => setDur(e.target.value)} /><span>min</span></span>
      </label>
      <label className="field-l"><span className="silk">Distance</span>
        <span className="unit-in"><input className="input mono" inputMode="decimal" value={dist} placeholder="—" onChange={(e) => setDist(e.target.value)} /><span>km</span></span>
      </label>
    </div>
  );
}

type SaveState = "idle" | "saving" | "saved" | "error";

/** The sets of a log sheet. They save as they are logged (a gym, between sets), not with Save: the
 * whole list is sent after a short pause, and once more if the sheet closes with a change pending.
 * `op` builds the write for a list; null means "hold them", for an activity that does not exist yet.
 * `takePending` hands Save the list when it has not been sent, so Save can carry it in its own op. */
function useLiveSets(initial: LoggedSet[], op: ((next: LoggedSet[]) => Op) | null) {
  const change = useChange();
  const [sets, setSets] = useState(initial);
  const [state, setState] = useState<SaveState>("idle");
  const latest = useRef(sets);
  const saved = useRef(JSON.stringify(initial));
  const timer = useRef<number | undefined>(undefined);
  const flush = () => {
    window.clearTimeout(timer.current);
    const text = JSON.stringify(latest.current);
    if (!op || text === saved.current) return;
    saved.current = text;
    setState("saving");
    change.mutate({ ops: [op(latest.current)], toast: false }, {
      onSuccess: () => setState("saved"),
      onError: () => { saved.current = ""; setState("error"); },
    });
  };
  const update = (next: LoggedSet[]) => {
    latest.current = next;
    setSets(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 600);
  };
  const takePending = (): LoggedSet[] | undefined => {
    window.clearTimeout(timer.current);
    const text = JSON.stringify(latest.current);
    if (text === saved.current) return undefined;
    saved.current = text;
    return latest.current;
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => flushRef.current(), []);
  return { sets, latest, update, state, takePending };
}

function WorkoutLog({ w, a }: { w: Workout; a?: Activity }) {
  const dock = useDock();
  const change = useChange();
  const today = useToday().data?.today ?? todayIso();
  const recorded = a && a.source !== "manual";
  const [mode, setMode] = useState<"done" | "skipped">(w.state === "skipped" ? "skipped" : "done");
  const [reason, setReason] = useState(w.skip_reason);
  const [skipped, setSkipped] = useState<string[]>(a?.skipped_items ?? []);
  const [rpe, setRpe] = useState<number | null>(a?.rpe ?? null);
  const [dur, setDur] = useState(a && !recorded && a.duration_min != null ? String(a.duration_min) : "");
  const [dist, setDist] = useState(a && !recorded && a.distance_km != null ? String(a.distance_km) : "");
  const [notes, setNotes] = useState(a?.notes ?? "");
  const needsDate = !a && (w.date == null || w.date > today);
  const [when, setWhen] = useState(needsDate ? today : w.date ?? today);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const done = w.state === "done";
  const exercises = useExercises().data;
  const measureOfEx = (id: string) => exercises?.find((e) => e.id === id)?.default_measure;

  const { sets, latest, update: changeSets, state: setState, takePending } = useLiveSets(a?.sets ?? [], (next) => {
    const op: Op = { op: "log_workout", workout_id: w.id, sets: next };
    if (a) op.activity_id = a.id;
    if (needsDate) op.date = when;
    return op;
  });

  const save = () => {
    const ops: Op[] = [];
    if (mode === "skipped") {
      ops.push({ op: "set_workout_status", id: w.id, status: "skipped", reason: reason.trim() });
    } else {
      const op: Op = { op: "log_workout", workout_id: w.id };
      if (a) op.activity_id = a.id;
      if (needsDate) op.date = when;
      // Only what the user changed, so annotations made elsewhere are never overwritten.
      if (!a || !sameList(skipped, a.skipped_items)) op.skipped_items = skipped;
      const pending = takePending();
      if (pending) op.sets = pending;
      if (!a || notes !== a.notes) op.notes = notes;
      if (rpe != null && (!a || rpe !== a.rpe)) op.rpe = rpe;
      if (!recorded) {
        const du = numOrNull(dur), di = numOrNull(dist);
        if (du != null && Number.isFinite(du) && du !== a?.duration_min) op.duration_min = du;
        if (di != null && Number.isFinite(di) && di !== a?.distance_km) op.distance_km = di;
      }
      ops.push(op);
      if (a && rpe == null && a.rpe != null) ops.push({ op: "update_activity_annotations", id: a.id, rpe: null });
    }
    change.mutate({ ops, toast: mode === "skipped" ? `Skipped ${w.title}` : done ? `Updated log · ${w.title}` : `Logged ${w.title}` }, { onSuccess: dock.close });
  };
  const unlink = () => { setMenu(false); change.mutate({ ops: [{ op: "unlink_activity", activity_id: a!.id }], toast: `Unlinked from ${w.title}` }, { onSuccess: dock.close }); };
  const delLog = () => { setMenu(false); change.mutate({ ops: [{ op: "delete_activity", id: a!.id }], toast: `Deleted the log of ${w.title}` }, { onSuccess: dock.close }); };

  return (
    <Shell title={w.title} mark={w.mark} sub={w.date ? dayLabel(w.date) : "No day yet"}
      menu={a && <>
        <button ref={moreRef} className="key sq flat" aria-label="Log actions" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><Icon name="more" /></button>
        <Popover anchor={moreRef} open={menu} onClose={() => setMenu(false)} label="Log actions" width={200}>
          <MenuList label="Log actions">
            {recorded ? <MenuItem onSelect={unlink}>Unlink activity</MenuItem> : <MenuItem onSelect={delLog}>Delete log</MenuItem>}
          </MenuList>
        </Popover>
      </>}
      footer={<><span className="fill" /><button className="key ink log-save" disabled={change.isPending} onClick={save}>Save</button></>}>
      <div className="seg log-mode" role="radiogroup" aria-label="Outcome">
        <button role="radio" aria-checked={mode === "done"} className={`key ${mode === "done" ? "is-on" : ""}`} onClick={() => setMode("done")}>Done</button>
        <button role="radio" aria-checked={mode === "skipped"} className={`key ${mode === "skipped" ? "is-on" : ""}`} disabled={done}
          title={done ? "It has a log; delete or unlink it first" : undefined} onClick={() => setMode("skipped")}>Skipped</button>
      </div>
      {mode === "skipped" ? (
        <div className="field-l">
          <input className="input" value={reason} placeholder="Reason" aria-label="Reason" onChange={(e) => setReason(e.target.value)} />
          <div className="row wrap">{REASONS.map((r) => <button key={r} className={`key plain ${reason === r ? "is-latched" : ""}`} onClick={() => setReason(r)}>{r}</button>)}</div>
        </div>
      ) : <>
        {needsDate && (
          <div className="field-l"><span className="silk">Date done</span>
            <DateField value={when} max={today} today={today} label="Date done" onChange={(v) => v && setWhen(v)} />
          </div>
        )}
        <fieldset className="field-l">
            <legend className="silk sl-legend">Items
              {setState !== "idle" && <span className={`sl-state ${setState}`} role="status">
                {setState === "saving" ? "Saving…" : setState === "saved" ? "Sets saved" : "Not saved · retry by editing"}
              </span>}
            </legend>
            {w.items.length > 0 && <ul className="sl-list">
              {w.items.map((it, i) => {
                const off = skipped.includes(it.id!);
                const skip = (s: boolean) => setSkipped(s ? [...skipped, it.id!] : skipped.filter((x) => x !== it.id));
                const m = measureOf(it, measureOfEx(it.exercise_id));
                if (!m) {
                  return (
                    <li key={it.id} className={`sl-item ${off ? "off" : ""}`}>
                      <div className="sl-hd">
                        <label className="sl-ck">
                          <input type="checkbox" checked={!off} onChange={() => skip(!off)} />
                          <span className="inum mono">{String(i + 1).padStart(2, "0")}</span>
                          <span className="sl-name">{it.name}</span>
                        </label>
                        <span className="sl-rx mono">{prescription(it)}</span>
                      </div>
                    </li>
                  );
                }
                return (
                  <ItemSets key={it.id} it={it} n={i + 1} measure={m} activityId={a?.id} skipped={off} onSkip={skip}
                    logged={sets.filter((s) => s.item_id === it.id)}
                    onChange={(next) => changeSets(replaceItemSets(latest.current, w.items, it.id!, next))} />
                );
              })}
            </ul>}
            <ExtraItems type={w.type} items={w.items} sets={sets} latest={latest} onChange={changeSets} activityId={a?.id} first={w.items.length} />
          </fieldset>
        <Rpe value={rpe} onChange={setRpe} />
        {recorded ? <Recorded a={a!} named /> : <Amounts dur={dur} dist={dist} setDur={setDur} setDist={setDist} />}
        <label className="field-l"><span className="silk">Notes</span>
          <textarea className="textarea" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </>}
    </Shell>
  );
}

/** Log activity (unplanned, manual) — or the details of an existing unplanned activity. */
function ActivityLog({ a, date }: { a?: Activity; date?: string }) {
  const dock = useDock();
  const change = useChange();
  const today = useToday().data?.today ?? todayIso();
  const manual = !a || a.source === "manual";
  const [type, setType] = useState<WorkoutType>(a?.type ?? "run");
  const [day, setDay] = useState(a?.date ?? date ?? today);
  const [title, setTitle] = useState(a?.name ?? "");
  const [rpe, setRpe] = useState<number | null>(a?.rpe ?? null);
  const [dur, setDur] = useState(a?.duration_min != null && manual ? String(a.duration_min) : "");
  const [dist, setDist] = useState(a?.distance_km != null && manual ? String(a.distance_km) : "");
  const [notes, setNotes] = useState(a?.notes ?? "");
  const label = TYPE_LIST.find((t) => t.value === type)!;
  // Exercises done (an unplanned gym session, or a Garmin strength recording with nothing planned).
  // On an existing activity they save as they are logged, as in a workout's log; a new one sends them with Save.
  const withSets = ["strength", "mobility", "other"].includes(manual ? type : a!.type);
  const { sets, latest, update: changeSets, takePending } = useLiveSets(a?.sets ?? [], a ? (next) => ({ op: "update_activity_annotations", id: a.id, sets: next }) : null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<"none" | "more" | "link">("none");
  // Linked: go straight on to that workout's log, where its sets can be filled in.
  const link = useLink((wid) => a && dock.open({ kind: "log", workoutId: wid, activityId: a.id }));

  const save = () => {
    const du = numOrNull(dur), di = numOrNull(dist);
    if (!a) {
      const op: Op = { op: "log_activity", type, date: day, title: title.trim() || label.label, notes };
      if (rpe != null) op.rpe = rpe;
      if (du != null) op.duration_min = du;
      if (di != null) op.distance_km = di;
      const pending = takePending();
      if (withSets && pending?.length) op.sets = pending;
      change.mutate({ ops: [op], toast: `Logged ${title.trim() || label.label}` }, { onSuccess: dock.close });
      return;
    }
    const op: Op = { op: "update_activity_annotations", id: a.id };
    if (rpe !== a.rpe) op.rpe = rpe;
    if (notes !== a.notes) op.notes = notes;
    if (manual) {
      const t = title.trim() || label.label;
      if (t !== a.name) op.title = t;
      if (type !== a.type) op.type = type;
      if (day !== a.date) op.date = day;
      if (du !== a.duration_min) op.duration_min = du;
      if (di !== a.distance_km) op.distance_km = di;
    }
    const pending = takePending();
    if (pending) op.sets = pending;
    if (Object.keys(op).length === 2) { dock.close(); return; }
    change.mutate({ ops: [op], toast: `Updated ${title.trim() || a.name}` }, { onSuccess: dock.close });
  };
  return (
    <Shell title={a ? a.name || sportLabel(a.type) : "Log activity"} mark={a ? a.mark : label.mark} sub={a ? dayLabel(a.date) : undefined}
      menu={a && !a.workout_id && <>
        <button ref={moreRef} className="key sq flat" aria-label="Activity actions" aria-haspopup="menu" aria-expanded={menu !== "none"}
          onClick={() => setMenu(menu === "none" ? "more" : "none")}><Icon name="more" /></button>
        <Popover anchor={moreRef} open={menu === "more"} onClose={() => setMenu("none")} label="Activity actions" width={220}>
          <MenuList label="Activity actions">
            <MenuItem onSelect={() => setMenu("link")}>Link to workout…</MenuItem>
          </MenuList>
        </Popover>
        <Popover anchor={moreRef} open={menu === "link"} onClose={() => setMenu("none")} label="Link to a workout" width={290}>
          {menu === "link" && <LinkMenu a={a} link={link} onDone={() => setMenu("none")} />}
        </Popover>
      </>}
      footer={<><span className="fill" /><button className="key ink log-save" disabled={change.isPending} onClick={save}>Save</button></>}>
      {manual ? <>
        <div className="ed-row2">
          <label className="field-l"><span className="silk">Type</span>
            <select className="select" value={type} onChange={(e) => setType(e.target.value as WorkoutType)}>
              {TYPE_LIST.map((t) => <option key={t.value} value={t.value}>{t.mark} · {t.label}</option>)}
            </select>
          </label>
          <div className="field-l"><span className="silk">Date</span>
            <DateField value={day} max={today} today={today} label="Date" onChange={(v) => v && setDay(v)} />
          </div>
        </div>
        <label className="field-l"><span className="silk">Title</span>
          <input className="input" value={title} placeholder={label.label} onChange={(e) => setTitle(e.target.value)} />
        </label>
      </> : <Recorded a={a!} />}
      {withSets && (
        <fieldset className="field-l">
          <legend className="silk sl-legend">Exercises</legend>
          <ExtraItems type={manual ? type : a!.type} items={[]} sets={sets} latest={latest} onChange={changeSets} activityId={a?.id} first={0} added={false} />
        </fieldset>
      )}
      <Rpe value={rpe} onChange={setRpe} />
      {manual && <Amounts dur={dur} dist={dist} setDur={setDur} setDist={setDist} />}
      <label className="field-l"><span className="silk">Notes</span>
        <textarea className="textarea" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
    </Shell>
  );
}
