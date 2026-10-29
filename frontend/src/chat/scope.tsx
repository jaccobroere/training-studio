import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { weekRange } from "../ui/dates";

/** What the athlete is looking at. Pages publish it; the chat captures it with every
 * message (so an in-flight turn keeps the scope it was sent from). */
export interface ChatScope {
  page: string;
  monday?: string;
  week_no?: number | null;
  phase?: string | null;
  session?: string;
  /** Weeks view: the visible range (Mondays → last Sunday) and the selected workouts. */
  from?: string;
  to?: string;
  selection?: string;
  /** Activities: the recording on screen (its id). */
  activity?: string;
  label: string;
}

const Ctx = createContext<{ scope: ChatScope; set: (s: ChatScope) => void } | null>(null);

export function ScopeProvider({ children }: { children: ReactNode }) {
  const [scope, set] = useState<ChatScope>({ page: "week", label: "This week" });
  const v = useMemo(() => ({ scope, set }), [scope]);
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}

export function useScope(): ChatScope {
  return useContext(Ctx)?.scope ?? { page: "week", label: "This week" };
}

/** Pages call this to publish their scope. */
export function usePublishScope(scope: ChatScope | null) {
  const ctx = useContext(Ctx);
  const key = JSON.stringify(scope);
  useEffect(() => {
    if (scope && ctx) ctx.set(scope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** "28 Sept – 4 Oct": a week without its year, for chips and readouts. */
const short = (monday: string) => weekRange(monday).replace(/ \d{4}$/, "");

/** The label on a scope chip: the week it was sent from, else the page's own label. */
export function scopeChip(s?: Partial<ChatScope> | null) {
  if (!s) return null;
  return s.monday ? short(s.monday) : (s.label ?? s.page);
}
