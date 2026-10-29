import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { addMonths, fieldDate, monthGrid, monthTitle, parseTime, shiftMonth } from "./calendar";
import { addDays, todayIso } from "./dates";
import { Icon } from "./Icon";
import { Popover } from "./Popover";

const DOW1 = ["M", "T", "W", "T", "F", "S", "S"];
const DOWL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Month grid date picker (Monday first, en-GB). Arrow keys move a day/week, PageUp/PageDown a
 * month, Home/End the week's ends, Enter picks. Used inline and inside `DateField`. */
export function Calendar({ value, onPick, min, max, today, marks, label = "Choose a date", autoFocus = true }: {
  value: string | null; onPick: (iso: string) => void; min?: string; max?: string; today?: string;
  /** Dates to underline (e.g. the selection's current days). */
  marks?: Set<string>; label?: string; autoFocus?: boolean;
}) {
  const t = today ?? todayIso();
  const [focus, setFocus] = useState(value ?? t);
  const [ym, setYm] = useState<[number, number]>(() => [Number(focus.slice(0, 4)), Number(focus.slice(5, 7)) - 1]);
  const grid = monthGrid(ym[0], ym[1]);
  const ref = useRef<HTMLDivElement>(null);
  const keyNav = useRef(false);
  const out = (d: string) => (min && d < min) || (max && d > max);

  useEffect(() => {
    if (!keyNav.current && !autoFocus) return;
    keyNav.current = false;
    ref.current?.querySelector<HTMLButtonElement>(`[data-d="${focus}"]`)?.focus({ preventScroll: true });
  }, [focus, ym, autoFocus]);

  const move = (d: string) => {
    keyNav.current = true;
    setFocus(d);
    const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)) - 1;
    if (y !== ym[0] || m !== ym[1]) setYm([y, m]);
  };
  const onKey = (e: KeyboardEvent) => {
    const k = e.key;
    const map: Record<string, () => string> = {
      ArrowLeft: () => addDays(focus, -1), ArrowRight: () => addDays(focus, 1),
      ArrowUp: () => addDays(focus, -7), ArrowDown: () => addDays(focus, 7),
      PageUp: () => addMonths(focus, -1), PageDown: () => addMonths(focus, 1),
      Home: () => addDays(focus, -((new Date(`${focus}T00:00:00Z`).getUTCDay() + 6) % 7)),
      End: () => addDays(focus, 6 - ((new Date(`${focus}T00:00:00Z`).getUTCDay() + 6) % 7)),
    };
    if (map[k]) { e.preventDefault(); move(map[k]()); }
  };
  const page = (n: number) => {
    const [y, m] = shiftMonth(ym[0], ym[1], n);
    setYm([y, m]);
    setFocus(`${y}-${String(m + 1).padStart(2, "0")}-${focus.slice(8, 10) > "28" ? "28" : focus.slice(8, 10)}`);
  };
  return (
    <div className="cal" ref={ref} role="group" aria-label={label}>
      <div className="cal-hd">
        <button type="button" className="key sq flat" aria-label="Previous month" onClick={() => page(-1)}><Icon name="prev" /></button>
        <span className="cal-t" aria-live="polite">{monthTitle(ym[0], ym[1])}</span>
        <button type="button" className="key sq flat" aria-label="Next month" onClick={() => page(1)}><Icon name="next" /></button>
      </div>
      {/* Roving tabindex: the focusable cells live inside the grid (ARIA grid pattern). */}
      {/* eslint-disable-next-line jsx-a11y/interactive-supports-focus */}
      <div className="cal-grid" role="grid" onKeyDown={onKey}>
        <div className="cal-row" role="row">
          {DOW1.map((d, i) => <span key={i} role="columnheader" className="cal-dow" aria-label={DOWL[i]}>{d}</span>)}
        </div>
        {Array.from({ length: 6 }, (_, r) => (
          <div className="cal-row" role="row" key={r}>
            {grid.slice(r * 7, r * 7 + 7).map((d) => {
              const inMonth = Number(d.slice(5, 7)) - 1 === ym[1];
              const cls = ["cal-d", inMonth ? "" : "other", d === value ? "on" : "", d === t ? "today" : "", marks?.has(d) ? "mark" : ""].join(" ");
              return (
                <button key={d} type="button" role="gridcell" data-d={d} className={cls} tabIndex={d === focus ? 0 : -1}
                  disabled={!!out(d)} aria-selected={d === value} aria-current={d === t ? "date" : undefined}
                  aria-label={fieldDate(d)} onClick={() => onPick(d)}>
                  {Number(d.slice(8))}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A date field that always reads "Thu 15 Oct 2026" (the native date input follows the
 * browser's locale, so it showed US dates). Opens the calendar in a popover. */
export function DateField({ value, onChange, disabled, min, max, label, placeholder = "Pick a date", allowClear, today, id, className }: {
  value: string | null; onChange: (iso: string | null) => void; disabled?: boolean; min?: string; max?: string;
  label: string; placeholder?: string; allowClear?: boolean; today?: string; id?: string; className?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <span className={`datef ${className ?? ""}`}>
      <button ref={ref} id={id} type="button" className="input datef-k" disabled={disabled} aria-haspopup="dialog" aria-expanded={open}
        aria-label={`${label}: ${value ? fieldDate(value) : "none"}. Change`} onClick={() => setOpen(!open)}>
        <span className={`mono ${value ? "" : "ph"}`}>{value ? fieldDate(value, value.slice(0, 4) !== (today ?? todayIso()).slice(0, 4)) : placeholder}</span>
        <Icon name="cal" />
      </button>
      {allowClear && value && !disabled && (
        <button type="button" className="key sq flat" aria-label={`Clear ${label.toLowerCase()}`} onClick={() => onChange(null)}><Icon name="close" /></button>
      )}
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} label={label} align="start" width={262}>
        <Calendar value={value} min={min} max={max} today={today} label={label}
          onPick={(d) => { onChange(d); setOpen(false); ref.current?.focus(); }} />
      </Popover>
    </span>
  );
}

/** 24-hour time as text ("19:30"). Accepts "1930", "7.30", "7"; normalises on blur. */
export function TimeField({ value, onChange, disabled, label = "Start time (optional)", className }: {
  value: string | null; onChange: (t: string | null) => void; disabled?: boolean; label?: string; className?: string;
}) {
  const [raw, setRaw] = useState(value ?? "");
  const [bad, setBad] = useState(false);
  useEffect(() => { setRaw(value ?? ""); setBad(false); }, [value]);
  const commit = () => {
    const p = parseTime(raw);
    if (p === undefined) { setBad(true); return; }
    setBad(false);
    setRaw(p ?? "");
    if (p !== value) onChange(p);
  };
  return (
    <input className={`input mono time-in ${bad ? "invalid" : ""} ${className ?? ""}`} inputMode="numeric" placeholder="--:--" maxLength={5}
      aria-label={label} title={bad ? "Use 24-hour time, e.g. 19:30" : label} aria-invalid={bad} disabled={disabled}
      value={raw} onChange={(e) => { setRaw(e.target.value); setBad(false); }} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} />
  );
}
