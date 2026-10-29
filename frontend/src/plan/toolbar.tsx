import { useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useDock } from "../app/dock";
import { ActionSheet } from "../app/ActionSheet";
import { readPref, writePref } from "../app/prefs";
import { Icon } from "../ui/Icon";
import { MenuItem, MenuList, MenuSep, Popover } from "../ui/Popover";
import { useSaved, useTags, useToday } from "./api";

/** The tag filter lives in the URL (?tag=) so Week, Weeks and links agree. */
export function useTagParam(): [string | null, (t: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const tag = params.get("tag");
  const set = (t: string | null) => {
    const p = new URLSearchParams(params);
    if (t) p.set("tag", t); else p.delete("tag");
    setParams(p, { replace: true });
  };
  return [tag, set];
}

export const withTag = (path: string, tag: string | null) => (tag ? `${path}?tag=${encodeURIComponent(tag)}` : path);

/** Week | Weeks. Keeps the tag filter across the switch. */
export function ViewSeg({ view, monday }: { view: "week" | "weeks"; monday?: string }) {
  const nav = useNavigate();
  const today = useToday();
  const [tag] = useTagParam();
  const toWeek = () => nav(withTag(`/plan/week/${monday ?? today.data?.monday ?? ""}`, tag));
  return (
    <div className="seg view-seg" role="radiogroup" aria-label="Plan view">
      <button role="radio" aria-checked={view === "week"} className={`key ${view === "week" ? "is-on" : ""}`}
        onClick={view === "week" ? undefined : toWeek}>Week</button>
      <button role="radio" aria-checked={view === "weeks"} className={`key ${view === "weeks" ? "is-on" : ""}`}
        onClick={view === "weeks" ? undefined : () => nav(withTag("/plan/weeks", tag) + (monday ? `${tag ? "&" : "?"}at=${monday}` : ""))}>Weeks</button>
    </div>
  );
}

/** "Tag ▾" → tags with counts; latched as "#marathon ×" while filtering. Labelled on every
 * viewport (an unlabeled icon read as nothing on mobile). */
export function TagFilter({ mobile }: { mobile: boolean }) {
  const [tag, setTag] = useTagParam();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const tags = useTags();
  return (
    <>
      {tag ? (
        <span className="tag-latch">
          <button ref={ref} className="key plain is-latched" onClick={() => setOpen(!open)} aria-haspopup="dialog" aria-expanded={open}
            aria-label={`Filtered by tag ${tag}. Change tag`}><span className="mono">#{tag}</span></button>
          <button className="key sq flat" aria-label="Clear tag filter" title="Show all" onClick={() => setTag(null)}><Icon name="close" /></button>
        </span>
      ) : (
        <button ref={ref} className="key plain flat tag-k" aria-haspopup="dialog" aria-expanded={open} aria-label="Filter by tag"
          onClick={() => setOpen(!open)}>
          <Icon name="tag" /><span>Tag</span>{!mobile && <Icon name="down" />}
        </button>
      )}
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} label="Filter by tag" align="start" width={240}>
        <MenuList label="Tags">
          {tags.data?.length ? tags.data.map((t) => (
            <MenuItem key={t.tag} hint={String(t.n)} onSelect={() => { setTag(t.tag); setOpen(false); }}>
              <span className={t.tag === tag ? "menu-on" : ""}>#{t.tag}</span>
            </MenuItem>
          )) : <p className="muted small pad-s">No tags. Add them in a workout.</p>}
          {tag && <><MenuSep /><MenuItem onSelect={() => { setTag(null); setOpen(false); }}>Show all</MenuItem></>}
        </MenuList>
      </Popover>
    </>
  );
}

/** + ADD → Workout · Repeating workout · Activity · From saved workout… */
export function AddMenu({ mobile, onAdd, onAddSaved }: {
  mobile: boolean; onAdd: (repeat?: boolean) => void; onAddSaved: (id: string) => void;
}) {
  const dock = useDock();
  const today = useToday();
  const saved = useSaved();
  const ref = useRef<HTMLButtonElement>(null);
  const [pop, setPop] = useState<"none" | "add" | "saved">("none");
  const close = () => setPop("none");
  return (
    <>
      <button ref={ref} className={`key ink ${mobile ? "sq" : ""}`} aria-haspopup="menu" aria-expanded={pop === "add"}
        onClick={() => setPop(pop === "add" ? "none" : "add")} aria-label="Add">
        <Icon name="plus" />{!mobile && "Add"}
      </button>
      {mobile ? <>
        <ActionSheet open={pop === "add"} onClose={close} label="Add">
          <div className="more-list">
            <button className="more-row" onClick={() => { close(); onAdd(); }}><Icon name="plus" />Workout</button>
            <button className="more-row" onClick={() => { close(); onAdd(true); }}><Icon name="repeat" />Repeating workout</button>
            <button className="more-row" onClick={() => { close(); dock.open({ kind: "log", date: today.data?.today }); }}><Icon name="check" />Log an activity</button>
            {!!saved.data?.length && <button className="more-row" onClick={() => setPop("saved")}><Icon name="library" />From saved workout<Icon name="right" className="hint" /></button>}
          </div>
        </ActionSheet>
        <ActionSheet open={pop === "saved"} onClose={close} label="Saved workouts">
          <div className="more-list">
            {saved.data?.map((x) => <button key={x.id} className="more-row" onClick={() => { close(); onAddSaved(x.id); }}><span className="mono muted">{x.mark}</span>{x.title}</button>)}
          </div>
        </ActionSheet>
      </> : <>
      <Popover anchor={ref} open={pop === "add"} onClose={close} label="Add" width={240}>
        <MenuList label="Add">
          <MenuItem hint="N" onSelect={() => { close(); onAdd(); }}>Workout</MenuItem>
          <MenuItem onSelect={() => { close(); onAdd(true); }}>Repeating workout</MenuItem>
          <MenuItem onSelect={() => { close(); dock.open({ kind: "log", date: today.data?.today }); }}>Log an activity</MenuItem>
          <MenuItem disabled={!saved.data?.length} onSelect={() => setPop("saved")}>From saved workout…</MenuItem>
        </MenuList>
      </Popover>
      <Popover anchor={ref} open={pop === "saved"} onClose={close} label="Saved workouts" width={260}>
        <MenuList label="Saved workouts">
          {saved.data?.map((s) => <MenuItem key={s.id} onSelect={() => { close(); onAddSaved(s.id); }}><span className="mono muted">{s.mark}</span> {s.title}</MenuItem>)}
        </MenuList>
      </Popover>
      </>}
    </>
  );
}

