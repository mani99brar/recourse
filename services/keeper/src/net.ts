// HTTP reads with a timeout and a clear split between failures worth retrying (network errors,
// timeouts, 429 and 5xx) and answers that are final (404, other 4xx).

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A failure that says nothing about the data: retry later. */
export class TransientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TransientError';
  }
}

/** A definite answer that the request cannot succeed as asked. */
export class PermanentError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PermanentError';
  }
}

export function isTransient(err: unknown): boolean {
  return err instanceof TransientError;
}

export interface HttpOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
}

/** Strips query strings so errors and logs never carry an API key passed in a URL. */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  return q < 0 ? url : url.slice(0, q);
}

/**
 * Sends the request and hands the answer to `read` while the timeout still runs, so a server that
 * sends its headers and then stalls in the body is cut off as well.
 */
async function request<T>(url: string, init: RequestInit, opts: HttpOptions, read: (res: Response) => Promise<T>): Promise<T> {
  const f = opts.fetch ?? (globalThis.fetch as FetchLike);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TransientError(`timeout on ${redactUrl(url)}`));
      controller.abort();
    }, opts.timeoutMs ?? 15_000);
  });
  try {
    let res: Response;
    try {
      res = await Promise.race([f(url, { ...init, signal: controller.signal }), timedOut]);
    } catch (err) {
      if (err instanceof TransientError) throw err;
      const what = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network error';
      throw new TransientError(`${what} on ${redactUrl(url)}`);
    }
    return await Promise.race([read(res), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

function classify(res: Response, url: string): void {
  if (res.ok) return;
  if (res.status === 429 || res.status >= 500) throw new TransientError(`HTTP ${res.status} on ${redactUrl(url)}`, res.status);
  throw new PermanentError(`HTTP ${res.status} on ${redactUrl(url)}`, res.status);
}

/** GET JSON. Returns null on 404; throws TransientError or PermanentError otherwise. */
export async function getJson<T>(url: string, opts: HttpOptions = {}): Promise<T | null> {
  return request(url, { method: 'GET', headers: { accept: 'application/json' } }, opts, async (res) => {
    if (res.status === 404) return null;
    classify(res, url);
    try {
      return (await res.json()) as T;
    } catch {
      throw new TransientError(`bad JSON from ${redactUrl(url)}`);
    }
  });
}

/** GET raw bytes. Returns null on 404. */
export async function getBytes(url: string, opts: HttpOptions = {}): Promise<Uint8Array | null> {
  return request(url, { method: 'GET' }, opts, async (res) => {
    if (res.status === 404) return null;
    classify(res, url);
    try {
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      throw new TransientError(`body read failed on ${redactUrl(url)}`);
    }
  });
}

/** POST JSON; throws on any non-2xx. */
export async function postJson(url: string, body: unknown, opts: HttpOptions = {}): Promise<void> {
  return request(
    url,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    opts,
    async (res) => classify(res, url),
  );
}

/** Exponential backoff: `base * 2^n`, capped. */
export function backoffMs(failures: number, baseMs = 5_000, capMs = 60_000): number {
  if (failures <= 0) return 0;
  return Math.min(capMs, baseMs * 2 ** (failures - 1));
}
