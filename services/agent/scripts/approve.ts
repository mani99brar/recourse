// The buyer's decision on an order above the spend limit. Shows the exact text, amount and payee
// first; `--yes` signs with BUYER_KEY_FILE (EIP-712), records the decision and carries the order
// on (an approval pays; a decline ends it).
//
//   pnpm --filter @recourse/agent approve <approvalId>            # show what would be signed
//   pnpm --filter @recourse/agent approve <approvalId> --yes      # approve and pay
//   pnpm --filter @recourse/agent approve <approvalId> --decline --yes

import { parseArgs } from 'node:util';
import { render } from '@recourse/renderer';
import { createLogger } from '@recourse/records';
import { approvalMessage } from '../src/approvals-api.js';
import { signApproval } from '../src/approval.js';
import { hashscanLink, loadBuyer, withOrdersLock } from '../src/cli.js';
import { openAgent, partiesOrNull } from '../src/setup.js';

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: { decline: { type: 'boolean', default: false }, yes: { type: 'boolean', default: false } },
    allowPositionals: true,
  });
  const approvalId = positionals[0];
  if (!approvalId) throw new Error('usage: approve <approvalId> [--decline] [--yes]');
  const env = process.env;
  const parties = partiesOrNull(env);
  if (!parties) throw new Error('PARTIES_FILE is not set or missing');
  return withOrdersLock(async () => {
    const agent = await openAgent(env, createLogger('agent'));
    try {
      const { buyer } = agent;
      const orderId = buyer.findByApprovalId(approvalId);
      const pending = orderId ? buyer.pendingApproval(orderId) : null;
      if (!orderId || !pending) {
        console.error(`approve: no open approval ${approvalId}`);
        return 2;
      }
      const decision = values.decline ? 'not_approved' : 'approved';
      console.log(render(pending.rendered.renderInput).text);
      console.log(`order ${orderId}: ${pending.terms.amount} of ${pending.terms.asset} to ${pending.terms.payTo}, open until ${new Date(pending.expiresAt * 1000).toISOString()}`);
      if (Math.floor(Date.now() / 1000) > pending.expiresAt) {
        console.error('approve: this approval has expired; place a new order');
        return 2;
      }
      const account = loadBuyer(env, parties);
      if (!values.yes) {
        console.log(`would sign "${decision}" as ${account.address}; rerun with --yes`);
        return 0;
      }
      const signature = await signApproval(account, approvalMessage(orderId, pending, decision));
      buyer.recordBuyerDecision(orderId, decision, account.address, signature, pending.expiresAt);
      const outcome = await buyer.run(orderId);
      console.log(JSON.stringify(outcome));
      if (outcome.state === 'done') console.log(await hashscanLink(agent.mirror, outcome.txId));
      return outcome.state === 'done' || outcome.state === 'declined' ? 0 : 1;
    } finally {
      agent.close();
    }
  });
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`approve: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
