// Test fixtures: a fake mirror node, gateway and chain behind one fake fetch, in the real response
// shapes, plus a fake transaction node. Names and ids are fictional; Hedera accounts use realm 9.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MirrorClient,
  replayJournal,
  claimsAbi,
  compareTs,
  RevertError,
  TransientError,
  type FeeFields,
  type MirrorLog,
  type TxReceipt,
  type TxRpc,
} from '@recourse/keeper';
import {
  ZERO_HASH,
  canonicalBytes,
  encodeRecordMsg,
  recordHash,
  type CanonicalValue,
  type Parties,
  type RecordKind,
  type RecordRefs,
} from '@recourse/shared';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  getAddress,
  keccak256,
  parseTransaction,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Clock } from '../src/clock.js';
import type { PrecheckConfig } from '../src/config.js';
import { GatewayDocStore, LocalDocStore, rawBlockCid, type DocStore } from '../src/docs.js';
import type { ProofClaim, ProofPorts } from '../src/proof.js';
import { PrecheckService, type ServiceDeps } from '../src/service.js';
import { TopicIndex } from '../src/topicIndex.js';
import type { ClaimsChain } from '../src/writer.js';

export const MIRROR = 'https://mirror.example';
export const GATEWAY = 'https://gateway.example';
export const TOPIC_ID = '9.9.500';
export const CLAIMS: Address = getAddress('0x00000000000000000000000000000000000c1a15');
export const AGENT_ACCOUNT = '9.9.1001';
export const SHOP_ACCOUNT = '9.9.2001';
export const STRANGER_ACCOUNT = '9.9.3001';
export const FILED_AT = 1_700_000_000n;

export const PARTIES: Parties = [
  {
    role: 'platform',
    evmAddress: getAddress('0x00000000000000000000000000000000000000a1'),
    hederaAccountId: '9.9.1000',
    hcsWriters: [AGENT_ACCOUNT],
    displayName: 'Fictional Platform',
  },
  {
    role: 'shop',
    evmAddress: getAddress('0x00000000000000000000000000000000000000a2'),
    hederaAccountId: '9.9.2000',
    hcsWriters: [SHOP_ACCOUNT],
    displayName: 'Fictional Shop',
  },
  {
    role: 'precheck-signer',
    evmAddress: getAddress('0x00000000000000000000000000000000000000a3'),
    hederaAccountId: '9.9.4000',
    hcsWriters: [],
    displayName: 'Fictional Signer',
  },
];

export class FakeClock implements Clock {
  constructor(public ms: number) {}
  now(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  setSeconds(s: bigint | number): void {
    this.ms = Number(s) * 1000;
  }
}

export const KINDS = [0, 1, 2, 3, 4, 5] as const satisfies readonly RecordKind[];
const KEYS = ['asked', 'shown', 'approval', 'ordered', 'packed', 'arrived'] as const;

export const ATTRS = { brand: 'acme', size: 'm', colour: 'red', quantity: '1', price: '20', merchant: 'northwind' };

/** A record document of the kind, agreeing with ATTRS unless `attrs` says otherwise. */
export function recordDoc(kind: RecordKind, orderId: Hex, attrs: Record<string, string> = ATTRS, extra: Record<string, CanonicalValue> = {}): Uint8Array {
  const base: Record<string, CanonicalValue> = { v: '1', kind: KEYS[kind], orderId };
  if (kind === 2) Object.assign(base, { approval: 'approved', approvalBasis: 'buyer' });
  else base.attrs = attrs;
  if (kind === 1) base.changes = [];
  if (kind === 3) base.x402TxId = 'settlement-1';
  return canonicalBytes({ ...base, ...extra });
}

export interface FakeMessage {
  seq: number;
  ts: string;
  bytes: Uint8Array;
  payer?: string;
  chunkTotal?: number;
  /** Account the transactions endpoint reports for this timestamp. */
  txAccount: string;
}

type Fault = { match: RegExp; mode: 503 | 429 | 'timeout' | 'html' | 404; times: number };

export interface Added {
  seq: number;
  cid: string;
  hash: Hex;
  doc: Uint8Array;
  ts: string;
}

export class World {
  messages: FakeMessage[] = [];
  gatewayDocs = new Map<string, Uint8Array>();
  logs: MirrorLog[] = [];
  faults: Fault[] = [];
  requests: string[] = [];
  /** The mirror shows only messages up to this sequence number (simulates ingestion lag). */
  visibleUpTo = Infinity;
  private logIndex = 0;
  private nextTs = 1_699_999_000;

