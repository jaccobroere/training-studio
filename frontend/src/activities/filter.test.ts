import { describe, expect, it } from "vitest";
import type { HealthActivity } from "../health/types";
import { filterParams, firstWithStream, legacyActivityPath, periodOf, readFilters, searchActivities } from "./filter";

const act = (over: Partial<HealthActivity>) => ({ id: "x", name: "Run", sport: "run", local_date: "2026-10-15", has_stream: true, ...over }) as HealthActivity;

describe("readFilters", () => {
  it("falls back to the remembered range", () => {
    expect(readFilters(new URLSearchParams(""), "12w")).toMatchObject({ sport: "", range: "12w", q: "" });
    expect(readFilters(new URLSearchParams("range=bogus"), "1y").range).toBe("1y");
  });
  it("reads a custom period only when both dates are valid and in order", () => {
    expect(readFilters(new URLSearchParams("from=2026-01-01&to=2026-02-01"), "12w")).toMatchObject({ range: "custom", from: "2026-01-01", to: "2026-02-01" });
    expect(readFilters(new URLSearchParams("from=2026-03-01&to=2026-02-01"), "12w").range).toBe("12w");
    expect(readFilters(new URLSearchParams("from=nope&to=2026-02-01"), "12w").from).toBeNull();
  });
});

describe("periodOf", () => {
  it("asks for days on a preset and for dates on a custom period", () => {
    expect(periodOf(readFilters(new URLSearchParams("range=4w"), "12w")).period).toEqual({ days: 28 });
    expect(periodOf(readFilters(new URLSearchParams("from=2026-01-01&to=2026-02-01"), "12w")).period).toEqual({ start: "2026-01-01", end: "2026-02-01" });
  });
});

describe("searchActivities", () => {
  const list = [act({ id: "a", name: "Jaap Eden ice", sport: "skate", type: "skate" }), act({ id: "b", name: "Long run", local_date: "2026-09-01" })];
  it("matches every word against name, type and date", () => {
    expect(searchActivities(list, "jaap ice").map((a) => a.id)).toEqual(["a"]);
    expect(searchActivities(list, "skate").map((a) => a.id)).toEqual(["a"]);
    expect(searchActivities(list, "2026-09").map((a) => a.id)).toEqual(["b"]);
    expect(searchActivities(list, "nothing here")).toEqual([]);
  });
  it("returns the list as it is for an empty search", () => {
    expect(searchActivities(list, "  ")).toBe(list);
  });
});

describe("firstWithStream", () => {
  it("skips summary-only recordings", () => {
    expect(firstWithStream([act({ id: "m", has_stream: false }), act({ id: "s" })])?.id).toBe("s");
    expect(firstWithStream([act({ has_stream: false })])).toBeNull();
  });
});

describe("filterParams", () => {
  it("keeps the filters and drops the view", () => {
    expect(filterParams(new URLSearchParams("sport=run&tab=laps&win=1-9&q=x")).toString()).toBe("sport=run&q=x");
  });
});

describe("legacyActivityPath", () => {
  it("moves the activity into the path and keeps the rest", () => {
    expect(legacyActivityPath("?activity=garmin:42&tab=laps")).toBe("/activities/garmin%3A42?tab=laps");
    expect(legacyActivityPath("?activity=demo:1")).toBe("/activities/demo%3A1");
  });
  it("opens the list when no activity is named", () => {
    expect(legacyActivityPath("")).toBe("/activities");
    expect(legacyActivityPath("?tab=stints")).toBe("/activities?tab=stints");
  });
});
