import { describe, expect, it } from "vitest";
import { byTime, content, coreFields, plannedOf, repeatSummary, shownFields, stepSets, toEdItem, toItem, type Draft } from "./model";

describe("editor model", () => {
  it("round-trips an item, keeping its id and dropping empties", () => {
    const it0 = { id: "a1", exercise_id: "back-squat", name: "Back squat", sets: 3, reps: "5", load: "80 kg", note: null, intensity: "" };
    const e = toEdItem(it0);
    expect(e.quick).toBe("3×5 80 kg");
    expect(toItem(e)).toEqual({ id: "a1", exercise_id: "back-squat", sets: 3, reps: "5", load: "80 kg" });
  });
  it("sums planned values × sets", () => {
    const items = [
      toEdItem({ exercise_id: "a", distance_km: 1, sets: 5 }),
      toEdItem({ exercise_id: "b", duration_min: 15 }),
      toEdItem({ exercise_id: "c", duration_min: 10, sets: 3 }),
    ];
    expect(plannedOf(items)).toEqual({ km: 5, min: 45 });
  });
  it("summarises the repeat rule", () => {
    const f = (d: string) => d.slice(5);
    expect(repeatSummary({ on: false, interval: 1, weekdays: [1], until: null }, f)).toBe("Does not repeat");
    expect(repeatSummary({ on: true, interval: 1, weekdays: [3, 1], until: null }, f)).toBe("Weekly on Tue, Thu");
    expect(repeatSummary({ on: true, interval: 2, weekdays: [5], until: "2027-04-04" }, f)).toBe("Every 2 weeks on Sat · until 04-04");
  });
  it("sorts a day by time, untimed after in their order", () => {
    const l = [{ id: "a", position: 0 }, { id: "b", position: 1, time: "18:00" }, { id: "c", position: 2, time: "07:30" }, { id: "d", position: 3 }];
    expect(byTime(l).map((x) => x.id)).toEqual(["c", "b", "a", "d"]);
  });
  it("sends time only when set or changed", () => {
    const d = { title: "X", type: "run", tags: [], notes: "", items: [], media: [], time: null } as unknown as Draft;
    expect("time" in content(d)).toBe(false);
    expect(content({ ...d, time: "19:30" }).time).toBe("19:30");
    expect(content(d, { time: "19:30" }).time).toBe(null);
  });
  it("shows the fields an exercise's measure needs, plus any that hold a value", () => {
    expect(coreFields("reps", "strength")).toEqual(["sets", "reps", "load"]);
    expect(coreFields("distance", "run")).toEqual(["distance_km", "duration_min", "intensity"]);
    expect(coreFields(undefined, "mobility")).toEqual(["sets", "reps", "load"]);
    expect(coreFields(undefined, "ride")).toEqual(["distance_km", "duration_min", "intensity"]);
    expect(shownFields(["sets", "reps", "load"], { distance_km: 2 }, [])).toEqual(["sets", "reps", "load", "distance_km"]);
    expect(shownFields(["sets", "reps"], {}, ["intensity"])).toEqual(["sets", "reps", "intensity"]);
  });
  it("steps sets: the first + lands on 3, − below 1 clears", () => {
    expect(stepSets(null, 1)).toBe(3);
    expect(stepSets(null, -1)).toBeNull();
    expect(stepSets(3, 1)).toBe(4);
    expect(stepSets(1, -1)).toBeNull();
  });
});
