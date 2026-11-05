// One paid request, no human: the agent pays the shop's connectivity-check route (0.05 USDC) over
// x402 on hedera:testnet and prints the Hedera transaction id and its HashScan link.
//
//   pnpm --filter @recourse/agent pay-once                       # dry run: checks and 402s only
//   pnpm --filter @recourse/agent pay-once --send                # pay, walking the facilitators
//   pnpm --filter @recourse/agent pay-once --send --facilitator 2
//   pnpm --filter @recourse/agent pay-once --send --shop-url <url>
//
// By default the shop runs in this process (127.0.0.1, a free port, its own journal) and the
// facilitators of X402_FACILITATOR_URLS are tried in order (x402.org, then Blocky402, then the
// self-hosted one): each rung's 402 names that rung's fee payer, so a payment is built for one rung
// only. A rung whose /supported does not list `exact` on hedera:testnet is skipped. After a failed
// payment the next rung is tried only once the signed transaction can no longer reach consensus,
// so the check is never paid twice. `--shop-url` pays a running shop instead, through whichever
// facilitator it uses.
//
// The payment is real: USDC moves from the agent's account to the shop's account. Checks first:
// both accounts exist with a key and are associated with USDC, the agent holds enough, and the 402
// is `exact` on hedera:testnet, in the expected asset, to the shop's 0.0.N account, for at most the
// check price. The signed transaction id is journaled before sending.

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { addressBook } from '@recourse/shared';
import { Journal, MirrorClient, checkAccount, createLogger, describeCheck, hederaAccountOf, validStartSeconds } from '@recourse/records';
import { loadAgentPayer, type AgentPayer } from '../src/hedera-signer.js';
import { PaymentRefused, chooseRequirement, payExactly, probe402, termsOf } from '../src/x402-pay.js';

const PING_PATH = '/x402/ping-order';
const MAX_PING_USDC = 50_000n;
const MAX_PING_TINYBAR = 10_000_000n;
/** Hedera's default validity window is 120 s; past this a signed transaction can no longer land. */
const DEAD_AFTER_S = 180;

type Row =
  | { type: 'attempt'; at: string; url: string; rung: number | null; amount: string; asset: string; payTo: string }
  | { type: 'signed'; at: string; txId: string; feePayer: string }
  | { type: 'result'; at: string; status: number; txId: string | null; settled: boolean; error: string | null };

type Attempt = { kind: 'settled'; txId: string; amount: bigint } | { kind: 'failed'; reason: string } | { kind: 'refused'; reason: string };

const iso = () => new Date().toISOString();

interface Context {
  payer: AgentPayer;
  shopAccount: string;
  asset: string;
  maxAmount: bigint;
  mirror: MirrorClient;
  journal: Journal<Row>;
  send: boolean;
}

