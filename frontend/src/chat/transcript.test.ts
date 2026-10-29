import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { transcriptOf } from "./transcript";

let n = 0;
const msg = (role: "user" | "assistant", parts: any[], metadata?: any): UIMessage =>
  ({ id: `m${++n}`, role, parts, ...(metadata ? { metadata } : {}) }) as UIMessage;

const text = (t: string) => ({ type: "text", text: t });
const tool = (name: string, output: any, state = "output-available") => ({ type: `tool-${name}`, toolCallId: `${name}-${++n}`, state, output });
const out = (t: string) => ({ ok: true, summary: t });

describe("transcript", () => {
  it("opens with the title, then each speaker in order", () => {
    const md = transcriptOf([
      msg("user", [text("How is my HRV?")]),
      msg("assistant", [text("Your HRV is up 4 ms on last week.")]),
    ], "HRV check");
    expect(md).toBe([
      "# HRV check",
      "## You\n\nHow is my HRV?",
      "## Assistant\n\nYour HRV is up 4 ms on last week.",
    ].join("\n\n") + "\n");
  });

  it("keeps every text part of one assistant turn, a paragraph apart", () => {
    const md = transcriptOf([
      msg("user", [text("What did I run?")]),
      msg("assistant", [text("This week:"), text("42 km across 4 runs.")]),
    ], "Runs");
    expect(md).toContain("## Assistant\n\nThis week:\n\n42 km across 4 runs.");
  });

  it("gives one assistant turn one heading, even across several messages", () => {
    const md = transcriptOf([
      msg("user", [text("Ease Sunday.")]),
      msg("assistant", [text("I can make it 40 easy minutes.")]),
      msg("assistant", [text("Done."), tool("change", { ok: true, saved: true, summary: "Moved Long run · Sun → Sat" })]),
      msg("user", [text("Thanks")]),
    ], "Sunday");
    expect(md.match(/## Assistant/g)).toHaveLength(1);
    expect(md).toContain("## Assistant\n\nI can make it 40 easy minutes.\n\nDone.\n\n_Moved Long run · Sun → Sat_\n\n## You\n\nThanks");
  });

  it("lists attachments under the message that sent them", () => {
    const md = transcriptOf([
      msg("user", [text("Compare these.")], { attachments: [
        { id: "a", filename: "a.png", media_type: "image/png", url: "/a" },
        { id: "b", filename: "b.pdf", media_type: "application/pdf", url: "/b" },
      ] }),
      msg("assistant", [text("Both show a steady week.")]),
    ], "Attachments");
    expect(md).toContain("Attached: a.png, b.pdf");
    expect(md.indexOf("Attached: a.png, b.pdf")).toBeGreaterThan(md.indexOf("Compare these."));
  });

  it("summarises card tools in one italic line and never dumps their output", () => {
    const md = transcriptOf([
      msg("user", [text("Add three runs next week.")]),
      msg("assistant", [
        text("Done."),
        tool("get_calendar", { ok: true, summary: "Your plan", days: [{ id: "x", title: "Tempo" }] }),
        tool("change", { ok: true, saved: true, change_id: "r42", summary: "Added 3 workouts to W43", lines: ["Added Easy run · Mon"] }),
      ]),
    ], "Plan");
    expect(md).toContain("## Assistant\n\nDone.\n\n_Added 3 workouts to W43_");
    expect(md).not.toContain("get_calendar");
    expect(md).not.toContain("change_id");
    expect(md).not.toContain("Tempo");
  });

  it("names a card by its title, and says plainly when one failed", () => {
    const md = transcriptOf([
      msg("user", [text("Chart my sleep.")]),
      msg("assistant", [
        tool("run_analysis", { ok: true, title: "Sleep vs training load" }),
        tool("change", { ok: false, detail: "The plan changed since you asked." }),
      ]),
    ], "Sleep");
    expect(md).toContain("_Sleep vs training load_");
    expect(md).toContain("_The plan changed since you asked._");
  });

  it("appends the turn's sources once, on its last message", () => {
    const md = transcriptOf([
      msg("user", [text("What is HRV?")]),
      msg("assistant", [
        text("First, a search."),
        tool("web_search", { ok: true, results: [
          { n: 1, title: "Heart rate variability", url: "https://example.com/hrv", accessed: "2026-10-20" },
          { n: 2, title: "Recovery basics", url: "https://example.org/recovery", accessed: "2026-10-20" },
        ] }),
      ]),
      msg("assistant", [text("It is the variation between beats [1].")]),
    ], "HRV");
    expect(md.match(/Sources:/g)).toHaveLength(1);
    expect(md).toContain("Sources:\n- [Heart rate variability](https://example.com/hrv)\n- [Recovery basics](https://example.org/recovery)");
    expect(md.indexOf("Sources:")).toBeGreaterThan(md.indexOf("variation between beats"));
  });

  it("leaves out a failure the model recovered from later in the turn", () => {
    // Same tool, a later call that landed: the thread folds the failure into a quiet step row.
    const md = transcriptOf([
      msg("user", [text("Move Sunday.")]),
      msg("assistant", [
        text("Trying."),
        tool("change", { ok: false, detail: "The plan changed since you asked." }),
        tool("change", { ok: true, saved: true, change_id: "r43", summary: "Moved Long run · Sun → Sat" }),
      ]),
    ], "Sunday");
    expect(md).not.toContain("The plan changed since you asked.");
    expect(md).toContain("_Moved Long run · Sun → Sat_");
  });

  it("leaves out messages that carry nothing readable", () => {
    const md = transcriptOf([
      msg("user", [text("   \n ")]),
      msg("assistant", [tool("get_profile", out("")), text(" ")]),
      msg("assistant", [tool("get_inbox", { ok: true, summary: "3 items" })]),
      msg("user", [text("Thanks")]),
    ], "  ");
    expect(md).toBe("# Chat\n\n## You\n\nThanks\n");
  });
});
