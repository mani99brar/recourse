// LOCAL ONLY. The keeper on two anvil nodes, one standing in for Hedera (port 8581) and one for
// Arbitrum (port 8582), with both DeployLocal stacks, the mock arbitrator, the mock OffRamps and
// the local CCIP relay process carrying messages between the nodes. The test plays the other
// parties (shop, pre-check signer, platform, court) from anvil's unlocked accounts; the keeper
// signs with its own two keys (anvil accounts 1 and 6 from anvil's public dev mnemonic).
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
import { openJournal, replayJournal, type Journal } from '../../src/journal.js';
import { BlockLogReader } from '../../src/logs.js';
import { Keeper } from '../../src/machine.js';
import { makeClient, viemTxRpc } from '../../src/rpc.js';
import { Sender, type TxSigner } from '../../src/sender.js';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const DEPLOYMENTS = join(ROOT, 'deployments');
const HEDERA_PORT = 8581;
const ARB_PORT = 8582;
const H_URL = `http://127.0.0.1:${HEDERA_PORT}`;
const A_URL = `http://127.0.0.1:${ARB_PORT}`;
const HEDERA_FILE = 'keeper05.hedera.local.json';
const ARB_FILE = 'keeper05.arbitrum.local.json';
const CASE_ON_FRESH_NODE = '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9';
// anvil's built-in development mnemonic (public; these accounts exist only on local nodes)
const DEV_MNEMONIC = 'test test test test test test test test test test test junk';
const dev = (i: number) => mnemonicToAccount(DEV_MNEMONIC, { addressIndex: i });
const ACCOUNT0 = dev(0).address;
const OPS_HEDERA = dev(1); // the claims rulingRelayer in the local stack
const OPS_ARB = dev(6); // set as the case contract's trusted relay; the CCIP relay process uses account 7

const claimsJson = JSON.parse(readFileSync(join(DEPLOYMENTS, 'abi', 'RecourseClaims.json'), 'utf8')) as Abi;
const erc20 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
const mockArbitrator = parseAbi(['function giveRuling(uint256 disputeID, uint256 ruling)']);

const started: ChildProcess[] = [];

