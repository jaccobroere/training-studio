/** The proposal card as a small state machine: what it shows in each server status, and where
 * an action leaves it. Pure, so the states are tested without a DOM. */
import type { Proposal } from "../api/types";

export type PStatus = Proposal["status"];
export type PAction = "discard" | "preview" | "apply" | "undo" | "show" | "ask";

export interface PView {
  head: string;
  /** One calm sentence under the summary, when the status needs explaining. */
  note: string | null;
  actions: PAction[];
  /** Quieter card (discarded / replaced). */
  dim: boolean;
  /** The ink key (one per card). */
  primary: PAction | null;
}

export function proposalView(status: PStatus, opts: { hasChange?: boolean } = {}): PView {
  switch (status) {
    case "open":
      return { head: "Proposal", note: null, actions: ["discard", "preview", "apply"], dim: false, primary: "apply" };
    case "applied":
      return { head: "Applied", note: null, actions: opts.hasChange ? ["show", "undo"] : ["show"], dim: false, primary: null };
    case "undone":
      return { head: "Undone", note: "Undone. The plan is back as it was.", actions: ["preview"], dim: true, primary: null };
    case "discarded":
      return { head: "Discarded", note: null, actions: [], dim: true, primary: null };
    case "replaced":
      return { head: "Replaced", note: "Replaced by a newer proposal.", actions: [], dim: true, primary: null };
    case "stale":
      return { head: "Out of date", note: "The plan changed since this was proposed. Nothing was changed.",
        actions: ["discard", "ask"], dim: false, primary: null };
  }
}

export type Outcome =
  | { ok: true; proposal?: { status: PStatus } }
  | { ok: false; status?: number; code?: string; current?: PStatus };

/** Where an action leaves the card. Refusals map to the status the server reports. */
export function nextStatus(cur: PStatus, action: "apply" | "discard" | "undo", out: Outcome): PStatus {
  if (out.ok) {
    if (out.proposal?.status) return out.proposal.status;
    return action === "apply" ? "applied" : action === "discard" ? "discarded" : "undone";
  }
  if (out.code === "stale") return "stale";
  if (out.code === "not_open" && out.current) return out.current;
  return cur;
}

/** "W43  +4  −1  ~2": one condensed line per week from the preview chips. */
export function weekLines(p: Pick<Proposal, "preview" | "weeks">): { monday: string; add: number; rm: number; ch: number }[] {
  const m = new Map<string, { add: number; rm: number; ch: number }>();
  const at = (w: string) => { if (!m.has(w)) m.set(w, { add: 0, rm: 0, ch: 0 }); return m.get(w)!; };
  for (const w of p.weeks ?? []) at(w);
  for (const c of p.preview?.added ?? []) at(c.week_monday).add++;
  for (const c of p.preview?.removed ?? []) at(c.week_monday).rm++;
  for (const c of p.preview?.changed ?? []) at((c.after ?? c.before).week_monday).ch++;
  return [...m].filter(([, v]) => v.add || v.rm || v.ch).sort(([a], [b]) => (a < b ? -1 : 1)).map(([monday, v]) => ({ monday, ...v }));
}

/** "24 workouts · 6 weeks" for the header. */
export function countsText(c: Proposal["counts"] | Record<string, number> | undefined): string {
  if (!c) return "";
  const parts: string[] = [];
  if (c.workouts) parts.push(`${c.workouts} workout${c.workouts === 1 ? "" : "s"}`);
  if (c.weeks) parts.push(`${c.weeks} week${c.weeks === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** A diff line's kind from its verb ("Added …", "Removed …", "Moved …"). */
export function lineKind(l: string): "ad" | "rm" | "ed" {
  if (/^(Added|Logged|Created|Linked)\b/.test(l)) return "ad";
  if (/^(Removed|Deleted|Unlinked|Ended|Archived)\b/.test(l)) return "rm";
  return "ed";
}
