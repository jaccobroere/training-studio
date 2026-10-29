/** Back-to-back edits of the same workout without 409s.
 *
 * Every write carries `expected: {"workout:w-1": 3}` read from the cache. When the user edits
 * the same row twice before the first response lands (ticking two tags, holding Alt+↓, dragging a
 * chip twice), the second request would carry the version the first one just bumped. So:
 *
 * 1. Writes are serialised per entity key: a write waits for every earlier write that touches any
 *    of its keys (`Serial`).
 * 2. Each response teaches us the server's new versions (`diffs[].after.version`, plus every
 *    `expected` the server accepted). A write that waited for one of our own writes sends the
 *    version that write produced instead of the (now stale) one its caller read (`Versions`).
 *
 * A version we did not produce ourselves is never overridden, so edits made elsewhere still 409.
 * No React here; unit-tested directly. */
import type { ChangeResult } from "../api/types";

export type Op = Record<string, unknown> & { op: string };

/** Entity keys a change touches: its `expected` keys plus workout/activity ids named in ops. */
export function lockKeys(ops: Op[], expected?: Record<string, number>): string[] {
  const out = new Set(Object.keys(expected ?? {}));
  for (const o of ops) {
    const isActivityOp = o.op.includes("activity");
    if (typeof o.id === "string") out.add(`${isActivityOp ? "activity" : o.op.includes("exercise") ? "exercise" : o.op.includes("saved") ? "saved" : "workout"}:${o.id}`);
    if (Array.isArray(o.ids)) for (const id of o.ids) if (typeof id === "string") out.add(`workout:${id}`);
    if (typeof o.workout_id === "string") out.add(`workout:${o.workout_id}`);
    if (typeof o.activity_id === "string") out.add(`activity:${o.activity_id}`);
  }
  return [...out];
}

/** A per-key FIFO: `run(keys, fn)` starts `fn` once every earlier task sharing a key settled. */
export class Serial {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const before = [...new Set(keys)].map((k) => this.tails.get(k)).filter((p): p is Promise<unknown> => !!p);
    const start = before.length ? Promise.allSettled(before).then(() => undefined) : Promise.resolve();
    const task = start.then(fn);
    const settled = task.then(() => undefined, () => undefined);
    for (const k of keys) this.tails.set(k, settled);
    // Forget keys whose last task is done so the map doesn't grow forever.
    void settled.then(() => { for (const k of keys) if (this.tails.get(k) === settled) this.tails.delete(k); });
    return task;
  }

  /** Keys with a write still queued or in flight. */
  busy(key: string): boolean {
    return this.tails.has(key);
  }
}

/** Versions our own writes produced, stamped with when we learned them. */
export class Versions {
  private seq = 0;
  private known = new Map<string, { v: number; at: number }>();

  /** A stamp to take when a write is queued (before it waits). */
  mark(): number {
    return ++this.seq;
  }

  /** After a successful write: the versions the server accepted and the ones it produced. */
  learn(sent: Record<string, number> | undefined, res: Pick<ChangeResult, "diffs">): void {
    const at = ++this.seq;
    for (const [k, v] of Object.entries(sent ?? {})) this.known.set(k, { v, at });
    for (const d of res.diffs ?? []) {
      if (!d.after) { this.known.delete(d.key); continue; }
      const v = d.after.version;
      if (typeof v === "number") this.known.set(d.key, { v, at });
    }
  }

  /** The `expected` to send for a write queued at `since`: a version one of our own writes
   * produced after that replaces the caller's (stale) read; everything else is kept. */
  resolve(expected: Record<string, number> | undefined, since: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(expected ?? {})) {
      const n = this.known.get(k);
      out[k] = n && n.at > since ? n.v : v;
    }
    return out;
  }
}

/** Optimistic version bump for a cached row that a pending write is about to change. */
export const bump = <T extends { version: number }>(x: T): T => ({ ...x, version: x.version + 1 });
