import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HederaLogReader, MirrorClient, mirrorBase } from '../src/mirror.js';
import { TransientError } from '../src/net.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function rawLog(ts: string, index: number, tx = '0xaa') {
  return {
    address: '0x00000000000000000000000000000000000000AB',
    data: '0x',
    index,
    topics: ['0xTOPIC'],
    timestamp: ts,
    transaction_hash: `${tx}${'0'.repeat(64 - tx.length + 2)}`,
    block_number: 7,
  };
}

/** Serves logs at or after the gte timestamp, two per page, following links.next. */
function logServer(all: ReturnType<typeof rawLog>[]) {
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    const u = new URL(url);
    const gte = u.searchParams.get('timestamp')!.replace('gte:', '');
    const offset = Number(u.searchParams.get('offset') ?? '0');
    const matching = all.filter((l) => Number(l.timestamp) >= Number(gte));
    const page = matching.slice(offset, offset + 2);
    const next =
      offset + 2 < matching.length
        ? `/api/v1/contracts/x/results/logs?timestamp=gte:${gte}&order=asc&limit=100&offset=${offset + 2}`
        : null;
    return new Response(JSON.stringify({ logs: page, links: { next } }), { status: 200 });
  };
  return { fetch, urls };
}

describe('mirror', () => {
  it('normalises the base URL', () => {
    expect(mirrorBase('https://m.example/api/v1/')).toBe('https://m.example');
    expect(mirrorBase('https://m.example')).toBe('https://m.example');
  });

  it('follows pagination and reports when pages remain', async () => {
    const all = [rawLog('10.000000001', 0), rawLog('10.000000001', 1), rawLog('11.000000000', 0, '0xbb')];
    const { fetch } = logServer(all);
    const m = new MirrorClient({ baseUrl: 'https://m.example', fetch });
    const full = await m.contractLogsSince('x', '0.000000000');
    expect(full.logs.map((l) => l.timestamp)).toEqual(['10.000000001', '10.000000001', '11.000000000']);
    expect(full.complete).toBe(true);
    const one = await m.contractLogsSince('x', '0.000000000', 1);
    expect(one.logs).toHaveLength(2);
    expect(one.complete).toBe(false);
  });

  it('classifies 5xx and 429 as transient, 404 as empty', async () => {
    const m503 = new MirrorClient({ baseUrl: 'https://m', fetch: async () => new Response('', { status: 503 }) });
    await expect(m503.topicMessage('0.0.1', 1n)).rejects.toBeInstanceOf(TransientError);
    const m429 = new MirrorClient({ baseUrl: 'https://m', fetch: async () => new Response('', { status: 429 }) });
    await expect(m429.newestTopicMessage('0.0.1')).rejects.toBeInstanceOf(TransientError);
    const m404 = new MirrorClient({ baseUrl: 'https://m', fetch: async () => new Response('', { status: 404 }) });
    expect(await m404.topicMessage('0.0.1', 1n)).toBeNull();
  });

  it('decodes topic messages with payer and chunk info', async () => {
    const fetch = async () =>
      new Response(
        JSON.stringify({
          consensus_timestamp: '5.000000002',
          message: Buffer.from('{"a":"b"}').toString('base64'),
          payer_account_id: '9.9.123',
          sequence_number: 4,
          topic_id: '9.9.7',
          chunk_info: { total: 1, initial_transaction_id: { account_id: '9.9.124' } },
        }),
        { status: 200 },
      );
    const m = new MirrorClient({ baseUrl: 'https://m', fetch });
    const msg = await m.topicMessage('9.9.7', 4n);
    expect(msg).toMatchObject({ seq: 4n, payer: '9.9.123', txAccount: '9.9.124', chunkTotal: 1 });
    expect(new TextDecoder().decode(msg!.bytes)).toBe('{"a":"b"}');
  });

  it('log reader re-reads an overlap after restart and never hands the same log twice in one run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keeper-mirror-'));
    dirs.push(dir);
    const all = [rawLog('1000.000000000', 0), rawLog('1100.000000000', 0, '0xbb')];
    const { fetch, urls } = logServer(all);
    const mirror = new MirrorClient({ baseUrl: 'https://m', fetch });
    const opts = { mirror, contract: 'x', dir, source: 'claims', startTimestamp: '900.000000000', overlapS: 300 };
    const r = new HederaLogReader(opts);
    const first = await r.poll();
    expect(first.logs).toHaveLength(2);
    r.commit(first.logs);
    expect(r.position).toBe('1100.000000000');
    const second = await r.poll();
    expect(second.logs).toHaveLength(0);
    r.commit(second.logs);
    // A restart starts 300 s behind the saved cursor; the caller dedupes what comes back.
    const r2 = new HederaLogReader(opts);
    await r2.poll();
    expect(urls.at(-1)).toContain('timestamp=gte:800.000000000');
  });
});
