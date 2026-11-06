// Live reads a request waits on for a bounded time. Each keeps the last value it read and when; a
// read that fails or has not answered in time leaves that value in place, the request is served
// from it (or without it), and meta.degraded and meta.stale say so. A read runs once at a time per
// key: a relay that hangs for a minute is asked once, not again on every request meanwhile.

import { AsyncLocalStorage } from 'node:async_hooks';

const deadline = new AsyncLocalStorage<number>();

/** Runs `fn` so that every bounded wait inside it ends `ms` from now at the latest. */
export function withDeadline<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  return deadline.run(Date.now() + ms, fn);
}

/** Milliseconds left to wait: `waitMs`, or less when the request's deadline comes first. */
function waitLeft(waitMs: number): number {
  const end = deadline.getStore();
  return Math.max(0, end === undefined ? waitMs : Math.min(waitMs, end - Date.now()));
}

/** `p`, or a rejection with `late()` once `waitMs` (or the request's deadline) has passed. */
export async function bounded<T>(p: Promise<T>, waitMs: number, late: () => unknown): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(late()), waitLeft(waitMs));
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** `p`'s value when it answers within `waitMs` (or the request's deadline), else `fallback`; a rejection gives `fallback` too. */
export function within<T, F>(p: Promise<T>, waitMs: number, fallback: F): Promise<T | F> {
  return bounded(p, waitMs, () => fallback).catch(() => fallback);
}

/** A value as last read: null before any read succeeded. `readAt` is unix seconds. */
export interface Held<T> {
  value: T | null;
  readAt: number | null;
}

interface Entry<T> extends Held<T> {
  pending: Promise<void> | null;
  /** The last read failed, or a request stopped waiting for it; cleared when a read succeeds. */
  behind: boolean;
}

export interface LastGoodOptions {
  /** A value younger than this is served without a read. */
  freshMs: number;
  /** How long a request waits on a read before it is served the last value. */
  waitMs: number;
  nowS: () => number;
  maxKeys?: number;
}

export class LastGood<T> {
  private m = new Map<string, Entry<T>>();
  constructor(private o: LastGoodOptions) {}

  private entry(key: string): Entry<T> {
    let e = this.m.get(key);
    if (!e) {
      e = { value: null, readAt: null, pending: null, behind: false };
      this.m.set(key, e);
      if (this.m.size > (this.o.maxKeys ?? 1000)) this.m.delete(this.m.keys().next().value as string);
    }
    return e;
  }

  /** Starts a read of `key` unless one is running or the value is fresh; resolves when it settles. */
  refresh(key: string, load: () => Promise<T>): Promise<void> {
    const e = this.entry(key);
    if (e.pending) return e.pending;
    if (e.readAt !== null && !e.behind && (this.o.nowS() - e.readAt) * 1000 < this.o.freshMs) return Promise.resolve();
    e.pending = load()
      .then(
        (v) => {
          e.value = v;
          e.readAt = this.o.nowS();
          e.behind = false;
        },
        () => {
          e.behind = true;
        },
      )
      .finally(() => {
        e.pending = null;
      });
    return e.pending;
  }

  /** `key`'s value, read first when not fresh: the read is waited on for a bounded time, then the last value stands. */
  async get(key: string, load: () => Promise<T>): Promise<Held<T>> {
    const e = this.entry(key);
    const done = await within(this.refresh(key, load).then(() => true), this.o.waitMs, false);
    if (!done) e.behind = true;
    return { value: e.value, readAt: e.readAt };
  }

  peek(key: string): Held<T> {
    const e = this.m.get(key);
    return { value: e?.value ?? null, readAt: e?.readAt ?? null };
  }

  /** Null while every key is current; else the oldest value served in place of a failed or late read (readAt null: a key never read). */
  behind(): { readAt: number | null } | null {
    let out: { readAt: number | null } | null = null;
    for (const e of this.m.values()) {
      if (!e.behind) continue;
      if (out === null || e.readAt === null || (out.readAt !== null && e.readAt < out.readAt)) out = { readAt: e.readAt };
    }
    return out;
  }
}
