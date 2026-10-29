import { describe, expect, it } from "vitest";
import { clock, labelEvery, sleepRange } from "./sleepScale";

const n = (bed: number | null, wake: number | null) => ({ bed, wake });
const range = (ns: ReturnType<typeof n>[]) => { const s = sleepRange(ns); return [s.min, s.max]; };

describe("sleepRange", () => {
  it("keeps the usual 20:00 → 10:00 window for ordinary nights", () => {
    expect(sleepRange([n(-1, 7), n(1.5, 8.4)])).toEqual({ min: -4, max: 10, interval: 2 });
  });
  it("keeps the window when there is no data at all", () => {
    expect(range([])).toEqual([-4, 10]);
    expect(range([n(null, null)])).toEqual([-4, 10]);
  });
  it("widens in 2-hour steps for a lie-in past 10:00", () => {
    expect(range([n(2, 10.25)])).toEqual([-4, 12]);
    expect(range([n(2, 12)])).toEqual([-4, 12]);
  });
  it("widens for an early night before 20:00", () => {
    expect(range([n(-4.5, 6)])).toEqual([-6, 10]);
  });
  it("never goes past noon before → 18:00, and thins the ticks when that wide", () => {
    expect(sleepRange([n(-20, 23)])).toEqual({ min: -12, max: 18, interval: 4 });
  });
  it("lets one odd night in a year be clipped instead of squashing the rest", () => {
    const year = Array.from({ length: 365 }, (_, i) => (i === 100 ? n(-20, 23) : n(1, 8)));
    expect(range(year)).toEqual([-4, 10]);
  });
  it("still widens when lie-ins are a habit, not an outlier", () => {
    const weeks = Array.from({ length: 84 }, (_, i) => (i % 7 === 6 ? n(2, 11.5) : n(1, 8)));
    expect(range(weeks)).toEqual([-4, 12]);
  });
  it("ignores non-finite values", () => {
    expect(range([n(NaN, Infinity)])).toEqual([-4, 10]);
  });
});

describe("labelEvery", () => {
  it("shows every label when they fit", () => expect(labelEvery(8, 10)).toBe(0));
  it("shows every third day over four weeks", () => expect(labelEvery(28, 10)).toBe(2));
  it("thins a year to about ten labels", () => expect(labelEvery(365, 10)).toBe(36));
  it("never goes negative", () => expect(labelEvery(0, 10)).toBe(0));
});

describe("clock", () => {
  it("formats hours around midnight", () => {
    expect(clock(-0.75)).toBe("23:15");
    expect(clock(8.5)).toBe("08:30");
    expect(clock(-4)).toBe("20:00");
    expect(clock(24)).toBe("00:00");
    expect(clock(null)).toBe("—");
  });
  it("rounds to whole minutes without ever showing :60", () => {
    expect(clock(1.999)).toBe("02:00");
    expect(clock(-0.001)).toBe("00:00");
  });
});
