import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { ZERO_HASH, encodeRecordMsg, recordHash, utf8ToBytes, type Parties, type RecordKind } from '@recourse/shared';
import { cidOfHash } from '../src/car.js';
import { MemoryLedger } from '../src/testing.js';
import { TopicReader, topicNumOf } from '../src/topic.js';
import { AGENT_PAYER, ORDER, OTHER_ORDER, PARTIES, SHOP_PAYER, STRANGER, TOPIC, doc } from './helpers.js';

function message(kind: RecordKind, orderId = ORDER, variant = 0): Uint8Array {
  const hash = recordHash(doc(kind, orderId, variant));
  return encodeRecordMsg({ cid: cidOfHash(hash).toString(), hash, kind, orderId });
}

function setup() {
  const ledger = new MemoryLedger();
  ledger.createTopic(TOPIC);
  return { ledger, reader: new TopicReader(ledger.mirror(), TOPIC, 2) };
}

describe('topic reads', () => {
  it('pages through every message and keeps decode failures flagged', async () => {
    const { ledger, reader } = setup();
    ledger.append(TOPIC, AGENT_PAYER, message(0));
    ledger.append(TOPIC, AGENT_PAYER, utf8ToBytes('hello'));
    ledger.append(TOPIC, AGENT_PAYER, message(1), 2);
    ledger.append(TOPIC, AGENT_PAYER, message(2));
    ledger.append(TOPIC, AGENT_PAYER, message(0, OTHER_ORDER));
    expect(await reader.sync()).toBe(5);
    expect(reader.lastSeq).toBe(5);
    const page = await reader.readTopic(1, 5);
    expect(page.map((m) => m.valid)).toEqual([true, false, false, true, true]);
    expect(page[2]).toMatchObject({ valid: false, error: 'chunked message' });
    const records = await reader.readOrderRecords(ORDER);
    expect(records.map((m) => [m.seq, m.kind])).toEqual([
      [1, 0],
      [4, 2],
    ]);
    ledger.append(TOPIC, AGENT_PAYER, message(3));
    expect(await reader.sync()).toBe(1);
  });

  it('builds refs from the first message per kind by an allowed writer, zero hash for the rest', async () => {
    const { ledger, reader } = setup();
    ledger.append(TOPIC, STRANGER, message(0, ORDER, 1)); // not a writer: ignored
    ledger.append(TOPIC, AGENT_PAYER, message(0));
    ledger.append(TOPIC, AGENT_PAYER, message(0, ORDER, 1)); // a second asked record: the first counts
    ledger.append(TOPIC, AGENT_PAYER, message(4)); // packed must come from the shop
    ledger.append(TOPIC, SHOP_PAYER, message(4));
    ledger.append(TOPIC, SHOP_PAYER, message(5)); // arrived is the platform's
    const refs = await reader.refsFor(ORDER, PARTIES);
    expect(refs.topicNum).toBe(7000001n);
    expect(refs.seq).toEqual([2n, 0n, 0n, 0n, 5n, 0n]);
    expect(refs.hashes[0]).toBe(recordHash(doc(0)));
    expect(refs.hashes[4]).toBe(recordHash(doc(4)));
    for (const i of [1, 2, 3, 5]) expect(refs.hashes[i]).toBe(ZERO_HASH);
  });

  it('with the order\'s platform and shop, another platform\'s writer never fills a slot', async () => {
    const { ledger, reader } = setup();
    const OTHER_WRITER = '0.0.5005';
    const parties: Parties = [
      ...PARTIES,
      { role: 'platform', evmAddress: getAddress('0x00000000000000000000000000000000000000c1'), hcsWriters: [OTHER_WRITER], displayName: 'Other Agent Co' },
    ];
    ledger.append(TOPIC, OTHER_WRITER, message(2, ORDER, 1)); // the other platform writes first
    ledger.append(TOPIC, AGENT_PAYER, message(2));
    const order = { platform: PARTIES[0]!.evmAddress, shop: PARTIES[1]!.evmAddress };
    const scoped = await reader.refsFor(ORDER, parties, order);
    expect(scoped.seq[2]).toBe(2n);
    expect(scoped.hashes[2]).toBe(recordHash(doc(2)));
    // Role-wide (no order given) the first platform writer wins, as before.
    expect((await reader.refsFor(ORDER, parties)).seq[2]).toBe(1n);
    // An order naming an address that is not a platform party has no writers at all.
    expect((await reader.refsFor(ORDER, parties, { ...order, platform: PARTIES[1]!.evmAddress })).seq[2]).toBe(0n);
  });

  it('parses topic numbers', () => {
    expect(topicNumOf('0.0.42')).toBe(42n);
    expect(() => topicNumOf('0.1.42')).toThrow();
  });
});
