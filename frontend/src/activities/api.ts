import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ActivitiesData, ActivityDetail, ActivityStats, BestsData } from "../health/types";

export interface ActivityAnalysis { activity: ActivityDetail | null; stats: ActivityStats | null }

/** The list's period: the last `days`, or between two dates (inclusive). */
export type Period = { days: number } | { start: string; end: string };

const opts = { staleTime: 60_000, placeholderData: <T,>(prev: T | undefined) => prev };

export const useActivities = (period: Period, type: string | null) =>
  useQuery({ queryKey: ["health", "activities", period, type], ...opts,
    queryFn: () => api<ActivitiesData>(`/api/health/activities?${"days" in period ? `days=${period.days}` : `start=${period.start}&end=${period.end}`}&limit=500${type ? `&type=${encodeURIComponent(type)}` : ""}`) });

/** One activity analysed (stream + stats); without an id, the latest run/ride/skate/walk with a stream. */
export const useActivityStats = (activityId: string | null) =>
  useQuery({ queryKey: ["health", "activity", activityId], staleTime: 5 * 60_000,
    queryFn: () => api<ActivityAnalysis>(`/api/health/activity${activityId ? `/${encodeURIComponent(activityId)}` : ""}?points=1500`) });

export const useBests = (type: string | null, days: number) =>
  useQuery({ queryKey: ["health", "bests", type, days], enabled: !!type, ...opts,
    queryFn: () => api<BestsData>(`/api/health/bests?type=${encodeURIComponent(type!)}&days=${Math.max(7, days)}`) });
