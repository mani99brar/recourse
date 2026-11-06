// One whole order on Hedera testnet, the live counterpart of local-demo, built from the same pieces:
//
//   agent checkout: asked, shown, approval -> x402 payment (USDC, or HBAR when PRICE_ASSET=hbar) -> ordered
//   shop: packed      buyer: arrived, complaint to the shop      shop: fileClaim through the status API
//
// Dry run by default: checks the accounts, the records topic, the keys, the claims deployment and
// the court fee, and shows the approval text and how the spend limits decide it; nothing is
// journaled, written or paid. `--send` runs it for real, step by step; a rerun with `--order <id>`
// carries on where it stopped (every step is journaled and idempotent). The claim is built by the
// status API's POST /v1/actions/fileClaim (STATUS_API_URL, default http://127.0.0.1:8787), checked
// against what the shop files, and signed here with SHOP_KEY_FILE, as file-claim does, once the API's
// index shows the arrived record the buyer has just written (up to a minute). The court fee is the vault's
// token from the shop in either mode: the USDC deployments/hedera.json records, Circle's (checked on
// the mirror node; also while there is no record yet) or the testnet mock (checked by balanceOf over
// HEDERA_RPC_URL_1). The shop's vault token is checked only when the run goes on to the claim; with
// --through order|pack|report it needs none, and with PRICE_ASSET=usdc its Circle USDC is still checked.
//
//   pnpm --filter @recourse/agent live-order [--sku tee-navy-l] [--local-shop [--facilitator N]]
//                                           [--through order|pack|report|claim] [--send] [--order <id>]
//                                           [--fault ordered-size=<S>]
//
// `--fault ordered-size=<S>` stages an agent-company mistake, for a demonstration only: the agent's
// ordered record (written after payment, so the shop cannot check it before it settles) states size
// S although the buyer asked for, and was shown, the item's own size. The shop packs and ships what
// the ordered record says, and the buyer reports size S. The fault rule is unchanged; it answers 1
// (the agent company) at step 2a-ii, so the shop's claim is paid from the agent company's deposit.
// Use an item whose size is the asked M (tee-navy-m) and a different S. Repeat it on a rerun.
//
// `--local-shop` runs the shop in this process (its own journal) on the facilitator rung N of
// X402_FACILITATOR_URLS; otherwise the agent finds the running shop through its ERC-8004
// registration (or SHOP_BASE_URL) and the shop's journals are read from its state folder (SHOP_STATE_DIR,
// else services/shop/state), the agent's from AGENT_STATE_DIR (else services/agent/state).

