import { describe, expect, it } from "vitest";
import { assistantError } from "./assistantError";
import { attReducer, acceptOf, briefOf, canAttach, chipMeta, DEFAULT_RULES, EMPTY, kindOf, readyMedia, serverError, uploading, validate } from "./attachments";
import { countsText, lineKind, nextStatus, proposalView, weekLines } from "./proposalState";
import type { Media } from "./types";

const rules = { ...DEFAULT_RULES, images: true, pdf: true };
const media = (over: Partial<Media> = {}): Media => ({ id: "m1", file: "m1.jpg", url: "/api/media/m1", purpose: "chat",
  media_type: "image/jpeg", filename: "knee.jpg", size: 180_000, pages: 1, ...over });

describe("attachment chips", () => {
  it("validates type, size and emptiness in plain words", () => {
    expect(validate({ name: "knee.jpg", size: 1000, type: "image/jpeg" }, rules)).toBeNull();
    expect(validate({ name: "a.mov", size: 1000, type: "video/quicktime" }, rules)?.[0]).toBe("Not supported");
    expect(validate({ name: "big.pdf", size: 21 * 1024 * 1024, type: "application/pdf" }, rules)?.[1]).toBe("big.pdf is 21 MB; the limit is 20 MB.");
    expect(validate({ name: "e.png", size: 0, type: "image/png" }, rules)?.[0]).toBe("Empty");
  });

  it("follows the status flags: images off still takes PDFs", () => {
    const pdfOnly = { ...rules, images: false };
    expect(validate({ name: "x.png", size: 10, type: "image/png" }, pdfOnly)?.[0]).toBe("Images off");
    expect(validate({ name: "x.pdf", size: 10, type: "application/pdf" }, pdfOnly)).toBeNull();
    expect(acceptOf(pdfOnly)).toBe("application/pdf");
    expect(canAttach(pdfOnly)).toBe(true);
    expect(canAttach({ ...rules, images: false, pdf: false })).toBe(false);
    expect(canAttach(undefined)).toBe(false);
  });

  it("reads HEIC and PDFs by extension when the browser gives no type", () => {
    expect(kindOf({ name: "IMG_1.HEIC", size: 1, type: "" })).toBe("image/heic");
    expect(kindOf({ name: "plan.pdf", size: 1, type: "" })).toBe("application/pdf");
  });

  it("adds up to the maximum, then says so", () => {
    const files = Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, name: `p${i}.png`, size: 10, type: "image/png" }));
    const s = attReducer(EMPTY, { type: "add", files, rules });
    expect(s.chips).toHaveLength(4);
    expect(s.notice).toBe("At most 4 files per message.");
    expect(s.chips.every((c) => c.status === "uploading")).toBe(true);
    expect(uploading(s)).toBe(true);
  });

  it("goes uploading → progress → ready, and failures become error chips", () => {
    let s = attReducer(EMPTY, { type: "add", rules, files: [
      { key: "a", name: "knee.jpg", size: 180_000, type: "image/jpeg" },
      { key: "b", name: "scan.pdf", size: 5000, type: "application/pdf" },
    ] });
    s = attReducer(s, { type: "progress", key: "a", progress: 38.2 });
    expect(chipMeta(s.chips[0])).toBe("38%");
    s = attReducer(s, { type: "progress", key: "a", progress: 10 });
    expect(s.chips[0].progress).toBe(38.2);
    s = attReducer(s, { type: "done", key: "a", media: media() });
    expect(s.chips[0].status).toBe("ready");
    expect(chipMeta(s.chips[0])).toBe("176 KB");
    const [short, error] = serverError("scan.pdf", 422, "pdf_encrypted");
    s = attReducer(s, { type: "fail", key: "b", short, error });
    expect(chipMeta(s.chips[1])).toBe("Locked PDF");
    expect(uploading(s)).toBe(false);
    expect(readyMedia(s).map((m) => m.id)).toEqual(["m1"]);
    s = attReducer(s, { type: "remove", key: "b" });
    expect(s.chips).toHaveLength(1);
    expect(attReducer(s, { type: "clear" })).toEqual(EMPTY);
  });

  it("shows page counts for PDFs and maps server codes", () => {
    let s = attReducer(EMPTY, { type: "add", rules, files: [{ key: "p", name: "plan.pdf", size: 9000, type: "application/pdf" }] });
    s = attReducer(s, { type: "done", key: "p", media: media({ media_type: "application/pdf", pages: 3, filename: "plan.pdf" }) });
    expect(chipMeta(s.chips[0])).toBe("3 pages");
    expect(serverError("x", 413, "")[0]).toBe("Too large");
    expect(serverError("x", 429, "rate_limited")[1]).toContain("Wait a moment");
    expect(briefOf(media())).toEqual({ id: "m1", filename: "knee.jpg", media_type: "image/jpeg", pages: 1, url: "/api/media/m1" });
  });
});

