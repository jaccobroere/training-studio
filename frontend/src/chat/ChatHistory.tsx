import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api } from "../api/client";
import { Icon } from "../ui/Icon";
import { sinceStamp, stamp } from "../ui/dates";
import { scopeChip, type ChatScope } from "./scope";

export interface ThreadRow {
  id: string;
  title: string;
  updated_at: string;
  turns: number;
  scope: Partial<ChatScope> | null;
}

/** Earlier chats, in the side panel itself: newest first, the open one marked. Picking a
 * row restores that chat; Back (or Escape) returns to the one that is open. */
export function ChatHistory({ current, currentTitle, onOpen, onBack }: {
  current: string; currentTitle: string; onOpen: (id: string) => void; onBack: () => void;
}) {
  // Always a fresh list: rows that shift under the pointer after a background refetch are how
  // a click lands on the wrong chat.
  const threads = useQuery({ queryKey: ["threads"], queryFn: () => api<ThreadRow[]>("/api/chat/threads"), gcTime: 0 });
  const list = useRef<HTMLOListElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const rows = threads.data ?? [];
  // A chat with no messages yet isn't saved; it still shows, so "current" is never missing.
  const unsaved = rows.length > 0 && !rows.some((t) => t.id === current);

  // Focus the open chat (or the newest) once the list is there; until then, Back.
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current) return;
    if (!threads.isSuccess) { back.current?.focus({ preventScroll: true }); return; }
    focused.current = true;
    const el = list.current?.querySelector<HTMLElement>("[aria-current=true]") ?? list.current?.querySelector<HTMLElement>("button");
    (el ?? back.current)?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest" });
  }, [threads.isSuccess]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); onBack(); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...(list.current?.querySelectorAll<HTMLElement>(".ch-row") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };

  const count = rows.length + (unsaved ? 1 : 0);
  return (
    // Escape and arrow keys are shortcuts for the buttons inside, which all stay reachable by Tab.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <section className="ch-view" aria-label="Chat history" onKeyDown={onKeyDown}>
      <div className="ch-bar">
        <button ref={back} className="key flat" onClick={onBack}><Icon name="prev" />Back to chat</button>
        <span className="fill" />
        {count > 0 && <span className="mono ch-count">{count} chat{count === 1 ? "" : "s"}</span>}
      </div>
      <div className="ch-scroll">
        {threads.isPending && (
          <div className="ch-skel" aria-label="Loading earlier chats">
            {[0, 1, 2, 3].map((i) => <div key={i} className="skel" style={{ height: 50 }} />)}
          </div>
        )}
        {threads.isError && (
          <div className="con-err" role="alert">
            <p>Earlier chats could not be loaded. The open chat is unaffected.</p>
            <button className="key" onClick={() => void threads.refetch()}>Retry</button>
          </div>
        )}
        {threads.isSuccess && !rows.length && (
          <div className="ch-empty">
            <p>No earlier chats yet. Every conversation you start is kept here, newest first, so you can pick it up again later.</p>
          </div>
        )}
        {count > 0 && (
          <ol className="ch-list" ref={list}>
            {unsaved && (
              <li>
                <button className="ch-row" aria-current="true" onClick={() => onOpen(current)}>
                  <span className="ch-title">{currentTitle === "…" ? "New chat" : currentTitle}</span>
                  <span className="ch-meta mono"><span>Not started</span></span>
                  <span className="tag ch-cur">current</span>
                </button>
              </li>
            )}
            {rows.map((t) => {
              const cur = t.id === current;
              const chip = scopeChip(t.scope);
              return (
                <li key={t.id}>
                  <button className="ch-row" aria-current={cur ? "true" : undefined} onClick={() => onOpen(t.id)}>
                    <span className="ch-title">{t.title}</span>
                    <span className="ch-meta mono">
                      <time dateTime={t.updated_at} title={stamp(t.updated_at, undefined, true)}>{sinceStamp(t.updated_at)}</time>
                      <span>{t.turns} turn{t.turns === 1 ? "" : "s"}</span>
                      {chip && <span className="ch-scope">⌖ {chip}</span>}
                    </span>
                    {cur && <span className="tag ch-cur">current</span>}
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
