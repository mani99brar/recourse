// Small HTTP helper with a per-call timeout and an injectable fetch, so sources run on fixtures.

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export const realFetch: FetchLike = (url, init) => fetch(url, init);

export class HttpError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`HTTP ${status} from ${new URL(url).host}`);
  }
}

export async function getJson(f: FetchLike, url: string, timeoutMs: number): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await f(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new HttpError(r.status, url);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

export async function getBytes(f: FetchLike, url: string, timeoutMs: number): Promise<Uint8Array> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await f(url, { signal: ctl.signal });
    if (!r.ok) throw new HttpError(r.status, url);
    return new Uint8Array(await r.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

/** Error text safe to show: never includes a URL's query string or path (they can carry keys). */
export function safeError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/https?:\/\/\S+/g, '<url>').slice(0, 200);
}
