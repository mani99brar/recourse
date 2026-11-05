// LOCAL ONLY. Seeds a two-node local stack (Hedera-side and Arbitrum-side anvils with the
// DeployLocal contracts) with claims in several states, then serves a mirror-node-shaped HTTP API
// and an IPFS-style gateway over the nodes so status-api and the web app can run without testnet.
//
//   tsx scripts/local-stack.ts   (env: HEDERA_URL, ARB_URL, HEDERA_LOCAL_FILE, ARBITRUM_LOCAL_FILE,
//                                 MIRROR_PORT, QA_DIR)
//
// Every name it writes is a labelled sample. Nothing here touches a real network.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import {
  canonicalBytes, claimIdOf, encodeClaimToCourt, encodeRecordMsg, encodeRulingBack, newOrderNonce, orderIdOf, recordHash,
  type RecordRefs,
} from '@recourse/shared';
import { createPublicClient, createWalletClient, encodeAbiParameters, http, parseAbi, type Abi, type Address, type Hex } from 'viem';

const env = (n: string, d?: string) => process.env[n] ?? d ?? (() => { throw new Error(`${n} not set`); })();
const H = env('HEDERA_URL', 'http://127.0.0.1:8600');
const A = env('ARB_URL', 'http://127.0.0.1:8601');
const HF = env('HEDERA_LOCAL_FILE');
const AF = env('ARBITRUM_LOCAL_FILE');
const PORT = Number(env('MIRROR_PORT', '8602'));
const QA = env('QA_DIR', '/tmp/qa');
const root = join(import.meta.dirname, '../../..');
const dep = (f: string) => JSON.parse(readFileSync(join(root, 'deployments', f), 'utf8'));
const abi = (n: string) => JSON.parse(readFileSync(join(root, 'deployments/abi', `${n}.json`), 'utf8')) as Abi;

const hj = dep(HF);
const aj = dep(AF);
const roles = hj.roles as Record<string, Address>;
const claims = hj.contracts.claims.address as Address;
const vault = hj.contracts.vault.address as Address;
const kase = aj.contracts.case.address as Address;
const local = hj.local as { router: Address; usdc: Address; arbSelector: string; casePeer: Address };
const out = aj.outside as { offRampHedera: Address; offRampArb: Address; klerosCore: Address; evidenceModule: Address };
const hp = createPublicClient({ transport: http(H) });
const ap = createPublicClient({ transport: http(A) });
const claimsAbi = abi('RecourseClaims');
const caseAbi = abi('RecourseCase');
const routerAbi = parseAbi(['function routeMessage((bytes32 messageId, uint64 sourceChainSelector, bytes sender, bytes data, (address token, uint256 amount)[] destTokenAmounts) message, uint16 gasForCallExactCheck, uint256 gasLimit, address receiver) returns (bool success, bytes retData, uint256 gasUsed)']) as Abi;
const erc20 = parseAbi(['function approve(address,uint256) returns (bool)']) as Abi;
const arbitratorAbi = parseAbi(['function giveRuling(uint256,uint256)']) as Abi;
const offRampAbi = parseAbi(['function setExecutionState(bytes32,uint8)']) as Abi;
const evidenceAbi = parseAbi(['function submitEvidence(uint256,string)']) as Abi;

