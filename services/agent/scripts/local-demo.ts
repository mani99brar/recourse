// LOCAL RUN ONLY: one whole order on this machine, end to end, with nothing on a public network.
//
//   agent checkout: asked, shown, approval -> x402 payment -> ordered
//   shop: packed      buyer: arrived, complaint to the shop      shop: fileClaim on RecourseClaims
//
// What is real and what is simulated:
// - Claims, the deposit vault and the USDC mock run on a local anvil, deployed by the repo's local
//   deploy script; the claim is a real transaction there, from anvil's development account 4 (the
//   shop), against the platform (account 3).
// - The records topic is an in-memory HCS stand-in (simulated). With --serve it is also served as
//   a mirror node REST API, so other services on this host can read it.
// - The x402 payment is signed by the agent like a live one, then checked and "settled" by a
//   simulated facilitator: no money moves, and the settlement id starts with `fake-settlement:`.
// - Documents go to a local content store (a directory, IPFS_PIN_API_URL=file://...) under the
//   same CIDs a public pin would get; with --serve the mirror port also serves them at /ipfs/<cid>.
//
// Usage: pnpm --filter @recourse/agent local-demo [--serve] [--anvil-port 8573] [--mirror-port 8574] [--shop-port 8575] [--state <dir>]
// Ports must be in 8570-8579. Do not wrap it in the suite lock: it takes that lock itself for the
// contract deploy only, so a --serve run does not hold it while it waits.

import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PrivateKey } from '@hiero-ledger/sdk';
import { createClientHederaSigner } from '@x402/hedera';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { ENV_DEFAULTS, RECORD_KEYS, decodeRecordMsg, type Parties } from '@recourse/shared';
import {
  Journal,
  LocalPinProvider,
  MemoryLedger,
  RecordsClient,
  TopicReader,
  createLogger,
  fetchDocument,
  pinDocument,
  type Logger,
  type RecordsJournalRow,
} from '@recourse/records';
import { createShopApp, type ShopJournalRow } from '../../shop/src/app.js';
import { chainClients, loadAbi } from '../../shop/src/chain.js';
import { claimInputFor } from '../../shop/src/claim-input.js';
import { FacilitatorLadder } from '../../shop/src/facilitators.js';
import { ClaimFiler, type FilingJournalRow } from '../../shop/src/filing.js';
import { fakeFacilitator } from '../../shop/src/local-facilitator.js';
import { devAccount, startLocalChain } from '../../shop/src/local-chain.js';
import { packOrder } from '../../shop/src/pack.js';
import { NETWORK, USDC_TOKEN_ID } from '../../shop/src/payments.js';
import { vaultStandingReader } from '../../shop/src/standing.js';
import { Buyer, type AgentRow } from '../src/buy.js';
import { DEFAULT_LIMITS } from '../src/limits.js';

export const DEMO_TOPIC = '0.0.7000001';
/** Made-up Hedera account ids for the local run; no such accounts are used anywhere else. */
export const DEMO_AGENT_ACCOUNT = '0.0.990300';
export const DEMO_SHOP_ACCOUNT = '0.0.990100';
export const DEMO_PLATFORM_ACCOUNT = '0.0.990200';
export const DEMO_BUYER_ACCOUNT = '0.0.990400';
const MERCHANT = 'Northwind Demo Shop';

export interface DemoOptions {
  anvilPort: number;
  mirrorPort: number;
  shopPort: number;
  stateDir: string;
  /** Deployment file name; default `hedera.lane04-demo-<anvil port>.local.json`. */
  deploymentFile?: string;
  /** Lock file taken for the contract deploy (see startLocalChain); none inside a locked test run. */
  deployLock?: string;
  log?: Logger;
}

export interface DemoResult {
  orderId: Hex;
  settlement: string;
  records: { kind: string; seq: number; payer: string; cid: string; hash: Hex }[];
  claim: { claimId: Hex; txHash: Hex | null; status: number; basketUsdc: string; netLossUsdc: string };
  env: Record<string, string>;
}

