// The shop packs a paid order: writes the packed record to the records topic from the shop's
// account and journals it. Dry run by default: shows the document that would be written.
//
//   pnpm --filter @recourse/shop run pack --order <orderId> [--brand B --size S --colour C --quantity N --price P] [--send]
//                                         [--state <shop state dir>]
//
// `run` is needed: without it pnpm runs its own `pack` command (a package tarball), not this script.
//
// Without attribute flags the packed record states the catalogue item and the price charged. A rerun
// after a failed commit commits the document journaled the first time, so attribute flags that
// differ from it are refused (the dry run shows it). An order the shop journaled as paid but never
// confirmed is confirmed first from its platform's asked, shown and approval records on the topic.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Hex } from 'viem';
import { partyByRole, type Attrs } from '@recourse/shared';
import { readParties } from '@recourse/shared/node';
import { Journal, TopicReader, createLogger, displayNameOf, mirrorFromEnv, openRecordsClient, recordsTopicId, withFileLock } from '@recourse/records';
import { assertShopJournal, shopStateDir } from '../src/boot.js';
import { itemBySku, offerAttrs } from '../src/catalog.js';
import { OrderBook, type ShopJournalRow } from '../src/orders.js';
import { attrsDiffer, chargedPrice, confirmationRefs, journaledDraft, packOrder, packedDoc, type PackConfirm } from '../src/pack.js';

type Env = Record<string, string | undefined>;

/** The topic and party map that confirm a paid_unconfirmed order; none without a party map. */
function confirmFrom(env: Env): PackConfirm | undefined {
  if (!env.PARTIES_FILE || !existsSync(env.PARTIES_FILE)) return undefined;
  const parties = readParties(env);
  return { reader: new TopicReader(mirrorFromEnv(env), recordsTopicId(env)), parties, shop: partyByRole(parties, 'shop').evmAddress };
}

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
  const stateDir = (values.state as string | undefined) ?? shopStateDir(process.env);
  assertShopJournal(stateDir);
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
      if (order.status === 'paid_unconfirmed') {
        const confirm = confirmFrom(env);
        if (!confirm) {
          console.log(`order ${orderId} is paid_unconfirmed and PARTIES_FILE is not set: --send would refuse it`);
          return 1;
        }
        try {
          const refs = await confirmationRefs(order, confirm);
          console.log(`order ${orderId} is paid_unconfirmed: --send would confirm it from the topic (asked ${refs.asked.seq}, shown ${refs.shown.seq}, approval ${refs.approval.seq})`);
        } catch (error) {
          console.log(`order ${orderId} is paid_unconfirmed and cannot be confirmed: ${error instanceof Error ? error.message : String(error)}`);
          return 1;
        }
      } else if (order.status !== 'paid') {
        console.log(`order ${orderId} is ${order.status}: --send would refuse it`);
        return 1;
      }
      const journaled = journaledDraft(journal.read().rows, orderId);
      if (journaled) {
        // A rerun commits the journaled document; it may already be on the topic.
        console.log(`order ${orderId} (${order.status}): a packed record was journaled at ${journaled.row.at}; --send commits it as it is`);
        console.log(journaled.text);
        const differs = attrs ? attrsDiffer(attrs, journaled.attrs) : [];
        if (differs.length > 0) {
          console.log(`the attributes given differ from it (${differs.join(', ')}): --send would refuse them`);
          return 1;
        }
        console.log('dry run: nothing written; rerun with --send');
        return 0;
      }
      const item = itemBySku(order.sku);
      const shown = attrs ?? (item ? { ...offerAttrs(item, order.quantity, merchant), price: chargedPrice(order.payment.amount, order.payment.asset) } : {});
      console.log(`order ${orderId} (${order.status}): would write`);
      console.log(new TextDecoder().decode(packedDoc({ orderId, attrs: shown, packedAt: Math.floor(Date.now() / 1000) })));
      console.log('dry run: nothing written; rerun with --send');
      return 0;
    }
    const confirm = confirmFrom(env);
    return await withFileLock(join(stateDir, 'records.jsonl.lock'), async () => {
      const records = openRecordsClient({ role: 'shop', journalPath: join(stateDir, 'records.jsonl'), env, log: createLogger('shop') });
      try {
        const packed = await packOrder({
          records: records.client,
          journal,
          orderId,
          merchant,
          ...(attrs ? { attrs } : {}),
          ...(confirm ? { confirm } : {}),
          log: createLogger('shop'),
        });
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
