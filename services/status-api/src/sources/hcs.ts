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

export async function pollHcs(store: Store, d: MirrorDeps, topic: string): Promise<void> {
  const st = store.status.hcs;
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
        if (r.ok) {
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
  }
}
