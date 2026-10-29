import { describe, expect, it } from "vitest";
import { bestLapCell, halfSplit, lapAxis, median, quantile, restsOf, deltaTime, distLabel, indexAt, latLonAt, lapTime, paceAxis, paceOf, pauseText, rollingMean, routeAt, routeGeometry, routeLlAt, routeSegments, scaleBar, signed, sportView, typeOrigin, windowLabel } from "./model";

describe("sportView", () => {
  it("skaters read speed with pace beside it and get the lap and stint tabs", () => {
    const v = sportView("skate");
    expect(v).toMatchObject({ primary: "speed", both: true, lapsAxis: "speed" });
    expect(v.tabs).toEqual(["overview", "laps", "stints", "efforts"]);
    expect(v.laps[0]).toBe("d400");
  });
  it("runners read pace, riders speed; others get a plain view", () => {
    expect(sportView("run").primary).toBe("pace");
    expect(sportView("ride")).toMatchObject({ primary: "speed", both: false, lapsAxis: null });
    expect(sportView("ride").laps[0]).toBe("d5000");
    expect(sportView("swim").tabs).toEqual(["overview", "laps"]);
  });
});

describe("lapAxis", () => {
  it("keeps the skating laps chart on km/h whatever the lap source", () => {
    // The server compares fixed and gate laps by time and device/stint laps by speed; a skating
    // chart must not flip its y-axis when the source changes.
    expect(lapAxis(sportView("skate"), "time")).toBe("speed");
    expect(lapAxis(sportView("skate"), "speed")).toBe("speed");
  });
  it("leaves the other sports on the server's comparison for that source", () => {
    expect(lapAxis(sportView("run"), "time")).toBe("time");
    expect(lapAxis(sportView("run"), "speed")).toBe("speed");
    expect(lapAxis(sportView("ride"), "time")).toBe("time");
    expect(lapAxis(sportView("ride"), "speed")).toBe("speed");
  });
});

describe("formatting", () => {
  it("lap times keep tenths", () => {
    expect(lapTime(57.14)).toBe("57.1");
    expect(lapTime(83.45)).toBe("1:23.5");
    expect(lapTime(61)).toBe("1:01.0");
    expect(lapTime(4968.9)).toBe("1:22:49");
    expect(lapTime(59.97)).toBe("1:00.0");
    expect(lapTime(3599.96)).toBe("1:00:00");
    expect(lapTime(null)).toBe("—");
  });
  it("signed deltas use a real minus and drop the sign at zero", () => {
    expect(signed(1.26)).toBe("+1.3");
    expect(signed(-0.44, 1, " s")).toBe("−0.4 s");
    expect(signed(0.01)).toBe("0");
  });
  it("time deltas switch to minutes past 60 s", () => {
    expect(deltaTime(12.34)).toBe("+12.3");
    expect(deltaTime(241.5)).toBe("+4:01.5");
    expect(deltaTime(-75)).toBe("−1:15.0");
  });
  it("labels windows and distances", () => {
    expect([10, 60, 300, 3600].map(windowLabel)).toEqual(["10 s", "1 min", "5 min", "1 h"]);
    expect([400, 1000, 21097.5, 40000].map(distLabel)).toEqual(["400 m", "1 km", "Half", "40 km"]);
  });
  it("pace is undefined when standing", () => {
    expect(paceOf(4)).toBe(250);
    expect(paceOf(0.2)).toBeNull();
  });
});

describe("rests", () => {
  it("are the gaps before each block that follow a stop of a minute or more", () => {
    const st = { lapsets: { blocks: [{ start_s: 0, rest_before_s: 0 }, { start_s: 759, rest_before_s: 232 }, { start_s: 1145, rest_before_s: 30 }] } };
    expect(restsOf(st)).toEqual([[527, 759]]);
  });
});

describe("bestLapCell", () => {
  const best = { n: 28, time_s: 83.44, speed_kmh: 17.26 };
  it("a timed best carries no unit, so the lap number is a note below it", () => {
    // The reported case: "lap 28" must never sit in the unit slot behind a time.
    expect(bestLapCell("time", best)).toEqual({ value: "1:23.4", unit: "", note: "lap 28" });
  });
  it("a speed best carries km/h inline and the lap number as a note", () => {
    expect(bestLapCell("speed", best)).toEqual({ value: "17.3", unit: "km/h", note: "lap 28" });
  });
  it("has nothing to show without a best lap", () => {
    expect(bestLapCell("speed", undefined)).toEqual({ value: "—", unit: "", note: "" });
  });
});

describe("cursor lookups", () => {
  it("indexAt finds the last sample at or before t on irregular times", () => {
    const ts = [0, 1, 3, 4, 8];
    expect([-1, 0, 2, 3.5, 7.9, 100].map((t) => indexAt(ts, t))).toEqual([0, 0, 1, 2, 3, 4]);
    expect(indexAt([], 3)).toBe(-1);
  });
  it("routeAt picks the point nearest in time", () => {
    const pts: [number, number, number][] = [[0, 0, 0], [10, 0, 5], [20, 0, 10]];
    expect(routeAt(pts, 6)).toEqual([10, 0]);
    expect(routeAt(pts, 9)).toEqual([20, 0]);
    expect(routeAt([], 1)).toBeNull();
  });
});

