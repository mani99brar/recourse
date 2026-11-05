import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem';
import { claimsEventsAbi, vaultEventsAbi, caseEventsAbi, decodeDocketLog } from '../src/events.js';
import { ArbitrumCaseSource, MirrorLogSource } from '../src/sources.js';
import { PLATFORM, SHOP, cid } from './helpers.js';

function ruledLog(n: number, ruling: number, attempts: number) {
  const topics = encodeEventTopics({ abi: claimsEventsAbi, eventName: 'RulingReceived', args: { claimId: cid(n) } });
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint8' }, { type: 'uint8' }, { type: 'bytes32' }],
    [77n, ruling, attempts, cid(0)],
  );
  return { topics, data };
}

describe('event decoding', () => {
  it('decodes the claims, vault and case events the docket follows', () => {
    const meta = { tx: '0xabc', index: 3, ts: 1_800_000_000 };
    expect(decodeDocketLog('hedera', meta, ruledLog(1, 2, 1))).toMatchObject({ name: 'RulingReceived', claimId: cid(1), disputeId: '77', ruling: 2, attempts: 1, ts: 1_800_000_000 });

    const filedTopics = encodeEventTopics({ abi: claimsEventsAbi, eventName: 'ClaimFiled', args: { claimId: cid(2), shop: SHOP, platform: PLATFORM } });
    const filedData = encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'tuple', components: [{ name: 'topicNum', type: 'uint64' }, { name: 'seq', type: 'uint64[6]' }, { name: 'hashes', type: 'bytes32[6]' }] },
        { type: 'uint256' }, { type: 'uint256' }, { type: 'uint64' },
      ],
      [cid(9), { topicNum: 5n, seq: [1n, 2n, 3n, 4n, 5n, 6n], hashes: Array(6).fill(cid(1)) as Hex[] }, 12_000_000n, 11_000_000n, 1_800_000_000n],
    );
    expect(decodeDocketLog('hedera', meta, { topics: filedTopics, data: filedData })).toMatchObject({ name: 'ClaimFiled', claimId: cid(2), shop: SHOP, platform: PLATFORM, filedAt: 1_800_000_000 });

    const appliedTopics = encodeEventTopics({ abi: vaultEventsAbi, eventName: 'OutcomeApplied', args: { claimId: cid(2), platform: PLATFORM, shop: SHOP } });
    const appliedData = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [2_000_000n, 1_000_000n, 0n]);
    expect(decodeDocketLog('hedera', meta, { topics: appliedTopics, data: appliedData })).toMatchObject({ name: 'OutcomeApplied', paid: '2000000', refund: '1000000' });

    const openedTopics = encodeEventTopics({ abi: caseEventsAbi, eventName: 'CaseOpened', args: { claimId: cid(2) } });
    const openedData = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint8' }], [41n, 1]);
    expect(decodeDocketLog('arbitrum', meta, { topics: openedTopics, data: openedData })).toMatchObject({ name: 'CaseOpened', disputeId: '41', attempt: 1 });
  });

  it('ignores events it does not follow', () => {
    expect(decodeDocketLog('hedera', { tx: '0x1', index: 0, ts: 1 }, { topics: ['0x' + '11'.repeat(32)], data: '0x' })).toBeNull();
  });
});

describe('mirror log source', () => {
  function mirror(pages: Record<string, unknown>) {
    const urls: string[] = [];
    const fetch = async (url: string) => {
      urls.push(url);
      const path = url.replace('https://mirror.test', '');
      const body = pages[path];
      if (body === undefined) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    };
    return { fetch, urls };
  }

  it('follows next links, advances the cursor, and skips logs at or before it', async () => {
    const a = ruledLog(1, 1, 1);
    const b = ruledLog(2, 3, 1);
    const log = (l: { topics: readonly string[]; data: string }, ts: string, tx: string) => ({ topics: l.topics, data: l.data, index: 0, timestamp: ts, transaction_hash: tx });
    const { fetch, urls } = mirror({
      '/api/v1/contracts/0xclaims/results/logs?order=asc&limit=100': { logs: [log(a, '1800000000.000000001', '0xaa')], links: { next: '/api/v1/contracts/0xclaims/results/logs?order=asc&limit=100&timestamp=gt:1800000000.000000001&page=2' } },
      '/api/v1/contracts/0xclaims/results/logs?order=asc&limit=100&timestamp=gt:1800000000.000000001&page=2': { logs: [log(b, '1800000005.500000000', '0xbb')], links: { next: null } },
      '/api/v1/contracts/0xclaims/results/logs?order=asc&limit=100&timestamp=gt:1800000005.500000000': { logs: [log(b, '1800000005.500000000', '0xbb')], links: { next: null } },
    });
    const src = new MirrorLogSource({ baseUrl: 'https://mirror.test/', contract: '0xclaims', name: 'hedera-claims', fetch });
    const first = await src.poll(undefined);
    expect(first.events.map((e) => e.name === 'RulingReceived' && e.claimId)).toEqual([cid(1), cid(2)]);
    expect(first.cursor).toBe('1800000005.500000000');
    const second = await src.poll(first.cursor);
    expect(second.events).toHaveLength(0); // the repeated log is at the cursor
    expect(second.cursor).toBe('1800000005.500000000');
    expect(urls).toHaveLength(3);
  });

  it('reports a mirror error instead of advancing', async () => {
    const { fetch } = mirror({});
    const src = new MirrorLogSource({ baseUrl: 'https://mirror.test', contract: '0xclaims', name: 'x', fetch });
    await expect(src.poll('1.0')).rejects.toThrow(/404/);
  });
});

describe('arbitrum source', () => {
  it('reads in chunks of at most 1,000 blocks and resumes after the last block read', async () => {
    const calls: [bigint, bigint][] = [];
    const topics = encodeEventTopics({ abi: caseEventsAbi, eventName: 'CaseOpened', args: { claimId: cid(1) } });
    const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint8' }], [9n, 1]);
    const reader = {
      getBlockNumber: async () => 2_500n,
      getLogs: async ({ fromBlock, toBlock }: { address: `0x${string}`; fromBlock: bigint; toBlock: bigint }) => {
        calls.push([fromBlock, toBlock]);
        return fromBlock === 1_001n ? [{ topics, data, transactionHash: '0xdd', logIndex: 0, blockNumber: 1_500n }] : [];
      },
    };
    const src = new ArbitrumCaseSource(reader, '0x00000000000000000000000000000000000000cc', 1n);
    const first = await src.poll(undefined);
    expect(calls).toEqual([[1n, 1000n], [1001n, 2000n], [2001n, 2500n]]);
    expect(first.cursor).toBe('2500');
    expect(first.events).toHaveLength(1);
    calls.length = 0;
    expect((await src.poll(first.cursor)).events).toHaveLength(0);
    expect(calls).toEqual([]); // nothing past the head
  });

  it('refuses a chunk over 1,000 blocks', () => {
    expect(() => new ArbitrumCaseSource({ getBlockNumber: async () => 0n, getLogs: async () => [] }, '0x00000000000000000000000000000000000000cc', 0n, 1001n)).toThrow();
  });
});
