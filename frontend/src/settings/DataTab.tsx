import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api } from "../api/client";
import { shortDate, stamp } from "../ui/dates";
import { Icon } from "../ui/Icon";
import { useToast } from "../ui/toast";
import { useRefreshOnImportDone, type Run, type Status } from "./garmin";
import { Progress } from "./Progress";
import { uploadError, uploadSizeError } from "./upload";

const LABEL: Record<string, string> = {
  hrv_ms: "HRV", hrv_weekly_ms: "HRV 7-day", rhr_bpm: "Resting HR", sleep_h: "Sleep", sleep_score: "Sleep score",
  stress_avg: "Stress", bb_max: "Body Battery high", bb_min: "Body Battery low", bb_charged: "BB charged",
  bb_drained: "BB drained", steps: "Steps", weight_kg: "Weight", body_fat_pct: "Body fat", vo2max: "VO2max",
  respiration: "Respiration", spo2: "SpO2", readiness: "Readiness", activities: "Activities",
  activity_files: "Activity files", sleep: "Sleep nights",
};

/** Settings → Data: uploads and recent imports, coverage (with the Garmin delete), export.
 * Owns the import polling for this tab. */
export function DataTab() {
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
        <UploadModule st={st} active={active} runs={runs.data} />
        <ExportModule />
      </div>
      <div className="settings-col">
        {st && <CoverageModule st={st} />}
      </div>
    </>
  );
}

