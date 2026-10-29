import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { api, ApiError, newOpId } from "../api/client";
import type { ChangeResult, Exercise, Inbox, SavedWorkout, WeeksRow, WeeksView, WeekView, Workout } from "../api/types";
import { chunkFrom, chunksFor, chunkTo, placeChips } from "./weeksModel";
import { addDays } from "../ui/dates";
import { useToast } from "../ui/toast";
import { bump, lockKeys, Serial, Versions, type Op } from "./versions";

export type { Op };

/** One queue + version memory per tab, shared by every useChange() caller. */
const serial = new Serial();
const versions = new Versions();

const weekKey = (monday: string) => ["week", monday] as const;
const fetchWeek = (monday: string) => api<WeekView>(`/api/week/${monday}`);

export function useToday() {
  return useQuery({ queryKey: ["today"], queryFn: () => api<{ today: string; monday: string; timezone: string }>("/api/today"), staleTime: 60_000 });
}

export function useWeek(monday: string) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: weekKey(monday), queryFn: () => fetchWeek(monday), staleTime: 20_000 });
  // Warm the neighbours so previous / next feel immediate.
  useEffect(() => {
    if (!q.isSuccess) return;
    for (const m of [addDays(monday, -7), addDays(monday, 7)]) {
      void qc.prefetchQuery({ queryKey: weekKey(m), queryFn: () => fetchWeek(m), staleTime: 20_000 });
    }
  }, [q.isSuccess, monday, qc]);
  return q;
}

export const useWorkout = (id: string | undefined) =>
  useQuery({ queryKey: ["workout", id], queryFn: () => api<Workout>(`/api/workouts/${id}`), enabled: !!id });

export const useExercises = () =>
  useQuery({ queryKey: ["exercises"], queryFn: () => api<Exercise[]>("/api/exercises?include_archived=true"), staleTime: 60_000 });

export const useSaved = () =>
  useQuery({ queryKey: ["saved"], queryFn: () => api<SavedWorkout[]>("/api/saved-workouts"), staleTime: 60_000 });

export const useTags = () =>
  useQuery({ queryKey: ["tags"], queryFn: () => api<{ tag: string; n: number }[]>("/api/tags"), staleTime: 60_000 });

export const useInbox = () =>
  useQuery({ queryKey: ["inbox"], queryFn: () => api<Inbox>("/api/inbox"), staleTime: 30_000, refetchInterval: 120_000 });

/** Any change can touch weeks, the inbox, the library and tags; refetch whatever is mounted. */
export function refreshPlan(qc: QueryClient) {
  for (const k of ["week", "weeks", "workout", "inbox", "exercises", "saved", "tags", "series", "profile", "exercise", "activity", "health"]) {
    void qc.invalidateQueries({ queryKey: [k] });
  }
}

export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "stale") return "This changed elsewhere. Reloaded; try again.";
    if (e.code === "conflict") return "Can't undo: something it touched has changed since.";
    if (e.code === "logged") return "It has a logged activity. Unlink or delete the log first.";
    if (e.code === "future") return "An activity can't be in the future.";
    if (e.code === "exercise_not_found") return "That exercise no longer exists.";
    if (e.status >= 500 || e.status === 0) return "Couldn't save. The server didn't respond; nothing changed.";
    return e.message || e.code;
  }
  return "Couldn't reach the server. Nothing was saved.";
}

export function useUndo() {
  const qc = useQueryClient();
  const toast = useToast();
  return useCallback(async (changeId: string) => {
    try {
      const r = await api<ChangeResult>(`/api/changes/${changeId}/undo`, { method: "POST", json: { op_id: newOpId() } });
      refreshPlan(qc);
      toast({ text: "Undone" });
      return r;
    } catch (e) {
      toast({ tone: "error", text: describeError(e) });
      return null;
    }
  }, [qc, toast]);
}

export interface ChangeVars {
  ops: Op[];
  reason?: string;
  expected?: Record<string, number>;
  /** Toast text (defaults to the server's summary); false = no toast. */
  toast?: string | false | ((r: ChangeResult) => string);
  /** Optimistic edit of one cached week while the request runs. */
  optimistic?: { monday: string; apply: (w: WeekView) => WeekView };
  /** Optimistic edits of other cached queries (prefix keys, e.g. ["inbox"]); rolled back on error. */
  patches?: { key: QueryKey; apply?: (d: any) => any; all?: (entries: [QueryKey, any][]) => [QueryKey, any][] }[];
  /** Don't append "· n customised kept" (the toast says what was kept itself). */
  noKept?: boolean;
  /** Error codes the caller shows itself (no error toast). */
  quiet?: string[];
}

