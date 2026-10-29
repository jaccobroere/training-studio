import { useRef, useState } from "react";
import type { Chip, Inbox, Workout } from "../api/types";
import { ChatKey } from "../app/ChatKey";
import { useDock } from "../app/dock";
import { usePublishScope } from "../chat/scope";
import { SkipForm } from "../plan/actions";
import { LinkMenu } from "../plan/LinkPicker";
import { useChange, useInbox, type ChangeVars } from "../plan/api";
import { actualValues, itemsLine } from "../plan/format";
import { Icon } from "../ui/Icon";
import { Popover } from "../ui/Popover";
import { dayLabel } from "../ui/dates";

type Rec = Inbox["recordings"][number];
const dd = (iso: string | null) => (iso ? dayLabel(iso).split(" ").slice(0, 2).join(" ") : "No day");

/** Optimistically drop a resolved row so the list and the nav badge update at once. */
const dropRec = (id: string): NonNullable<ChangeVars["patches"]>[number] => ({
  key: ["inbox"], apply: (d: Inbox) => ({ ...d, recordings: d.recordings.filter((r) => r.activity.id !== id), count: Math.max(0, d.count - 1) }),
});
const dropWorkout = (id: string): NonNullable<ChangeVars["patches"]>[number] => ({
  key: ["inbox"], apply: (d: Inbox) => ({ ...d, not_logged: d.not_logged.filter((w) => w.id !== id), count: Math.max(0, d.count - 1) }),
});

export function InboxPage() {
  const q = useInbox();
  usePublishScope({ page: "inbox", label: "Inbox" });
  const d = q.data;
  const ambiguous = d?.recordings.filter((r) => r.ambiguous) ?? [];
  const recs = d?.recordings.filter((r) => !r.ambiguous) ?? [];
  return (
    <div className="page inbox">
      <div className="strip" role="toolbar" aria-label="Inbox">
        <h1 className="page-t">Inbox</h1>
        {d && d.count > 0 && <span className="mono muted small">{d.count} to sort · last 4 weeks</span>}
        <span className="fill" />
        <ChatKey />
      </div>
      <div className="page-scroll">
        <div className="board narrow">
          {!d ? (q.isError ? <div className="state-err module" role="alert"><p>Couldn't load the inbox.</p><button className="key" onClick={() => q.refetch()}>Retry</button></div>
            : <div className="ib-skel">{Array.from({ length: 4 }, (_, i) => <div key={i} className="skel" style={{ height: 44 }} />)}</div>)
            : !d.count ? (
              <div className="inbox-zero">
                <p className="iz-t">Inbox is clear</p>
              </div>
            ) : <>
              {ambiguous.length > 0 && (
                <Section title="Which workout?" n={ambiguous.length}>
                  {ambiguous.map((r) => <RecordingRow key={r.activity.id} r={r} inline />)}
                </Section>
              )}
              {recs.length > 0 && (
                <Section title="Recordings to link" n={recs.length}>
                  {recs.map((r) => <RecordingRow key={r.activity.id} r={r} />)}
                </Section>
              )}
              {d.not_logged.length > 0 && (
                <Section title="Not logged" n={d.not_logged.length}>
                  {d.not_logged.map((w) => <NotLoggedRow key={w.id} w={w} />)}
                </Section>
              )}
            </>}
        </div>
      </div>
    </div>
  );
}

function Section({ title, n, hint, children }: { title: string; n: number; hint?: string; children: React.ReactNode }) {
  return (
    <section className="module ib-sec" aria-label={title}>
      <div className="module-hd"><h2>{title}</h2><span className="mono muted">{n}</span></div>
      {hint && <p className="ib-hint">{hint}</p>}
      <ul>{children}</ul>
    </section>
  );
}

const candLabel = (c: Chip) => `${c.title} · ${dd(c.date)}${c.time ? ` ${c.time}` : ""}`;

/** A recording that could belong to a workout: link it (best match first), keep it as
 * unplanned, or open it. Ambiguous ones show their candidates inline. */
