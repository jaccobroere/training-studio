import { describe, expect, it } from "vitest";
import { isoWeek, rangeShort, weekday } from "./dates";

describe("plan dates", () => {
  it("numbers ISO weeks", () => {
    expect(isoWeek("2026-10-12")).toBe(42);
    expect(isoWeek("2026-10-18")).toBe(42);
    expect(isoWeek("2026-01-01")).toBe(1);
    expect(isoWeek("2027-01-01")).toBe(53);
    expect(isoWeek("2024-12-30")).toBe(1);
  });
  it("formats week ranges", () => {
    expect(rangeShort("2026-10-12")).toBe("12–18 Oct");
    expect(rangeShort("2026-09-28")).toBe("28 Sep – 4 Oct");
  });
  it("gives the weekday", () => {
    expect(weekday("2026-10-12")).toBe(0);
    expect(weekday("2026-10-18")).toBe(6);
  });
});
