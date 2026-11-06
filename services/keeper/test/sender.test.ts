import { describe, expect, it } from 'vitest';
import { keccak256, type Address, type Hex, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { JournalRecord } from '../src/journal.js';
import { viemTxRpc } from '../src/rpc.js';
import { BroadcastRejected, RevertError, Sender, rejectionReason, type FeeFields, type TxReceipt, type TxRpc } from '../src/sender.js';
import { TransientError } from '../src/net.js';

/** A tiny in-memory node: broadcasts land in a mempool and are mined on `mine()`. */
class FakeNode implements TxRpc {
  chainId = 31337;
  mempool = new Map<Hex, { raw: Hex; from: Address; nonce: number }>();
  mined = new Map<Hex, TxReceipt>();
  nonces = new Map<string, number>();
  dropBroadcasts = false;
  failBroadcasts = false;
  broadcasts: Hex[] = [];
  refusals = 0;
  revertWith: Hex | undefined;
  block = 1n;
  constructor(private readonly nonceOf: (raw: Hex) => { from: Address; nonce: number }) {}
  async call(): Promise<void> {
    if (this.revertWith !== undefined) throw new RevertError(this.revertWith);
  }
  async estimateGas(): Promise<bigint> {
    return 100_000n;
  }
  async fees(): Promise<FeeFields> {
    return { type: 'eip1559', maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
  }
  async nonce(address: Address): Promise<number> {
    return this.nonces.get(address.toLowerCase()) ?? 0;
  }
  /** The node refuses every broadcast with this text (a definite answer, not a transport failure). */
  refuseWith: string | undefined;
  async sendRaw(raw: Hex): Promise<Hex> {
    if (this.failBroadcasts) throw new TransientError('network error');
    if (this.refuseWith !== undefined) {
      this.refusals += 1;
      throw new Error(this.refuseWith);
    }
    this.broadcasts.push(raw);
    const hash = keccak256(raw);
    if (!this.dropBroadcasts) this.mempool.set(hash, { raw, ...this.nonceOf(raw) });
    return hash;
  }
  async receipt(hash: Hex): Promise<TxReceipt | null> {
    return this.mined.get(hash) ?? null;
  }
  async known(hash: Hex): Promise<boolean> {
    return this.mempool.has(hash) || this.mined.has(hash);
  }
  mine(): void {
    for (const [hash, tx] of this.mempool) {
      this.mined.set(hash, { status: 'success', blockNumber: this.block++ });
      this.nonces.set(tx.from.toLowerCase(), tx.nonce + 1);
    }
    this.mempool.clear();
  }
  /** Another tool sends with the same key and takes the nonce. */
  useNonce(address: Address): void {
    this.nonces.set(address.toLowerCase(), (this.nonces.get(address.toLowerCase()) ?? 0) + 1);
  }
}

function setup() {
  const account = privateKeyToAccount(generatePrivateKey());
  const signed = new Map<Hex, number>();
  const signer = {
    address: account.address,
    async signTransaction(tx: Record<string, unknown>): Promise<Hex> {
      const raw = await account.signTransaction(tx as never);
      signed.set(raw, Number(tx.nonce));
      return raw;
    },
  };
  const node = new FakeNode((raw) => ({ from: account.address, nonce: signed.get(raw) ?? -1 }));
  const journal: JournalRecord[] = [];
  const make = (extra: Partial<ConstructorParameters<typeof Sender>[0]> = {}) =>
    new Sender({
      chain: 'arbitrum',
      rpc: node,
      signer,
      from: account.address,
      append: (r) => journal.push(JSON.parse(JSON.stringify(r)) as JournalRecord),
      receiptWaitMs: 0,
      receiptPollMs: 0,
      sleep: async () => undefined,
      ...extra,
    });
  const req = { to: '0x00000000000000000000000000000000000000aa' as Address, data: '0x1234' as Hex, call: 'settle' };
  return { node, journal, make, req, account };
}

describe('sender', () => {
  it('a simulated revert sends nothing and journals nothing', async () => {
    const { node, journal, make, req } = setup();
    node.revertWith = '0xdeadbeef';
    const out = await make().send(req);
    expect(out).toEqual({ kind: 'rejected', revertData: '0xdeadbeef', message: 'execution reverted' });
    expect(journal).toEqual([]);
    expect(node.broadcasts).toEqual([]);
  });

  it('journals the intent before broadcast and the result after the receipt', async () => {
    const { node, journal, make, req } = setup();
    const s = make({ receiptWaitMs: 1_000 });
    const origSend = node.sendRaw.bind(node);
    node.sendRaw = async (raw) => {
      expect(journal.map((r) => r.t)).toEqual(['intent']);
      const h = await origSend(raw);
      node.mine();
      return h;
    };
    const out = await s.send(req);
    expect(out.kind).toBe('mined');
    expect(journal.map((r) => r.t)).toEqual(['intent', 'result']);
    expect(journal[0]!.raw).toBe(node.broadcasts[0]);
    expect(s.openIntents()).toEqual([]);
  });

  it('is busy while one of its transactions is open', async () => {
    const { make, req } = setup();
    const s = make();
    expect((await s.send(req)).kind).toBe('pending');
    expect(await s.send(req)).toEqual({ kind: 'busy' });
  });

  it('crash after the intent, before broadcast: rebroadcasts the same bytes once, no second transaction', async () => {
    const { node, journal, make, req } = setup();
    const crashing = make({
      onIntent: () => {
        throw new Error('crash');
      },
    });
    await expect(crashing.send(req)).rejects.toThrow('crash');
    expect(node.broadcasts).toEqual([]);
    const restarted = make();
    restarted.load(journal);
    expect(restarted.openIntents()).toHaveLength(1);
    await restarted.resolveOpen();
    expect(node.broadcasts).toEqual([journal[0]!.raw]);
    node.mine();
    const done = await restarted.resolveOpen();
    expect(done.map((d) => d.outcome.kind)).toEqual(['mined']);
    expect(node.mined.size).toBe(1);
    expect(journal.filter((r) => r.t === 'result')).toHaveLength(1);
  });

  it('crash after broadcast, before the result: finds the receipt and does not resend', async () => {
    const { node, journal, make, req } = setup();
    await make().send(req); // receipt wait 0: returns pending, no result journaled
    node.mine();
    const restarted = make();
    restarted.load(journal);
    const done = await restarted.resolveOpen();
    expect(done.map((d) => d.outcome.kind)).toEqual(['mined']);
    expect(node.broadcasts).toHaveLength(1);
  });

  it('a pending transaction the node still knows is left alone', async () => {
    const { node, journal, make, req } = setup();
    await make().send(req);
    const restarted = make();
    restarted.load(journal);
    expect(await restarted.resolveOpen()).toEqual([]);
    expect(node.broadcasts).toHaveLength(1);
  });

  it('a dropped transaction whose nonce another sender used is superseded', async () => {
    const { node, journal, make, req, account } = setup();
    node.dropBroadcasts = true;
    await make().send(req);
    node.useNonce(account.address);
    const restarted = make();
    restarted.load(journal);
    const done = await restarted.resolveOpen();
    expect(done.map((d) => d.outcome.kind)).toEqual(['superseded']);
    expect(journal.at(-1)).toMatchObject({ t: 'result', outcome: 'superseded' });
  });

  it('a failed broadcast leaves the intent open and a later resolve rebroadcasts it', async () => {
    const { node, make, req } = setup();
    node.failBroadcasts = true;
    const s = make();
    expect((await s.send(req)).kind).toBe('pending');
    node.failBroadcasts = false;
    await s.resolveOpen();
    expect(node.broadcasts).toHaveLength(1);
  });

  it('without dropRejected (the pre-check) a refused intent stays open and the key stays busy', async () => {
    const { node, make, req } = setup();
    node.refuseWith = 'insufficient funds for gas * price + value';
    const s = make();
    expect((await s.send(req)).kind).toBe('pending');
    for (let i = 0; i < 50; i++) await s.resolveOpen();
    expect(s.openIntents()).toHaveLength(1);
    expect(await s.send(req)).toEqual({ kind: 'busy' });
    expect(s.intentStatus()[0]).toMatchObject({ rejections: 51, reason: 'funds' });
  });

  it('a broadcast the node keeps refusing is dropped, the key is freed, and a lack of funds cools down', async () => {
    const { node, journal, make, req } = setup();
    let now = 1_000_000;
    node.refuseWith = 'insufficient funds for gas * price + value';
    const s = make({ dropRejected: { after: 3, minAgeMs: 60_000, fundsCooldownMs: 300_000 }, now: () => now });
    expect((await s.send(req)).kind).toBe('pending'); // refusal 1
    await s.resolveOpen(); // 2
    await s.resolveOpen(); // 3, but only 0 s old
    expect(s.openIntents()).toHaveLength(1);
    expect(s.intentStatus()[0]).toMatchObject({ rejections: 3, reason: 'funds', ageS: 0 });
    now += 60_000;
    const done = await s.resolveOpen();
    expect(done.map((d) => d.outcome)).toEqual([{ kind: 'dropped', id: journal[0]!.id, reason: 'funds' }]);
    expect(journal.at(-1)).toMatchObject({ t: 'result', outcome: 'dropped', reason: 'funds', id: journal[0]!.id });
    expect(s.openIntents()).toEqual([]);
    // Unfunded: nothing new is signed until the cooldown ends.
    expect(await s.send(req)).toEqual({ kind: 'busy' });
    expect(journal.filter((r) => r.t === 'intent')).toHaveLength(1);
    now += 300_000;
    node.refuseWith = undefined; // the key was funded
    expect((await s.send(req)).kind).toBe('pending');
    expect(journal.filter((r) => r.t === 'intent')).toHaveLength(2);
    expect(node.broadcasts).toHaveLength(1);
  });

  it('a fee the network outgrew is dropped without a cooldown, so the next send signs fresh fees at once', async () => {
    const { node, make, req } = setup();
    let now = 1_000_000;
    node.refuseWith = 'max fee per gas less than block base fee';
    const s = make({ dropRejected: { after: 2, minAgeMs: 0, fundsCooldownMs: 300_000 }, now: () => now });
    await s.send(req);
    const done = await s.resolveOpen();
    expect(done.map((d) => d.outcome.kind)).toEqual(['dropped']);
    node.refuseWith = undefined;
    now += 1;
    expect((await s.send(req)).kind).toBe('pending');
  });

  it('transport failures are not refusals: the intent is never dropped for them', async () => {
    const { node, make, req } = setup();
    let now = 1_000_000;
    node.failBroadcasts = true;
    const s = make({ dropRejected: { after: 2, minAgeMs: 0, fundsCooldownMs: 0 }, now: () => now });
    await s.send(req);
    for (let i = 0; i < 10; i++) {
      now += 60_000;
      await s.resolveOpen();
    }
    expect(s.openIntents()).toHaveLength(1);
    expect(s.intentStatus()[0]).toMatchObject({ rejections: 0, ageS: 600, lastError: 'network error' });
  });

  it('a nonce the network has used is never dropped: it is superseded as before', async () => {
    const { node, make, req, account } = setup();
    node.refuseWith = 'nonce too low';
    const s = make({ dropRejected: { after: 1, minAgeMs: 0, fundsCooldownMs: 0 } });
    await s.send(req);
    node.useNonce(account.address);
    const done = await s.resolveOpen();
    expect(done.map((d) => d.outcome.kind)).toEqual(['superseded']);
  });

  it('rebroadcasts nothing while the caller says no (paused or in a window), but still reads receipts', async () => {
    const { node, make, req } = setup();
    node.failBroadcasts = true;
    const s = make();
    await s.send(req);
    node.failBroadcasts = false;
    await s.resolveOpen({ rebroadcast: () => false });
    expect(node.broadcasts).toHaveLength(0);
    await s.resolveOpen({ rebroadcast: () => true });
    expect(node.broadcasts).toHaveLength(1);
    node.mine();
    expect((await s.resolveOpen({ rebroadcast: () => false })).map((d) => d.outcome.kind)).toEqual(['mined']);
  });

  it('dry run simulates and prints, never signs', async () => {
    const { node, journal, make, req } = setup();
    const lines: string[] = [];
    const s = make({ signer: undefined, log: (l) => lines.push(l) });
    expect(await s.send(req)).toEqual({ kind: 'dry' });
    expect(journal).toEqual([]);
    expect(node.broadcasts).toEqual([]);
    expect(lines[0]).toMatch(/would call settle/);
  });
});

describe('viemTxRpc broadcast errors', () => {
  const raw = '0x02f86c' as Hex;
  const rpcThrowing = (err: unknown) =>
    viemTxRpc({ chainId: 1, feeMode: 'legacy', client: { sendRawTransaction: async () => Promise.reject(err) } as unknown as PublicClient });

  it("reads the node's refusal from the error details, past viem's first line", async () => {
    const err = Object.assign(new Error('Missing or invalid parameters.\nDouble check you have provided the correct parameters.'), {
      details: 'insufficient funds for gas * price + value: balance 0',
    });
    const thrown = await rpcThrowing(err).sendRaw(raw).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(BroadcastRejected);
    expect(rejectionReason(thrown)).toBe('funds');
    expect((thrown as Error).message).toBe('insufficient funds for gas * price + value: balance 0');
  });

  it('a node that already has the transaction is a successful broadcast', async () => {
    const err = Object.assign(new Error('Internal error'), { details: 'already known' });
    expect(await rpcThrowing(err).sendRaw(raw)).toBe(keccak256(raw));
  });

  it('anything else stays a transport failure', async () => {
    const thrown = await rpcThrowing(new Error('fetch failed')).sendRaw(raw).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(TransientError);
    expect(rejectionReason(thrown)).toBeUndefined();
  });
});