  constructor(readonly clock: FakeClock) {}

  fail(match: RegExp, mode: Fault['mode'], times = 1): void {
    this.faults.push({ match, mode, times });
  }

  /** Raw message on the topic. */
  addMessage(m: { bytes: Uint8Array; payer?: string | null; ts?: string; chunkTotal?: number; txAccount?: string }): FakeMessage {
    const seq = this.messages.length + 1;
    const ts = m.ts ?? `${this.nextTs++}.000000001`;
    const msg: FakeMessage = {
      seq,
      ts,
      bytes: m.bytes,
      txAccount: m.txAccount ?? m.payer ?? AGENT_ACCOUNT,
    };
    if (m.payer !== null) msg.payer = m.payer ?? AGENT_ACCOUNT;
    if (m.chunkTotal !== undefined) msg.chunkTotal = m.chunkTotal;
    this.messages.push(msg);
    return msg;
  }

  /** A record: pins the document on the gateway and commits its message. */
  addRecord(o: {
    kind: RecordKind;
    orderId: Hex;
    doc?: Uint8Array;
    payer?: string | null;
    ts?: string;
    msgKind?: RecordKind;
    msgOrderId?: Hex;
    txAccount?: string;
  }): Added {
    const doc = o.doc ?? recordDoc(o.kind, o.orderId);
    const cid = rawBlockCid(doc);
    this.gatewayDocs.set(cid, doc);
    const hash = recordHash(doc);
    const bytes = encodeRecordMsg({ cid, hash, kind: o.msgKind ?? o.kind, orderId: o.msgOrderId ?? o.orderId });
    const defaultPayer = o.kind === 4 ? SHOP_ACCOUNT : AGENT_ACCOUNT;
    const m = this.addMessage({ bytes, payer: o.payer === undefined ? defaultPayer : o.payer, ts: o.ts, txAccount: o.txAccount });
    return { seq: m.seq, cid, hash, doc, ts: m.ts };
  }

  /** All six records of an order, agreeing, in order. */
  addOrder(orderId: Hex, docs: Partial<Record<RecordKind, Uint8Array>> = {}): Added[] {
    return KINDS.map((kind) => this.addRecord({ kind, orderId, doc: docs[kind] }));
  }

  addLog(address: Address, topics: Hex[], data: Hex, ts: string): void {
    this.logs.push({
      address: address.toLowerCase() as Hex,
      data,
      index: this.logIndex++,
      topics,
      timestamp: ts,
      transactionHash: keccak256(`0x${this.logIndex.toString(16).padStart(2, '0')}`),
      blockNumber: 1,
    });
  }

  fileClaim(orderId: Hex, refs: RecordRefs, filedAt: bigint = FILED_AT): Hex {
    const claimId = keccak256(orderId);
    const item = getAbiItem({ abi: claimsAbi, name: 'ClaimFiled' });
    const topics = encodeEventTopics({
      abi: claimsAbi,
      eventName: 'ClaimFiled',
      args: { claimId, shop: PARTIES[1]!.evmAddress, platform: PARTIES[0]!.evmAddress },
    });
    const data = encodeAbiParameters(
      item.inputs.filter((i) => !('indexed' in i && i.indexed)),
      [orderId, refs, 100_000_000n, 40_000_000n, filedAt],
    );
    this.addLog(CLAIMS, topics.filter((t): t is Hex => t !== null) as Hex[], data, `${filedAt}.500000000`);
    return claimId;
  }

  preCheckRecorded(claimId: Hex, gap: number, answer: number, packHash: Hex, ts: string): void {
    const topics = encodeEventTopics({ abi: claimsAbi, eventName: 'PreCheckRecorded', args: { claimId } });
    const item = getAbiItem({ abi: claimsAbi, name: 'PreCheckRecorded' });
    const data = encodeAbiParameters(
      item.inputs.filter((i) => !('indexed' in i && i.indexed)),
      [gap, answer, packHash],
    );
    this.addLog(CLAIMS, topics.filter((t): t is Hex => t !== null) as Hex[], data, ts);
  }

  private reply(body: unknown, status = 200): Response {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }

  private rawMessage(m: FakeMessage) {
    return {
      consensus_timestamp: m.ts,
      message: Buffer.from(m.bytes).toString('base64'),
      ...(m.payer === undefined ? {} : { payer_account_id: m.payer }),
      sequence_number: m.seq,
      topic_id: TOPIC_ID,
      chunk_info: m.chunkTotal === undefined ? null : { total: m.chunkTotal, initial_transaction_id: { account_id: m.txAccount } },
    };
  }

