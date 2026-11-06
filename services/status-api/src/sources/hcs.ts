// HCS reader: record messages from the mirror node topic endpoint.

import { decodeRecordMsg } from '@recourse/shared';
import { getJson, safeError } from '../http.js';
import type { Store } from '../store.js';
import type { HcsRecord } from '../types.js';
import { mirrorHeadSeconds, type MirrorDeps } from './hedera.js';

interface TopicMessage {
  consensus_timestamp: string;
  message: string;
  payer_account_id: string;
  sequence_number: number;
}

const MAX_PAGES_PER_POLL = 40;
/** Messages kept from payers that are not configured writers of their kind (the topic is open). */
export const MAX_FOREIGN_RECORDS = 2000;

export interface HcsOptions {
  /**
   * Whether a payer is a configured writer of a kind: true, false, or null when the parties are
   * not known (then the message is kept). Leave out to keep every message.
   */
  isWriter?: (kind: number, payer: string) => boolean | null;
  maxForeign?: number;
}

/**
 * Messages in the store from known non-writers: counted over the whole store once the parties are
 * known, then kept up to date. Absent while the parties are unknown, since messages kept then
 * could not be told apart and the count would start low.
 */
const foreignKept = new WeakMap<Store, number>();

/** The stored foreign-message count, counted now if needed; null while the parties are unknown. */
function foreignCount(store: Store, isWriter: (kind: number, payer: string) => boolean | null): number | null {
  const known = foreignKept.get(store);
  if (known !== undefined) return known;
  let n = 0;
  for (const r of store.hcs.values()) {
    const w = isWriter(r.kind, r.payer);
    if (w === null) return null;
    if (w === false) n++;
  }
  foreignKept.set(store, n);
  return n;
}

export async function pollHcs(store: Store, d: MirrorDeps, topic: string, opts: HcsOptions = {}): Promise<void> {
  const st = store.status.hcs;
  const isWriter = opts.isWriter;
  const maxForeign = opts.maxForeign ?? MAX_FOREIGN_RECORDS;
  const counted = isWriter ? foreignCount(store, isWriter) : null;
  // Within this poll; written back only when every message's payer could be judged.
  let kept = counted ?? 0;
  let unknown = counted === null;
  const head = await mirrorHeadSeconds(d);
  try {
    // gte:<seq+1>, not gt:<seq>: the mirror refuses a sequencenumber filter of 0 with a 400
    // ("Invalid parameter: sequencenumber"), and a fresh store starts at seq 0.
    let url: string | null =
      `${d.baseUrl}/api/v1/topics/${topic}/messages?order=asc&limit=100&sequencenumber=gte:${store.cursors.hcs.seq + 1}`;
    let pages = 0;
    let through = false;
    while (url !== null) {
      if (pages++ >= MAX_PAGES_PER_POLL) break;
      const j = (await getJson(d.fetch, url, d.timeoutMs)) as { messages?: TopicMessage[]; links?: { next?: string | null } };
      const records: HcsRecord[] = [];
      for (const m of j.messages ?? []) {
        if (m.sequence_number <= store.cursors.hcs.seq) continue;
        const bytes = Uint8Array.from(Buffer.from(m.message, 'base64'));
        const r = decodeRecordMsg(bytes);
        // Anyone can post to the topic: messages from payers that are not writers of their kind
        // are only ever shown as "wrong payer", so past a cap they are counted and dropped.
        const writer = r.ok && isWriter !== undefined ? isWriter(r.value.kind, m.payer_account_id) : true;
        if (writer === null) unknown = true;
        const foreign = writer === false;
        if (foreign && kept >= maxForeign) {
          st.foreignDropped++;
        } else if (r.ok) {
          if (foreign) kept++;
          records.push({
            topic,
            seq: m.sequence_number,
            consensusTimestamp: m.consensus_timestamp,
            payer: m.payer_account_id,
            kind: r.value.kind,
            orderId: r.value.orderId,
            hash: r.value.hash,
            cid: r.value.cid,
          });
        } else {
          st.decodeFailures++;
        }
        store.cursors.hcs.seq = m.sequence_number;
      }
      store.addHcs(records);
      const next = j.links?.next;
      url = next ? (next.startsWith('http') ? next : `${d.baseUrl}${next}`) : null;
      if (url === null) through = true;
    }
    st.cursor = String(store.cursors.hcs.seq);
    if (through) st.indexedThrough = head;
    st.failing = false;
    st.lastOkAt = d.nowS();
  } catch (e) {
    st.failing = true;
    st.lastError = safeError(e);
    st.lastErrorAt = d.nowS();
  } finally {
    if (isWriter) {
      if (unknown) foreignKept.delete(store);
      else foreignKept.set(store, kept);
    }
  }
}
