import { Icon } from "../ui/Icon";
import { useDock } from "./dock";

/** The chat entry at the right end of every page toolbar; latched while the chat is open. */
export function ChatKey() {
  const dock = useDock();
  const on = dock.view?.kind === "console";
  return (
    <button className={`key sq chat-k ${on ? "is-latched" : ""}`} aria-pressed={on} onClick={dock.toggleConsole}
      aria-label="Chat with the assistant" title="Chat (⌘J)">
      <Icon name="chat" />
    </button>
  );
}
