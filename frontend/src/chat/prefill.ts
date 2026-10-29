/** Ask the chat to put text in its composer (e.g. "Discuss this chart"). If the chat
 * is not mounted yet, the text waits for it. Nothing is sent until the athlete presses Send. */
const EVT = "sports:chat-prefill";
let pending: string | null = null;

export function prefillChat(text: string) {
  pending = text;
  window.dispatchEvent(new CustomEvent<string>(EVT, { detail: text }));
}

export function onPrefill(fn: (text: string) => void): () => void {
  if (pending) { fn(pending); pending = null; }
  const h = (e: Event) => { fn((e as CustomEvent<string>).detail); pending = null; };
  window.addEventListener(EVT, h);
  return () => window.removeEventListener(EVT, h);
}

export const newThreadId = () => `t-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
