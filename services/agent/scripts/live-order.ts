// One whole order on Hedera testnet, the live counterpart of local-demo, built from the same pieces:
//
//   agent checkout: asked, shown, approval -> x402 payment (USDC) -> ordered
//   shop: packed      buyer: arrived, complaint to the shop      shop: fileClaim on RecourseClaims
//
// Dry run by default: checks the accounts, the records topic, the keys, the claims deployment and
// the court fee, and shows the approval text and how the spend limits decide it; nothing is
// journaled, written or paid. `--send` runs it for real, step by step; a rerun with `--order <id>`
// carries on where it stopped (every step is journaled and idempotent).
//
//   pnpm --filter @recourse/agent live-order [--sku tee-navy-l] [--local-shop [--facilitator N]]
//                                           [--through order|pack|report|claim] [--send] [--order <id>]
//
// `--local-shop` runs the shop in this process (its own journal) on the facilitator rung N of
// X402_FACILITATOR_URLS; otherwise the agent finds the running shop through its ERC-8004
// registration (or SHOP_BASE_URL) and the shop's journal is read from services/shop/state.

import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { erc20Abi, getAddress, type Hex } from 'viem';
import { addressBook, claimIdOf, partyByRole, type Attrs } from '@recourse/shared';
import { loadSigner } from '@recourse/shared/node';
import {
  Journal,
  MirrorClient,
  TopicReader,
  checkAccount,
  createLogger,
  describeCheck,
  displayNameOf,
  fetchDocument,
  ipfsOptionsFromEnv,
  mirrorFromEnv,
  openRecordsClient,
  recordsTopicId,
  withFileLock,
} from '@recourse/records';
import type { RunningShop } from '../../shop/src/boot.js';
import { chainClients, loadAbi, readHederaDeployment } from '../../shop/src/chain.js';
import { claimInputFor } from '../../shop/src/claim-input.js';
import { ClaimFiler, type FilingJournalRow } from '../../shop/src/filing.js';
import type { ShopJournalRow } from '../../shop/src/orders.js';
import { packOrder } from '../../shop/src/pack.js';
import { hashscanLink, loadBuyer, withOrdersLock } from '../src/cli.js';
import { openAgent, partiesOrNull } from '../src/setup.js';

