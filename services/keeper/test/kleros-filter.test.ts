// The Kleros log filters: they name only the disputes of claims still open, and never pass a node
// an indexed-topic OR-list longer than it accepts (nodes refuse more than 1000 with "exceed max
// topics", which would stop the Arbitrum cursor for good).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CIRCLE_VAULT_TOKEN } from '@recourse/shared';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveChains, MAX_FILTER_IDS, batches } from '../src/adapter.js';
import { Alerter } from '../src/alerts.js';
import { phaseOf } from '../src/claims.js';
import type { EvidencePort } from '../src/evidence.js';
import { openJournal } from '../src/journal.js';
import type { LogQuery } from '../src/logs.js';
import { Keeper } from '../src/machine.js';
import { FakeChains } from './fake-chains.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function liveChains(): { chains: LiveChains; queries: () => LogQuery[] } {
  let queries: LogQuery[] = [];
  const reader = {
    position: 0,
    async poll(hooks: { between?: (e: never[]) => void; then?: () => LogQuery[] }) {
      hooks.between?.([]);
      queries = hooks.then?.() ?? [];
      return [];
    },
    commit() {},
  };
  const at = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
  const chains = new LiveChains({
    hedera: { client: {} as never, claims: at(1), vault: at(2), offRamp: at(3), events: {} as never, sender: {} as never },
    arbitrum: {
      client: {} as never,
      chainId: 421614,
      case: at(4),
      klerosCore: at(5),
      evidenceModule: at(6),
      disputeKit: at(7),
      offRamp: at(8),
      reader: reader as never,
      sender: { address: at(9) } as never,
    },
  });
  return { chains, queries: () => queries };
}

describe('Kleros log filters', () => {
  it('splits a long id list so no query names more than MAX_FILTER_IDS (and never over 1000)', async () => {
    const { chains, queries } = liveChains();
    const disputes = Array.from({ length: 1203 }, (_, i) => BigInt(i + 1));
    const externals = Array.from({ length: 1203 }, (_, i) => BigInt(10_000 + i));
    await chains.pollArbitrum({ disputeIds: () => disputes, externalIds: () => externals, onCaseEvents: () => undefined });
    const q = queries();
    const ids = (name: string, arg: string) => q.filter((x) => x.eventName === name).map((x) => (x.args as Record<string, readonly bigint[]>)[arg]!);
    for (const [name, arg, all] of [
      ['Draw', '_disputeID', disputes],
      ['Evidence', '_externalDisputeID', externals],
      ['Contribution', '_coreDisputeID', disputes],
      ['ChoiceFunded', '_coreDisputeID', disputes],
    ] as const) {
      const lists = ids(name, arg);
      expect(lists.length).toBe(Math.ceil(1203 / MAX_FILTER_IDS));
      for (const l of lists) expect(l.length).toBeLessThanOrEqual(Math.min(MAX_FILTER_IDS, 1000));
      expect(lists.flat()).toEqual(all);
    }
    for (const e of q.filter((x) => x.eventName === 'Evidence')) expect((e.args as Record<string, unknown>)._party).toBe(`0x${(9).toString(16).padStart(40, '0')}`);
  });

  it('a short list stays one query, and an empty one asks for nothing', async () => {
    expect(batches([1n, 2n], MAX_FILTER_IDS)).toEqual([[1n, 2n]]);
    expect(batches([], MAX_FILTER_IDS)).toEqual([]);
    const { chains, queries } = liveChains();
    await chains.pollArbitrum({ disputeIds: () => [], externalIds: () => [], onCaseEvents: () => undefined });
    expect(queries()).toEqual([]);
  });

  it('names only the disputes of claims still open, so the lists do not grow with every dispute ever', async () => {
    const fake = new FakeChains();
    const d = mkdtempSync(join(tmpdir(), 'keeper-filter-'));
    dirs.push(d);
    const journal = openJournal(d);
    const alerter = new Alerter({ service: 'keeper', append: (r) => journal.append(r), now: () => fake.t * 1000 });
    const evidence: EvidencePort = {
      async build(req) {
        const text = JSON.stringify({ name: 'evidence', claimId: req.claimId, attempt: req.attempt });
        return { ok: true, text, sha256: keccak256(toHex(text)) };
      },
    };
    const k = new Keeper({ chains: fake, journal, alerter, stateDir: d, evidence, now: () => fake.t, vaultToken: CIRCLE_VAULT_TOKEN });
    k.start();
    const run = async (seconds: number) => {
      for (let s = 0; s < seconds; s += 15) {
        fake.t += 15;
        await k.tick();
      }
    };
    const toWatching = async (n: number): Promise<Hex> => {
      const id = fake.file(n);
      await run(30);
      fake.precheck(id);
      await run(30);
      fake.contest(id);
      await run(30);
      fake.deliver(id);
      await run(60);
      fake.draw(id);
      await run(30);
      return id;
    };
    const settled = await toWatching(1);
    const live = await toWatching(2);
    fake.rule(settled, 1);
    await run(30);
    fake.arrive(settled);
    await run(60);
    expect(phaseOf(k.book.claims.get(settled)!)).toBe('Settled');
    expect(phaseOf(k.book.claims.get(live)!)).toBe('Watching');
    const liveAttempts = k.book.claims.get(live)!.attempts;
    expect(k.book.disputeIds()).toEqual(liveAttempts.map((a) => BigInt(a.disputeId)));
    expect(k.book.externalIds()).toEqual(liveAttempts.map((a) => BigInt(a.externalId)));
    journal.close();
  });
});

