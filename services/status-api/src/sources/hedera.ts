// Hedera reader: contract logs from the mirror node, one cursor per contract.

import type { Address, Hex } from 'viem';
import { decodeLog, padTimestamp, secondsOf } from '../decode.js';
import { getJson, safeError, type FetchLike } from '../http.js';
import type { HederaCursor, Store } from '../store.js';
import type { ContractName, RawLog } from '../types.js';

export interface MirrorDeps {
  fetch: FetchLike;
  baseUrl: string;
  timeoutMs: number;
  /** Seconds since epoch; injectable for tests. */
  nowS: () => number;
}

interface MirrorLogRow {
  address: string;
  data: string;
  index: number;
  topics: string[];
  timestamp: string;
  transaction_hash: string;
  block_number?: number;
}

const MAX_PAGES_PER_POLL = 40;

/** Consensus time of the mirror's newest block, as unix seconds; falls back to the clock. */
export async function mirrorHeadSeconds(d: MirrorDeps): Promise<number> {
  try {
    const j = (await getJson(d.fetch, `${d.baseUrl}/api/v1/blocks?limit=1&order=desc`, d.timeoutMs)) as {
      blocks?: { timestamp?: { to?: string } }[];
    };
    const to = j.blocks?.[0]?.timestamp?.to;
    if (to) return Number(secondsOf(to));
  } catch {
    // the clock is the best head estimate when the blocks endpoint is unavailable
  }
  return d.nowS();
}

function after(row: { timestamp: string; index: number }, c: HederaCursor | undefined): boolean {
  if (!c) return true;
  const a = padTimestamp(row.timestamp);
  const b = padTimestamp(c.timestamp);
  return a > b || (a === b && row.index > c.index);
}

export interface HederaPollResult {
  added: number;
  decodeFailures: number;
  throughHead: boolean;
}

/**
 * Reads new logs of one contract. Pages are followed with `links.next`; the query starts at the
 * cursor timestamp inclusive and rows at or before the cursor are skipped, so logs that share a
 * timestamp across a page boundary are neither lost nor repeated.
 */
export async function pollHederaContract(
  store: Store,
  d: MirrorDeps,
  contract: Exclude<ContractName, 'case'>,
  address: Address,
  startTimestamp?: string,
): Promise<HederaPollResult> {
  const key = address.toLowerCase();
  const cursor = store.cursors.hedera[key];
  const from = cursor?.timestamp ?? startTimestamp ?? '0.000000000';
  let url: string | null =
    `${d.baseUrl}/api/v1/contracts/${address}/results/logs?order=asc&limit=100&timestamp=gte:${from}`;
  let added = 0;
  let failures = 0;
  let pages = 0;
  let throughHead = false;
  let running: HederaCursor | undefined = cursor;
  while (url !== null) {
    if (pages++ >= MAX_PAGES_PER_POLL) break;
    const j = (await getJson(d.fetch, url, d.timeoutMs)) as { logs?: MirrorLogRow[]; links?: { next?: string | null } };
    const rows = j.logs ?? [];
    const events = [];
    for (const row of rows) {
      if (!after(row, running)) continue;
      const raw: RawLog = {
        address,
        topics: row.topics as Hex[],
        data: row.data as Hex,
        tx: row.transaction_hash as Hex,
        logIndex: row.index,
        time: secondsOf(row.timestamp),
        order: `${padTimestamp(row.timestamp)}:${String(row.index).padStart(6, '0')}`,
      };
      const ev = decodeLog('hedera', contract, raw);
      if (ev) events.push(ev);
      else failures++;
      running = { timestamp: row.timestamp, index: row.index };
    }
    added += store.addEvents(events);
    if (running) store.cursors.hedera[key] = running;
    const next = j.links?.next;
    url = next ? (next.startsWith('http') ? next : `${d.baseUrl}${next}`) : null;
    if (url === null) throughHead = true;
  }
  return { added, decodeFailures: failures, throughHead };
}

/** Polls both Hedera contracts and records the outcome on the store's source status. */
export async function pollHedera(
  store: Store,
  d: MirrorDeps,
  contracts: { claims?: Address; vault?: Address },
  startTimestamp?: string,
): Promise<void> {
  const st = store.status.hedera;
  const head = await mirrorHeadSeconds(d);
  try {
    let through = true;
    for (const [name, address] of [
      ['claims', contracts.claims],
      ['vault', contracts.vault],
    ] as const) {
      if (!address) continue;
      const r = await pollHederaContract(store, d, name, address, startTimestamp);
      st.decodeFailures += r.decodeFailures;
      through = through && r.throughHead;
    }
    const latest = Object.values(store.cursors.hedera).map((c) => padTimestamp(c.timestamp)).sort().pop();
    st.cursor = latest ? latest.replace(/^0+/, '') : '';
    if (through) st.indexedThrough = head;
    st.failing = false;
    st.lastOkAt = d.nowS();
  } catch (e) {
    st.failing = true;
    st.lastError = safeError(e);
    st.lastErrorAt = d.nowS();
  }
}