const STEPS = ['order', 'pack', 'report', 'claim'] as const;
type Step = (typeof STEPS)[number];
const HBAR = 100_000_000n;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      sku: { type: 'string', default: 'tee-navy-l' },
      'local-shop': { type: 'boolean', default: false },
      facilitator: { type: 'string' },
      through: { type: 'string', default: 'claim' },
      order: { type: 'string' },
      send: { type: 'boolean', default: false },
    },
  });
  const through = values.through as Step;
  if (!STEPS.includes(through)) throw new Error(`--through: one of ${STEPS.join(', ')}`);
  const upTo = (s: Step) => STEPS.indexOf(s) <= STEPS.indexOf(through);
  const send = values.send ?? false;
  const env = process.env;
  const log = createLogger('live-order');
  console.log(send ? 'live-order: SEND (real records, payment and claim on Hedera testnet)' : 'live-order: dry run (nothing is written or paid)');

  const parties = partiesOrNull(env);
  if (!parties) throw new Error('PARTIES_FILE is not set or missing');
  const merchant = displayNameOf('shop', env);
  const shopParty = partyByRole(parties, 'shop');
  const { DEFAULT_STATE_DIR, startShop } = await import('../../shop/src/boot.js');

  let shop: RunningShop | null = null;
  let shopJournalPath = join(DEFAULT_STATE_DIR, 'journal.jsonl');
  if (values['local-shop']) {
    shopJournalPath = join(DEFAULT_STATE_DIR, 'live-order-journal.jsonl');
    const rung = values.facilitator ? Number(values.facilitator) : 1;
    shop = await startShop({ env, port: 0, firstRung: rung, journalPath: shopJournalPath, log: createLogger('shop') });
    const state = shop.ladder.state();
    console.log(`local shop on ${shop.url}, facilitator rung ${state.rung}: ${state.url}`);
    if (state.rung !== rung) console.log(`(rung ${rung} was not usable)`);
  }
  try {
    // Checks every step needs, before anything is written.
    const mirror = new MirrorClient(env.HEDERA_MIRROR_URL || addressBook.hedera.mirrorUrl);
    const agentParty = partyByRole(parties, 'agent');
    const checks = await Promise.all([
      checkAccount(mirror, { role: 'agent', accountId: agentParty.hederaAccountId!, minTinybar: 1n * HBAR, usdc: { minBalance: 2_000_000n } }),
      checkAccount(mirror, { role: 'shop', accountId: shopParty.hederaAccountId!, minTinybar: 1n * HBAR, usdc: {} }),
    ]);
    for (const c of checks) console.log(describeCheck(c));
    const topicId = recordsTopicId(env);
    const topic = await mirror.topic(topicId);
    console.log(topic ? `records topic ${topicId}: on the mirror node` : `records topic ${topicId}: NOT on the mirror node`);
    const shopAccount = loadSigner('SHOP_KEY_FILE', env);
    if (getAddress(shopParty.evmAddress) !== shopAccount.address) throw new Error('SHOP_KEY_FILE is not the party map\'s shop');
    const buyerAccount = upTo('report') ? loadBuyer(env, parties) : null;
    let deployment: ReturnType<typeof readHederaDeployment> | null = null;
    if (upTo('claim')) {
      try {
        deployment = readHederaDeployment({ env });
      } catch (error) {
        console.log(`claims deployment: ${error instanceof Error ? error.message : String(error)}`);
        if (send) return 2;
      }
    }
    const rpcUrl = env.HEDERA_RPC_URL_1;
    if (deployment && !rpcUrl) throw new Error('HEDERA_RPC_URL_1 is not set');
    const clients = deployment ? chainClients({ rpcUrl: rpcUrl!, chainId: deployment.chainId, account: shopAccount }) : null;
    if (checks.some((c) => !c.ok) || !topic) {
      if (send) {
        console.error('live-order: a check failed; nothing sent');
        return 2;
      }
      console.log('a check failed: --send would stop here');
    }

    return await withFileLock(join(DEFAULT_STATE_DIR, 'claims.jsonl.lock'), () => withOrdersLock(async () => {
      const claimsJournal = Journal.open<FilingJournalRow>(join(DEFAULT_STATE_DIR, 'claims.jsonl'));
      const filer =
        deployment && clients
          ? new ClaimFiler({ clients, claims: deployment.claims, vault: deployment.vault, usdc: deployment.usdc, claimsAbi: loadAbi('RecourseClaims', env), journal: claimsJournal, log })
          : null;
      if (filer && deployment && clients) {
        const [fee, balance] = await Promise.all([
          filer.courtFee(),
          clients.publicClient.readContract({ address: deployment.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [shopAccount.address] }),
        ]);
        console.log(`claims ${deployment.claims}: court fee ${fee} µUSDC; the shop holds ${balance} µUSDC${balance < fee ? ' (NOT ENOUGH)' : ''}`);
      }
      const agent = await openAgent(env, log, shop ? { shop: { x402Base: `${shop.url}/x402/`, apiBase: shop.url, payTo: shopParty.hederaAccountId!, shopAddress: getAddress(shopParty.evmAddress), source: 'in-process shop' } } : {});
      try {
        const { buyer } = agent;
        const target = agent.shop;
        console.log(`shop: ${target.x402Base} (payTo ${target.payTo}, via ${target.source})`);
        const asked: Attrs = { brand: 'Northwind', size: 'M', colour: 'Navy', quantity: '1', price: '2.00', merchant };
        const draftInput = { sku: values.sku!, quantity: 1, asked, buyer: { name: 'Demo Buyer', address: '1 Example Street' } };

        let orderId = values.order as Hex | undefined;
        if (!send) {
          const p = await buyer.preview(draftInput);
          console.log(`402: ${p.terms.amount} of ${p.terms.asset} to ${p.terms.payTo}; changes: ${p.changes.join(', ') || 'none'}`);
          console.log(`spend limits: ${p.decision.kind === 'refused' ? `refused (${p.decision.reason})` : p.decision.kind}`);
          console.log(p.text);
          if (deployment) console.log(`claim id for this preview's order id: ${claimIdOf(BigInt(deployment.chainId), deployment.claims, p.orderId)}`);
          console.log(`dry run complete: would run ${STEPS.filter(upTo).join(' -> ')}; rerun with --send`);
          return 0;
        }

        // 1. Checkout and payment.
        if (!orderId) {
          orderId = buyer.draft(draftInput);
          console.log(`order ${orderId} (rerun with --order ${orderId} to carry on)`);
        }
        const outcome = await buyer.run(orderId);
        console.log(`checkout: ${JSON.stringify(outcome)}`);
        if (outcome.state === 'awaiting_approval') {
          console.log(`waiting for the buyer: pnpm --filter @recourse/agent approve ${outcome.approvalId} --yes, then rerun with --order ${orderId}`);
          return 0;
        }
        if (outcome.state !== 'done') return 1;
        console.log(`payment ${outcome.txId}: ${await hashscanLink(agent.mirror, outcome.txId)}`);
        if (!upTo('pack')) return 0;

        // 2. The shop's packed record, from the shop account.
        // The shop appends to this journal too: never cut its last line.
        const shopJournal = Journal.open<ShopJournalRow>(shopJournalPath, { cutTornTail: false });
        try {
          const packed = await withFileLock(join(DEFAULT_STATE_DIR, 'records.jsonl.lock'), async () => {
            const records = openRecordsClient({ role: 'shop', journalPath: join(DEFAULT_STATE_DIR, 'records.jsonl'), env, log });
            try {
              return await packOrder({ records: records.client, journal: shopJournal, orderId: orderId!, merchant, log });
            } finally {
              records.close();
            }
          });
          console.log(`packed: seq ${packed.seq}, cid ${packed.cid}`);
          if (!upTo('report')) return 0;

          // 3. What arrived (the size the shop sent, not the size asked for), and the complaint.
          const report = await buyer.report(orderId, {
            attrs: { brand: 'Northwind', size: 'L', colour: 'Navy', quantity: '1', merchant },
            buyerAccount: buyerAccount!,
          });
          console.log(`arrived: seq ${report.seq}, cid ${report.cid}; shop ${report.shopAccepted ? 'took the complaint' : `refused it: ${report.shopError}`}`);
          if (!report.shopAccepted) return 1;
          if (!upTo('claim') || !filer) return 0;

          // 4. The shop's claim.
          const reader = new TopicReader(mirrorFromEnv(env), topicId);
          const ipfs = ipfsOptionsFromEnv(env);
          const input = await claimInputFor({ rows: shopJournal.read().rows, reader, parties, orderId, fetchDoc: (cid, hash) => fetchDocument(cid, hash, ipfs) });
          const filed = await filer.fileClaim(input);
          console.log(`claim ${filed.claimId}${filed.txHash ? `: https://hashscan.io/testnet/transaction/${filed.txHash}` : ' (already filed)'}`);
          return 0;
        } finally {
          shopJournal.close();
        }
      } finally {
        agent.close();
        claimsJournal.close();
      }
    }));
  } finally {
    await shop?.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`live-order: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
