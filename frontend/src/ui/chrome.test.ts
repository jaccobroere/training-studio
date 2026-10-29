import { describe, expect, it } from "vitest";
import { nextHide, settleHide } from "./chrome";

describe("scroll chrome", () => {
  it("slides the bar with the scroll, within its height", () => {
    expect(nextHide(0, 20, 200, 60)).toBe(20);
    expect(nextHide(50, 30, 400, 60)).toBe(60);
    expect(nextHide(60, -15, 400, 60)).toBe(45);
    expect(nextHide(10, -40, 400, 60)).toBe(0);
  });
  it("never hides more than the content has moved", () => {
    expect(nextHide(0, 40, 25, 60)).toBe(25);
    expect(nextHide(60, -5, 10, 60)).toBe(10);
    expect(nextHide(30, 5, -8, 60)).toBe(0);
  });
  it("settles a half-shown bar fully in or out", () => {
    expect(settleHide(20, 300, 60)).toBe(0);
    expect(settleHide(40, 300, 60)).toBe(60);
    expect(settleHide(40, 50, 60)).toBe(0);
    expect(settleHide(60, 300, 60)).toBe(60);
    expect(settleHide(0, 300, 60)).toBe(0);
  });
});
