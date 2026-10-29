/** Turn-level reads over a conversation's parts, shared by the thread view and the transcript.
 *  A turn is the run of consecutive assistant messages; the last one carries its sources. */
import type { UIMessage } from "ai";

export interface Turn { parts: any[]; last: boolean }

/** Tools that render as their own card in the thread (`messages.tsx`); the transcript names each
 *  in one italic line instead. One list, so a new card tool cannot go missing from the copy. */
export const CARD_TOOLS = new Set(["change", "propose", "undo_change", "run_analysis", "pin_analysis", "update_pinned", "unpin_analysis"]);

/** All consecutive assistant messages form one turn; `last` marks where its sources go. */
export function turnOf(messages: UIMessage[], i: number): Turn | null {
  if (messages[i].role !== "assistant") return null;
  let a = i, b = i;
  while (a > 0 && messages[a - 1].role === "assistant") a--;
  while (b < messages.length - 1 && messages[b + 1].role === "assistant") b++;
  return { parts: messages.slice(a, b + 1).flatMap((x) => x.parts as any[]), last: i === b };
}

/** The prose of a turn: its text parts, one paragraph apart. Cards, steps and sources are not text. */
export function turnText(parts: any[]): string {
  return parts.filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n\n").trim();
}

export type Src = { n: number; title: string; url: string; accessed: string };

/** Sources from this turn's searches and fetches, numbered as the model cites them. */
export function turnSources(parts: any[]): Src[] {
  const out: Src[] = [];
  for (const p of parts) {
    if (p.type === "tool-web_search" && p.output?.ok) {
      for (const r of p.output.results ?? []) if (!out.some((x) => x.url === r.url)) out.push(r);
    }
  }
  for (const p of parts) {
    if (p.type === "tool-web_fetch" && p.output?.ok && !out.some((x) => x.url === p.output.url)) {
      out.push({ n: p.output.n ?? out.length + 1, title: p.output.title, url: p.output.url, accessed: p.output.accessed });
    }
  }
  return out.sort((a, b) => a.n - b.n);
}
