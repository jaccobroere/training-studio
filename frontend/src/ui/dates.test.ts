import { describe, expect, it } from "vitest";
import { sinceStamp } from "./dates";

describe("sinceStamp", () => {
  const now = new Date("2026-09-30T19:00:00Z"); // Wed 30 Sep, 21:00 in Amsterdam
  it("shows only the time today, in the athlete's timezone", () => {
    expect(sinceStamp("2026-09-30T07:05:00Z", now)).toBe("09:05");
    expect(sinceStamp("2026-09-29T22:30:00Z", now)).toBe("00:30"); // already Wednesday in Amsterdam
  });
  it("names yesterday and the rest of the week", () => {
    expect(sinceStamp("2026-09-29T08:10:00Z", now)).toBe("Yesterday 10:10");
    expect(sinceStamp("2026-09-26T16:30:00Z", now)).toBe("Sat 18:30");
  });
  it("falls back to a date, with the year only when it differs", () => {
    expect(sinceStamp("2026-09-20T10:00:00Z", now)).toBe("20 Sep");
    expect(sinceStamp("2025-12-31T10:00:00Z", now)).toBe("31 Dec 2025");
  });
});