describe("proposal card states", () => {
  it("open has Discard, Preview and Apply (the ink key)", () => {
    const v = proposalView("open");
    expect(v.actions).toEqual(["discard", "preview", "apply"]);
    expect(v.primary).toBe("apply");
    expect(v.head).toBe("Proposal");
  });

  it("applied offers Undo only with a change id; discarded and replaced are quiet with no keys", () => {
    expect(proposalView("applied", { hasChange: true }).actions).toEqual(["show", "undo"]);
    expect(proposalView("applied").actions).toEqual(["show"]);
    expect(proposalView("discarded")).toMatchObject({ actions: [], dim: true });
    expect(proposalView("replaced").note).toContain("newer proposal");
  });

  it("stale explains calmly and offers Ask again", () => {
    const v = proposalView("stale");
    expect(v.head).toBe("Out of date");
    expect(v.note).toContain("Nothing was changed");
    expect(v.actions).toContain("ask");
    expect(v.actions).not.toContain("apply");
  });

  it("transitions on actions and refusals", () => {
    expect(nextStatus("open", "apply", { ok: true })).toBe("applied");
    expect(nextStatus("open", "apply", { ok: true, proposal: { status: "applied" } })).toBe("applied");
    expect(nextStatus("open", "discard", { ok: true })).toBe("discarded");
    expect(nextStatus("applied", "undo", { ok: true })).toBe("undone");
    expect(nextStatus("open", "apply", { ok: false, status: 409, code: "stale" })).toBe("stale");
    expect(nextStatus("open", "apply", { ok: false, status: 409, code: "not_open", current: "replaced" })).toBe("replaced");
    expect(nextStatus("open", "apply", { ok: false, status: 500 })).toBe("open");
    expect(nextStatus("stale", "discard", { ok: true })).toBe("discarded");
  });

  it("condenses per week and labels counts and lines", () => {
    const chip = (w: string) => ({ id: "x", date: null, time: null, week_monday: w, weekday: null, type: "run" as const, mark: "RUN", title: "t", tags: [], series_id: null, status: "planned", items: [] });
    const rows = weekLines({ weeks: ["2026-10-26", "2026-10-19"], preview: { added: [chip("2026-10-19"), chip("2026-10-19")], removed: [chip("2026-10-26")],
      changed: [{ kind: "moved", fields: ["date"], before: chip("2026-10-19"), after: chip("2026-10-26") }] } });
    expect(rows).toEqual([{ monday: "2026-10-19", add: 2, rm: 0, ch: 0 }, { monday: "2026-10-26", add: 0, rm: 1, ch: 1 }]);
    expect(countsText({ workouts: 24, added: 24, removed: 0, moved: 0, changed: 0, other: 0, weeks: 1 })).toBe("24 workouts · 1 week");
    expect(lineKind("Added Easy run · Mon 19 Oct")).toBe("ad");
    expect(lineKind("Removed Tempo · Tue")).toBe("rm");
    expect(lineKind("Moved Long run · Sat → Sun")).toBe("ed");
  });
});

describe("assistant errors", () => {
  it("shows the server's plain sentence as it is, with no wrapper", () => {
    expect(assistantError("The assistant isn't available right now. Try again later.")).toBe("The assistant isn't available right now. Try again later.");
    expect(assistantError("The assistant reached its step limit. Try a more focused question.")).toContain("step limit");
  });
  it("maps the API's codes and hides bodies and network errors", () => {
    expect(assistantError('{"code":"quota_exceeded","detail":"You\'ve used all 200 turns","request_id":"x"}')).toContain("Weekly limit");
    expect(assistantError('{"code":"turn_in_progress"}')).toContain("earlier message");
    for (const raw of ["Failed to fetch", "", "status_code: 500, body: {'error': 'x'}", "TypeError: NetworkError when attempting to fetch"]) {
      expect(assistantError(raw)).toBe("The assistant couldn't answer. Please try again.");
    }
  });
});
