import { describe, expect, it } from "vitest";
import { isPrompt, promptText, settlePrompts } from "./prompts";

const T = "# Profile\n\n## Goals\n<!-- What are you training for? -->\n\n## Availability\n<!-- Which days? -->\n";

describe("profile prompts", () => {
  it("recognises prompt lines", () => {
    expect(isPrompt("<!-- Which days? -->")).toBe(true);
    expect(isPrompt("Which days?")).toBe(false);
    expect(promptText("<!-- Which days? -->")).toBe("Which days?");
  });
  it("keeps prompts in untouched sections", () => {
    expect(settlePrompts(T).text).toBe(T);
  });
  it("drops the prompt of a section once it has text, and reports the caret shift", () => {
    const typed = T.replace("<!-- What are you training for? -->\n", "<!-- What are you training for? -->\nM");
    const caret = typed.indexOf("M") + 1;
    const r = settlePrompts(typed, caret);
    expect(r.text).toBe("# Profile\n\n## Goals\nM\n## Availability\n<!-- Which days? -->\n");
    expect(r.shift).toBe("<!-- What are you training for? -->\n".length);
    expect(r.text.slice(0, caret - r.shift)).toBe("# Profile\n\n## Goals\nM");
  });
  it("removes the comment when you type on the prompt line itself", () => {
    const typed = T.replace("<!-- What are you training for? -->", "Ma<!-- What are you training for? -->");
    const caret = typed.indexOf("Ma") + 2;
    const r = settlePrompts(typed, caret);
    expect(r.text).toContain("## Goals\nMa\n");
    expect(r.text).toContain("<!-- Which days? -->");
    expect(r.shift).toBe(0);
  });
});
