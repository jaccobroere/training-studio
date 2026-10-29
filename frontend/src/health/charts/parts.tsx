export const fmt = (v: number | null | undefined, digits?: number) => {
  if (v == null || Number.isNaN(v)) return "—";
  const d = digits ?? (Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2);
  return Number(v.toFixed(d)).toLocaleString("en-GB");
};

/** Whole seconds, rounded once, so 59.6 s carries to the next minute (never ":60"). */
function clockParts(secs: number) {
  const total = Math.max(0, Math.round(secs));
  return { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60), s: total % 60 };
}

/** "5:31" — minutes and seconds, no hours. */
export const mmss = (secs: number | null | undefined) => {
  if (secs == null || !Number.isFinite(secs)) return "—";
  const { m, s } = clockParts(secs);
  return `${m}:${String(s).padStart(2, "0")}`;
};

export const paceStr = (secPerKm: number | null | undefined) =>
  (!secPerKm || !Number.isFinite(secPerKm) ? "—" : mmss(secPerKm));

export const hms = (secs: number | null | undefined) => {
  if (secs == null) return "—";
  const { h, m, s } = clockParts(secs);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
};

/** One readout cell: label, value, unit (inline, behind the value) and note (its own line below). */
export type ReadoutItem = [label: string, value: string, unit?: string, note?: string, sig?: boolean];

/** Instrument readout strip: label / value / unit (inline) / note (below). The primary way to read a chart. */
export function Readout({ items, compact }: { items: ReadoutItem[]; compact?: boolean }) {
  return (
    <dl className={`readout ${compact ? "compact" : ""}`}>
      {items.map(([k, v, u, n, sig]) => (
        <div key={k} className={sig ? "sig" : undefined}><dt>{k}</dt><dd>{v}{u ? <small className="unit">{u}</small> : null}{n ? <small className="note">{n}</small> : null}</dd></div>
      ))}
    </dl>
  );
}

export function Unavailable({ what, why }: { what: string; why: string }) {
  return (
    <div className="unavail" role="note" aria-label={`${what}: no data`}>
      <p>{why}</p>
    </div>
  );
}

export function Spark({ values, w = 120, h = 22 }: { values: (number | null)[]; w?: number; h?: number }) {
  const vals = values.filter((v): v is number => v != null);
  if (vals.length < 2) return <svg width={w} height={h} aria-hidden="true" />;
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const x = (i: number) => (i / (values.length - 1)) * (w - 4) + 2;
  const y = (v: number) => h - 2 - ((v - lo) / span) * (h - 4);
  let d = "", pen = false;
  values.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  const lastI = values.length - 1 - [...values].reverse().findIndex((v) => v != null);
  return (
    <svg width={w} height={h} aria-hidden="true" className="spark">
      <path d={d} fill="none" stroke="var(--s-ink)" strokeWidth={1} />
      <circle cx={x(lastI)} cy={y(values[lastI] as number)} r={2} fill="var(--s-ink)" />
    </svg>
  );
}

/** On touch screens the tooltip sits at the top of the plot, centred on the tap, so a finger never covers it. */
export function touchTip(): Record<string, unknown> {
  if (typeof matchMedia === "undefined" || !matchMedia("(pointer: coarse)").matches) return {};
  return {
    position: (pt: number[], _p: unknown, _d: unknown, _r: unknown, size: { contentSize: number[]; viewSize: number[] }) =>
      [Math.max(0, Math.min(pt[0] - size.contentSize[0] / 2, size.viewSize[0] - size.contentSize[0])), 0],
  };
}