  private visible(): FakeMessage[] {
    return this.messages.filter((m) => m.seq <= this.visibleUpTo);
  }

  fetch = async (input: string): Promise<Response> => {
    this.requests.push(input);
    const fault = this.faults.find((f) => f.times > 0 && f.match.test(input));
    if (fault !== undefined) {
      fault.times -= 1;
      if (fault.mode === 'timeout') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (fault.mode === 'html') return this.reply('<html>gateway error</html>');
      return this.reply('', fault.mode);
    }
    const url = new URL(input);
    const p = url.pathname;
    if (url.origin === GATEWAY) {
      const doc = this.gatewayDocs.get(p.replace('/ipfs/', ''));
      return doc === undefined ? this.reply('', 404) : new Response(new Uint8Array(doc).buffer, { status: 200 });
    }
    let m: RegExpExecArray | null;
    if ((m = /^\/api\/v1\/topics\/[^/]+\/messages\/(\d+)$/.exec(p))) {
      const found = this.visible().find((x) => x.seq === Number(m![1]));
      return found === undefined ? this.reply('', 404) : this.reply(this.rawMessage(found));
    }
    if (/^\/api\/v1\/topics\/[^/]+\/messages$/.test(p)) {
      const vis = this.visible();
      if (url.searchParams.get('order') === 'desc') {
        const last = vis[vis.length - 1];
        return this.reply({ messages: last === undefined ? [] : [this.rawMessage(last)], links: { next: null } });
      }
      const from = Number((url.searchParams.get('sequencenumber') ?? 'gte:1').replace('gte:', ''));
      const limit = Number(url.searchParams.get('limit') ?? '100');
      const rest = vis.filter((x) => x.seq >= from);
      const page = rest.slice(0, limit);
      const next = rest.length > limit ? `/api/v1/topics/x/messages?sequencenumber=gte:${from + limit}` : null;
      return this.reply({ messages: page.map((x) => this.rawMessage(x)), links: { next } });
    }
    if (/^\/api\/v1\/contracts\/[^/]+\/results\/logs$/.test(p)) {
      const from = (url.searchParams.get('timestamp') ?? 'gte:0').replace('gte:', '');
      const logs = this.logs
        .filter((l) => compareTs(l.timestamp, from) >= 0)
        .sort((a, b) => compareTs(a.timestamp, b.timestamp) || a.index - b.index)
        .map((l) => ({
          address: l.address,
          data: l.data,
          index: l.index,
          topics: l.topics,
          timestamp: l.timestamp,
          transaction_hash: l.transactionHash,
          block_number: l.blockNumber,
        }));
      return this.reply({ logs, links: { next: null } });
    }
    if (p === '/api/v1/transactions') {
      const ts = url.searchParams.get('timestamp');
      const found = this.messages.find((x) => x.ts === ts);
      return this.reply({ transactions: found === undefined ? [] : [{ transaction_id: `${found.txAccount}-1700000000-123456789` }] });
    }
    if (p === '/api/v1/blocks') {
      return this.reply({ blocks: [{ timestamp: { to: `${Math.floor(this.clock.now() / 1000)}.000000000` } }] });
    }
    return this.reply('', 404);
  };

