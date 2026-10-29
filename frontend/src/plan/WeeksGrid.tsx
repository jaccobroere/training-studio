import { useDraggable, useDroppable } from "@dnd-kit/core";
import { memo, type KeyboardEvent, type MouseEvent } from "react";
import { Link } from "react-router";
import type { Chip, WeeksRow } from "../api/types";
import { byTime } from "../editor/model";
import { addDays, dayLabel, shortDate } from "../ui/dates";
import { Icon } from "../ui/Icon";
import { sportLabel } from "../ui/sport";
import { isoWeek } from "./dates";
import { useIsOver, type OverStore } from "./overSlot";
import { withTag } from "./toolbar";
import { ghostTitle, slotKey, totalLines, totalText, type Ghost, type PreviewMap } from "./weeksModel";

export const GLYPH: Record<string, string> = { done: "●", skipped: "⊘", not_logged: "○" };
/** The legend under the grid: what each status mark on a chip means. */
const LEGEND: [string, string][] = [["●", "done"], ["○", "planned, not logged"], ["⊘", "skipped"], ["▪", "unplanned recording"]];

export function GridLegend() {
  return (
    <p className="wk-legend small muted" aria-label="Legend">
      {LEGEND.map(([g, w]) => <span key={w}><span className="mono" aria-hidden="true">{g}</span> {w}</span>)}
    </p>
  );
}

export const STATE_WORD: Record<string, string> = { done: "done", skipped: "skipped", not_logged: "not logged", planned: "planned" };

export interface GridCtx {
  today: string;
  tag: string | null;
  sel: ReadonlySet<string>;
  preview: PreviewMap | null;
  /** Live "Shift days…" preview: where selected chips would land. */
  shiftGhosts: Map<string, Ghost[]>;
  dragging: boolean;
  /** The slot under the pointer; read per cell (not via React state) so moves stay cheap. */
  over: OverStore;
  onChip: (c: Chip, monday: string, e: MouseEvent | KeyboardEvent) => void;
  onChipKey: (c: Chip, monday: string, e: KeyboardEvent) => void;
  onAdd: (date: string) => void;
  onActivity: (id: string) => void;
}

/** One workout chip: time · mark · short title · status glyph. Drag to any day; Shift/⌘-click
 * to select; click to edit. */
const WChip = memo(function WChip({ c, monday, ctx }: { c: Chip; monday: string; ctx: GridCtx }) {
  const gone = ctx.preview?.gone.get(c.id);
  const edit = ctx.preview?.edited.get(c.id);
  const locked = !!gone || !!edit;
  const drag = useDraggable({ id: `c:${c.id}`, data: { chip: c, monday }, disabled: locked });
  const selected = ctx.sel.has(c.id);
  const shifting = selected && ctx.shiftGhosts.size > 0;
  const shown = edit ? edit.chip : c;
  const cls = ["wchip", `s-${c.state}`, selected ? "sel" : "", drag.isDragging ? "dragging" : "", gone ? "gone" : "",
    edit ? "ghost edit" : "", shifting ? "shifting" : ""].join(" ");
  const label = `${c.title}, ${c.date ? dayLabel(c.date) : "no day yet"}${c.time ? ` at ${c.time}` : ""}, ${sportLabel(c.type)}, ${STATE_WORD[c.state]}`
    + (gone ? `. Proposed ${gone === "move" ? "move away" : "removal"}` : "") + (edit ? `. ${ghostTitle(edit)}` : "");
  return (
    <button ref={drag.setNodeRef} {...(locked ? {} : drag.listeners)} className={cls} data-sel-id={locked ? undefined : c.id}
      aria-pressed={selected} aria-label={label} title={edit ? ghostTitle(edit) : `${c.title}${c.time ? ` · ${c.time}` : ""}${GLYPH[c.state] ? ` · ${STATE_WORD[c.state]}` : ""}`}
      onClick={(e) => ctx.onChip(c, monday, e)} onKeyDown={(e) => ctx.onChipKey(c, monday, e)}
      onKeyUp={(e) => { if (e.key === " ") e.preventDefault(); }}>
      {c.time && <span className="tm mono">{c.time}</span>}
      <span className="mk mono">{shown.mark}</span>
      <span className="ti">{shown.title}</span>
      {GLYPH[c.state] && <span className="gl mono" aria-hidden="true" title={STATE_WORD[c.state]}>{GLYPH[c.state]}</span>}
    </button>
  );
});

function GhostChip({ g, shift }: { g: Ghost; shift?: boolean }) {
  return (
    <span className={`wchip ghost ${shift ? "shift" : ""}`} title={shift ? `Lands here: ${g.chip.title}` : ghostTitle(g)} role="img"
      aria-label={shift ? `${g.chip.title} would land here` : ghostTitle(g)}>
      {g.chip.time && <span className="tm mono">{g.chip.time}</span>}
      <span className="mk mono">{g.kind === "add" ? "+" : g.kind === "move" ? "→" : ""}{g.chip.mark}</span>
      <span className="ti">{g.chip.title}</span>
    </span>
  );
}

