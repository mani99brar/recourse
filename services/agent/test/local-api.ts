// The status API over a local anvil deployment, in the test process, for the anvil tests: the same
// /v1 actions the commands call, reading and simulating on the local contracts. No mirror node runs
// here, so its index stays empty: claim reads answer 404 and party reads carry no credit, and the
// commands' read-back finds nothing (the tests give them --wait 0 and read the chain themselves).

import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import { createApp } from '../../status-api/src/app.js';
import { ViemActionReads } from '../../status-api/src/chain.js';
import { loadConfig } from '../../status-api/src/config.js';
import { loadDeployments, type Deployments } from '../../status-api/src/deployments.js';
import { realFetch } from '../../status-api/src/http.js';
import { DocFetcher } from '../../status-api/src/ipfs.js';
import { StatusService } from '../../status-api/src/service.js';
import { Store } from '../../status-api/src/store.js';

export interface LocalApi {
  url: string;
  close(): Promise<void>;
}

/** `deploymentFile`: the full path of the *.local.json the local deploy wrote. */
export async function startLocalApi(rpcUrl: string, deploymentFile: string): Promise<LocalApi> {
  // loadDeployments takes the local file's name from the environment, as the service does.
  const was = process.env.HEDERA_LOCAL_FILE;
  let deployments: Deployments;
  try {
    process.env.HEDERA_LOCAL_FILE = basename(deploymentFile);
    deployments = loadDeployments(dirname(deploymentFile));
  } finally {
    if (was === undefined) delete process.env.HEDERA_LOCAL_FILE;
    else process.env.HEDERA_LOCAL_FILE = was;
  }
  if (!deployments.claims || !deployments.vault) throw new Error(`${deploymentFile} names no claims or vault contract`);
  // Nothing on this host is asked: the docket, pre-check and shop URLs go nowhere.
  const nowhere = 'http://127.0.0.1:1';
  const cfg = { ...loadConfig({ HEDERA_RPC_URL_1: rpcUrl, HOME: tmpdir(), DOCKET_URL: nowhere, PRECHECK_URL: nowhere, SHOP_URL: nowhere }), viewCacheMs: 0 };
  const docs = new DocFetcher({ fetch: (u, i) => fetch(u, i), ipfs: null, ratePerMin: 10, timeoutMs: 1000 });
  const svc = new StatusService({ store: new Store(), cfg, deployments, reader: null, parties: () => null, docs, fetch: realFetch, nowS: () => Math.floor(Date.now() / 1000) });
  const chain = new ViemActionReads({
    hederaRpcUrls: [rpcUrl],
    arbRpcUrl: '',
    timeoutMs: 10_000,
    claims: deployments.claims,
    vault: deployments.vault,
    caseAddress: null,
    klerosCore: deployments.outside.klerosCore,
  });
  const server = await new Promise<Server>((resolve, reject) => {
    const s = createApp(svc, { chain }).listen(0, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