import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { getAddress, type Hex } from 'viem';
import { CIRCLE_VAULT_TOKEN, RecordKind, addressBook, claimIdOf, hederaAccountIdOf, partyByRole, priceAssetOf, type Attrs, type VaultToken } from '@recourse/shared';
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
  readJournal,
  recordsTopicId,
  withFileLock,
  type RecordsClient,
} from '@recourse/records';
import type { RunningShop } from '../../shop/src/boot.js';
import { basketPrice, itemBySku } from '../../shop/src/catalog.js';
import { DeploymentMissingError, balanceReader, publicClientFor, readHederaDeployment } from '../../shop/src/chain.js';
import { claimInputFor } from '../../shop/src/claim-input.js';
import type { FilingJournalRow } from '../../shop/src/filing.js';
import type { ShopJournalRow } from '../../shop/src/orders.js';
import { packOrder } from '../../shop/src/pack.js';
import { courtFeeOf, fileClaimRun, openHedera, type HederaSide } from '../src/act.js';
import type { AgentRow } from '../src/buy.js';
import { hashscanLink, loadBuyer, withOrdersLock } from '../src/cli.js';
import { orderedDoc } from '../src/docs.js';
import { openAgent, ordersJournalPath, partiesOrNull } from '../src/setup.js';

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
      fault: { type: 'string' },
    },
  });
  const through = values.through as Step;
  if (!STEPS.includes(through)) throw new Error(`--through: one of ${STEPS.join(', ')}`);
  const faultMatch = values.fault === undefined ? null : /^ordered-size=([A-Za-z0-9]{1,8})$/.exec(values.fault);
  if (values.fault !== undefined && !faultMatch) throw new Error('--fault: ordered-size=<S> is the one staged fault');
  const faultSize = faultMatch ? faultMatch[1]! : null;
  const upTo = (s: Step) => STEPS.indexOf(s) <= STEPS.indexOf(through);
  const send = values.send ?? false;
  const env = process.env;
  const log = createLogger('live-order');
  console.log(send ? 'live-order: SEND (real records, payment and claim on Hedera testnet)' : 'live-order: dry run (nothing is written or paid)');

  const parties = partiesOrNull(env);
  if (!parties) throw new Error('PARTIES_FILE is not set or missing');
  const merchant = displayNameOf('shop', env);
  const shopParty = partyByRole(parties, 'shop', env);
  const { assertShopJournal, shopStateDir, startShop } = await import('../../shop/src/boot.js');
  const shopState = shopStateDir(env);
  const ordersJournal = ordersJournalPath(env);

  let shop: RunningShop | null = null;
  let shopJournalPath = join(shopState, 'journal.jsonl');
  // The running shop's journals: refuse a folder it has never written, so its claims and records
  // journals are the ones this run reads.
  if (!values['local-shop']) assertShopJournal(shopState);
  if (values['local-shop']) {
    shopJournalPath = join(shopState, 'live-order-journal.jsonl');
    const rung = values.facilitator ? Number(values.facilitator) : 1;
    shop = await startShop({ env, port: 0, firstRung: rung, journalPath: shopJournalPath, log: createLogger('shop') });
    const state = shop.ladder.state();
    console.log(`local shop on ${shop.url}, facilitator rung ${state.rung}: ${state.url}`);
    if (state.rung !== rung) console.log(`(rung ${rung} was not usable)`);
  }
  try {
    // Checks every step needs, before anything is written.
    const mirror = new MirrorClient(env.HEDERA_MIRROR_URL || addressBook.hedera.mirrorUrl);
    const agentParty = partyByRole(parties, 'agent', env);
    // 1 HBAR covers the agent's record fees (the facilitator pays the transfer's fee). Until the
    // order's payment is signed the agent must also hold its price, in HBAR (and then no USDC) when
    // paying in HBAR. A rerun with --order prices the journaled basket, and once a payment is signed
    // its money may already have left, so only the fees are checked.
    const orderRows = values.order ? readJournal<AgentRow>(ordersJournal).rows.filter((r) => 'orderId' in r && r.orderId === values.order) : [];
    const drafted = orderRows.find((r): r is Extract<AgentRow, { type: 'draft' }> => r.type === 'draft');
    if (values.order && !drafted) throw new Error(`--order: no draft for ${values.order} in ${ordersJournal}`);
    const basket = drafted ? { sku: drafted.sku, quantity: drafted.quantity } : { sku: values.sku!, quantity: 1 };
    const item = itemBySku(basket.sku);
    if (!item) throw new Error(`--sku: no item ${basket.sku}`);
    if (faultSize !== null) {
      if (item.size.toLowerCase() === faultSize.toLowerCase()) throw new Error(`--fault: ${basket.sku} is already size ${item.size}; stage a size it does not have`);
      console.log(`staged fault: the ordered record will say size ${faultSize}; asked M, shown ${item.size}; the shop ships ${faultSize}`);
    }
    const priceAsset = priceAssetOf(env);
    const toPay = orderRows.some((r) => r.type === 'pay_signed' || r.type === 'paid') ? 0n : BigInt(basketPrice(item, basket.quantity, priceAsset).amount);
    const agentNeeds = priceAsset === 'hbar' ? { minTinybar: 1n * HBAR + toPay } : { minTinybar: 1n * HBAR, usdc: { minBalance: toPay } };
    // No deployment yet is Circle's USDC, as for a record with no usdc object; a bad record names no
    // token, so the shop's is not checked (and --send stops).
    let deployment: ReturnType<typeof readHederaDeployment> | null = null;
    let vaultToken: VaultToken | null = null;
    if (upTo('claim')) {
      try {
        deployment = readHederaDeployment({ env });
        vaultToken = deployment.token;
      } catch (error) {
        console.log(`claims deployment: ${error instanceof Error ? error.message : String(error)}`);
        if (error instanceof DeploymentMissingError) vaultToken = CIRCLE_VAULT_TOKEN;
        if (send) return 2;
      }
    }
    const rpcUrl = env.HEDERA_RPC_URL_1;
    if (deployment && !rpcUrl) throw new Error('HEDERA_RPC_URL_1 is not set');
    // The shop's court fee is in the vault's token; an x402 payment in USDC reaches it in Circle's.
    const shopId = hederaAccountIdOf(shopParty);
    const vaultUsdc = vaultToken && { token: vaultToken, ...(deployment ? { balanceOf: balanceReader(publicClientFor(rpcUrl!, deployment.chainId)) } : {}) };
    const x402Usdc = priceAsset === 'usdc' && vaultToken?.mode !== 'circle';
    const checks = await Promise.all([
      checkAccount(mirror, { role: 'agent', accountId: hederaAccountIdOf(agentParty), ...agentNeeds }),
      checkAccount(mirror, { role: 'shop', accountId: shopId, minTinybar: 1n * HBAR, ...(vaultUsdc ? { usdc: vaultUsdc } : {}) }),
      ...(x402Usdc ? [checkAccount(mirror, { role: 'shop (x402 USDC)', accountId: shopId, usdc: {} })] : []),
    ]);
    for (const c of checks) console.log(describeCheck(c));
    const topicId = recordsTopicId(env);
    const topic = await mirror.topic(topicId);
    console.log(topic ? `records topic ${topicId}: on the mirror node` : `records topic ${topicId}: NOT on the mirror node`);
    const shopAccount = loadSigner('SHOP_KEY_FILE', env);
    if (getAddress(shopParty.evmAddress) !== shopAccount.address) throw new Error('SHOP_KEY_FILE is not the party map\'s shop');
    const buyerAccount = upTo('report') ? loadBuyer(env, parties) : null;
    // The claim goes through the status API, which must serve this checkout's contracts.
    let api: HederaSide | null = null;
    if (deployment) {
      try {
        api = await openHedera(env, shopAccount);
        const u = `µ${deployment.token.symbol}`;
        console.log(`claims ${deployment.claims}: court fee ${courtFeeOf(api.params)} ${u} of ${deployment.token.label} ${deployment.usdc}, from the status API at ${api.client.base}`);
      } catch (error) {
        console.log(`status API: ${error instanceof Error ? error.message : String(error)}`);
        if (send) return 2;
      }
    }
    if (checks.some((c) => !c.ok) || !topic) {
      if (send) {
        console.error('live-order: a check failed; nothing sent');
        return 2;
      }
      console.log('a check failed: --send would stop here');
    }

    return await withFileLock(join(shopState, 'claims.jsonl.lock'), () => withOrdersLock(async () => {
      const claimsJournal = Journal.open<FilingJournalRow>(join(shopState, 'claims.jsonl'));
      const agent = await openAgent(env, log, {
        ...(shop ? { shop: { x402Base: `${shop.url}/x402/`, apiBase: shop.url, payTo: hederaAccountIdOf(shopParty), shopAddress: getAddress(shopParty.evmAddress), source: 'in-process shop' } } : {}),
        ...(faultSize !== null ? { records: (client: RecordsClient) => withOrderedSize(client, faultSize) } : {}),
      });
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
          const packed = await withFileLock(join(shopState, 'records.jsonl.lock'), async () => {
            const records = openRecordsClient({ role: 'shop', journalPath: join(shopState, 'records.jsonl'), env, log });
            try {
              // With a staged fault the shop ships what the agent's ordered record says.
              const attrs = faultSize !== null ? await orderedAttrsOf(ordersJournal, orderId!, env) : undefined;
              return await packOrder({ records: records.client, journal: shopJournal, orderId: orderId!, merchant, log, ...(attrs ? { attrs } : {}) });
            } finally {
              records.close();
            }
          });
          console.log(`packed: seq ${packed.seq}, cid ${packed.cid}`);
          if (!upTo('report')) return 0;

          // 3. What arrived (the size the shop sent, not the size asked for), and the complaint.
          const report = await buyer.report(orderId, {
            attrs: { brand: 'Northwind', size: faultSize ?? 'L', colour: 'Navy', quantity: '1', merchant },
            buyerAccount: buyerAccount!,
          });
          console.log(`arrived: seq ${report.seq}, cid ${report.cid}; shop ${report.shopAccepted ? 'took the complaint' : `refused it: ${report.shopError}`}`);
          if (!report.shopAccepted) return 1;
          if (!upTo('claim') || !api) return 0;

          // 4. The shop's claim, built by the status API and signed here.
          const reader = new TopicReader(mirrorFromEnv(env), topicId);
          const ipfs = ipfsOptionsFromEnv(env);
          const input = await claimInputFor({ rows: shopJournal.read().rows, reader, parties, orderId, fetchDoc: (cid, hash) => fetchDocument(cid, hash, ipfs) });
          const filed = await fileClaimRun(api, input, { send: true, journal: claimsJournal });
          console.log(`claim ${filed.claimId}${filed.done ? ' (already filed)' : filed.hashes.length > 0 ? `: https://hashscan.io/testnet/transaction/${filed.hashes.at(-1)}` : ''}`);
          return filed.code;
        } finally {
          shopJournal.close();
        }
      } finally {
        agent.close();
        claimsJournal.close();
      }
    }, env));
  } finally {
    await shop?.close();
  }
}

