import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { tabbables, wrapTarget } from "./focusTrap";

/** Breathing room kept between a popover and every viewport edge. */
const EDGE = 8;
/** Below this a popover stops being readable; the viewport still wins on a very small screen. */
const MIN_W = 180;

/** The `width` prop is a preference, not a promise: a popover never grows past the viewport. */
function fitWidth(preferred: number | undefined, vw: number): number | undefined {
  if (preferred == null) return undefined;
  const room = Math.max(0, vw - EDGE * 2);
  return Math.max(Math.min(preferred, room), Math.min(Math.min(preferred, MIN_W), room));
}

/** Anchored popover rendered in a portal with fixed positioning, so it can never be clipped
 * by a scrolling container. Closes on outside click and Escape; returns focus to the anchor. */
export function Popover({ anchor, open, onClose, children, align = "end", label, width: preferredWidth }: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: "start" | "end";
  label: string;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  // Tracked so the preferred width is re-clamped when the window narrows under an open popover.
  const [vw, setVw] = useState(() => (typeof window === "undefined" ? 1024 : window.innerWidth));
  const width = fitWidth(preferredWidth, vw);

  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    setVw(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const place = () => {
      const a = anchor.current!.getBoundingClientRect();
      const el = ref.current;
      // Measured size, not the requested width: the clamp (and any content growth) wins.
      const w = el?.offsetWidth || width || 220;
      const h = el?.offsetHeight || 200;
      const maxLeft = Math.max(EDGE, window.innerWidth - w - EDGE);
      let left = align === "end" ? a.right - w : a.left;
      left = Math.min(Math.max(EDGE, left), maxLeft);
      let top = a.bottom + 6;
      if (top + h > window.innerHeight - EDGE) top = a.top - h - 6; // flip above the anchor
      top = Math.min(Math.max(EDGE, top), Math.max(EDGE, window.innerHeight - h - EDGE));
      setPos({ top, left });
    };
    place();
    const id = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    // content can grow after the first placement (a search list refilling): keep it on screen
    const ro = typeof ResizeObserver !== "undefined" && ref.current ? new ResizeObserver(place) : null;
    if (ro && ref.current) ro.observe(ref.current);
    return () => {
      ro?.disconnect();
      cancelAnimationFrame(id);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor, align, width, vw]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      if (inLaterPopover(t)) return; // a popover opened from inside this one
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab" && ref.current && ref.current.contains(e.target as Node) && !inLaterPopover(e.target as Node)) {
        // Popovers are dialogs: Tab cycles inside instead of leaking behind them.
        const t = wrapTarget(tabbables(ref.current), document.activeElement, e.shiftKey);
        if (t) { e.preventDefault(); t.focus(); }
        return;
      }
      if (e.key === "Escape") {
        if (inLaterPopover(e.target as Node)) return; // Esc closes the topmost layer only
        e.stopPropagation();
        onClose();
        anchor.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    /** Is `t` inside a popover rendered after this one (a nested child)? */
    const inLaterPopover = (t: Node) => {
      const el = (t instanceof Element ? t : t.parentElement)?.closest(".popover");
      return !!el && el !== ref.current && !!ref.current && !!(ref.current.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    };
    const first = ref.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")
      ?? ref.current?.querySelector<HTMLElement>("button:not([disabled]), input, select, textarea");
    if (!ref.current?.contains(document.activeElement)) first?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose, anchor]);

  if (!open) return null;
  return createPortal(
    <div ref={ref} className="popover" role="dialog" aria-label={label}
      // max-width is the hard cap; width is only the preference fitWidth() clamped.
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width, maxWidth: `calc(100vw - ${EDGE * 2}px)` }}>
      {children}
    </div>,
    document.body,
  );
}

/** Vertical list of menu actions with arrow-key navigation. */
export function MenuList({ children, label }: { children: ReactNode; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} role="menu" aria-label={label} className="menu" tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const items = [...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])") ?? [])];
        const i = items.indexOf(document.activeElement as HTMLElement);
        const n = items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
        n?.focus();
      }}>
      {children}
    </div>
  );
}

export function MenuItem({ onSelect, children, disabled, hint }: {
  onSelect: () => void; children: ReactNode; disabled?: boolean; hint?: string;
}) {
  return (
    <button role="menuitem" className="menu-item" disabled={disabled} onClick={onSelect}>
      <span>{children}</span>
      {hint && <span className="menu-hint mono">{hint}</span>}
    </button>
  );
}

export const MenuSep = () => <div className="menu-sep" role="separator" />;
