import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { useDock } from "../app/dock";
import { usePinnedDock } from "../app/useMedia";
import { api, ApiError } from "../api/client";
import type { ChangeResult, Proposal } from "../api/types";
import { useProposal, useOpenProposalPreview } from "../plan/preview";
import { describeError, refreshPlan, useUndo } from "../plan/api";
import { mondayOf, shortDate } from "../ui/dates";
import { Icon } from "../ui/Icon";
import { useToast } from "../ui/toast";
import { prefillChat } from "./prefill";
import { plainToolError } from "./toolError";
import { countsText, lineKind, nextStatus, proposalView, weekLines, type PAction } from "./proposalState";
import type { ChangeOut, PinOut, ProposeOut, ToolMeta } from "./types";

/** Link to a week of the plan. Where the chat covers the plan (phone, narrow tablet) it closes the
 * chat too, otherwise the link seems to do nothing when that week is already the one open. */
function ShowInPlan({ monday }: { monday: string }) {
  const dock = useDock();
  const pinned = usePinnedDock();
  return <Link className="key flat" to={`/plan/week/${monday}`} onClick={() => { if (!pinned && dock.consoleOpen) dock.toggleConsole(); }}>Show in plan</Link>;
}

/** Link to the pinned analyses in Health. As with ShowInPlan, where the chat is a sheet that covers
 * the page (phone, narrow tablet) the link closes the chat too, otherwise it seems to do nothing. */
export function OpenInHealth() {
  const dock = useDock();
  const pinned = usePinnedDock();
  return <Link className="key flat" to="/stats/pinned" onClick={() => { if (!pinned && dock.consoleOpen) dock.toggleConsole(); }}>Open in Health</Link>;
}

/** A tool part as the AI SDK streams it. */
export interface ToolPart<O = any> {
  type: string; toolCallId: string; state: "input-streaming" | "input-available" | "output-available" | "output-error";
  input?: Record<string, unknown>; output?: O; errorText?: string;
}

const toolName = (p: { type: string }) => p.type.slice(5);

const PENDING: Record<string, string> = {
  get_calendar: "Reading the calendar", get_workout: "Reading a workout", list_series: "Reading repeating workouts",
  list_exercises: "Reading your exercises", list_saved_workouts: "Reading saved workouts", get_activities: "Reading activities",
  get_daily_metrics: "Reading health data", get_inbox: "Reading the inbox", get_profile: "Reading your profile",
  get_history: "Reading the change history", read_guide: "Reading the coaching guide", web_search: "Searching the web",
  web_fetch: "Reading a web page", list_pinned: "Reading pinned analyses",
};
const pendingLabel = (p: ToolPart) => PENDING[toolName(p)] ?? `Working: ${toolName(p).replace(/_/g, " ")}`;

