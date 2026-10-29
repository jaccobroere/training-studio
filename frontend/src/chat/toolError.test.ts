import { describe, expect, it } from "vitest";
import { plainToolError, superseded } from "./toolError";

describe("superseded failures", () => {
  const bad = { type: "tool-change", state: "output-error" };
  const good = { type: "tool-change", state: "output-available", output: { ok: true } };
  it("folds a failed card that a later call of the same tool recovered", () => {
    expect(superseded([bad, good], 0)).toBe(true);
    expect(superseded([bad], 0)).toBe(false);
    expect(superseded([bad, { ...good, type: "tool-propose" }], 0)).toBe(false);
    expect(superseded([good, bad], 1)).toBe(false);
  });
});

describe("tool error copy", () => {
  it("never shows a validation dump", () => {
    const dump = '4 validation errors:\n```json\n[ {"type":"missing","loc":["question"]} ]\n```\n\nFix the errors and try again.';
    const out = plainToolError(dump);
    expect(out.text).toBe("The assistant's request was incomplete. Nothing changed; it corrects and retries.");
    expect(out.text).not.toContain("{");
    expect(out.details).toContain("missing");
  });
  it("keeps the details of the readable server message collapsible", () => {
    const msg = "The `change` call was not run (nothing changed): ops[1] has no `op`; give it one of: add_workout, …. Fix the errors and try again.";
    const out = plainToolError(msg);
    expect(out.text).toMatch(/^The assistant's request was incomplete/);
    expect(out.details).toContain("ops[1] has no `op`");
    expect(out.details).not.toContain("Fix the errors");
  });
  it("passes ordinary sentences through and has a fallback", () => {
    expect(plainToolError("No exercise run. Similar: easy-run.").text).toBe("No exercise run. Similar: easy-run.");
    expect(plainToolError("").text).toBe("Step failed. Nothing changed.");
  });
});
