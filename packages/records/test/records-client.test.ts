import { describe, expect, it } from 'vitest';
import {
  RECORD_MSG_MAX_BYTES,
  canonicalBytes,
  decodeRecordMsg,
  encodeRecordMsg,
  isCanonical,
  recordHash,
  ruleSlotFromDoc,
  utf8ToBytes,
  type RecordKind,
} from '@recourse/shared';
import { cidOfHash } from '../src/car.js';
import { readJournal } from '../src/journal.js';
import type { RecordsJournalRow } from '../src/records-client.js';
import type { SendFault } from '../src/testing.js';
import { AGENT_PAYER, ORDER, OTHER_ORDER, PARTIES, TOPIC, doc, harness, type Harness } from './helpers.js';

const AGENT_KINDS: RecordKind[] = [0, 1, 2, 3, 5];

function ownMessages(h: Harness, kind: RecordKind, orderId = ORDER) {
  return h.ledger
    .messages(TOPIC)
    .map((m) => ({ m, d: decodeRecordMsg(m.bytes) }))
    .filter(({ m, d }) => d.ok && d.value.kind === kind && d.value.orderId === orderId && m.payer === AGENT_PAYER);
}

describe('records client: commits', () => {
  it('commits each agent record once, with messages and documents in the shared formats', async () => {
    const h = harness();
    const { client, reader } = h.open();
    for (const kind of AGENT_KINDS) {
      const committed = await client.commitRecord(kind, ORDER, doc(kind));
      expect(committed).toMatchObject({ orderId: ORDER, kind, hash: recordHash(doc(kind)), simulated: true });
      expect(committed.cid).toBe(cidOfHash(committed.hash).toString());
    }
    const messages = h.ledger.messages(TOPIC);
    expect(messages).toHaveLength(AGENT_KINDS.length);
    for (const m of messages) {
      expect(m.bytes.length).toBeLessThanOrEqual(RECORD_MSG_MAX_BYTES);
      expect(isCanonical(m.bytes)).toBe(true);
      const decoded = decodeRecordMsg(m.bytes);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) continue;
      expect(m.payer).toBe(AGENT_PAYER);
      expect(h.ipfs.has(decoded.value.cid)).toBe(true);
    }
    for (const kind of AGENT_KINDS) expect(ruleSlotFromDoc(kind, doc(kind), ORDER).ok).toBe(true);
    const refs = await reader.refsFor(ORDER, PARTIES);
    expect(refs.seq).toEqual([1n, 2n, 3n, 4n, 0n, 5n]);
    expect(refs.hashes[2]).toBe(recordHash(doc(2)));
  });

  it('returns the same commit for the same document and refuses a different one', async () => {
    const h = harness();
    const { client } = h.open();
    const first = await client.commitRecord(0, ORDER, doc(0));
    expect(await client.commitRecord(0, ORDER, doc(0))).toEqual(first);
    await expect(client.commitRecord(0, ORDER, doc(0, ORDER, 1))).rejects.toMatchObject({ code: 'record_conflict' });
    expect(h.ledger.messages(TOPIC)).toHaveLength(1);
    // Another order is independent.
    await client.commitRecord(0, OTHER_ORDER, doc(0, OTHER_ORDER));
    expect(h.ledger.messages(TOPIC)).toHaveLength(2);
  });

  it('joins concurrent calls for the same record', async () => {
    const h = harness();
    const { client } = h.open();
    const [a, b] = await Promise.all([client.commitRecord(1, ORDER, doc(1)), client.commitRecord(1, ORDER, doc(1))]);
    expect(a).toEqual(b);
    expect(h.ledger.messages(TOPIC)).toHaveLength(1);
  });

  it('refuses the wrong writer, invalid documents and oversized ones before pinning', async () => {
    const h = harness();
    const agent = h.open().client;
    await expect(agent.commitRecord(4, ORDER, doc(4))).rejects.toMatchObject({ code: 'wrong_writer' });
    const shop = h.open({ role: 'shop' }).client;
    await expect(shop.commitRecord(0, ORDER, doc(0))).rejects.toMatchObject({ code: 'wrong_writer' });
    await expect(agent.commitRecord(0, ORDER, utf8ToBytes('{"v": "1"}'))).rejects.toMatchObject({ code: 'record_invalid' });
    await expect(agent.commitRecord(0, ORDER, doc(0, OTHER_ORDER))).rejects.toMatchObject({ code: 'record_invalid' });
    await expect(agent.commitRecord(1, ORDER, doc(0))).rejects.toMatchObject({ code: 'record_invalid' });
    const big = canonicalBytes({ v: '1', kind: 'asked', orderId: ORDER, attrs: { brand: 'x'.repeat(1600) } });
    await expect(agent.commitRecord(0, ORDER, big)).rejects.toMatchObject({ code: 'record_too_large' });
    expect(h.ipfs.pinCalls).toBe(0);
    expect(h.ledger.messages(TOPIC)).toHaveLength(0);
    const packed = await shop.commitRecord(4, ORDER, doc(4));
    expect(packed.kind).toBe(4);
  });

  it('never pins or references a document the provider misreports', async () => {
    const h = harness();
    const { client } = h.open();
    h.ipfs.inject('wrong_cid');
    await expect(client.commitRecord(0, ORDER, doc(0))).rejects.toMatchObject({ code: 'pin_mismatch' });
    expect(h.ledger.messages(TOPIC)).toHaveLength(0);
    const rows = readJournal<RecordsJournalRow>(h.journalPath).rows;
    expect(rows).toHaveLength(0);
  });
});

