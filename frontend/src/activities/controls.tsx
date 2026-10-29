import "./activities.css";
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

export interface Opt { key: string; label: string }

/** Segmented control with roving tabindex and arrow keys. `tab` = a tablist (selected, not
 * checked); otherwise a radiogroup. Keys are 44px on touch widths (see activity.css). */
export function Seg({ label, options, value, onChange, tab, className = "" }: {
  label: string; options: Opt[]; value: string; onChange: (k: string) => void; tab?: boolean; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const move = (e: KeyboardEvent, i: number) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const j = (i + d + options.length) % options.length;
    onChange(options[j].key);
    ref.current?.querySelectorAll<HTMLElement>("button")[j]?.focus();
  };
  return (
    <div ref={ref} className={`seg ${className}`} role={tab ? "tablist" : "radiogroup"} aria-label={label}>
      {options.map((o, i) => {
        const on = o.key === value;
        return (
          <button type="button" key={o.key} className={`key ${on ? "is-on" : ""}`} tabIndex={on ? 0 : -1}
            {...(tab ? { role: "tab", "aria-selected": on, id: `av-tab-${o.key}`, "aria-controls": "av-panel" } : { role: "radio", "aria-checked": on })}
            onClick={() => onChange(o.key)} onKeyDown={(e) => move(e, i)}>{o.label}</button>
        );
      })}
    </div>
  );
}

/** A choice among many: every option as one segmented row when there is room, and on a phone
 * the few common ones as keys plus a "More" key that opens the system picker (a native select
 * laid over the key, so it gets the OS sheet, search and accessibility for free). */
export function Choice({ label, options, primary, value, onChange }: {
  label: string; options: Opt[]; primary: string[]; value: string; onChange: (k: string) => void;
}) {
  const id = useId();
  const quick = options.filter((o) => primary.includes(o.key));
  const more = options.filter((o) => !primary.includes(o.key));
  const picked = more.find((o) => o.key === value);
  return (
    <>
      <Seg label={label} options={options} value={value} onChange={onChange} className="ch-wide" />
      <div className="ch-narrow">
        <Seg label={label} options={quick} value={primary.includes(value) ? value : ""} onChange={onChange} />
        {more.length > 0 && (
          <label className={`key more ${picked ? "is-on" : ""}`} htmlFor={id}>
            <span>{picked ? picked.label : "More"}</span>
            <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" /></svg>
            <select id={id} value={picked ? picked.key : ""} aria-label={`${label}: more options`} onChange={(e) => e.target.value && onChange(e.target.value)}>
              <option value="" disabled>More…</option>
              {more.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </label>
        )}
      </div>
    </>
  );
}

/** A disclosure panel: a 48px header row (title, a one-line hint of what is inside, a chevron),
 * the body on open. Native <details>, so it is keyboard and screen-reader complete. */
export function Fold({ title, hint, open, children }: { title: string; hint?: ReactNode; open: boolean; children: ReactNode }) {
  return (
    <details className="screen chart-screen fold" open={open}>
      <summary>
        <span className="silk">{title}</span>
        {hint != null && <span className="fold-hint mono">{hint}</span>}
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" /></svg>
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}

/** One short line, and the longer explanation (by default "how this is measured") behind a disclosure. */
export function Note({ children, more, title = "How this is measured" }: { children: ReactNode; more?: ReactNode; title?: string }) {
  return (
    <div className="chart-note">
      <p>{children}</p>
      {more && <details className="note-more"><summary>{title}</summary><p>{more}</p></details>}
    </div>
  );
}
