import { chromeTop, holdChrome } from "../ui/chrome";
import {
  DndContext, DragOverlay, MouseSensor, TouchSensor, useSensor, useSensors,
  type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type MouseEvent as RMouseEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import type { Chip, PreviewChip } from "../api/types";
import { ChatKey } from "../app/ChatKey";
import { useDock } from "../app/dock";
import { useCoarse, useMobile } from "../app/useMedia";
import { usePublishScope } from "../chat/scope";
import { Calendar } from "../ui/DateField";
import { addDays, dayLabel, mondayOf } from "../ui/dates";
import { Icon } from "../ui/Icon";
import { Popover } from "../ui/Popover";
import { Agenda } from "./Agenda";
import { useChange, useToday, useWeeksRange, weeksMovePatch } from "./api";
import { BulkBar, type BulkAsk } from "./BulkBar";
import { isoWeek } from "./dates";
import { createOverStore } from "./overSlot";
import { LibSide, useAddFromLib, type LibDrag } from "./LibSide";
import { PreviewBar, useProposal } from "./preview";
import { AddMenu, LibKey, MobileBar, TagFilter, useLibDrawer, useTagParam, ViewSeg, withTag } from "./toolbar";
import { isTyping } from "./WeekPage";
import { GridLegend, WeekRowView, type GridCtx } from "./WeeksGrid";
import {
  boxSelect, capRange, daysBetween, hitIds, indexRows, mondays, previewMap, rangeLabel, rectFrom, shiftTargets, shiftWords,
  slotKey, toggleSel, type Ghost, type Indexed, type Rect,
} from "./weeksModel";

const W = 7;
const EXTEND = 8 * W; // days added when scrolling near an edge
const MAX_WEEKS = 40; // loaded window cap; weeks far from the viewport are dropped
const EDGE = 500; // px from an edge that loads more weeks

export function WeeksPage() {
  const today = useToday();
  if (!today.data) {
    return <div className="page plan"><div className="strip" /><WeeksSkeleton /></div>;
  }
  return <Weeks todayIso={today.data.today} />;
}

function WeeksSkeleton() {
  return (
    <div className="weeks-skel" aria-busy="true" aria-label="Loading weeks">
      {Array.from({ length: 6 }, (_, i) => <div key={i} className="skel" style={{ height: 64, margin: "0 14px 1px" }} />)}
    </div>
  );
}

function Weeks({ todayIso }: { todayIso: string }) {
  const mobile = useMobile();
  const coarse = useCoarse();
  const nav = useNavigate();
  const dock = useDock();
  const change = useChange();
  const addLib = useAddFromLib();
  const [params, setParams] = useSearchParams();
  const [tag] = useTagParam();
  const [lib, toggleLib] = useLibDrawer();
  const proposalId = params.get("proposal");
  const at = params.get("at");
  const curMon = mondayOf(todayIso);
  const anchor0 = at && /^\d{4}-\d{2}-\d{2}$/.test(at) ? mondayOf(at) : curMon;

  // ---------- Range, data, index ----------
  const [range, setRange] = useState(() => ({ from: addDays(anchor0, -8 * W), to: addDays(anchor0, 16 * W) }));
  const data = useWeeksRange(range.from, range.to, tag);
  const rowsBy = useMemo(() => new Map(data.rows.map((r) => [r.monday, r])), [data.rows]);
  const ms = useMemo(() => mondays(range.from, range.to), [range]);
  const index = useMemo(() => indexRows(data.rows), [data.rows]);

  // ---------- Selection ----------
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [ask, setAsk] = useState<BulkAsk | null>(null);
  const [shiftN, setShiftN] = useState(0);
  const selChips = useMemo(() => [...sel].map((id) => index.get(id)).filter((c): c is Indexed => !!c), [sel, index]);
  const clearSel = useCallback(() => { setSel(new Set()); setSelectMode(false); setAsk(null); setShiftN(0); }, []);
  useEffect(() => {
    if (data.loading || !sel.size) return;
    if ([...sel].some((id) => !index.has(id))) setSel(new Set([...sel].filter((id) => index.has(id))));
  }, [index, data.loading, sel]);
  useEffect(() => { clearSel(); }, [tag, clearSel]);

  const shiftGhosts = useMemo(() => {
    const out = new Map<string, Ghost[]>();
    if (!shiftN) return out;
    const t = shiftTargets(selChips, shiftN);
    for (const c of selChips) {
      const to = t.get(c.id)!;
      const chip: PreviewChip = { id: c.id, date: to.date, time: c.time ?? null, week_monday: to.week_monday, weekday: null, type: c.type, mark: c.mark,
        title: c.title, tags: c.tags, series_id: c.series_id, status: c.state, items: [] };
      const k = slotKey(to.date, to.week_monday);
      out.set(k, [...(out.get(k) ?? []), { key: `shift:${c.id}`, kind: "move", chip, fields: [] }]);
    }
    return out;
  }, [shiftN, selChips]);

  // ---------- Proposal preview ----------
  const proposal = useProposal(proposalId);
  const pmap = useMemo(() => (proposal.data && (proposal.data.status === "open" || proposal.data.status === "stale") ? previewMap(proposal.data) : null),
    [proposal.data]);
  const closePreview = () => { const p = new URLSearchParams(params); p.delete("proposal"); setParams(p, { replace: true }); };

  // ---------- Scrolling: anchor, visible range, infinite edges ----------
  const scroller = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const pending = useRef<string | null>(addDays(anchor0, -W)); // opens with the anchor week second from the top
  const anchor = useRef<{ monday: string; off: number } | null>(null);
  const [tick, setTick] = useState(0);
  const [vis, setVis] = useState({ first: anchor0, last: addDays(anchor0, 5 * W) });
  // The header sticks a gap below the scroller's top (weeks.css --gap); rows land just under it.
  const headH = () => (head.current ? head.current.offsetHeight + (parseFloat(getComputedStyle(head.current).top) || 0) : 0)
    + (scroller.current ? chromeTop(scroller.current) : 0);
  const rowEl = (m: string) => scroller.current?.querySelector<HTMLElement>(`[data-monday="${m}"]`) ?? null;

  const jump = useCallback((m: string) => {
    const target = mondayOf(m);
    setRange((r) => ({ from: target < addDays(r.from, 4 * W) ? addDays(target, -8 * W) : r.from, to: target > addDays(r.to, -10 * W) ? addDays(target, 16 * W) : r.to }));
    pending.current = target;
    setTick((t) => t + 1);
  }, []);

  const measure = useCallback(() => {
    const sc = scroller.current;
    if (!sc) return;
    const top = sc.getBoundingClientRect().top + headH();
    const bottom = sc.getBoundingClientRect().bottom;
    let first: string | null = null, last: string | null = null;
    for (const el of sc.querySelectorAll<HTMLElement>("[data-monday]")) {
      const r = el.getBoundingClientRect();
      if (r.bottom <= top + 4) continue;
      if (r.top >= bottom - 4) break;
      if (!first) { first = el.dataset.monday!; anchor.current = { monday: first, off: r.top - top }; }
      last = el.dataset.monday!;
    }
    if (first && last) setVis((v) => (v.first === first && v.last === last ? v : { first: first!, last: last! }));
    const cap = (r: { from: string; to: string }) => (first && last ? capRange(r, first, last, MAX_WEEKS) : r);
    if (sc.scrollTop < EDGE) setRange((r) => cap({ ...r, from: addDays(r.from, -EXTEND) }));
    else if (sc.scrollHeight - sc.scrollTop - sc.clientHeight < EDGE) setRange((r) => cap({ ...r, to: addDays(r.to, EXTEND) }));
    else setRange((r) => cap(r)); // also settles a window that a jump left oversized
  }, []);

  useLayoutEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    if (pending.current) {
      const el = rowEl(pending.current);
      if (!el) return;
      holdChrome();
      sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - headH();
      pending.current = null;
      measure();
      return;
    }
    // Keep the first visible week where it was while rows above load or grow (manual scroll
    // anchoring, so prepending history never makes the view jump).
    const a = anchor.current;
    const el = a && rowEl(a.monday);
    if (a && el) {
      const off = el.getBoundingClientRect().top - (sc.getBoundingClientRect().top + headH());
      if (Math.abs(off - a.off) > 0.5) sc.scrollTop += off - a.off;
    }
  });
  useEffect(() => { measure(); }, [measure, tick, data.rows.length]);
  const raf = useRef(0);
  const onScroll = () => { cancelAnimationFrame(raf.current); raf.current = requestAnimationFrame(measure); };

  // Scroll to a proposal's first week once it loads.
  const shownFor = useRef<string | null>(null);
  useEffect(() => {
    if (!pmap?.first || !proposal.data || shownFor.current === proposal.data.id) return;
    shownFor.current = proposal.data.id;
    const last = [...proposal.data.weeks].sort().at(-1) ?? pmap.first;
    setRange((r) => ({ from: r.from < addDays(pmap.first!, -2 * W) ? r.from : addDays(pmap.first!, -4 * W), to: r.to > addDays(last, 2 * W) ? r.to : addDays(last, 4 * W) }));
    pending.current = addDays(pmap.first, -W);
    setTick((t) => t + 1);
  }, [pmap, proposal.data]);

  // ---------- Chat scope: visible range + selection ----------
  const selection = selChips.slice(0, 15).map((c) => `${c.title} (${c.date ? dayLabel(c.date) : `no day, week of ${c.week_monday}`}, ${c.id})`).join("; ");
  usePublishScope({
    page: "weeks", from: vis.first, to: addDays(vis.last, 6),
    label: `W${isoWeek(vis.first)}–W${isoWeek(vis.last)}${sel.size ? ` · ${sel.size} selected` : ""}`,
    ...(selection ? { selection } : {}),
  });

  // ---------- Chip interaction ----------
  // Handlers are stable (they read the latest state through a ref) so the memoised grid rows
  // aren't invalidated by every render.
  const live = useRef({ sel, selectMode });
  live.current = { sel, selectMode };
  const onChip = useCallback((c: Chip, _m: string, e: RMouseEvent | RKeyboardEvent) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey || live.current.selectMode) { setSel((s) => toggleSel(s, c.id)); return; }
    dock.open({ kind: "editor", id: c.id });
  }, [dock]);
  const onChipKey = useCallback((c: Chip, _m: string, e: RKeyboardEvent) => {
    const k = e.key;
    const only = () => { if (!live.current.sel.has(c.id)) setSel(new Set([c.id])); };
    if (k === " ") { e.preventDefault(); setSel((s) => toggleSel(s, c.id)); }
    else if ((k === "m" || k === "M") && !e.metaKey && !e.ctrlKey) { e.preventDefault(); only(); setAsk("move"); }
    else if (k === "Delete" || k === "Backspace") { e.preventDefault(); only(); setAsk("delete"); }
  }, []);
  const addOn = useCallback((date: string) => dock.open({ kind: "editor", seed: { date, week_monday: mondayOf(date) } }), [dock]);
  const onActivity = useCallback((id: string) => dock.open({ kind: "log", activityId: id }), [dock]);
  const addNew = (repeat = false) => dock.open({ kind: "editor", seed: { date: todayIso, week_monday: curMon, repeat } });
  const addSaved = (id: string) => dock.open({ kind: "editor", seed: { date: todayIso, week_monday: curMon, from_saved: id } });

  // ---------- Page keys ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      if (e.key === "Escape" && (sel.size || selectMode)) { e.preventDefault(); clearSel(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSel(new Set([...index.values()].filter((c) => c.week_monday >= vis.first && c.week_monday <= vis.last && !pmap?.gone.has(c.id)).map((c) => c.id)));
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "t") jump(addDays(curMon, -W));
      else if (e.key === "w") nav(withTag(`/plan/week/${vis.first <= curMon && curMon <= vis.last ? curMon : vis.first}`, tag));
      else if (e.key === "n") addNew();
      else if ((e.key === "Delete" || e.key === "Backspace") && sel.size) setAsk("delete");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---------- Box select (mouse, on empty grid area) ----------
  const [band, setBand] = useState<Rect | null>(null);
  const onBodyDown = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse" || e.button !== 0 || mobile) return;
    if ((e.target as HTMLElement).closest("button, a, input, .wk-tray .silk")) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const base = new Set(sel);
    let active = false;
    let items: { id: string; rect: Rect }[] | null = null;
    const move = (ev: PointerEvent) => {
      if (!active && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
      active = true;
      items ??= [...(scroller.current?.querySelectorAll<HTMLElement>("[data-sel-id]") ?? [])].map((el) => ({ id: el.dataset.selId!, rect: el.getBoundingClientRect() }));
      const r = rectFrom(start, { x: ev.clientX, y: ev.clientY });
      setBand(r);
      const next = boxSelect(base, hitIds(r, items), additive);
      setSel((cur) => (cur.size === next.size && [...next].every((id) => cur.has(id)) ? cur : next));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setBand(null);
      if (!active && !additive && sel.size) setSel(new Set());
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ---------- Drag and drop ----------
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 350, tolerance: 8 } }),
  );
  const [drag, setDrag] = useState<{ chip?: Chip; monday?: string; lib?: LibDrag } | null>(null);
  const [over] = useState(createOverStore);
  const slotOf = (o: DragOverEvent["over"]) => {
    const d = o?.data.current as { date: string | null; monday: string } | undefined;
    return d ? slotKey(d.date, d.monday) : null;
  };
  const onDragStart = (e: DragStartEvent) => setDrag(e.active.data.current as { chip?: Chip; monday?: string; lib?: LibDrag });
  const onDragOver = (e: DragOverEvent) => over.set(slotOf(e.over));
  const onDragEnd = (e: DragEndEvent) => {
    const d = e.active.data.current as { chip?: Chip; monday?: string; lib?: LibDrag };
    setDrag(null);
    over.set(null);
    const to = e.over?.data.current as { date: string | null; monday: string } | undefined;
    if (!to) return;
    if (d.lib) { addLib(d.lib, to.date, to.monday); return; }
    const c = d.chip!, from = d.monday!;
    if (to.date === c.date && (to.date !== null || to.monday === from)) return;
    if (sel.has(c.id) && sel.size > 1) {
      const n = c.date && to.date ? daysBetween(c.date, to.date) : daysBetween(from, to.monday);
      if (!n) return;
      const expected = Object.fromEntries(selChips.map((x) => [`workout:${x.id}`, x.version]));
      change.mutate({ ops: [{ op: "shift_workouts", ids: selChips.map((x) => x.id), days: n }], expected,
        toast: `Moved ${shiftWords(selChips.length, n)}`, patches: [weeksMovePatch(shiftTargets(selChips, n))] });
      return;
    }
    const place = to.date ? { date: to.date } : { week_monday: to.monday };
    change.mutate({
      ops: [{ op: "move_workout", id: c.id, ...place }], expected: { [`workout:${c.id}`]: c.version },
      toast: `Moved ${c.title} to ${to.date ? dayLabel(to.date) : "no day"}`,
      patches: [weeksMovePatch(new Map([[c.id, { date: to.date, week_monday: to.monday }]]))],
    });
  };

  const dragging = !!drag;
  const ctx: GridCtx = useMemo(() => ({
    today: todayIso, tag, sel, preview: pmap, shiftGhosts, dragging, over,
    onChip, onChipKey, onAdd: addOn, onActivity,
  }), [todayIso, tag, sel, pmap, shiftGhosts, dragging, over, onChip, onChipKey, addOn, onActivity]);
  const currentVisible = vis.first <= curMon && curMon <= vis.last;
  const showLib = lib && !mobile;
  const selecting = sel.size > 0 || selectMode;

  return (
    <div className="page plan weeks-page">
      {selecting ? (
        <div className="strip bulk-strip">
          {sel.size ? (
            <BulkBar chips={selChips} mobile={mobile} today={todayIso} ask={ask} onAsk={setAsk} onClear={clearSel} onShiftPreview={setShiftN} />
          ) : (
            <div className="bulkbar" role="toolbar" aria-label="Select workouts">
              <span className="bb-n">Tap workouts to select</span><span className="fill" />
              <button className="key flat plain" onClick={clearSel}>Done</button>
            </div>
          )}
        </div>
      ) : (
        <WeeksToolbar mobile={mobile} coarse={coarse} label={rangeLabel(vis.first, vis.last)} first={vis.first} today={todayIso}
          currentVisible={currentVisible} lib={showLib} onLib={toggleLib}
          onPrev={() => jump(addDays(vis.first, -4 * W))} onNext={() => jump(addDays(vis.first, 4 * W))}
          onToday={() => jump(addDays(curMon, -W))} onJump={(d) => jump(addDays(mondayOf(d), -W))}
          onSelect={() => setSelectMode(true)} onAdd={addNew} onAddSaved={addSaved} />
      )}
      <DndContext sensors={sensors} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}
        onDragCancel={() => { setDrag(null); over.set(null); }}
        accessibility={{ announcements: {
          onDragStart: () => "Picked up workout.", onDragOver: ({ over }) => (over ? `Over ${String(over.id).replace(/^(cell|tray):/, "")}` : "Not over a day"),
          onDragEnd: ({ over }) => (over ? "Dropped." : "Dropped nowhere; nothing moved"), onDragCancel: () => "Move cancelled",
        } }}>
        <div className="plan-body">
          {showLib && <LibSide onClose={toggleLib} />}
          <div ref={scroller} className={`page-scroll weeks-scroll ${drag ? "is-dragging" : ""}`} onScroll={onScroll}>
            {mobile ? (
              <Agenda mondays={ms} rows={rowsBy} ctx={ctx} selectMode={selectMode || sel.size > 0}
                onLong={(c) => { setSelectMode(true); setSel((s) => new Set(s).add(c.id)); }} />
            ) : (
              <div className={`weeks ${tag ? "tagged" : ""} ${pmap ? "previewing" : ""}`} role="grid" aria-label="Weeks" aria-multiselectable="true" onPointerDown={onBodyDown}>
                <div ref={head} className="wk-head" role="row">
                  <span role="columnheader" className="sr">Week</span>
                  <span aria-hidden="true" />
                  {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <span key={d} role="columnheader" className="silk">{d}</span>)}
                  <span role="columnheader" className="silk wk-tot-h">Total</span>
                </div>
                {ms.map((m) => <WeekRowView key={m} monday={m} row={rowsBy.get(m)} ctx={ctx} />)}
                <GridLegend />
              </div>
            )}
            {data.error && !data.rows.length && (
              <div className="board"><div className="state-err module" role="alert"><p>Couldn't load these weeks.</p>
                <button className="key" onClick={data.refetch}>Retry</button></div></div>
            )}
          </div>
        </div>
        <DragOverlay dropAnimation={null}>
          {drag?.chip && (
            <div className="drag-ghost sm">
              <span className="mono mk">{drag.chip.mark}</span><span className="ttl">{drag.chip.title}</span>
              {sel.has(drag.chip.id) && sel.size > 1 && <span className="mono muted">+{sel.size - 1}</span>}
            </div>
          )}
          {drag?.lib && <div className="drag-ghost sm"><span className="mono mk">{drag.lib.mark}</span><span className="ttl">{drag.lib.title}</span></div>}
        </DragOverlay>
      </DndContext>
      {band && <div className="band" style={{ left: band.left, top: band.top, width: band.right - band.left, height: band.bottom - band.top }} aria-hidden="true" />}
      {proposal.data && <PreviewBar p={proposal.data} onClose={closePreview} />}
      {proposalId && proposal.isError && (
        <div className="preview-bar done" role="region" aria-label="Proposal preview">
          <div className="pb-t"><span className="pb-s">This proposal no longer exists.</span></div>
          <div className="pb-k-row"><button className="key flat" onClick={closePreview}>Close preview</button></div>
        </div>
      )}
    </div>
  );
}

