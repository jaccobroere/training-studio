/** Tiny fetch wrapper. Every API error is one envelope, `{code, detail, request_id, ...extra}`
 *  (backend/core/errors.py); `ApiError` carries it to the UI. */

/** The server said the session is gone: the shell marks the cached status signed out
 *  instead of refetching it (see auth/session.tsx). */
export const SIGNED_OUT_EVENT = "sports:signed-out";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public body: any,
    public retryAfter?: number,
  ) {
    super(body?.detail || code);
  }

  get requestId(): string | undefined {
    return this.body?.request_id;
  }
}

/** The server's retry window in whole seconds: the header Caddy sends, else the JSON
 *  `retry_after` the app's own limiter puts in the envelope. Anything else is no window. */
function retryWindow(headers: Headers, body: any): number | undefined {
  const header = headers.get("Retry-After");
  const raw = header || body?.retry_after;
  const seconds = Math.ceil(Number(raw));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(path, {
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...rest.headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  const body = text ? safeJson(text) : null;
  // Only the session code signs the shell out. A wrong password or a Garmin credential
  // also answers 401; those belong to the form that asked, not to a session reset.
  if (res.status === 401 && body?.code === "signed_out") {
    window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  }
  if (!res.ok) {
    throw new ApiError(res.status, body?.code || `http_${res.status}`, body,
      retryWindow(res.headers, body));
  }
  return body as T;
}

function safeJson(t: string) {
  try {
    return JSON.parse(t);
  } catch {
    return { detail: t };
  }
}

export const newOpId = () => `op-${crypto.randomUUID()}`;
