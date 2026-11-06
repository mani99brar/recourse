// What reaches the journal and how it is kept small: anyone's Evidence posts and other events the
// keeper does not use are never journaled or kept, and a journal past its size limit is rewritten
// as the state it describes, so start-up replay stays bounded and gives the same state.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CIRCLE_VAULT_TOKEN, externalIdUint } from '@recourse/shared';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveChains } from '../src/adapter.js';
import { Alerter } from '../src/alerts.js';
import { phaseOf } from '../src/claims.js';
import type { EvidencePort } from '../src/evidence.js';
import { JOURNAL_FILE, openJournal, replayJournal, type JournalRecord } from '../src/journal.js';
import type { LogQuery } from '../src/logs.js';
import { Keeper, type KeeperOptions } from '../src/machine.js';
import { FakeChains } from './fake-chains.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const evidence: EvidencePort = {
  async build(req) {
    const text = JSON.stringify({ name: 'evidence', claimId: req.claimId, attempt: req.attempt });
    return { ok: true, text, sha256: keccak256(toHex(text)) };
  },
};

function rig(fake: FakeChains, dir?: string, keeper: Partial<KeeperOptions> = {}) {
  const d = dir ?? mkdtempSync(join(tmpdir(), 'keeper-compact-'));
  if (!dir) dirs.push(d);
  const journal = openJournal(d);
  const alerter = new Alerter({ service: 'keeper', append: (r) => journal.append(r), now: () => fake.t * 1000 });
  const k = new Keeper({ chains: fake, journal, alerter, stateDir: d, evidence, now: () => fake.t, vaultToken: CIRCLE_VAULT_TOKEN, ...keeper });
  k.start();
  return { dir: d, journal, alerter, k };
}

async function run(fake: FakeChains, k: Keeper, seconds: number, step = 15): Promise<void> {
  for (let s = 0; s < seconds; s += step) {
    fake.t += Math.min(step, seconds - s);
    await k.tick();
  }
}

async function toWatching(fake: FakeChains, k: Keeper, n: number): Promise<Hex> {
  const id = fake.file(n);
  await run(fake, k, 30);
  fake.precheck(id);
  await run(fake, k, 30);
  fake.contest(id);
  await run(fake, k, 30);
  fake.deliver(id);
  await run(fake, k, 60);
  fake.draw(id);
  await run(fake, k, 30);
  return id;
}

const journalText = (dir: string) => readFileSync(join(dir, JOURNAL_FILE), 'utf8');

