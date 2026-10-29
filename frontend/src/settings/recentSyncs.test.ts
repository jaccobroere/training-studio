import { describe, expect, it } from "vitest";
import type { Run } from "./garmin";
import { recentSyncs, syncLabel, syncOutcome, syncTime } from "./recentSyncs";

const run = (over: Partial<Run> & { id: string; created_at: string }): Run => ({
  kind: "pull", state: "done", finished_at: null, params: {}, progress: {}, report: {}, ...over,
});

describe("recent syncs", () => {
  it("returns nothing for a missing or empty import list", () => {
    expect(recentSyncs(undefined)).toEqual([]);
    expect(recentSyncs([])).toEqual([]);
  });

  it("keeps only Garmin pulls, not uploads, FIT imports or backfills", () => {
    const runs = [
      run({ id: "pull", created_at: "2026-10-29T08:00:00Z" }),
      run({ id: "upload", kind: "archive", created_at: "2026-10-29T09:00:00Z" }),
      run({ id: "fit", kind: "fit", created_at: "2026-10-29T10:00:00Z" }),
      run({ id: "backfill", kind: "backfill", created_at: "2026-10-29T11:00:00Z" }),
    ];
    expect(recentSyncs(runs).map((r) => r.id)).toEqual(["pull"]);
  });

  it("shows the last three newest first even when the API order is not trusted", () => {
    const runs = [
      run({ id: "old", created_at: "2026-10-20T08:00:00Z" }),
      run({ id: "new", created_at: "2026-10-29T08:00:00Z" }),
      run({ id: "middle", created_at: "2026-10-25T08:00:00Z" }),
      run({ id: "fourth", created_at: "2026-10-24T08:00:00Z" }),
    ];
    expect(recentSyncs(runs).map((r) => r.id)).toEqual(["new", "middle", "fourth"]);
    expect(recentSyncs(runs, 1).map((r) => r.id)).toEqual(["new"]);
  });

  it("shows fewer than three when that is all there is", () => {
    const runs = [run({ id: "a", created_at: "2026-10-29T08:00:00Z" })];
    expect(recentSyncs(runs)).toHaveLength(1);
  });

  it("names the outcome for a sync row", () => {
    expect(syncOutcome("done")).toBe("Synced");
    expect(syncOutcome("failed")).toBe("Failed");
    expect(syncOutcome("partial")).toBe("Partial");
    expect(syncOutcome("cancelled")).toBe("Cancelled");
    expect(syncOutcome("running")).toBe("Syncing");
    expect(syncOutcome("queued")).toBe("Queued");
  });

  it("uses the finish time when present, otherwise the creation time", () => {
    expect(syncTime(run({ id: "a", created_at: "2026-10-29T08:00:00Z", finished_at: "2026-10-29T08:04:00Z" }))).toBe("2026-10-29T08:04:00Z");
    expect(syncTime(run({ id: "b", created_at: "2026-10-29T08:00:00Z" }))).toBe("2026-10-29T08:00:00Z");
  });

  it("labels scheduled, first and manual runs", () => {
    expect(syncLabel(run({ id: "a", created_at: "2026-10-29T08:00:00Z", params: { scheduled: true } }))).toBe("Scheduled sync");
    expect(syncLabel(run({ id: "b", created_at: "2026-10-29T08:00:00Z", params: { first: true } }))).toBe("First sync");
    expect(syncLabel(run({ id: "c", created_at: "2026-10-29T08:00:00Z", params: { manual: true } }))).toBe("Sync");
  });
});
