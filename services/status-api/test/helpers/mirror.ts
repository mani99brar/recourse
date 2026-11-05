// An in-memory mirror node: serves paged contract logs, topic messages and the blocks endpoint
// through an injected fetch. Pages are small on purpose so page boundaries are exercised.
import type { FetchLike } from '../../src/http.js';
import { padTimestamp } from '../../src/decode.js';
import type { SimLog } from './encode.js';
import { Buffer } from 'node:buffer';

export interface TopicMsg {
  seq: number;
  ts: string;
  payer: string;
  body: Uint8Array;
}

export class FakeMirror {
  logs = new Map<string, SimLog[]>();
  topics = new Map<string, TopicMsg[]>();
  headTs = '1700000000.000000000';
  pageSize = 2;
  failNext = 0;
  requests: string[] = [];

  addLogs(address: string, logs: SimLog[]): void {
    const key = address.toLowerCase();
    this.logs.set(key, [...(this.logs.get(key) ?? []), ...logs]);
  }

  fetch: FetchLike = async (url) => {
    this.requests.push(url);
    if (this.failNext > 0) {
      this.failNext--;
      return { ok: false, status: 503, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    }
    const u = new URL(url);
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
    const skip = Number(u.searchParams.get('skip') ?? '0');
    const next = (n: number, total: number) => {
      if (skip + n >= total) return null;
      const q = new URLSearchParams(u.searchParams);
      q.set('skip', String(skip + n));
      return `${u.pathname}?${q.toString()}`;
    };
    let m = /^\/api\/v1\/contracts\/(0x[0-9a-fA-F]+)\/results\/logs$/.exec(u.pathname);
    if (m) {
      const all = this.logs.get(m[1]!.toLowerCase()) ?? [];
      const ts = u.searchParams.get('timestamp') ?? 'gte:0';
      const [op, val] = ts.split(':') as [string, string];
      const min = padTimestamp(val);
      const matching = all
        .filter((l) => (op === 'gte' ? padTimestamp(l.ts) >= min : padTimestamp(l.ts) > min))
        .sort((a, b) => (a.raw.order < b.raw.order ? -1 : 1));
      const page = matching.slice(skip, skip + this.pageSize);
      return ok({
        logs: page.map((l) => ({
          address: l.raw.address,
          data: l.raw.data,
          index: l.raw.logIndex,
          topics: l.raw.topics,
          timestamp: l.ts,
          transaction_hash: l.raw.tx,
        })),
        links: { next: next(page.length, matching.length) },
      });
    }
    m = /^\/api\/v1\/topics\/([\d.]+)\/messages$/.exec(u.pathname);
    if (m) {
      const all = this.topics.get(m[1]!) ?? [];
      const gt = Number((u.searchParams.get('sequencenumber') ?? 'gt:0').split(':')[1]);
      const matching = all.filter((x) => x.seq > gt);
      const page = matching.slice(skip, skip + this.pageSize);
      return ok({
        messages: page.map((x) => ({
          consensus_timestamp: x.ts,
          message: Buffer.from(x.body).toString('base64'),
          payer_account_id: x.payer,
          sequence_number: x.seq,
        })),
        links: { next: next(page.length, matching.length) },
      });
    }
    if (u.pathname === '/api/v1/blocks') return ok({ blocks: [{ timestamp: { from: this.headTs, to: this.headTs } }] });
    return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  };
}
