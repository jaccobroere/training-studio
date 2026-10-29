import { useId, useState } from "react";
import { DateField } from "../ui/DateField";
import type { Media } from "../api/types";
import { useTags } from "../plan/api";
import { DOW, DOW1 } from "../plan/dates";
import { autoFocus } from "../ui/autoFocus";
import { Icon } from "../ui/Icon";
import { dayLabel } from "../ui/dates";
import { repeatSummary, type Repeat } from "./model";

const norm = (t: string) => t.trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-").slice(0, 30);

/** Token input: existing tags with ×, typing suggests tags in use, Enter creates. */
export function TagInput({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [v, setV] = useState("");
  const all = useTags();
  const id = useId();
  const term = norm(v);
  const sugg = (all.data ?? []).map((t) => t.tag).filter((t) => !tags.includes(t) && (!term || t.includes(term))).slice(0, 6);
  const add = (t: string) => {
    const x = norm(t);
    if (x && !tags.includes(x) && tags.length < 20) onChange([...tags, x]);
    setV("");
  };
  return (
    <div className="tag-input">
      <ul className="tag-list">
        {tags.map((t) => (
          <li key={t} className="tag tok">#{t}<button aria-label={`Remove tag ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}>×</button></li>
        ))}
        <li className="tok-in">
          <input className="input" value={v} placeholder="Add tag" aria-label="Add tag" list={id}
            onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === ",") && v.trim()) { e.preventDefault(); add(v); }
              if (e.key === "Backspace" && !v && tags.length) onChange(tags.slice(0, -1));
            }}
            onBlur={() => v.trim() && add(v)} />
          <datalist id={id}>{sugg.map((t) => <option key={t} value={t} />)}</datalist>
        </li>
      </ul>
      {!v && sugg.length > 0 && tags.length < 3 && (
        <div className="tag-sugg">{sugg.slice(0, 4).map((t) => <button key={t} className="tag sugg" onClick={() => add(t)}>+ #{t}</button>)}</div>
      )}
    </div>
  );
}

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

/** Links (and stored images): open in a new tab, × removes, "+ Add link" reveals one input. */
export function MediaList({ media, onChange }: { media: Media[]; onChange: (m: Media[]) => void }) {
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const valid = /^https?:\/\/\S+\.\S+/.test(url.trim());
  const add = () => {
    if (!valid) return;
    onChange([...media, { kind: "link", url: url.trim(), title: title.trim() }]);
    setUrl(""); setTitle(""); setAdding(false);
  };
  return (
    <div className="media">
      {media.length > 0 && (
        <ul className="media-list">
          {media.map((m, i) => (
            <li key={i} className="media-row">
              {m.kind === "image"
                ? <img src={`/api/media/${m.file}`} alt="" className="thumb" />
                : <Icon name="link" />}
              {m.kind === "link"
                ? <a href={m.url} target="_blank" rel="noreferrer noopener" className="m-title">{m.title || host(m.url)}</a>
                : <span className="m-title">{m.title || "Image"}</span>}
              {m.kind === "link" && <span className="m-host mono">{host(m.url)}</span>}
              <button className="key sq flat" aria-label={`Remove ${m.title || "link"}`} onClick={() => onChange(media.filter((_, j) => j !== i))}><Icon name="close" /></button>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <div className="media-add">
          <input className="input mono" ref={autoFocus} value={url} placeholder="https://…" aria-label="Link URL" onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } if (e.key === "Escape") { e.stopPropagation(); setAdding(false); } }} />
          <input className="input" value={title} placeholder="Title" aria-label="Link title" onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
          <div className="row">
            <button className="key flat" onClick={() => setAdding(false)}>Cancel</button>
            <button className="key" disabled={!valid} onClick={add}>Add link</button>
          </div>
        </div>
      ) : (
        <button className="key plain add-link" onClick={() => setAdding(true)}><Icon name="plus" />Add link</button>
      )}
    </div>
  );
}

/** One summary key that opens inline to Off|Weekly, every N weeks, weekday keys, until. */
export function RepeatField({ value, onChange, disabled, defaultDay, defaultOpen, time }: {
  value: Repeat; onChange: (r: Repeat) => void; disabled?: string; defaultDay: number; defaultOpen?: boolean; time?: string | null;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const set = (p: Partial<Repeat>) => onChange({ ...value, ...p });
  const summary = repeatSummary(value, (d) => dayLabel(d).split(" ").slice(1).join(" "), time);
  return (
    <div className={`repeat ${open ? "open" : ""}`}>
      <button className="repeat-sum" aria-expanded={open} onClick={() => setOpen(!open)} disabled={!!disabled}>
        <span className="silk">Repeat</span>
        <span className="rs-v">{disabled ?? summary}</span>
        {!disabled && <Icon name={open ? "up" : "down"} />}
      </button>
      {open && !disabled && (
        <div className="repeat-bd">
          <div className="seg" role="radiogroup" aria-label="Repeat">
            <button role="radio" aria-checked={!value.on} className={`key ${!value.on ? "is-on" : ""}`} onClick={() => set({ on: false })}>Off</button>
            <button role="radio" aria-checked={value.on} className={`key ${value.on ? "is-on" : ""}`}
              onClick={() => set({ on: true, weekdays: value.weekdays.length ? value.weekdays : [defaultDay] })}>Weekly</button>
          </div>
          {value.on && <>
            <div className="rep-every">
              <span>Every</span>
              <div className="stepper">
                <button className="key sq" aria-label="Fewer weeks" disabled={value.interval <= 1} onClick={() => set({ interval: value.interval - 1 })}>−</button>
                <span className="mono" aria-live="polite">{value.interval}</span>
                <button className="key sq" aria-label="More weeks" disabled={value.interval >= 8} onClick={() => set({ interval: value.interval + 1 })}>+</button>
              </div>
              <span>{value.interval === 1 ? "week" : "weeks"} on</span>
            </div>
            <div className="days7" role="group" aria-label="Weekdays">
              {DOW1.map((d, i) => {
                const on = value.weekdays.includes(i);
                return (
                  <button key={i} className={`key sq ${on ? "is-on" : ""}`} aria-pressed={on} aria-label={DOW[i]}
                    onClick={() => set({ weekdays: on ? (value.weekdays.length > 1 ? value.weekdays.filter((x) => x !== i) : value.weekdays) : [...value.weekdays, i] })}>{d}</button>
                );
              })}
            </div>
            <div className="field-l rep-until"><span className="silk">Until</span>
              <DateField value={value.until} label="Until" placeholder="No end date" allowClear onChange={(v) => set({ until: v })} />
            </div>
          </>}
        </div>
      )}
    </div>
  );
}