/** The records client with the ordered record's size replaced: the staged agent-company mistake of `--fault`. */
function withOrderedSize(client: RecordsClient, size: string): RecordsClient {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'commitRecord') {
        return (kind: RecordKind, orderId: Hex, bytes: Uint8Array) => {
          if (kind !== RecordKind.Ordered) return target.commitRecord(kind, orderId, bytes);
          const doc = JSON.parse(new TextDecoder().decode(bytes)) as { orderId: Hex; attrs: Attrs; x402TxId: string; amount: string; asset: string; payTo: string };
          return target.commitRecord(kind, orderId, orderedDoc({ ...doc, attrs: { ...doc.attrs, size } }));
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** The attributes of the order's ordered record, read back from the topic's document. */
async function orderedAttrsOf(journalPath: string, orderId: Hex, env: NodeJS.ProcessEnv): Promise<Attrs> {
  const row = readJournal<AgentRow>(journalPath).rows.find(
    (r): r is Extract<AgentRow, { type: 'committed' }> => r.type === 'committed' && r.orderId === orderId && r.kind === RecordKind.Ordered,
  );
  if (!row) throw new Error(`no ordered record for ${orderId} in ${journalPath}`);
  return (JSON.parse(new TextDecoder().decode(await fetchDocument(row.cid, row.hash, ipfsOptionsFromEnv(env)))) as { attrs: Attrs }).attrs;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`live-order: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
