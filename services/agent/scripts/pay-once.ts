// One paid request, no human: the agent pays the shop's connectivity-check route over x402 on
// hedera:testnet and prints the settled Hedera transaction id.
//
//   pnpm --filter @recourse/agent pay-once                      # shop at SHOP_BASE_URL
//   pnpm --filter @recourse/agent pay-once --shop-url <url>
//   pnpm --filter @recourse/agent pay-once --local-shop [--facilitator N]
//
// `--local-shop` starts the shop in this process (127.0.0.1, a free port) with facilitator rung N
// of X402_FACILITATOR_URLS active, so each rung can be tried without redeploying the shop. The
// payment is real either way: USDC moves from the agent's account to the shop's account.
//
// Checks before paying: both accounts exist with a key, are associated with USDC, and the agent
// holds enough; the 402 is `exact` on hedera:testnet, in the expected asset, to the shop's 0.0.N
// account, for at most the check price. The signed transaction id is journaled before sending.

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { addressBook } from '@recourse/shared';
import { Journal, MirrorClient, checkAccount, createLogger, describeCheck, hederaAccountOf } from '@recourse/records';
import { loadAgentPayer } from '../src/hedera-signer.js';
import { PaymentRefused, chooseRequirement, payExactly, probe402, termsOf } from '../src/x402-pay.js';

const PING_PATH = '/x402/ping-order';
const MAX_PING_USDC = 50_000n;
const MAX_PING_TINYBAR = 10_000_000n;

