import { useId, useMemo, useState } from "react";
import { EChart } from "./EChart";
import { keyEntries, labelMode, specLabel, specOption, specTable, type ChartV2, type KeyEntry } from "./spec";
import { useTokens } from "./theme";
import "./charts.css";

/** Renders one chart spec v2 on a screen: title, the plot, a key row when names can't sit on
 * the lines, and a table toggle with every value (the accessible reading of the chart). */
export function SpecChart({ spec, height = 220, compact = false, bare = false }: {
  spec: ChartV2; height?: number; compact?: boolean; /** No title row (the host shows it). */ bare?: boolean;
}) {
  const t = useTokens();
  const option = useMemo(() => specOption(spec, t, { compact }), [spec, t, compact]);
  const [table, setTable] = useState(false);
  const tid = useId();
  const keys = labelMode(spec) === "key" ? keyEntries(spec, t) : [];
  const empty = spec.series.every((s) => !s.data.length);
  return (
    <figure className="spec">
      {!bare && (spec.title || spec.subtitle) && (
        <figcaption className="spec-cap">
          {spec.title && <span className="spec-t">{spec.title}</span>}
          {spec.subtitle && <span className="spec-sub">{spec.subtitle}</span>}
        </figcaption>
      )}
      {empty ? <p className="spec-empty">No data points in this chart.</p> : table
        ? <SpecTable spec={spec} id={tid} height={height} />
        : <EChart option={option} height={height} label={specLabel(spec)} />}
      <div className="spec-ft">
        {keys.length > 0 && !table && <SpecKey entries={keys} />}
        <span className="fill" />
        {!empty && (
          <button type="button" className="spec-tg mono" aria-expanded={table} aria-controls={table ? tid : undefined}
            onClick={() => setTable(!table)}>{table ? "Show chart" : "Show table"}</button>
        )}
      </div>
    </figure>
  );
}

function SpecKey({ entries }: { entries: KeyEntry[] }) {
  return (
    <ul className="spec-key" aria-label="Series">
      {entries.map((e, i) => (
        <li key={`${e.name}-${i}`}>
          <svg width="16" height="10" aria-hidden="true">
            {e.mark === "line" && <line x1="1" x2="15" y1="5" y2="5" stroke={e.shade} strokeWidth="1.5" strokeDasharray={e.dash === "dashed" ? "4 2" : e.dash === "dotted" ? "1.5 2" : undefined} />}
            {e.mark === "bar" && <rect x="2" y="1" width="12" height="8" fill={e.shade} fillOpacity={e.soft ? 0.5 : 1} stroke={e.soft ? e.shade : "var(--s-ink-3)"} strokeWidth={e.soft ? 1 : 0.5} />}
            {e.mark === "bar" && e.decal != null && e.decal > 0 && <path d={["", "M2 9 L10 1 M6 9 L14 1", "M5 5 h0.1 M10 5 h0.1", "M2 5 h4 M9 5 h4", "M2 1 L10 9 M6 1 L14 9"][e.decal]} stroke="var(--screen)" strokeWidth="1.2" strokeLinecap="round" />}
            {e.mark === "ring" && <circle cx="8" cy="5" r="3.2" fill="none" stroke={e.shade} strokeWidth="1.2" />}
            {e.mark === "band" && <rect x="1" y="1" width="14" height="8" fill={e.shade} stroke="var(--s-ink-3)" strokeWidth="0.5" strokeDasharray="1 1.5" />}
          </svg>
          <span>{e.name}</span>
        </li>
      ))}
    </ul>
  );
}

function SpecTable({ spec, id, height }: { spec: ChartV2; id: string; height: number }) {
  const { columns, rows } = useMemo(() => specTable(spec), [spec]);
  return (
    <div className="tbl-wrap spec-tbl" id={id} style={{ maxHeight: Math.max(height, 160) }} tabIndex={0} role="region" aria-label={`${spec.title || "Chart"} values`}>
      <table className="tbl">
        <thead><tr>{columns.map((c, i) => <th key={i} scope="col">{c}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((v, k) => k === 0 ? <th key={k} scope="row" className="mono">{v}</th> : <td key={k} className="mono">{v}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
