import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { readPref, writePref } from "../app/prefs";
import { Icon } from "../ui/Icon";
import { acceptOf, attReducer, canAttach, chipMeta, EMPTY, isImage, serverError, upload, uploading, readyMedia, type AttState } from "./attachments";
import { onPrefill } from "./prefill";
import { scopeChip, type ChatScope } from "./scope";
import type { AttachmentRules, Media } from "./types";

export function FileGlyph() {
  return (
    <svg className="att-ic" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M3.5 1.5h4.5l3 3v8h-7.5z M8 1.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function ClipGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10.5 4.5 5.6 9.4a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5 5a4.2 4.2 0 0 0 6 6l4.4-4.4" />
    </svg>
  );
}

let seq = 0;

/** Attachment chips for one thread: validate, upload with progress, remove (aborts an upload). */
export function useAttachments(tid: string, rules: AttachmentRules | undefined) {
  const [state, dispatch] = useReducer(attReducer, EMPTY);
  const aborts = useRef(new Map<string, () => void>());
  const stateRef = useRef<AttState>(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  const add = useCallback((files: File[]) => {
    if (!rules || !canAttach(rules) || !files.length) return;
    const keyed = files.map((f) => Object.assign(f, { key: `att-${++seq}` }));
    // Validate in the reducer first; only files that came out as "uploading" go to the server.
    const before = new Set(stateRef.current.chips.map((c) => c.key));
    const next = attReducer(stateRef.current, { type: "add", files: keyed, rules });
    dispatch({ type: "add", files: keyed, rules });
    for (const c of next.chips) {
      if (before.has(c.key) || c.status !== "uploading") continue;
      const file = keyed.find((f) => f.key === c.key)!;
      const up = upload(file, tid, (pct) => dispatch({ type: "progress", key: c.key, progress: pct }));
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
  }, [rules, tid]);
  const remove = useCallback((key: string) => {
    aborts.current.get(key)?.();
    dispatch({ type: "remove", key });
  }, []);
  const clear = useCallback(() => dispatch({ type: "clear" }), []);
  useEffect(() => () => { for (const a of aborts.current.values()) a(); }, []);
  return { state, add, remove, clear, enabled: canAttach(rules), rules };
}

export type Attachments = ReturnType<typeof useAttachments>;

export function Composer({ tid, scope, busy, att, composer, onSend, onStop }: {
  tid: string; scope: ChatScope; busy: boolean; att: Attachments;
  composer: React.RefObject<HTMLTextAreaElement | null>;
  onSend: (text: string, files: Media[]) => void; onStop: () => void;
}) {
  const [draft, setDraft] = useState<string>(() => readPref(`chat.draft.${tid}`, ""));
  useEffect(() => writePref(`chat.draft.${tid}`, draft), [tid, draft]);
  useEffect(() => onPrefill((text) => { setDraft(text); requestAnimationFrame(() => composer.current?.focus()); }), [composer]);
  const fileInput = useRef<HTMLInputElement>(null);
  const files = readyMedia(att.state);
  const pending = uploading(att.state);
  const can = !busy && !pending && (!!draft.trim() || files.length > 0);
  const errors = att.state.chips.filter((c) => c.status === "error").map((c) => c.error!);

  // Browsers without `field-sizing: content` grow the box by hand.
  useEffect(() => {
    const el = composer.current;
    if (!el || (typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content"))) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [draft, composer]);

  const send = () => {
    if (!can) return;
    onSend(draft.trim(), files);
    setDraft("");
    att.clear();
  };
  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
      <div className="cmp-box">
        <span className="scope-chip mono" title="Sent with this message">⌖ {scopeChip(scope)}</span>
        {att.state.chips.length > 0 && (
          <ul className="att-list" aria-label="Files to send">
            {att.state.chips.map((c) => (
              <li key={c.key} className={`att ${c.status}`} title={c.error ?? c.name}>
                {c.status === "ready" && c.media && isImage(c.type) ? <img className="att-thumb" src={c.media.url} alt="" /> : <FileGlyph />}
                <span className="att-n">{c.name}</span>
                <span className="att-m mono" aria-live={c.status === "uploading" ? "off" : "polite"}>{chipMeta(c)}</span>
                <button type="button" className="key sq flat att-x" aria-label={`Remove ${c.name}`} onClick={() => att.remove(c.key)}><Icon name="close" /></button>
              </li>
            ))}
          </ul>
        )}
        <textarea ref={composer} className="cmp-text" rows={1} value={draft} placeholder="Message"
          aria-label="Message the assistant" onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            const fs = [...e.clipboardData.files];
            if (fs.length && att.enabled) { e.preventDefault(); att.add(fs); }
          }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
      </div>
      {(errors.length > 0 || att.state.notice) && (
        <ul className="att-errs" role="alert">
          {att.state.notice && <li>{att.state.notice}</li>}
          {errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
      <div className="cmp-ft">
        {att.enabled && att.rules && (
          <>
            <input ref={fileInput} type="file" multiple hidden accept={acceptOf(att.rules)}
              onChange={(e) => { att.add([...(e.target.files ?? [])]); e.target.value = ""; }} />
            <button type="button" className="key sq flat cmp-clip" aria-label={att.rules.images ? "Attach images or PDFs" : "Attach PDFs"}
              title={att.rules.images ? "Attach images or PDFs" : "Attach PDFs"}
              disabled={att.state.chips.length >= att.rules.max_per_message}
              onClick={() => fileInput.current?.click()}><ClipGlyph /></button>
          </>
        )}
        {pending && <span className="mono cmp-hint up">Uploading…</span>}
        <span className="fill" />
        {busy
          ? <button type="button" className="key" onClick={onStop}><Icon name="stop" />Stop</button>
          : <button type="submit" className="key ink" disabled={!can}><Icon name="send" />Send</button>}
      </div>
    </form>
  );
}
