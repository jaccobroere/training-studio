import { createContext, useContext, useEffect, useState, type ReactNode, type RefObject } from "react";

/** The activity card's responsive inset (`--av-pad`: 16 · 20 · 24 px), read once per card and handed
 * to every chart below it. A canvas chart's grid is in pixels, so the value is read from the computed
 * style rather than repeated as a second set of breakpoints in JavaScript: the CSS stays the one
 * definition of the rhythm, and the plot's grid edges move with the card's padding. */
const Pad = createContext(16);

export const useInset = () => useContext(Pad);

export function InsetProvider({ host, children }: { host: RefObject<HTMLElement | null>; children: ReactNode }) {
  const [px, setPx] = useState(16);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const read = () => {
      const v = Number.parseFloat(getComputedStyle(el).getPropertyValue("--av-pad"));
      if (Number.isFinite(v) && v > 0) setPx((old) => (old === v ? old : v));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [host]);
  return <Pad.Provider value={px}>{children}</Pad.Provider>;
}
