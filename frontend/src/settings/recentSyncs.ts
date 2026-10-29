/** The recent Garmin pulls shown in Settings → Connections. `GET /api/imports` returns every
 * job kind (uploads, backfills, pulls), newest first; the connections view only wants pulls. */
import type { Run } from "./garmin";

export const RECENT_SYNCS = 3;

/** The last `limit` Garmin syncs, newest first. A sync is a persisted `pull` row, so this works
 * for scheduled and manual runs without a new endpoint or storage. */
export function recentSyncs(runs: Run[] | undefined, limit = RECENT_SYNCS): Run[] {
  return [...(runs ?? [])]
    .filter((r) => r.kind === "pull")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
}

/** One word for what happened, kept separate from the raw state so the UI does not leak
 * queue terminology ("done" reads as success here, "partial" still moved data). */
export function syncOutcome(state: string): string {
  if (state === "done") return "Synced";
  if (state === "partial") return "Partial";
  if (state === "failed") return "Failed";
  if (state === "cancelled") return "Cancelled";
  if (state === "running") return "Syncing";
  return "Queued";
}

/** When the sync happened: its finish time, or the start when it is still in flight. */
export function syncTime(run: Run): string {
  return run.finished_at ?? run.created_at;
}

/** "Scheduled sync" / "First sync" / "Sync", matching the import rows on the Data tab. */
export function syncLabel(run: Run): string {
  return run.params.scheduled ? "Scheduled sync" : run.params.first ? "First sync" : "Sync";
}
