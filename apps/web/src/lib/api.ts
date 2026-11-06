import { useEffect, useRef, useState } from 'react';
import type { VaultToken } from '@recourse/shared';

const BASE = (import.meta.env?.VITE_STATUS_API_URL as string | undefined) ?? '/api';
export const POLL_MS = Number(import.meta.env?.VITE_POLL_MS ?? 5000);

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** The API's own sentence for people (v1 errors); null on the older `{ error: code }` form. */
    readonly said: string | null = null,
    /** v1 `error.details`: facts such as `field`, `closesAt`, `contester`, `revert`. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

/** An error body in either form: v1 `{ error: { code, message, details? } }` or the older `{ error: code }`. */
export function failureFrom(status: number, body: unknown): ApiFailure {
  const e = (body as { error?: unknown } | null | undefined)?.error;
  if (typeof e === 'string') return new ApiFailure(status, e);
  if (e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string') {
    const { code, message, details } = e as { code: string; message?: unknown; details?: unknown };
    return new ApiFailure(status, code, typeof message === 'string' ? message : null, details && typeof details === 'object' ? (details as Record<string, unknown>) : {});
  }
  return new ApiFailure(status, 'unreachable');
}

/** The full URL of an API path ("/claims/0x…" or "/v1/claims/0x…"). */
export function apiUrl(path: string): string {
  return `${BASE}${path}`;
}

export async function getApi<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(apiUrl(path), { signal: signal ?? null, headers: { accept: 'application/json' } });
  const body = (await r.json().catch(() => ({}))) as unknown;
  if (!r.ok) throw failureFrom(r.status, body);
  return body as T;
}

export interface Fresh {
  asOf?: { hedera: number | null; arbitrum: number | null; hcs: number | null };
  degraded?: string[];
  /** The deployment's vault token: every vault amount in the body is in it. */
  vaultToken?: VaultToken;
  /** Until every contract is locked, what the owner can still change (`notice`, plain words). */
  configLock?: { allLocked: boolean | null; notice: string | null };
}

export interface PollState<T> {
  data: T | null;
  error: ApiFailure | null;
  loading: boolean;
}

/** Fetches a path now and every POLL_MS. Keeps the last good data when a later fetch fails. */
export function usePoll<T>(path: string | null, ms: number = POLL_MS): PollState<T> {
  const [state, setState] = useState<PollState<T>>({ data: null, error: null, loading: path !== null });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (path === null) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      try {
        const data = await getApi<T>(path, ctl.signal);
        if (alive.current) setState({ data, error: null, loading: false });
      } catch (e) {
        if (!alive.current || ctl.signal.aborted) return;
        const err = e instanceof ApiFailure ? e : new ApiFailure(0, 'unreachable');
        setState((s) => ({ data: s.data, error: err, loading: false }));
      }
      if (alive.current) timer = setTimeout(run, ms);
    };
    void run();
    return () => {
      alive.current = false;
      ctl.abort();
      clearTimeout(timer);
    };
  }, [path, ms]);
  return state;
}