function WeeksToolbar({ mobile, coarse, label, first, today, currentVisible, lib, onLib, onPrev, onNext, onToday, onJump, onSelect, onAdd, onAddSaved }: {
  mobile: boolean; coarse: boolean; label: string; first: string; today: string; currentVisible: boolean; lib: boolean; onLib: () => void;
  onPrev: () => void; onNext: () => void; onToday: () => void; onJump: (d: string) => void; onSelect: () => void;
  onAdd: (repeat?: boolean) => void; onAddSaved: (id: string) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [jump, setJump] = useState(false);
  const labelKey = (
    <button ref={ref} className="key wk-label range" aria-haspopup="dialog" aria-expanded={jump} onClick={() => setJump(!jump)}
      aria-label={`Showing ${label}. Jump to a date`}><span className="mono">{label}</span></button>
  );
  const selectKey = (mobile || coarse) && <button className="key plain flat" onClick={onSelect}><Icon name="check" />Select</button>;
  const addKey = <AddMenu mobile={mobile} onAdd={onAdd} onAddSaved={onAddSaved} />;
  return (
    <div className="strip" role="toolbar" aria-label="Weeks controls">
      {mobile ? <>
        <MobileBar view="weeks" monday={first} top={label.split(/\s[–-]\s/)[0]} sub={`Week ${isoWeek(first)}`} pickRef={ref} jumpOpen={jump}
          onJump={() => setJump(!jump)} onPrev={onPrev} onNext={onNext} isCurrent={currentVisible} onToday={onToday} onSelect={onSelect} add={addKey} />
      </> : <>
        <ViewSeg view="weeks" monday={first} />
        <span className="div" />
        <div className="grp wk-nav">
          <button className="key sq" aria-label="Earlier weeks" onClick={onPrev}><Icon name="prev" /></button>
          {labelKey}
          <button className="key sq" aria-label="Later weeks" onClick={onNext}><Icon name="next" /></button>
          <button className="key flat plain today-k" onClick={onToday} disabled={currentVisible}>Today</button>
        </div>
        <span className="div" />
        <TagFilter mobile={false} />
        <span className="fill" />
        {selectKey}
        <LibKey open={lib} onToggle={onLib} />
        {addKey}
        <ChatKey />
      </>}
      <Popover anchor={ref} open={jump} onClose={() => setJump(false)} label="Jump to a week" align="start" width={262}>
        <p className="pop-t">Jump to</p>
        <Calendar value={null} today={today} label="Week" onPick={(d) => { onJump(d); setJump(false); }} />
      </Popover>
    </div>
  );
}