function RecordingRow({ r, inline }: { r: Rec; inline?: boolean }) {
  const change = useChange();
  const dock = useDock();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const a = r.activity;
  const best = r.candidates[0];
  const link = (c: Chip) => change.mutate({
    ops: [{ op: "link_activity", activity_id: a.id, workout_id: c.id }], toast: `Linked ${a.name} to ${c.title}`, patches: [dropRec(a.id)],
  });
  const keep = () => change.mutate({
    ops: [{ op: "update_activity_annotations", id: a.id, kept_unplanned: true }], toast: `Kept ${a.name} as unplanned`, patches: [dropRec(a.id)],
  });
  return (
    <li className={`ib-row rec ${inline ? "amb" : ""}`}>
      <span className="act-mark" aria-hidden="true" />
      <span className="sport act">{a.mark}</span>
      <button className="ib-body what" onClick={() => dock.open({ kind: "log", activityId: a.id })} aria-label={`${a.name}, ${dayLabel(a.date)}. Open the recording`}>
        <span className="ib-t">{a.name}</span>
        <span className="ib-sub mono">{dd(a.date)} · {actualValues(a) || "No values"}</span>
      </button>
      <div className="ib-acts">
        {!inline && best && <button className="key" onClick={() => link(best)} title={`Link to ${candLabel(best)}`}><Icon name="link" /><span className="ib-k-t">{best.title}</span><span className="mono ib-k-d">{dd(best.date)}</span></button>}
        {!inline && (
          <button ref={ref} className="key sq flat" aria-haspopup="menu" aria-expanded={open} aria-label="Link to another workout" onClick={() => setOpen(!open)}><Icon name="down" /></button>
        )}
        <button className="key flat plain" onClick={keep}>Keep as unplanned</button>
      </div>
      {inline && (
        <div className="ib-cands" role="group" aria-label={`Link ${a.name} to`}>
          {r.candidates.map((c) => (
            <button key={c.id} className="key plain" onClick={() => link(c)}>
              <span className="mono muted">{c.mark}</span>{c.title}<span className="mono muted">{dd(c.date)}{c.time ? ` ${c.time}` : ""}</span>
            </button>
          ))}
        </div>
      )}
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} label="Link to a workout" width={290}>
        {open && <LinkMenu a={a} onDone={() => setOpen(false)} extra={{ patches: [dropRec(a.id)] }} />}
      </Popover>
    </li>
  );
}

/** A past workout with no log: ✓ Done, Skip…, or open it. */
function NotLoggedRow({ w }: { w: Workout }) {
  const change = useChange();
  const dock = useDock();
  const ref = useRef<HTMLButtonElement>(null);
  const [skip, setSkip] = useState(false);
  const done = () => change.mutate({ ops: [{ op: "log_workout", workout_id: w.id }], toast: `Logged ${w.title}`, patches: [dropWorkout(w.id)] });
  const skipIt = (reason: string) => change.mutate({
    ops: [{ op: "set_workout_status", id: w.id, status: "skipped", reason }], expected: { [`workout:${w.id}`]: w.version },
    toast: `Skipped ${w.title}`, patches: [dropWorkout(w.id)],
  });
  return (
    <li className="ib-row">
      <span />
      <span className="sport">{w.mark}</span>
      <button className="ib-body what" onClick={() => dock.open({ kind: "editor", id: w.id })} aria-label={`${w.title}, ${w.date ? dayLabel(w.date) : "no day"}. Open`}>
        <span className="ib-t">{w.title}</span>
        <span className="ib-sub mono">{dd(w.date)}{w.time ? ` ${w.time}` : ""}{w.items.length ? ` · ${itemsLine(w.items, 2)}` : ""}</span>
      </button>
      <div className="ib-acts">
        <button className="key sq check" aria-label={`Mark ${w.title} done`} title="Done" onClick={done}><Icon name="check" /></button>
        <button ref={ref} className="key flat plain" aria-haspopup="dialog" aria-expanded={skip} onClick={() => setSkip(!skip)}>Skip…</button>
      </div>
      <Popover anchor={ref} open={skip} onClose={() => setSkip(false)} label={`Skip ${w.title}`} width={264}>
        <SkipForm onSkip={(reason) => { setSkip(false); skipIt(reason); }} />
      </Popover>
    </li>
  );
}
