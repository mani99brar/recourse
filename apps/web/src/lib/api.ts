import { useEffect, useState } from 'react';
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

/** The reads the pages make: each a /v1 path of openapi.json, the same API the agents call. */
export const READS = {
  claims: () => '/v1/claims',
  partyClaims: (address: string) => `/v1/claims?party=${encodeURIComponent(address)}`,
  claim: (claimId: string) => `/v1/claims/${encodeURIComponent(claimId)}`,
  party: (address: string) => `/v1/parties/${encodeURIComponent(address)}`,
  params: () => '/v1/params',
  search: (q: string) => `/v1/search?q=${encodeURIComponent(q)}`,
  orderRecords: (orderId: string) => `/v1/orders/${encodeURIComponent(orderId)}/records`,
} as const;

const FRESH_KEYS = ['asOf', 'degraded', 'stale', 'vaultToken', 'configLock'] as const;

/**
 * A /v1 read as the pages use it: `{ <key>: value, meta }` becomes the value with meta's freshness
 * fields (Fresh) beside it. `/v1/claims` answers `{ claims, party, meta }`: its rows, and for a
 * party its standing and groups.
 */
export function fromV1(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const { meta, ...rest } = body as Record<string, unknown>;
  const fresh: Record<string, unknown> = {};
  if (meta && typeof meta === 'object') {
    for (const k of FRESH_KEYS) if (k in meta) fresh[k] = (meta as Record<string, unknown>)[k];
  }
  if (Array.isArray(rest.claims)) {
    const party = rest.party as { standing?: unknown; groups?: unknown } | null | undefined;
    return { rows: rest.claims, ...(party ? { standing: party.standing, groups: party.groups } : {}), ...fresh };
  }
  const keys = Object.keys(rest);
  const only = keys.length === 1 ? rest[keys[0]!] : undefined;
  if (only && typeof only === 'object' && !Array.isArray(only)) return { ...(only as object), ...fresh };
  return { ...rest, ...fresh };
}

/** A /v1 read, unwrapped for the pages (see fromV1). */
export async function getRead<T>(path: string, signal?: AbortSignal): Promise<T> {
  return fromV1(await getApi<unknown>(path, signal)) as T;
}

/** The status service is rebuilding its index: v1 `upstream_unavailable` with `rebuilding`, or the older `rebuilding` code. */
export function isRebuilding(e: ApiFailure): boolean {
  return e.code === 'rebuilding' || e.details.rebuilding === true;
}

export interface Fresh {
  asOf?: { hedera: number | null; arbitrum: number | null; hcs: number | null };
  degraded?: string[];
  /** Each live read in `degraded` served from its last good value, and how old that value is (null: never read). */
  stale?: { read: string; ageS: number | null }[];
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

/**
 * Reads a /v1 path (see READS) now and every POLL_MS, unwrapped. Keeps the last good data when a later read of
 * the same path fails. The state is kept with the path it was read for, so after a move to another path (another
 * claim or party) the page shows nothing of the last one, even in the render before the new read starts, and a
 * read of the last path that lands after the move is dropped.
 */
export function usePoll<T>(path: string | null, ms: number = POLL_MS): PollState<T> {
  const [state, setState] = useState<PollState<T> & { path: string | null }>({ path, data: null, error: null, loading: path !== null });
  useEffect(() => {
    if (path === null) return;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      try {
        const data = await getRead<T>(path, ctl.signal);
        if (ctl.signal.aborted) return;
        setState({ path, data, error: null, loading: false });
      } catch (e) {
        if (ctl.signal.aborted) return;
        const err = e instanceof ApiFailure ? e : new ApiFailure(0, 'unreachable');
        setState((s) => ({ path, data: s.path === path ? s.data : null, error: err, loading: false }));
      }
      timer = setTimeout(run, ms);
    };
    void run();
    return () => {
      ctl.abort();
      clearTimeout(timer);
    };
  }, [path, ms]);
  if (state.path !== path) return { data: null, error: null, loading: path !== null };
  return state;
}
