import { useEffect, type RefObject } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Tab targets inside `root`, in DOM order (hidden ones skipped). */
export function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/** The element Tab / Shift+Tab should land on to stay inside `list`, or null to let the
 * browser move normally. Pure so it can be tested without a DOM. */
export function wrapTarget<T>(list: T[], active: unknown, back: boolean): T | null {
  if (!list.length) return null;
  const i = list.indexOf(active as T);
  if (back && (i <= 0)) return list[list.length - 1];
  if (!back && (i === -1 || i === list.length - 1)) return list[0];
  return null;
}

/** For anything that is `aria-modal` or acts as a dialog: Tab cycles inside `ref`, Esc calls
 * `onEscape` (if given and nothing else handled it), and focus returns to whatever had it
 * before when the dialog unmounts (unless `restore` is false because the owner does it). */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, opts: { onEscape?: () => void; restore?: boolean; active?: boolean } = {}) {
  const { onEscape, restore = true, active = true } = opts;
  useEffect(() => {
    const root = ref.current;
    if (!root || !active) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        const list = tabbables(root);
        if (!list.length) { e.preventDefault(); root.focus(); return; }
        const t = wrapTarget(list, document.activeElement, e.shiftKey);
        const outside = !root.contains(document.activeElement);
        if (t || outside) { e.preventDefault(); (t ?? list[0]).focus(); }
      } else if (e.key === "Escape" && onEscape && !e.defaultPrevented && !document.querySelector(".popover")) {
        e.preventDefault();
        onEscape();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (restore && before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [ref, onEscape, restore, active]);
}