/** The one write path: POST /api/changes, then refresh, then a toast with Undo. */
export function useChange() {
  const qc = useQueryClient();
  const toast = useToast();
  const undo = useUndo();
  return useMutation({
    mutationKey: ["change"],
    mutationFn: ({ ops, reason, expected }: ChangeVars) => {
      // Wait for earlier writes to the same rows, then send the versions they produced.
      const since = versions.mark();
      return serial.run(lockKeys(ops, expected), async () => {
        const sent = versions.resolve(expected, since);
        const res = await api<ChangeResult>("/api/changes", { method: "POST", json: { ops, reason: reason ?? "", expected: sent, op_id: newOpId() } });
        versions.learn(sent, res);
        return res;
      });
    },
    onMutate: async (v) => {
      const snaps: [QueryKey, unknown][] = [];
      for (const p of v.patches ?? []) {
        await qc.cancelQueries({ queryKey: p.key });
        const entries = qc.getQueriesData({ queryKey: p.key }).filter(([, d]) => d !== undefined) as [QueryKey, any][];
        snaps.push(...entries);
        const next = p.all ? p.all(entries) : entries.map(([k, d]) => [k, p.apply!(d)] as [QueryKey, any]);
        for (const [k, d] of next) qc.setQueryData(k, d);
      }
      if (!v.optimistic) return { snaps };
      const key = weekKey(v.optimistic.monday);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<WeekView>(key);
      if (prev) qc.setQueryData(key, v.optimistic.apply(prev));
      return { prev, key, snaps };
    },
    onError: (err, v, ctx: any) => {
      if (ctx?.prev) qc.setQueryData(ctx.key, ctx.prev);
      for (const [k, d] of ctx?.snaps ?? []) qc.setQueryData(k, d);
      refreshPlan(qc);
      if (!(err instanceof ApiError && v.quiet?.includes(err.code))) toast({ tone: "error", text: describeError(err) });
    },
    onSuccess: (res, v) => {
      // While more writes are queued, a refetch would briefly undo their optimistic edits; the
      // last one to finish refreshes.
      if (qc.isMutating({ mutationKey: ["change"] }) <= 1) refreshPlan(qc);
      if (v.toast === false || !res.applied || !res.change_id) return;
      const kept = res.kept.length && !v.noKept ? ` · ${res.kept.length} customised kept` : "";
      const text = typeof v.toast === "function" ? v.toast(res) : v.toast ?? res.summary;
      toast({ text: `${text}${kept}`, action: { label: "Undo", run: async () => { await undo(res.change_id!); } } });
    },
  });
}

/** Move a workout inside a cached week (optimistic drag / Move to…). */
export function moveInWeek(w: WeekView, id: string, date: string | null, position?: number): WeekView {
  let moving: Workout | undefined;
  const strip = (list: Workout[]) => list.filter((x) => (x.id === id ? ((moving = x), false) : true));
  const days = w.days.map((d) => ({ ...d, workouts: strip(d.workouts) }));
  const tray = strip(w.tray);
  if (!moving) return w;
  const m = bump({ ...moving, date });
  const put = (list: Workout[]) => {
    const out = [...list];
    out.splice(position ?? out.length, 0, m);
    return out;
  };
  return {
    ...w,
    days: days.map((d) => (d.date === date ? { ...d, workouts: put(d.workouts) } : d)),
    tray: date === null ? put(tray) : tray,
  };
}

export function patchInWeek(w: WeekView, id: string, patch: Partial<Workout>): WeekView {
  const upd = (x: Workout) => (x.id === id ? bump({ ...x, ...patch }) : x);
  return { ...w, days: w.days.map((d) => ({ ...d, workouts: d.workouts.map(upd) })), tray: w.tray.map(upd) };
}

// ---------- Plan → Weeks ----------

const weeksKey = (chunk: number, tag: string | null) => ["weeks", chunk, tag ?? ""] as const;

/** The loaded week rows from `from` to `to` (Mondays), fetched in fixed 8-week chunks so
 * scrolling only ever adds requests. */
export function useWeeksRange(from: string, to: string, tag: string | null) {
  const chunks = chunksFor(from, to);
  const qs = useQueries({
    queries: chunks.map((i) => ({
      queryKey: weeksKey(i, tag),
      queryFn: () => api<WeeksView>(`/api/weeks?from=${chunkFrom(i)}&to=${chunkTo(i)}${tag ? `&tag=${encodeURIComponent(tag)}` : ""}`),
      staleTime: 20_000,
      placeholderData: keepPreviousData,
    })),
  });
  const rows: WeeksRow[] = [];
  for (const q of qs) if (q.data) rows.push(...q.data.weeks);
  rows.sort((a, b) => a.monday.localeCompare(b.monday));
  return {
    rows: rows.filter((r) => r.monday >= from && r.monday <= to),
    today: qs.find((q) => q.data)?.data?.today,
    loading: qs.some((q) => q.isPending),
    error: qs.some((q) => q.isError),
    refetch: () => qs.forEach((q) => void q.refetch()),
  };
}

/** Optimistic patch for every loaded weeks chunk at once (a chip can move between chunks). */
export function weeksMovePatch(moves: Map<string, { date: string | null; week_monday: string }>) {
  return {
    key: ["weeks"] as QueryKey,
    all: (entries: [QueryKey, any][]) => {
      const byTag = new Map<string, [QueryKey, WeeksView][]>();
      for (const e of entries) { const t = String(e[0][2] ?? ""); byTag.set(t, [...(byTag.get(t) ?? []), e as [QueryKey, WeeksView]]); }
      const out: [QueryKey, any][] = [];
      for (const list of byTag.values()) {
        const placed = placeChips(list.flatMap(([, d]) => d.weeks), moves);
        const at = new Map(placed.map((r) => [r.monday, r]));
        for (const [k, d] of list) out.push([k, { ...d, weeks: d.weeks.map((r) => at.get(r.monday) ?? r) }]);
      }
      return out;
    },
  };
}

/** Optimistically drop chips (bulk delete). */
export function weeksRemovePatch(ids: Set<string>) {
  const keep = (l: { id: string }[]) => l.filter((c) => !ids.has(c.id));
  return {
    key: ["weeks"] as QueryKey,
    apply: (d: WeeksView) => ({ ...d, weeks: d.weeks.map((r) => ({ ...r, tray: keep(r.tray), days: r.days.map((x) => ({ ...x, workouts: keep(x.workouts) })) })) }),
  };
}
