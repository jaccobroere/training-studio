import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../api/client";
import { addDays, dayLabel, shortDate, stamp, todayIso } from "../ui/dates";
import { DateField } from "../ui/DateField";
import { Icon } from "../ui/Icon";
import { useToast } from "../ui/toast";
import type { Run, Status } from "./garmin";
import { useRefreshOnImportDone } from "./garmin";
import { Progress } from "./Progress";
import { recentSyncs, syncLabel, syncOutcome, syncTime } from "./recentSyncs";

/** Settings → Connections: the Garmin sign-in and schedule, backfill history, what is synced. */
export function ConnectionsTab() {
  const status = useQuery({
    queryKey: ["garmin-status"], queryFn: () => api<Status>("/api/garmin/status"),
    refetchInterval: (q) => (q.state.data?.backfill ? 4000 : false),
  });
  const runs = useQuery({
    queryKey: ["imports"], queryFn: () => api<Run[]>("/api/imports"),
    refetchInterval: (q) => (q.state.data?.some((r) => r.state === "queued" || r.state === "running") ? 1200 : false),
  });
  const active = runs.data?.find((r) => (r.state === "queued" || r.state === "running") && r.kind !== "backfill");
  useRefreshOnImportDone(active);
  const st = status.data;
  return (
    <>
      <div className="settings-col">
        {st ? <ConnectModule st={st} active={active} /> : <section className="module"><div className="skel" style={{ height: 260, margin: 12 }} /></section>}
        <RecentSyncs runs={runs.data} />
      </div>
      <div className="settings-col">
        {st?.connected && <BackfillModule st={st} />}
        {st && <SyncedTypes st={st} />}
      </div>
    </>
  );
}

