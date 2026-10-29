import { useRef } from "react";
import { Link } from "react-router";
import type { Chip, WeeksRow } from "../api/types";
import { byTime } from "../editor/model";
import { addDays, dayLabel } from "../ui/dates";
import { sportLabel } from "../ui/sport";
import { isoWeek, rangeShort } from "./dates";
import { withTag } from "./toolbar";
import { GLYPH, STATE_WORD, Totals, type GridCtx } from "./WeeksGrid";
import { ghostTitle, slotKey, type Ghost } from "./weeksModel";

const dd = (iso: string) => dayLabel(iso).split(" ").slice(0, 2).join(" ");

/** Long-press (400 ms, < 8 px of movement) without losing the normal tap. */
function useLongPress(onLong: () => void) {
  const t = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const clear = () => { if (t.current) window.clearTimeout(t.current); t.current = null; };
  return {
    fired,
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        fired.current = false;
        start.current = { x: e.clientX, y: e.clientY };
        clear();
        t.current = window.setTimeout(() => { fired.current = true; onLong(); }, 400);
      },
      onPointerMove: (e: React.PointerEvent) => {
        if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 8) clear();
      },
      onPointerUp: clear, onPointerCancel: clear, onPointerLeave: clear,
      onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    },
  };
}

function Row({ c, monday, ctx, selectMode, onLong }: { c: Chip; monday: string; ctx: GridCtx; selectMode: boolean; onLong: (c: Chip) => void }) {
  const lp = useLongPress(() => onLong(c));
  const gone = ctx.preview?.gone.get(c.id);
  const edit = ctx.preview?.edited.get(c.id);
  const sel = ctx.sel.has(c.id);
  const shown = edit ? edit.chip : c;
  return (
    <li>
      <button {...lp.handlers} className={`ag-row s-${c.state} ${sel ? "sel" : ""} ${gone ? "gone" : ""} ${edit ? "ghost" : ""}`}
        aria-pressed={selectMode ? sel : undefined}
        aria-label={`${c.title}, ${c.date ? dayLabel(c.date) : "no day yet"}${c.time ? ` at ${c.time}` : ""}, ${sportLabel(c.type)}, ${STATE_WORD[c.state]}${selectMode ? (sel ? ", selected" : "") : ". Long-press to select"}`}
        onClick={(e) => { if (lp.fired.current) { lp.fired.current = false; return; } ctx.onChip(c, monday, e); }}>
        {selectMode && <span className={`ag-box ${sel ? "on" : ""}`} aria-hidden="true">{sel ? "✓" : ""}</span>}
        <span className="ag-d mono">{c.date ? dd(c.date) : "No day"}</span>
        <span className="sport">{shown.mark}</span>
        <span className="ag-t"><span className="ag-ti">{shown.title}</span>{c.time && <span className="ag-tm mono">{c.time}</span>}</span>
        <span className="ag-g mono" aria-hidden="true">{GLYPH[c.state] ?? ""}</span>
      </button>
    </li>
  );
}

function GhostRow({ g }: { g: Ghost }) {
  return (
    <li className="ag-row ghost" role="img" aria-label={ghostTitle(g)} title={ghostTitle(g)}>
      <span className="ag-d mono">{g.chip.date ? dd(g.chip.date) : "No day"}</span>
      <span className="sport">{g.kind === "add" ? "+" : "→"}{g.chip.mark}</span>
      <span className="ag-t"><span className="ag-ti">{g.chip.title}</span>{g.chip.time && <span className="ag-tm mono">{g.chip.time}</span>}</span>
      <span />
    </li>
  );
}

/** Mobile Weeks: an agenda grouped by week (sticky headers with totals). Tap = edit,
 * long-press = select; the bulk bar then offers Move to… instead of drag. */
export function Agenda({ mondays, rows, ctx, selectMode, onLong }: {
  mondays: string[]; rows: Map<string, WeeksRow>; ctx: GridCtx; selectMode: boolean; onLong: (c: Chip) => void;
}) {
  return (
    <div className="agenda">
      {mondays.map((m) => {
        const r = rows.get(m);
        const current = m <= ctx.today && ctx.today <= addDays(m, 6);
        const items: ({ kind: "c"; c: Chip; d: string } | { kind: "g"; g: Ghost; d: string } | { kind: "a"; a: WeeksRow["days"][number]["unplanned"][number]; d: string })[] = [];
        if (r) {
          for (const d of r.days) {
            for (const c of byTime(d.workouts)) items.push({ kind: "c", c, d: d.date });
            for (const a of d.unplanned) items.push({ kind: "a", a, d: d.date });
            for (const g of [...(ctx.preview?.ghosts.get(d.date) ?? []), ...(ctx.shiftGhosts.get(d.date) ?? [])]) items.push({ kind: "g", g, d: d.date });
          }
          for (const c of r.tray) items.push({ kind: "c", c, d: "~" });
          for (const g of [...(ctx.preview?.ghosts.get(slotKey(null, m)) ?? []), ...(ctx.shiftGhosts.get(slotKey(null, m)) ?? [])]) items.push({ kind: "g", g, d: "~" });
          items.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
        }
        return (
          <section key={m} className={`ag-wk ${current ? "current" : ""}`} data-monday={m} aria-label={`Week ${isoWeek(m)}`}>
            <Link className="ag-hd" to={withTag(`/plan/week/${m}`, ctx.tag)}>
              <span className="mono ag-wn">W{isoWeek(m)}</span><span className="ag-rg">{rangeShort(m)}</span>
              <span className="fill" />
              {r && <span className="ag-tot mono"><Totals row={r} today={ctx.today} compact /></span>}
            </Link>
            {!r ? <div className="ag-skel"><span className="skel" /></div> : items.length ? (
              <ul className="ag-list">
                {items.map((it) => it.kind === "c" ? <Row key={it.c.id} c={it.c} monday={m} ctx={ctx} selectMode={selectMode} onLong={onLong} />
                  : it.kind === "g" ? <GhostRow key={it.g.key} g={it.g} />
                    : (
                      <li key={it.a.id}>
                        <button className="ag-row act" onClick={() => ctx.onActivity(it.a.id)} aria-label={`${it.a.name}, unplanned, ${dayLabel(it.d)}`}>
                          {selectMode && <span className="ag-box off" aria-hidden="true" />}
                          <span className="ag-d mono">{dd(it.d)}</span>
                          <span className="sport act">{it.a.mark}</span>
                          <span className="ag-t"><span className="ag-ti">{it.a.name}</span></span>
                          <span className="am" aria-hidden="true" />
                        </button>
                      </li>
                    ))}
              </ul>
            ) : <p className="ag-none">{m < ctx.today.slice(0, 10) && addDays(m, 6) < ctx.today ? "Nothing logged" : "Nothing planned"}</p>}
          </section>
        );
      })}
    </div>
  );
}
