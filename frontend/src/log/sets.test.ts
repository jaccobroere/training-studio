import { describe, expect, it } from "vitest";
import type { Item, LoggedSet } from "../api/types";
import { extraIds, extraMeasure, kgOf, measureOf, plannedCount, prefill, replaceExtraSets, replaceItemSets, repsTarget, setsText, toSet } from "./sets";

const sq: Item = { id: "a", exercise_id: "back-squat", sets: 3, reps: "5–8", load: "80 kg" };
const plank: Item = { id: "b", exercise_id: "plank", sets: 2, duration_min: 0.5 };

describe("measureOf", () => {
  it("counts reps, holds seconds, leaves continuous work alone", () => {
    expect(measureOf(sq)).toBe("reps");
    expect(measureOf(plank)).toBe("secs");
    expect(measureOf({ exercise_id: "easy-run", distance_km: 8 })).toBeNull();
    expect(measureOf({ exercise_id: "handstand", duration_min: 12 })).toBeNull();
    expect(measureOf({ exercise_id: "dead-hang", sets: 3 }, "time")).toBe("secs");
    expect(measureOf({ exercise_id: "pull-up", sets: 3 })).toBe("reps");
    expect(measureOf({ exercise_id: "row", sets: 3 }, "distance")).toBeNull();
    expect(measureOf({ exercise_id: "anything" })).toBeNull();
  });
});

describe("plan targets", () => {
  it("reads the low end of a rep range and plain kilos", () => {
    expect(repsTarget("5–8/leg")).toBe(5);
    expect(repsTarget("12")).toBe(12);
    expect(repsTarget("AMRAP")).toBeUndefined();
    expect(kgOf("80 kg")).toBe(80);
    expect(kgOf("22,5kg")).toBe(22.5);
    expect(kgOf("BW")).toBeUndefined();
    expect(kgOf("BW+10 kg")).toBeUndefined();
    expect(plannedCount(sq)).toBe(3);
    expect(plannedCount({ exercise_id: "x", reps: "10" })).toBe(1);
  });
});

describe("prefill", () => {
  it("uses the same set of the last session, else the plan", () => {
    expect(prefill(sq, "reps", 0)).toEqual({ reps: 5, kg: 80 });
    expect(prefill(plank, "secs", 1)).toEqual({ secs: 30, kg: undefined });
    const last = [{ reps: 8, kg: 82.5 }, { reps: 7, kg: 82.5 }];
    expect(prefill(sq, "reps", 1, last)).toEqual({ reps: 7, kg: 82.5 });
    expect(prefill(sq, "reps", 3, last)).toEqual({ reps: 7, kg: 82.5 }); // an extra set repeats the last
  });
});

describe("toSet", () => {
  it("stores only what is set and needs a count", () => {
    expect(toSet(sq, "reps", { reps: 8, kg: 80 })).toEqual({ exercise_id: "back-squat", item_id: "a", reps: 8, kg: 80 });
    expect(toSet(sq, "reps", { reps: 10 })).toEqual({ exercise_id: "back-squat", item_id: "a", reps: 10 });
    expect(toSet(sq, "reps", { reps: 10, kg: 0 })).toEqual({ exercise_id: "back-squat", item_id: "a", reps: 10 });
    expect(toSet(plank, "secs", { secs: 45.4 })).toEqual({ exercise_id: "plank", item_id: "b", secs: 45 });
    expect(toSet(sq, "reps", { kg: 80 })).toBeNull();
  });
});

describe("replaceItemSets", () => {
  const all: LoggedSet[] = [
    { exercise_id: "plank", item_id: "b", secs: 30 },
    { exercise_id: "push-up", reps: 20 },
    { exercise_id: "back-squat", item_id: "a", reps: 5, kg: 80 },
  ];
  it("keeps the workout's order and extras at the end", () => {
    const next = replaceItemSets(all, [sq, plank], "a", [{ exercise_id: "back-squat", item_id: "a", reps: 6, kg: 80 }]);
    expect(next.map((s) => s.exercise_id)).toEqual(["back-squat", "plank", "push-up"]);
    expect(next[0].reps).toBe(6);
    expect(replaceItemSets(all, [sq, plank], "b", []).map((s) => s.exercise_id)).toEqual(["back-squat", "push-up"]);
  });
});

describe("setsText", () => {
  it("groups identical sets", () => {
    expect(setsText([{ reps: 8, kg: 60 }, { reps: 8, kg: 60 }, { reps: 8, kg: 60 }])).toBe("3 × 8 · 60 kg");
    expect(setsText([{ reps: 8, kg: 60 }, { reps: 6, kg: 65 }])).toBe("8 × 60 kg, 6 × 65 kg");
    expect(setsText([{ secs: 45 }, { secs: 45 }])).toBe("2 × 45 s");
    expect(setsText([{ reps: 12 }])).toBe("1 × 12");
    expect(setsText([{ reps: 5, kg: 82.5 }, { reps: 5, kg: 82.5 }, { reps: 4, kg: 82.5 }])).toBe("5, 5, 4 · 82.5 kg");
    expect(setsText([{ reps: 10 }, { reps: 8 }])).toBe("10, 8");
    expect(setsText([{ reps: 5 }, { reps: 5 }, { reps: 8, kg: 26 }])).toBe("5 bw, 5 bw, 8 × 26 kg");
    expect(setsText([])).toBe("");
  });
});

describe("exercises added while logging", () => {
  const all: LoggedSet[] = [
    { exercise_id: "back-squat", item_id: "a", reps: 5, kg: 80 },
    { exercise_id: "dips", reps: 8 },
    { exercise_id: "pull-up", reps: 6 },
    { exercise_id: "dips", reps: 7 },
  ];
  it("finds them in first-logged order, planned or not", () => {
    expect(extraIds(all, [sq])).toEqual(["dips", "pull-up"]);
    expect(extraIds(all, [])).toEqual(["back-squat", "dips", "pull-up"]);
    expect(extraIds([{ exercise_id: "x", item_id: "gone", reps: 1 }], [sq])).toEqual(["x"]);
  });
  it("replaces one added exercise's sets and leaves the rest", () => {
    const next = replaceExtraSets(all, [sq], "dips", [{ exercise_id: "dips", reps: 10 }], ["dips", "pull-up"]);
    expect(next).toEqual([all[0], { exercise_id: "dips", reps: 10 }, { exercise_id: "pull-up", reps: 6 }]);
    const added = replaceExtraSets(all, [sq], "row", [{ exercise_id: "row", reps: 12 }], ["dips", "pull-up", "row"]);
    expect(added.at(-1)).toEqual({ exercise_id: "row", reps: 12 });
    expect(replaceExtraSets(all, [sq], "pull-up", [], ["dips", "pull-up"]).map((x) => x.exercise_id)).toEqual(["back-squat", "dips", "dips"]);
  });
  it("holds are timed, the rest counted", () => {
    expect(extraMeasure("time")).toBe("secs");
    expect(extraMeasure("reps")).toBe("reps");
    expect(extraMeasure(undefined)).toBe("reps");
  });
});
