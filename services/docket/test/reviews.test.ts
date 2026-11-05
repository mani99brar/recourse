import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, memoryLogger, readJournal } from '@recourse/records';
import { erc8004ReputationAbi } from '@recourse/shared';
import { custom, decodeFunctionData, encodeAbiParameters, encodeEventTopics, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { ReviewWriter, feedbackCalldata, reviewValues, type FeedbackArgs, type ReviewChain, type ReviewRow, type SimResult } from '../src/reviews.js';
import { viemReviewChain } from '../src/reviewsChain.js';
import type { CaseRow } from '../src/schema.js';
import { caseRow } from './rows.js';
import { E, NOV, cid, rig } from './helpers.js';

const SCHEME = '0x54E4545AFcf8960884A750320e70aFE16b2b3CaE' as Address;
const AGENT_OWNER = '0xC9d6E94A0Ada9293ACbf871c4bC15c580355b623' as Address;
const CFG = { valueFault: -100, valueClear: 0, tag1: 'recourse', retrySeconds: 600, retryMax: 3 };

class FakeChain implements ReviewChain {
  schemeAddress = SCHEME;
  registered = new Set<bigint>([11n, 22n]);
  sent: FeedbackArgs[] = [];
  onChain: { agentId: bigint; hash: Hex; txHash: string }[] = [];
  failSends: Error[] = [];
  simulateCalls: Address[] = [];
  ownerRevert = 'execution reverted: Self-feedback not allowed';
  schemeRevert: string | null = null;
  async ownerOf(id: bigint) {
    return this.registered.has(id) ? AGENT_OWNER : null;
  }
  async simulate(from: Address): Promise<SimResult> {
    this.simulateCalls.push(from);
    if (from === AGENT_OWNER) return this.ownerRevert ? { ok: false, reason: this.ownerRevert } : { ok: true };
    return this.schemeRevert ? { ok: false, reason: this.schemeRevert } : { ok: true };
  }
  async send(args: FeedbackArgs) {
    const f = this.failSends.shift();
    if (f) throw f;
    this.sent.push(args);
    const txHash = `0xfeed${this.sent.length.toString(16).padStart(60, '0')}`;
    this.onChain.push({ agentId: args.agentId, hash: args.feedbackHash, txHash });
    return { txHash };
  }
  async existing(agentId: bigint, hash: Hex) {
    return this.onChain.find((e) => e.agentId === agentId && e.hash === hash) ?? null;
  }
}

function writer(chain: FakeChain, dir = mkdtempSync(join(tmpdir(), 'reviews-')), targets = { platform: 11n, shop: 22n }) {
  const path = join(dir, 'reviews.jsonl');
  const clock = { t: NOV };
  const make = () => new ReviewWriter(chain, Journal.open<ReviewRow>(path), readJournal<ReviewRow>(path).rows, targets, CFG, () => clock.t, memoryLogger());
  return { make, w: make(), clock, path };
}

const written = (n: number, over: Partial<CaseRow> = {}) => ({ claimId: cid(n), row: caseRow(n, over) });

describe('review values', () => {
  it('follow the outcome table', () => {
    expect(reviewValues(1, CFG)).toEqual({ platform: -100, shop: 0 });
    expect(reviewValues(2, CFG)).toEqual({ platform: 0, shop: -100 });
    expect(reviewValues(3, CFG)).toEqual({ platform: 0, shop: 0 });
    expect(reviewValues(0, CFG)).toBeNull();
  });
});

describe('ReviewWriter', () => {
  it('sends one review per side with the right call, and nothing for an unresolved case', async () => {
    const chain = new FakeChain();
    const { w } = writer(chain);
    await w.process([written(1, { outcome: 1, reasonCid: 'bafyreason' }), written(2, { outcome: 0, unresolved: true })]);
    expect(chain.sent).toHaveLength(2);
    const [p, s] = chain.sent;
    expect(p).toMatchObject({ agentId: 11n, value: -100n, valueDecimals: 0, tag1: 'recourse', tag2: 'platform', feedbackURI: 'ipfs://bafyreason' });
    expect(s).toMatchObject({ agentId: 22n, value: 0n, tag2: 'platform' });
    expect(p!.feedbackHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(w.statusOf(cid(1))).toMatchObject({ platform: { status: 'sent' }, shop: { status: 'sent' } });
    expect(w.statusOf(cid(2))).toMatchObject({ platform: { status: 'none' }, shop: { status: 'none' } });
  });

  it('builds calldata that decodes back to the same arguments', () => {
    const args: FeedbackArgs = { agentId: 11n, value: -100n, valueDecimals: 0, tag1: 'recourse', tag2: 'shop', endpoint: '', feedbackURI: 'ipfs://x', feedbackHash: cid(7) };
    const decoded = decodeFunctionData({ abi: erc8004ReputationAbi, data: feedbackCalldata(args) });
    expect(decoded.functionName).toBe('giveFeedback');
    expect(decoded.args).toEqual([11n, -100n, 0, 'recourse', 'shop', '', 'ipfs://x', cid(7)]);
  });

  it('runs the preflight once, as the owner (must revert) and as the scheme wallet (must succeed)', async () => {
    const chain = new FakeChain();
    const { w } = writer(chain);
    await w.process([written(1, { outcome: 1 })]);
    await w.process([written(2, { outcome: 2 })]);
    expect(chain.simulateCalls).toEqual([AGENT_OWNER, SCHEME]);
  });

  it('turns reviews off when the preflight fails, and sends nothing', async () => {
    for (const tweak of [(c: FakeChain) => (c.ownerRevert = ''), (c: FakeChain) => (c.schemeRevert = 'execution reverted'), (c: FakeChain) => c.registered.clear()]) {
      const chain = new FakeChain();
      tweak(chain);
      const { w } = writer(chain);
      await w.process([written(1, { outcome: 1 })]);
      expect(chain.sent).toHaveLength(0);
      expect(w.disabled).not.toBeNull();
      expect(w.statusOf(cid(1))).toMatchObject({ platform: { status: 'cut' } });
    }
  });

  it('skips an id that is not registered and logs it, never sending', async () => {
    const chain = new FakeChain();
    const { w } = writer(chain, undefined, { platform: 11n, shop: 99n });
    await w.process([written(1, { outcome: 1 })]);
    expect(chain.sent).toHaveLength(1);
    expect(w.statusOf(cid(1))).toMatchObject({ platform: { status: 'sent' }, shop: { status: 'skipped' } });
  });

  it('sends each (claim, side) once, across calls and restarts', async () => {
    const chain = new FakeChain();
    const { w, make } = writer(chain);
    const rows = [written(1, { outcome: 1 })];
    await w.process(rows);
    await w.process(rows);
    await make().process(rows);
    expect(chain.sent).toHaveLength(2);
  });

  it('after a cut-off send, finds the review on chain instead of sending it again', async () => {
    const chain = new FakeChain();
    const { w, make, path } = writer(chain);
    const rows = [written(1, { outcome: 1 })];
    // the send lands on chain, but the process dies before it records the result
    await w.process(rows);
    const { readFileSync, writeFileSync } = await import('node:fs');
    const kept = readFileSync(path, 'utf8').trim().split('\n').filter((l) => !l.includes('"phase":"sent"'));
    writeFileSync(path, `${kept.join('\n')}\n`);
    const again = make();
    await again.process(rows);
    expect(chain.sent).toHaveLength(2);
    expect(again.statusOf(cid(1))).toMatchObject({ platform: { status: 'sent', tx: expect.stringMatching(/^0xfeed/) } });
  });

  it('marks a revert failed, retries after the interval, and stops at the maximum', async () => {
    const chain = new FakeChain();
    chain.failSends = Array.from({ length: 10 }, () => new Error('transaction reverted'));
    const { w, clock } = writer(chain);
    const rows = [written(1, { outcome: 3 })];
    await w.process(rows);
    expect(w.statusOf(cid(1))).toMatchObject({ platform: { status: 'failed' } });
    await w.process(rows); // too soon
    expect(chain.failSends).toHaveLength(8);
    for (let i = 0; i < 6; i++) {
      clock.t += 601;
      await w.process(rows);
    }
    expect(chain.failSends.length).toBe(10 - 6); // 3 tries per side, then held
    expect(w.statusOf(cid(1))).toMatchObject({ platform: { status: 'failed' }, shop: { status: 'failed' } });
  });

  it('a review failure never changes the case write status and never blocks other claims', async () => {
    const chain = new FakeChain();
    chain.failSends = [new Error('transaction reverted'), new Error('transaction reverted')];
    const r = rig({ reviews: writer(chain).w });
    r.docket.ingest([E.filed(1), E.precheck(1, 2, 1), E.ruling(1, 1), E.filed(2), E.precheck(2, 2, 2), E.ruling(2, 2, 1, NOV + 7300)]);
    await r.docket.flush();
    expect(r.docket.writeStatus(cid(1))).toMatchObject({ writeStatus: 'written', reviews: { platform: { status: 'failed' }, shop: { status: 'failed' } } });
    expect(r.docket.writeStatus(cid(2))).toMatchObject({ writeStatus: 'written', reviews: { platform: { status: 'sent' }, shop: { status: 'sent' } } });
  });
});

describe('viem review chain', () => {
  it('simulates giveFeedback as the given caller and reads revert reasons', async () => {
    const calls: { method: string; params: unknown }[] = [];
    const transport = custom({
      async request({ method, params }) {
        calls.push({ method, params });
        if (method === 'eth_call') {
          const from = String((params as [{ from?: string }])[0].from).toLowerCase();
          if (from === AGENT_OWNER.toLowerCase()) {
            throw Object.assign(new Error('execution reverted: Self-feedback not allowed'), { code: 3, data: '0x' });
          }
          return '0x';
        }
        throw new Error(`unexpected ${method}`);
      },
    });
    const chain = viemReviewChain({ account: privateKeyToAccount(`0x${'11'.repeat(32)}`), transport, mirrorUrl: 'https://mirror.test' });
    const args: FeedbackArgs = { agentId: 11n, value: 0n, valueDecimals: 0, tag1: 't', tag2: 'u', endpoint: '', feedbackURI: '', feedbackHash: cid(1) };
    const owner = await chain.simulate(AGENT_OWNER, args);
    expect(owner.ok).toBe(false);
    expect((owner as { reason: string }).reason).toMatch(/self-feedback not allowed/i);
    expect(await chain.simulate(SCHEME, args)).toEqual({ ok: true });
    const first = calls[0]!.params as [{ data: string; to: string }];
    expect(first[0].data).toBe(feedbackCalldata(args));
    expect(calls.every((c) => c.method === 'eth_call')).toBe(true); // nothing was sent
  });

  it('finds an earlier review of ours in the registry logs by agent, client and hash', async () => {
    const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
    const topics = encodeEventTopics({ abi: erc8004ReputationAbi, eventName: 'NewFeedback', args: { agentId: 11n, clientAddress: account.address, indexedTag1: 'recourse' } });
    const data = encodeAbiParameters(
      [{ type: 'uint64' }, { type: 'int128' }, { type: 'uint8' }, { type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'bytes32' }],
      [1n, -100n, 0, 'recourse', 'platform', '', '', cid(5)],
    );
    const fetch = async () => new Response(JSON.stringify({ logs: [{ topics, data, transaction_hash: '0xabc' }], links: { next: null } }));
    const chain = viemReviewChain({ account, transport: custom({ request: async () => '0x' }), mirrorUrl: 'https://mirror.test', fetch });
    expect(await chain.existing(11n, cid(5))).toEqual({ txHash: '0xabc' });
    expect(await chain.existing(11n, cid(6))).toBeNull();
    expect(await chain.existing(12n, cid(5))).toBeNull();
  });
});