function ConnectModule({ st, active }: { st: Status; active?: Run }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [code, setCode] = useState("");
  const [mfa, setMfa] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["garmin-status"] }), qc.invalidateQueries({ queryKey: ["imports"] })]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = mfa
        ? await api<{ state: string }>("/api/garmin/connect/mfa", { method: "POST", json: { code } })
        : await api<{ state: string }>("/api/garmin/connect", { method: "POST", json: { email, password: pw } });
      setPw("");
      if (r.state === "needs_mfa") { setMfa(true); return; }
      setMfa(false); setCode(""); setEmail("");
      toast({ text: "Garmin connected. Fetching the last three days now." });
      await refresh();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : "Can't reach the server.");
      if (e2 instanceof ApiError && e2.code === "mfa_expired") setMfa(false);
    } finally {
      setBusy(false);
    }
  };
  const syncNow = async () => {
    try {
      await api("/api/garmin/sync", { method: "POST", json: {} });
      await refresh();
    } catch (e2) {
      toast({ tone: "error", text: e2 instanceof ApiError ? e2.message : "Sync failed to start" });
    }
  };
  const disconnect = async () => {
    await api("/api/garmin/disconnect", { method: "POST" });
    toast({ text: "Disconnected. Synced data stays." });
    await refresh();
  };
  const setSettings = async (patch: Partial<Status["settings"]>) => {
    await api("/api/garmin/settings", { method: "PATCH", json: patch });
    await refresh();
  };
  const needsReauth = !st.connected && st.token_present && st.token_key;
  const label = st.connected ? "Connected" : !st.token_key ? "Unavailable" : needsReauth ? "Sign-in expired" : "Not connected";
  return (
    <section className="module garmin">
      <div className="module-hd"><h2>Garmin Connect</h2><span className="fill" />
        <span className={`tag ${st.connected ? "ok-tag" : "warn"}`}>{label}</span>
      </div>
      <div className="module-bd sec">
        <div className="screen">
          <dl className="readout">
            <div><dt>Data through</dt><dd>{st.data_through ? dayLabel(st.data_through) : "—"}</dd></div>
            <div><dt>Last sync</dt><dd>{st.state.last_pull ? stamp(st.state.last_pull + "Z", undefined, true) : "never"}</dd></div>
            <div><dt>Next</dt><dd>{st.backoff_until ? `paused → ${stamp(st.backoff_until, undefined, true)}` : st.next_pull ? stamp(st.next_pull, undefined, true) : st.connected ? "off" : "—"}</dd></div>
          </dl>
        </div>
        {st.state.last_error && <p className="small warn-t">Last problem: {st.state.last_error}</p>}
        {!st.connected ? (
          <form id="garmin-connect" className="plan-form" onSubmit={submit}>
            <p className="small">{!st.token_key ? "Garmin sync is switched off on the server for now. Your synced data is safe; ask the operator." :
              needsReauth ? "Garmin no longer accepts the saved sign-in. Sign in again to resume syncing." :
              "Sign in with your Garmin account to sync automatically."} The password is used once to get tokens and is never stored.
              The tokens are kept encrypted and give read-only access until you disconnect.</p>
            {!mfa ? (
              <div className="form-grid">
                <label className="field-l"><span className="silk">Garmin email</span>
                  <input className="input" type="email" autoComplete="off" autoCapitalize="none" spellCheck={false} required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
                <label className="field-l"><span className="silk">Garmin password</span>
                  <input className="input" type="password" autoComplete="off" required value={pw} onChange={(e) => setPw(e.target.value)} /></label>
              </div>
            ) : (
              <label className="field-l"><span className="silk">Code from Garmin (email or authenticator)</span>
                <input className="input mono" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} /></label>
            )}
            <p className="muted small">Three sign-in attempts a day. Garmin can lock an account after repeated failures, so the app never retries on its own.</p>
            {err && <p className="auth-err" role="alert">{err}</p>}
          </form>
        ) : (
          <>
            <div className="sync-row">
              <label className="chk small"><input type="checkbox" checked={st.settings.auto} onChange={(e) => void setSettings({ auto: e.target.checked })} /> Sync automatically</label>
              <span className="fill" />
              <div className="seg" role="group" aria-label="Sync interval">
                {st.intervals_h.map((h) => (
                  <button key={h} className={`key ${st.settings.interval_h === h ? "is-on" : ""}`} aria-pressed={st.settings.interval_h === h}
                    disabled={!st.settings.auto} onClick={() => void setSettings({ interval_h: h })}>{h} h</button>
                ))}
              </div>
            </div>
            <p className="muted small">Each sync fetches the last three days and any new activities.</p>
          </>
        )}
        {active && <Progress label={active.state === "queued" ? "Queued" : active.kind === "pull" ? "Syncing from Garmin" : `Importing ${active.params.filename ?? ""}`}
          frac={active.progress.total ? (active.progress.done ?? 0) / active.progress.total : null} />}
      </div>
      <div className="module-ft">
        {!st.connected ? (
          <>
            {mfa && <button type="button" className="key" onClick={() => { setMfa(false); setCode(""); }}>Back</button>}
            <button className="key ink" type="submit" form="garmin-connect" disabled={busy}><Icon name="key" />{mfa ? "Verify code" : "Connect Garmin"}</button>
          </>
        ) : (
          <>
            <button className="key flat" onClick={disconnect}>Disconnect</button>
            <button className="key ink" onClick={syncNow} disabled={!!active}><Icon name="sync" />Sync now</button>
          </>
        )}
      </div>
    </section>
  );
}

/** The last three Garmin syncs, newest first. The rows are already persisted as import runs,
 * so this is only a filtered view of the same list the Data tab shows. */
function RecentSyncs({ runs }: { runs?: Run[] }) {
  const recent = recentSyncs(runs);
  return (
    <section className="module">
      <div className="module-hd"><h2>Recent syncs</h2><span className="fill" /><span className="silk">{recent.length ? `last ${recent.length}` : ""}</span></div>
      <div className="module-bd sec">
        {!runs ? <div className="skel" style={{ height: 54 }} /> : recent.length === 0 ? (
          <p className="muted small">No syncs yet. Connect Garmin above, or press Sync now; the three most recent appear here.</p>
        ) : (
          <ol className="syncs" aria-label="Recent syncs">
            {recent.map((r) => (
              <li key={r.id} className={`st-${r.state}`}>
                <span className="tag run-st">{syncOutcome(r.state)}</span>
                <span className="sync-t">{syncLabel(r)}</span>
                <span className="mono muted small sync-when">{stamp(syncTime(r), undefined, true)}</span>
              </li>
            ))}
          </ol>
        )}
        <p className="muted small">The full import history, including each sync's fetched records, is under Data.</p>
      </div>
    </section>
  );
}