async function attempt(ctx: Context, shopUrl: string, rung: number | null): Promise<Attempt> {
  const url = `${shopUrl.replace(/\/+$/, '')}${PING_PATH}`;
  const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
  let terms;
  try {
    const probe = await probe402(url, init);
    const requirement = chooseRequirement(probe.paymentRequired, { asset: ctx.asset, expectedPayTo: ctx.shopAccount });
    if (BigInt(requirement.amount) > ctx.maxAmount) {
      throw new PaymentRefused('price_above_check', `the check route asks ${requirement.amount}, above ${ctx.maxAmount}`);
    }
    terms = termsOf(requirement);
    console.log(`402: ${terms.amount} of ${terms.asset} to ${terms.payTo} on ${terms.network}, fee payer ${String(requirement.extra.feePayer)}`);
  } catch (error) {
    if (error instanceof PaymentRefused) return { kind: 'refused', reason: error.message };
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
  if (!ctx.send) return { kind: 'failed', reason: 'dry run' };

  ctx.journal.append({ type: 'attempt', at: iso(), url, rung, amount: terms.amount, asset: terms.asset, payTo: terms.payTo });
  let signedTxId: string | null = null;
  try {
    const paid = await payExactly({
      url,
      init,
      approved: terms,
      signer: ctx.payer.signer,
      onSigned: (s) => {
        signedTxId = s.txId;
        ctx.journal.append({ type: 'signed', at: iso(), txId: s.txId, feePayer: s.feePayer });
      },
    });
    const settled = paid.status === 200 && paid.settlement?.success === true;
    const txId = paid.settlement?.transaction || paid.signed?.txId || null;
    ctx.journal.append({ type: 'result', at: iso(), status: paid.status, txId, settled, error: settled ? null : JSON.stringify(paid.body).slice(0, 300) });
    if (settled && txId) return { kind: 'settled', txId, amount: BigInt(terms.amount) };
    console.error(`not settled (HTTP ${paid.status}): ${JSON.stringify(paid.body).slice(0, 300)}`);
  } catch (error) {
    if (error instanceof PaymentRefused) return { kind: 'refused', reason: error.message };
    console.error(`payment error: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Doubt: did the signed transaction land anyway? Wait until it no longer can.
  const signed = signedTxId as string | null;
  if (!signed) return { kind: 'failed', reason: 'nothing was signed' };
  const deadline = validStartSeconds(signed) + DEAD_AFTER_S;
  console.log(`checking whether ${signed} reached consensus (until ${new Date(deadline * 1000).toISOString()})`);
  while (Math.floor(Date.now() / 1000) <= deadline) {
    const tx = await ctx.mirror.transaction(signed).catch(() => null);
    if (tx) return tx.result === 'SUCCESS' ? { kind: 'settled', txId: signed, amount: BigInt(terms.amount) } : { kind: 'failed', reason: `${signed}: ${tx.result}` };
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return { kind: 'failed', reason: `${signed} never reached consensus` };
}

async function confirm(ctx: Context, txId: string, payTo: string, amount: bigint): Promise<number> {
  console.log(`settled: ${txId}`);
  for (let i = 0; i < 20; i++) {
    const tx = await ctx.mirror.transaction(txId).catch(() => null);
    if (tx) {
      const moved =
        ctx.asset === '0.0.0'
          ? tx.transfers.filter((t) => t.account === payTo).reduce((s, t) => s + t.amount, 0n)
          : tx.tokenTransfers.filter((t) => t.tokenId === ctx.asset && t.account === payTo).reduce((s, t) => s + t.amount, 0n);
      console.log(`mirror: ${tx.result}, ${moved} of ${ctx.asset} to ${payTo}, consensus ${tx.consensusTimestamp}`);
      console.log(`https://hashscan.io/testnet/transaction/${tx.consensusTimestamp}`);
      return tx.result === 'SUCCESS' && moved === amount ? 0 : 1;
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  console.error('pay-once: the mirror node does not show the transaction yet; look it up by its id above');
  return 1;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      send: { type: 'boolean', default: false },
      'shop-url': { type: 'string' },
      facilitator: { type: 'string' },
    },
    allowPositionals: false,
  });
  const env = process.env;
  const log = createLogger('agent');
  const send = values.send ?? false;
  console.log(send ? 'pay-once: SEND (a real payment on Hedera testnet)' : 'pay-once: dry run (nothing is paid)');
  const hbar = (env.PRICE_ASSET ?? 'usdc').toLowerCase() === 'hbar';
  const asset = hbar ? '0.0.0' : addressBook.hedera.usdc.tokenId;
  const maxAmount = hbar ? MAX_PING_TINYBAR : MAX_PING_USDC;
  const mirror = new MirrorClient(env.HEDERA_MIRROR_URL || addressBook.hedera.mirrorUrl);

  const payer = loadAgentPayer(env);
  const shopAccount = hederaAccountOf('shop', env).accountId;
  log.info('accounts', { agent: payer.accountId, shop: shopAccount, source: payer.source });
  const checks = await Promise.all([
    checkAccount(mirror, { role: 'agent', accountId: payer.accountId, minTinybar: 1n, ...(hbar ? {} : { usdc: { minBalance: maxAmount } }) }),
    checkAccount(mirror, { role: 'shop', accountId: shopAccount, ...(hbar ? {} : { usdc: {} }) }),
  ]);
  for (const c of checks) console.log(describeCheck(c));
  if (checks.some((c) => !c.ok)) {
    console.error('pay-once: account check failed; nothing sent');
    return 2;
  }

  const journal = Journal.open<Row>(join(fileURLToPath(new URL('../state/', import.meta.url)), 'pay-once.jsonl'));
  const ctx: Context = { payer, shopAccount, asset, maxAmount, mirror, journal, send };
  try {
    if (values['shop-url']) {
      if (values.facilitator) throw new Error('--facilitator picks the in-process shop\'s rung; it does not apply to --shop-url');
      const r = await attempt(ctx, values['shop-url'], null);
      if (r.kind === 'settled') return confirm(ctx, r.txId, shopAccount, r.amount);
      console.error(`pay-once: ${r.reason}`);
      return send ? 1 : r.kind === 'refused' ? 2 : 0;
    }

    const { startShop, DEFAULT_STATE_DIR } = await import('../../shop/src/boot.js');
    const { parseFacilitatorUrls } = await import('../../shop/src/facilitators.js');
    const urls = parseFacilitatorUrls(env.X402_FACILITATOR_URLS);
    const only = values.facilitator ? Number(values.facilitator) : null;
    if (only !== null && (!Number.isInteger(only) || only < 1 || only > urls.length)) throw new Error(`--facilitator: expected 1-${urls.length}`);
    const rungs = only ? [only] : urls.map((_, i) => i + 1);
    for (const rung of rungs) {
      console.log(`\nrung ${rung}: ${urls[rung - 1]}`);
      let running;
      try {
        running = await startShop({ env, port: 0, firstRung: rung, log: createLogger('shop'), journalPath: join(DEFAULT_STATE_DIR, 'pay-once-journal.jsonl') });
      } catch (error) {
        console.log(`rung ${rung}: shop did not start (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }
      try {
        const state = running.ladder.state();
        if (state.rung !== rung) {
          console.log(`rung ${rung}: not usable (its /supported has no exact on hedera:testnet); the ladder would use rung ${state.rung}`);
          continue;
        }
        const r = await attempt(ctx, running.url, rung);
        if (r.kind === 'settled') {
          console.log(`paid through rung ${rung} (${state.url})`);
          return confirm(ctx, r.txId, shopAccount, r.amount);
        }
        if (r.kind === 'refused') {
          console.error(`pay-once: refused: ${r.reason}`);
          return 2;
        }
        if (send) console.log(`rung ${rung}: ${r.reason}; trying the next rung`);
      } finally {
        await running.close();
      }
    }
    if (!send) {
      console.log('\ndry run complete; rerun with --send to pay');
      return 0;
    }
    console.error('pay-once: no rung settled the payment');
    return 1;
  } finally {
    journal.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`pay-once: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