const Cell = memo(function Cell({ date, chips, unplanned, monday, ctx }: {
  date: string; chips: Chip[]; unplanned: WeeksRow["days"][number]["unplanned"]; monday: string; ctx: GridCtx;
}) {
  const drop = useDroppable({ id: `cell:${date}`, data: { date, monday } });
  const ghosts = [...(ctx.preview?.ghosts.get(date) ?? []), ...(ctx.shiftGhosts.get(date) ?? [])];
  const isToday = date === ctx.today;
  const over = useIsOver(ctx.over, date);
  return (
    <div ref={drop.setNodeRef} className={`wcell ${isToday ? "today" : ""} ${date < ctx.today ? "past" : ""} ${over ? "over" : ""}`}
      data-date={date} role="gridcell" aria-label={dayLabel(date)}>
      {byTime(chips).map((c) => <WChip key={c.id} c={c} monday={monday} ctx={ctx} />)}
      {unplanned.map((a) => (
        <button key={a.id} className="wchip act" title={`${a.name} · unplanned`} aria-label={`${a.name}, unplanned ${sportLabel(a.type)}, ${dayLabel(date)}. Open`}
          onClick={() => ctx.onActivity(a.id)}>
          <span className="mk mono">{a.mark}</span><span className="ti">{a.name}</span><span className="am" aria-hidden="true" />
        </button>
      ))}
      {ghosts.map((g) => <GhostChip key={g.key} g={g} shift={g.key.startsWith("shift:")} />)}
      {!ctx.dragging && <button className="cell-add" tabIndex={-1} aria-label={`Add a workout on ${dayLabel(date)}`} onClick={() => ctx.onAdd(date)}><Icon name="plus" /></button>}
    </div>
  );
});

function TrayLine({ row, ctx }: { row: WeeksRow; ctx: GridCtx }) {
  const key = slotKey(null, row.monday);
  const drop = useDroppable({ id: `tray:${row.monday}`, data: { date: null, monday: row.monday } });
  const over = useIsOver(ctx.over, key);
  const ghosts = [...(ctx.preview?.ghosts.get(key) ?? []), ...(ctx.shiftGhosts.get(key) ?? [])];
  if (!row.tray.length && !ghosts.length) return null;
  return (
    <div ref={drop.setNodeRef} className={`wk-tray ${over ? "over" : ""}`}>
      <span className="silk">No day yet</span>
      {row.tray.map((c) => <WChip key={c.id} c={c} monday={row.monday} ctx={ctx} />)}
      {ghosts.map((g) => <GhostChip key={g.key} g={g} shift={g.key.startsWith("shift:")} />)}
    </div>
  );
}

export function Totals({ row, today, compact }: { row: WeeksRow; today: string; compact?: boolean }) {
  const when = addDays(row.monday, 6) < today ? "past" : row.monday > today ? "future" : "current";
  const { lines, rest } = totalLines(row.totals, when, compact ? 2 : 3);
  if (!lines.length) return <span className="tot-none">—</span>;
  return (
    <>
      {lines.map((l) => (
        <span key={l.type} className="tot" title={totalText(l)}>
          <span className="tot-m">{l.mark}</span>
          {l.actual != null && <b>{l.actual}</b>}
          {l.actual != null && l.planned != null && <span className="tot-p"> / {l.planned}</span>}
          {l.actual == null && l.planned != null && <span className="tot-p">{l.planned}</span>}
          {l.unit === "km" && <span className="tot-u"> km</span>}
        </span>
      ))}
      {rest.length > 0 && (
        <span className="tot tot-more" title={`Also this week:\n${rest.map(totalText).join("\n")}`}>
          <span aria-hidden="true">+{rest.length} more</span>
          <span className="sr">{rest.length} more {rest.length === 1 ? "type" : "types"}: {rest.map(totalText).join(", ")}</span>
        </span>
      )}
    </>
  );
}

export const WeekRowView = memo(function WeekRowView({ monday, row, ctx }: { monday: string; row?: WeeksRow; ctx: GridCtx }) {
  const current = monday <= ctx.today && ctx.today <= addDays(monday, 6);
  const n = row ? row.days.reduce((s, d) => s + d.workouts.length, 0) + row.tray.length : 0;
  return (
    <div className={`wk-row ${current ? "current" : ""} ${row ? "" : "loading"}`} data-monday={monday} role="row">
      <Link to={withTag(`/plan/week/${monday}`, ctx.tag)} className="wk-lab" role="rowheader"
        aria-label={`Week ${isoWeek(monday)}, ${shortDate(monday)}. Open the week`}>
        <span className="wn mono">W{isoWeek(monday)}</span>
        <span className="wd mono">{shortDate(monday)}</span>
        {ctx.tag && row && <span className="wt mono" title={`${n} × #${ctx.tag}`}>{n}×</span>}
      </Link>
      {row ? row.days.map((d) => <Cell key={d.date} date={d.date} chips={d.workouts} unplanned={d.unplanned} monday={monday} ctx={ctx} />)
        : Array.from({ length: 7 }, (_, i) => <div key={i} className={`wcell ${addDays(monday, i) < ctx.today ? "past" : ""}`} role="gridcell"><span className="skel" /></div>)}
      <div className="wk-tot mono" role="gridcell" aria-label="Totals, actual over planned">{row && <Totals row={row} today={ctx.today} />}</div>
      {row && <TrayLine row={row} ctx={ctx} />}
    </div>
  );
});
