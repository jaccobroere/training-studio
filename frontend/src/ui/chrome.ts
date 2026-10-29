import { useEffect, type RefObject } from "react";
import { useLocation } from "react-router";

/** Phone chrome that gets out of the way while reading, the way native apps do it:
 * - the page's top bar (`.page > .strip`) is an overlay that slides off as content moves up and
 *   comes back as soon as it moves down, tied to the scroll itself (Material "enter always", the
 *   Safari/Chrome address bar), then settles fully in or out when scrolling stops;
 * - the tab bar minimises to icons on scroll down and expands on scroll up, at the top and at
 *   the end (iOS 26 tab bar).
 * Elements marked `.chrome-pin` (Health's section tabs) ride with the bar and stay pinned once
 * it has gone. Scrollers in sheets and sideways rows are ignored. */

let holdUntil = 0;
let reveal: (() => void) | null = null;
/** Programmatic scrolls (landing on today, jumping to a section) show the bars and keep them
 * there, so offsets computed with chromeTop() land right. */
export const holdChrome = (ms = 600) => { holdUntil = performance.now() + ms; reveal?.(); };

/** Full height of the page's overlaid bars above `sc`, shown or not (0 on desktop). Use this for
 * offsets that must stay put while the bar slides (anchoring, landing on a row). */
export function chromeTop(sc: HTMLElement): number {
  const page = sc.closest<HTMLElement>(".page");
  const strip = page?.querySelector<HTMLElement>(":scope > .strip");
  if (!page || !strip || getComputedStyle(strip).position !== "absolute") return 0;
  const pin = page.querySelector<HTMLElement>(".chrome-pin");
  return strip.offsetHeight + (pin && pin !== sc && !sc.contains(pin) ? pin.offsetHeight : 0);
}

const SETTLE_MS = 140;

/** The top bar's offset after the content moved by `d` px: tied to the scroll, within [0, H], and
 * never more than the scroll offset itself (so no gap ever opens above the content). */
export const nextHide = (hide: number, d: number, top: number, H: number) =>
  Math.min(Math.max(0, Math.min(H, hide + d)), Math.max(0, top));

/** Where a half-shown bar settles once scrolling stops: back in unless mostly gone and past it. */
export const settleHide = (hide: number, top: number, H: number) =>
  hide > 0 && hide < H ? (hide > H / 2 && top > H ? H : 0) : hide;

export function useScrollChrome(shellRef: RefObject<HTMLElement | null>, enabled: boolean) {
  const { pathname } = useLocation();
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || !enabled) return;
    const last = new WeakMap<Element, number>();
    let hide = 0, down = 0, up = 0, settle = 0;
    let page: HTMLElement | null = null;
    const motion = !matchMedia("(prefers-reduced-motion: reduce)").matches;

    const measure = () => {
      page = shell.querySelector<HTMLElement>(".main-m .page");
      if (!page) return;
      const strip = page.querySelector<HTMLElement>(":scope > .strip");
      const pin = page.querySelector<HTMLElement>(".chrome-pin");
      page.style.setProperty("--top-h", `${strip?.offsetHeight ?? 0}px`);
      page.style.setProperty("--pin-h", `${pin?.offsetHeight ?? 0}px`);
    };
    const tabbar = shell.querySelector<HTMLElement>(".tabbar");
    const measureTabs = () => {
      if (tabbar && !shell.hasAttribute("data-tabs-min")) shell.style.setProperty("--tab-h", `${tabbar.offsetHeight}px`);
    };
    const setHide = (px: number, animate = false) => {
      hide = px;
      if (!page) return;
      page.classList.toggle("chrome-settle", animate && motion);
      page.style.setProperty("--hide", `${px}px`);
    };
    const setMin = (on: boolean) => shell.toggleAttribute("data-tabs-min", on);

    const onScroll = (e: Event) => {
      const t = e.target;
      if (!(t instanceof HTMLElement) || !t.closest(".main-m") || t.closest(".sheet, .sec-nav")) return;
      const top = t.scrollTop;
      const prev = last.get(t) ?? top;
      last.set(t, top);
      const d = top - prev;
      if (!d) return; // sideways
      const room = t.scrollHeight - t.clientHeight;
      if (top < 0 || top > room) return; // iOS rubber-band
      if (performance.now() < holdUntil) return;
      if (!page || !page.contains(t)) measure();
      const H = page?.querySelector<HTMLElement>(":scope > .strip")?.offsetHeight ?? 0;
      if (room < H * 3) { setHide(0); setMin(false); return; } // short pages keep their bars
      // Never uncover a gap above the content: near the top the bar is as visible as the offset allows.
      setHide(nextHide(hide, d, top, H));
      if (d > 0) { up = 0; down += d; if (down > 24 && top > 48) setMin(true); }
      else { down = 0; up -= d; if (up > 12) setMin(false); }
      if (top <= 0 || top >= room - 2) setMin(false);
      clearTimeout(settle);
      settle = window.setTimeout(() => {
        const to = settleHide(hide, t.scrollTop, H);
        if (to !== hide) setHide(to, true);
      }, SETTLE_MS);
    };
    // Keyboard users reaching the bar get it back.
    const onFocus = (e: FocusEvent) => {
      if (e.target instanceof Element && e.target.closest(".page > .strip, .chrome-pin, .tabbar")) { setHide(0, true); setMin(false); }
    };

    reveal = () => { setHide(0, true); setMin(false); };
    measure();
    measureTabs();
    setHide(0);
    setMin(false);
    const ro = new ResizeObserver(() => { measure(); measureTabs(); });
    // The page swaps its bar (Weeks' select mode replaces the strip): watch its direct children too.
    const pageMo = new MutationObserver(() => { measure(); watch(); });
    const watch = () => {
      ro.disconnect();
      pageMo.disconnect();
      if (tabbar) ro.observe(tabbar);
      page?.querySelectorAll(":scope > .strip, .chrome-pin").forEach((el) => ro.observe(el));
      if (page) pageMo.observe(page, { childList: true });
    };
    watch();
    // Pages render their bars after data arrives; re-measure when the page's children change.
    const mo = new MutationObserver(() => { const before = page; measure(); if (page !== before) { setHide(0); watch(); } });
    const main = shell.querySelector(".main-m");
    if (main) mo.observe(main, { childList: true, subtree: false });
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    shell.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      shell.removeEventListener("focusin", onFocus);
      ro.disconnect();
      mo.disconnect();
      pageMo.disconnect();
      clearTimeout(settle);
      reveal = null;
    };
  }, [shellRef, pathname, enabled]);
}
