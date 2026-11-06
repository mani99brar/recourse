import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex } from 'viem';
import { externalIdUint, addressBook } from '@recourse/shared';
import { describe, expect, it } from 'vitest';
import { evidenceAbi } from '../src/abi/outside.js';
import { Indexer } from '../src/indexer.js';
import { DocFetcher } from '../src/ipfs.js';
import { pollArbitrum, pollEvidence, type ArbDeps } from '../src/sources/arbitrum.js';
import { Store } from '../src/store.js';
import { Sim, nextTx } from './helpers/encode.js';
import { FakeArb } from './helpers/arb.js';
import { CASE, SHOP, buildClaim, ingest } from './helpers/fixtures.js';
import { harness, testConfig, testDeployments, testParties } from './helpers/service.js';

const deps = (rpc: FakeArb, over: Partial<ArbDeps> = {}): ArbDeps => ({ rpc, confirmations: 20, chunk: 100, nowS: () => 1_700_000_000, ...over });

/** An indexer that reads only Arbitrum, from `arb`. */
function indexerFor(store: Store, arb: FakeArb) {
  const cfg = testConfig({ recordsTopic: '' });
  const deployments = testDeployments({ claims: undefined, vault: undefined });
  const docs = new DocFetcher({ fetch: async () => new Response(null, { status: 503 }), ipfs: null, ratePerMin: 10, timeoutMs: 100 });
  return new Indexer({ store, cfg, deployments, fetch: async () => { throw new Error('no mirror'); }, arbRpc: arb, reader: null, parties: () => testParties(), docs, nowS: () => 1_700_000_000 });
}

function arbSim() {
  const sim = new Sim();
  const b = buildClaim(sim, 'at_court', 1);
  return { sim, b };
}

describe('arbitrum reader', () => {
  it('indexes only up to head minus the confirmation depth', async () => {
    const { sim } = arbSim();
    const arb = new FakeArb();
    arb.place(sim.logs, CASE);
    const blocks = sim.logs.filter((l) => l.chain === 'arbitrum').map((l) => l.raw.block!);
    const last = blocks[blocks.length - 1]!;
    arb.head = last + 19n; // newest log is inside the confirmation window
    const store = new Store();
    await pollArbitrum(store, deps(arb), CASE, 0n);
    expect(store.events.size).toBe(blocks.length - 1);
    expect(store.cursors.arbitrum.block).toBe(arb.head - 20n + 1n);
    arb.head = last + 20n;
    await pollArbitrum(store, deps(arb), CASE, 0n);
    expect(store.events.size).toBe(blocks.length);
  });

  it('reads in chunks no larger than the configured size', async () => {
    const arb = new FakeArb();
    arb.head = 1000n;
    const store = new Store();
    await pollArbitrum(store, deps(arb, { chunk: 250 }), CASE, 0n);
    expect(arb.queries.length).toBeGreaterThan(3);
    for (const q of arb.queries) expect(q.to - q.from + 1n).toBeLessThanOrEqual(250n);
    expect(arb.queries.at(-1)!.to).toBe(980n);
  });

  it('keeps its cursor and reports the error when the node is down', async () => {
    const arb = new FakeArb();
    const store = new Store();
    await pollArbitrum(store, deps(arb), CASE, 0n);
    const cursor = store.cursors.arbitrum.block;
    arb.fail = true;
    await pollArbitrum(store, deps(arb), CASE, 0n);
    expect(store.status.arbitrum.failing).toBe(true);
    expect(store.status.arbitrum.lastError).toMatch(/rpc down/);
    expect(store.cursors.arbitrum.block).toBe(cursor);
  });
});

