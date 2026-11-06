import { describe, expect, it } from 'vitest';
import { PermanentError, TransientError, getBytes, getJson, postJson, type FetchLike } from '../src/net.js';

const URL_WITH_KEY = 'https://mirror.example/api/v1/x?key=hidden';

/** A body that sends its first bytes and then never ends, whatever the request's signal does. */
function stalledBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"logs": ['));
    },
  });
}

describe('keeper HTTP reads', () => {
  it('reads JSON, gives null on 404 and splits retryable answers from final ones', async () => {
    const answer = (status: number, body = '{"ok": true}'): FetchLike => async () => new Response(body, { status });
    expect(await getJson(URL_WITH_KEY, { fetch: answer(200) })).toEqual({ ok: true });
    expect(await getJson(URL_WITH_KEY, { fetch: answer(404) })).toBeNull();
    await expect(getJson(URL_WITH_KEY, { fetch: answer(503) })).rejects.toBeInstanceOf(TransientError);
    await expect(getJson(URL_WITH_KEY, { fetch: answer(400) })).rejects.toBeInstanceOf(PermanentError);
    await expect(getJson(URL_WITH_KEY, { fetch: answer(200, '{"logs": [') })).rejects.toThrow(/bad JSON/);
    await expect(postJson(URL_WITH_KEY, {}, { fetch: answer(200) })).resolves.toBeUndefined();
  });

  it('times out a body that stalls after the headers, and never prints the query string', async () => {
    const fetch: FetchLike = async () => new Response(stalledBody(), { status: 200 });
    const err = await getJson(URL_WITH_KEY, { fetch, timeoutMs: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect((err as Error).message).toBe('timeout on https://mirror.example/api/v1/x');
    await expect(getBytes(URL_WITH_KEY, { fetch, timeoutMs: 20 })).rejects.toThrow(/^timeout on /);
  });

  it('times out a body that the abort ends, as fetch does', async () => {
    const fetch: FetchLike = async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"logs": ['));
          init?.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(body, { status: 200 });
    };
    await expect(getJson(URL_WITH_KEY, { fetch, timeoutMs: 20 })).rejects.toThrow(/^timeout on /);
  });

  it('times out an answer whose headers never come', async () => {
    const fetch: FetchLike = () => new Promise<Response>(() => {});
    await expect(getJson(URL_WITH_KEY, { fetch, timeoutMs: 20 })).rejects.toThrow(/^timeout on /);
    await expect(postJson(URL_WITH_KEY, {}, { fetch, timeoutMs: 20 })).rejects.toBeInstanceOf(TransientError);
  });

  it('calls a refused connection a network error', async () => {
    const fetch: FetchLike = async () => Promise.reject(new TypeError('fetch failed'));
    await expect(getJson(URL_WITH_KEY, { fetch })).rejects.toThrow('network error on https://mirror.example/api/v1/x');
  });
});
