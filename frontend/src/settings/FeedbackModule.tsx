import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { FileGlyph } from "../chat/Composer";
import { attReducer, chipMeta, EMPTY, readyMedia, serverError, uploadTo, uploading, type AttState } from "../chat/attachments";
import type { AttachmentRules, Media } from "../chat/types";
import { Icon } from "../ui/Icon";
import { shortDate } from "../ui/dates";
import { useToast } from "../ui/toast";

type Kind = "bug" | "idea" | "other";

interface Recent {
  id: string;
  kind: Kind;
  message: string;
  created_at: string;
  state: "queued" | "sent" | "failed";
  attachments: number;
}

/** Screenshots only, three per note. The server re-encodes them and strips metadata. */
const SHOT_RULES: AttachmentRules = {
  images: true, pdf: false, max_per_message: 3, max_mb: 20,
  types: ["image/png", "image/jpeg", "image/webp", "image/heic"],
};
const SHOT_ACCEPT = "image/png,image/jpeg,image/webp,image/heic,.heic";

let seq = 0;

/** The chat composer's chip logic, uploading to the feedback endpoint instead. */
function useScreenshots() {
  const [state, dispatch] = useReducer(attReducer, EMPTY);
  const aborts = useRef(new Map<string, () => void>());
  const stateRef = useRef<AttState>(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  const add = useCallback((files: File[]) => {
    if (!files.length) return;
    const keyed = files.map((f) => Object.assign(f, { key: `shot-${++seq}` }));
    const before = new Set(stateRef.current.chips.map((c) => c.key));
    const next = attReducer(stateRef.current, { type: "add", files: keyed, rules: SHOT_RULES, per: "per note" });
    // Two pastes can land before React re-renders: count the first one's chips at once.
    stateRef.current = next;
    dispatch({ type: "add", files: keyed, rules: SHOT_RULES, per: "per note" });
    for (const c of next.chips) {
      if (before.has(c.key) || c.status !== "uploading") continue;
      const file = keyed.find((f) => f.key === c.key)!;
      const up = uploadTo("/api/feedback/attachments", file, {}, (pct) => dispatch({ type: "progress", key: c.key, progress: pct }));
      aborts.current.set(c.key, up.abort);
      up.promise
        .then((media: Media) => dispatch({ type: "done", key: c.key, media }))
        .catch((e: { status: number; code: string }) => {
          if (e.code === "aborted") return;
          const [short, error] = serverError(file.name, e.status, e.code);
          dispatch({ type: "fail", key: c.key, short, error });
        })
        .finally(() => aborts.current.delete(c.key));
    }
  }, []);
  const remove = useCallback((key: string) => {
    aborts.current.get(key)?.();
    dispatch({ type: "remove", key });
  }, []);
  const clear = useCallback(() => dispatch({ type: "clear" }), []);
  useEffect(() => () => { for (const a of aborts.current.values()) a(); }, []);
  return { state, add, remove, clear };
}

const LABEL: Record<Kind, string> = { bug: "Bug", idea: "Idea", other: "Other" };
const STATE: Record<Recent["state"], string> = {
  queued: "waiting to send",
  sent: "sent",
  failed: "couldn't send",
};

/** Settings → Account → Feedback. The note is stored in this account's database
 * first; when the server has a feedback webhook configured, the background outbox
 * forwards it there. No training/health data is attached unless the athlete writes it. */
export function FeedbackModule() {
  const toast = useToast();
  const qc = useQueryClient();
  const [kind, setKind] = useState<Kind>("bug");
  const [message, setMessage] = useState("");
  const [includeContext, setIncludeContext] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [pollUntil, setPollUntil] = useState(0);
  const shots = useScreenshots();
  const shotInput = useRef<HTMLInputElement>(null);
  const shotsPending = uploading(shots.state);
  const shotErrors = shots.state.chips.filter((c) => c.status === "error").map((c) => c.error!);
  const recent = useQuery({
    queryKey: ["feedback-recent"],
    queryFn: () => api<Recent[]>("/api/feedback"),
    // After a retry the background outbox sends within a few seconds; poll briefly so
    // "waiting to send" becomes "sent" without a manual refresh.
    refetchInterval: () => (Date.now() < pollUntil ? 4000 : false),
  });

  const retry = async (id: string) => {
    setRetrying(id);
    try {
      await api<{ id: string; state: string }>(`/api/feedback/${id}/retry`, {
        method: "POST",
      });
      setPollUntil(Date.now() + 20000);
      toast({ text: "Queued again — it will send within a few seconds." });
      void qc.invalidateQueries({ queryKey: ["feedback-recent"] });
    } catch (e2) {
      toast({ text: e2 instanceof ApiError ? e2.message : "Can't retry that note." });
    } finally {
      setRetrying(null);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await api<{ id: string; queued: boolean; remaining: number }>("/api/feedback", {
        method: "POST",
        json: {
          kind,
          message,
          include_context: includeContext,
          path: window.location.pathname,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
          user_agent: navigator.userAgent,
          attachments: readyMedia(shots.state).map((m) => m.id),
        },
      });
      setMessage("");
      shots.clear();
      toast({
        text: r.queued
          ? `Thanks — sent to the feedback queue. ${r.remaining} left today.`
          : "Thanks — saved. Forwarding is off in this environment.",
      });
      void qc.invalidateQueries({ queryKey: ["feedback-recent"] });
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : "Can't reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="module">
      <div className="module-hd"><h2>Feedback</h2><span className="fill" /><span className="mono muted small">to the operator</span></div>
      <div className="module-bd sec">
        <form id="acct-feedback" className="plan-form" onSubmit={submit}>
          <fieldset className="field-l"><legend className="silk">What kind?</legend>
            <div className="seg">
              {(Object.keys(LABEL) as Kind[]).map((k) => (
                <button type="button" key={k} className={`key ${kind === k ? "is-on" : ""}`} aria-pressed={kind === k} onClick={() => setKind(k)}>{LABEL[k]}</button>
              ))}
            </div>
          </fieldset>
          <label className="field-l"><span className="silk">What happened, or what would help?</span>
            <textarea className="textarea" rows={5} maxLength={4000} required value={message}
              placeholder="Be as specific as you like: what you did, what you expected, and what happened."
              onChange={(e) => setMessage(e.target.value)}
              onPaste={(e) => {
                const fs = [...e.clipboardData.files];
                if (fs.length) { e.preventDefault(); shots.add(fs); }
              }} /></label>
          <div className="field-l">
            <span className="silk">Screenshots <span className="muted">(optional, up to 3)</span></span>
            {shots.state.chips.length > 0 && (
              <ul className="att-list" aria-label="Screenshots to send">
                {shots.state.chips.map((c) => (
                  <li key={c.key} className={`att ${c.status}`} title={c.error ?? c.name}>
                    {c.status === "ready" && c.media ? <img className="att-thumb" src={c.media.url} alt="" /> : <FileGlyph />}
                    <span className="att-n">{c.name}</span>
                    <span className="att-m mono" aria-live={c.status === "uploading" ? "off" : "polite"}>{chipMeta(c)}</span>
                    <button type="button" className="key sq flat att-x" aria-label={`Remove ${c.name}`} onClick={() => shots.remove(c.key)}><Icon name="close" /></button>
                  </li>
                ))}
              </ul>
            )}
            {(shotErrors.length > 0 || shots.state.notice) && (
              <ul className="att-errs" role="alert">
                {shots.state.notice && <li>{shots.state.notice}</li>}
                {shotErrors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            )}
            <input ref={shotInput} type="file" multiple hidden accept={SHOT_ACCEPT}
              onChange={(e) => { shots.add([...(e.target.files ?? [])]); e.target.value = ""; }} />
            <div>
              <button type="button" className="key" disabled={shots.state.chips.length >= SHOT_RULES.max_per_message}
                onClick={() => shotInput.current?.click()}>Add screenshot</button>
            </div>
          </div>
          <label className="chk small"><input type="checkbox" checked={includeContext} onChange={(e) => setIncludeContext(e.target.checked)} /> Include this page, browser, app version and your account name</label>
          <p className="muted small">It goes to the person who runs this server and may be triaged by an AI assistant. Your training and health data are never attached automatically. Don't include anything you don't want an assistant to read.</p>
          {shots.state.chips.length > 0 && (
            <p className="muted small">Screenshots can show your training and health data. They are shrunk and stripped of photo metadata, then sent with the note to wherever the person who runs this server receives feedback, and to the AI assistant (a cloud model) that triages it. This app deletes its copy a week after sending; ask the operator how long they keep theirs.</p>
          )}
          {err && <p className="auth-err" role="alert">{err}</p>}
        </form>
        {!!recent.data?.length && (
          <details>
            <summary className="muted small">Recent notes</summary>
            <ul className="plain-list">
              {recent.data.map((r) => (
                <li key={r.id}>
                  <span className="tag">{LABEL[r.kind]}</span>
                  <span className="small">{r.message.length > 80 ? `${r.message.slice(0, 80)}…` : r.message}</span>
                  {r.attachments > 0 && <span className="mono small muted">+{r.attachments} {r.attachments === 1 ? "screenshot" : "screenshots"}</span>}
                  <span className="fill" />
                  {r.state === "failed" && (
                    <button
                      type="button"
                      className="key plain"
                      disabled={retrying === r.id}
                      onClick={() => void retry(r.id)}
                    >
                      {retrying === r.id ? "Retrying…" : "Retry"}
                    </button>
                  )}
                  <span className="mono small muted">{STATE[r.state]} · {shortDate(r.created_at.slice(0, 10))}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <div className="module-ft">
        <button className="key ink" type="submit" form="acct-feedback" disabled={busy || shotsPending || message.trim().length < 3}>{shotsPending ? "Uploading…" : "Send feedback"}</button>
      </div>
    </section>
  );
}
