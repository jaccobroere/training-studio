import { describe, expect, it } from "vitest";
import { lineDiff } from "./diff";

describe("lineDiff", () => {
  it("marks added and removed lines", () => {
    const d = lineDiff("a\nb\nc", "a\nc\nd");
    expect(d.map((l) => `${l.t}:${l.s}`)).toEqual(["same:a", "del:b", "same:c", "add:d"]);
  });
});
