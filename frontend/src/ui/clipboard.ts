/** Copy text, the async way where the browser has it and with a hidden textarea where it does not
 *  (older Safari, or a page the clipboard permission was refused on). Never throws: a copy that
 *  did not happen returns false so the caller can say so. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or no user gesture: try the selection route below.
  }
  return selectionCopy(text);
}

function selectionCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const sel = document.getSelection();
  const ranges: Range[] = [];
  if (sel) for (let i = 0; i < sel.rangeCount; i++) ranges.push(sel.getRangeAt(i).cloneRange());
  // Off-screen but rendered: `display: none` cannot be selected, so iOS would copy nothing.
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.cssText = "position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0;";
  document.body.append(el);
  let ok = false;
  try {
    el.select();
    el.setSelectionRange(0, text.length);
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  el.remove();
  // Put the reader back where they were: same focus, same selection.
  if (active && document.contains(active)) active.focus({ preventScroll: true });
  if (sel) {
    sel.removeAllRanges();
    for (const r of ranges) {
      try { sel.addRange(r); } catch { /* the text it pointed at is gone */ }
    }
  }
  return ok;
}
