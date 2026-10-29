import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { NavLink } from "react-router";
import { api, ApiError } from "../api/client";
import { readPref } from "../app/prefs";
import { setTheme, type Theme } from "../app/theme";
import { useMe } from "../auth/session";
import { PrivacyNotice } from "../privacy/PrivacyNotice";
import { shortDate, stamp } from "../ui/dates";
import { Icon } from "../ui/Icon";
import { useToast } from "../ui/toast";
import { FeedbackModule } from "./FeedbackModule";

interface SessionRow { current: boolean; created_at: string; last_seen_at: string; device: string }
interface ChatStatus { configured: boolean; provider: string; model: string; note: string; consent: boolean;
  usage: { used: number; limit: number; resets_at: string; exhausted: boolean } }

/** Settings → Account (decision 23): everything a person can do for themselves. There is no
 * admin in the app; resets and limits are the operator's CLI. */
export function AccountTab() {
  return (
    <>
      <div className="settings-col">
        <ProfileModule />
        <PasswordModule />
        <SessionsModule />
      </div>
      <div className="settings-col">
        <AssistantModule />
        <FeedbackModule />
        <DeleteModule />
      </div>
    </>
  );
}

/** The Profile is its own Settings tab (decision 37). Account carries a card so the document
 * people look at most is one click away from the account content, without moving or duplicating
 * the editor and its save/versions behaviour. */
function ProfileModule() {
  return (
    <section className="module">
      <div className="module-hd"><h2>Training profile</h2><span className="fill" /><span className="silk">versioned</span></div>
      <div className="module-bd">
        <p className="small">The Markdown notes about you that the assistant reads whenever it plans. Every save keeps a version you can restore.</p>
      </div>
      <div className="module-ft">
        <NavLink className="key ink" to="/settings/profile"><Icon name="profile" />Open profile</NavLink>
      </div>
    </section>
  );
}

function PasswordModule() {
  const { me } = useMe();
  const [privacy, setPrivacy] = useState(false);
  const toast = useToast();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (next !== again) return setErr("The new passwords don't match.");
    setBusy(true);
    try {
      const r = await api<{ other_sessions_ended: number }>("/api/auth/password", { method: "POST", json: { current: cur, new: next } });
      setCur(""); setNext(""); setAgain("");
      toast({ text: r.other_sessions_ended ? `Password changed. Signed out ${r.other_sessions_ended} other device${r.other_sessions_ended === 1 ? "" : "s"}.` : "Password changed." });
      void qc.invalidateQueries({ queryKey: ["auth-sessions"] });
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : "Can't reach the server.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="module">
      <div className="module-hd"><h2>Sign-in</h2><span className="fill" /><span className="mono muted small">{me.username} · since {shortDate(me.created_at.slice(0, 10))}</span></div>
      <div className="module-bd sec">
        <form id="acct-password" className="plan-form" onSubmit={submit}>
          <input type="text" name="username" autoComplete="username" value={me.username} readOnly hidden />
          <label className="field-l"><span className="silk">Current password</span>
            <input className="input" type="password" autoComplete="current-password" required value={cur} onChange={(e) => setCur(e.target.value)} /></label>
          <div className="form-grid">
            <label className="field-l"><span className="silk">New password</span>
              <input className="input" type="password" autoComplete="new-password" required minLength={10} maxLength={128} value={next} onChange={(e) => setNext(e.target.value)} /></label>
            <label className="field-l"><span className="silk">Repeat new password</span>
              <input className="input" type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} /></label>
          </div>
          <p className="muted small">At least 10 characters. Signs out your other devices. There is no email on accounts, so only the operator can reset a forgotten password.</p>
          <p className="muted small"><button type="button" className="link" onClick={() => setPrivacy(true)}>Privacy</button></p>
          {err && <p className="auth-err" role="alert">{err}</p>}
        </form>
      </div>
      <div className="module-ft">
        <button className="key ink" type="submit" form="acct-password" disabled={busy || !cur || !next}>Change password</button>
      </div>
      {privacy && <PrivacyNotice onClose={() => setPrivacy(false)} />}
    </section>
  );
}

function device(ua: string) {
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "macOS"
    : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari" : "";
  return [br, os].filter(Boolean).join(" · ") || (ua ? ua.slice(0, 40) : "Unknown device");
}

