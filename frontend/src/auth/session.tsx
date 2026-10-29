import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { ApiError, SIGNED_OUT_EVENT, api } from "../api/client";

export interface Me {
  id: number; username: string; created_at: string; must_change_password: boolean;
  assistant_consent: boolean; privacy_seen: boolean;
  usage: { used: number; limit: number; resets_at: string; exhausted: boolean };
}
export interface Status { signed_in: boolean; user: Me | null; password_min: number; notice: string }

export const STATUS_KEY = ["auth-status"] as const;

const Ctx = createContext<{ me: Me; refresh: () => void } | null>(null);
export function useMe() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useMe outside a signed-in shell");
  return c;
}

function useAuthStatus() {
  return useQuery({ queryKey: STATUS_KEY, queryFn: () => api<Status>("/api/auth/status"), staleTime: 60_000 });
}

/** A 401 from a data call means the session is gone. Mark the cached status signed out
 *  instead of refetching it: the status route is exactly what disagreed with the data
 *  routes (a stale dev cookie), so a refetch would remount the app and repeat the 401. */
export function markSignedOut(qc: QueryClient): void {
  const prev = qc.getQueryData<Status>(STATUS_KEY);
  if (!prev) return;
  void qc.cancelQueries({ queryKey: STATUS_KEY });
  qc.setQueryData<Status>(STATUS_KEY, { ...prev, signed_in: false, user: null });
}

export function subscribeSignedOut(qc: QueryClient): () => void {
  const onOut = () => markSignedOut(qc);
  window.addEventListener(SIGNED_OUT_EVENT, onOut);
  return () => window.removeEventListener(SIGNED_OUT_EVENT, onOut);
}

/** The status call failed: a 429 names its retry window, a 5xx or a network error is "can't
 *  reach the server", and any other 4xx carries the server's own sentence. */
export function statusError(err: unknown): string {
  if (err instanceof ApiError && err.status === 429) {
    return err.retryAfter
      ? `Too many requests, retry in ${err.retryAfter} seconds.`
      : "Too many requests. Try again in a minute.";
  }
  if (!(err instanceof ApiError) || err.status >= 500) return "Can't reach the server.";
  return err.message;
}

/** Renders `signedIn` for an authenticated user, else the sign-in screen. Any 401 from the API
 * (expired or revoked session) flips back to sign-in without losing the URL. */
export function SessionGate({ signedIn, signedOut, mustChange, privacy }: {
  signedIn: ReactNode; signedOut: (s: Status) => ReactNode; mustChange: (me: Me) => ReactNode; privacy: (me: Me) => ReactNode;
}) {
  const qc = useQueryClient();
  const q = useAuthStatus();
  useEffect(() => subscribeSignedOut(qc), [qc]);
  if (q.isPending) return <div className="boot" aria-busy="true"><div className="mark big"><i /></div></div>;
  if (q.isError) return <div className="boot"><p className="muted">{statusError(q.error)} <button className="key" onClick={() => q.refetch()}>Retry</button></p></div>;
  const s = q.data!;
  if (!s.signed_in || !s.user) return <>{signedOut(s)}</>;
  if (s.user.must_change_password) return <>{mustChange(s.user)}</>;
  if (!s.user.privacy_seen) return <>{privacy(s.user)}</>;
  return <Ctx.Provider value={{ me: s.user, refresh: () => void qc.invalidateQueries({ queryKey: STATUS_KEY }) }}>{signedIn}</Ctx.Provider>;
}