type Row =
  | { type: 'attempt'; at: string; url: string; amount: string; asset: string; payTo: string }
  | { type: 'signed'; at: string; txId: string; feePayer: string }
  | { type: 'result'; at: string; status: number; txId: string | null; settled: boolean; error: string | null };

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'shop-url': { type: 'string' },
      'local-shop': { type: 'boolean', default: false },
      facilitator: { type: 'string' },
    },
    allowPositionals: false,
  });
  const env = process.env;
  const log = createLogger('agent');
  const hbar = (env.PRICE_ASSET ?? 'usdc').toLowerCase() === 'hbar';
  const asset = hbar ? '0.0.0' : addressBook.hedera.usdc.tokenId;
  const maxAmount = hbar ? MAX_PING_TINYBAR : MAX_PING_USDC;
  const mirror = new MirrorClient(env.HEDERA_MIRROR_URL || addressBook.hedera.mirrorUrl);

  const payer = loadAgentPayer(env);
  const shopAccount = hederaAccountOf('shop', env).accountId;
  log.info('accounts', { agent: payer.accountId, shop: shopAccount, source: payer.source });

  const checks = await Promise.all([
    checkAccount(mirror, {
      role: 'agent',
      accountId: payer.accountId,
      minTinybar: 1n,
      ...(hbar ? {} : { usdc: { minBalance: maxAmount } }),
    }),
    checkAccount(mirror, { role: 'shop', accountId: shopAccount, ...(hbar ? {} : { usdc: {} }) }),
  ]);
  for (const c of checks) console.log(describeCheck(c));
  if (checks.some((c) => !c.ok)) {
    console.error('pay-once: account check failed; nothing sent');
    return 2;
  }

  let shopUrl = values['shop-url'] ?? env.SHOP_BASE_URL;
  let stopShop: (() => Promise<void>) | null = null;
  if (values['local-shop']) {
    const { startShop } = await import('../../shop/src/boot.js');
    const rung = values.facilitator ? Number(values.facilitator) : 1;
    if (!Number.isInteger(rung) || rung < 1) throw new Error('--facilitator: expected a rung number from 1');
    const running = await startShop({ env, port: 0, firstRung: rung, log: createLogger('shop') });
    const state = running.ladder.state();
    if (state.rung !== rung) {
      await running.close();
      console.error(`pay-once: rung ${rung} is not usable; the ladder picked rung ${state.rung} (${state.url})`);
      return 2;
    }
    console.log(`local shop on ${running.url}, facilitator rung ${state.rung}: ${state.url}`);
    shopUrl = running.url;
    stopShop = running.close;
  } else if (values.facilitator) {
    console.error('pay-once: --facilitator needs --local-shop (the shop, not the agent, picks the facilitator)');
    return 2;
  }
  if (!shopUrl) {
    console.error('pay-once: no shop URL (pass --shop-url, --local-shop, or set SHOP_BASE_URL)');
    return 2;
  }
  if (!values['local-shop'] && !values['shop-url']) log.warn('shop_url_fallback', { source: 'SHOP_BASE_URL' });

  const url = `${shopUrl.replace(/\/+$/, '')}${PING_PATH}`;
  const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
  const stateDir = fileURLToPath(new URL('../state/', import.meta.url));
  const journal = Journal.open<Row>(join(stateDir, 'pay-once.jsonl'));
  try {
    const probe = await probe402(url, init);
    const requirement = chooseRequirement(probe.paymentRequired, { asset, expectedPayTo: shopAccount });
    if (BigInt(requirement.amount) > maxAmount) {
      throw new PaymentRefused('price_above_check', `the check route asks ${requirement.amount}, above ${maxAmount}`);
    }
    const terms = termsOf(requirement);
    console.log(`402: ${terms.amount} of ${terms.asset} to ${terms.payTo} on ${terms.network}, fee payer ${String(requirement.extra.feePayer)}`);
    journal.append({ type: 'attempt', at: new Date().toISOString(), url, amount: terms.amount, asset: terms.asset, payTo: terms.payTo });

    const paid = await payExactly({
      url,
      init,
      approved: terms,
      signer: payer.signer,
      onSigned: (s) => journal.append({ type: 'signed', at: new Date().toISOString(), txId: s.txId, feePayer: s.feePayer }),
    });
    const txId = paid.settlement?.transaction || paid.signed?.txId || null;
    const settled = paid.status === 200 && paid.settlement?.success === true;
    journal.append({
      type: 'result',
      at: new Date().toISOString(),
      status: paid.status,
      txId,
      settled,
      error: settled ? null : JSON.stringify(paid.body).slice(0, 300),
    });
    if (!settled) {
      console.error(`pay-once: payment not settled (HTTP ${paid.status}): ${JSON.stringify(paid.body).slice(0, 300)}`);
      if (paid.signed) console.error(`signed transaction id (look it up before retrying): ${paid.signed.txId}`);
      return 1;
    }
    console.log(`settled: ${txId}`);
    console.log(`https://hashscan.io/testnet/transaction/${txId}`);
    const onChain = txId ? await waitForTransaction(mirror, txId) : null;
    if (!onChain) {
      console.error('pay-once: the mirror node does not show the transaction yet; check the link above');
      return 1;
    }
    const credited = onChain.tokenTransfers
      .filter((t) => t.tokenId === terms.asset && t.account === terms.payTo)
      .reduce((s, t) => s + t.amount, 0n);
    const hbarCredited = onChain.transfers.filter((t) => t.account === terms.payTo).reduce((s, t) => s + t.amount, 0n);
    const moved = terms.asset === '0.0.0' ? hbarCredited : credited;
    console.log(`mirror: ${onChain.result}, ${moved} of ${terms.asset} to ${terms.payTo}, consensus ${onChain.consensusTimestamp}`);
    return onChain.result === 'SUCCESS' && moved === BigInt(terms.amount) ? 0 : 1;
  } catch (error) {
    if (error instanceof PaymentRefused) {
      console.error(`pay-once: refused ${error.message}`);
      journal.append({ type: 'result', at: new Date().toISOString(), status: 0, txId: null, settled: false, error: error.code });
      return 2;
    }
    throw error;
  } finally {
    journal.close();
    await stopShop?.();
  }
}

async function waitForTransaction(mirror: MirrorClient, txId: string) {
  for (let i = 0; i < 20; i++) {
    const tx = await mirror.transaction(txId).catch(() => null);
    if (tx) return tx;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return null;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`pay-once: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