function SessionsModule() {
  const q = useQuery({ queryKey: ["auth-sessions"], queryFn: () => api<SessionRow[]>("/api/auth/sessions") });
  const qc = useQueryClient();
  const toast = useToast();
  const others = (q.data ?? []).filter((s) => !s.current).length;
  const endOthers = async () => {
    const r = await api<{ ended: number }>("/api/auth/sessions/end-others", { method: "POST" });
    toast({ text: `Signed out ${r.ended} other device${r.ended === 1 ? "" : "s"}.` });
    void qc.invalidateQueries({ queryKey: ["auth-sessions"] });
  };
  const signOut = async () => {
    await api("/api/auth/logout", { method: "POST" });
    qc.clear();
    await qc.invalidateQueries({ queryKey: ["auth-status"] });
  };
  return (
    <section className="module">
      <div className="module-hd"><h2>Signed-in devices</h2><span className="fill" /><span className="mono muted small">{q.data?.length ?? "…"}</span></div>
      <div className="module-bd sec">
        <ul className="devs" aria-label="Signed-in devices">
          {q.data?.map((s) => (
            <li key={s.created_at + s.device}>
              <span className="dev-n">{device(s.device)}{s.current && <span className="tag on-tag">this device</span>}</span>
              <span className="mono small muted">Active {stamp(s.last_seen_at, undefined, true)} · signed in {shortDate(s.created_at.slice(0, 10))}</span>
            </li>
          ))}
        </ul>
        <p className="muted small">Sessions expire after 30 idle days, or 90 days at most.</p>
      </div>
      <div className="module-ft">
        <button className="key" disabled={!others} onClick={endOthers}>Sign out other devices</button>
        <button className="key" onClick={signOut}>Sign out</button>
      </div>
    </section>
  );
}

function AssistantModule() {
  const q = useQuery({ queryKey: ["chat-status"], queryFn: () => api<ChatStatus>("/api/chat/status") });
  const [theme, setT] = useState<Theme>(() => readPref<Theme>("theme", "system"));
  const u = q.data?.usage;
  const pct = u && u.limit > 0 ? Math.min(100, (u.used / u.limit) * 100) : 0;
  return (
    <section className="module">
      <div className="module-hd"><h2>Assistant & appearance</h2></div>
      <div className="module-bd sec">
        {q.data && (
          <>
            <dl className="readout card acct-read">
              <div><dt>Model</dt><dd className="mono">{q.data.model}</dd></div>
              <div><dt>Provider</dt><dd>{q.data.provider}</dd></div>
              <div><dt>Status</dt><dd>{!q.data.configured ? "not configured" : q.data.consent ? "on" : "off"}</dd></div>
            </dl>
            {u && (
              <div className="usage" aria-label="Assistant turns this week">
                <div className="usage-hd"><span className="silk">Turns this week</span><span className="fill" />
                  <span className="mono">{u.used} / {u.limit < 0 ? "∞" : u.limit}</span></div>
                <div className="meter km" role="img" aria-label={`${u.used} of ${u.limit} turns used`}><i className="fill-bar" style={{ width: `${pct}%` }} /></div>
                <p className="muted small">One turn is one message and everything the assistant does to answer it. Resets {stamp(u.resets_at, undefined, true)}.</p>
              </div>
            )}
            <p className="muted small">{q.data.note}</p>
          </>
        )}
        <fieldset className="field-l"><legend className="silk">Theme</legend>
          <div className="seg">{(["system", "light", "dark"] as Theme[]).map((t) => (
            <button type="button" key={t} className={`key ${theme === t ? "is-on" : ""}`} aria-pressed={theme === t} onClick={() => { setTheme(t); setT(t); }}>{t}</button>
          ))}</div>
        </fieldset>
      </div>
    </section>
  );
}

function DeleteModule() {
  const { me } = useMe();
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [typed, setTyped] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const match = typed.trim().toLowerCase() === me.username.toLowerCase();
  const del = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await api("/api/auth/delete", { method: "POST", json: { password: pw, confirm: typed } });
      qc.clear();
      await qc.invalidateQueries({ queryKey: ["auth-status"] });
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : "Can't reach the server.");
      setBusy(false);
    }
  };
  return (
    <section className="module danger-zone">
      <div className="module-hd"><h2>Delete account</h2></div>
      <div className="module-bd sec">
        <p className="small">Deletes your account and all its data, including conversations and the Garmin connection. This can't be undone, though server backups may hold a copy for a while. Download your archive first.</p>
        {open && (
          <form id="acct-delete" className="plan-form" onSubmit={del}>
            <input type="text" name="username" autoComplete="username" value={me.username} readOnly hidden />
            <div className="form-grid">
              <label className="field-l"><span className="silk">Password</span>
                <input className="input" type="password" autoComplete="current-password" required value={pw} onChange={(e) => setPw(e.target.value)} /></label>
              <label className="field-l"><span className="silk">Type “{me.username}” to confirm</span>
                <input className="input" autoCapitalize="none" spellCheck={false} required value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
            </div>
            {err && <p className="auth-err" role="alert">{err}</p>}
          </form>
        )}
      </div>
      <div className="module-ft">
        {!open ? (
          <button className="key danger" onClick={() => setOpen(true)}><Icon name="trash" />Delete my account…</button>
        ) : (
          <>
            <button type="button" className="key" onClick={() => { setOpen(false); setPw(""); setTyped(""); }}>Cancel</button>
            <button type="submit" className="key danger" form="acct-delete" disabled={busy || !pw || !match}>Delete everything</button>
          </>
        )}
      </div>
    </section>
  );
}