describe('records client: retries and restarts', () => {
  it('resends the same transaction after a dropped send', async () => {
    const h = harness();
    const { client, submitter } = h.open({ submitter: { faults: ['drop', 'drop'] } });
    const committed = await client.commitRecord(0, ORDER, doc(0));
    expect(submitter.prepared).toHaveLength(1);
    expect(submitter.sends).toBe(3);
    expect(committed.txId).toBe(submitter.prepared[0]);
    expect(h.ledger.messages(TOPIC)).toHaveLength(1);
  });

  it('takes the receipt when the reply is lost after consensus', async () => {
    const h = harness();
    const { client, submitter } = h.open({ submitter: { faults: ['lost_reply'] } });
    const committed = await client.commitRecord(2, ORDER, doc(2));
    expect(committed.seq).toBe(1);
    expect(submitter.sends).toBe(1);
    expect(h.ledger.messages(TOPIC)).toHaveLength(1);
  });

  it('resends rather than duplicates when the reply is lost and receipts are unavailable', async () => {
    const h = harness();
    const { client, submitter } = h.open({ submitter: { faults: ['lost_reply'], receipts: false } });
    const committed = await client.commitRecord(2, ORDER, doc(2));
    expect(committed.seq).toBe(1);
    expect(submitter.sends).toBe(2);
    expect(h.ledger.messages(TOPIC)).toHaveLength(1);
  });

  it('gives up with submit_failed and settles the old transaction on the next call', async () => {
    const h = harness();
    const first = h.open({ submitter: { faults: ['drop', 'drop', 'drop', 'drop'], receipts: false } });
    await expect(first.client.commitRecord(3, ORDER, doc(3))).rejects.toMatchObject({ code: 'submit_failed' });
    first.journal.close();
    const second = h.open();
    const committed = await second.client.commitRecord(3, ORDER, doc(3));
    // The first transaction had to expire before a second one was prepared.
    expect(h.ledger.clock).toBeGreaterThan(Number(first.submitter.prepared[0]!.split('@')[1]!.split('.')[0]) + 120);
    expect(committed.txId).toBe(second.submitter.prepared[0]);
    expect(h.ledger.messages(TOPIC)).toHaveLength(1);
  });

  it('after a crash past consensus, finds the message instead of sending again', async () => {
    const h = harness();
    const first = h.open({ submitter: { faults: ['land_and_hang'] } });
    void first.client.commitRecord(5, ORDER, doc(5));
    await first.submitter.hung;
    first.journal.close();
    const second = h.open();
    const committed = await second.client.commitRecord(5, ORDER, doc(5));
    expect(second.submitter.prepared).toHaveLength(0);
    expect(committed.seq).toBe(1);
    expect(h.ledger.messages(TOPIC)).toHaveLength(1);
  });

  it('adopts this payer\'s message already on the topic and refuses a conflicting one', async () => {
    const h = harness();
    const hash = recordHash(doc(0));
    h.ledger.append(TOPIC, AGENT_PAYER, encodeRecordMsg({ cid: cidOfHash(hash).toString(), hash, kind: 0, orderId: ORDER }));
    const { client, submitter } = h.open();
    expect((await client.commitRecord(0, ORDER, doc(0))).seq).toBe(1);
    expect(submitter.prepared).toHaveLength(0);
    const other = recordHash(doc(1, ORDER, 1));
    h.ledger.append(TOPIC, AGENT_PAYER, encodeRecordMsg({ cid: cidOfHash(other).toString(), hash: other, kind: 1, orderId: ORDER }));
    await expect(client.commitRecord(1, ORDER, doc(1))).rejects.toMatchObject({ code: 'record_conflict' });
  });

  it('replays the journal: a committed record is answered without touching the network', async () => {
    const h = harness();
    const committed = await h.open().client.commitRecord(0, ORDER, doc(0));
    const hits = h.ledger.mirrorHits.messages;
    const again = h.open();
    expect(again.client.committed(ORDER, 0)).toEqual(committed);
    expect(await again.client.commitRecord(0, ORDER, doc(0))).toEqual(committed);
    expect(h.ledger.mirrorHits.messages).toBe(hits);
    await expect(again.client.commitRecord(0, ORDER, doc(0, ORDER, 1))).rejects.toMatchObject({ code: 'record_conflict' });
  });
});

