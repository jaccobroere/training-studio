import { useSyncExternalStore } from "react";

export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Shell breakpoints (SCREENS.md §0): mobile ≤760, tablet 761–1279, desktop ≥1280. The side
 * panel overlays below 1100px and pins as a dock from there (content stays ≥660px). */
const MOBILE = "(max-width: 760px)";
export const PIN_DOCK = "(min-width: 1100px)";
export const useMobile = () => useMedia(MOBILE);
export const usePinnedDock = () => useMedia(PIN_DOCK);
export const useCoarse = () => useMedia("(pointer: coarse)");
