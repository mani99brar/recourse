// LOCAL ONLY. The keeper on two anvil nodes, one standing in for Hedera and one for Arbitrum
// (ports 8581-8584, one pair per bridge mode), with both DeployLocal stacks, the mock arbitrator, the mock OffRamps and
// the local CCIP relay process carrying messages between the nodes. The test plays the other
// parties (shop, pre-check signer, platform, court) from anvil's unlocked accounts and moves the
// nodes' clocks for the expiry cases; the keeper signs with its own two keys (anvil accounts 1
// and 6 from anvil's public dev mnemonic). Deployment files are deployments/*.lane05-<tag>.local.json,
// removed afterwards.
//
// Run under the suite lock:  pnpm --filter ./services/keeper test:anvil

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEvidence, rawCidOfHash } from '@recourse/court';
import { CaseState, ClaimStatus, sha256, utf8ToBytes } from '@recourse/shared';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { caseAbi, claimsAbi } from '../../src/abi.js';
import { DEFAULT_GAS_FLOORS, LiveChains } from '../../src/adapter.js';
import { Alerter } from '../../src/alerts.js';
import { readArbitrumDeployment, readHederaDeployment, type ArbitrumDeployment, type HederaDeployment } from '../../src/deployments.js';
import { evidenceAssembler, type BuildEvidence } from '../../src/evidence.js';
import { openJournal, replayJournal, type Journal, type JournalRecord } from '../../src/journal.js';
import { BlockLogReader } from '../../src/logs.js';
import { Keeper } from '../../src/machine.js';
import { makeClient, viemTxRpc } from '../../src/rpc.js';
import { Sender, type TxSigner } from '../../src/sender.js';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const DEPLOYMENTS = join(ROOT, 'deployments');
const CASE_ON_FRESH_NODE = '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9';
// anvil's built-in development mnemonic (public; these accounts exist only on local nodes)
const DEV_MNEMONIC = 'test test test test test test test test test test test junk';
const dev = (i: number) => mnemonicToAccount(DEV_MNEMONIC, { addressIndex: i });
const ACCOUNT0 = dev(0).address;
const OPS_HEDERA = dev(1); // the claims rulingRelayer in the local stack
const OPS_ARB = dev(6); // set as the case contract's trusted relay; the CCIP relay process uses account 7
/** DeployLocal gives the case Hedera's locked claim timeout less this (CaseTimeouts.RELAY_BUDGET), as on testnet. */
const RELAY_BUDGET_S = 7200;

const claimsJson = JSON.parse(readFileSync(join(DEPLOYMENTS, 'abi', 'RecourseClaims.json'), 'utf8')) as Abi;
const erc20 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
const mockArbitrator = parseAbi(['function giveRuling(uint256 disputeID, uint256 ruling)']);

function startAnvil(port: number): ChildProcess {
  return spawn('anvil', ['--port', String(port), '--silent'], { stdio: 'ignore' });
}