/** Library drawer toggle (desktop and tablet): saved workouts and exercises to drag onto days. */
export function useLibDrawer(): [boolean, () => void] {
  const [open, setOpen] = useState<boolean>(() => readPref("plan.lib", false));
  return [open, () => setOpen((o) => { writePref("plan.lib", !o); return !o; })];
}

export function LibKey({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button className={`key sq lib-k ${open ? "is-latched" : ""}`} aria-pressed={open} onClick={onToggle}
      aria-label="Library: drag saved workouts onto days" title="Library (drag onto a day)"><Icon name="library" /></button>
  );
}

/** Phone title bar: one 52px row. Week | Weeks, a ‹ range › stepper (centre opens the date jump),
 * Add, and one overflow menu for Today, tag filter, Select and the assistant. */
export function MobileBar({ view, monday, top, sub, pickRef, jumpOpen, onJump, onPrev, onNext, isCurrent, onToday, onSelect, add }: {
  view: "week" | "weeks"; monday?: string; top: string; sub: string;
  pickRef: React.RefObject<HTMLButtonElement | null>; jumpOpen: boolean; onJump: () => void;
  onPrev: () => void; onNext: () => void; isCurrent: boolean; onToday: () => void; onSelect?: () => void; add: React.ReactNode;
}) {
  const [tag, setTag] = useTagParam();
  const tags = useTags();
  const dock = useDock();
  const moreRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <div className="strip-row m-bar">
        <ViewSeg view={view} monday={monday} />
        <div className="seg m-wk">
          <button className="key sq" aria-label={view === "week" ? "Previous week" : "Earlier weeks"} onClick={onPrev}><Icon name="prev" /></button>
          <button ref={pickRef} className="key m-wk-l" aria-haspopup="dialog" aria-expanded={jumpOpen} onClick={onJump}
            aria-label={`${sub}, ${top}. Jump to a date`}>
            <span className="mono m-wk-t">{top.replace(/\s–\s/, "–")}</span><span className="silk m-wk-s">{sub}</span>
          </button>
          <button className="key sq" aria-label={view === "week" ? "Next week" : "Later weeks"} onClick={onNext}><Icon name="next" /></button>
        </div>
        {add}
        <button ref={moreRef} className={`key sq flat m-more ${tag ? "has-dot" : ""}`} aria-label="More" aria-haspopup="menu" aria-expanded={open}
          onClick={() => setOpen(!open)}><Icon name="more" /></button>
        <ActionSheet open={open} onClose={close} label="More">
          <div className="more-list">
            <button className="more-row" disabled={isCurrent} onClick={() => { close(); onToday(); }}><Icon name="cal" />Go to today</button>
            {onSelect && <button className="more-row" onClick={() => { close(); onSelect(); }}><Icon name="check" />Select workouts</button>}
            <button className="more-row" onClick={() => { close(); dock.toggleConsole(); }}><Icon name="chat" />Assistant</button>
          </div>
          {!!tags.data?.length && <>
            <p className="silk sheet-h">Tag</p>
            <div className="more-list">
              {tags.data.map((t) => (
                <button key={t.tag} className="more-row" aria-pressed={t.tag === tag} onClick={() => { setTag(t.tag === tag ? null : t.tag); close(); }}>
                  <span className="mono">#{t.tag}</span>{t.tag === tag && <Icon name="check" className="hint" />}<span className="hint mono">{t.n}</span>
                </button>
              ))}
            </div>
          </>}
        </ActionSheet>
      </div>
      {tag && (
        <div className="strip-row m-tagrow">
          <span className="silk">Tag</span><span className="mono m-tag">#{tag}</span><span className="fill" />
          <button className="key flat plain" onClick={() => setTag(null)}><Icon name="close" />Show all</button>
        </div>
      )}
    </>
  );
}
