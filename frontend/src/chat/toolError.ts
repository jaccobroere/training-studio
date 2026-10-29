import { CARD_TOOLS } from "./turn";

/** What a failed tool card says. The model gets the precise message (backend/chat/errors.py); the
 *  athlete gets one plain sentence, and the precise text stays one tap away under "Details". */
const INCOMPLETE = "The assistant's request was incomplete. Nothing changed; it corrects and retries.";

type AnyPart = { type?: string; state?: string; output?: { ok?: boolean } | null };
const failedPart = (p: AnyPart) => p.state === "output-error" || p.output?.ok === false;
const landedPart = (p: AnyPart) => p.state === "output-available" && p.output?.ok === true;

/** A failed card the model later recovered from in the same turn (same tool, a later call that worked)
 *  folds into a quiet step row instead of a red card. A failure nothing recovered stays a card. */
export function superseded(parts: AnyPart[], i: number): boolean {
  const p = parts[i];
  if (!CARD_TOOLS.has(String(p.type).replace(/^tool-/, "")) || !failedPart(p)) return false;
  return parts.slice(i + 1).some((q) => q.type === p.type && landedPart(q));
}

export function plainToolError(raw?: string | null): { text: string; details?: string } {
  const t = (raw ?? "").trim();
  if (!t) return { text: "Step failed. Nothing changed." };
  const dump = t.includes("```") || /^\d+ validation errors?\b/.test(t) || /"(loc|type)"\s*:/.test(t);
  if (dump || /call was not run \(nothing changed\)/.test(t)) {
    return { text: INCOMPLETE, details: t.replace(/\s*Fix the errors and try again\.\s*$/, "").slice(0, 600) };
  }
  return { text: t.replace(/\s*Fix the errors and try again\.\s*$/, "") };
}
