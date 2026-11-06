// Document store port: fetch a document by CID, pin new bytes. The gateway side fetches over
// HTTP with a bytes cache and a request budget; pinning comes from a pin client handed in by the
// entry point. `LocalDocStore` is a stand-in for tests and local runs only.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBytes, TransientError, type FetchLike } from '@recourse/keeper';
import { hexToBytes, sha256 } from '@recourse/shared';

export interface FetchOptions {
  /** Skip the cache and replace the cached bytes (used to re-read a document that failed its hash). */
  fresh?: boolean;
}

/** The document is larger than the store reads. Its size is fixed by its CID, so this never passes. */
export class DocTooLarge extends Error {
  constructor(readonly cid: string, detail: string) {
    super(`document ${cid} is too large: ${detail}`);
    this.name = 'DocTooLarge';
  }
}

/** Largest document a store reads: the records package's fetch limit. */
export const DOC_FETCH_MAX_BYTES = 256 * 1024;

export interface DocStore {
  /**
   * Bytes at the CID, or null when the store has no such document (a definite miss). Throws
   * DocTooLarge for a document over DOC_FETCH_MAX_BYTES and TransientError on a failure that may pass.
   */
  fetch(cid: string, options?: FetchOptions): Promise<Uint8Array | null>;
  /** Pins the exact bytes and returns their CID. */
  pin(bytes: Uint8Array): Promise<string>;
}

/** The pin half of a store: the real client lives in another package and is wired in by the entry point. */
export interface PinClient {
  pin(bytes: Uint8Array): Promise<string>;
}

const CID = /^[A-Za-z0-9]+$/;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** CIDv1 of one raw block: version 1, raw codec, sha2-256, base32 lower with the `b` prefix. */
export function rawBlockCid(bytes: Uint8Array): string {
  const digest = hexToBytes(sha256(bytes));
  const cid = new Uint8Array(4 + digest.length);
  cid.set([0x01, 0x55, 0x12, 0x20], 0);
  cid.set(digest, 4);
  return `b${base32(cid)}`;
}

export interface GatewayDocStoreOptions {
  /** Base URL of the gateway; documents are read at `<url>/ipfs/<cid>`. */
  gatewayUrl: string;
  /** Pins new documents. Without one, `pin` throws. */
  pinClient?: PinClient;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Cached documents kept (oldest dropped first). Default 256. */
  cacheEntries?: number;
  /** Requests allowed per rolling minute. The gateway allows about 200; default 180. */
  maxPerMinute?: number;
  now?: () => number;
}

export class GatewayDocStore implements DocStore {
  private readonly base: string;
  private readonly cache = new Map<string, Uint8Array>();
  private readonly sent: number[] = [];

  constructor(private readonly o: GatewayDocStoreOptions) {
    this.base = o.gatewayUrl.replace(/\/+$/, '');
  }

  async fetch(cid: string, options: FetchOptions = {}): Promise<Uint8Array | null> {
    if (!CID.test(cid)) return null;
    if (options.fresh !== true) {
      const hit = this.cache.get(cid);
      if (hit !== undefined) return hit;
    }
    this.spendRequest();
    const bytes = await getBytes(`${this.base}/ipfs/${cid}`, { fetch: this.o.fetch, timeoutMs: this.o.timeoutMs });
    if (bytes === null) return null;
    if (bytes.length > DOC_FETCH_MAX_BYTES) throw new DocTooLarge(cid, `${bytes.length} bytes`);
    this.cache.delete(cid);
    this.cache.set(cid, bytes);
    const cap = this.o.cacheEntries ?? 256;
    while (this.cache.size > cap) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      this.cache.delete(oldest.value);
    }
    return bytes;
  }

  async pin(bytes: Uint8Array): Promise<string> {
    if (this.o.pinClient === undefined) throw new Error('no pin client is configured');
    return this.o.pinClient.pin(bytes);
  }

  private spendRequest(): void {
    const now = (this.o.now ?? Date.now)();
    while (this.sent.length > 0 && now - this.sent[0]! >= 60_000) this.sent.shift();
    if (this.sent.length >= (this.o.maxPerMinute ?? 180)) throw new TransientError('gateway request budget spent; retry shortly');
    this.sent.push(now);
  }
}

/**
 * LOCAL STAND-IN, for tests and local runs only. Documents are files named by their CID under one
 * directory; nothing is pinned to IPFS and no gateway is involved. The CIDs have the real raw-block
 * form so records and messages built with them look like live ones.
 */
export class LocalDocStore implements DocStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  async fetch(cid: string): Promise<Uint8Array | null> {
    if (!CID.test(cid)) return null;
    try {
      return new Uint8Array(readFileSync(join(this.dir, cid)));
    } catch {
      return null;
    }
  }

  async pin(bytes: Uint8Array): Promise<string> {
    const cid = rawBlockCid(bytes);
    const tmp = join(this.dir, `${cid}.tmp`);
    writeFileSync(tmp, bytes);
    renameSync(tmp, join(this.dir, cid));
    return cid;
  }
}

/**
 * Fetch half of the records package's pin client: bytes checked against the CID, throws on a miss.
 * Its errors carry a `code`: `not_found` for a definite miss, `document_too_large` for a document
 * over its limit, anything else for a failure that may pass.
 */
export interface CheckedFetcher {
  fetch(cid: string): Promise<Uint8Array>;
}

export interface PinnedDocStoreOptions {
  /** Reads a document; the bytes it returns always hash to their CID. */
  source: CheckedFetcher;
  /** Pins new documents. Without one, `pin` throws. */
  pinClient?: PinClient;
  cacheEntries?: number;
}

/**
 * Store over the shared pin client (the host's local content store, or Filebase through the
 * gateway). A definite miss (`not_found`: not in the store and no gateway, a gateway 404, a CID
 * that is not raw SHA-256) is null; a document over the fetch limit is DocTooLarge; every other
 * failure (a gateway error, bytes that do not match their CID) is a retry. The pre-check turns a
 * miss or a retry that lasts past its wait into a rejection.
 */
export class PinnedDocStore implements DocStore {
  private readonly cache = new Map<string, Uint8Array>();

  constructor(private readonly o: PinnedDocStoreOptions) {}

  async fetch(cid: string, options: FetchOptions = {}): Promise<Uint8Array | null> {
    if (!CID.test(cid)) return null;
    if (options.fresh !== true) {
      const hit = this.cache.get(cid);
      if (hit !== undefined) return hit;
    }
    let bytes: Uint8Array;
    try {
      bytes = await this.o.source.fetch(cid);
    } catch (err) {
      const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
      const message = err instanceof Error ? err.message : String(err);
      if (code === 'not_found') return null;
      if (code === 'document_too_large') throw new DocTooLarge(cid, message);
      throw new TransientError(`document ${cid} not readable yet: ${message}`);
    }
    this.cache.delete(cid);
    this.cache.set(cid, bytes);
    while (this.cache.size > (this.o.cacheEntries ?? 256)) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      this.cache.delete(oldest.value);
    }
    return bytes;
  }

  async pin(bytes: Uint8Array): Promise<string> {
    if (this.o.pinClient === undefined) throw new Error('no pin client is configured');
    return this.o.pinClient.pin(bytes);
  }
}
