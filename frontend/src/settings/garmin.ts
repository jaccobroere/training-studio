/** The Garmin/import shapes the Settings tabs read. Kept in one place so the connections and
 * data tabs can each own their query without importing each other. */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

export interface Status {
  connected: boolean; token_present: boolean; token_key: boolean; pull_every_h: number; demo_present: boolean;
  state: { auth?: string | null; last_pull?: string | null; last_error?: string | null; connected_at?: string };
  settings: { auto: boolean; interval_h: number }; intervals_h: number[];
  next_pull: string | null; backoff_until: string | null; backfill: Run | null; backfill_max_days: number;
  synced_types: { key: string; label: string; detail: string }[];
  activities: { n: number; first: string | null; last: string | null };
  data_through: string | null;
  coverage: { metric: string; first: string; last: string; n: number; expected: number }[];
}

export interface Run {
  id: string; kind: string; state: string; created_at: string; finished_at: string | null;
  params: { filename?: string; size?: number; manual?: boolean; scheduled?: boolean; first?: boolean; start?: string; end?: string; cursor?: string; resume_at?: string | null };
  progress: { done?: number; total?: number };
  report: { files?: Record<string, number>; records?: Record<string, { new: number; updated: number; same: number }>;
    ranges?: Record<string, [string, string]>; devices?: string[]; errors?: string[]; unsupported?: string[];
    n_errors?: number; n_unsupported?: number; demo?: boolean; autolinked?: string | null };
}

/** When an import or sync finishes, everything that reads recorded data refreshes. Both tabs
 * can start one (Sync now on Connections, an upload on Data), so both use this. */
export function useRefreshOnImportDone(active: Run | undefined) {
  const qc = useQueryClient();
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active) {
      for (const k of ["garmin-status", "inbox", "week", "weeks", "health"]) void qc.invalidateQueries({ queryKey: [k] });
    }
    wasActive.current = !!active;
  }, [active, qc]);
}
