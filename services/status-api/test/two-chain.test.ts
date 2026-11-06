// A claim from filing to settlement across two real local nodes: the Hedera stack (DeployLocal)
// and the Arbitrum stack (DeployLocal with a mock court and mock OffRamps). Skipped unless
// TWO_CHAIN_HEDERA_URL, TWO_CHAIN_ARB_URL, HEDERA_LOCAL_FILE and ARBITRUM_LOCAL_FILE are set.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  claimIdOf, encodeClaimToCourt, encodeRulingBack, newOrderNonce, orderIdOf, type RecordRefs,
} from '@recourse/shared';
import {
  createPublicClient, createWalletClient, encodeAbiParameters, http, parseAbi, type Abi, type Address, type Hex,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { loadDeployments } from '../src/deployments.js';
import { Indexer } from '../src/indexer.js';
import { DocFetcher } from '../src/ipfs.js';
import { ViemReader } from '../src/live.js';
import { Store } from '../src/store.js';
import { viemArbRpc } from '../src/sources/viem-arb.js';
import type { SimLog } from './helpers/encode.js';
import { FakeMirror } from './helpers/mirror.js';
import { harness, testConfig } from './helpers/service.js';

const H = process.env.TWO_CHAIN_HEDERA_URL;
const A = process.env.TWO_CHAIN_ARB_URL;
const HF = process.env.HEDERA_LOCAL_FILE;
const AF = process.env.ARBITRUM_LOCAL_FILE;
const enabled = Boolean(H && A && HF && AF);

const abiDir = join(__dirname, '../../../deployments/abi');
const abi = (n: string) => JSON.parse(readFileSync(join(abiDir, `${n}.json`), 'utf8')) as Abi;
const router = parseAbi([
  'function routeMessage((bytes32 messageId, uint64 sourceChainSelector, bytes sender, bytes data, (address token, uint256 amount)[] destTokenAmounts) message, uint16 gasForCallExactCheck, uint256 gasLimit, address receiver) returns (bool success, bytes retData, uint256 gasUsed)',
]);
const erc20 = parseAbi(['function approve(address,uint256) returns (bool)']);
const arbitrator = parseAbi(['function giveRuling(uint256,uint256)']);
const offRamp = parseAbi(['function setExecutionState(bytes32,uint8)']);
const evidenceMod = parseAbi(['function submitEvidence(uint256,string)']);

describe.skipIf(!enabled)('two local chains, one claim end to end', () => {
  it('shows each status along the way, from filed to settled', async () => {
    const dep = loadDeployments(dirname(join(__dirname, '../../../deployments/x')));
    const hj = JSON.parse(readFileSync(join(__dirname, '../../../deployments', HF!), 'utf8'));
    const roles = hj.roles as Record<string, Address>;
    const local = hj.local as { router: Address; usdc: Address; arbSelector: string; casePeer: Address };
    const claims = dep.claims!;
    const vault = dep.vault!;
    const kase = dep.caseAddress!;
    const hp = createPublicClient({ transport: http(H!) });
    const ap = createPublicClient({ transport: http(A!) });
    const send = async (url: string, pub: typeof hp, from: Address, address: Address, abiX: Abi, functionName: string, args: unknown[], gas?: bigint) => {
      const w = createWalletClient({ account: from, transport: http(url) });
      const hash = await (w as any).writeContract({ address, abi: abiX, functionName, args, ...(gas ? { gas } : {}), chain: null });
      const r = await pub.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') throw new Error(`${functionName} reverted`);
      return r;
    };
    const claimsAbi = abi('RecourseClaims');
    const caseAbiJson = abi('RecourseCase');

    // Indexer rig: Hedera through a mirror-shaped fake over the node's logs, Arbitrum for real.
    const mirror = new FakeMirror();
    mirror.pageSize = 9;
    const store = new Store();
    const reader = new ViemReader({
      hederaRpcUrls: [H!], arbRpcUrl: A!, timeoutMs: 5000, claims, vault, caseAddress: kase,
      klerosCore: dep.outside.klerosCore, offRampHedera: dep.outside.offRampHedera, offRampArb: dep.outside.offRampArb, arbConfirmations: 0,
    });
    const cfg = testConfig({ recordsTopic: '', arbConfirmations: 0, arbLogChunk: 500, viewCacheMs: 0 });
    const clock = { now: 0 };
    const docs = new DocFetcher({ fetch: async () => new Response(null, { status: 503 }), ipfs: null, ratePerMin: 1, timeoutMs: 100 });
    const indexer = new Indexer({ store, cfg, deployments: dep, fetch: mirror.fetch, arbRpc: viemArbRpc(A!, 5000), reader, parties: () => null, docs, nowS: () => clock.now });
    const h = harness({ store, reader, cfg: { viewCacheMs: 0, recordsTopic: '' }, deployments: dep });
    (h.svc.d as { nowS: () => number }).nowS = () => clock.now;

    async function refresh(): Promise<void> {
      for (const [address, contract] of [[claims, 'claims'], [vault, 'vault']] as const) {
        const rows = (await hp.request({ method: 'eth_getLogs', params: [{ address, fromBlock: '0x0', toBlock: 'latest' }] })) as { address: Address; topics: Hex[]; data: Hex; transactionHash: Hex; logIndex: Hex; blockNumber: Hex }[];
        const logs: SimLog[] = [];
        for (const r of rows) {
          const block = await hp.getBlock({ blockNumber: BigInt(r.blockNumber) });
          const idx = Number(BigInt(r.logIndex));
          const ts = `${block.timestamp}.${String(Number(BigInt(r.blockNumber)) % 1000).padStart(3, '0')}${String(idx).padStart(6, '0')}`;
          logs.push({ chain: 'hedera', contract, ts, raw: { address, topics: r.topics, data: r.data, tx: r.transactionHash, logIndex: idx, time: block.timestamp, order: ts } });
        }
        mirror.logs.set(address.toLowerCase(), logs);
      }
      const a = await ap.getBlock();
      const hb = await hp.getBlock();
      clock.now = Number(a.timestamp > hb.timestamp ? a.timestamp : hb.timestamp) + 1;
      mirror.headTs = `${clock.now}.000000000`;
      await indexer.pollOnce();
    }
    const row = async (id: Hex) => (await h.svc.claimRows()).find((r) => r.claimId === id)!;
    async function expectKey(id: Hex, key: string) {
      await refresh();
      expect((await row(id)).statusKey).toBe(key);
    }

    // File.
    const fee = 3_000_000n;
    const nonce = newOrderNonce();
    const orderId = orderIdOf(roles.platform!, roles.shop!, nonce);
    const claimId = claimIdOf(hj.chainId, claims, orderId);
    const refs: RecordRefs = {
      topicNum: 4242n,
      seq: [1n, 2n, 3n, 4n, 5n, 6n],
      hashes: [1, 2, 3, 4, 5, 6].map((i) => `0x${i.toString(16).padStart(64, '0')}`) as unknown as RecordRefs['hashes'],
    };
    await send(H!, hp, roles.shop!, local.usdc, erc20 as Abi, 'approve', [vault, fee]);
    await send(H!, hp, roles.shop!, claims, claimsAbi, 'fileClaim', [nonce, roles.platform, refs, 60_000_000n, 50_000_000n]);
    await expectKey(claimId, 'filed');
    expect((await row(claimId)).deadline).not.toBeNull(); // expires if not pre-checked
    expect((await row(claimId)).escrow).toEqual({ amount: fee, fate: 'held' });

    const packHash = ('0x' + 'ee'.repeat(32)) as Hex;
    await send(H!, hp, roles.preCheckSigner!, claims, claimsAbi, 'recordPreCheck', [claimId, 1, 1, packHash]);
    await expectKey(claimId, 'finding_made');

    await send(H!, hp, roles.platform!, claims, claimsAbi, 'contest', [claimId]);
    await expectKey(claimId, 'contested');
    expect((await row(claimId)).deadline).not.toBeNull(); // expires if no ruling

    const sent = await send(H!, hp, roles.rulingRelayer!, claims, claimsAbi, 'sendToCourt', [claimId]);
    await expectKey(claimId, 'at_court');
    const outRow = await row(claimId);
    expect(outRow.nextActor).toBe('none'); // case not received yet
    void sent;
    const live0 = store.live.get(claimId);
    expect(Object.keys(live0?.exec ?? {}).length).toBe(1); // outbound message state read on the Arbitrum OffRamp
    const outMsg = Object.keys(live0!.exec)[0] as Hex;

    // Deliver to Arbitrum with the local router, as CCIP would.
    const c = (await hp.readContract({ address: claims, abi: claimsAbi, functionName: 'getClaim', args: [claimId] })) as any;
    const payload = encodeClaimToCourt({
      version: 1, claimId, platform: c.platform, shop: c.shop, gap: c.gap, answer: c.answer,
      refs: { topicNum: c.refs.topicNum, seq: c.refs.seq, hashes: c.refs.hashes }, packHash: c.packHash,
      basketUsdc: c.basketUsdc, netLossUsdc: c.netLossUsdc, filedAt: c.filedAt,
    });
    const arbRouter = (JSON.parse(readFileSync(join(__dirname, '../../../deployments', AF!), 'utf8')) as { mocks: { router: Address } }).mocks.router;
    await send(A!, ap, roles.rulingRelayer!, arbRouter, router as Abi, 'routeMessage', [
      { messageId: outMsg, sourceChainSelector: BigInt(222782988166878823n), sender: encodeAbiParameters([{ type: 'address' }], [claims]), data: payload, destTokenAmounts: [] },
      5000, 400_000n, kase,
    ], 800_000n);
    await send(A!, ap, roles.owner!, dep.outside.offRampArb, offRamp as Abi, 'setExecutionState', [outMsg, 2]);
    await expectKey(claimId, 'at_court');
    expect((await row(claimId)).nextCall).toBe('openCase');

    // Open the case and add evidence.
    const open = await send(A!, ap, roles.rulingRelayer!, kase, caseAbiJson, 'openCase', [payload]);
    expect(open.status).toBe('success');
    const ext = (await ap.readContract({ address: kase, abi: caseAbiJson, functionName: 'externalIdOf', args: [claimId, 1] })) as bigint;
    await send(A!, ap, roles.shop!, dep.outside.evidenceModule, evidenceMod as Abi, 'submitEvidence', [ext, '{"name":"Sample evidence","fileURI":"/ipfs/bafysample"}']);
    await expectKey(claimId, 'at_court');
    let d = await h.svc.claimDetail(claimId);
    expect(d.court.disputeIds).toHaveLength(1);
    expect(d.court.state).toBe('opened');
    expect(store.live.get(claimId)!.caseView!.expiresAt ?? 0n).toBeGreaterThan(0n);
    expect(d.court.evidence).toHaveLength(1);
    expect(d.court.courtLinks[0]!.url).toContain(d.court.disputeIds[0]!.toString());
    expect(d.court.currentRuling).toBe(0n);

    // Ruling by the mock court, then relay back.
    const disputeId = d.court.disputeIds[0]!;
    await send(A!, ap, roles.owner!, dep.outside.klerosCore, arbitrator as Abi, 'giveRuling', [disputeId, 1n]);
    await expectKey(claimId, 'at_court');
    d = await h.svc.claimDetail(claimId);
    expect(d.court.currentRuling).toBe(1n);
    expect(d.court.state).toBe('ruled');
    expect((await row(claimId)).nextCall).toBe('relayRuling');

    const relay = await send(A!, ap, roles.rulingRelayer!, kase, caseAbiJson, 'relayRuling', [claimId]);
    expect(relay.status).toBe('success');
    await refresh();
    d = await h.svc.claimDetail(claimId);
    expect(d.court.state).toBe('relayed');
    const back = d.events.find((e) => e.name === 'RulingRelayed')!;
    expect(back).toBeTruthy();
    const backMsg = (store.eventsOf(claimId).find((e) => e.name === 'RulingRelayed')!.args.messageId) as Hex;

    // Deliver the ruling on Hedera with the local router.
    const rb = encodeRulingBack({ version: 1, claimId, disputeId: BigInt(disputeId), ruling: 1, attempts: 1 });
    await send(H!, hp, roles.rulingRelayer!, local.router, router as Abi, 'routeMessage', [
      { messageId: backMsg, sourceChainSelector: BigInt(local.arbSelector), sender: encodeAbiParameters([{ type: 'address' }], [local.casePeer]), data: rb, destTokenAmounts: [] },
      5000, 400_000n, claims,
    ], 800_000n);
    await send(H!, hp, roles.owner!, dep.outside.offRampHedera, offRamp as Abi, 'setExecutionState', [backMsg, 2]);
    await expectKey(claimId, 'ruled');
    const ruled = await row(claimId);
    expect(ruled.owed).toBe(50_000_000n + 15_000_000n + 3_000_000n + fee);
    expect(ruled.paid).toBeNull();

    await send(H!, hp, roles.rulingRelayer!, claims, claimsAbi, 'settle', [claimId]);
    await expectKey(claimId, 'settled');
    const done = await row(claimId);
    expect(done.owed).toBe(done.paid! + done.notCovered!);
    expect(done.escrow.fate).toBe('kept_by_pool');

    // Both legs are named with the right direction.
    d = await h.svc.claimDetail(claimId);
    expect(d.bridge.map((b) => b.direction)).toContain('toArbitrum');
    expect(store.status.arbitrum.decodeFailures).toBe(0);
    expect(store.status.hedera.decodeFailures).toBe(0);
  }, 120_000);
});
