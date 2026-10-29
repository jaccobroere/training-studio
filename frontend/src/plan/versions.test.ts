import { describe, expect, it } from "vitest";
import type { WeekView, Workout } from "../api/types";
import { moveInWeek, patchInWeek } from "./api";
import { bump, lockKeys, Serial, Versions } from "./versions";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Serial", () => {
  it("runs tasks sharing a key one after another, in order", async () => {
    const s = new Serial();
    const log: string[] = [];
    let release!: () => void;
    const a = s.run(["workout:1"], async () => { log.push("a0"); await new Promise<void>((r) => (release = r)); log.push("a1"); });
    const b = s.run(["workout:1"], async () => { log.push("b"); });
    await tick();
    expect(log).toEqual(["a0"]);
    release();
    await Promise.all([a, b]);
    expect(log).toEqual(["a0", "a1", "b"]);
  });
  it("lets unrelated keys run in parallel and survives a failing predecessor", async () => {
    const s = new Serial();
    const log: string[] = [];
    const a = s.run(["workout:1"], async () => { throw new Error("boom"); });
    const b = s.run(["workout:1"], async () => { log.push("b"); });
    const c = s.run(["workout:2"], async () => { log.push("c"); });
    await expect(a).rejects.toThrow("boom");
    await Promise.all([b, c]);
    expect(log.sort()).toEqual(["b", "c"]);
    await tick();
    expect(s.busy("workout:1")).toBe(false);
  });
});

describe("Versions", () => {
  const res = (key: string, version: number) => ({ diffs: [{ key, kind: "updated" as const, before: null, after: { version }, fields: [] }] });
  it("swaps a stale version for the one our earlier write produced", () => {
    const v = new Versions();
    const first = v.mark();
    const second = v.mark();
    v.learn({ "workout:1": 3 }, res("workout:1", 4));
    expect(v.resolve({ "workout:1": 3 }, first)).toEqual({ "workout:1": 4 });
    expect(v.resolve({ "workout:1": 3 }, second)).toEqual({ "workout:1": 4 });
  });
  it("keeps versions read after the write finished (so external edits still 409)", () => {
    const v = new Versions();
    v.learn({ "workout:1": 3 }, res("workout:1", 4));
    const later = v.mark();
    expect(v.resolve({ "workout:1": 9 }, later)).toEqual({ "workout:1": 9 });
  });
  it("forgets deleted rows and leaves unknown keys alone", () => {
    const v = new Versions();
    const s = v.mark();
    v.learn({}, { diffs: [{ key: "workout:1", kind: "deleted", before: { version: 1 }, after: null, fields: [] }] });
    expect(v.resolve({ "workout:1": 1, "workout:2": 5 }, s)).toEqual({ "workout:1": 1, "workout:2": 5 });
  });
});

describe("lockKeys", () => {
  it("collects expected keys and ids named in ops", () => {
    const k = lockKeys([{ op: "set_tags", ids: ["a", "b"] }, { op: "move_workout", id: "c" }, { op: "update_activity_annotations", id: "x1" }], { "workout:a": 1 });
    expect(k.sort()).toEqual(["activity:x1", "workout:a", "workout:b", "workout:c"]);
  });
});

describe("optimistic patches bump version", () => {
  const w = (id: string, version: number) => ({ id, version, date: "2026-10-12", state: "planned" } as unknown as Workout);
  const wk = { days: [{ date: "2026-10-12", workouts: [w("a", 2), w("b", 5)] }, { date: "2026-10-13", workouts: [] }], tray: [] } as unknown as WeekView;
  it("patchInWeek", () => {
    const out = patchInWeek(wk, "a", { state: "done" });
    expect(out.days[0].workouts[0].version).toBe(3);
    expect(out.days[0].workouts[1].version).toBe(5);
  });
  it("moveInWeek", () => {
    const out = moveInWeek(wk, "a", "2026-10-13");
    expect(out.days[1].workouts[0]).toMatchObject({ id: "a", version: 3 });
  });
  it("bump", () => expect(bump({ version: 1 }).version).toBe(2));
});
