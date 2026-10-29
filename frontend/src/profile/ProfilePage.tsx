import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, ApiError } from "../api/client";
import type { ChangeResult, ProfileT, ProfileVersion } from "../api/types";
import { ChatKey } from "../app/ChatKey";
import { useMobile } from "../app/useMedia";
import { usePublishScope } from "../chat/scope";
import { describeError, refreshPlan, useUndo } from "../plan/api";
import { Icon } from "../ui/Icon";
import { useToast } from "../ui/toast";
import { lineDiff } from "./diff";
import { isPrompt, promptText, settlePrompts } from "./prompts";

const useProfile = () => useQuery({ queryKey: ["profile"], queryFn: () => api<ProfileT>("/api/profile") });
const who = (s: string) => (s === "chat" ? "assistant" : s === "system" ? "template" : s === "undo" ? "undo" : "you");
const when = (at: string) => new Date(at).toLocaleString("en-GB", { timeZone: "Europe/Amsterdam", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function ProfilePage({ embedded = false }: { embedded?: boolean }) {
  const q = useProfile();
  usePublishScope({ page: "profile", label: "Profile" });
  if (!q.data) {
    return (
      <div className={embedded ? "profile settings-profile" : "page profile"}>
        {!embedded && <div className="strip"><h1 className="page-t">Profile</h1></div>}
        {q.isError ? <div className="board"><div className="state-err module" role="alert"><p>Couldn't load your profile.</p><button className="key" onClick={() => q.refetch()}>Retry</button></div></div>
          : <div className="board"><div className="skel" style={{ height: 320, maxWidth: 760, margin: "20px auto" }} /></div>}
      </div>
    );
  }
  return <Profile p={q.data} key={q.data.current?.version ?? 0} embedded={embedded} />;
}

const HEAD = /^#{1,6}\s/;

/** A prompt line keeps every character (so the caret lines up) but greys out the markers. */
function PromptLine({ line }: { line: string }) {
  const m = /^(\s*<!--\s*)(.*?)(\s*-->\s*)$/.exec(line);
  if (!m) return <>{line}</>;
  return <><span className="mk">{m[1]}</span>{m[2]}<span className="mk">{m[3]}</span></>;
}

/** A textarea that grows with its text, over a mirror that greys out the template prompts. */
function Editor({ value, onChange }: { value: string; onChange: (v: string, caret: number) => void }) {
  const ta = useRef<HTMLTextAreaElement>(null);
  return (
    <div className="md-ed">
      <div className="md-mirror" aria-hidden="true">
        {value.split("\n").map((l, i) => (
          <div key={i} className={isPrompt(l) ? "pr" : HEAD.test(l) ? "h" : ""}>{isPrompt(l) ? <PromptLine line={l} /> : HEAD.test(l) ? <><span className="mk">{l.match(HEAD)![0]}</span>{l.replace(HEAD, "")}</> : l || "\u200b"}</div>
        ))}
        <div>{"\u200b"}</div>
      </div>
      <textarea ref={ta} className="md-ta" value={value} spellCheck aria-label="Profile (Markdown)"
        onChange={(e) => onChange(e.target.value, e.target.selectionStart)} />
    </div>
  );
}

function Profile({ p, embedded }: { p: ProfileT; embedded: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const undo = useUndo();
  const mobile = useMobile();
  const start = p.current?.markdown ?? p.template ?? "";
  const [text, setText] = useState(start);
  const [base, setBase] = useState(start);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [versions, setVersions] = useState(false);
  const [busy, setBusy] = useState(false);
  const caretFix = useRef<number | null>(null);
  const dirty = text !== base;

  useLayoutEffect(() => {
    if (caretFix.current == null) return;
    const el = document.querySelector<HTMLTextAreaElement>(".md-ta");
    el?.setSelectionRange(caretFix.current, caretFix.current);
    caretFix.current = null;
  });
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); void save(); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const edit = (v: string, caret: number) => {
    const r = settlePrompts(v, caret);
    if (r.shift) caretFix.current = caret - r.shift;
    setText(r.text);
  };
  const done = (r: ChangeResult, verb: string) => {
    refreshPlan(qc);
    if (r.applied && r.change_id) toast({ text: verb, action: { label: "Undo", run: async () => { await undo(r.change_id!); } } });
  };
  const save = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    try {
      const r = await api<ChangeResult & { version: number }>("/api/profile", { method: "PUT", json: { markdown: text, base_version: p.current?.version ?? null } });
      setBase(text);
      done(r, "Saved the profile");
    } catch (e) {
      toast({ tone: "error", text: e instanceof ApiError && e.code === "stale" ? "The profile changed elsewhere. Your text is kept; reload to compare." : describeError(e) });
    } finally {
      setBusy(false);
    }
  };
  const restore = async (v: number) => {
    try {
      const r = await api<ChangeResult>(`/api/profile/versions/${v}/restore`, { method: "POST" });
      done(r, `Restored version ${v}`);
      setVersions(false);
    } catch (e) {
      toast({ tone: "error", text: describeError(e) });
    }
  };

  return (
    <div className={embedded ? "profile settings-profile" : "page profile"}>
      <div className="strip" role="toolbar" aria-label="Profile">
        {embedded ? <span className="silk profile-lbl">Training profile</span> : <h1 className="page-t">Profile</h1>}
        <div className="seg" role="radiogroup" aria-label="Mode">
          <button role="radio" aria-checked={mode === "edit"} className={`key ${mode === "edit" ? "is-on" : ""}`} onClick={() => setMode("edit")}>Edit</button>
          <button role="radio" aria-checked={mode === "preview"} className={`key ${mode === "preview" ? "is-on" : ""}`} onClick={() => setMode("preview")}>Preview</button>
        </div>
        <span className="fill" />
        {dirty
          ? <button className="key ink" disabled={busy} onClick={() => void save()}>Save</button>
          : p.current && !mobile && <span className="mono muted small saved-at">{p.current.source === "system" ? "Template" : `Saved ${when(p.current.at)}`}</span>}
        <button className={`key plain ${versions ? "is-latched" : ""}`} aria-pressed={versions} aria-label="Versions" onClick={() => setVersions(!versions)}>
          <Icon name="hist" />{!mobile && "Versions"}
        </button>
        {!embedded && <ChatKey />}
      </div>
      <div className={`profile-body ${versions && !mobile ? "with-v" : ""}`}>
        <div className="page-scroll">
          <div className="doc module">
            {!p.current && <p className="doc-note">New profile. The assistant reads it when it plans.</p>}
            {mode === "edit" ? <Editor value={text} onChange={edit} /> : <Preview md={text} />}
          </div>
        </div>
        {versions && (mobile
          ? <div className="sheet" role="dialog" aria-modal="true" aria-label="Versions"><Versions p={p} current={text} onRestore={restore} onClose={() => setVersions(false)} /></div>
          : <aside className="versions-col" aria-label="Versions"><Versions p={p} current={text} onRestore={restore} onClose={() => setVersions(false)} /></aside>)}
      </div>
    </div>
  );
}

function Preview({ md }: { md: string }) {
  const clean = md.split("\n").map((l) => (isPrompt(l) ? `> *${promptText(l)}*` : l)).join("\n");
  return <div className="md-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a>,
  }}>{clean}</ReactMarkdown></div>;
}