function startAnvil(port: number): ChildProcess {
  const p = spawn('anvil', ['--port', String(port), '--silent'], { stdio: 'ignore' });
  started.push(p);
  return p;
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

describe('keeper on two anvil nodes, both legs over the local CCIP relay', () => {
  let hed: HederaDeployment;
  let arb: ArbitrumDeployment;
  let hClient: PublicClient;
  let aClient: PublicClient;
  let roles: { platform: Address; shop: Address; preCheckSigner: Address };
  let usdc: Address;
  const stateDir = mkdtempSync(join(tmpdir(), 'keeper-anvil-'));
  const docs = new Map<string, Uint8Array>();
  const wallet = (url: string) => createWalletClient({ transport: http(url) });

  /** Sends from an unlocked anvil account and waits for a successful receipt. */
  async function act(url: string, args: Parameters<ReturnType<typeof wallet>['writeContract']>[0]): Promise<void> {
    const hash = await wallet(url).writeContract(args);
    const client = url === H_URL ? hClient : aClient;
    const rc = await client.waitForTransactionReceipt({ hash, pollingInterval: 100 });
    if (rc.status !== 'success') throw new Error(`${String(args.functionName)} reverted`);
  }

  beforeAll(async () => {
    startAnvil(HEDERA_PORT);
    startAnvil(ARB_PORT);
    await waitRpc(H_URL);
    await waitRpc(A_URL);
    forgeScript('script/hedera/DeployLocal.s.sol', H_URL, {
      HEDERA_LOCAL_FILE: HEDERA_FILE,
      LOCAL_CASE_PEER: CASE_ON_FRESH_NODE,
      LOCAL_BRIDGE_MODE: 'Both',
    });
    const hRaw = JSON.parse(readFileSync(join(DEPLOYMENTS, HEDERA_FILE), 'utf8')) as {
      contracts: { claims: { address: Address } };
      roles: { platform: Address; shop: Address; preCheckSigner: Address };
      local: { usdc: Address };
    };
    forgeScript('script/arbitrum/DeployLocal.s.sol', A_URL, {
      ARBITRUM_LOCAL_FILE: ARB_FILE,
      LOCAL_CLAIMS_PEER: hRaw.contracts.claims.address,
      LOCAL_HEDERA_RPC_URL: H_URL,
      LOCAL_ARB_RPC_URL: A_URL,
      LOCAL_TRUSTED_RELAY: OPS_ARB.address,
    });
    arb = readArbitrumDeployment(DEPLOYMENTS, ARB_FILE);
    hed = readHederaDeployment(DEPLOYMENTS, HEDERA_FILE, arb);
    expect(arb.case).toBe(CASE_ON_FRESH_NODE);
    roles = hRaw.roles;
    usdc = hRaw.local.usdc;
    hClient = makeClient({ chainId: hed.chainId, urls: [H_URL] });
    aClient = makeClient({ chainId: arb.chainId, urls: [A_URL] });

    const relay = spawn(join(ROOT, 'node_modules', '.bin', 'tsx'), ['scripts/local-relay.ts'], {
      cwd: join(ROOT, 'packages', 'court'),
      env: { ...process.env, DEPLOYMENTS_DIR: DEPLOYMENTS, ARBITRUM_LOCAL_FILE: ARB_FILE, HEDERA_LOCAL_FILE: HEDERA_FILE, LOCAL_ARB_RPC_URL: A_URL, LOCAL_HEDERA_RPC_URL: H_URL },
      stdio: 'ignore',
    });
    started.push(relay);
  });

  afterAll(() => {
    for (const p of started) p.kill('SIGTERM');
    rmSync(stateDir, { recursive: true, force: true });
    for (const f of [HEDERA_FILE, ARB_FILE]) rmSync(join(DEPLOYMENTS, f), { force: true });
  });

  function makeKeeper(): Rig {
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
    (await hClient.readContract({ address: hed.claims, abi: claimsAbi, functionName: 'getClaim', args: [id] })).status;
  const caseOf = (id: Hex) => aClient.readContract({ address: arb.case, abi: caseAbi, functionName: 'caseOf', args: [id] });

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

  it('files, contests, opens, posts evidence, refiles once on ruling 0, relays the ruling and settles; survives a restart', async () => {
    const params = (await hClient.readContract({ address: hed.claims, abi: claimsAbi, functionName: 'params' })) as { courtFeeUsdc: bigint };
    const nonce = keccak256(toHex('keeper anvil claim 1'));
    const refs = { topicNum: 4242n, seq: [100n, 101n, 102n, 103n, 104n, 105n], hashes: [0, 1, 2, 3, 4, 5].map((i) => keccak256(toHex(`rec ${i}`))) };

    // Shop files.
    await act(H_URL, { chain: null, account: roles.shop, address: usdc, abi: erc20, functionName: 'approve', args: [hed.vault, params.courtFeeUsdc * 2n] });
    await act(H_URL, { chain: null, account: roles.shop, address: hed.claims, abi: claimsJson, functionName: 'fileClaim', args: [nonce, roles.platform, refs, 120_000_000n, 100_000_000n] });
    const id = (await hClient.readContract({ address: hed.claims, abi: claimsJson, functionName: 'claimIdFor', args: [roles.platform, roles.shop, nonce] })) as Hex;
    expect(await claimStatus(id)).toBe(ClaimStatus.Filed);

    let rig = makeKeeper();
    await until(rig, 'ClaimFiled', async () => rig.keeper.book.claims.has(id));

    // Pre-check signer records; the platform contests; the keeper sends to court.
    await act(H_URL, { chain: null, account: roles.preCheckSigner, address: hed.claims, abi: claimsJson, functionName: 'recordPreCheck', args: [id, 1, 1, precheckDoc(id)] });
    await act(H_URL, { chain: null, account: roles.platform, address: hed.claims, abi: claimsJson, functionName: 'contest', args: [id] });
    expect(await claimStatus(id)).toBe(ClaimStatus.Contested);
    await until(rig, 'sendToCourt', async () => (await claimStatus(id)) === ClaimStatus.AtCourt);

    // The relay delivers it; the keeper opens the case and posts evidence for attempt 1.
    await until(rig, 'openCase', async () => (await caseOf(id)).state === CaseState.Opened);
    await until(rig, 'evidence 1', async () => rig.keeper.book.claims.get(id)?.attempts[0]?.evidenceAt !== undefined);
    expect(rig.keeper.book.claims.get(id)!.deliveredAt).toBeDefined();

    // Restart: a fresh keeper on the same journal picks up where the first left off.
    rig.journal.close();
    rig = makeKeeper();
    expect(rig.keeper.book.claims.get(id)!.attempts).toHaveLength(1);

    // The court refuses on attempt 1: the keeper refiles with the same payload.
    const d1 = (await caseOf(id)).disputeIds[0];
    await act(A_URL, { chain: null, account: ACCOUNT0, address: arb.klerosCore, abi: mockArbitrator, functionName: 'giveRuling', args: [d1, 0n] });
    await until(rig, 'refile', async () => (await caseOf(id)).attempts === 2);
    await until(rig, 'evidence 2', async () => rig.keeper.book.claims.get(id)?.attempts[1]?.evidenceAt !== undefined);

    // A final ruling: relayed to Hedera over the relay, then settled.
    const d2 = (await caseOf(id)).disputeIds[1];
    await act(A_URL, { chain: null, account: ACCOUNT0, address: arb.klerosCore, abi: mockArbitrator, functionName: 'giveRuling', args: [d2, 1n] });
    await until(rig, 'relayRuling', async () => (await caseOf(id)).state === CaseState.Relayed);
    await until(rig, 'settle', async () => (await claimStatus(id)) === ClaimStatus.Settled, 90);
    await rig.tick();
    expect(rig.keeper.book.claims.get(id)!.terminal).toBe('Settled');

    // One transaction per step, all from the keeper's two keys, all mined successfully.
    rig.journal.close();
    const records = replayJournal(stateDir).records;
    const intents = records.filter((r) => r.t === 'intent');
    const results = records.filter((r) => r.t === 'result');
    const calls = intents.map((r) => String(r.call));
    for (const fn of ['sendToCourt', 'openCase', 'refile', 'relayRuling', 'settle']) expect(calls.filter((c) => c === fn), fn).toHaveLength(1);
    expect(calls.filter((c) => c === 'submitEvidence')).toHaveLength(2);
    expect(results.every((r) => r.outcome === 'success')).toBe(true);
    expect(new Set(intents.map((r) => String(r.from).toLowerCase()))).toEqual(new Set([OPS_HEDERA.address.toLowerCase(), OPS_ARB.address.toLowerCase()]));
  });
});
