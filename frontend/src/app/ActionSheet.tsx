import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../ui/focusTrap";

/** Phone action sheet: a bottom sheet of 48px rows (`.more-row`) over a scrim. Same mechanics as the
 * More sheet; replaces anchored popovers for menus on touch screens. */
export function ActionSheet({ open, onClose, label, children }: {
  open: boolean; onClose: () => void; label: string; children: ReactNode;
}) {
  return open ? createPortal(<Sheet onClose={onClose} label={label}>{children}</Sheet>, document.body) : null;
}

function Sheet({ onClose, label, children }: { onClose: () => void; label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus(); }, []);
  useFocusTrap(ref, { onEscape: onClose });
  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div ref={ref} className="sheet bottom more-sheet action-sheet" role="dialog" aria-modal="true" aria-label={label}>
        <span className="grab" aria-hidden="true" />
        {children}
      </div>
    </>
  );
}
