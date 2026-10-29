import { describe, expect, it, vi } from "vitest";
import { createOverStore } from "./overSlot";

describe("over store", () => {
  it("notifies only on change and supports unsubscribe", () => {
    const s = createOverStore();
    const f = vi.fn();
    const off = s.subscribe(f);
    s.set("a"); s.set("a"); s.set("b");
    expect(f).toHaveBeenCalledTimes(2);
    expect(s.get()).toBe("b");
    off(); s.set(null);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