describe('events the keeper does not use', () => {
  it('Evidence from any other party is neither journaled nor kept, however large', async () => {
    const fake = new FakeChains();
    const r = rig(fake);
    const id = await toWatching(fake, r.k, 1);
    const ext = externalIdUint(fake.arbChainId, fake.caseAddress, id, 1);
    const before = statSync(join(r.dir, JOURNAL_FILE)).size;
    const globals = r.k.book.globalEvents.length;
    const big = 'x'.repeat(90_000);
    for (let i = 0; i < 50; i++) fake.emitA('evidence', 'Evidence', { _externalDisputeID: ext, _party: '0x000000000000000000000000000000000000dEaD', _evidence: big });
    fake.emitA('case', 'FeePoolFunded', { from: fake.opsArb, amount: 1n });
    await run(fake, r.k, 15);
    expect(statSync(join(r.dir, JOURNAL_FILE)).size - before).toBeLessThan(5_000);
    expect(r.k.book.globalEvents.length).toBe(globals);
    expect(journalText(r.dir)).not.toContain('xxxxxxxxxx');
    // After a restart nothing of it comes back either.
    r.journal.close();
    const r2 = rig(fake, r.dir);
    expect(r2.k.book.globalEvents.length).toBeLessThanOrEqual(globals);
    expect(phaseOf(r2.k.book.claims.get(id)!)).toBe('Watching');
  });

  it("our own Evidence event is journaled without its text (the evidence record already holds it)", async () => {
    const fake = new FakeChains();
    const r = rig(fake);
    const id = await toWatching(fake, r.k, 1);
    const events = replayJournal(r.dir).records.filter((x) => x.t === 'event' && x.name === 'Evidence');
    expect(events).toHaveLength(1);
    const args = events[0]!.args as Record<string, unknown>;
    expect(args._evidence).toBeUndefined();
    expect(args._evidenceLength).toBeGreaterThan(0);
    expect(String(args._party).toLowerCase()).toBe(fake.opsArb.toLowerCase());
    expect(r.k.book.claims.get(id)!.attempts[0]!.evidenceAt).toBeDefined();
  });

  it('the Arbitrum Evidence query names our ops key, so other parties are not even fetched', async () => {
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
    const opsArb = '0x00000000000000000000000000000000000a4b01' as Address;
    const chains = new LiveChains({
      hedera: { client: {} as never, claims: opsArb, vault: opsArb, offRamp: opsArb, events: {} as never, sender: {} as never },
      arbitrum: {
        client: {} as never,
        chainId: 421614,
        case: opsArb,
        klerosCore: opsArb,
        evidenceModule: opsArb,
        offRamp: opsArb,
        reader: reader as never,
        sender: { address: opsArb } as never,
      },
    });
    await chains.pollArbitrum({ disputeIds: () => [212n], externalIds: () => [7n], onCaseEvents: () => undefined });
    const ev = queries.find((q) => q.eventName === 'Evidence')!;
    expect(ev.args).toEqual({ _externalDisputeID: [7n], _party: opsArb });
  });
});

