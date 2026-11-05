// The shop packs a paid order: writes the packed record to the records topic from the shop's
// account and journals it. Dry run by default: shows the document that would be written.
//
//   pnpm --filter @recourse/shop pack --order <orderId> [--brand B --size S --colour C --quantity N --price P] [--send]
//                                     [--state <shop state dir>]
//
// Without attribute flags the packed record states the catalogue item and the price charged.

import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Hex } from 'viem';
import type { Attrs } from '@recourse/shared';
import { Journal, createLogger, displayNameOf, openRecordsClient, withFileLock } from '@recourse/records';
import { DEFAULT_STATE_DIR } from '../src/boot.js';
import { itemBySku, offerAttrs } from '../src/catalog.js';
import { OrderBook, type ShopJournalRow } from '../src/orders.js';
import { chargedPrice, packOrder, packedDoc } from '../src/pack.js';

const ATTRS = ['brand', 'size', 'colour', 'quantity', 'price', 'merchant'] as const;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      order: { type: 'string' },
      send: { type: 'boolean', default: false },
      state: { type: 'string' },
      ...Object.fromEntries(ATTRS.map((k) => [k, { type: 'string' as const }])),
    },
  });
  if (!values.order) throw new Error('--order is required');
  const orderId = values.order as Hex;
  const env = process.env;
  const stateDir = (values.state as string | undefined) ?? DEFAULT_STATE_DIR;
  const merchant = displayNameOf('shop', env);
  const given: Attrs = {};
  for (const k of ATTRS) {
    const v = (values as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.trim() !== '') given[k] = v;
  }
  const attrs = Object.keys(given).length > 0 ? given : undefined;

  // The running shop appends to this journal too: never cut its last line.
  const journal = Journal.open<ShopJournalRow>(join(stateDir, 'journal.jsonl'), { cutTornTail: false });
  try {
    if (!values.send) {
      const book = new OrderBook();
      for (const row of journal.read().rows) book.apply(row);
      const order = book.get(orderId);
      if (!order) throw new Error(`no paid order ${orderId} in ${join(stateDir, 'journal.jsonl')}`);
      if (order.packed) {
        console.log(`already packed: seq ${order.packed.seq}, cid ${order.packed.cid}`);
        return 0;
      }
      const item = itemBySku(order.sku);
      const shown = attrs ?? (item ? { ...offerAttrs(item, order.quantity, merchant), price: chargedPrice(order.payment.amount, order.payment.asset) } : {});
      console.log(`order ${orderId} (${order.status}): would write`);
      console.log(new TextDecoder().decode(packedDoc({ orderId, attrs: shown, packedAt: Math.floor(Date.now() / 1000) })));
      console.log('dry run: nothing written; rerun with --send');
      return 0;
    }
    return await withFileLock(join(stateDir, 'records.jsonl.lock'), async () => {
      const records = openRecordsClient({ role: 'shop', journalPath: join(stateDir, 'records.jsonl'), env, log: createLogger('shop') });
      try {
        const packed = await packOrder({ records: records.client, journal, orderId, merchant, ...(attrs ? { attrs } : {}), log: createLogger('shop') });
        console.log(JSON.stringify(packed));
        return 0;
      } finally {
        records.close();
      }
    });
  } finally {
    journal.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`pack: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
