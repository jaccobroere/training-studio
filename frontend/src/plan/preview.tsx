import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useNavigate } from "react-router";
import { api, ApiError } from "../api/client";
import type { ChangeResult, Proposal } from "../api/types";
import { useDock } from "../app/dock";
import { useMedia, PIN_DOCK } from "../app/useMedia";
import { useToast } from "../ui/toast";
import { describeError, refreshPlan, useUndo } from "./api";

/** Where the Weeks view previews a proposal: /plan/weeks?proposal=<id>. */
const proposalPreviewPath = (id: string) => `/plan/weeks?proposal=${encodeURIComponent(id)}`;

/** Set when opening a preview closed the chat (tablet/mobile), so closing it reopens the chat. */
let reopenChat = false;

/** Open a proposal as ghost chips in the Weeks view. On tablet and mobile the chat closes to
 * make room; "Close preview" brings it back. For the chat's "Preview in calendar" key. */
export function useOpenProposalPreview() {
  const nav = useNavigate();
  const dock = useDock();
  const pinned = useMedia(PIN_DOCK);
  return useCallback((id: string) => {
    if (!pinned && dock.view) { reopenChat = dock.view.kind === "console"; dock.close(); }
    nav(proposalPreviewPath(id));
  }, [nav, dock, pinned]);
}

export const useProposal = (id: string | null) =>
  useQuery({ queryKey: ["proposal", id], enabled: !!id, queryFn: () => api<Proposal>(`/api/chat/proposals/${id}`) });

const STATUS: Record<string, string> = {
  applied: "Applied", discarded: "Discarded", replaced: "Replaced by a newer proposal", undone: "Applied, then undone",
};

/** The sticky bar under the Weeks grid while previewing: summary · Close preview · Discard · Apply n. */
export function PreviewBar({ p, onClose }: { p: Proposal; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const undo = useUndo();
  const dock = useDock();
  const [busy, setBusy] = useState<"apply" | "discard" | null>(null);
  const [stale, setStale] = useState(false);
  const close = () => {
    onClose();
    if (reopenChat) { reopenChat = false; dock.open({ kind: "console" }); }
  };
  const act = async (verb: "apply" | "discard") => {
    setBusy(verb);
    try {
      const r = await api<{ proposal: Proposal; change: ChangeResult } | Proposal>(`/api/chat/proposals/${p.id}/${verb}`, { method: "POST" });
      refreshPlan(qc);
      void qc.invalidateQueries({ queryKey: ["proposal", p.id] });
      if (verb === "apply" && "change" in r && r.change.change_id) {
        const cid = r.change.change_id;
        toast({ text: `Applied · ${p.title}`, action: { label: "Undo", run: async () => { await undo(cid); void qc.invalidateQueries({ queryKey: ["proposal", p.id] }); } } });
      } else toast({ text: verb === "apply" ? `Applied · ${p.title}` : "Discarded the proposal" });
      close();
    } catch (e) {
      void qc.invalidateQueries({ queryKey: ["proposal", p.id] });
      if (e instanceof ApiError && e.code === "stale") setStale(true);
      else toast({ tone: "error", text: describeError(e) });
    } finally {
      setBusy(null);
    }
  };
  const isStale = stale || p.status === "stale";
  const open = p.status === "open" && !isStale;
  const n = p.counts.workouts;
  return (
    <div className={`preview-bar ${open ? "" : "done"}`} role="region" aria-label="Proposal preview">
      <div className="pb-t">
        <span className="silk pb-k">{isStale ? "Out of date" : open ? "Proposal" : "Preview"}</span>
        <span className="pb-s">
          {isStale ? "The plan changed since this was proposed. Ask the assistant again."
            : open ? <><b>{p.title}</b><span className="pb-sum mono"> · {p.summary}</span></>
              : <><b>{p.title}</b> · {STATUS[p.status] ?? p.status}</>}
        </span>
      </div>
      <div className="pb-k-row">
        <button className="key flat" onClick={close}>Close preview</button>
        {(open || isStale) && <button className="key" disabled={!!busy} onClick={() => void act("discard")}>Discard</button>}
        {open && <button className="key pb-apply" disabled={!!busy} onClick={() => void act("apply")}>{busy === "apply" ? "Applying…" : `Apply${n ? ` ${n}` : ""}`}</button>}
      </div>
    </div>
  );
}
