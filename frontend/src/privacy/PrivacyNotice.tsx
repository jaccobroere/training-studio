import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { describeError } from "../plan/api";
import { useToast } from "../ui/toast";

/** The privacy note, short and plain. Shown once to a signed-in account right after the first
 * password change (SessionGate), acknowledged with one key; re-readable from Settings →
 * Account, where `onClose` makes it an overlay. Keep it in step with OPERATOR.md. */
export function PrivacyNotice({ onClose }: { onClose?: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const seen = async () => {
    setBusy(true);
    try {
      await api("/api/auth/privacy-seen", { method: "POST" });
      await qc.invalidateQueries({ queryKey: ["auth-status"] });
    } catch (e) {
      toast({ tone: "error", text: describeError(e) });
      setBusy(false);
    }
  };
  const panel = (
    <div className="auth-panel module">
      <div className="auth-hd"><div className="mark big" aria-hidden="true"><i /></div>
        <div><h1 id="privacy-h">Your data here</h1><p className="muted small">The short version, in plain words.</p></div></div>
      <div className="privacy-bd">
        <p>This app runs on a server run by the person who invited you. There's no tracking or ads.</p>
        <p><b>What's stored:</b> your account, workouts, health metrics, GPS tracks, photos and chats. Your Garmin
          password is never stored, only an encrypted access token.</p>
        <p><b>What leaves the server:</b> only when you use the assistant (after you turn it on) do your question and
          the data it needs go to Ollama Cloud. Maps load from OpenStreetMap, which sees roughly which area you're viewing.</p>
        <p><b>Who can see it:</b> the person who runs this server can technically access everything. Ask them how they handle that.</p>
        <p><b>Backups</b> are up to the person who runs this server; ask them how they're kept.</p>
        <p><b>Leaving:</b> delete your account in Settings → Account and your data is removed right away (a safety copy is
          purged within 7 days). Copies in backups last as long as the operator keeps those.</p>
        <p>Questions, or want a copy of your data? Ask the person who runs this server, or download your archive in Settings → Data.</p>
      </div>
      {onClose
        ? <button type="button" className="key auth-go" onClick={onClose}>Close</button>
        : <button type="button" className="key ink auth-go" disabled={busy} onClick={seen}>OK, got it</button>}
    </div>
  );
  if (onClose) return <div className="auth privacy overlay" role="dialog" aria-modal="true" aria-labelledby="privacy-h">{panel}</div>;
  return <main className="auth privacy">{panel}</main>;
}
