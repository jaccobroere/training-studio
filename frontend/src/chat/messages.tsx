import type { UIMessage } from "ai";
import { useEffect, useRef, useState } from "react";
import { copyText } from "../ui/clipboard";
import { Icon } from "../ui/Icon";
import { useToast } from "../ui/toast";
import { AnalysisCard } from "./AnalysisCard";
import { ChangeCard, PinCard, ProposalCard, ToolSteps, type ToolPart } from "./cards";
import { Markdown } from "./Markdown";
import { isPdf } from "./attachments";
import { scopeChip, type ChatScope } from "./scope";
import { CARD_TOOLS, turnSources, turnText, type Src, type Turn } from "./turn";
import type { MessageAttachment } from "./types";
import { FileGlyph } from "./Composer";
import { superseded } from "./toolError";

/** Tools that render as their own card; every other tool is a one-line read step. */
const isStep = (p: any) => typeof p.type === "string" && p.type.startsWith("tool-") && !CARD_TOOLS.has(p.type.slice(5));

export function firstText(m: UIMessage) {
  return (m.parts as any[]).filter((p) => p.type === "text").map((p) => p.text).join(" ");
}

export function hasVisibleOutput(messages: UIMessage[]) {
  const last = messages[messages.length - 1];
  return !!last && last.role === "assistant" && (last.parts as any[]).some((p) => (p.type === "text" && p.text.trim()) || p.type?.startsWith("tool-"));
}

function SentFiles({ list }: { list: MessageAttachment[] }) {
  return (
    <ul className="u-files" aria-label="Attached files">
      {list.map((f) => (
        <li key={f.id}>
          <a className="att sent" href={f.url} target="_blank" rel="noopener noreferrer" title={f.filename}>
            {isPdf(f.media_type) ? <FileGlyph /> : <img className="att-thumb" src={f.url} alt="" loading="lazy" />}
            <span className="att-n">{f.filename}</span>
            {isPdf(f.media_type) && f.pages ? <span className="att-m mono">{f.pages} {f.pages === 1 ? "page" : "pages"}</span> : null}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function Message({ m, turn }: { m: UIMessage; turn: Turn | null }) {
  if (m.role === "user") {
    const meta = (m.metadata ?? {}) as { scope?: ChatScope; attachments?: MessageAttachment[] };
    const text = firstText(m);
    return (
      <div className="msg user">
        {meta.scope && <div className="u-meta"><span className="scope-chip mono">⌖ {scopeChip(meta.scope)}</span></div>}
        {!!meta.attachments?.length && <SentFiles list={meta.attachments} />}
        {text.trim() && <p>{text}</p>}
      </div>
    );
  }
  // Sources from this turn's searches/fetches, numbered as the model cites them.
  const turnParts = turn?.parts ?? (m.parts as any[]);
  const sources: Src[] = turnSources(turnParts);
  const cites = new Set(sources.map((x) => x.n));
  // Consecutive read steps render together as one compact block.
  const out: React.ReactNode[] = [];
  let steps: ToolPart[] = [];
  const flush = (k: string) => {
    if (!steps.length) return;
    out.push(<ToolSteps key={k} parts={steps} />);
    steps = [];
  };
  (m.parts as any[]).forEach((p, i) => {
    const k = `${m.id}-${i}`;
    if (isStep(p) || superseded(m.parts as any[], i)) { steps.push(p); return; }
    flush(`${k}-s`);
    const name = typeof p.type === "string" && p.type.startsWith("tool-") ? p.type.slice(5) : null;
    if (p.type === "text" && p.text.trim()) out.push(<div key={k} className="msg asst"><Markdown text={p.text} cites={cites} /></div>);
    else if (name === "propose" || (name === "change" && p.output?.proposal_id)) out.push(<ProposalCard key={k} part={p} />);
    else if (name === "change" || name === "undo_change") out.push(<ChangeCard key={k} part={p} />);
    else if (name === "run_analysis") out.push(<AnalysisCard key={k} part={p} />);
    else if (name === "pin_analysis" || name === "update_pinned" || name === "unpin_analysis") out.push(<PinCard key={k} part={p} />);
  });
  flush(`${m.id}-end`);
  if (sources.length && turn?.last) {
    const text = turnParts.filter((p) => p.type === "text").map((p) => p.text).join(" ");
    const cited = new Set([...text.matchAll(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g)].flatMap((x) => x[1].split(",").map((n) => Number(n.trim()))));
    out.push(<Sources key={`${m.id}-src`} list={sources.filter((x) => cited.has(x.n))} extra={sources.filter((x) => !cited.has(x.n))} />);
  }
  // One copy key per turn, after everything the turn showed (tool-only turns get none).
  const reply = turn?.last ? turnText(turnParts) : "";
  if (reply) out.push(<TurnActions key={`${m.id}-act`} text={reply} />);
  return <>{out}</>;
}

/** Copy one reply: quiet at rest, ink under the pointer, and a full tap target on a phone. */
function TurnActions({ text }: { text: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    if (!(await copyText(text))) {
      toast({ tone: "error", text: "Couldn't copy the reply" });
      return;
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="turn-actions">
      <button type="button" className="key flat plain turn-copy" aria-label="Copy reply" title="Copy reply as Markdown" onClick={() => void copy()}>
        <Icon name={copied ? "check" : "copy"} />
        <span>{copied ? "Copied" : "Copy"}</span>
      </button>
      <span className="sr" aria-live="polite">{copied ? "Reply copied" : ""}</span>
    </div>
  );
}

function Sources({ list, extra = [] }: { list: Src[]; extra?: Src[] }) {
  if (!list.length && !extra.length) return null;
  return (
    <div className="srcs-wrap">
      {list.length > 0 && <ol className="srcs" aria-label="Sources cited">{list.map((s) => <SourceRow key={`${s.n}-${s.url}`} s={s} />)}</ol>}
      {extra.length > 0 && (
        <details className="steps-fold more-src">
          <summary><span className="mono">{extra.length} more consulted, not cited</span></summary>
          <ol className="srcs">{extra.map((s) => <SourceRow key={`${s.n}-${s.url}`} s={s} />)}</ol>
        </details>
      )}
    </div>
  );
}

function SourceRow({ s }: { s: Src }) {
  let host = s.url;
  try { host = new URL(s.url).hostname.replace(/^www\./, ""); } catch { /* keep raw */ }
  return (
    <li id={`cite-${s.n}`}>
      <span className="cite mono">{s.n}</span>
      <a href={s.url} target="_blank" rel="noopener noreferrer nofollow">{s.title || host}</a>
      <span className="mono muted small">{host} · accessed {s.accessed}</span>
    </li>
  );
}
