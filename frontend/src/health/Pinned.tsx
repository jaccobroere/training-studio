import { DndContext, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { useDock } from "../app/dock";
import { ResultBody } from "../chat/AnalysisCard";
import { prefillChat } from "../chat/prefill";
import type { Pinned } from "../chat/types";
import { sinceStamp, todayIso } from "../ui/dates";
import { Icon } from "../ui/Icon";
import { useToast } from "../ui/toast";
import { usePinned, usePinnedRun } from "./api";
import { keyTarget, moveById, moveItem, rangeWords } from "./order";

/** Health → Pinned: saved analyses re-run on current data when they come into view. The UI can
 * reorder and remove them; changing one is the assistant's job ("Ask to change"). */
export function PinnedBoard() {
  const qc = useQueryClient();
  const toast = useToast();
  const dock = useDock();
  const q = usePinned();
  const [say, setSay] = useState("");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor));
  const list = q.data ?? [];

  const save = async (next: Pinned[], moved: Pinned) => {
    const prev = list;
    qc.setQueryData(["pinned"], next);
    const pos = next.findIndex((x) => x.id === moved.id) + 1;
    setSay(`Moved ${moved.title} to position ${pos} of ${next.length}.`);
    try {
      const saved = await api<Pinned[]>("/api/pinned/order", { method: "PUT", json: { ids: next.map((x) => x.id) } });
      qc.setQueryData(["pinned"], saved);
    } catch {
      qc.setQueryData(["pinned"], prev);
      toast({ tone: "error", text: "Couldn't save the new order. Reloaded." });
      void qc.invalidateQueries({ queryKey: ["pinned"] });
    }
  };
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const moved = list.find((x) => x.id === e.active.id);
    if (moved) void save(moveById(list, String(e.active.id), String(e.over.id)), moved);
  };
  const remove = async (p: Pinned) => {
    const prev = list;
    qc.setQueryData(["pinned"], list.filter((x) => x.id !== p.id));
    try {
      await api(`/api/pinned/${p.id}`, { method: "DELETE" });
      // Only an unchanged pin can be put back exactly: re-pin its analysis.
      const back = p.created_from && p.version === 1 ? p.created_from : null;
      toast({
        text: `Removed ${p.title}`,
        action: back ? { label: "Undo", run: async () => {
          try {
            await api("/api/pinned", { method: "POST", json: { analysis_id: back, title: p.title } });
          } catch (e) {
            toast({ tone: "error", text: e instanceof ApiError && e.code === "analysis_not_found" ? "That analysis is gone; ask the assistant to pin it again." : "Couldn't put it back." });
          }
          void qc.invalidateQueries({ queryKey: ["pinned"] });
        } } : undefined,
      });
    } catch {
      qc.setQueryData(["pinned"], prev);
      toast({ tone: "error", text: "Couldn't remove it. Try again." });
    }
  };
  const ask = (text: string) => { prefillChat(text); dock.open({ kind: "console" }); };

  if (q.isPending) return <div className="pin-list"><div className="skel" style={{ height: 220 }} aria-label="Loading pinned analyses" /></div>;
  if (q.isError) {
    return <div className="h-empty"><p>Couldn't load your pinned analyses.</p><button type="button" className="key" onClick={() => void q.refetch()}>Retry</button></div>;
  }
  if (!list.length) {
    return (
      <div className="h-empty">
        <p><b>Nothing pinned.</b> Pin an analysis from the chat and it re-runs here on your latest data.</p>
        <button type="button" className="key" onClick={() => ask("Chart my resting heart rate and HRV over the last 90 days, with a 7-day average.")}>Ask the assistant</button>
      </div>
    );
  }
  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <p className="sr-only" aria-live="polite">{say}</p>
      <ol className="pin-list">
        {list.map((p, i) => (
          <PinnedCard key={p.id} p={p} index={i} count={list.length}
            onMove={(to) => void save(moveItem(list, i, to), p)} onRemove={() => void remove(p)}
            onAsk={() => ask(`About my pinned analysis “${p.title}” (${p.id}): please change it: `)} />
        ))}
      </ol>
    </DndContext>
  );
}

