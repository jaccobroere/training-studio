import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../api/client";

/** Sign in. Accounts are invite-only (the operator creates them), so this is the whole screen:
 * the product mark, two fields, one key. */
export function AuthScreen() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/api/auth/login", { method: "POST", json: { username, password } });
      // Drop everything the previous session cached, then refetch the (still observed) status.
      // clear() would detach SessionGate's observer and leave the sign-in screen up.
      await qc.resetQueries();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Can't reach the server.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="auth">
      <div className="auth-panel module">
        <div className="auth-hd">
          <div className="mark big" aria-hidden="true"><i /></div>
          <div><h1>Training Studio</h1><p className="mono muted small">plan · log · analyse</p></div>
        </div>
        <form className="auth-form" onSubmit={submit}>
          <label className="field-l"><span className="silk">Username</span>
            <input className="input" name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" enterKeyHint="next" spellCheck={false}
              required minLength={3} maxLength={32} value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label className="field-l"><span className="silk">Password</span>
            <input className="input" type="password" name="password" autoComplete="current-password" enterKeyHint="go"
              required maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && <p className="auth-err" role="alert">{error}</p>}
          <button className="key ink auth-go" type="submit" disabled={busy}>{busy ? "…" : "Sign in"}</button>
        </form>
      </div>
      <p className="auth-foot mono small">Plans, health data and chats stay private to your account.</p>
    </main>
  );
}

export function ChangePasswordScreen({ username, forced, onDone }: { username: string; forced?: boolean; onDone?: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const qc = useQueryClient();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setMsg({ ok: false, text: "The new passwords don't match." });
    try {
      const r = await api<{ other_sessions_ended: number }>("/api/auth/password", { method: "POST", json: { current, new: next } });
      setMsg({ ok: true, text: `Password changed${r.other_sessions_ended ? ` · signed out ${r.other_sessions_ended} other session${r.other_sessions_ended > 1 ? "s" : ""}` : ""}.` });
      setCurrent(""); setNext(""); setConfirm("");
      await qc.invalidateQueries({ queryKey: ["auth-status"] });
      onDone?.();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : "Couldn't change the password." });
    }
  };
  const form = (
    <form className="auth-form" onSubmit={submit}>
      <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />
      <label className="field-l"><span className="silk">{forced ? "Temporary password" : "Current password"}</span>
        <input className="input" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
      <label className="field-l"><span className="silk">New password</span>
        <input className="input" type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} /></label>
      <label className="field-l"><span className="silk">Repeat new password</span>
        <input className="input" type="password" name="confirm" autoComplete="new-password" enterKeyHint="go" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
      {msg && <p className={msg.ok ? "auth-ok" : "auth-err"} role="status">{msg.text}</p>}
      <button className="key ink auth-go" type="submit">Change password</button>
    </form>
  );
  if (!forced) return form;
  return (
    <main className="auth">
      <div className="auth-panel module">
        <div className="auth-hd"><div className="mark big" aria-hidden="true"><i /></div>
          <div><h1>Choose a new password</h1><p className="muted small">You signed in with a temporary password. Choose your own to continue.</p></div></div>
        {form}
      </div>
    </main>
  );
}