describe('court round', () => {
  function chainsReading(extraData: Hex, times: Record<string, readonly bigint[]>) {
    const asked: bigint[] = [];
    const at = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
    const client = {
      async readContract(q: { functionName: string; args?: readonly unknown[] }) {
        if (q.functionName === 'EXTRA_DATA') return extraData;
        if (q.functionName === 'getTimesPerPeriod') {
          const id = q.args![0] as bigint;
          asked.push(id);
          return times[id.toString()]!;
        }
        throw new Error(`unexpected ${q.functionName}`);
      },
    };
    const chains = new LiveChains({
      hedera: { client: {} as never, claims: at(1), vault: at(2), offRamp: at(3), events: {} as never, sender: {} as never },
      arbitrum: { client: client as never, chainId: 421614, case: at(4), klerosCore: at(5), evidenceModule: at(6), offRamp: at(8), reader: {} as never, sender: { address: at(9) } as never },
    });
    return { chains, asked };
  }

  it("sums the four periods of the court named in the case contract's EXTRA_DATA, read once", async () => {
    // The live extraData: court 8, then the number of jurors.
    const extra = `0x${(8).toString(16).padStart(64, '0')}${(3).toString(16).padStart(64, '0')}` as Hex;
    const { chains, asked } = chainsReading(extra, { '8': [900n, 2700n, 1800n, 2700n] });
    expect(await chains.courtRoundS()).toBe(8100);
    expect(await chains.courtRoundS()).toBe(8100);
    expect(asked).toEqual([8n]);
  });

  it('takes the general court when EXTRA_DATA is shorter than one word', async () => {
    const { chains, asked } = chainsReading('0x', { '1': [60n, 60n, 60n, 60n] });
    expect(await chains.courtRoundS()).toBe(240);
    expect(asked).toEqual([1n]);
  });
});

describe('dispute views', () => {
  const at = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
  function chainsWith(extra: { disputeKit?: Address; sortitionModule?: Address; disputeViews?: boolean }, fail = false) {
    const asked: string[] = [];
    const client = {
      async readContract(q: { functionName: string }) {
        asked.push(q.functionName);
        if (fail) throw new Error('HTTP request failed.\n\nURL: https://rpc.example');
        if (q.functionName === 'disputes') return [8n, at(4), 4, false, 1_800_000_000n];
        if (q.functionName === 'getTimesPerPeriod') return [900n, 2700n, 1800n, 2700n];
        throw new Error(`unexpected ${q.functionName}`);
      },
    };
    const chains = new LiveChains({
      hedera: { client: {} as never, claims: at(1), vault: at(2), offRamp: at(3), events: {} as never, sender: {} as never },
      arbitrum: { client: client as never, chainId: 421614, case: at(4), klerosCore: at(5), evidenceModule: at(6), offRamp: at(8), reader: {} as never, sender: { address: at(9) } as never, ...extra },
    });
    return { chains, asked };
  }

  it('KlerosCore (a deployment with a dispute kit and a sortition module) has them and is read', async () => {
    const { chains, asked } = chainsWith({ disputeKit: at(7), sortitionModule: at(10) });
    expect(chains.disputeViews).toBe(true);
    expect(await chains.dispute(212n)).toMatchObject({ courtId: 8n, period: 4, ruled: false, timesPerPeriod: [900, 2700, 1800, 2700] });
    expect(asked).toEqual(['disputes', 'getTimesPerPeriod']);
  });

  it('a failed read rejects; it is never an empty answer', async () => {
    const { chains } = chainsWith({ disputeKit: at(7), sortitionModule: at(10) }, true);
    await expect(chains.dispute(212n)).rejects.toThrow('HTTP request failed.');
  });

  it('the local mock arbitrator (neither address) has none, and is not asked', async () => {
    const { chains, asked } = chainsWith({});
    expect(chains.disputeViews).toBe(false);
    await expect(chains.dispute(1n)).rejects.toThrow('no dispute views');
    expect(asked).toEqual([]);
    expect(chainsWith({ disputeViews: true }).chains.disputeViews).toBe(true);
  });
});
