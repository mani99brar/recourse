import { useEffect, useRef, useState } from 'react';

const BASE = (import.meta.env?.VITE_STATUS_API_URL as string | undefined) ?? '/api';
export const POLL_MS = Number(import.meta.env?.VITE_POLL_MS ?? 5000);

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export async function getApi<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { signal: signal ?? null, headers: { accept: 'application/json' } });
  const body = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new ApiFailure(r.status, body.error ?? 'unreachable');
  return body as T;
}

export interface Fresh {
  asOf?: { hedera: number | null; arbitrum: number | null; hcs: number | null };
  degraded?: string[];
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