describe('court evidence (what gate 4 reads)', () => {
  it('returns the claim, the dispute, the period, the court link and the evidence entry', async () => {
    const { sim, b } = arbSim();
    const store = new Store();
    ingest(store, sim);
    store.live.set(b.claimId, b.live!);
    const arb = new FakeArb();
    arb.head = 6000n;
    const module = addressBook.arbitrum.evidenceModule;
    const ext = externalIdUint(31338, CASE, b.claimId, 1);
    const [sig] = encodeEventTopics({ abi: evidenceAbi, eventName: 'Evidence', args: { _externalDisputeID: ext, _party: SHOP } }) as Hex[];
    const topics = encodeEventTopics({ abi: evidenceAbi, eventName: 'Evidence', args: { _externalDisputeID: ext, _party: SHOP } }) as Hex[];
    arb.rows.push({
      address: module,
      topics,
      data: encodeAbiParameters([{ type: 'string' }], ['{"name":"Sample evidence","fileURI":"/ipfs/bafysample"}']),
      transactionHash: nextTx(),
      logIndex: 0,
      blockNumber: 1500n,
    });
    void sig;
    await pollEvidence(store, deps(arb), module, 31338, CASE, b.claimId, 1, 1000n);
    const h = harness({ store, now: Number(b.now) });
    const d = await h.svc.claimDetail(b.claimId);
    expect(d.court.disputeIds[0]).toBe(901n);
    expect(d.court.period).toBe(2);
    expect(d.court.periodName).toBe('vote');
    expect(d.court.evidence).toHaveLength(1);
    expect(d.court.evidence[0]).toMatchObject({ attempt: 1, party: getAddress(SHOP) });
    expect(d.court.evidence[0]!.uri).toContain('Sample evidence');
    expect(d.court.courtLinks[0]!.url).toContain('901');
    expect(d.court.currentRuling).toBe(1n);
  });

  it('does not repeat evidence it has already read', async () => {
    const { sim, b } = arbSim();
    const store = new Store();
    ingest(store, sim);
    const arb = new FakeArb();
    arb.head = 6000n;
    await pollEvidence(store, deps(arb), addressBook.arbitrum.evidenceModule, 31338, CASE, b.claimId, 1, 1000n);
    const n = arb.queries.length;
    await pollEvidence(store, deps(arb), addressBook.arbitrum.evidenceModule, 31338, CASE, b.claimId, 1, 1000n);
    expect(arb.queries.length).toBe(n); // nothing new above the cursor
  });

  it('reads an older case in chunks and keeps what it read when a later chunk fails', async () => {
    const { sim, b } = arbSim();
    const store = new Store();
    ingest(store, sim);
    const arb = new FakeArb();
    arb.head = 6000n;
    const module = addressBook.arbitrum.evidenceModule;
    const ext = externalIdUint(31338, CASE, b.claimId, 1);
    arb.rows.push({
      address: module,
      topics: encodeEventTopics({ abi: evidenceAbi, eventName: 'Evidence', args: { _externalDisputeID: ext, _party: SHOP } }) as Hex[],
      data: encodeAbiParameters([{ type: 'string' }], ['{"name":"Early evidence"}']),
      transactionHash: nextTx(),
      logIndex: 0,
      blockNumber: 1100n,
    });
    // The node refuses the query after the second chunk.
    const logs = arb.logs.bind(arb);
    arb.logs = async (a) => {
      if (arb.queries.length >= 2) throw new Error('range too large');
      return logs(a);
    };
    await expect(pollEvidence(store, deps(arb, { chunk: 250 }), module, 31338, CASE, b.claimId, 1, 1000n)).rejects.toThrow(/range too large/);
    for (const q of arb.queries) expect(q.to - q.from + 1n).toBeLessThanOrEqual(250n);
    expect(store.evidenceCursor[ext.toString()]).toBe(1500n);
    expect(store.evidence.size).toBe(1);

    arb.logs = logs;
    await pollEvidence(store, deps(arb, { chunk: 250 }), module, 31338, CASE, b.claimId, 1, 1000n);
    expect(arb.queries[2]!.from).toBe(1500n);
    expect(store.evidenceCursor[ext.toString()]).toBe(5981n);
  });

  it('reports an evidence read that fails in /health without failing the Arbitrum source', async () => {
    const { sim } = arbSim();
    const arb = new FakeArb();
    arb.place(sim.logs, CASE);
    const logs = arb.logs.bind(arb);
    arb.logs = async (a) => {
      if (a.address !== CASE) throw new Error('evidence module unreachable');
      return logs(a);
    };
    const store = new Store();
    ingest(store, sim); // the claim as Hedera filed it
    const r = indexerFor(store, arb);
    await r.pollOnce();
    expect(store.status.arbitrum.failing).toBe(false);
    expect(store.status.arbitrum.lastError).toMatch(/^evidence: .*evidence module unreachable/);
    expect(store.status.arbitrum.lastErrorAt).toBe(1_700_000_000);
  });

  it("a fresh store answers before an older case's evidence is read, which goes on over later polls", async () => {
    const { sim } = arbSim();
    const arb = new FakeArb();
    arb.place(sim.logs, CASE);
    arb.head = 60_000n; // the case is about 59 000 blocks old: 59 ranges of evidence at the default chunk
    let evidenceReads = 0;
    const logs = arb.logs.bind(arb);
    arb.logs = async (a) => {
      if (a.address !== CASE) evidenceReads++;
      return logs(a);
    };
    const store = new Store();
    ingest(store, sim);
    store.rebuilding = true;
    const r = indexerFor(store, arb);
    await r.pollOnce();
    expect(store.rebuilding).toBe(false);
    expect(evidenceReads).toBe(10);
    const [key] = Object.keys(store.evidenceCursor);
    const after1 = store.evidenceCursor[key!]!;
    await r.pollOnce();
    expect(evidenceReads).toBe(20);
    expect(store.evidenceCursor[key!]).toBe(after1 + 10_000n);
  });
});
