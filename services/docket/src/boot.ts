// Wires the docket together and runs it: config, lock, journal, store, sources, HTTP.

import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Journal, createLogger, ipfsOptionsFromEnv, pinDocument, pinProviderFromEnv, readJournal } from '@recourse/records';
import { nullPinner, type Pinner } from './reason.js';
import { createPublicClient, http, formatEther, type Address } from 'viem';
import { loadSigner, readParties } from '@recourse/shared/node';
import { createDocketApp } from './app.js';
import { loadConfig, type DocketConfig } from './config.js';
import { Docket, cutReviews, type JournalRow, type ReviewPort } from './docket.js';
import { acquireLock } from './lock.js';
import { ReviewWriter, type ReviewRow } from './reviews.js';
import { viemReviewChain } from './reviewsChain.js';
import { ArbitrumCaseSource, MirrorLogSource } from './sources.js';
import { ArkivStore } from './store/arkiv.js';
import { SdkArkivIo, arkivChain } from './store/arkivSdk.js';
import { LocalStore } from './store/local.js';
import type { DocketStore } from './store/types.js';

type Poller = { name: string; poll(cursor: string | undefined): Promise<{ events: import('./events.js').DocketEvent[]; cursor: string | undefined }> };

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pick(obj: Record<string, unknown> | null, names: string[]): string | undefined {
  if (obj === null) return undefined;
  for (const n of names) {
    const v = obj[n];
    if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) return v;
  }
  return undefined;
}

export async function startDocket(env: Record<string, string | undefined> = process.env): Promise<void> {
  const cfg = loadConfig(env);
  const log = createLogger('docket');
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  const release = acquireLock(join(cfg.stateDir, 'docket.lock'));
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (release(), process.exit(0)));

  const store = buildStore(cfg);
  const journalPath = join(cfg.stateDir, 'docket.jsonl');
  const history = readJournal<JournalRow>(journalPath);
  if (history.corrupt.length > 0) throw new Error(`docket journal has ${history.corrupt.length} corrupt line(s)`);
  const journal = Journal.open<JournalRow>(journalPath);

  const alert = async (text: string): Promise<void> => {
    log.warn('alert', { text });
    if (cfg.alertUrl === undefined) return;
    try {
      await fetch(cfg.alertUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    } catch {
      /* alerting must never stop the docket */
    }
  };

  const docket = new Docket({
    store,
    journal,
    history: history.rows,
    now: () => Math.floor(Date.now() / 1000),
    log,
    alert,
    pinner: buildPinner(env, log),
    reviews: buildReviews(cfg, env, log),
    retrySeconds: cfg.retrySeconds,
    retryMax: cfg.retryMax,
  });

  const pollers = buildPollers(cfg, env, log);
  let lastError: string | null = null;
  const app = createDocketApp({ docket, store: store.kind, rate: { publishThreshold: cfg.publishThreshold, sampleMode: cfg.sampleMode, z: cfg.z } });
  app.get('/sources', (_req, res) => res.json({ sources: pollers.map((p) => p.name), lastError }));
  app.listen(cfg.port, () => log.info('listening', { port: cfg.port, store: store.kind, sources: pollers.length }));

  const tick = async (): Promise<void> => {
    for (const p of pollers) {
      try {
        const r = await p.poll(docket.cursor(p.name));
        docket.ingest(r.events);
        if (r.cursor !== undefined) docket.setCursor(p.name, r.cursor);
        lastError = null;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        log.warn('poll_failed', { source: p.name, error: lastError });
      }
    }
    try {
      await docket.flush();
    } catch (error) {
      log.error('flush_failed', { error: error instanceof Error ? error.message : String(error) });
    }
  };
  await tick();
  setInterval(() => void tick(), cfg.pollSeconds * 1000);
  if (store.kind === 'arkiv') void watchBalances(cfg, env, alert);
}

function buildStore(cfg: DocketConfig): DocketStore {
  if (cfg.store === 'local') return LocalStore.open(join(cfg.stateDir, 'local-store.jsonl'));
  const account = loadSigner('SCHEME_KEY_FILE');
  return new ArkivStore(
    new SdkArkivIo({ accessKey: cfg.arkivAccessKey, ...(cfg.arkivRpcUrl ? { rpcUrl: cfg.arkivRpcUrl } : {}), account, lifetimeDays: cfg.lifetimeDays }),
    cfg.pageSize,
  );
}