/** ISO week number of a Monday. */
function isoWeek(monday: string): number {
  const d = new Date(`${monday}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 3);
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d.getTime() - jan4.getTime()) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
}

export function Pending({ label }: { label: string }) {
  return <div className="receipt pending" role="status"><div className="rc-hd mono"><span className="dotpulse" aria-hidden="true" />{label}</div></div>;
}

export function ToolError({ title = "Not saved", out }: { title?: string; out?: ToolMeta & { error?: string; detail?: string } }) {
  const { text, details } = plainToolError(out?.detail || out?.summary);
  return (
    <div className="receipt err" role="alert">
      <div className="rc-hd mono"><span>{title.toUpperCase()}</span><span className="fill" /><span className="rc-code">{out?.error}</span></div>
      <p className="rc-note">{text}</p>
      {details && <details className="rc-note"><summary>Details</summary>{details}</details>}
    </div>
  );
}

// ---------------------------------------------------------------- tool steps

/** One read step: "✓ Read the calendar · Your plan · 3 workouts · weeks 40–41", details on demand. */
function Step({ p }: { p: ToolPart<ToolMeta> }) {
  const out = p.output;
  const done = p.state === "output-available";
  const failed = p.state === "output-error" || (done && (out?.ok === false || !!out?.error));
  if (!done && !failed) {
    return <li className="step pending" role="status"><span className="dotpulse" aria-hidden="true" /><span className="st-l">{pendingLabel(p)}…</span></li>;
  }
  const label = out?.label ?? toolName(p).replace(/_/g, " ");
  const summary = failed ? plainToolError(out?.detail || out?.summary || p.errorText || "failed").text : out?.summary;
  return (
    <li className={`step ${failed ? "failed" : ""}`}>
      <details>
        <summary>
          <span className="st-g mono" aria-hidden="true">{failed ? "✕" : "✓"}</span>
          <span className="st-l">{label}</span>
          {out?.source && <span className="st-src">· {out.source}</span>}
          {summary && <span className="st-sum">· {summary}</span>}
        </summary>
        <StepDetail p={p} />
      </details>
    </li>
  );
}

function StepDetail({ p }: { p: ToolPart }) {
  const args = Object.entries(p.input ?? {}).filter(([, v]) => v != null && v !== "" && !(Array.isArray(v) && !v.length));
  return (
    <dl className="st-det mono">
      <div><dt>tool</dt><dd>{toolName(p)}</dd></div>
      {args.map(([k, v]) => (
        <div key={k}><dt>{k}</dt><dd>{clip(typeof v === "string" ? v : JSON.stringify(v), 240)}</dd></div>
      ))}
      {p.state === "output-error" && <div><dt>error</dt><dd>{clip(plainToolError(p.errorText).details ?? p.errorText ?? "", 240)}</dd></div>}
    </dl>
  );
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Consecutive read steps: listed one per line; more than three fold into one line. */
export function ToolSteps({ parts }: { parts: ToolPart[] }) {
  const running = parts.some((p) => p.state === "input-streaming" || p.state === "input-available");
  const list = <ul className="steps">{parts.map((p) => <Step key={p.toolCallId} p={p} />)}</ul>;
  if (parts.length <= 3) return list;
  const sources = [...new Set(parts.map((p) => (p.output as ToolMeta | undefined)?.source).filter(Boolean))];
  return (
    <details className="steps-fold" open={running || undefined}>
      <summary>
        <Icon name="right" />
        <span className="mono">{parts.length} steps</span>
        {sources.length > 0 && <span className="st-sum">· {sources.join(", ")}</span>}
        {running && <span className="dotpulse" aria-hidden="true" />}
      </summary>
      {list}
    </details>
  );
}

// ---------------------------------------------------------------- diff lines

function Lines({ lines, max = 6 }: { lines: string[]; max?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, max);
  return (
    <div className="diff mono" role="list">
      {shown.map((l, i) => {
        const k = lineKind(l);
        return (
          <div key={i} className={`d-row ${k}`} role="listitem">
            <span className="dg" aria-hidden="true">{k === "ad" ? "+" : k === "rm" ? "−" : "~"}</span>
            <span className="dt">{l}</span>
          </div>
        );
      })}
      {lines.length > max && (
        <button type="button" className="key flat plain d-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `${lines.length - max} more`}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- change card

interface ChangeRow { undone_by_id: string | null }

export function ChangeCard({ part }: { part: ToolPart<ChangeOut> }) {
  const undo = useUndo();
  const out = part.output;
  const id = out?.change_id;
  const isUndo = toolName(part) === "undo_change";
  const row = useQuery({ queryKey: ["change", id], enabled: !!id && !!out?.saved, staleTime: 30_000,
    queryFn: () => api<ChangeRow>(`/api/changes/${id}`) });
  const [undoneHere, setUndoneHere] = useState(false);
  const [busy, setBusy] = useState(false);
  if (part.state === "output-error") return <ToolError out={{ detail: part.errorText }} />;
  if (part.state !== "output-available") return <Pending label={isUndo ? "Undoing…" : "Changing the plan…"} />;
  if (!out?.ok) return <ToolError title={isUndo ? "Not undone" : "Not saved"} out={out} />;
  if (!out.saved) return <ul className="steps"><li className="step"><span className="st-g mono" aria-hidden="true">·</span><span className="st-l">{out.detail || out.summary || "Nothing changed"}</span></li></ul>;
  const lines = out.lines ?? [];
  const undone = undoneHere || !!row.data?.undone_by_id;
  const n = lines.length;
  const head = undone ? "Undone" : isUndo ? "Undid a change" : "Applied";
  const week = out.weeks?.[0];
  return (
    <div className={`receipt change ${undone ? "is-undone" : ""}`}>
      <div className="rc-hd mono">
        <span>{head.toUpperCase()} · {n} CHANGE{n === 1 ? "" : "S"}</span>
        <span className="fill" />
        <span className="rc-id" title="Change id">{id}</span>
      </div>
      <div className="rc-body"><Lines lines={lines} /></div>
      {!!out.kept?.length && (
        <ul className="rc-kept">{out.kept.map((k) => <li key={k.id}>Kept {k.title}: {k.note}</li>)}</ul>
      )}
      {!undone && (
        <div className="rc-ft">
          {week && <ShowInPlan monday={mondayOf(week)} />}
          <span className="fill" />
          {id && (
            <button type="button" className="key" disabled={busy} onClick={async () => {
              setBusy(true);
              if (await undo(id)) setUndoneHere(true);
              setBusy(false);
            }}><Icon name="undo" />{busy ? "Undoing…" : "Undo"}</button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- proposal card

export function ProposalCard({ part }: { part: ToolPart<ProposeOut & ChangeOut> }) {
  const out = part.output;
  const id = out?.proposal_id ?? null;
  const q = useProposal(id);
  const qc = useQueryClient();
  const fresh = part.state === "output-available" && !!id;
  // a new proposal replaces older open ones: refresh the cards above it
  useEffect(() => { if (fresh) void qc.invalidateQueries({ queryKey: ["proposal"] }); }, [fresh, id, qc]);
  if (part.state === "output-error") return <ToolError title="No proposal" out={{ detail: part.errorText }} />;
  if (part.state !== "output-available") return <Pending label="Drafting a proposal…" />;
  if (!out?.ok) return <ToolError title="No proposal" out={out} />;
  if (!id) return <ul className="steps"><li className="step"><span className="st-g mono" aria-hidden="true">·</span><span className="st-l">{out.detail || "Nothing to change: the plan already matches."}</span></li></ul>;
  if (q.isPending) {
    return (
      <div className="receipt proposal">
        <div className="rc-hd mono"><span>PROPOSAL</span><span className="fill" /><span>{countsText(out.counts)}</span></div>
        <p className="rc-title">{out.title}</p>
        <div className="rc-body"><div className="skel" style={{ height: 54 }} aria-label="Loading the proposal" /></div>
      </div>
    );
  }
  if (q.isError || !q.data) {
    const gone = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="receipt proposal discarded">
        <div className="rc-hd mono"><span>PROPOSAL</span><span className="fill" /><span>{countsText(out.counts)}</span></div>
        <p className="rc-title">{out.title}</p>
        <p className="rc-note">{gone ? "This proposal no longer exists (its chat was cleared)." : "Couldn't load this proposal."}</p>
        {!gone && <div className="rc-ft"><span className="fill" /><button type="button" className="key" onClick={() => void q.refetch()}>Retry</button></div>}
      </div>
    );
  }
  return <ProposalBody p={q.data} converted={out.converted} />;
}

function ProposalBody({ p, converted }: { p: Proposal; converted?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const undo = useUndo();
  const preview = useOpenProposalPreview();
  const loc = useLocation();
  const [busy, setBusy] = useState<PAction | null>(null);
  const [allWeeks, setAllWeeks] = useState(false);
  const v = proposalView(p.status, { hasChange: !!p.change_id });
  const previewing = loc.pathname.startsWith("/plan/weeks") && new URLSearchParams(loc.search).get("proposal") === p.id;
  const weeks = weekLines(p);
  const n = p.counts.workouts;

  const set = (status: Proposal["status"], patch: Partial<Proposal> = {}) =>
    qc.setQueryData<Proposal>(["proposal", p.id], (old) => (old ? { ...old, ...patch, status } : old));
  const act = async (verb: "apply" | "discard") => {
    setBusy(verb);
    try {
      const r = await api<{ proposal: Proposal; change: ChangeResult } | Proposal>(`/api/chat/proposals/${p.id}/${verb}`, { method: "POST" });
      const prop = "proposal" in r ? r.proposal : r;
      set(nextStatus(p.status, verb, { ok: true, proposal: prop }), prop);
      if (verb === "apply") refreshPlan(qc);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      const current = e instanceof ApiError ? (e.body?.status as Proposal["status"] | undefined) : undefined;
      const next = nextStatus(p.status, verb, { ok: false, code, status: e instanceof ApiError ? e.status : 0, current });
      if (next !== p.status) set(next);
      else toast({ tone: "error", text: describeError(e) });
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ["proposal", p.id] });
    }
  };
  const doUndo = async () => {
    if (!p.change_id) return;
    setBusy("undo");
    if (await undo(p.change_id)) set("undone");
    setBusy(null);
    void qc.invalidateQueries({ queryKey: ["proposal", p.id] });
  };

  const key = (a: PAction) => {
    switch (a) {
      case "discard": return <button key={a} type="button" className="key flat" disabled={!!busy} onClick={() => void act("discard")}>{busy === "discard" ? "Discarding…" : "Discard"}</button>;
      case "preview": return (
        <button key={a} type="button" className={`key ${previewing ? "is-latched" : ""}`} aria-pressed={previewing} title="Preview in calendar" onClick={() => preview(p.id)}>
          <Icon name="cal" />Preview
        </button>
      );
      case "apply": return <button key={a} type="button" className="key ink" disabled={!!busy} onClick={() => void act("apply")}>{busy === "apply" ? "Applying…" : `Apply${n ? ` ${n}` : ""}`}</button>;
      case "undo": return <button key={a} type="button" className="key" disabled={!!busy} onClick={() => void doUndo()}><Icon name="undo" />{busy === "undo" ? "Undoing…" : "Undo"}</button>;
      case "show": return p.weeks[0] ? <ShowInPlan key={a} monday={p.weeks[0]} /> : null;
      case "ask": return (
        <button key={a} type="button" className="key" onClick={() => prefillChat(`The proposal “${p.title}” is out of date. Please propose it again on the current plan.`)}>Ask again</button>
      );
    }
  };
  const left = v.actions.filter((a) => a === "discard" || a === "show");
  const right = v.actions.filter((a) => a !== "discard" && a !== "show");
  return (
    <div className={`receipt proposal ${p.status} ${v.dim ? "dim" : ""}`}>
      <div className="rc-hd mono">
        <span>{v.head.toUpperCase()}</span>
        <span className="fill" />
        <span>{countsText(p.counts)}</span>
      </div>
      <p className="rc-title">{p.title}</p>
      {p.summary && <p className="rc-note">{p.summary}</p>}
      {v.note && <p className="rc-note rc-state-note" role={p.status === "stale" ? "status" : undefined}>{v.note}</p>}
      {converted && p.status === "open" && <p className="rc-note">Large change: review it before applying.</p>}
      <div className="rc-body">
        {weeks.length > 1 ? (
          <>
            <ul className="wk-lines mono" aria-label="Changes per week">
              {(allWeeks || weeks.length <= 8 ? weeks : weeks.slice(0, 6)).map((w) => (
                <li key={w.monday}>
                  <span className="wk-n">W{isoWeek(w.monday)}</span>
                  <span className="wk-d">{shortDate(w.monday)}</span>
                  <span className="wk-c">
                    {w.add > 0 && <span title={`${w.add} added`}>+{w.add}</span>}
                    {w.rm > 0 && <span title={`${w.rm} removed`}>−{w.rm}</span>}
                    {w.ch > 0 && <span title={`${w.ch} changed`}>~{w.ch}</span>}
                  </span>
                </li>
              ))}
            </ul>
            {weeks.length > 8 && (
              <button type="button" className="key flat plain d-more" aria-expanded={allWeeks} onClick={() => setAllWeeks(!allWeeks)}>
                {allWeeks ? "Show fewer weeks" : `All ${weeks.length} weeks`}
              </button>
            )}
            <p className="rc-note wk-key">+ added · ~ changed · − removed</p>
            <details className="rc-all">
              <summary><Icon name="right" />Every change ({p.lines.length})</summary>
              <Lines lines={p.lines} max={p.lines.length} />
            </details>
          </>
        ) : <Lines lines={p.lines} />}
      </div>
      {v.actions.length > 0 && (
        <div className="rc-ft">
          {left.map(key)}
          <span className="fill" />
          {right.map(key)}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- pin receipts

export function PinCard({ part }: { part: ToolPart<PinOut> }) {
  const qc = useQueryClient();
  const out = part.output;
  const done = part.state === "output-available" && !!out?.ok;
  useEffect(() => {
    if (done) {
      void qc.invalidateQueries({ queryKey: ["pinned"] });
      void qc.invalidateQueries({ queryKey: ["analysis"] });
    }
  }, [done, qc]);
  const name = toolName(part);
  if (part.state === "output-error") return <ToolError title="Not pinned" out={{ detail: part.errorText }} />;
  if (part.state !== "output-available") return <Pending label={name === "unpin_analysis" ? "Removing the pin…" : name === "update_pinned" ? "Updating the pin…" : "Pinning…"} />;
  if (!out?.ok) return <ToolError title={name === "unpin_analysis" ? "Not removed" : "Not pinned"} out={out} />;
  const head = name === "unpin_analysis" ? "Removed from Pinned" : name === "update_pinned" ? `Pin updated${out.version ? ` · v${out.version}` : ""}` : out.created === false ? "Already pinned" : "Pinned";
  return (
    <div className="receipt pin">
      <div className="rc-hd mono"><span>{head.toUpperCase()}</span><span className="fill" /><span className="rc-id">Health</span></div>
      <div className="rc-ft">
        <span className="rc-pin-t">{out.title ?? out.summary}</span>
        <span className="fill" />
        {name !== "unpin_analysis" && <OpenInHealth />}
      </div>
    </div>
  );
}
