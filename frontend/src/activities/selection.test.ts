import { describe, expect, it } from "vitest";
import type { Stream } from "../health/types";
import { MIN_WINDOW_S, formatWindow, makeWindow, moveWindow, nudgeEdge, parseWindow, sameWindow, windowStats } from "./selection";

describe("makeWindow", () => {
  it("orders the ends and clamps to the recording", () => {
    expect(makeWindow(300, 100, 1000)).toEqual([100, 300]);
    expect(makeWindow(-20, 50, 1000)).toEqual([0, 50]);
    expect(makeWindow(900, 1200, 1000)).toEqual([900, 1000]);
  });
  it("refuses a click-sized window", () => {
    expect(makeWindow(100, 100 + MIN_WINDOW_S - 1, 1000)).toBeNull();
    expect(makeWindow(100, 100 + MIN_WINDOW_S, 1000)).toEqual([100, 105]);
  });
});

describe("moveWindow", () => {
  it("keeps its length and stops at both ends", () => {
    expect(moveWindow([100, 160], 30, 1000)).toEqual([130, 190]);
    expect(moveWindow([100, 160], -500, 1000)).toEqual([0, 60]);
    expect(moveWindow([900, 960], 500, 1000)).toEqual([940, 1000]);
  });
});

describe("nudgeEdge", () => {
  it("moves one edge", () => {
    expect(nudgeEdge([100, 200], 0, 10, 1000)).toEqual([110, 200]);
    expect(nudgeEdge([100, 200], 1, -10, 1000)).toEqual([100, 190]);
  });
  it("never crosses the other edge or leaves the recording", () => {
    expect(nudgeEdge([100, 120], 0, 50, 1000)).toEqual([120 - MIN_WINDOW_S, 120]);
    expect(nudgeEdge([100, 120], 1, -50, 1000)).toEqual([100, 100 + MIN_WINDOW_S]);
    expect(nudgeEdge([10, 990], 1, 50, 1000)).toEqual([10, 1000]);
    expect(nudgeEdge([10, 990], 0, -50, 1000)).toEqual([0, 990]);
  });
});

describe("window in the URL", () => {
  it("round-trips whole seconds", () => {
    expect(formatWindow([120.4, 380.6])).toBe("120-381");
    expect(parseWindow("120-381", 1000)).toEqual([120, 381]);
  });
  it("ignores anything that is not a window", () => {
    expect(parseWindow(null, 1000)).toBeNull();
    expect(parseWindow("abc", 1000)).toBeNull();
    expect(parseWindow("200-202", 1000)).toBeNull();
    expect(parseWindow("-5-90", 1000)).toBeNull();
  });
  it("clamps to the recording", () => {
    expect(parseWindow("900-5000", 1000)).toEqual([900, 1000]);
  });
});

describe("sameWindow", () => {
  it("compares within a second", () => {
    expect(sameWindow([10, 20], [10.4, 19.6])).toBe(true);
    expect(sameWindow([10, 20], [12, 20])).toBe(false);
    expect(sameWindow(null, [1, 2])).toBe(false);
  });
});

describe("windowStats", () => {
  // 1 Hz for 100 s at 8 m/s, HR 120 → 160, a 30 s recording pause after 60 s.
  const t = [...Array(61).keys(), ...Array.from({ length: 40 }, (_, i) => 91 + i)];
  const s: Stream = { t, dist: t.map((x) => (x <= 60 ? x * 8 : 480 + (x - 91) * 8)), hr: t.map((x) => 120 + x / 2.5),
    cad: t.map(() => 180), pow: t.map(() => null) };
  it("is distance over time, with the pause in the time", () => {
    const w = windowStats(s, 0, 60)!;
    expect(w.dt).toBe(60);
    expect(w.dist).toBe(480);
    expect(w.ms).toBe(8);
    expect(w.cad).toBe(180);
    expect(w.pow).toBeNull();
  });
  it("weights heart rate by time and reports the peak", () => {
    const w = windowStats(s, 10, 20)!;
    expect(w.hr).toBeCloseTo(120 + 15 / 2.5 + 0.2, 1); // mean of samples 11..20
    expect(w.hrMax).toBeCloseTo(128, 5);
  });
  it("skips the gap when averaging", () => {
    const w = windowStats(s, 50, 100)!;
    expect(w.hr).not.toBeNull();
    expect(w.dt).toBe(50);
  });
  it("needs at least two samples", () => {
    expect(windowStats(s, 10, 10)).toBeNull();
  });
});
