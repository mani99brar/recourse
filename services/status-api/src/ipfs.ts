// Record documents by CID, through @recourse/records `fetchDocument`: the content store on this
// host first (IPFS_PIN_API_URL=file://...), then the gateway (IPFS_GATEWAY_URL). Every document is
// checked against the hash its caller expects (the HCS message's, or the claim's pack hash) and
// capped at MAX_DOCUMENT_BYTES while it is read. Results are kept in a cache bounded by bytes;
// documents that can never match are remembered, fetches that failed are retried after a pause.

// Imported from the records ipfs module itself, not the @recourse/records barrel: the barrel also
// loads the Hedera SDK, which took this service from 64 to 152 MB of anonymous memory at startup,
// over its 160M unit cap; this module alone costs about 23 MB.
import { IpfsError, MAX_DOCUMENT_BYTES, fetchDocument, type IpfsOptions } from '../../../packages/records/src/ipfs.js';
import { isCanonical, parseCanonical } from '@recourse/shared';
import type { Hex } from 'viem';

/** The fetch `fetchDocument` calls: a WHATWG fetch. */
export type DocFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The bytes at the CID hash to the expected value. */
export interface DocFound {
  ok: true;
  cid: string;
  hash: Hex;
  canonical: boolean;
  /** Parsed document when canonical, else null. */
  doc: unknown | null;
  size: number;
}

/** The document at the CID can never be the one the hash names. */
export interface DocRejected {
  ok: false;
  cid: string;
  hash: Hex;
  reason: 'hash_mismatch' | 'document_too_large';
}

export type DocCheck = DocFound | DocRejected;

export interface DocFetcherOptions {
  fetch: DocFetch;
  /** Local store and gateway, from `ipfsOptionsFromEnv`; null when neither is configured. */
  ipfs: Pick<IpfsOptions, 'localDir' | 'gatewayUrl'> | null;
  ratePerMin: number;
  timeoutMs: number;
  now?: () => number;
  /** Byte budget of the cache of fetched documents (default 4 MiB). */
  cacheBytes?: number;
  /** How long a failed fetch is not retried, in ms (default 60 s). */
  retryAfterMs?: number;
}

const CID_TEXT = /^[A-Za-z0-9]{1,128}$/;
/** Per-entry overhead counted on top of the document bytes. */
const ENTRY_OVERHEAD = 256;
const MAX_MISSES = 5000;

export class DocFetcher {
  /** Insertion order is recency: a hit moves to the end, eviction takes from the front. */
  private cache = new Map<string, DocCheck>();
  private cachedBytes = 0;
  private misses = new Map<string, number>();
  private stamps: number[] = [];
  constructor(private opts: DocFetcherOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** What /health reports: which document sources are configured, never their values. */
  describe(): { localStore: boolean; gateway: boolean; cached: number; cachedBytes: number } {
    return {
      localStore: Boolean(this.opts.ipfs?.localDir),
      gateway: Boolean(this.opts.ipfs?.gatewayUrl),
      cached: this.cache.size,
      cachedBytes: this.cachedBytes,
    };
  }

  /**
   * The cached result: a check, null for a fetch that failed recently (not retried yet), or
   * undefined when nothing is known.
   */
  peek(cid: string, hash: Hex): DocCheck | null | undefined {
    const key = keyOf(cid, hash);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const missed = this.misses.get(key);
    if (missed !== undefined && this.now() - missed < (this.opts.retryAfterMs ?? 60_000)) return null;
    return undefined;
  }

  /**
   * Fetches and checks a document unless known. Null means unavailable (nothing configured, the
   * rate limit spent, a fetch that failed or an error this code does not know): the caller then
   * reports the record as unknown, never as false.
   */
  async get(cid: string, hash: Hex): Promise<DocCheck | null> {
    const known = this.peek(cid, hash);
    const key = keyOf(cid, hash);
    if (known) {
      this.cache.delete(key);
      this.cache.set(key, known);
      return known;
    }
    if (known === null || this.opts.ipfs === null || !CID_TEXT.test(cid)) return null;
    const now = this.now();
    this.stamps = this.stamps.filter((t) => now - t < 60_000);
    if (this.stamps.length >= this.opts.ratePerMin) return null;
    this.stamps.push(now);
    try {
      const bytes = await fetchDocument(cid, hash, {
        ...this.opts.ipfs,
        fetchImpl: cappedFetch((u, i) => this.opts.fetch(u, i)),
        timeoutMs: this.opts.timeoutMs,
        retries: 0,
      });
      const canonical = isCanonical(bytes);
      const parsed = canonical ? parseCanonical(bytes) : null;
      const found: DocFound = { ok: true, cid, hash, canonical, doc: parsed && parsed.ok ? parsed.value : null, size: bytes.length };
      this.remember(key, found, bytes.length);
      return found;
    } catch (e) {
      if (e instanceof IpfsError && (e.code === 'hash_mismatch' || e.code === 'document_too_large')) {
        const rejected: DocRejected = { ok: false, cid, hash, reason: e.code };
        this.remember(key, rejected, 0);
        return rejected;
      }
      if (this.misses.size >= MAX_MISSES) this.misses.clear();
      this.misses.set(key, now);
      return null;
    }
  }

  private remember(key: string, check: DocCheck, bytes: number): void {
    this.misses.delete(key);
    this.cache.set(key, check);
    this.cachedBytes += bytes + ENTRY_OVERHEAD;
    const budget = this.opts.cacheBytes ?? 4 * 1024 * 1024;
    for (const [k, v] of this.cache) {
      if (this.cachedBytes <= budget || this.cache.size <= 1) break;
      this.cache.delete(k);
      this.cachedBytes -= (v.ok ? v.size : 0) + ENTRY_OVERHEAD;
    }
  }
}

function keyOf(cid: string, hash: Hex): string {
  return `${cid}:${hash.toLowerCase()}`;
}

/**
 * Wraps a fetch so a successful body is read with a running byte cap: a gateway that sends no
 * content-length, or more bytes than it announced, is cut off at `maxBytes` instead of buffered
 * whole. Past the cap it fails with `document_too_large`, which `fetchDocument` passes on.
 */
export function cappedFetch(base: DocFetch, maxBytes: number = MAX_DOCUMENT_BYTES): DocFetch {
  return async (url, init) => {
    const res = await base(url, init);
    if (!res.ok || res.body === null) return res;
    const announced = Number(res.headers.get('content-length') ?? '0');
    if (announced > maxBytes) {
      await res.body.cancel().catch(() => undefined);
      throw new IpfsError('document_too_large', `the gateway announced ${announced} bytes`);
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new IpfsError('document_too_large', `more than ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    return new Response(bytes, { status: res.status, headers: { 'content-length': String(total) } });
  };
}
