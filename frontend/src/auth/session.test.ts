import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../api/client";
import { STATUS_KEY, statusError, subscribeSignedOut, type Me, type Status } from "./session";

const me: Me = {
  id: 1,
  username: "athlete",
  created_at: "2026-10-01T08:00:00Z",
  must_change_password: false,
  assistant_consent: true,
  privacy_seen: true,
  usage: { used: 3, limit: 200, resets_at: "2026-10-05T00:00:00Z", exhausted: false },
};

const signedIn: Status = {
  signed_in: true,
  user: me,
  password_min: 10,
  notice: "Ask the operator about a forgotten password.",
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a 401 from a data call", () => {
  it("marks the cached status signed out without refetching it", async () => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("fetch", async () =>
      jsonResponse(401, { code: "signed_out", detail: "Sign in to continue.", request_id: "r-1" }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData<Status>(STATUS_KEY, signedIn);

    // The status query must never run: it is the call that disagreed with the data routes.
    let statusCalls = 0;
    const observer = new QueryObserver(qc, {
      queryKey: STATUS_KEY,
      queryFn: async () => {
        statusCalls += 1;
        return signedIn;
      },
      staleTime: Infinity,
    });
    const stop = observer.subscribe(() => {});
    const unsubscribe = subscribeSignedOut(qc);

    const results = await Promise.allSettled([
      api("/api/week/2026-09-28"),
      api("/api/inbox"),
      api("/api/exercises"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(qc.getQueryData<Status>(STATUS_KEY)).toEqual({
      ...signedIn,
      signed_in: false,
      user: null,
    });
    expect(statusCalls).toBe(0);

    stop();
    unsubscribe();
  });
});

describe("a 401 that is not a session", () => {
  it("leaves the cached status signed in for bad credentials and Garmin", async () => {
    vi.stubGlobal("window", new EventTarget());
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData<Status>(STATUS_KEY, signedIn);
    const unsubscribe = subscribeSignedOut(qc);

    for (const [path, code] of [
      ["/api/auth/login", "bad_credentials"],
      ["/api/garmin/connect", "garmin_rejected"],
    ]) {
      vi.stubGlobal("fetch", async () =>
        jsonResponse(401, { code, detail: "Not the session." }),
      );
      await expect(api(path, { method: "POST" })).rejects.toThrow();
    }

    expect(qc.getQueryData<Status>(STATUS_KEY)).toEqual(signedIn);
    unsubscribe();
  });
});

describe("a 429 budget", () => {
  it("throws an ApiError carrying the Retry-After window", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse(
        429,
        { code: "rate_limited", detail: "Too many sign-in attempts. Try again later.", retry_after: 37 },
        { "Retry-After": "37" },
      ),
    );
    const error: unknown = await api("/api/auth/login").then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw new Error("expected an ApiError");
    expect(error.status).toBe(429);
    expect(error.retryAfter).toBe(37);
  });

  it("falls back to the envelope and ignores a window that is not a positive number", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(429, { code: "rate_limited", retry_after: 12.2 }));
    const body: unknown = await api("/api/auth/login").then(
      () => null,
      (e: unknown) => e,
    );
    expect(body instanceof ApiError && body.retryAfter).toBe(13);

    vi.stubGlobal("fetch", async () =>
      jsonResponse(429, { code: "rate_limited" }, { "Retry-After": "later" }),
    );
    const junk: unknown = await api("/api/auth/login").then(
      () => null,
      (e: unknown) => e,
    );
    expect(junk instanceof ApiError && junk.retryAfter).toBeUndefined();
  });
});

describe("status errors", () => {
  it("names the rate-limit window instead of an outage", () => {
    expect(statusError(new ApiError(429, "rate_limited", {}, 37))).toBe(
      "Too many requests, retry in 37 seconds.",
    );
    expect(statusError(new ApiError(429, "rate_limited", {}))).toBe(
      "Too many requests. Try again in a minute.",
    );
  });

  it("reserves the outage copy for network errors and 5xx", () => {
    expect(statusError(new Error("fetch failed"))).toBe("Can't reach the server.");
    expect(statusError(new ApiError(503, "http_503", {}))).toBe("Can't reach the server.");
    expect(
      statusError(new ApiError(403, "forbidden", { detail: "Cross-site request refused." })),
    ).toBe("Cross-site request refused.");
  });
});