describe("route geometry", () => {
  it("keeps equal scale, puts north up and breaks the line across a pause", () => {
    const pts: [number, number, number][] = [[0, 0, 0], [100, 0, 10], [100, 50, 200], [0, 50, 210]];
    const g = routeGeometry(pts, [0, 0, 100, 50], 220, 120, 10);
    expect(g.scale).toBeCloseTo(2);
    expect(g.map(0, 0)).toEqual([10, 110]);
    expect(g.map(100, 50)).toEqual([210, 10]);
    expect(g.d.match(/M/g)?.length).toBe(2);
  });
  it("reports the pause it broke the line at, so it can be drawn as one", () => {
    const pts: [number, number, number][] = [[0, 0, 0], [100, 0, 10], [100, 50, 200], [0, 50, 210]];
    const g = routeGeometry(pts, [0, 0, 100, 50], 220, 120, 10);
    expect(g.gaps).toHaveLength(1);
    expect(g.gaps[0]).toMatchObject({ ax: 210, ay: 110, bx: 210, by: 10, secs: 190 });
    expect(g.gaps[0].secs).toBe(190); // 10 s → 200 s: not recorded, never interpolated
    expect(pauseText(190)).toBe("Recording pause · 3 min");
    expect(pauseText(121)).toBe("Recording pause · 2 min");
    expect(pauseText(3900)).toBe("Recording pause · 1.1 h");
  });
  it("splits the trace into stretches with the pause before each", () => {
    const pts: [number, number, number][] = [[0, 0, 0], [100, 0, 10], [100, 50, 200], [0, 50, 210]];
    expect(routeSegments(pts)).toEqual([
      { i0: 0, i1: 1, gapBefore: null },
      { i0: 2, i1: 3, gapBefore: 190 },
    ]);
    expect(routeSegments([])).toEqual([]);
  });
  it("scale bar is a round length that fits", () => {
    expect(scaleBar(0.5, 90)).toBe(100);
    expect(scaleBar(0.01, 90)).toBe(5000);
  });
});

describe("map coordinates", () => {
  it("ll follows the same index as the points", () => {
    const pts: [number, number, number][] = [[0, 0, 0], [10, 0, 5], [20, 0, 10]];
    const ll: [number, number][] = [[52, 5], [52.0001, 5], [52.0002, 5]];
    expect(routeLlAt(pts, ll, 6)).toEqual([52.0001, 5]);
    expect(routeLlAt(pts, ll, 9)).toEqual([52.0002, 5]);
    expect(routeLlAt(pts, ll, 100)).toEqual([52.0002, 5]);
    expect(routeLlAt(pts, ll, -5)).toEqual([52, 5]);
    expect(routeLlAt([], [], 1)).toBeNull();
    expect(routeLlAt(pts, ll.slice(0, 2), 1)).toBeNull(); // misaligned: no guess
  });
  it("a metre offset maps back to degrees around the route centre", () => {
    const [la, lo] = latLonAt(1000, 0, [52, 5]);
    expect(la).toBe(52);
    expect(lo).toBeCloseTo(5 + 1000 / (111_195 * Math.cos((52 * Math.PI) / 180)), 6);
    const [n] = latLonAt(0, 1000, [52, 5]);
    expect(n).toBeCloseTo(52 + 1000 / 111_195, 6);
  });
});

describe("display smoothing and axes", () => {
  it("rolling mean is by time, not by sample count", () => {
    const out = rollingMean([0, 1, 2, 10, 11], [1, 2, 3, 10, null], 2);
    expect(out).toEqual([1, 1.5, 2, 10, 10]);
  });
  it("pace axis clips stops and rounds to whole steps", () => {
    const ax = paceAxis([300, 305, 310, 900, null]);
    expect(ax.min % ax.step).toBe(0);
    expect(ax.max).toBeLessThanOrEqual(480);
    expect(ax.min).toBeLessThanOrEqual(290);
  });
});

describe("median", () => {
  it("takes the middle, or the mean of the two middle values", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
  it("skips missing values and is null when none are left", () => {
    expect(median([null, 5, undefined])).toBe(5);
    expect(median([])).toBeNull();
  });
});

describe("quantile", () => {
  it("interpolates between the two nearest values", () => {
    expect(quantile([10, 20, 30, 40, 50], 0.5)).toBe(30);
    expect(quantile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(quantile([10, 20, 30, 40], 0.9)).toBeCloseTo(37);
  });
  it("caps a lap-time axis: the 9th decile of a set with one slow lap stays near the cluster", () => {
    const laps = [142, 145, 148, 150, 151, 152, 153, 154, 155, 156, 158, 160, 162, 164, 166, 168, 190, 196];
    expect(quantile(laps, 0.9)).toBeLessThan(180);
    expect(quantile(laps, 0.9)).toBeGreaterThan(168);
  });
  it("returns NaN on an empty set", () => {
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
  });
});

describe("halfSplit", () => {
  it("is negative when the second half is smaller (faster laps)", () => {
    expect(halfSplit([70, 69, 68, 67])).toBe(-2);
    expect(halfSplit([60, 60, 99, 62, 62])).toBe(2);
  });
  it("needs four values", () => {
    expect(halfSplit([60, 61, 62])).toBeNull();
  });
});

describe("typeOrigin", () => {
  const label = (t: string) => t[0].toUpperCase() + t.slice(1);
  it("names the device's type when the athlete overrode it", () => {
    expect(typeOrigin({ type_override: "skate", device_type: "other" }, label)).toBe("Set by you · Garmin says Other");
    expect(typeOrigin({ type_override: "skate" }, label)).toBe("Set by you");
  });
  it("is null when nothing was overridden", () => {
    expect(typeOrigin({ type_override: null, device_type: "run" }, label)).toBeNull();
  });
});
