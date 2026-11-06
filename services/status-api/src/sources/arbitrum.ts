// Arbitrum reader: RecourseCase logs, kept at least `confirmations` blocks behind the head so a
// shallow reorg never reaches the store. (The free endpoints lag about 17 minutes at `finalized`,
// so the head minus a small depth is used instead.)

import type { Address, Hex } from 'viem';
import { evidenceAbi } from '../abi/outside.js';
import { decodeLog } from '../decode.js';
import { safeError } from '../http.js';
import type { Store } from '../store.js';
import type { RawLog } from '../types.js';
import { decodeEventLog, toEventSelector } from 'viem';
import { externalIdUint } from '@recourse/shared';

export interface ArbLogRow {
  address: Address;
  topics: Hex[];
  data: Hex;
  transactionHash: Hex;
  logIndex: number;
  blockNumber: bigint;
}

/** The slice of an Arbitrum RPC client the reader needs; viem and fakes both provide it. */
export interface ArbRpc {
  blockNumber(): Promise<bigint>;
  /** Unix seconds of a block. */
  blockTime(block: bigint): Promise<bigint>;
  finalizedBlock(): Promise<bigint | null>;
  logs(args: { address: Address; fromBlock: bigint; toBlock: bigint; topics?: (Hex | Hex[] | null)[] }): Promise<ArbLogRow[]>;
}

export interface ArbDeps {
  rpc: ArbRpc;
  confirmations: number;
  chunk: number;
  nowS: () => number;
}

export async function pollArbitrum(
  store: Store,
  d: ArbDeps,
  caseAddress: Address,
  startBlock: bigint,
): Promise<void> {
  const st = store.status.arbitrum;
  try {
    const head = await d.rpc.blockNumber();
    const to = head - BigInt(d.confirmations);
    let from = store.cursors.arbitrum.block ?? startBlock;
    const times = new Map<bigint, bigint>();
    const timeOf = async (b: bigint) => {
      let t = times.get(b);
      if (t === undefined) {
        t = await d.rpc.blockTime(b);
        times.set(b, t);
      }
      return t;
    };
    while (from <= to) {
      const chunkTo = from + BigInt(d.chunk) - 1n < to ? from + BigInt(d.chunk) - 1n : to;
      const rows = await d.rpc.logs({ address: caseAddress, fromBlock: from, toBlock: chunkTo });
      const events = [];
      for (const row of rows) {
        const raw: RawLog = {
          address: row.address,
          topics: row.topics,
          data: row.data,
          tx: row.transactionHash,
          logIndex: row.logIndex,
          time: await timeOf(row.blockNumber),
          order: `${row.blockNumber.toString().padStart(12, '0')}:${String(row.logIndex).padStart(6, '0')}`,
          block: row.blockNumber,
        };
        const ev = decodeLog('arbitrum', 'case', raw);
        if (ev) events.push(ev);
        else st.decodeFailures++;
      }
      store.addEvents(events);
      store.cursors.arbitrum.block = chunkTo + 1n;
      from = chunkTo + 1n;
    }
    st.cursor = String(store.cursors.arbitrum.block ?? '');
    st.headDistance = Number(head - (store.cursors.arbitrum.block ?? head));
    if (to >= 0n) st.indexedThrough = Number(await timeOf(to < 0n ? 0n : to));
    store.arbFinalized = await d.rpc.finalizedBlock().catch(() => null);
    st.failing = false;
    st.lastOkAt = d.nowS();
  } catch (e) {
    st.failing = true;
    st.lastError = safeError(e);
    st.lastErrorAt = d.nowS();
  }
}

/**
 * Evidence submitted to the EvidenceModule for this claim's court attempts. The module serves
 * every dispute on the chain, so the query filters on our external ids and starts at the block
 * where the case was opened. Read in ARB_LOG_CHUNK ranges, the cursor kept after each, as the case
 * logs are: an RPC that caps the range of eth_getLogs would otherwise refuse an older case's query.
 */
export async function pollEvidence(
  store: Store,
  d: ArbDeps,
  evidenceModule: Address,
  caseChainId: number,
  caseAddress: Address,
  claimId: Hex,
  attempt: 1 | 2,
  fromBlock: bigint,
): Promise<void> {
  const ext = externalIdUint(caseChainId, caseAddress, claimId, attempt);
  const key = ext.toString();
  const head = await d.rpc.blockNumber();
  const to = head - BigInt(d.confirmations);
  let from = store.evidenceCursor[key] ?? fromBlock;
  const topic = ('0x' + ext.toString(16).padStart(64, '0')) as Hex;
  // topics[0] is the event signature; build it from the ABI.
  const sig = toEventSelector(evidenceAbi[0]);
  while (from <= to) {
    const chunkTo = from + BigInt(d.chunk) - 1n < to ? from + BigInt(d.chunk) - 1n : to;
    const rows = await d.rpc.logs({ address: evidenceModule, fromBlock: from, toBlock: chunkTo, topics: [sig, topic] });
    const items = [];
    for (const row of rows) {
      try {
        const dec = decodeEventLog({ abi: evidenceAbi, topics: row.topics as [Hex], data: row.data });
        items.push({
          externalId: key,
          party: (dec.args as { _party: string })._party,
          uri: (dec.args as { _evidence: string })._evidence,
          tx: row.transactionHash,
          logIndex: row.logIndex,
          time: await d.rpc.blockTime(row.blockNumber),
        });
      } catch {
        store.status.arbitrum.decodeFailures++;
      }
    }
    store.addEvidence(items);
    store.evidenceCursor[key] = chunkTo + 1n;
    from = chunkTo + 1n;
  }
}