async function send(url: string, pub: typeof hp, from: Address, address: Address, a: Abi, functionName: string, args: unknown[], gas?: bigint) {
  const w = createWalletClient({ account: from, transport: http(url) });
  const hash = await (w as any).writeContract({ address, abi: a, functionName, args, ...(gas ? { gas } : {}), chain: null });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${functionName} reverted`);
  return r;
}
const hs = (from: Address, address: Address, a: Abi, fn: string, args: unknown[]) => send(H, hp, from, address, a, fn, args);
const as_ = (from: Address, address: Address, a: Abi, fn: string, args: unknown[], gas?: bigint) => send(A, ap, from, address, a, fn, args, gas);
const rpc = (url: string, method: string, params: unknown[] = []) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json()) as Promise<{ result: any }>;

// ---------------------------------------------------------------- records
const TOPIC = '0.0.4242';
const topicMsgs: { seq: number; ts: string; payer: string; body: Uint8Array }[] = [];
const docs = new Map<string, Uint8Array>();
const DOCS = (orderId: Hex) => [
  { kind: 'asked', attrs: { brand: 'northwind', size: 'm', price: '120' } },
  { kind: 'shown', attrs: { size: 'm', price: '95.50' }, changes: [] },
  { kind: 'approval', approval: 'approved', approvalBasis: 'buyer' },
  { kind: 'ordered', attrs: { brand: 'fabrikam', size: 'm', price: '95.50' }, x402TxId: '0.0.1002@1700000000.000000001' },
  { kind: 'packed', attrs: { brand: 'fabrikam', size: 'm' } },
  { kind: 'arrived', attrs: { brand: 'fabrikam', size: 'm' } },
].map((d) => ({ v: '1', orderId, ...d }));
let hcsSeq = 0;
function publishRecords(orderId: Hex): RecordRefs {
  const seq: bigint[] = [];
  const hashes: Hex[] = [];
  DOCS(orderId).forEach((d, kind) => {
    const bytes = canonicalBytes(d as never);
    const hash = recordHash(bytes);
    const cid = `bafyqa${orderId.slice(2, 10)}k${kind}`;
    docs.set(cid, bytes);
    hcsSeq++;
    topicMsgs.push({ seq: hcsSeq, ts: `${1_700_000_000 + hcsSeq}.000000000`, payer: kind === 4 ? '0.0.2001' : '0.0.1002', body: encodeRecordMsg({ cid, hash, kind: kind as 0, orderId }) });
    seq.push(BigInt(hcsSeq));
    hashes.push(hash);
  });
  return { topicNum: 4242n, seq: seq as never, hashes: hashes as never };
}

// ---------------------------------------------------------------- seeding
const FEE = 3_000_000n;
// Claims without published records still need a non-zero 'ordered' hash to be filed.
const noRefs = (): RecordRefs => ({
  topicNum: 4242n,
  seq: [0n, 0n, 0n, 9001n, 0n, 0n],
  hashes: [0, 1, 2, 3, 4, 5].map((i) => (i === 3 ? '0x' + '5a'.repeat(32) : '0x' + '00'.repeat(32))) as never,
});
const sample = (orderId: Hex, i: number): RecordRefs => {
  void i;
  return publishRecords(orderId);
};

async function newClaim(withRecords: boolean, basket = 60_000_000n, netLoss = 50_000_000n) {
  const nonce = newOrderNonce();
  const orderId = orderIdOf(roles.platform!, roles.shop!, nonce);
  const claimId = claimIdOf(hj.chainId, claims, orderId);
  const refs = withRecords ? sample(orderId, 0) : noRefs();
  await hs(roles.shop!, local.usdc, erc20, 'approve', [vault, FEE]);
  await hs(roles.shop!, claims, claimsAbi, 'fileClaim', [nonce, roles.platform, refs, basket, netLoss]);
  return { claimId, orderId, refs };
}
const precheck = (id: Hex) => hs(roles.preCheckSigner!, claims, claimsAbi, 'recordPreCheck', [id, 1, 1, ('0x' + 'ee'.repeat(32)) as Hex]);
const contest = (id: Hex) => hs(roles.platform!, claims, claimsAbi, 'contest', [id]);

async function toCourt(id: Hex, withEvidence = true) {
  await hs(roles.rulingRelayer!, claims, claimsAbi, 'sendToCourt', [id]);
  const c = (await hp.readContract({ address: claims, abi: claimsAbi, functionName: 'getClaim', args: [id] })) as any;
  const logs = (await rpc(H, 'eth_getLogs', [{ address: claims, fromBlock: '0x0', toBlock: 'latest' }])).result as any[];
  void logs;
  const payload = encodeClaimToCourt({ version: 1, claimId: id, platform: c.platform, shop: c.shop, gap: c.gap, answer: c.answer, refs: { topicNum: c.refs.topicNum, seq: c.refs.seq, hashes: c.refs.hashes }, packHash: c.packHash, basketUsdc: c.basketUsdc, netLossUsdc: c.netLossUsdc, filedAt: c.filedAt });
  const msgId = c.lastMessageId as Hex;
  await as_(roles.rulingRelayer!, aj.mocks.router, routerAbi, 'routeMessage', [
    { messageId: msgId, sourceChainSelector: 222782988166878823n, sender: encodeAbiParameters([{ type: 'address' }], [claims]), data: payload, destTokenAmounts: [] }, 5000, 400_000n, kase,
  ], 800_000n);
  await as_(roles.owner!, out.offRampArb, offRampAbi, 'setExecutionState', [msgId, 2]);
  await as_(roles.rulingRelayer!, kase, caseAbi, 'openCase', [payload]);
  if (withEvidence) {
    const ext = (await ap.readContract({ address: kase, abi: caseAbi, functionName: 'externalIdOf', args: [id, 1] })) as bigint;
    await as_(roles.shop!, out.evidenceModule, evidenceAbi, 'submitEvidence', [ext, '{"name":"Sample evidence (local)","fileURI":"/ipfs/bafyqasample"}']);
  }
  return payload;
}

async function seed() {
  // Make both chains' clocks match the wall clock after the expiry warp.
  // 1. An expired claim: filed first, then the clock jumps past the claim timeout.
  const expired = await newClaim(false);
  const timeout = Number(((await hp.readContract({ address: claims, abi: claimsAbi, functionName: 'params' })) as any).claimTimeout);
  const real = Math.floor(Date.now() / 1000);
  for (const [url, pub] of [[H, hp], [A, ap]] as const) {
    const t = Number((await pub.getBlock()).timestamp);
    await rpc(url, 'evm_increaseTime', [Math.max(real - t, timeout + 60)]);
    await rpc(url, 'evm_mine');
  }
  await hs(roles.rulingRelayer!, claims, claimsAbi, 'expireClaim', [expired.claimId]);

  const filed = await newClaim(false);
  const checked = await newClaim(true);
  await precheck(checked.claimId);
  const contested = await newClaim(false);
  await precheck(contested.claimId);
  await contest(contested.claimId);
  const atCourt = await newClaim(false);
  await precheck(atCourt.claimId);
  await contest(atCourt.claimId);
  await toCourt(atCourt.claimId);

  // Settled with a full record set.
  const done = await newClaim(true);
  await precheck(done.claimId);
  await contest(done.claimId);
  const payload = await toCourt(done.claimId);
  void payload;
  const ev = (await ap.readContract({ address: kase, abi: caseAbi, functionName: 'caseOf', args: [done.claimId] })) as any;
  const disputeId = ev.disputeIds[0] as bigint;
  await as_(roles.owner!, out.klerosCore, arbitratorAbi, 'giveRuling', [disputeId, 1n]);
  const relay = await as_(roles.rulingRelayer!, kase, caseAbi, 'relayRuling', [done.claimId]);
  void relay;
  const logs = (await rpc(A, 'eth_getLogs', [{ address: kase, fromBlock: '0x0', toBlock: 'latest' }])).result as any[];
  const relayed = logs.filter((l) => l.topics[1] === done.claimId && l.topics[0] === relayedTopic())[0];
  const backMsg = ('0x' + (relayed?.data as string).slice(2 + 64, 2 + 128)) as Hex;
  const rb = encodeRulingBack({ version: 1, claimId: done.claimId, disputeId, ruling: 1, attempts: 1 });
  await send(H, hp, roles.rulingRelayer!, local.router, routerAbi, 'routeMessage', [
    { messageId: backMsg, sourceChainSelector: BigInt(local.arbSelector), sender: encodeAbiParameters([{ type: 'address' }], [local.casePeer]), data: rb, destTokenAmounts: [] }, 5000, 400_000n, claims,
  ], 800_000n);
  await hs(roles.owner!, out.offRampHedera, offRampAbi, 'setExecutionState', [backMsg, 2]);
  await hs(roles.rulingRelayer!, claims, claimsAbi, 'settle', [done.claimId]);
  return { expired, filed, checked, contested, atCourt, done };
}

import { toEventSelector } from 'viem';
function relayedTopic(): string {
  const item = (caseAbi as any[]).find((x) => x.type === 'event' && x.name === 'RulingRelayed');
  return toEventSelector(item);
}

// ---------------------------------------------------------------- parties for the web
function writeParties() {
  const mk = (role: string, evmAddress: string, id: string, name: string, hcsWriters: string[] = []) => ({ role, evmAddress, hederaAccountId: id, hcsWriters, displayName: name });
  const scheme = '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955';
  const list = [
    mk('platform', roles.platform!, '0.0.1001', 'Example Agent Co (sample)', ['0.0.1002']),
    mk('agent', '0x976EA74026E726554dB657fA54763abd0C3a0aa9', '0.0.1002', 'Example agent (sample)'),
    mk('shop', roles.shop!, '0.0.2001', 'Example Shop (sample)', ['0.0.2001']),
    mk('scheme', scheme, '0.0.3001', 'Docket writer (sample)'),
  ];
  mkdirSync(QA, { recursive: true });
  writeFileSync(join(QA, 'parties.json'), JSON.stringify(list, null, 2));
}

// ---------------------------------------------------------------- mirror + gateway
const blockTs = new Map<string, number>();
async function ts(url: string, blockHex: string): Promise<number> {
  const k = `${url}${blockHex}`;
  let v = blockTs.get(k);
  if (v === undefined) {
    v = Number(BigInt((await rpc(url, 'eth_getBlockByNumber', [blockHex, false])).result.timestamp));
    blockTs.set(k, v);
  }
  return v;
}

async function serveMirror() {
  const srv = createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const json = (b: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(b, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))); };
      const skip = Number(u.searchParams.get('skip') ?? '0');
      const page = Number(u.searchParams.get('limit') ?? '100');
      const next = (n: number, total: number) => {
        if (skip + n >= total) return null;
        const q = new URLSearchParams(u.searchParams); q.set('skip', String(skip + n));
        return `${u.pathname}?${q}`;
      };
      let m = /^\/api\/v1\/contracts\/(0x[0-9a-fA-F]+)\/results\/logs$/.exec(u.pathname);
      if (m) {
        const rows = ((await rpc(H, 'eth_getLogs', [{ address: m[1], fromBlock: '0x0', toBlock: 'latest' }])).result as any[]);
        const min = (u.searchParams.get('timestamp') ?? 'gte:0').split(':')[1]!;
        const list = [];
        for (const r of rows) {
          const t = await ts(H, r.blockNumber);
          const stamp = `${t}.${String(Number(BigInt(r.blockNumber)) % 1000).padStart(3, '0')}${String(Number(BigInt(r.logIndex))).padStart(6, '0')}`;
          list.push({ address: r.address, data: r.data, index: Number(BigInt(r.logIndex)), topics: r.topics, timestamp: stamp, transaction_hash: r.transactionHash });
        }
        const pad = (s: string) => { const [a = '0', b = '0'] = s.split('.'); return `${a.padStart(12, '0')}.${b.padEnd(9, '0')}`; };
        const sel = list.filter((l) => pad(l.timestamp) >= pad(min)).sort((a, b) => (pad(a.timestamp) + String(a.index).padStart(6, '0')).localeCompare(pad(b.timestamp) + String(b.index).padStart(6, '0')));
        const slice = sel.slice(skip, skip + page);
        return json({ logs: slice, links: { next: next(slice.length, sel.length) } });
      }
      m = /^\/api\/v1\/topics\/([\d.]+)\/messages$/.exec(u.pathname);
      if (m) {
        const gt = Number((u.searchParams.get('sequencenumber') ?? 'gt:0').split(':')[1]);
        const sel = m[1] === TOPIC ? topicMsgs.filter((x) => x.seq > gt) : [];
        const slice = sel.slice(skip, skip + page);
        return json({ messages: slice.map((x) => ({ consensus_timestamp: x.ts, message: Buffer.from(x.body).toString('base64'), payer_account_id: x.payer, sequence_number: x.seq })), links: { next: next(slice.length, sel.length) } });
      }
      if (u.pathname === '/api/v1/blocks') return json({ blocks: [{ timestamp: { to: `${Math.floor(Date.now() / 1000)}.000000000` } }] });
      m = /^\/ipfs\/(.+)$/.exec(u.pathname);
      if (m && docs.has(m[1]!)) { res.end(Buffer.from(docs.get(m[1]!)!)); return; }
      res.statusCode = 404; res.end('{}');
    } catch (e) {
      res.statusCode = 500; res.end(String(e));
    }
  });
  await new Promise<void>((r) => srv.listen(PORT, '127.0.0.1', r));
}

async function main() {
  writeParties();
  const ids = await seed();
  await serveMirror();
  writeFileSync(join(QA, 'claims.json'), JSON.stringify(Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, { claimId: v.claimId, orderId: v.orderId }])), null, 2));
  console.log('READY', JSON.stringify(Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, v.claimId]))));
}
void main();
