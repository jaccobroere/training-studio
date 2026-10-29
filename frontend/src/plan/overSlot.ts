import { useSyncExternalStore } from "react";

/** The drop slot under the pointer, kept outside React state: only the two cells whose
 * "is it me?" answer flips re-render, not the whole grid, on every pointer move. */
export function createOverStore() {
  let cur: string | null = null;
  const subs = new Set<() => void>();
  return {
    get: () => cur,
    set(v: string | null) {
      if (v === cur) return;
      cur = v;
      subs.forEach((f) => f());
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => { subs.delete(f); };
    },
  };
}
export type OverStore = ReturnType<typeof createOverStore>;

export function useIsOver(store: OverStore, slot: string): boolean {
  return useSyncExternalStore(store.subscribe, () => store.get() === slot);
}
