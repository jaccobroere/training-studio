/** One owner for the phone viewport.
 *
 * The app is a fixed shell with inner scrollers; the document itself never scrolls. On iOS the
 * on-screen keyboard leaves the layout viewport full height and pans the visual one instead, and
 * Safari can leave the page offset after the keyboard closes (fixed bars then float mid-screen).
 * So: publish the visible box as CSS variables (--vvh height, --vvt top, --kb keyboard inset,
 * [data-kb] while it is open) for sheets to size against, and put the page back at 0 once the
 * keyboard is gone. */
const editable = (el: Element | null) =>
  !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
    || (el as HTMLElement).isContentEditable);

/** Keep the field being typed in visible: scroll its own scroller (never the page) until it
 * clears the keyboard's bar and the sheet's header. */
function reveal(el: Element | null) {
  const vv = window.visualViewport;
  if (!vv || !editable(el)) return;
  const field = el as HTMLElement;
  let sc: HTMLElement | null = field.parentElement;
  while (sc && !(sc.scrollHeight > sc.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
  if (!sc) return;
  const box = sc.getBoundingClientRect();
  const r = field.getBoundingClientRect();
  // iOS puts a ~44px prev/next/done bar above the keyboard; keep a bit of context above and below the field.
  const bottom = Math.min(box.bottom, vv.offsetTop + vv.height - 48);
  const top = Math.max(box.top, vv.offsetTop) + 12;
  // Only when clearly out of range: a few px of slack keeps this from fighting iOS's own scroll-into-view.
  if (r.bottom > bottom + 6) sc.scrollTop += r.bottom - bottom + 24;
  else if (r.top < top - 6) sc.scrollTop -= top - r.top + 24;
}

export function installViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  if (!vv) return;
  let frame = 0;
  const sync = () => {
    frame = 0;
    const open = window.innerHeight - vv.height > 120 && editable(document.activeElement);
    root.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
    root.style.setProperty("--vvt", `${Math.round(vv.offsetTop)}px`);
    root.style.setProperty("--kb", `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`);
    root.toggleAttribute("data-kb", open);
    if (open) reveal(document.activeElement);
    // Not while pinch-zoomed: there the offset is the reader's own panning.
    // Only once nothing editable has focus: while a field does, iOS may still be panning to it.
    if (!editable(document.activeElement) && vv.scale <= 1.01 && (window.scrollY || window.scrollX)) window.scrollTo(0, 0);
  };
  const queue = () => { if (!frame) frame = requestAnimationFrame(sync); };
  vv.addEventListener("resize", queue);
  vv.addEventListener("scroll", queue);
  window.addEventListener("scroll", queue, { passive: true });
  // Focus moving between fields keeps the keyboard up; only settle once nothing editable has it.
  document.addEventListener("focusout", () => setTimeout(queue, 120));
  // The keyboard takes ~250ms to open; once it has, bring the focused field into view (and again when focus moves on).
  document.addEventListener("focusin", (e) => { const t = e.target as Element; setTimeout(() => { queue(); reveal(t); }, 300); });
  sync();
}