async function waitRpc(url: string): Promise<void> {
  const c = createPublicClient({ transport: http(url) });
  for (let i = 0; i < 100; i++) {
    try {
      await c.getChainId();
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`no anvil at ${url}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function forgeScript(script: string, url: string, env: Record<string, string>): void {
  execFileSync('forge', ['script', script, '--rpc-url', url, '--broadcast', '--unlocked', '--sender', ACCOUNT0, '-j', '1'], {
    cwd: join(ROOT, 'contracts'),
    env: { ...process.env, ...env },
    stdio: 'pipe',
    maxBuffer: 64 * 1024 * 1024,
  });
}

interface Rig {
  keeper: Keeper;
  journal: Journal;
  alerter: Alerter;
  chains: LiveChains;
  tick: () => Promise<void>;
}

/** One pair of fresh anvil nodes with both DeployLocal stacks in the given bridge mode. */
function useStack(o: { mode: 'Both' | 'None'; hederaPort: number; arbPort: number; tag: string; relay: boolean }) {
  const H_URL = `http://127.0.0.1:${o.hederaPort}`;
  const A_URL = `http://127.0.0.1:${o.arbPort}`;
  const HEDERA_FILE = `hedera.lane05-${o.tag}.local.json`;
  const ARB_FILE = `arbitrum.lane05-${o.tag}.local.json`;
  const procs: ChildProcess[] = [];
  const stateDir = mkdtempSync(join(tmpdir(), `keeper-anvil-${o.tag}-`));
  const docs = new Map<string, Uint8Array>();
  const wallet = (url: string) => createWalletClient({ transport: http(url) });
  const s = {
    H_URL,
    A_URL,
    stateDir,
    hed: undefined as unknown as HederaDeployment,
    arb: undefined as unknown as ArbitrumDeployment,
    hClient: undefined as unknown as PublicClient,
    aClient: undefined as unknown as PublicClient,
    roles: undefined as unknown as { platform: Address; shop: Address; preCheckSigner: Address },
    usdc: undefined as unknown as Address,
  };

  beforeAll(async () => {
    procs.push(startAnvil(o.hederaPort), startAnvil(o.arbPort));
    await waitRpc(H_URL);
    await waitRpc(A_URL);
    forgeScript('script/hedera/DeployLocal.s.sol', H_URL, { HEDERA_LOCAL_FILE: HEDERA_FILE, LOCAL_CASE_PEER: CASE_ON_FRESH_NODE, LOCAL_BRIDGE_MODE: o.mode });
    const hRaw = JSON.parse(readFileSync(join(DEPLOYMENTS, HEDERA_FILE), 'utf8')) as {
      contracts: { claims: { address: Address } };
      roles: { platform: Address; shop: Address; preCheckSigner: Address; rulingRelayer: Address };
      local: { usdc: Address };
    };
    expect(hRaw.roles.rulingRelayer).toBe(OPS_HEDERA.address);
    forgeScript('script/arbitrum/DeployLocal.s.sol', A_URL, {
      ARBITRUM_LOCAL_FILE: ARB_FILE,
      LOCAL_CLAIMS_PEER: hRaw.contracts.claims.address,
      LOCAL_HEDERA_RPC_URL: H_URL,
      LOCAL_ARB_RPC_URL: A_URL,
      LOCAL_TRUSTED_RELAY: OPS_ARB.address,
    });
    s.arb = readArbitrumDeployment(DEPLOYMENTS, ARB_FILE);
    s.hed = readHederaDeployment(DEPLOYMENTS, HEDERA_FILE, s.arb);
    expect(s.arb.case).toBe(CASE_ON_FRESH_NODE);
    s.roles = hRaw.roles;
    s.usdc = hRaw.local.usdc;
    s.hClient = makeClient({ chainId: s.hed.chainId, urls: [H_URL] });
    s.aClient = makeClient({ chainId: s.arb.chainId, urls: [A_URL] });
    if (o.relay) {
      const relay = spawn(join(ROOT, 'node_modules', '.bin', 'tsx'), ['scripts/local-relay.ts'], {
        cwd: join(ROOT, 'packages', 'court'),
        env: { ...process.env, DEPLOYMENTS_DIR: DEPLOYMENTS, ARBITRUM_LOCAL_FILE: ARB_FILE, HEDERA_LOCAL_FILE: HEDERA_FILE, LOCAL_ARB_RPC_URL: A_URL, LOCAL_HEDERA_RPC_URL: H_URL },
        stdio: 'ignore',
      });
      procs.push(relay);
    }
  });

  afterAll(() => {
    for (const p of procs) p.kill('SIGTERM');
    rmSync(stateDir, { recursive: true, force: true });
    for (const f of [HEDERA_FILE, ARB_FILE]) rmSync(join(DEPLOYMENTS, f), { force: true });
  });

  /** Sends from an unlocked anvil account and waits for a successful receipt. */
  async function act(url: string, args: Parameters<ReturnType<typeof wallet>['writeContract']>[0]): Promise<void> {
    const hash = await wallet(url).writeContract(args);
    const client = url === H_URL ? s.hClient : s.aClient;
    const rc = await client.waitForTransactionReceipt({ hash, pollingInterval: 100 });
    if (rc.status !== 'success') throw new Error(`${String(args.functionName)} reverted`);
  }

  function makeKeeper(): Rig {
    const { hed, arb, hClient, aClient } = s;
    const journal = openJournal(stateDir);
    const append = (r: Parameters<Journal['append']>[0]) => journal.append(r);
    const hSender = new Sender({
      chain: 'hedera',
      rpc: viemTxRpc({ chainId: hed.chainId, client: hClient, feeMode: 'legacy' }),
      signer: OPS_HEDERA as unknown as TxSigner,
      from: OPS_HEDERA.address,
      append,
      nonceTag: 'latest',
      receiptWaitMs: 10_000,
      receiptPollMs: 100,
    });
    const aSender = new Sender({
      chain: 'arbitrum',
      rpc: viemTxRpc({ chainId: arb.chainId, client: aClient, feeMode: 'eip1559' }),
      signer: OPS_ARB as unknown as TxSigner,
      from: OPS_ARB.address,
      append,
      receiptWaitMs: 10_000,
      receiptPollMs: 100,
    });
    const reader = (chain: 'hedera' | 'arbitrum', source: string, client: PublicClient, startBlock: number, address: Address, abi: Abi, name: string) =>
      new BlockLogReader({ chain, client, dir: stateDir, source, startBlock, confirmations: 0, chunk: 1000, maxChunks: 10, first: [{ source: name, address, abi }] });
    const chains = new LiveChains({
      hedera: {
        client: hClient,
        claims: hed.claims,
        vault: hed.vault,
        offRamp: hed.offRamp,
        events: reader('hedera', 'hedera-claims', hClient, hed.startBlock, hed.claims, claimsAbi as Abi, 'claims'),
        sender: hSender,
        // anvil counts native value in wei, not Hedera's tinybars.
        weibarPerNativeUnit: 1n,
      },
      arbitrum: {
        client: aClient,
        chainId: arb.chainId,
        case: arb.case,
        klerosCore: arb.klerosCore,
        evidenceModule: arb.evidenceModule,
        offRamp: arb.offRamp,
        reader: reader('arbitrum', 'arbitrum', aClient, arb.startBlock, arb.case, caseAbi as Abi, 'case'),
        sender: aSender,
      },
      gasFloors: DEFAULT_GAS_FLOORS,
    });
    const alerter = new Alerter({ service: 'keeper', append });
    let chainNow = 0;
    const keeper = new Keeper({
      chains,
      journal,
      alerter,
      stateDir,
      evidence: evidenceAssembler({ fetchDoc: async (cid) => docs.get(cid) ?? null, rawCidOfHash, build: buildEvidence as unknown as BuildEvidence }),
      timing: { refileHoldS: 0 },
      now: () => chainNow,
      vaultToken: hed.token,
    });
    keeper.start();
    const tick = async () => {
      const [h, a] = await Promise.all([hClient.getBlock(), aClient.getBlock()]);
      chainNow = Math.max(Number(h.timestamp), Number(a.timestamp));
      await keeper.tick();
    };
    return { keeper, journal, alerter, chains, tick };
  }

  async function until(rig: Rig, what: string, ok: () => Promise<boolean>, tries = 60): Promise<void> {
    for (let i = 0; i < tries; i++) {
      await rig.tick();
      if (await ok()) return;
      await sleep(500);
    }
    const claims = [...rig.keeper.book.claims.values()].map((c) => ({ id: c.claimId, lastError: c.lastError, tries: c.tries, autoHold: c.autoHold, outbound: c.outbound }));
    throw new Error(
      `timed out waiting for ${what}; health ${JSON.stringify(rig.keeper.health)}; claims ${JSON.stringify(claims)}; alerts ${JSON.stringify(rig.alerter.pending().map((a) => [a.kind, a.hint]))}`,
    );
  }

  const claimStatus = async (id: Hex) =>
    (await s.hClient.readContract({ address: s.hed.claims, abi: claimsAbi, functionName: 'getClaim', args: [id] })).status;
  const caseOf = (id: Hex) => s.aClient.readContract({ address: s.arb.case, abi: caseAbi, functionName: 'caseOf', args: [id] });

  /** The pre-check result document and one held record, kept where the keeper's doc fetch finds them. */
  function precheckDoc(claimId: Hex): Hex {
    const record = utf8ToBytes(JSON.stringify({ kind: 'asked', note: 'local test record' }));
    const recordHash = sha256(record);
    docs.set(rawCidOfHash(recordHash), record);
    const slots = [0, 1, 2, 3, 4, 5].map((k) =>
      k === 0 ? { kind: '0', outcome: 'held', hcsHash: recordHash, cid: rawCidOfHash(recordHash), seq: '100' } : { kind: String(k), outcome: 'absent' },
    );
    const bytes = utf8ToBytes(JSON.stringify({ claimId, gap: '1', answer: '1', reasonKey: 'gap1_asked_vs_shown', records: slots, result: {} }));
    const packHash = sha256(bytes);
    docs.set(rawCidOfHash(packHash), bytes);
    return packHash;
  }

  const latestTime = async (client: PublicClient) => Number((await client.getBlock()).timestamp);

  /** Mines one block on the node at exactly `timestamp` (later blocks go on from there). */
  async function mineAt(url: string, timestamp: number): Promise<void> {
    const t = createTestClient({ mode: 'anvil', transport: http(url) });
    await t.setNextBlockTimestamp({ timestamp: BigInt(timestamp) });
    await t.mine({ blocks: 1 });
  }

  /** Brings the node that is behind up to the other's time (the keeper reads one clock for both). */
  async function syncClocks(): Promise<void> {
    const [h, a] = [await latestTime(s.hClient), await latestTime(s.aClient)];
    if (h > a) await mineAt(A_URL, h);
    else if (a > h) await mineAt(H_URL, a);
  }

  /** The shop files, the pre-check signer records, the platform contests. Returns the claim id. */
  async function fileAndContest(rig: Rig, n: number, opts: { precheckDelayS?: number } = {}): Promise<Hex> {
    const { hed, hClient, roles } = s;
    const params = (await hClient.readContract({ address: hed.claims, abi: claimsAbi, functionName: 'params' })) as { courtFeeUsdc: bigint };
    const nonce = keccak256(toHex(`keeper anvil claim ${o.tag} ${n}`));
    const refs = { topicNum: 4242n, seq: [100n, 101n, 102n, 103n, 104n, 105n], hashes: [0, 1, 2, 3, 4, 5].map((i) => keccak256(toHex(`rec ${i}`))) };
    await act(H_URL, { chain: null, account: roles.shop, address: s.usdc, abi: erc20, functionName: 'approve', args: [hed.vault, params.courtFeeUsdc * 2n] });
    await act(H_URL, { chain: null, account: roles.shop, address: hed.claims, abi: claimsJson, functionName: 'fileClaim', args: [nonce, roles.platform, refs, 120_000_000n, 100_000_000n] });
    const id = (await hClient.readContract({ address: hed.claims, abi: claimsJson, functionName: 'claimIdFor', args: [roles.platform, roles.shop, nonce] })) as Hex;
    expect(await claimStatus(id)).toBe(ClaimStatus.Filed);
    await until(rig, 'ClaimFiled', async () => rig.keeper.book.claims.has(id));
    if (opts.precheckDelayS) {
      await mineAt(H_URL, (await latestTime(s.hClient)) + opts.precheckDelayS);
      await syncClocks();
    }
    await act(H_URL, { chain: null, account: roles.preCheckSigner, address: hed.claims, abi: claimsJson, functionName: 'recordPreCheck', args: [id, 1, 1, precheckDoc(id)] });
    await act(H_URL, { chain: null, account: roles.platform, address: hed.claims, abi: claimsJson, functionName: 'contest', args: [id] });
    expect(await claimStatus(id)).toBe(ClaimStatus.Contested);
    return id;
  }

  const giveRuling = (disputeId: bigint, ruling: bigint) =>
    act(A_URL, { chain: null, account: ACCOUNT0, address: s.arb.klerosCore, abi: mockArbitrator, functionName: 'giveRuling', args: [disputeId, ruling] });

  function journalCalls(): { calls: string[]; intents: JournalRecord[]; results: JournalRecord[]; events: JournalRecord[] } {
    const records = replayJournal(stateDir).records;
    const intents = records.filter((r) => r.t === 'intent');
    return { calls: intents.map((r) => String(r.call)), intents, results: records.filter((r) => r.t === 'result'), events: records.filter((r) => r.t === 'event') };
  }

  const openCases = () => s.aClient.readContract({ address: s.arb.case, abi: caseAbi, functionName: 'openCases' });
  const getClaim = (id: Hex) => s.hClient.readContract({ address: s.hed.claims, abi: claimsAbi, functionName: 'getClaim', args: [id] });

  /** The journaled calls for one claim and their results. */
  function callsFor(id: Hex): { calls: string[]; outcomes: string[] } {
    const { intents, results } = journalCalls();
    const mine = intents.filter((r) => String(r.claimId ?? '').toLowerCase() === id.toLowerCase());
    const ids = new Set(mine.map((r) => String(r.id)));
    return { calls: mine.map((r) => String(r.call)), outcomes: results.filter((r) => ids.has(String(r.id))).map((r) => String(r.outcome)) };
  }

  /** Files, contests and brings a claim to Watching on the None stack (relayClaim, openCase, evidence). */
  async function toWatchingNone(rig: Rig, n: number, opts: { precheckDelayS?: number } = {}): Promise<Hex> {
    const id = await fileAndContest(rig, n, opts);
    await until(rig, 'sendToCourt', async () => (await claimStatus(id)) === ClaimStatus.AtCourt);
    await until(rig, 'relayClaim', async () => (await caseOf(id)).state !== CaseState.None);
    await until(rig, 'openCase', async () => (await caseOf(id)).state === CaseState.Opened);
    await until(rig, 'evidence 1', async () => rig.keeper.book.claims.get(id)?.attempts[0]?.evidenceAt !== undefined);
    return id;
  }

  return { s, makeKeeper, until, claimStatus, caseOf, fileAndContest, giveRuling, journalCalls, mineAt, syncClocks, openCases, getClaim, callsFor, toWatchingNone };
}

const keeperKeys = new Set([OPS_HEDERA.address.toLowerCase(), OPS_ARB.address.toLowerCase()]);

describe('keeper on two anvil nodes, both legs over the local CCIP relay', () => {
  const st = useStack({ mode: 'Both', hederaPort: 8581, arbPort: 8582, tag: 'both', relay: true });

  it('files, contests, opens, posts evidence, refiles once on ruling 0, relays the ruling and settles; survives a restart', async () => {
    let rig = st.makeKeeper();
    const id = await st.fileAndContest(rig, 1);
    await st.until(rig, 'sendToCourt', async () => (await st.claimStatus(id)) === ClaimStatus.AtCourt);

    // The relay delivers it; the keeper opens the case and posts evidence for attempt 1.
    await st.until(rig, 'openCase', async () => (await st.caseOf(id)).state === CaseState.Opened);
    await st.until(rig, 'evidence 1', async () => rig.keeper.book.claims.get(id)?.attempts[0]?.evidenceAt !== undefined);
    expect(rig.keeper.book.claims.get(id)!.deliveredAt).toBeDefined();

    // Restart: a fresh keeper on the same journal picks up where the first left off.
    rig.journal.close();
    rig = st.makeKeeper();
    expect(rig.keeper.book.claims.get(id)!.attempts).toHaveLength(1);

    // The court refuses on attempt 1: the keeper refiles with the same payload.
    await st.giveRuling((await st.caseOf(id)).disputeIds[0], 0n);
    await st.until(rig, 'refile', async () => (await st.caseOf(id)).attempts === 2);
    await st.until(rig, 'evidence 2', async () => rig.keeper.book.claims.get(id)?.attempts[1]?.evidenceAt !== undefined);

    // A final ruling: relayed to Hedera over the relay, then settled.
    await st.giveRuling((await st.caseOf(id)).disputeIds[1], 1n);
    await st.until(rig, 'relayRuling', async () => (await st.caseOf(id)).state === CaseState.Relayed);
    await st.until(rig, 'settle', async () => (await st.claimStatus(id)) === ClaimStatus.Settled, 90);
    await rig.tick();
    expect(rig.keeper.book.claims.get(id)!.terminal).toBe('Settled');

    // One transaction per step, all from the keeper's two keys, all mined successfully.
    rig.journal.close();
    const { calls, intents, results, events } = st.journalCalls();
    // The evidence posts were also read back from the chain through the external-id log filter.
    expect(events.filter((e) => e.source === 'evidence' && e.name === 'Evidence')).toHaveLength(2);
    for (const fn of ['sendToCourt', 'openCase', 'refile', 'relayRuling', 'settle']) expect(calls.filter((c) => c === fn), fn).toHaveLength(1);
    expect(calls.filter((c) => c === 'submitEvidence')).toHaveLength(2);
    expect(results.every((r) => r.outcome === 'success')).toBe(true);
    expect(new Set(intents.map((r) => String(r.from).toLowerCase()))).toEqual(keeperKeys);
  });
});

describe('keeper on two anvil nodes, no CCIP (bridge mode None)', () => {
  const st = useStack({ mode: 'None', hederaPort: 8583, arbPort: 8584, tag: 'none', relay: false });

  it('relays the claim as the trusted relay, opens on the zero-id receive and records the ruling on Hedera', async () => {
    const rig = st.makeKeeper();
    const id = await st.fileAndContest(rig, 1);
    await st.until(rig, 'sendToCourt', async () => (await st.claimStatus(id)) === ClaimStatus.AtCourt);
    await st.until(rig, 'relayClaim', async () => (await st.caseOf(id)).state !== CaseState.None);
    await st.until(rig, 'openCase', async () => (await st.caseOf(id)).state === CaseState.Opened);
    await st.until(rig, 'evidence 1', async () => rig.keeper.book.claims.get(id)?.attempts[0]?.evidenceAt !== undefined);
    await st.giveRuling((await st.caseOf(id)).disputeIds[0], 2n);
    await st.until(rig, 'recordRuling and settle', async () => (await st.claimStatus(id)) === ClaimStatus.Settled, 90);

    rig.journal.close();
    const { calls, intents, results } = st.journalCalls();
    for (const fn of ['sendToCourt', 'relayClaim', 'openCase', 'submitEvidence', 'recordRuling', 'settle']) expect(calls.filter((c) => c === fn), fn).toHaveLength(1);
    expect(calls).not.toContain('relayRuling');
    expect(calls).not.toContain('resend');
    expect(results.every((r) => r.outcome === 'success')).toBe(true);
    expect(new Set(intents.map((r) => String(r.from).toLowerCase()))).toEqual(keeperKeys);
  });

  const claimTimeoutOf = async () =>
    Number((await st.s.hClient.readContract({ address: st.s.hed.claims, abi: claimsAbi, functionName: 'params' })).claimTimeout);

  it('marks an expired case stale on Arbitrum (slot freed) before Hedera may expire the claim, then expires it there', async () => {
    const rig = st.makeKeeper();
    await st.syncClocks();
    // The case's timeout is Hedera's less the 2 h relay budget, and the pre-check lands 10 min after
    // filing, so Hedera's expiry comes 2 h 10 min after Arbitrum's.
    const id = await st.toWatchingNone(rig, 2, { precheckDelayS: 600 });
    expect(await st.openCases()).toBe(1);
    const expiresAt = Number(await st.s.aClient.readContract({ address: st.s.arb.case, abi: caseAbi, functionName: 'expiresAt', args: [id] }));
    const caseTimeout = Number(await st.s.aClient.readContract({ address: st.s.arb.case, abi: caseAbi, functionName: 'claimTimeout' }));
    const claim = await st.getClaim(id);
    const claimTimeout = await claimTimeoutOf();
    expect(caseTimeout).toBe(claimTimeout - RELAY_BUDGET_S);
    expect(expiresAt).toBe(Number(claim.filedAt) + caseTimeout);
    const hederaExpiresAfter = Number(claim.preCheckedAt) + claimTimeout;
    expect(hederaExpiresAfter - expiresAt).toBeGreaterThanOrEqual(RELAY_BUDGET_S + 600);

    // Arbitrum just past expiresAt; Hedera 5 min short of its own expiry.
    await st.mineAt(st.s.A_URL, expiresAt + 1);
    await st.mineAt(st.s.H_URL, hederaExpiresAfter - 300);
    await st.until(rig, 'markStale', async () => (await st.caseOf(id)).state === CaseState.Stale);
    await st.until(rig, 'ClaimStale read', async () => rig.keeper.book.claims.get(id)?.staleAt !== undefined);
    expect(await st.openCases()).toBe(0);
    expect(await st.claimStatus(id)).toBe(ClaimStatus.AtCourt);

    // Past Hedera's own expiry the claim expires there and the fee is refunded.
    await st.mineAt(st.s.H_URL, hederaExpiresAfter + 2);
    await st.until(rig, 'expireClaim', async () => (await st.claimStatus(id)) === ClaimStatus.Expired);
    await rig.tick();
    expect(rig.keeper.book.claims.get(id)!.terminal).toBe('Expired');

    rig.journal.close();
    const { calls, outcomes } = st.callsFor(id);
    expect(calls.filter((c) => c === 'markStale')).toHaveLength(1);
    expect(calls.filter((c) => c === 'expireClaim')).toHaveLength(1);
    expect(outcomes.every((x) => x === 'success')).toBe(true);
  });

  it('after a downtime past both expiries: expires the claim on Hedera, then frees its case from the expired claim', async () => {
    const rig = st.makeKeeper();
    await st.syncClocks();
    const id = await st.toWatchingNone(rig, 3);
    expect(await st.openCases()).toBe(1);
    const claim = await st.getClaim(id);
    const past = Number(claim.preCheckedAt) + (await claimTimeoutOf()) + 60;
    await st.mineAt(st.s.H_URL, past);
    await st.mineAt(st.s.A_URL, past);
    await st.until(rig, 'expireClaim', async () => (await st.claimStatus(id)) === ClaimStatus.Expired);
    await st.until(rig, 'markStale', async () => (await st.caseOf(id)).state === CaseState.Stale);
    expect(await st.openCases()).toBe(0);
    await st.until(rig, 'ClaimStale read', async () => rig.keeper.book.claims.get(id)?.staleAt !== undefined);

    rig.journal.close();
    const { calls, outcomes } = st.callsFor(id);
    expect(calls.filter((c) => c === 'expireClaim' || c === 'markStale')).toEqual(['expireClaim', 'markStale']);
    expect(outcomes.every((x) => x === 'success')).toBe(true);
  });
});