function BackfillModule({ st }: { st: Status }) {
  const qc = useQueryClient();
  const toast = useToast();
  const today = todayIso();
  const min = addDays(today, -st.backfill_max_days);
  const [start, setStart] = useState(addDays(today, -180));
  const b = st.backfill;
  const days = Math.round((new Date(`${today}T12:00:00`).getTime() - new Date(`${start}T12:00:00`).getTime()) / 864e5);
  const go = async () => {
    try {
      await api("/api/garmin/backfill", { method: "POST", json: { start } });
      await qc.invalidateQueries({ queryKey: ["garmin-status"] });
    } catch (e) {
      toast({ tone: "error", text: e instanceof ApiError ? e.message : "Couldn't start the backfill" });
    }
  };
  const cancel = async () => {
    if (!b) return;
    await api(`/api/imports/${b.id}/cancel`, { method: "POST" });
    await qc.invalidateQueries({ queryKey: ["garmin-status"] });
  };
  return (
    <section className="module">
      <div className="module-hd"><h2>Backfill history</h2><span className="fill" /><span className="silk">up to 5 years</span></div>
      <div className="module-bd sec">
        {b ? (
          <>
            <p className="small">Fetching {shortDate(b.params.start!)} → {shortDate(b.params.end!)}, oldest first, in 14-day steps.
              {b.state === "paused" && <> Garmin asked the app to slow down; it resumes by itself {b.params.resume_at ? stamp(b.params.resume_at + "Z", undefined, true) : "soon"}.</>}</p>
            <Progress label={b.state === "paused" ? "Paused" : b.state === "queued" && !b.progress.done ? "Queued" : `Backfilling · ${b.progress.done ?? 0}/${b.progress.total ?? "?"} days`}
              frac={b.progress.total ? (b.progress.done ?? 0) / b.progress.total : null} onCancel={cancel} />
          </>
        ) : (
          <>
            <p className="small">Fetches up to five years of older days in the background, about 90 minutes per year. It pauses when Garmin rate-limits and resumes by itself. For older history, upload an export.</p>
            <div className="bf-row">
              <div className="field-l"><span className="silk">From</span>
                <DateField value={start || null} min={min} max={today} label="Backfill from" onChange={(v) => v && setStart(v)} /></div>
              <span className="mono small muted">{days > 0 ? `${days} days` : ""}</span>
            </div>
          </>
        )}
      </div>
      {!b && (
        <div className="module-ft">
          <button className="key ink" onClick={go} disabled={!start || days < 1}>Start backfill</button>
        </div>
      )}
    </section>
  );
}

function SyncedTypes({ st }: { st: Status }) {
  const have = new Set(st.coverage.map((c) => c.metric));
  const map: Record<string, string[]> = { daily: ["steps", "rhr_bpm", "stress_avg", "bb_max"], sleep: ["sleep_h", "sleep_score"], hrv: ["hrv_ms"],
    vo2max: ["vo2max"], readiness: ["readiness"], respiration: ["respiration"], spo2: ["spo2"], weight: ["weight_kg"] };
  return (
    <section className="module">
      <div className="module-hd"><h2>What is synced</h2></div>
      <div className="module-bd">
        <ul className="synced">
          {st.synced_types.map((t) => {
            const on = t.key === "activities" ? st.activities.n > 0 : (map[t.key] ?? []).some((m) => have.has(m));
            return (
              <li key={t.key}><span className={`led-dot ${on ? "on" : ""}`} aria-hidden="true" /><b>{t.label}</b><span className="muted small">{t.detail}</span>
                <span className="mono small muted">{on ? "" : "none yet"}</span></li>
            );
          })}
        </ul>
        <p className="muted small">There are no per-type switches. Original responses and FIT files are kept.</p>
      </div>
    </section>
  );
}