  mirror(): MirrorClient {
    return new MirrorClient({ baseUrl: MIRROR, fetch: this.fetch });
  }
}

export function refsOf(topicNum: bigint, named: Partial<Record<RecordKind, { seq: number; hash: Hex }>>): RecordRefs {
  const seq = [0n, 0n, 0n, 0n, 0n, 0n] as [bigint, bigint, bigint, bigint, bigint, bigint];
  const hashes = [ZERO_HASH, ZERO_HASH, ZERO_HASH, ZERO_HASH, ZERO_HASH, ZERO_HASH] as [Hex, Hex, Hex, Hex, Hex, Hex];
  for (const k of KINDS) {
    const n = named[k];
    if (n !== undefined) {
      seq[k] = BigInt(n.seq);
      hashes[k] = n.hash;
    }
  }
  return { topicNum, seq, hashes };
}

/** Refs naming every record in `added` (indexed by kind). */
export function refsFor(added: readonly Added[], topicNum = 500n, skip: readonly RecordKind[] = []): RecordRefs {
  const named: Partial<Record<RecordKind, { seq: number; hash: Hex }>> = {};
  for (const k of KINDS) {
    const a = added[k];
    if (a !== undefined && !skip.includes(k)) named[k] = { seq: a.seq, hash: a.hash };
  }
  return refsOf(topicNum, named);
}

export function orderIdOf(n: number): Hex {
  return keccak256(`0x${n.toString(16).padStart(2, '0')}`);
}

export function config(stateDir: string, over: Partial<PrecheckConfig> = {}): PrecheckConfig {
  return {
    rpcUrls: ['http://127.0.0.1:1'],
    mirrorUrl: MIRROR,
    gatewayUrl: GATEWAY,
    topicId: TOPIC_ID,
    topicNum: 500n,
    alertUrl: undefined,
    stateDir,
    port: 0,
    quietS: 120,
    pauseWindows: [],
    claimsAddress: CLAIMS,
    startTimestamp: '1699999000.000000000',
    tickMs: 15_000,
    ...over,
  };
}

export class FakeChain implements ClaimsChain {
  claims = new Map<string, { status: number; packHash: Hex }>();
  reads = 0;
  failReads = false;
  async getClaim(claimId: Hex) {
    this.reads += 1;
    if (this.failReads) throw new TransientError('rpc down');
    return this.claims.get(claimId) ?? { status: 0, packHash: ZERO_HASH };
  }
}

/** A node that mines on request: the mined transaction updates the fake chain and the fake mirror. */
export class FakeNode implements TxRpc {
  chainId = 296;
  mempool = new Map<Hex, { raw: Hex }>();
  mined = new Map<Hex, TxReceipt>();
  nonce_ = 0;
  broadcasts: Hex[] = [];
  revertCalls = false;
  block = 1n;
  constructor(
    private readonly world: World,
    private readonly chain: FakeChain,
  ) {}
  async call(): Promise<void> {
    if (this.revertCalls) throw new RevertError('0xdeadbeef');
  }
  async estimateGas(): Promise<bigint> {
    return 100_000n;
  }
  async fees(): Promise<FeeFields> {
    return { type: 'eip1559', maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
  }
  async nonce(): Promise<number> {
    return this.nonce_;
  }
  async sendRaw(raw: Hex): Promise<Hex> {
    this.broadcasts.push(raw);
    const hash = keccak256(raw);
    this.mempool.set(hash, { raw });
    return hash;
  }
  async receipt(hash: Hex): Promise<TxReceipt | null> {
    return this.mined.get(hash) ?? null;
  }
  async known(hash: Hex): Promise<boolean> {
    return this.mempool.has(hash) || this.mined.has(hash);
  }
  /** Mines every pending transaction; each recordPreCheck lands on the fake chain and mirror. */
  mine(): void {
    for (const [hash, tx] of this.mempool) {
      const parsed = parseTransaction(tx.raw);
      const call = decodeFunctionData({ abi: claimsAbi, data: parsed.data ?? '0x' });
      if (call.functionName === 'recordPreCheck') {
        const [claimId, gap, answer, packHash] = call.args;
        this.chain.claims.set(claimId, { status: 2, packHash });
        this.world.preCheckRecorded(claimId, gap, answer, packHash, `${Math.floor(this.world.clock.now() / 1000)}.000000001`);
      }
      this.mined.set(hash, { status: 'success', blockNumber: this.block++ });
      this.nonce_ = (parsed.nonce ?? 0) + 1;
    }
    this.mempool.clear();
  }
}

export interface Rig {
  dir: string;
  clock: FakeClock;
  world: World;
  chain: FakeChain;
  node: FakeNode;
  docs: LocalDocStore;
  docsDir: string;
  signerAddress: Address;
  signer: { address: Address; signTransaction(tx: Record<string, unknown>): Promise<Hex> };
  cleanup(): void;
  /** A service over this rig's state directory; call again after `close()` to model a restart. */
  start(over?: Omit<Partial<ServiceDeps>, 'config'> & { config?: Partial<PrecheckConfig> }): Promise<PrecheckService>;
}

const rigs: Rig[] = [];

export function cleanupRigs(): void {
  for (const r of rigs.splice(0)) r.cleanup();
}

/** Gateway reads go through the fake fetch; pins land in a local directory the fake gateway also serves. */
export function makeRig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'precheck-state-'));
  const docsDir = mkdtempSync(join(tmpdir(), 'precheck-docs-'));
  const clock = new FakeClock(Number(FILED_AT + 30n) * 1000);
  const world = new World(clock);
  const chain = new FakeChain();
  const node = new FakeNode(world, chain);
  const docs = new LocalDocStore(docsDir);
  const account = privateKeyToAccount(generatePrivateKey());
  const signer = { address: account.address, signTransaction: (tx: Record<string, unknown>) => account.signTransaction(tx as never) };
  const rig: Rig = {
    dir,
    clock,
    world,
    chain,
    node,
    docs,
    docsDir,
    signerAddress: account.address,
    signer,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
      rmSync(docsDir, { recursive: true, force: true });
    },
    start(over = {}) {
      const { config: cfgOver, ...rest } = over;
      return PrecheckService.create({
        config: config(dir, cfgOver),
        parties: PARTIES,
        mirror: world.mirror(),
        docs: gatewayBackedDocs(world, docs),
        chain,
        rpc: node,
        signer,
        from: account.address,
        clock,
        fetch: world.fetch,
        senderOptions: { receiptWaitMs: 0, receiptPollMs: 0, sleep: async () => undefined },
        ...rest,
      });
    },
  };
  rigs.push(rig);
  return rig;
}

