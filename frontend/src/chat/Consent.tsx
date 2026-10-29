import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";
import { useToast } from "../ui/toast";
import { describeError } from "../plan/api";
import type { ChatStatus } from "./types";

/** First-use consent (decision 25): say plainly where messages go before the first one. The
 * main sentence is the server's own `note`, so the text matches what the backend does. */
export function Consent({ status, compact = false }: { status: ChatStatus; compact?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const agree = async () => {
    setBusy(true);
    try {
      await api("/api/auth/consent", { method: "POST" });
      await Promise.all([qc.invalidateQueries({ queryKey: ["chat-status"] }), qc.invalidateQueries({ queryKey: ["auth-status"] })]);
    } catch (e) {
      toast({ tone: "error", text: describeError(e) });
    } finally {
      setBusy(false);
    }
  };
  const limit = status.usage.limit;
  return (
    <div className={`consent ${compact ? "compact" : ""}`}>
      <span className="silk">Before the first message</span>
      <h3>The assistant runs on {status.provider}</h3>
      {status.note && <p className="consent-note">{status.note}</p>}
      <ul>
        <li>Model <span className="mono">{status.model}</span>. Web searches go through {status.provider}'s search; queries never contain your own numbers.</li>
        <li>Your password and Garmin sign-in never leave this server. Nothing is sent until you write a message.</li>
        <li>You have <b>{limit < 0 ? "unlimited" : limit}</b> assistant turns a week (a turn is one message with everything the
          assistant does to answer it). The count resets Monday 00:00.</li>
      </ul>
      <div className="consent-ft">
        <span className="fill" />
        <button type="button" className="key ink" disabled={busy} onClick={agree}>Turn on the assistant</button>
      </div>
    </div>
  );
}
