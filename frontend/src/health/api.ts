import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Pinned, PinnedRun } from "../chat/types";
import type { DailySeries, EfficiencyData, EnergyData, LoadData, Overview, SleepData, VolumeData } from "./types";

export const RANGES = [
  { key: "4w", label: "4W", days: 28, words: "last 4 weeks" },
  { key: "12w", label: "12W", days: 84, words: "last 12 weeks" },
  { key: "1y", label: "1Y", days: 365, words: "last year" },
] as const;
export const rangeOf = (k: string) => RANGES.find((r) => r.key === k) ?? RANGES[1];

const opts = { staleTime: 60_000, placeholderData: <T,>(prev: T | undefined) => prev };

export const useOverview = (days: number) =>
  useQuery({ queryKey: ["health", "overview", days], queryFn: () => api<Overview>(`/api/health/overview?days=${Math.max(7, days)}`), ...opts });

export const useDaily = (metric: string, days: number) =>
  useQuery({ queryKey: ["health", "daily", metric, days], queryFn: () => api<DailySeries>(`/api/health/daily/${metric}?days=${days}`), ...opts });

export const useSleep = (days: number) =>
  useQuery({ queryKey: ["health", "sleep", days], queryFn: () => api<SleepData>(`/api/health/sleep?days=${days}`), ...opts });

export const useLoad = (days: number) =>
  useQuery({ queryKey: ["health", "load", days], queryFn: () => api<LoadData>(`/api/health/load?days=${Math.max(7, days)}`), ...opts });

export const useEnergy = (days: number) =>
  useQuery({ queryKey: ["health", "energy", days], queryFn: () => api<EnergyData>(`/api/health/energy?days=${Math.max(7, days)}`), ...opts });

export const useVolume = (type: string, days: number) =>
  useQuery({ queryKey: ["health", "volume", type, days], queryFn: () => api<VolumeData>(`/api/health/volume?type=${encodeURIComponent(type)}&days=${Math.max(7, days)}`), ...opts });

export const useEfficiency = (type: string, days: number) =>
  useQuery({ queryKey: ["health", "efficiency", type, days], ...opts,
    queryFn: () => api<EfficiencyData>(`/api/health/efficiency?type=${encodeURIComponent(type)}&days=${Math.max(28, days)}`) });

export const usePinned = () => useQuery({ queryKey: ["pinned"], queryFn: () => api<Pinned[]>("/api/pinned"), staleTime: 30_000 });

/** A pin's result on current data. The server caches by (code, data), so reopening is cheap;
 * `enabled` waits until the card is on screen. */
export const usePinnedRun = (p: Pinned, enabled: boolean) =>
  useQuery({ queryKey: ["pinned", "run", p.id, p.version], enabled, staleTime: 5 * 60_000, refetchOnWindowFocus: false,
    queryFn: () => api<PinnedRun>(`/api/pinned/${p.id}/run`) });