function buildPollers(cfg: DocketConfig, env: Record<string, string | undefined>, log: ReturnType<typeof createLogger>): Poller[] {
  const out: Poller[] = [];
  if (cfg.deploymentsDir === undefined) {
    log.warn('no_deployments', { note: 'DEPLOYMENTS_DIR not set; no chain sources' });
    return out;
  }
  const hedera = readJson(join(cfg.deploymentsDir, 'hedera.json'));
  const claims = pick(hedera, ['RecourseClaims', 'recourseClaims', 'claims']);
  const vault = pick(hedera, ['DepositVault', 'depositVault', 'vault']);
  if (claims) out.push(new MirrorLogSource({ baseUrl: cfg.mirrorUrl, contract: claims, name: 'hedera-claims' }));
  if (vault) out.push(new MirrorLogSource({ baseUrl: cfg.mirrorUrl, contract: vault, name: 'hedera-vault' }));
  const arb = readJson(join(cfg.deploymentsDir, 'arbitrum.json'));
  const arbCase = pick(arb, ['RecourseCase', 'recourseCase', 'case']);
  const startBlock = arb && (typeof arb.startBlock === 'number' || typeof arb.startBlock === 'string') ? BigInt(arb.startBlock as string | number) : undefined;
  if (arbCase && startBlock !== undefined && env.ARB_RPC_URL) {
    const client = createPublicClient({ transport: http(env.ARB_RPC_URL) });
    out.push(
      new ArbitrumCaseSource(
        {
          getBlockNumber: () => client.getBlockNumber(),
          getLogs: async ({ address, fromBlock, toBlock }) => (await client.getLogs({ address, fromBlock, toBlock })) as never,
        },
        arbCase as `0x${string}`,
        startBlock,
      ),
    );
  }
  if (out.length === 0) log.warn('no_sources', { note: 'no contract addresses found in the deployments directory yet' });
  return out;
}

async function watchBalances(cfg: DocketConfig, env: Record<string, string | undefined>, alert: (t: string) => Promise<void>): Promise<void> {
  const account = loadSigner('SCHEME_KEY_FILE');
  const check = async (): Promise<void> => {
    try {
      const arkiv = createPublicClient({ chain: arkivChain(cfg.arkivAccessKey, cfg.arkivRpcUrl), transport: http() });
      const tglm = Number(formatEther(await arkiv.getBalance({ address: account.address as Address })));
      if (tglm < cfg.minTglm) await alert(`docket: writer tGLM balance is ${tglm.toFixed(3)}, below ${cfg.minTglm}`);
      const hederaUrl = env.HEDERA_RPC_URL_1;
      if (hederaUrl) {
        const hedera = createPublicClient({ transport: http(hederaUrl) });
        const hbar = Number(formatEther(await hedera.getBalance({ address: account.address as Address })));
        if (hbar < cfg.minHbar) await alert(`docket: scheme account HBAR balance is ${hbar.toFixed(2)}, below ${cfg.minHbar}`);
      }
    } catch {
      /* a failed balance read is not an alert */
    }
  };
  await check();
  setInterval(() => void check(), 30 * 60 * 1000);
}

function buildReviews(cfg: DocketConfig, env: Record<string, string | undefined>, log: ReturnType<typeof createLogger>): ReviewPort {
  if (!cfg.reviewsEnabled) return cutReviews;
  try {
    const parties = readParties(env);
    const idOf = (...roles: ('platform' | 'agent' | 'shop')[]): bigint | undefined => {
      for (const role of roles) {
        const p = parties.find((x) => x.role === role && x.agentId !== undefined);
        if (p?.agentId !== undefined) return BigInt(p.agentId);
      }
      return undefined;
    };
    const targets = { ...(idOf('platform', 'agent') !== undefined ? { platform: idOf('platform', 'agent')! } : {}), ...(idOf('shop') !== undefined ? { shop: idOf('shop')! } : {}) };
    const chain = viemReviewChain({ account: loadSigner('SCHEME_KEY_FILE'), rpcUrl: env.HEDERA_RPC_URL_1 ?? '', mirrorUrl: cfg.mirrorUrl });
    const path = join(cfg.stateDir, 'reviews.jsonl');
    const history = readJournal<ReviewRow>(path).rows;
    return new ReviewWriter(chain, Journal.open<ReviewRow>(path), history, targets, { valueFault: cfg.reviewValueFault, valueClear: cfg.reviewValueClear, tag1: cfg.reviewTag1, retrySeconds: cfg.retrySeconds, retryMax: cfg.retryMax }, () => Math.floor(Date.now() / 1000), log);
  } catch (error) {
    log.warn('reviews_off', { error: error instanceof Error ? error.message : String(error) });
    return cutReviews;
  }
}

function buildPinner(env: Record<string, string | undefined>, log: ReturnType<typeof createLogger>): Pinner {
  try {
    const provider = pinProviderFromEnv(env);
    const opts = ipfsOptionsFromEnv(env);
    return { pin: async (bytes) => (await pinDocument(bytes, provider, opts)).cid };
  } catch {
    log.warn('pin_off', { note: 'IPFS pinning is not configured; reasonCid stays empty' });
    return nullPinner;
  }
}