function UploadModule({ st, active, runs }: { st?: Status; active?: Run; runs?: Run[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [drag, setDrag] = useState(false);
  const [uploading, setUploading] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const send = (file: File) => {
    const sizeError = uploadSizeError(file.size);
    if (sizeError) { toast({ tone: "error", text: sizeError }); return; }
    if (uploading != null) return;
    setUploading(0);
    const fd = new FormData();
    fd.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/garmin/upload");
    xhr.upload.onprogress = (e) => e.lengthComputable && setUploading(e.loaded / e.total);
    xhr.onload = () => {
      setUploading(null);
      if (xhr.status < 200 || xhr.status >= 300) toast({ tone: "error", text: uploadError(xhr.status, xhr.responseText) });
      void qc.invalidateQueries({ queryKey: ["imports"] });
    };
    xhr.onerror = () => { setUploading(null); toast({ tone: "error", text: "Upload connection lost. Check recent imports before trying again." }); };
    xhr.send(fd);
  };
  const removeDemo = async () => {
    const r = await api<{ activities: number; metrics: number }>("/api/garmin/demo", { method: "DELETE" });
    toast({ text: `Removed demo data · ${r.activities} activities, ${r.metrics} daily values` });
    await qc.invalidateQueries();
  };
  return (
    <section className="module">
      <div className="module-hd"><h2>Uploads & imports</h2></div>
      <div className="module-bd sec">
        {st?.demo_present && (
          <div className="demo-note" role="note">
            <span><b>Demo data present.</b> Synthetic recordings and wellness values for testing, not your measurements.</span>
            <button className="key" onClick={removeDemo}>Remove demo data</button>
          </div>
        )}
        <div className={`drop ${drag ? "over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) send(f); }}>
          <Icon name="upload" />
          <div>
            <b>Upload a Garmin export (.zip) or activity (.fit)</b>
            <p className="small muted">Up to 100 MiB. Full history: garmin.com → Account → Data Management → Export your data. Re-importing is safe.</p>
          </div>
          <span className="fill" />
          <input ref={input} type="file" accept=".zip,.fit" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) send(f); e.target.value = ""; }} />
          <button className="key" onClick={() => input.current?.click()} disabled={uploading != null}>Choose file</button>
        </div>
        {uploading != null && <Progress label="Uploading" frac={uploading} />}
        {active && active.kind !== "pull" && <Progress label={active.state === "queued" ? "Queued" : `Importing ${active.params.filename ?? ""}`}
          frac={active.progress.total ? (active.progress.done ?? 0) / active.progress.total : null}
          onCancel={() => api(`/api/imports/${active.id}/cancel`, { method: "POST" }).then(() => qc.invalidateQueries({ queryKey: ["imports"] }))} />}
        {!!runs?.length && <span className="silk">Recent imports and syncs</span>}
        <ol className="runs">{runs?.slice(0, 8).map((r) => <RunRow key={r.id} r={r} />)}</ol>
        {runs?.length === 0 && <p className="muted small">Nothing imported yet.</p>}
      </div>
    </section>
  );
}

function CoverageModule({ st }: { st: Status }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const del = async () => {
    const r = await api<{ activities: number; metrics: number; nights: number }>("/api/garmin/delete-data", { method: "POST", json: { confirm: typed } });
    toast({ text: `Deleted ${r.activities} activities, ${r.metrics} daily values and ${r.nights} nights from Garmin.` });
    setOpen(false); setTyped("");
    await qc.invalidateQueries();
  };
  return (
    <section className="module">
      <div className="module-hd"><h2>Coverage</h2></div>
      <div className="module-bd sec">
        {st.coverage.length === 0 ? <p className="muted small">No data yet.</p> : (
          <div className="tbl-wrap" tabIndex={0} role="region" aria-label="Coverage per metric">
            <table className="tbl cov">
              <thead><tr><th>Metric</th><th>From</th><th>To</th><th>Days</th><th>Coverage</th></tr></thead>
              <tbody>{st.coverage.map((c) => {
                const pct = Math.round((c.n / c.expected) * 100);
                return (
                  <tr key={c.metric}><td>{LABEL[c.metric] ?? c.metric}</td><td className="mono">{shortDate(c.first)}</td><td className="mono">{shortDate(c.last)}</td>
                    <td className="mono">{c.n} / {c.expected}</td>
                    <td><span className="covbar" role="img" aria-label={`${pct}% of days`}><i style={{ width: `${pct}%` }} /></span><span className="mono small"> {pct}%</span></td></tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
        <p className="muted small">{st.activities.n} activities{st.activities.first ? `, ${shortDate(st.activities.first)} – ${shortDate(st.activities.last!)}` : ""}.</p>
        {open && (
          <form id="garmin-delete" className="sec" onSubmit={(e) => { e.preventDefault(); void del(); }}>
            <p className="small">Deletes all Garmin activities, streams, daily values, sleep nights and kept originals. Your plan and logs stay; links to deleted recordings are removed (undoable from week history).</p>
            <label className="field-l"><span className="silk">Type “delete” to confirm</span>
              <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
          </form>
        )}
      </div>
      {st.coverage.length > 0 && (
        <div className="module-ft">
          {!open ? (
            <button className="key danger" onClick={() => setOpen(true)}><Icon name="trash" />Delete synced Garmin data…</button>
          ) : (
            <>
              <button type="button" className="key" onClick={() => { setOpen(false); setTyped(""); }}>Cancel</button>
              <button type="submit" className="key danger" form="garmin-delete" disabled={typed.trim().toLowerCase() !== "delete"}>Delete Garmin data</button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function ExportModule() {
  const [conv, setConv] = useState(true);
  return (
    <section className="module">
      <div className="module-hd"><h2>Your data</h2></div>
      <div className="module-bd sec">
        <b>Full archive</b>
        <p className="muted small">Plans, change history, logs, recordings, daily metrics, analyses and original Garmin files, with a manifest. Never includes passwords or Garmin tokens.</p>
        <label className="chk small"><input type="checkbox" checked={conv} onChange={(e) => setConv(e.target.checked)} /> Include assistant conversations</label>
      </div>
      <div className="module-ft">
        <a className="key ink" href={`/api/export/archive?conversations=${conv}`}><Icon name="download" />Download archive</a>
      </div>
    </section>
  );
}

function RunRow({ r }: { r: Run }) {
  const rec = r.report.records ?? {};
  const total = (k: "new" | "updated" | "same") => Object.values(rec).reduce((a, x) => a + x[k], 0);
  const f = r.report.files;
  return (
    <li className={`run st-${r.state}`}>
      <details>
        <summary>
          <span className={`tag run-st`}>{r.state}</span>
          <span className="run-t">{r.kind === "pull" ? (r.params.scheduled ? "Scheduled sync" : r.params.first ? "First sync" : "Sync") : r.kind === "backfill" ? `Backfill from ${shortDate(r.params.start!)}` : r.params.filename}</span>
          <span className="mono muted small">{stamp(r.created_at, undefined, true)}</span>
          {r.report.demo && <span className="tag">demo</span>}
          <span className="fill" />
          {f && <span className="mono small">{total("new")} new · {total("updated")} updated · {total("same")} unchanged</span>}
        </summary>
        {f && (
          <div className="run-rep">
            <p className="mono small">Files: {f.parsed} parsed · {f.unsupported} unsupported · {f.failed} failed</p>
            {r.report.autolinked && <p className="small">Auto-linked: {r.report.autolinked}</p>}
            {r.report.devices?.length ? <p className="small">Devices: {r.report.devices.join(", ")}</p> : null}
            <table className="tbl"><thead><tr><th>Record</th><th>New</th><th>Updated</th><th>Same</th><th>Dates</th></tr></thead>
              <tbody>{Object.entries(rec).map(([k, v]) => (
                <tr key={k}><td>{LABEL[k] ?? k}</td><td className="mono">{v.new}</td><td className="mono">{v.updated}</td><td className="mono">{v.same}</td>
                  <td className="mono small">{r.report.ranges?.[k] ? `${shortDate(r.report.ranges[k][0])} – ${shortDate(r.report.ranges[k][1])}` : ""}</td></tr>
              ))}</tbody></table>
            {r.report.errors?.length ? <><span className="silk">Problems ({r.report.n_errors})</span><ul className="errs mono small">{r.report.errors.map((e) => <li key={e}>{e}</li>)}</ul></> : null}
            {r.report.unsupported?.length ? <><span className="silk">Kept but not read ({r.report.n_unsupported})</span><ul className="errs mono small">{r.report.unsupported.slice(0, 12).map((e) => <li key={e}>{e}</li>)}</ul></> : null}
          </div>
        )}
      </details>
    </li>
  );
}
