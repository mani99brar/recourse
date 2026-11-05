// Places an order for the platform's buyer. Dry run by default: it finds the shop, reads the 402
// and shows the text the buyer would approve and how the spend limits decide it; nothing is
// journaled, written to the topic or paid. `--send` places the order.
//
//   pnpm --filter @recourse/agent order --sku tee-navy-m [--qty 1] [--brand B --size S --colour C --price P]
//                                      [--name N --address A] [--send]
//   pnpm --filter @recourse/agent order --resume <orderId> --send     # carry on after a crash
//   pnpm --filter @recourse/agent order --list
//
// Above the spend limit the order waits for the buyer: the command prints the approval id; the
// buyer decides with `approve`.

import { parseArgs } from 'node:util';
import type { Hex } from 'viem';
import { createLogger } from '@recourse/records';
import { ATTR_OPTIONS, attrsFrom, hashscanLink, withOrdersLock } from '../src/cli.js';
import { openAgent } from '../src/setup.js';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      sku: { type: 'string' },
      qty: { type: 'string', default: '1' },
      name: { type: 'string' },
      address: { type: 'string' },
      resume: { type: 'string' },
      list: { type: 'boolean', default: false },
      send: { type: 'boolean', default: false },
      ...ATTR_OPTIONS,
    },
  });
  const env = process.env;
  const log = createLogger('agent');
  return withOrdersLock(async () => {
    const agent = await openAgent(env, log);
    try {
      const { buyer, shop } = agent;
      console.log(`shop: ${shop.x402Base} (payTo ${shop.payTo}, found via ${shop.source})`);
      if (values.list) {
        for (const id of buyer.orders()) console.log(id);
        return 0;
      }
      if (values.resume) {
        if (!values.send) {
          console.log(`dry run: would resume ${values.resume}; rerun with --send`);
          return 0;
        }
        const outcome = await buyer.run(values.resume as Hex);
        console.log(JSON.stringify(outcome));
        if (outcome.state === 'done') console.log(await hashscanLink(agent.mirror, outcome.txId));
        return outcome.state === 'done' || outcome.state === 'awaiting_approval' ? 0 : 1;
      }
      if (!values.sku) throw new Error('--sku is required (or --resume / --list)');
      const quantity = Number(values.qty);
      const asked = attrsFrom({ ...values, quantity: values.quantity ?? String(quantity) });
      const buyerDetails: Record<string, string> = {};
      if (values.name) buyerDetails.name = values.name;
      if (values.address) buyerDetails.address = values.address;
      const draft = { sku: values.sku, quantity, asked, buyer: buyerDetails };

      if (!values.send) {
        const p = await buyer.preview(draft);
        console.log(`402: ${p.terms.amount} of ${p.terms.asset} to ${p.terms.payTo} on ${p.terms.network}`);
        console.log(`text the buyer approves (hash ${p.textHash}):\n${p.text}`);
        console.log(`changes: ${p.changes.length ? p.changes.join(', ') : 'none'}`);
        console.log(`spend limits: ${p.decision.kind === 'refused' ? `refused (${p.decision.reason})` : p.decision.kind === 'mandate' ? 'within the mandate, no human needed' : 'needs the buyer'}`);
        console.log('dry run: nothing journaled, written or paid; rerun with --send');
        return 0;
      }
      const orderId = buyer.draft(draft);
      console.log(`order ${orderId}`);
      const outcome = await buyer.run(orderId);
      console.log(JSON.stringify(outcome));
      if (outcome.state === 'awaiting_approval') {
        console.log(`waiting for the buyer: pnpm --filter @recourse/agent approve ${outcome.approvalId}`);
        console.log(`(shown at http://127.0.0.1:${env.AGENT_PORT ?? '8722'}/approvals/${outcome.approvalId})`);
        return 0;
      }
      if (outcome.state === 'done') console.log(await hashscanLink(agent.mirror, outcome.txId));
      return outcome.state === 'done' ? 0 : 1;
    } finally {
      agent.close();
    }
  });
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`order: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
