import { Chat as LiveChat, useChat } from "@ai-sdk/react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useDock } from "../app/dock";
import { useMobile } from "../app/useMedia";
import { readPref, writePref } from "../app/prefs";
import { Icon } from "../ui/Icon";
import { copyText } from "../ui/clipboard";
import { stamp } from "../ui/dates";
import { useToast } from "../ui/toast";
import { refreshPlan } from "../plan/api";
import { briefOf } from "./attachments";
import { Composer, useAttachments } from "./Composer";
import { Consent } from "./Consent";
import { ChatHistory } from "./ChatHistory";
import { firstText, hasVisibleOutput, Message } from "./messages";
import { newThreadId, prefillChat } from "./prefill";
import { useScope, type ChatScope } from "./scope";
import { transcriptOf } from "./transcript";
import { turnOf } from "./turn";
import type { ChatStatus, Media, MessageAttachment } from "./types";
import { assistantError } from "./assistantError";

/** The assistant panel: one conversation at a time, or the list of earlier chats. */
export default function Chat() {
  const qc = useQueryClient();
  const [tid, setTid] = useState<string>(() => readPref("chat.thread", newThreadId()));
  useEffect(() => writePref("chat.thread", tid), [tid]);
  const [view, setView] = useState<"chat" | "history">("chat");
  const [title, setTitle] = useState("New chat");
  const composer = useRef<HTMLTextAreaElement>(null);
  const threadEl = useRef<HTMLDivElement>(null);
  const historyKey = useRef<HTMLButtonElement>(null);
  const wantFocus = useRef(false);
  const mobile = useMobile();

  // A thread's messages are read from the server each time it is opened. The live
  // conversation is owned by useChat from then on, so a cached copy would only ever be
  // stale: it is what made a restored chat come back empty or missing its latest turns.
  const history = useQuery({
    queryKey: ["thread", tid],
    queryFn: () => api<{ messages: UIMessage[]; title: string }>(`/api/chat/threads/${tid}`),
    staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });

  const open = (id: string) => {
    wantFocus.current = true;
    if (id !== tid) {
      qc.removeQueries({ queryKey: ["thread", id], exact: true });
      setTitle("…");
      setTid(id);
    }
    setView("chat");
  };
  const newChat = () => open(newThreadId());
  const back = () => { wantFocus.current = true; setView("chat"); };

  // The live conversation lives in Thread; the header needs it at click time, not per render.
  const toast = useToast();
  const liveMessages = useRef<UIMessage[]>([]);
  const [messageCount, setMessageCount] = useState(0);
  const onMessages = useCallback((all: UIMessage[]) => {
    liveMessages.current = all;
    setMessageCount(all.length);
  }, []);
  // While another thread loads, the previous one must not be what the copy key copies.
  useEffect(() => {
    if (!history.isPending) return;
    liveMessages.current = [];
    setMessageCount(0);
  }, [history.isPending, tid]);

  const copyChat = async () => {
    const all = liveMessages.current;
    if (!all.length) return;
    const heading = title === "New chat" || title === "…" ? "Chat" : title;
    if (await copyText(transcriptOf(all, heading))) {
      toast({ text: `Copied chat · ${all.length} ${all.length === 1 ? "message" : "messages"}` });
    } else {
      toast({ tone: "error", text: "Couldn't copy the chat" });
    }
  };

  // Back from the history list, focus lands in the conversation: the composer on desktop,
  // the message list on a phone (so the keyboard doesn't cover the restored chat).
  useEffect(() => {
    if (view !== "chat" || !wantFocus.current) return;
    const el = mobile ? threadEl.current : composer.current;
    if (!el) return;
    wantFocus.current = false;
    el.focus({ preventScroll: true });
  }, [view, tid, history.status, mobile]);

  return (
    <ChatFrame view={view} title={view === "history" ? "Earlier chats" : history.isError ? "Not loaded" : title} historyKey={historyKey}
      onHistory={() => setView(view === "history" ? "chat" : "history")} onNew={newChat}
      onCopy={() => void copyChat()} canCopy={messageCount > 0 && view === "chat"}>
      {view === "history" && <ChatHistory current={tid} currentTitle={title} onOpen={open} onBack={back} />}
      <div className="con-body" hidden={view === "history"}>
        <Gate>
          {history.isPending ? <div className="skel" style={{ margin: 14, height: 90 }} aria-label="Loading chat" />
            : history.isError ? (
              <div className="con-err load" role="alert">
                <p>Couldn't load this chat. Nothing is lost.</p>
                <button className="key" onClick={() => void history.refetch()}>Retry</button>
                <button className="key flat" onClick={newChat}>New chat</button>
              </div>
            ) : (
              <Thread key={tid} tid={tid} initial={history.data.messages} title={history.data.title}
                composer={composer} scroller={threadEl} onTitle={setTitle} onMessages={onMessages} />
            )}
        </Gate>
      </div>
    </ChatFrame>
  );
}


