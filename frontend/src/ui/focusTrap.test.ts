import { describe, expect, it } from "vitest";
import { wrapTarget } from "./focusTrap";

describe("wrapTarget", () => {
  const l = ["a", "b", "c"];
  it("wraps forward from the last and back from the first", () => {
    expect(wrapTarget(l, "c", false)).toBe("a");
    expect(wrapTarget(l, "a", true)).toBe("c");
  });
  it("lets the browser move inside the list", () => {
    expect(wrapTarget(l, "b", false)).toBeNull();
    expect(wrapTarget(l, "b", true)).toBeNull();
  });
  it("pulls focus in from outside", () => {
    expect(wrapTarget(l, "x", false)).toBe("a");
    expect(wrapTarget(l, "x", true)).toBe("c");
  });
  it("handles an empty list", () => expect(wrapTarget([], null, false)).toBeNull());
});