function inRange(port: number): number {
  if (!Number.isInteger(port) || port < 8570 || port > 8579) throw new Error(`port ${port} is outside 8570-8579`);
  return port;
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

/** Mirror node REST over the in-memory ledger, plus the local store as a read-only gateway. */
function mirrorServer(ledger: MemoryLedger, store: LocalPinProvider): Server {
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method !== 'GET') {
        res.writeHead(405).end();
        return;
      }
      const ipfs = /^\/ipfs\/([A-Za-z0-9]+)$/.exec(url.pathname);
      if (ipfs) {
        const bytes = await store.readPinned(ipfs[1]!).catch(() => null);
        if (!bytes) {
          res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) }).end(Buffer.from(bytes));
        return;
      }
      const answer = await ledger.fetch(url.toString());
      const body = Buffer.from(await answer.arrayBuffer());
      res.writeHead(answer.status, { 'content-type': 'application/json' }).end(body);
    })().catch((error: unknown) => {
      res.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
  });
}

/**
 * Runs the order and leaves everything running; `close` stops it all. Every value it returns comes
 * from the local run; nothing here is a testnet or mainnet value.
 */
export async function runLocalDemo(options: DemoOptions): Promise<DemoResult & { close(): Promise<void> }> {
  const log = options.log ?? createLogger('local-demo');
  const [anvilPort, mirrorPort, shopPort] = [inRange(options.anvilPort), inRange(options.mirrorPort), inRange(options.shopPort)];
  mkdirSync(options.stateDir, { recursive: true });
  const closers: (() => Promise<void> | void)[] = [];
  const close = async () => {
    for (const c of closers.splice(0).reverse()) await c();
  };
  try {
    // Chain: Claims, vault and USDC mock on anvil. Platform = account 3, shop = account 4.
    const file = options.deploymentFile ?? `hedera.lane04-demo-${anvilPort}.local.json`;
    const chain = await startLocalChain(anvilPort, { file, ...(options.deployLock ? { deployLock: options.deployLock } : {}) });
    closers.push(() => chain.stop());
    const platform = chain.deployment.roles?.platform;
    const shopAddress = chain.deployment.roles?.shop;
    if (!platform || !shopAddress) throw new Error('the local deployment names no platform or shop account');
    const shopAccount = devAccount(4);
    if (shopAccount.address !== shopAddress) throw new Error('anvil account 4 is not the deployment shop');

    // Records topic (simulated) and the local content store.
    const ledger = new MemoryLedger(Math.floor(Date.now() / 1000));
    ledger.createTopic(DEMO_TOPIC);
    const tick = setInterval(() => {
      ledger.clock = Math.max(ledger.clock, Math.floor(Date.now() / 1000));
    }, 1000);
    tick.unref();
    closers.push(() => clearInterval(tick));
    const storeDir = join(options.stateDir, 'ipfs');
    const store = new LocalPinProvider(storeDir);
    const ipfs = { localDir: storeDir };
    const pin = (bytes: Uint8Array) => pinDocument(bytes, store, ipfs);
    const mirror = mirrorServer(ledger, store);
    await listen(mirror, mirrorPort);
    closers.push(() => new Promise<void>((r) => mirror.close(() => r())));
    const mirrorUrl = `http://127.0.0.1:${mirrorPort}`;

    const agentAccount = privateKeyToAccount(generatePrivateKey());
    const buyerAccount = privateKeyToAccount(generatePrivateKey());
    const parties: Parties = [
      { role: 'platform', evmAddress: platform, hederaAccountId: DEMO_PLATFORM_ACCOUNT, hcsWriters: [DEMO_AGENT_ACCOUNT], displayName: 'Demo Agent Co' },
      { role: 'agent', evmAddress: agentAccount.address, hederaAccountId: DEMO_AGENT_ACCOUNT, hcsWriters: [], displayName: 'Demo Shopping Agent' },
      { role: 'shop', evmAddress: shopAddress, hederaAccountId: DEMO_SHOP_ACCOUNT, hcsWriters: [DEMO_SHOP_ACCOUNT], displayName: MERCHANT },
      { role: 'buyer', evmAddress: buyerAccount.address, hederaAccountId: DEMO_BUYER_ACCOUNT, hcsWriters: [], displayName: 'Demo Buyer' },
    ];
    const partiesFile = join(options.stateDir, 'parties.json');
    writeFileSync(partiesFile, `${JSON.stringify(parties, null, 2)}\n`);
    const chainEnv = { HEDERA_RPC_URL_1: chain.rpcUrl, HEDERA_LOCAL_FILE: file };

    // Shop, paid through the simulated facilitator, with the vault standing check on.
    const fake = fakeFacilitator();
    const shopJournal = Journal.open<ShopJournalRow>(join(options.stateDir, 'shop', 'journal.jsonl'));
    closers.push(() => shopJournal.close());
    let initialize: (() => Promise<void>) | undefined;
    const ladder = new FacilitatorLadder([{ index: 1, url: 'local://simulated-facilitator', create: () => fake }], {
      network: NETWORK,
      log,
      onSwitch: async () => initialize?.(),
    });
    await ladder.select();
    const shopReader = new TopicReader(ledger.mirror(), DEMO_TOPIC);
    const shop = createShopApp({
      config: {
        port: shopPort,
        publicUrl: null,
        payTo: DEMO_SHOP_ACCOUNT,
        payToSource: 'local demo',
        facilitatorUrls: ['local://simulated-facilitator'],
        priceAsset: 'usdc',
        mirrorUrl: `${mirrorUrl}/api/v1`,
        stateDir: join(options.stateDir, 'shop'),
        standingCheck: 'vault',
        topicId: DEMO_TOPIC,
        displayName: MERCHANT,
        shopAddress,
      },
      facilitator: ladder,
      journal: shopJournal,
      log,
      parties,
      standing: vaultStandingReader(chainEnv),
      reader: shopReader,
    });
    initialize = shop.initialize;
    await shop.initialize();
    const shopServer = await new Promise<Server>((resolve, reject) => {
      const s = shop.app.listen(shopPort, '127.0.0.1', () => resolve(s));
      s.once('error', reject);
    });
    closers.push(() => new Promise<void>((r) => shopServer.close(() => r())));
    const shopUrl = `http://127.0.0.1:${shopPort}`;

    // Agent: fresh local keys, the simulated topic and the local store.
    const recordsClient = (role: 'agent' | 'shop', payer: string, journalName: string) => {
      const journal = Journal.open<RecordsJournalRow>(join(options.stateDir, journalName));
      closers.push(() => journal.close());
      const submitter = ledger.submitter(payer, { receipts: true });
      return new RecordsClient({ role, topicId: DEMO_TOPIC, submitter, pin, reader: new TopicReader(ledger.mirror(), DEMO_TOPIC), mirror: ledger.mirror(), journal, log });
    };
    const agentJournal = Journal.open<AgentRow>(join(options.stateDir, 'agent', 'orders.jsonl'));
    closers.push(() => agentJournal.close());
    const buyer = new Buyer({
      platform,
      shop: { x402Base: `${shopUrl}/x402/`, apiBase: shopUrl, payTo: DEMO_SHOP_ACCOUNT, shopAddress, source: 'local demo' },
      records: recordsClient('agent', DEMO_AGENT_ACCOUNT, 'agent/records.jsonl'),
      pin,
      payer: createClientHederaSigner(DEMO_AGENT_ACCOUNT, PrivateKey.generateECDSA(), { network: NETWORK }),
      agentAccount,
      mirror: ledger.mirror(),
      journal: agentJournal,
      limits: DEFAULT_LIMITS,
      asset: USDC_TOKEN_ID,
      log,
      pollMs: 200,
    });

    // 1. Checkout: the buyer asked for size M; the shop's item is size L. The change is shown, and
    //    the price is within the mandate, so the agent approves and pays.
    const orderId = buyer.draft({
      sku: 'tee-navy-l',
      quantity: 1,
      asked: { brand: 'Northwind', size: 'M', colour: 'Navy', quantity: '1', price: '2.00', merchant: MERCHANT },
      buyer: { name: 'Demo Buyer', address: '1 Example Street' },
    });
    const outcome = await buyer.run(orderId);
    if (outcome.state !== 'done') throw new Error(`checkout ended ${JSON.stringify(outcome)}`);
    log.info('demo_checkout_done', { orderId, settlement: outcome.txId, simulated: true });

    // 2. The shop packs what was paid for and writes the packed record from its own account.
    const packed = await packOrder({ records: recordsClient('shop', DEMO_SHOP_ACCOUNT, 'shop/records.jsonl'), journal: shopJournal, orderId, merchant: MERCHANT, log });

    // 3. The buyer reports what arrived (size L, not the M asked for) and complains to the shop.
    const report = await buyer.report(orderId, {
      attrs: { brand: 'Northwind', size: 'L', colour: 'Navy', quantity: '1', merchant: MERCHANT },
      buyerAccount,
      attempts: 3,
    });
    if (!report.shopAccepted) throw new Error(`the shop did not take the complaint: ${report.shopError}`);

    // 4. The shop files its claim on the local RecourseClaims for the whole basket.
    const input = await claimInputFor({
      rows: shopJournal.read().rows,
      reader: shopReader,
      parties,
      orderId,
      fetchDoc: (cid, hash) => fetchDocument(cid, hash, ipfs),
    });
    const claimsJournal = Journal.open<FilingJournalRow>(join(options.stateDir, 'shop', 'claims.jsonl'));
    closers.push(() => claimsJournal.close());
    const filer = new ClaimFiler({
      clients: chainClients({ rpcUrl: chain.rpcUrl, chainId: chain.deployment.chainId, account: shopAccount }),
      claims: chain.deployment.claims,
      vault: chain.deployment.vault,
      usdc: chain.deployment.usdc,
      claimsAbi: loadAbi('RecourseClaims'),
      journal: claimsJournal,
      log,
      receiptTimeoutMs: 30_000,
    });
    const filed = await filer.fileClaim(input);
    const status = await filer.statusOf(filed.claimId);

    const records = ledger
      .messages(DEMO_TOPIC)
      .map((m) => ({ m, d: decodeRecordMsg(m.bytes) }))
      .filter((x) => x.d.ok && x.d.value.orderId === orderId)
      .map(({ m, d }) => {
        const v = (d as { ok: true; value: { kind: number; cid: string; hash: Hex } }).value;
        return { kind: RECORD_KEYS[v.kind] ?? String(v.kind), seq: m.seq, payer: m.payer, cid: v.cid, hash: v.hash };
      });
    log.info('demo_done', { orderId, packedSeq: packed.seq, arrivedSeq: report.seq, claimId: filed.claimId, status });

    return {
      orderId,
      settlement: outcome.txId,
      records,
      claim: { claimId: filed.claimId, txHash: filed.txHash, status, basketUsdc: input.basketUsdc.toString(), netLossUsdc: input.netLossUsdc.toString() },
      env: {
        HEDERA_RPC_URL_1: chain.rpcUrl,
        HEDERA_LOCAL_FILE: file,
        HEDERA_MIRROR_URL: mirrorUrl,
        HCS_RECORDS_TOPIC_ID: DEMO_TOPIC,
        PARTIES_FILE: partiesFile,
        IPFS_PIN_API_URL: pathToFileURL(storeDir).href,
        IPFS_GATEWAY_URL: mirrorUrl,
        SHOP_BASE_URL: shopUrl,
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function arg(args: string[], name: string, fallback: string): string {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const serve = args.includes('--serve');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const stateDir = arg(args, '--state', fileURLToPath(new URL(`../state/local-demo/${stamp}/`, import.meta.url)));
  const result = await runLocalDemo({
    anvilPort: Number(arg(args, '--anvil-port', '8573')),
    mirrorPort: Number(arg(args, '--mirror-port', '8574')),
    shopPort: Number(arg(args, '--shop-port', '8575')),
    stateDir,
    deployLock: process.env.SUITE_LOCK_FILE || ENV_DEFAULTS.SUITE_LOCK_FILE!,
  });
  const { close, env, ...summary } = result;
  console.log('\nLOCAL RUN: simulated records topic and facilitator, local anvil chain; no public network was used.');
  console.log(JSON.stringify(summary, null, 2));
  console.log('\nEnvironment for other services on this host:');
  for (const [k, v] of Object.entries(env)) console.log(`${k}=${v}`);
  if (!serve) {
    await close();
    return;
  }
  console.log('\nServing the chain, the shop and the mirror until interrupted (Ctrl-C).');
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
  await close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
