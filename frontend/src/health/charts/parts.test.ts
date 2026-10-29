import { describe, expect, it } from "vitest";
import { hms, mmss, paceStr } from "./parts";

describe("time and pace formatting", () => {
  it("rounds once, so seconds never print as 60", () => {
    expect(paceStr(359.6)).toBe("6:00");
    expect(paceStr(299.4)).toBe("4:59");
    expect(mmss(359.6)).toBe("6:00");
    expect(hms(59.6)).toBe("1:00");
    expect(hms(3599.7)).toBe("1:00:00");
    expect(hms(83.4)).toBe("1:23");
  });
  it("shows a dash for nothing at all", () => {
    expect(paceStr(null)).toBe("—");
    expect(paceStr(undefined)).toBe("—");
    expect(paceStr(0)).toBe("—");
    expect(mmss(null)).toBe("—");
    expect(mmss(0)).toBe("0:00");
    expect(hms(null)).toBe("—");
  });
});
