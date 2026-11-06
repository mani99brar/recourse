// Settles the shop never heard back about. Dry run by default: lists every settle_unknown row in the
// shop journal that has no outcome yet and what the mirror node says about its transfer; nothing is
// written. `--write` journals the outcomes (the order paid with that transaction, a duplicate
// payment to refund, or a dead payment), as the running shop does at boot and on GET /orders/:id.
// It signs and sends nothing.
//
//   pnpm --filter @recourse/shop reconcile [--order <orderId>] [--write] [--state <shop state dir>]

import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Journal, mirrorFromEnv } from '@recourse/records';
import { DEFAULT_STATE_DIR } from '../src/boot.js';
import type { ShopJournalRow } from '../src/orders.js';
import { checkSettlements } from '../src/reconcile.js';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      order: { type: 'string' },
      write: { type: 'boolean', default: false },
      state: { type: 'string' },
    },
  });
  const stateDir = values.state ?? DEFAULT_STATE_DIR;
  const path = join(stateDir, 'journal.jsonl');
  // The running shop appends to this journal too: never cut its last line.
  const journal = Journal.open<ShopJournalRow>(path, { cutTornTail: false });
  try {
    const checks = await checkSettlements({
      rows: journal.read().rows,
      mirror: mirrorFromEnv(process.env),
      now: Math.floor(Date.now() / 1000),
      ...(values.order ? { orderId: values.order } : {}),
    });
    if (checks.length === 0) {
      console.log(`no open settle_unknown rows in ${path}`);
      return 0;
    }
    for (const c of checks) {
      console.log(`order ${c.unknown.orderId}: transaction ${c.unknown.txId} (${c.unknown.amount} of ${c.unknown.asset} from ${c.unknown.payer}): ${c.outcome}, ${c.reason}`);
      for (const row of c.rows) console.log(`  ${values.write ? 'journaled' : 'would journal'} ${row.type}`);
      if (values.write) for (const row of c.rows) journal.append(row);
    }
    if (!values.write && checks.some((c) => c.rows.length > 0)) console.log('dry run: nothing written; rerun with --write');
    return checks.some((c) => c.outcome === 'unreachable') ? 1 : 0;
  } finally {
    journal.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`reconcile: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
