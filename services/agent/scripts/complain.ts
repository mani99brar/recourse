// The buyer reports what arrived and complains to the shop. Dry run by default: shows the arrived
// record that would be signed. `--yes` signs it with BUYER_KEY_FILE, writes it to the records
// topic (once; a rerun reuses the first report) and points the shop at it.
//
//   pnpm --filter @recourse/agent complain --order <orderId> --brand B --size S --colour C --quantity 1 [--yes]

import { parseArgs } from 'node:util';
import type { Hex } from 'viem';
import { createLogger } from '@recourse/records';
import { ATTR_OPTIONS, attrsFrom, loadBuyer, withOrdersLock } from '../src/cli.js';
import { arrivedBody } from '../src/docs.js';
import { openAgent, partiesOrNull } from '../src/setup.js';

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { order: { type: 'string' }, yes: { type: 'boolean', default: false }, ...ATTR_OPTIONS } });
  if (!values.order) throw new Error('--order is required');
  const orderId = values.order as Hex;
  const attrs = attrsFrom(values);
  if (Object.keys(attrs).length === 0) throw new Error('say what arrived: at least one of --brand --size --colour --quantity --price --merchant');
  const env = process.env;
  const parties = partiesOrNull(env);
  if (!parties) throw new Error('PARTIES_FILE is not set or missing');
  const account = loadBuyer(env, parties);
  if (!values.yes) {
    const body = new TextDecoder().decode(arrivedBody({ orderId, attrs, reportedAt: Math.floor(Date.now() / 1000) }));
    console.log(`would sign as ${account.address} and write:\n${body}\nrerun with --yes`);
    return 0;
  }
  return withOrdersLock(async () => {
    const agent = await openAgent(env, createLogger('agent'));
    try {
      const report = await agent.buyer.report(orderId, { attrs, buyerAccount: account });
      console.log(JSON.stringify(report));
      return report.shopAccepted ? 0 : 1;
    } finally {
      agent.close();
    }
  });
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`complain: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
