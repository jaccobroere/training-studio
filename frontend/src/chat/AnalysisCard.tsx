import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../api/client";
import { SpecChart } from "../charts/SpecChart";
import { stamp } from "../ui/dates";
import { useToast } from "../ui/toast";
import { OpenInHealth, Pending, ToolError, type ToolPart } from "./cards";
import type { Analysis, AnalysisOut, AnalysisResult, Pinned, TableT } from "./types";

const fmtCell = (v: unknown) => (typeof v === "number" ? String(Math.round(v * 100) / 100) : v == null ? "—"
  : String(v).replace(/[T ]00:00:00(\.0+)?$/, "").slice(0, 40));

/** A result table: the first rows, with the full table as CSV. */
function ResultTable({ t, csv, rows = 8 }: { t: TableT; csv?: string; rows?: number }) {
  return (
    <div className="an-tbl">
      {t.title && <span className="an-tt">{t.title}</span>}
      <div className="tbl-wrap" tabIndex={0} role="region" aria-label={t.title || "Table"}>
        <table className="tbl">
          <thead><tr>{t.columns.map((c, i) => <th key={i} scope="col">{c}</th>)}</tr></thead>
          <tbody>{t.rows.slice(0, rows).map((r, j) => <tr key={j}>{r.map((v, k) => <td key={k} className="mono">{fmtCell(v)}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <div className="an-tf">
        <span className="mono">{t.rows.length > rows ? `First ${rows} of ${t.rows.length} rows` : `${t.rows.length} row${t.rows.length === 1 ? "" : "s"}`}</span>
        {csv && <a className="key flat" href={csv} download>CSV</a>}
      </div>
    </div>
  );
}

/** Printed output: shown in full when short, folded when long. */
function Stdout({ text, truncated }: { text: string; truncated?: boolean }) {
  const t = text.trim();
  if (!t) return null;
  const lines = t.split("\n");
  const long = lines.length > 8 || t.length > 600;
  if (!long) return <pre className="an-out mono">{t}</pre>;
  return (
    <details className="an-fold">
      <summary className="mono">Printed output · {lines.length} lines{truncated ? " (cut short)" : ""}</summary>
      <pre className="an-out mono">{t}</pre>
    </details>
  );
}

/** Charts, printed output and tables of one run (chat card and Health pins share this). */
export function ResultBody({ res, csvBase, chartHeight = 210, fold }: { res: AnalysisResult; csvBase?: string; chartHeight?: number; /** Show this many charts, the rest on demand. */ fold?: number }) {
  const [more, setMore] = useState(false);
  const charts = res.charts ?? [];
  const shown = fold && !more ? charts.slice(0, fold) : charts;
  return (
    <>
      {shown.map((c, i) => <div key={i} className="screen an-chart"><SpecChart spec={c} height={chartHeight} compact /></div>)}
      {fold != null && charts.length > fold && (
        <button type="button" className="key flat an-more" aria-expanded={more} onClick={() => setMore(!more)}>
          {more ? "Fewer charts" : `${charts.length - fold} more chart${charts.length - fold === 1 ? "" : "s"}`}
        </button>
      )}
      {res.stdout && <Stdout text={res.stdout} truncated={res.truncated} />}
      {res.tables?.map((t, i) => <ResultTable key={i} t={t} csv={csvBase ? `${csvBase}/table/${i}.csv` : undefined} />)}
      {!!res.warnings?.length && <ul className="an-warn">{res.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
    </>
  );
}

function rowsText(rows?: Record<string, number>) {
  return Object.entries(rows ?? {}).map(([k, n]) => `${k} ${n} rows`).join(" · ");
}

export function AnalysisCard({ part }: { part: ToolPart<AnalysisOut> }) {
  const out = part.output;
  const id = out?.analysis_id;
  const q = useQuery({ queryKey: ["analysis", id], enabled: !!id && part.state === "output-available",
    queryFn: () => api<Analysis>(`/api/analyses/${id}`), staleTime: 60_000 });
  const [code, setCode] = useState(false);
  if (part.state === "output-error") return <ToolError title="Analysis not run" out={{ detail: part.errorText }} />;
  if (part.state !== "output-available") return <Pending label="Running the analysis in the sandbox…" />;
  if (!out) return <ToolError title="Analysis not run" />;
  if (!id) {
    // bad_dataset / analysis_limit: nothing ran.
    return <ToolError title={out.error === "analysis_limit" ? "No more runs this turn" : "Analysis not run"} out={out} />;
  }
  const a = q.data;
  const failed = out.ok === false || (a && a.status !== "ok");
  const status = a?.status ?? out.status ?? (out.ok ? "ok" : "error");
  return (
    <div className={`receipt analysis ${failed ? "err" : ""}`}>
      <div className="rc-hd mono">
        <span>{failed ? `ANALYSIS · ${status.toUpperCase()}` : "ANALYSIS"}</span>
        <span className="fill" />
        <span className="rc-id">{rowsText(a?.rows ?? out.rows)}{out.duration_s != null ? ` · ${out.duration_s}s` : ""}</span>
      </div>
      <p className="rc-title">{a?.title || out.title || "Analysis"}</p>
      {a?.question && <p className="rc-note an-q">{a.question}</p>}
      {failed ? <FailedRun out={out} a={a} /> : q.isPending ? (
        <div className="an-chart"><div className="skel" style={{ height: 180 }} aria-label="Loading the result" /></div>
      ) : q.isError ? (
        <p className="rc-note">Couldn't load the full result. <button type="button" className="key flat" onClick={() => void q.refetch()}>Retry</button></p>
      ) : a ? <ResultBody res={a.result} csvBase={`/api/analyses/${id}`} fold={2} /> : null}
      {code && a?.code && <pre className="an-code mono" aria-label="Analysis code">{a.code}</pre>}
      <div className="rc-ft">
        <span className="rc-state mono">
          {a ? `Ran ${stamp(a.at, undefined, true)}` : ""}{a?.data_changed_since ? " · data has changed since" : ""}
        </span>
        <span className="fill" />
        {a?.code && <button type="button" className="key flat" aria-expanded={code} onClick={() => setCode(!code)}>{code ? "Hide code" : "Code"}</button>}
        {a?.datasets?.map((d, i) => (
          <a key={d.name} className="key flat" href={`/api/analyses/${id}/data.csv?dataset=${i}`} download
            title={`The ${d.kind} data this ran on, as CSV`}>{a.datasets.length > 1 ? `Data · ${d.name}` : "Data CSV"}</a>
        ))}
        {a && !failed && <PinKey a={a} />}
      </div>
    </div>
  );
}

function FailedRun({ out, a }: { out: AnalysisOut; a?: Analysis }) {
  const brief = a?.result.error_brief;
  const message = brief?.message || out.error || a?.result.error?.trim().split("\n").slice(-1)[0] || "The code stopped with an error.";
  const line = brief?.line ?? out.line;
  const codeLine = brief?.code ?? out.code_line;
  const hint = brief?.hint ?? out.hint;
  return (
    <div className="an-err">
      <p className="an-msg mono">{message}</p>
      {(line || codeLine) && <pre className="an-out err mono">{line ? `line ${line}: ` : ""}{codeLine}</pre>}
      {hint && <p className="rc-note">{hint}</p>}
      <p className="rc-note">
        {out.status === "timeout" ? "The run took too long and was stopped. " : ""}
        {out.runs_left != null ? (out.runs_left > 0
          ? `The assistant can fix this and retry (${out.runs_left} run${out.runs_left === 1 ? "" : "s"} left this turn).`
          : "No runs left this turn. Ask again to try a different approach.") : out.next ?? ""}
      </p>
    </div>
  );
}

function PinKey({ a }: { a: Analysis }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (a.pinned_id) {
    return <span className="pin-done"><span className="mono">Pinned</span><OpenInHealth /></span>;
  }
  const pin = async () => {
    setBusy(true);
    try {
      const p = await api<Pinned & { created: boolean }>("/api/pinned", { method: "POST", json: { analysis_id: a.id } });
      qc.setQueryData<Analysis>(["analysis", a.id], (old) => (old ? { ...old, pinned_id: p.id } : old));
      void qc.invalidateQueries({ queryKey: ["pinned"] });
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "";
      toast({ tone: "error", text: code === "too_many_pinned" ? "Pinned is full (24). Remove one in Health first."
        : code === "analysis_failed" ? "Only analyses that ran without errors can be pinned." : "Couldn't pin this analysis." });
    } finally {
      setBusy(false);
    }
  };
  return <button type="button" className="key" disabled={busy} onClick={() => void pin()}>{busy ? "Pinning…" : "Pin"}</button>;
}
