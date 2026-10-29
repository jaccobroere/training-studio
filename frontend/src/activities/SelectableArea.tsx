import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { hms } from "../health/charts/parts";
import { makeWindow, moveWindow, nudgeEdge, type Win } from "./selection";

/** Where the plot sits inside the chart (px from the left, right and top; its height). */
export interface Plot { left: number; right: number; top: number; height: number }

type Drag = { kind: "new" | "move" | "edge"; edge: 0 | 1; x0: number; y0: number; w0: Win | null; moved: boolean };

const clamp01 = (f: number) => Math.min(1, Math.max(0, f));
const DRAG_PX = 4;

/** Makes a chart's plot area selectable: drag across it to pick a window, drag the window to move
 * it, drag an edge to resize it, click outside to clear it. The two edges are sliders (arrow keys
 * move by 1 s, Shift by 10 s; Esc clears), with 44px hit areas so a thumb can grab them. On touch a
 * finger drags the window itself, the grips resize it, and bare plot scrolls the page. `toFrac` /
 * `fromFrac` convert between seconds and 0..1 across the plot. */
export function SelectableArea({ plot, win, total, toFrac, fromFrac, onWin, children }: {
  plot: Plot; win: Win | null; total: number; toFrac: (t: number) => number; fromFrac: (f: number) => number;
  onWin: (w: Win | null) => void; children: ReactNode;
}) {
  const plotEl = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const at = (clientX: number) => {
    const r = plotEl.current!.getBoundingClientRect();
    return clamp01((clientX - r.left) / r.width);
  };
  const begin = (e: PointerEvent, kind: Drag["kind"], edge: 0 | 1 = 0) => {
    drag.current = { kind, edge, x0: at(e.clientX), y0: e.clientY, w0: win, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const f = at(e.clientX);
    const inside = !!win && f >= toFrac(win[0]) && f <= toFrac(win[1]);
    if (e.pointerType === "touch" && !inside) return; // bare plot: keep page scroll
    begin(e, inside ? "move" : "new");
  };
  const move = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const f = at(e.clientX);
    const width = plotEl.current!.getBoundingClientRect().width;
    const dx = (f - d.x0) * width;
    // A finger that starts on the window may still be scrolling the page: only take over once the
    // drag is clearly sideways, otherwise a few px of drift would nudge the window by seconds.
    const vertical = e.pointerType === "touch" && d.kind === "move";
    if (!d.moved && (Math.abs(dx) < DRAG_PX || (vertical && Math.abs(dx) <= Math.abs(e.clientY - d.y0) + DRAG_PX))) return;
    d.moved = true;
    const dt = fromFrac(f) - fromFrac(d.x0);
    if (d.kind === "new") onWin(makeWindow(fromFrac(d.x0), fromFrac(f), total));
    else if (d.kind === "move" && d.w0) onWin(moveWindow(d.w0, dt, total));
    else if (d.w0) onWin(nudgeEdge(d.w0, d.edge, dt, total)); // an edge dragged onto the other one stops there
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved && d.kind === "new" && win) onWin(null); // a click outside puts the window away
  };
  const key = (e: KeyboardEvent, edge: 0 | 1) => {
    if (!win) return;
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "Escape") onWin(null);
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") onWin(nudgeEdge(win, edge, e.key === "ArrowLeft" ? -step : step, total));
    else return;
    e.preventDefault();
  };
  const frac = win ? [toFrac(win[0]), toFrac(win[1])] : null;
  return (
    <div className="sel-area" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      {children}
      <div ref={plotEl} className="sel-plot" style={{ left: plot.left, right: plot.right, top: plot.top, height: plot.height }}>
        {win && frac && (
          <div className="sel-win" style={{ left: `${frac[0] * 100}%`, width: `${(frac[1] - frac[0]) * 100}%` }}>
            <span className="sel-len mono">{hms(win[1] - win[0])}</span>
            {([0, 1] as const).map((edge) => (
              <button key={edge} type="button" role="slider" className={`sel-edge e${edge}`} aria-orientation="horizontal"
                aria-label={edge ? "Window end" : "Window start"} aria-valuemin={0} aria-valuemax={Math.round(total)}
                aria-valuenow={Math.round(win[edge])} aria-valuetext={hms(win[edge])}
                onPointerDown={(e) => { e.stopPropagation(); begin(e, "edge", edge); }} onKeyDown={(e) => key(e, edge)}><i /></button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
