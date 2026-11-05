// Pre-check service entry point: `tsx src/main.ts [--dry-run] [--once] [--local-docs <dir>]
// [--deployments-file <name>.local.json]`.
//
// --dry-run   loads no key; reads everything and prints the call it would make. Nothing is pinned.
// --once      runs one tick and exits.
// --local-docs  LOCAL RUNS ONLY: keep documents as files in <dir> instead of pinning them. Refused
//             unless the Hedera RPC is on this machine.

import { fileURLToPath } from 'node:url';
import { MirrorClient, makeClient, viemTxRpc, type TxSigner } from '@recourse/keeper';
import { loadSigner, readParties } from '@recourse/shared/node';
import { partyByRole } from '@recourse/shared';
import { systemClock } from './clock.js';
import { loadConfig, type PrecheckConfig } from './config.js';
import { GatewayDocStore, LocalDocStore, type DocStore, type PinClient } from './docs.js';
import { createApp, listen } from './http.js';
import { PrecheckService } from './service.js';
import { viemClaimsChain } from './writer.js';

/**
 * WIRING POINT for the real pin client. Return a PinClient built from the records package here
 * once its pin client is ready. Until then live sends are refused (see `makeDocs`).
 */
function realPinClient(_cfg: PrecheckConfig): PinClient | undefined {
  return undefined;
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

function makeDocs(cfg: PrecheckConfig, dryRun: boolean, localDir: string | undefined): DocStore {
  if (localDir !== undefined) {
    if (!dryRun && !cfg.rpcUrls.every(isLoopback)) {
      throw new Error('--local-docs is for local runs: the Hedera RPC must be on this machine');
    }
    console.error(`LOCAL DOC STORE in ${localDir}: documents are written to files and are not pinned to IPFS`);
    return new LocalDocStore(localDir);
  }
  const pinClient = realPinClient(cfg);
  if (pinClient === undefined && !dryRun) {
    throw new Error('no pin client is wired (see realPinClient in main.ts): refusing to send. Use --dry-run, or --local-docs on a local chain');
  }
  return new GatewayDocStore({ gatewayUrl: cfg.gatewayUrl, ...(pinClient === undefined ? {} : { pinClient }) });
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const once = args.includes('--once');
  const localDir = argValue(args, '--local-docs');
  const deploymentsFile = argValue(args, '--deployments-file');

  const cfg = loadConfig(process.env, deploymentsFile === undefined ? {} : { deploymentsFile });
  const parties = readParties();
  const docs = makeDocs(cfg, dryRun, localDir);

  let signer: TxSigner | undefined;
  const from = partyByRole(parties, 'precheck-signer').evmAddress;
  if (!dryRun) {
    const account = await loadSigner('PRECHECK_SIGNER_KEY_FILE');
    signer = { address: account.address, signTransaction: (tx) => account.signTransaction(tx as never) };
  }

  const client = makeClient({ chainId: 296, urls: cfg.rpcUrls });
  const log = (line: string) => console.log(line);
  const service = await PrecheckService.create({
    config: cfg,
    parties,
    mirror: new MirrorClient({ baseUrl: cfg.mirrorUrl }),
    docs,
    chain: viemClaimsChain(client, cfg.claimsAddress),
    rpc: viemTxRpc({ chainId: 296, client, feeMode: 'legacy' }),
    signer,
    from,
    clock: systemClock,
    dryRun,
    log,
  });

  if (once) {
    await service.tick();
    log(JSON.stringify(service.health()));
    service.close();
    return;
  }

  const server = await listen(createApp(service), cfg.port);
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    service
      .pump()
      .catch((err: unknown) => log(`tick failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        running = false;
      });
  }, cfg.tickMs);
  const stop = () => {
    clearInterval(timer);
    server.close();
    service.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  log(JSON.stringify({ event: 'started', port: cfg.port, dryRun }));
  void service.pump();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