/**
 * Reads come from the fake gateway through the real gateway client; pins go to the local store
 * and are mirrored onto the fake gateway, as a real pin makes the document readable there.
 */
export function gatewayBackedDocs(world: World, local: LocalDocStore): DocStore {
  const store = new GatewayDocStore({ gatewayUrl: GATEWAY, fetch: world.fetch });
  return {
    fetch: (cid, options) => store.fetch(cid, options),
    async pin(bytes) {
      const cid = await local.pin(bytes);
      world.gatewayDocs.set(cid, bytes);
      return cid;
    },
  };
}

/** The proof layer on its own: a topic index over the fake mirror and the ports it needs. */
export async function proofKit(rig: Rig, over: { quietS?: number } = {}) {
  const index = TopicIndex.open({ mirror: rig.world.mirror(), topicId: TOPIC_ID, dir: rig.dir, clock: rig.clock });
  const ports: ProofPorts = {
    index,
    mirror: rig.world.mirror(),
    docs: gatewayBackedDocs(rig.world, rig.docs),
    parties: PARTIES,
    topicNum: 500n,
    quietS: over.quietS ?? 120,
    clock: rig.clock,
    suspects: new Map(),
  };
  return { index, ports };
}

/** A message past the filing, so the index counts as read through it. */
export function addLaterMessage(world: World, filedAt: bigint = FILED_AT): void {
  world.addMessage({ bytes: new TextEncoder().encode('{}'), ts: `${filedAt + 5n}.000000000` });
}

export function proofClaim(orderId: Hex, refs: RecordRefs, filedAt: bigint = FILED_AT): ProofClaim {
  return { claimId: keccak256(orderId), orderId, filedAt, refs };
}

export interface SetupOptions {
  orderId?: Hex;
  /** Kinds not written to the topic at all. */
  omit?: readonly RecordKind[];
  /** Kinds written but left out of the claim's refs. */
  refsSkip?: readonly RecordKind[];
  /** Documents to use instead of the default agreeing ones. */
  docs?: Partial<Record<RecordKind, Uint8Array>>;
  /** Write a message after the filing so the index can read through it. */
  later?: boolean;
}

/** Writes an order's records, files the claim and marks it Filed on the fake chain. */
export function setupClaim(rig: Rig, o: SetupOptions = {}) {
  const orderId = o.orderId ?? orderIdOf(1);
  const added = KINDS.map((kind) =>
    o.omit?.includes(kind) ? undefined : rig.world.addRecord({ kind, orderId, doc: o.docs?.[kind] }),
  );
  const named: Partial<Record<RecordKind, { seq: number; hash: Hex }>> = {};
  for (const k of KINDS) {
    const a = added[k];
    if (a !== undefined && !o.refsSkip?.includes(k)) named[k] = { seq: a.seq, hash: a.hash };
  }
  const refs = refsOf(500n, named);
  if (o.later === true) addLaterMessage(rig.world);
  const claimId = rig.world.fileClaim(orderId, refs);
  rig.chain.claims.set(claimId, { status: 1, packHash: ZERO_HASH });
  return { orderId, claimId, added, refs };
}

export function journalRecords(rig: Rig) {
  return replayJournal(rig.dir).records;
}

export function alertKinds(rig: Rig): string[] {
  return journalRecords(rig)
    .filter((r) => r.t === 'alert')
    .map((r) => String(r.kind));
}
