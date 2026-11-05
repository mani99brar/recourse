// Record documents by CID through an HTTP gateway: cached forever, rate limited, and hashed so
// callers can compare the bytes with the HCS message.

import { isCanonical, parseCanonical, recordHash } from '@recourse/shared';
import type { Hex } from 'viem';
import { getBytes, type FetchLike } from './http.js';

export interface DocInfo {
  cid: string;
  /** SHA-256 of the exact bytes fetched. */
  hash: Hex;
  canonical: boolean;
  /** Parsed document when canonical, else null. */
  doc: unknown | null;
  bytes: Uint8Array;
}

export class DocFetcher {
  private cache = new Map<string, DocInfo>();
  private stamps: number[] = [];
  constructor(
    private opts: { fetch: FetchLike; gatewayUrl: string | null; ratePerMin: number; timeoutMs: number; now?: () => number },
  ) {}

  /** The cached document, or undefined when not fetched yet. */
  peek(cid: string): DocInfo | undefined {
    return this.cache.get(cid);
  }

  /**
   * Fetches a document unless cached. Returns null when the gateway is not configured, the rate
   * limit is spent, or the fetch fails; the caller then reports the record as unknown, not false.
   */
  async get(cid: string): Promise<DocInfo | null> {
    const hit = this.cache.get(cid);
    if (hit) return hit;
    if (this.opts.gatewayUrl === null) return null;
    const now = (this.opts.now ?? Date.now)();
    this.stamps = this.stamps.filter((t) => now - t < 60_000);
    if (this.stamps.length >= this.opts.ratePerMin) return null;
    this.stamps.push(now);
    try {
      const bytes = await getBytes(this.opts.fetch, `${this.opts.gatewayUrl}/ipfs/${cid}`, this.opts.timeoutMs);
      const canonical = isCanonical(bytes);
      const parsed = canonical ? parseCanonical(bytes) : null;
      const info: DocInfo = {
        cid,
        hash: recordHash(bytes),
        canonical,
        doc: parsed && parsed.ok ? parsed.value : null,
        bytes,
      };
      this.cache.set(cid, info);
      return info;
    } catch {
      return null;
    }
  }
}