describe('journal compaction', () => {
  it('rewrites a journal past its limit and a restart from it gives the same state', async () => {
    const fake = new FakeChains();
    const r = rig(fake, undefined, { compactAtBytes: 1 << 30 });
    const settled = await toWatching(fake, r.k, 1);
    fake.rule(settled, 1);
    await run(fake, r.k, 30);
    fake.arrive(settled);
    await run(fake, r.k, 60);
    const live = await toWatching(fake, r.k, 2);
    const waiting = fake.file(3);
    await run(fake, r.k, 30);
    fake.precheck(waiting);
    await run(fake, r.k, 30);
    await run(fake, r.k, 1200, 60); // closes uncontested meanwhile
    // An intent the senders still hold open must come through verbatim.
    const intent: JournalRecord = { t: 'intent', id: 'arbitrum-test-1', chain: 'arbitrum', from: fake.opsArb, to: fake.caseAddress, data: '0x', value: '0', call: 'relayRuling', nonce: 4, hash: `0x${'aa'.repeat(32)}`, raw: '0x02', claimId: live, at: 1 };
    fake.intentRecords = [intent];

    const snapshot = (k: Keeper, al: Alerter) => ({
      claims: JSON.parse(JSON.stringify([...k.book.claims.values()])) as unknown,
      phases: [...k.book.claims.values()].map((c) => phaseOf(c)),
      evidence: k.book.evidenceText(live, 1),
      outbox: al.pending().map((a) => a.id),
      last: [settled, live, waiting].map((id) => al.latestFor(id)),
    });
    const sizeBefore = statSync(join(r.dir, JOURNAL_FILE)).size;
    expect(r.k.compact()).toBe(true);
    const sizeAfter = statSync(join(r.dir, JOURNAL_FILE)).size;
    expect(sizeAfter).toBeLessThan(sizeBefore);
    expect(existsSync(join(r.dir, `${JOURNAL_FILE}.prev`))).toBe(true);
    expect(statSync(join(r.dir, `${JOURNAL_FILE}.prev`)).size).toBe(sizeBefore);
    // The settled claim keeps its facts but not its payload bytes; the open one keeps them.
    expect(r.k.book.claims.get(settled)!.received!.payload).toBe('0x');
    expect(r.k.book.claims.get(live)!.received!.payload).toBe(fake.payloadOf(live));
    // Appends after the rewrite land in the new file.
    await run(fake, r.k, 30);
    expect(statSync(join(r.dir, JOURNAL_FILE)).size).toBeGreaterThanOrEqual(sizeAfter);
    const atClose = snapshot(r.k, r.alerter);
    expect(atClose.phases).toEqual(['Settled', 'Watching', 'Closed']);
    r.journal.close();

    const loaded: JournalRecord[][] = [];
    const fake2 = Object.assign(fake, { load: (recs: readonly JournalRecord[]) => loaded.push([...recs]) });
    const r2 = rig(fake2, r.dir);
    expect(snapshot(r2.k, r2.alerter)).toEqual(atClose);
    expect(loaded.at(-1)).toEqual([intent]);
    // It goes on from there without repeating a call.
    const calls = fake.calls.length;
    await run(fake, r2.k, 60);
    expect(fake.calls.slice(calls).map((c) => c.fn).filter((f) => f !== 'passPeriod' && f !== 'passPhase')).toEqual([]);
  });

  it('compacts from the tick once the journal reaches compactAtBytes, never on a tick whose event read failed', async () => {
    const fake = new FakeChains();
    const r = rig(fake, undefined, { compactAtBytes: 20_000 });
    await toWatching(fake, r.k, 1);
    await run(fake, r.k, 30);
    expect(existsSync(join(r.dir, `${JOURNAL_FILE}.prev`))).toBe(true);
    expect(statSync(join(r.dir, JOURNAL_FILE)).size).toBeLessThan(20_000);

    const fake2 = new FakeChains();
    const r2 = rig(fake2, undefined, { compactAtBytes: 1 });
    const poll = fake2.pollHedera.bind(fake2);
    fake2.pollHedera = async () => {
      throw new Error('mirror down');
    };
    await r2.k.tick();
    expect(existsSync(join(r2.dir, `${JOURNAL_FILE}.prev`))).toBe(false);
    fake2.pollHedera = poll;
    await r2.k.tick();
    expect(existsSync(join(r2.dir, `${JOURNAL_FILE}.prev`))).toBe(true);
  });

  it('when the compacted journal alone fills the limit, compacts again only once it has doubled', async () => {
    const fake = new FakeChains();
    const lines: string[] = [];
    const limit = 1500;
    const r = rig(fake, undefined, { compactAtBytes: limit, log: (l) => lines.push(l) });
    const compactions = () => lines.filter((l) => l.startsWith('journal compacted')).length;
    const size = () => statSync(join(r.dir, JOURNAL_FILE)).size;
    await toWatching(fake, r.k, 1);
    const first = compactions();
    expect(first).toBeGreaterThan(0);
    const left = Number(/-> (\d+) bytes/.exec(lines.filter((l) => l.startsWith('journal compacted')).at(-1)!)![1]);
    expect(left).toBeGreaterThan(limit); // the state alone is over the limit
    await run(fake, r.k, 150, 15); // ten quiet ticks
    expect(size()).toBeLessThan(2 * left);
    expect(compactions()).toBe(first);
    await toWatching(fake, r.k, 2); // a second claim doubles it
    expect(compactions()).toBeGreaterThan(first);
    expect(size()).toBeLessThan(2 * Number(/-> (\d+) bytes/.exec(lines.filter((l) => l.startsWith('journal compacted')).at(-1)!)![1]));
  });

  it('never compacts when the chain port cannot hand over its open intents', async () => {
    const fake = new FakeChains();
    const noIntents = Object.assign(fake, { openIntentRecords: undefined });
    const r = rig(noIntents as unknown as FakeChains, undefined, { compactAtBytes: 1 });
    await toWatching(fake, r.k, 1);
    expect(r.k.compact()).toBe(false);
    expect(existsSync(join(r.dir, `${JOURNAL_FILE}.prev`))).toBe(false);
  });
});