function Versions({ p, current, onRestore, onClose }: { p: ProfileT; current: string; onRestore: (v: number) => void; onClose: () => void }) {
  const [sel, setSel] = useState<number | null>(null);
  const [diff, setDiff] = useState(true);
  const v = useQuery({ queryKey: ["profile", "v", sel], enabled: sel != null, queryFn: () => api<ProfileVersion & { markdown: string }>(`/api/profile/versions/${sel}`) });
  if (sel != null) {
    return (
      <div className="vpanel">
        <div className="panel-hd">
          <button className="key flat plain" onClick={() => setSel(null)}><Icon name="back" />Versions</button>
          <span className="mono">v{sel}</span>
          <span className="fill" />
          <button className={`key plain ${diff ? "is-latched" : ""}`} aria-pressed={diff} onClick={() => setDiff(!diff)}>Diff</button>
        </div>
        <div className="vbody">
          {!v.data ? <div className="skel" style={{ height: 120 }} /> : diff ? (
            <pre className="vdiff mono">{lineDiff(v.data.markdown, current).filter((l) => l.t !== "same" || /^#{1,6}\s/.test(l.s)).map((l, i) => (
              <div key={i} className={l.t}>{l.t === "add" ? "+ " : l.t === "del" ? "− " : "  "}{l.s}</div>
            ))}</pre>
          ) : <Preview md={v.data.markdown} />}
        </div>
        <div className="panel-ft">
          <span className="hint-l">{diff ? `v${sel} compared with now` : ""}</span>
          <span className="fill" />
          {p.current?.version !== sel && <button className="key ink" onClick={() => onRestore(sel)}>Restore</button>}
        </div>
      </div>
    );
  }
  return (
    <div className="vpanel">
      <div className="panel-hd"><h2>Versions</h2><span className="fill" /><button className="key sq flat" aria-label="Close versions" onClick={onClose}><Icon name="close" /></button></div>
      <ol className="vlist">
        {p.versions.map((x) => (
          <li key={x.version}>
            <button className="vrow" onClick={() => setSel(x.version)}>
              <span className="mono vn">v{x.version}</span>
              <span className="mono muted">{when(x.at)}</span>
              <span className="muted">{who(x.source)}</span>
              {x.version === p.current?.version && <span className="tag">current</span>}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
