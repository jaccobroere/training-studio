import { describe, expect, it } from "vitest";
import { addMonths, fieldDate, monthGrid, parseTime } from "./calendar";

describe("calendar helpers", () => {
  it("builds a Monday-first 6-week grid", () => {
    const g = monthGrid(2026, 9); // October 2026
    expect(g).toHaveLength(42);
    expect(g[0]).toBe("2026-09-28");
    expect(g).toContain("2026-10-31");
  });
  it("adds months, clamping the day", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonths("2026-01-10", -1)).toBe("2025-12-10");
  });
  it("formats dates en-GB without commas", () => {
    expect(fieldDate("2026-10-15")).toBe("Thu 15 Oct 2026");
    expect(fieldDate("2026-10-15", false)).toBe("Thu 15 Oct");
  });
  it("parses 24-hour times leniently", () => {
    expect(parseTime("7:30")).toBe("07:30");
    expect(parseTime("1930")).toBe("19:30");
    expect(parseTime("19.05")).toBe("19:05");
    expect(parseTime("7")).toBe("07:00");
    expect(parseTime("")).toBeNull();
    expect(parseTime("25:00")).toBeUndefined();
    expect(parseTime("7pm")).toBeUndefined();
  });
});