function ChatFrame({ view, title, historyKey, onHistory, onNew, onCopy, canCopy, children }: {
  view: "chat" | "history"; title: string; historyKey: React.RefObject<HTMLButtonElement | null>;
  onHistory: () => void; onNew: () => void; onCopy: () => void; canCopy: boolean; children: React.ReactNode;
}) {
  const { close } = useDock();
  const inHistory = view === "history";
  return (
    <div className="panel console">
      <div className="con-hd">
        <span className="silk con-name">Chat</span>
        <span className="con-title" title={title}>{title}</span>
        <span className="fill" />
        <button ref={historyKey} className={`key sq flat ${inHistory ? "is-latched" : ""}`} aria-pressed={inHistory}
          aria-label="Chat history" title={inHistory ? "Back to the chat" : "Chat history"} onClick={onHistory}><Icon name="hist" /></button>
        <button className="key sq flat" aria-label="Copy chat" title="Copy chat as Markdown" disabled={!canCopy} onClick={onCopy}><Icon name="copy" /></button>
        <button className="key flat new" aria-label="New chat" title="New chat" onClick={onNew}><Icon name="plus" /><span className="lbl">New</span></button>
        <button className="key sq flat" aria-label="Close chat" onClick={close}><Icon name="close" /></button>
      </div>
      {children}
    </div>
  );
}

const useChatStatus = () => useQuery({ queryKey: ["chat-status"], queryFn: () => api<ChatStatus>("/api/chat/status"), staleTime: 60_000 });

/** Banners about the assistant itself, and the first-use consent before any conversation. */
function Gate({ children }: { children: React.ReactNode }) {
  const status = useChatStatus();
  return <>
    {status.data && !status.data.configured && (
      <div className="con-banner" role="status">The assistant isn't set up on this server.</div>
    )}
    {status.data?.usage.exhausted && (
      <div className="con-banner" role="status">Weekly limit reached ({status.data.usage.limit} turns). Resets {stamp(status.data.usage.resets_at, undefined, true)}.</div>
    )}
    {status.data?.configured && !status.data.consent ? <Consent status={status.data} /> : children}
  </>;
}

/** The scope the next message is sent with; the transport reads it at send time. */
const liveScope: { current: ChatScope | null } = { current: null };

/** One chat object per thread, kept outside React. Leaving a chat (another chat, the history
 * list, closing the panel) unmounts its view, and a chat owned by the view would abort its
 * request on unmount: the server then drops the turn, which came back as an empty chat. An
 * answer still streaming is picked up again as is; otherwise the thread starts from what the
 * server has, the only complete copy. */
const live = new Map<string, { chat: LiveChat<UIMessage>; from: UIMessage[] }>();
const answering = (c: LiveChat<UIMessage>) => c.status === "submitted" || c.status === "streaming";

function liveChat(tid: string, initial: UIMessage[], qc: QueryClient): LiveChat<UIMessage> {
  const had = live.get(tid);
  if (had && (answering(had.chat) || had.from === initial)) return had.chat;
  for (const [id, e] of live) if (id !== tid && !answering(e.chat)) live.delete(id);
  const chat = new LiveChat<UIMessage>({
    id: tid, messages: initial,
    transport: new DefaultChatTransport({
      api: "/api/chat",
      // The server owns history: send only the newest message, the scope captured *now*, and
      // the ids of the files attached to that message.
      prepareSendMessagesRequest: ({ id, messages }) => {
        const last = messages[messages.length - 1];
        const files = ((last?.metadata as { attachments?: MessageAttachment[] } | undefined)?.attachments ?? []).map((a) => a.id);
        return { body: { id, trigger: "submit-message", messages: messages.slice(-1), scope: liveScope.current, ...(files.length ? { attachments: files } : {}) } };
      },
    }),
    onFinish: () => {
      void qc.invalidateQueries({ queryKey: ["threads"] });
    },
  });
  live.set(tid, { chat, from: initial });
  return chat;
}

const PLAN_TOOLS = new Set(["tool-change", "tool-undo_change"]);

