import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { WorkoutType } from "../api/types";
import { readPref, writePref } from "./prefs";

/** What a new workout starts from (date null + week_monday = "no day yet"). */
export interface WorkoutSeed {
  date: string | null;
  week_monday: string;
  type?: WorkoutType;
  repeat?: boolean;
  from_saved?: string;
}

/** The one right-hand slot: chat, the workout editor or the log sheet. The editor and log
 * stack on the chat; closing them returns to the chat if it was open. */
export type DockView =
  | { kind: "console" }
  | { kind: "editor"; id?: string; seed?: WorkoutSeed; nonce?: number }
  | { kind: "log"; workoutId?: string; activityId?: string; date?: string; nonce?: number };

interface DockCtx {
  view: DockView | null;
  consoleOpen: boolean;
  width: number;
  open: (v: DockView) => void;
  close: () => void;
  toggleConsole: () => void;
  setWidth: (w: number) => void;
}

const Ctx = createContext<DockCtx | null>(null);
export function useDock(): DockCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("DockProvider missing");
  return c;
}

let seq = 0;
/** Where focus returns when a panel closes (the row or key that opened it). */
let opener: HTMLElement | null = null;

export function DockProvider({ children }: { children: ReactNode }) {
  const [consoleOpen, setConsoleOpen] = useState<boolean>(() => readPref("console.open", false));
  const [overlay, setOverlay] = useState<DockView | null>(null);
  const [width, setW] = useState<number>(() => readPref("dock.width", 440));

  const view: DockView | null = useMemo(() => overlay ?? (consoleOpen ? { kind: "console" } : null), [overlay, consoleOpen]);
  const open = useCallback((v: DockView) => {
    const a = document.activeElement;
    if (a instanceof HTMLElement && !a.closest(".dock, .sheet, .overlay")) opener = a;
    if (v.kind === "console") {
      setOverlay(null);
      setConsoleOpen(true);
      writePref("console.open", true);
    } else setOverlay({ ...v, nonce: ++seq });
  }, []);
  const close = useCallback(() => {
    setOverlay((o) => {
      if (!o) {
        setConsoleOpen(false);
        writePref("console.open", false);
      }
      return null;
    });
    const back = opener;
    requestAnimationFrame(() => { if (back?.isConnected) back.focus({ preventScroll: true }); });
  }, []);
  const toggleConsole = useCallback(() => {
    setOverlay(null);
    setConsoleOpen((o) => {
      writePref("console.open", !o);
      return !o;
    });
  }, []);
  const setWidth = useCallback((w: number) => {
    const clamped = Math.round(Math.min(620, Math.max(360, w)));
    setW(clamped);
    writePref("dock.width", clamped);
  }, []);
  const value = useMemo(() => ({ view, consoleOpen, width, open, close, toggleConsole, setWidth }),
    [view, consoleOpen, width, open, close, toggleConsole, setWidth]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