/** Starts the run only when the card is (nearly) on screen. */
function useVisible<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) setSeen(true); }, { rootMargin: "300px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

function PinnedCard({ p, index, count, onMove, onRemove, onAsk }: {
  p: Pinned; index: number; count: number; onMove: (to: number) => void; onRemove: () => void; onAsk: () => void;
}) {
  const qc = useQueryClient();
  const [box, visible] = useVisible<HTMLLIElement>();
  const run = usePinnedRun(p, visible);
  const [refreshing, setRefreshing] = useState(false);
  const drag = useDraggable({ id: p.id });
  const drop = useDroppable({ id: p.id });
  const r = run.data;
  const today = todayIso();
  const refresh = async () => {
    setRefreshing(true);
    try {
      const fresh = await api(`/api/pinned/${p.id}/run?force=true`);
      qc.setQueryData(["pinned", "run", p.id, p.version], fresh);
    } catch { /* the card shows the last result */ } finally { setRefreshing(false); }
  };
  const style = drag.transform ? { transform: `translate3d(0, ${drag.transform.y}px, 0)`, zIndex: 3, position: "relative" as const } : undefined;
  const failed = r && r.status !== "ok";
  return (
    <li ref={(el) => { box.current = el; drop.setNodeRef(el); }} style={style}
      className={`module pin-card ${drag.isDragging ? "dragging" : ""} ${drop.isOver && !drag.isDragging ? "drop-over" : ""}`} aria-label={p.title}>
      <div className="module-hd pin-hd">
        <button type="button" ref={drag.setActivatorNodeRef} className="key sq flat pin-grip" {...drag.listeners} {...drag.attributes}
          aria-label={`Reorder ${p.title}: position ${index + 1} of ${count}. Use arrow keys to move.`} aria-roledescription="sortable"
          onKeyDown={(e) => {
            const to = keyTarget(e.key, index, count);
            if (to == null) return;
            e.preventDefault();
            onMove(to);
            requestAnimationFrame(() => (document.querySelector(`[data-grip="${p.id}"]`) as HTMLElement | null)?.focus());
          }} data-grip={p.id}><Icon name="grip" /></button>
        <h3 className="pin-t">{p.title}</h3>
        <span className="fill" />
        <button type="button" className="key flat" onClick={onAsk}>Ask to change</button>
        <button type="button" className="key sq flat" aria-label={`Run ${p.title} again`} title="Run again" disabled={refreshing || run.isFetching} onClick={() => void refresh()}><Icon name="sync" /></button>
        <button type="button" className="key sq flat" aria-label={`Remove ${p.title} from Pinned`} title="Remove" onClick={onRemove}><Icon name="trash" /></button>
      </div>
      <div className="pin-meta mono">
        {r ? <>
          <span>{rangeWords(r.ranges, today)}</span>
          {Object.entries(r.rows).map(([k, n]) => <span key={k}>{k}: {n} rows</span>)}
          <span>{r.cached ? `ran ${sinceStamp(r.ran_at)}` : "ran just now"}</span>
        </> : <span>{p.datasets.map((d) => `${d.name}: ${d.kind}`).join(" · ")}</span>}
        {p.version > 1 && <span>v{p.version}</span>}
      </div>
      <div className="pin-body">
        {!visible || run.isPending || refreshing ? (
          <div className="pin-skel" role="status" aria-label={`Running ${p.title} on your latest data`}>
            <div className="skel" style={{ height: 180 }} />
            <span className="mono">Running on your latest data…</span>
          </div>
        ) : run.isError ? (
          <div className="pin-err" role="alert"><p>Couldn't run this pin{run.error instanceof ApiError ? ` (${run.error.code})` : ""}.</p>
            <button type="button" className="key" onClick={() => void run.refetch()}>Retry</button></div>
        ) : failed ? (
          <div className="pin-err" role="alert">
            <p><b>{r.status === "timeout" ? "This took too long and was stopped." : "This pin no longer runs on the current data."}</b></p>
            {r.result.error_brief?.message && <pre className="an-out err mono">{r.result.error_brief.message}{r.result.error_brief.line ? ` (line ${r.result.error_brief.line})` : ""}</pre>}
            <p className="muted small">Ask the assistant to fix it; the pin keeps its place.</p>
            <button type="button" className="key" onClick={onAsk}>Ask to fix</button>
          </div>
        ) : r ? <ResultBody res={r.result} chartHeight={230} fold={2} /> : null}
      </div>
    </li>
  );
}
