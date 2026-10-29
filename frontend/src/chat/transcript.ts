/** A conversation as Markdown, for the clipboard: what was said, plus one italic line for each
 *  card the assistant produced. Tool steps and raw tool arguments stay out; a transcript is read,
 *  not replayed. */
import type { UIMessage } from "ai";
import type { MessageAttachment } from "./types";
import { superseded } from "./toolError";
import { CARD_TOOLS, turnOf, turnSources, turnText } from "./turn";

/** The one line a card contributes: "Applied 3 changes", "Proposal · 24 workouts". */
function cardLine(p: any): string {
  if (p.state !== "output-available" || !p.output) return "";
  const out = p.output as { ok?: boolean; title?: string; summary?: string; error?: string; detail?: string };
  const what = out.ok === false ? (out.summary || out.detail || out.error) : (out.title || out.summary || out.detail);
  return typeof what === "string" ? what.trim() : "";
}

function attachmentsOf(m: UIMessage): string {
  const list = ((m.metadata ?? {}) as { attachments?: MessageAttachment[] }).attachments ?? [];
  return list.length ? `Attached: ${list.map((a) => a.filename).join(", ")}` : "";
}

function bodyOf(m: UIMessage, i: number, messages: UIMessage[]): string[] {
  const parts = m.parts as any[];
  if (m.role === "user") {
    const text = turnText(parts);
    return [text, attachmentsOf(m)].filter(Boolean);
  }
  const lines: string[] = [];
  const text = turnText(parts);
  if (text) lines.push(text);
  parts.forEach((p, j) => {
    const name = typeof p.type === "string" && p.type.startsWith("tool-") ? p.type.slice(5) : null;
    // A failure the model fixed later in the same turn is a quiet step on screen: not a card here.
    if (!name || !CARD_TOOLS.has(name) || superseded(parts, j)) return;
    const what = cardLine(p);
    if (what) lines.push(`_${what}_`);
  });
  const turn = turnOf(messages, i);
  if (turn?.last) {
    const sources = turnSources(turn.parts);
    if (sources.length) lines.push(["Sources:", ...sources.map((s) => `- [${s.title || s.url}](${s.url})`)].join("\n"));
  }
  return lines;
}

/** The whole conversation as Markdown: a title, then `## You` / `## Assistant` per turn.
 *  A turn's consecutive assistant messages share one heading (the screen shows them as one
 *  reply), and messages that carry nothing readable (a tool call with no text) are left out. */
export function transcriptOf(messages: UIMessage[], title: string): string {
  const turns: { role: string; body: string[] }[] = [];
  messages.forEach((m, i) => {
    const body = bodyOf(m, i, messages);
    if (!body.length) return;
    const role = m.role === "user" ? "You" : "Assistant";
    const prev = turns[turns.length - 1];
    if (prev && prev.role === "Assistant" && role === "Assistant") prev.body.push(...body);
    else turns.push({ role, body });
  });
  const blocks = [`# ${title.trim() || "Chat"}`, ...turns.map((t) => `## ${t.role}\n\n${t.body.join("\n\n")}`)];
  return `${blocks.join("\n\n")}\n`;
}