/** Small deterministic PRNG so a failing seed can be replayed. */
function prng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x1_0000_0000;
  };
}

describe('records client: crash anywhere', () => {
  const FAULTS: SendFault[] = ['ok', 'drop', 'lost_reply', 'hang', 'land_and_hang'];

  it('lands exactly one message per record over 100 random fault and restart sequences', async () => {
    for (let seed = 1; seed <= 100; seed++) {
      const rand = prng(seed);
      const h = harness();
      const kinds = AGENT_KINDS.filter(() => rand() < 0.6);
      if (kinds.length === 0) kinds.push(0);
      for (const kind of kinds) {
        let done = false;
        for (let life = 0; life < 12 && !done; life++) {
          const faults = life >= 8 ? [] : Array.from({ length: Math.floor(rand() * 5) }, () => FAULTS[Math.floor(rand() * FAULTS.length)]!);
          const opened = h.open({ submitter: { faults, receipts: rand() < 0.5 } });
          const outcome = await Promise.race([
            opened.client.commitRecord(kind, ORDER, doc(kind)).then(
              () => 'committed' as const,
              (error: { code?: string }) => {
                if (error.code !== 'submit_failed') throw error;
                return 'failed' as const;
              },
            ),
            opened.submitter.hung.then(() => 'killed' as const),
          ]);
          opened.journal.close();
          if (outcome === 'committed') done = true;
          h.ledger.clock += Math.floor(rand() * 300);
        }
        expect(done, `seed ${seed} kind ${kind}`).toBe(true);
        const own = ownMessages(h, kind);
        expect(own, `seed ${seed} kind ${kind}`).toHaveLength(1);
        const final = h.open();
        expect(final.client.committed(ORDER, kind)?.seq, `seed ${seed} kind ${kind}`).toBe(own[0]!.m.seq);
        final.journal.close();
      }
    }
    // A hundred sequences of up to twelve lives each take about 5 s on this host, the default limit.
  }, 60_000);
});
