/** One progress line for any background job: a label with the percentage, a bar and Cancel.
 * Shared by the connection, backfill and import modules. */
export function Progress({ label, frac, onCancel }: { label: string; frac: number | null; onCancel?: () => void }) {
  return (
    <div className="progress" role="status">
      <span className="mono small">{label}{frac != null ? ` · ${Math.round(frac * 100)}%` : "…"}</span>
      <span className="pbar"><i style={{ width: `${Math.round((frac ?? 0.05) * 100)}%` }} className={frac == null ? "indet" : ""} /></span>
      {onCancel && <button className="key flat" onClick={onCancel}>Cancel</button>}
    </div>
  );
}