function Thread({ tid, initial, title, composer, scroller, onTitle, onMessages }: {
  tid: string; initial: UIMessage[]; title: string;
  composer: React.RefObject<HTMLTextAreaElement | null>; scroller: React.RefObject<HTMLDivElement | null>;
  onTitle: (t: string) => void; onMessages: (m: UIMessage[]) => void;
}) {
  const scope = useScope();
  useEffect(() => { liveScope.current = scope; }, [scope]);
  const qc = useQueryClient();
  const status = useChatStatus();
  const [chat] = useState(() => liveChat(tid, initial, qc));
  const { messages, sendMessage, status: chatState, stop, error, clearError } = useChat({ chat });
  const att = useAttachments(tid, status.data?.attachments);
  const busy = chatState === "submitted" || chatState === "streaming";
  const [dropping, setDropping] = useState(false);

  // Refresh the plan as soon as a saved change's tool result arrives (once per change).
  const seen = useRef(new Set<string>());
  useEffect(() => {
    for (const m of messages) for (const p of m.parts as any[]) {
      if (PLAN_TOOLS.has(p.type) && p.state === "output-available" && p.output?.saved && !seen.current.has(p.output.change_id)) {
        seen.current.add(p.output.change_id);
        refreshPlan(qc);
      }
    }
  }, [messages, qc, tid]);

  // Follow new output only while the reader is at the bottom.
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages, chatState, scroller]);

  // The composer grows with chips and errors: keep the end of the conversation in view.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { if (pinned.current) el.scrollTop = el.scrollHeight; });
    ro.observe(el);
    return () => ro.disconnect();
  }, [scroller]);

  const send = (text: string, files: Media[]) => {
    if (busy) return;
    pinned.current = true;
    void sendMessage({ text, metadata: { scope: liveScope.current, ...(files.length ? { attachments: files.map(briefOf) } : {}) } });
  };

  const liveTitle = (title === "New chat" && messages[0] ? (firstText(messages[0]) || "Attached files").slice(0, 60) : title) || "New chat";
  useEffect(() => onTitle(liveTitle), [liveTitle, onTitle]);
  // Hand the header the conversation it copies; the ref is read at click time.
  useEffect(() => onMessages(messages), [messages, onMessages]);
  const dragHasFiles = (e: React.DragEvent) => att.enabled && [...e.dataTransfer.types].includes("Files");
  return (
    <div className={`thread-wrap ${dropping ? "dropping" : ""}`}
      onDragEnter={(e) => { if (dragHasFiles(e)) { e.preventDefault(); setDropping(true); } }}
      onDragOver={(e) => { if (dragHasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false); }}
      onDrop={(e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        setDropping(false);
        att.add([...e.dataTransfer.files]);
      }}>
      <div className="thread" ref={scroller} tabIndex={-1} aria-label="Conversation" onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}>
        {!messages.length && <EmptyThread page={scope.page} onPick={prefillChat} />}
        {messages.map((m, i) => <Message key={m.id} m={m} turn={turnOf(messages, i)} />)}
        {busy && !hasVisibleOutput(messages) && <div className="thinking mono" role="status"><span className="dotpulse" aria-hidden="true" />Thinking…</div>}
        {error && (
          <div className="con-err" role="alert">
            <p>{assistantError(error.message)}</p>
            <button type="button" className="key" onClick={() => clearError()}>Dismiss</button>
          </div>
        )}
      </div>
      <Composer tid={tid} scope={scope} busy={busy} att={att} composer={composer} onSend={send} onStop={() => void stop()} />
      {dropping && <div className="drop-hint" aria-hidden="true"><span>Drop to attach</span></div>}
    </div>
  );
}

const STARTERS: Record<string, string[]> = {
  health: ["How has my HRV moved over the last month?", "Is my sleep keeping up with my training load?", "Chart weekly running distance against average heart rate"],
  library: ["Find a demo video for each exercise without one", "Suggest three exercises for knee stability"],
  default: ["How does this week compare with last week?", "I'm tired today. What should I drop?", "Draft a 4-week build toward a 10K"],
};

function EmptyThread({ page, onPick }: { page: string; onPick: (t: string) => void }) {
  const list = STARTERS[page] ?? STARTERS.default;
  return (
    <div className="empty-thread">
      <ul className="starters">{list.map((s) => (
        <li key={s}><button type="button" className="starter" onClick={() => onPick(s)}><span>{s}</span><Icon name="right" /></button></li>
      ))}</ul>
    </div>
  );
}
