import type { Address } from 'viem';
import type { ArbLogRow, ArbRpc } from '../../src/sources/arbitrum.js';
import type { SimLog } from './encode.js';

/** An Arbitrum node in memory: a head, block times of one second, and logs placed at blocks. */
export class FakeArb implements ArbRpc {
  head = 5000n;
  finalized: bigint | null = null;
  fail = false;
  rows: ArbLogRow[] = [];
  queries: { from: bigint; to: bigint }[] = [];
  constructor(public t0 = 1_700_000_000n) {}

  place(logs: SimLog[], address: Address): void {
    for (const l of logs) {
      if (l.chain !== 'arbitrum') continue;
      this.rows.push({ address, topics: l.raw.topics, data: l.raw.data, transactionHash: l.raw.tx, logIndex: l.raw.logIndex, blockNumber: l.raw.block! });
    }
  }
  async blockNumber() {
    if (this.fail) throw new Error('rpc down');
    return this.head;
  }
  async blockTime(n: bigint) {
    // Logs carry their own time in the sim; blocks without logs use the base clock.
    const row = this.rows.find((r) => r.blockNumber === n);
    void row;
    return this.t0 + n;
  }
  async finalizedBlock() {
    return this.finalized;
  }
  async logs(a: { address: Address; fromBlock: bigint; toBlock: bigint; topics?: unknown[] }) {
    if (this.fail) throw new Error('rpc down');
    this.queries.push({ from: a.fromBlock, to: a.toBlock });
    return this.rows.filter((r) => r.address === a.address && r.blockNumber >= a.fromBlock && r.blockNumber <= a.toBlock && (!a.topics || a.topics.length === 0 || r.topics[0] === a.topics[0]) && (a.topics?.[1] === undefined || r.topics[1] === a.topics[1]));
  }
}
