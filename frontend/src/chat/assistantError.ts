/** What the athlete reads when a chat turn fails. `message` is either the HTTP error body (a refusal
 *  before the stream starts: the API's error envelope as JSON) or the sentence the server streamed
 *  as the turn's error (backend/chat/api.py `plain_error`, already plain copy). */
const FALLBACK = "The assistant couldn't answer. Please try again.";

export function assistantError(message: string): string {
  const t = message || "";
  if (t.includes("global_quota_exceeded")) return "The assistant is paused for everyone this week. It's back Monday 00:00.";
  if (t.includes("quota_exceeded")) return "Weekly limit reached. It resets Monday 00:00.";
  if (t.includes("turn_in_progress")) return "Still answering an earlier message, possibly in another tab. Wait, then send again.";
  if (t.includes("consent_required")) return "Turn on the assistant first.";
  if (t.includes("rate_limited") || t.includes("busy")) return "Too many messages. Wait a minute, then send again.";
  if (t.includes("bad_attachment")) return "A file couldn't be used. Remove it and send again.";
  if (t.includes("assistant_unavailable") || t.includes("503")) return "The assistant is unavailable. Your plan is untouched.";
  // A streamed sentence shows as it is; anything that looks like a body, a status or a network error does not.
  const sentence = t.trim();
  if (sentence.length <= 160 && /^[A-Z][^{}<>]*[.!?]$/.test(sentence)) return sentence;
  return FALLBACK;
}
