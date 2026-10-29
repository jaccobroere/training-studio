import { describe, expect, it } from "vitest";
import { keyTarget, moveById, moveItem, rangeWords } from "./order";

describe("pinned order", () => {
  const l = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it("moves by index and by id", () => {
    expect(moveItem(l, 0, 2).map((x) => x.id)).toEqual(["b", "c", "a"]);
    expect(moveItem(l, 2, -5).map((x) => x.id)).toEqual(["c", "a", "b"]);
    expect(moveItem(l, 1, 1)).toBe(l);
    expect(moveById(l, "c", "a").map((x) => x.id)).toEqual(["c", "a", "b"]);
    expect(moveById(l, "x", "a")).toBe(l);
  });
  it("maps reorder keys", () => {
    expect(keyTarget("ArrowUp", 0, 3)).toBeNull();
    expect(keyTarget("ArrowDown", 0, 3)).toBe(1);
    expect(keyTarget("End", 0, 3)).toBe(2);
    expect(keyTarget("Home", 2, 3)).toBe(0);
    expect(keyTarget("Enter", 1, 3)).toBeNull();
  });
  it("describes ranges", () => {
    expect(rangeWords([{ start: "2026-07-17", end: "2026-10-14" }], "2026-10-14")).toBe("last 90 days");
    expect(rangeWords([{ start: "2026-09-01", end: "2026-09-30" }], "2026-10-14")).toBe("1 Sep – 30 Sep");
  });
});
