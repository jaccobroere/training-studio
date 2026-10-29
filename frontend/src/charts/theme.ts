/** ECharts styling derived from the live CSS tokens, so charts follow light/dark exactly
 * like the panels do (DESIGN.md: light chassis → light screens; dark → dark). */
import { useEffect, useState } from "react";

export interface Tok {
  ink: string; ink2: string; ink3: string; grat: string; grat2: string; band: string;
  screen: string; signal: string; face: string; mono: string; sans: string;
}

function readTokens(): Tok {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    ink: v("--s-ink"), ink2: v("--s-ink-2"), ink3: v("--s-ink-3"), grat: v("--grat"), grat2: v("--grat-2"),
    band: v("--s-band"), screen: v("--screen"), signal: v("--signal"), face: v("--face-2"),
    mono: "Geist Mono, ui-monospace, monospace", sans: "Instrument Sans Variable, system-ui, sans-serif",
  };
}

/** Re-read tokens whenever the theme changes (system preference or the in-app toggle). */
export function useTokens(): Tok {
  const [t, setT] = useState<Tok>(() => readTokens());
  useEffect(() => {
    const m = window.matchMedia("(prefers-color-scheme: dark)");
    const upd = () => requestAnimationFrame(() => setT(readTokens()));
    m.addEventListener("change", upd);
    const mo = new MutationObserver(upd);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => { m.removeEventListener("change", upd); mo.disconnect(); };
  }, []);
  return t;
}

export function axisBase(t: Tok) {
  return {
    axisLine: { lineStyle: { color: t.grat } },
    axisTick: { lineStyle: { color: t.grat }, length: 4 },
    axisLabel: { color: t.ink3, fontFamily: t.mono, fontSize: 10.5 },
    splitLine: { lineStyle: { color: t.grat, type: [1, 3] as number[] } },
    nameTextStyle: { color: t.ink3, fontFamily: t.mono, fontSize: 10 },
  };
}

export function baseOption(t: Tok) {
  return {
    animation: false,
    backgroundColor: "transparent",
    textStyle: { fontFamily: t.mono, color: t.ink2 },
    grid: { left: 44, right: 16, top: 14, bottom: 26, containLabel: false },
    tooltip: {
      trigger: "axis" as const, confine: true, backgroundColor: t.face, borderColor: t.grat,
      textStyle: { color: t.ink, fontFamily: t.mono, fontSize: 11 }, extraCssText: "border-radius:3px;box-shadow:none;",
      axisPointer: { type: "line" as const, lineStyle: { color: t.ink2, type: [2, 2] as number[] } },
    },
    aria: { enabled: true, decal: { show: false } },
  };
}

/** Distinct greys + fill patterns per series: never colour-only. */
export const DECALS = [
  { symbol: "rect", dashArrayX: [1, 0], dashArrayY: [1, 0] },
  { symbol: "rect", dashArrayX: [1, 0], dashArrayY: [2, 3], rotation: Math.PI / 4 },
  { symbol: "circle", symbolSize: 0.7, dashArrayX: [[2, 3]], dashArrayY: [3, 3] },
  { symbol: "rect", dashArrayX: [[4, 3]], dashArrayY: [1, 3] },
  { symbol: "rect", dashArrayX: [1, 0], dashArrayY: [4, 2], rotation: -Math.PI / 4 },
];
