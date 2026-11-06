// status-api entry point: `tsx src/main.ts`. Starts with whatever is configured; a missing
// deployments directory or party file is reported by /health, never fatal. A malformed `usdc`
// object in the Hedera file stops startup: the vault token is never guessed.

// The records ipfs module, not the barrel (see ipfs.ts: the barrel adds 87 MB at startup).
import { ipfsOptionsFromEnv, type IpfsOptions } from '../../../packages/records/src/ipfs.js';
import { readParties } from '@recourse/shared/node';
import type { Parties } from '@recourse/shared';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { loadDeployments } from './deployments.js';
import { realFetch, safeError } from './http.js';
import { Indexer } from './indexer.js';
import { DocFetcher } from './ipfs.js';
import { ViemActionReads, type ActionReads } from './chain.js';
import { ViemReader, type Reader } from './live.js';
import { StatusService } from './service.js';
import { viemArbRpc } from './sources/viem-arb.js';
import { Store, identityOf } from './store.js';

/** How often the live values a request may wait on are read again in the background (about 20 eth_calls a run). */
const WARM_EVERY_MS = 30_000;

function main(): void {
  const cfg = loadConfig();
  const deployments = loadDeployments(cfg.deploymentsDir);
  const identity = identityOf(deployments, cfg.recordsTopic);
  const loaded = Indexer.loadSnapshot(cfg.stateDir, identity);
  const store = loaded ?? new Store();
  store.identity = identity;
  // A snapshot saved before the first full read finished still says rebuilding.
  store.rebuilding = loaded === null || loaded.rebuilding;

  let parties: Parties | null = null;
  const loadParties = () => {
    try {
      parties = readParties();
    } catch {
      parties = null;
    }
  };
  loadParties();
  setInterval(loadParties, 30_000).unref();

  const nowS = () => Math.floor(Date.now() / 1000);
  // The same document sources as every other service: the content store on this host first
  // (IPFS_PIN_API_URL=file://...), then IPFS_GATEWAY_URL. Neither set: records read as unknown.
  let ipfs: IpfsOptions | null = null;
  try {
    ipfs = ipfsOptionsFromEnv(process.env);
  } catch (e) {
    console.error(`status-api: record documents cannot be fetched (${safeError(e)}); records will read as unchecked`);
  }
  const docs = new DocFetcher({ fetch: (u, i) => fetch(u, i), ipfs, ratePerMin: cfg.ipfsRatePerMin, timeoutMs: cfg.sourceTimeoutMs });
  const arbRpc = cfg.arbRpcUrl ? viemArbRpc(cfg.arbRpcUrl, cfg.sourceTimeoutMs) : null;
  let reader: Reader | null = null;
  if (deployments.claims && deployments.vault && deployments.caseAddress && cfg.hederaRpcUrls.length > 0 && cfg.arbRpcUrl) {
    reader = new ViemReader({
      hederaRpcUrls: cfg.hederaRpcUrls,
      arbRpcUrl: cfg.arbRpcUrl,
      timeoutMs: cfg.sourceTimeoutMs,
      claims: deployments.claims,
      vault: deployments.vault,
      caseAddress: deployments.caseAddress,
      klerosCore: deployments.outside.klerosCore,
      offRampHedera: deployments.outside.offRampHedera,
      offRampArb: deployments.outside.offRampArb,
      arbConfirmations: cfg.arbConfirmations,
    });
  }

  // The /v1 actions read and simulate on the same endpoints at the latest block; without a Hedera
  // relay or the Hedera contracts they answer upstream_unavailable, and without ARB_RPC_URL so do
  // the Arbitrum ones.
  let chain: ActionReads | null = null;
  if (deployments.claims && deployments.vault && cfg.hederaRpcUrls.length > 0) {
    chain = new ViemActionReads({
      hederaRpcUrls: cfg.hederaRpcUrls,
      arbRpcUrl: cfg.arbRpcUrl,
      timeoutMs: cfg.sourceTimeoutMs,
      claims: deployments.claims,
      vault: deployments.vault,
      caseAddress: deployments.caseAddress ?? null,
      klerosCore: deployments.outside.klerosCore,
    });
  }

  const svc = new StatusService({ store, cfg, deployments, reader, parties: () => parties, docs, fetch: realFetch, nowS });
  // Not awaited: the server listens at once, and /health stops saying `params` when this lands.
  // Then every 30 s, so requests are served from these reads instead of waiting on the relay.
  void svc.warm();
  setInterval(() => void svc.warm(), WARM_EVERY_MS).unref();
  const indexer = new Indexer({ store, cfg, deployments, fetch: realFetch, arbRpc, reader, parties: () => parties, docs, nowS });
  indexer.start();
  const server = createApp(svc, { chain }).listen(cfg.port, '127.0.0.1', () => {
    console.log(`status-api listening on 127.0.0.1:${cfg.port}`);
  });
  const stop = () => {
    indexer.stop();
    server.close();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main();
