import { describe, expect, it } from 'vitest';
import { keccak256, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { JournalRecord } from '../src/journal.js';
import { RevertError, Sender, type FeeFields, type TxReceipt, type TxRpc } from '../src/sender.js';
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
  async sendRaw(raw: Hex): Promise<Hex> {
    if (this.failBroadcasts) throw new TransientError('network error');
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
