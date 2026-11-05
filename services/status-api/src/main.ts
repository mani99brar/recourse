// status-api entry point: `tsx src/main.ts`. Starts with whatever is configured; a missing
// deployments directory or party file is reported by /health, never fatal.

import { readParties } from '@recourse/shared/node';
import type { Parties } from '@recourse/shared';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { loadDeployments } from './deployments.js';
import { realFetch } from './http.js';
import { Indexer } from './indexer.js';
import { DocFetcher } from './ipfs.js';
import { ViemReader, type Reader } from './live.js';
import { StatusService } from './service.js';
import { viemArbRpc } from './sources/viem-arb.js';
import { Store } from './store.js';

function main(): void {
  const cfg = loadConfig();
  const deployments = loadDeployments(cfg.deploymentsDir);
  const loaded = Indexer.loadSnapshot(cfg.stateDir);
  const store = loaded ?? new Store();
  store.rebuilding = loaded === null;

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
  const docs = new DocFetcher({ fetch: realFetch, gatewayUrl: cfg.ipfsGatewayUrl, ratePerMin: cfg.ipfsRatePerMin, timeoutMs: cfg.sourceTimeoutMs });
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

  const svc = new StatusService({ store, cfg, deployments, reader, parties: () => parties, docs, fetch: realFetch, nowS });
  const indexer = new Indexer({ store, cfg, deployments, fetch: realFetch, arbRpc, reader, parties: () => parties, docs, nowS });
  indexer.start();
  const server = createApp(svc).listen(cfg.port, '127.0.0.1', () => {
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
