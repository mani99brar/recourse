// Keeper entry point:
//   tsx src/main.ts [--dry-run] [--once] [--hedera-file <name>] [--arbitrum-file <name>]
//                   [--ops-arb-address <0x..>]
//
// --dry-run        loads no key. Reads both chains, steps every claim and logs each call it would
//                  make; nothing is signed or sent. Simulation runs from the ops addresses
//                  (RULING_RELAYER_ADDRESS for Hedera; --ops-arb-address or the case contract's
//                  trustedRelay() for Arbitrum).
// --once           one tick, print health, exit.
// --hedera-file    a bare *.local.json name in DEPLOYMENTS_DIR instead of hedera.json; same for
//  --arbitrum-file  arbitrum. Local files are refused unless every RPC URL is loopback.

import { isAddress, type Address, type PublicClient } from 'viem';
import { buildEvidence, rawCidOfHash } from '@recourse/court';
import { fetchDocument, hashOfCid, ipfsOptionsFromEnv, type IpfsOptions } from '@recourse/records';
import { loadSigner } from '@recourse/shared/node';
import { caseAbi, claimsAbi } from './abi.js';
import { DEFAULT_GAS_FLOORS, LiveChains } from './adapter.js';
import { Alerter } from './alerts.js';
import { loadKeeperConfig, type KeeperConfig } from './config.js';
import { readArbitrumDeployment, readHederaDeployment } from './deployments.js';
import { evidenceAssembler, type BuildEvidence } from './evidence.js';
import { createKeeperApp, jsonSafe, listenKeeper } from './http.js';
import { openJournal } from './journal.js';
import { BlockLogReader, MirrorEventSource, type EventSource } from './logs.js';
import { Keeper } from './machine.js';
import { HederaLogReader, MirrorClient } from './mirror.js';
import { makeClient, viemTxRpc } from './rpc.js';
import { Sender, type TxSigner } from './sender.js';
import { tsSeconds } from './timestamps.js';

const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
}

function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
  } catch {
    return false;
  }
}

async function checkChain(client: PublicClient, want: number, what: string): Promise<void> {
  const got = await client.getChainId();
  if (got !== want) throw new Error(`${what} RPC is chain ${got}, the deployments file says ${want}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const once = args.includes('--once');
  const cfg: KeeperConfig = loadKeeperConfig();
  const arbFile = arg(args, '--arbitrum-file') ?? 'arbitrum.json';
  const hedFile = arg(args, '--hedera-file') ?? 'hedera.json';
  const arb = readArbitrumDeployment(cfg.deploymentsDir, arbFile);
  const hed = readHederaDeployment(cfg.deploymentsDir, hedFile, arb);
  if ((arb.local || hed.local) && ![...cfg.hederaRpcUrls, cfg.arbRpcUrl].every(isLoopback)) {
    throw new Error('local deployment files need loopback RPC URLs (HEDERA_RPC_URL_1/2, ARB_RPC_URL)');
  }
  if (arb.local !== hed.local) throw new Error('use local files for both chains or for neither');

  const hClient = makeClient({ chainId: hed.chainId, urls: cfg.hederaRpcUrls });
  const aClient = makeClient({ chainId: arb.chainId, urls: [cfg.arbRpcUrl] });
  await checkChain(hClient, hed.chainId, 'Hedera');
  await checkChain(aClient, arb.chainId, 'Arbitrum');

  let hSigner: TxSigner | undefined;
  let aSigner: TxSigner | undefined;
  let hFrom: Address;
  let aFrom: Address;
  if (dryRun) {
    const relayer = process.env.RULING_RELAYER_ADDRESS ?? '';
    hFrom = (isAddress(relayer) ? relayer : await hClient.readContract({ address: hed.claims, abi: claimsAbi, functionName: 'rulingRelayer' })) as Address;
    const given = arg(args, '--ops-arb-address');
    if (given !== undefined && !isAddress(given)) throw new Error('--ops-arb-address is not an address');
    aFrom = (given as Address | undefined) ?? (await aClient.readContract({ address: arb.case, abi: [...caseAbi, ...TRUSTED_RELAY], functionName: 'trustedRelay' }));
  } else {
    const h = loadSigner('OPS_HEDERA_KEY_FILE');
    const a = loadSigner('OPS_ARB_KEY_FILE');
    hSigner = h as unknown as TxSigner;
    aSigner = a as unknown as TxSigner;
    hFrom = h.address;
    aFrom = a.address;
    const relayer = await hClient.readContract({ address: hed.claims, abi: claimsAbi, functionName: 'rulingRelayer' });
    if (relayer.toLowerCase() !== hFrom.toLowerCase()) {
      log(`warning: ops-hedera ${hFrom} is not the claims rulingRelayer ${relayer}; recordRuling (one-leg modes) will revert`);
    }
  }

  const journal = openJournal(cfg.stateDir);
  const append = (r: Parameters<typeof journal.append>[0]) => journal.append(r);
  // A transaction the node refuses 4 times in a row (one per tick) and that is 2 min old is
  // dropped so the key is free again; after a drop for lack of funds nothing new is signed on
  // that key for 5 min (doubling up to 40 min while it stays unfunded).
  const dropRejected = { after: 4, minAgeMs: 120_000, fundsCooldownMs: 300_000 };
  const hSender = new Sender({
    chain: 'hedera',
    rpc: viemTxRpc({ chainId: hed.chainId, client: hClient, feeMode: 'legacy' }),
    from: hFrom,
    append,
    nonceTag: 'latest', // the Hedera relay has no usable pending nonce
    log,
    dropRejected,
    ...(hSigner ? { signer: hSigner } : {}),
  });
  const aSender = new Sender({
    chain: 'arbitrum',
    rpc: viemTxRpc({ chainId: arb.chainId, client: aClient, feeMode: 'eip1559' }),
    from: aFrom,
    append,
    nonceTag: 'pending',
    log,
    dropRejected,
    ...(aSigner ? { signer: aSigner } : {}),
  });

  let hEvents: EventSource;
  let hReader: { position: unknown };
  if (hed.claimsId !== null && !hed.local) {
    const mirror = new MirrorClient({ baseUrl: cfg.mirrorUrl });
    const reader = new HederaLogReader({ mirror, contract: hed.claimsId, dir: cfg.stateDir, source: 'hedera-claims', startTimestamp: hed.startTimestamp });
    hReader = reader;
    hEvents = new MirrorEventSource(reader, claimsAbi, 'claims', async () => {
      const newest = Number(tsSeconds(await mirror.newestBlockTimestamp()));
      return Math.max(0, Math.floor(Date.now() / 1000) - newest);
    });
  } else {
    const reader = new BlockLogReader({
      chain: 'hedera',
      client: hClient,
      dir: cfg.stateDir,
      source: 'hedera-claims',
      startBlock: hed.startBlock,
      confirmations: 0,
      chunk: 1000,
      maxChunks: 10,
      first: [{ source: 'claims', address: hed.claims, abi: claimsAbi }],
    });
    hReader = reader;
    hEvents = reader;
  }
  const aReader = new BlockLogReader({
    chain: 'arbitrum',
    client: aClient,
    dir: cfg.stateDir,
    source: 'arbitrum',
    startBlock: arb.startBlock,
    confirmations: cfg.arbConfirmations,
    chunk: 1000,
    maxChunks: 8,
    first: [{ source: 'case', address: arb.case, abi: caseAbi }],
  });

  const chains = new LiveChains({
    hedera: { client: hClient, claims: hed.claims, vault: hed.vault, offRamp: hed.offRamp, events: hEvents, sender: hSender },
    arbitrum: {
      client: aClient,
      chainId: arb.chainId,
      case: arb.case,
      klerosCore: arb.klerosCore,
      evidenceModule: arb.evidenceModule,
      offRamp: arb.offRamp,
      reader: aReader,
      sender: aSender,
      ...(arb.disputeKit ? { disputeKit: arb.disputeKit } : {}),
      ...(arb.sortitionModule ? { sortitionModule: arb.sortitionModule } : {}),
    },
    gasFloors: DEFAULT_GAS_FLOORS,
    log,
  });

  // Documents are read like every service on this host reads them: the local content store first
  // (IPFS_PIN_API_URL=file://...), then the gateway. A miss is "not there yet".
  let ipfs: IpfsOptions | undefined;
  try {
    ipfs = ipfsOptionsFromEnv(process.env);
  } catch (err) {
    log(`warning: ${err instanceof Error ? err.message : String(err)}; evidence cannot be built and cases open without it near the deadline`);
  }
  const evidence = evidenceAssembler({
    ...(cfg.precheckUrl ? { precheckUrl: cfg.precheckUrl } : {}),
    fetchDoc: async (cid) => {
      const hash = hashOfCid(cid);
      if (ipfs === undefined || !hash) return null;
      try {
        return await fetchDocument(cid, hash, ipfs);
      } catch {
        return null;
      }
    },
    rawCidOfHash,
    build: buildEvidence as unknown as BuildEvidence,
  });

  const alerter = new Alerter({ service: 'keeper', append, log, ...(cfg.alertUrl ? { url: cfg.alertUrl } : {}) });
  const courtLink = (id: string) => cfg.courtUrlTemplate.replace('{id}', id);
  const keeper = new Keeper({
    chains,
    journal,
    alerter,
    stateDir: cfg.stateDir,
    evidence,
    windows: cfg.windows,
    timing: { refileHoldS: cfg.refileHoldS },
    floors: cfg.floors,
    log,
    links: { courtCase: courtLink },
    vaultToken: hed.token,
    compactAtBytes: cfg.compactAtBytes,
  });
  keeper.start();

  // A tick that has not come back in four poll intervals (two minutes at least) is a stuck keeper.
  const staleAfterS = Math.max(120, Math.ceil((4 * cfg.pollMs) / 1000));
  const health = () =>
    jsonSafe({
      service: 'keeper',
      ...keeper.status(staleAfterS),
      dryRun,
      hederaFile: hed.file,
      arbitrumFile: arb.file,
      opsHedera: chains.opsHedera,
      opsArb: chains.opsArb,
      openIntents: [...hSender.intentStatus(), ...aSender.intentStatus()].map((i) => ({
        chain: i.chain,
        call: i.call,
        claimId: i.claimId,
        hash: i.hash,
        nonce: i.nonce,
        ageS: i.ageS,
        rejections: i.rejections,
        ...(i.reason ? { reason: i.reason } : {}),
        ...(i.lastError ? { lastError: i.lastError } : {}),
      })),
      sendCooldownUntil: { hedera: hSender.cooldownUntil || undefined, arbitrum: aSender.cooldownUntil || undefined },
      alerts: keeper.alertBacklog(),
      ...keeper.health,
      cursors: { hedera: hReader.position, arbitrum: aReader.position },
    }) as Record<string, unknown>;

  if (once) {
    await keeper.tick();
    log(JSON.stringify(health()));
    journal.close();
    return;
  }

  const server = await listenKeeper(
    createKeeperApp({
      health,
      healthStatus: () => (keeper.status(staleAfterS).ok ? 200 : 503),
      claim: (id) => keeper.view(id) as Record<string, unknown> | undefined,
    }),
    cfg.port,
  );
  log(JSON.stringify({ event: 'started', port: cfg.port, dryRun, hederaFile: hed.file, arbitrumFile: arb.file }));
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  while (!stopping) {
    const started = Date.now();
    await keeper.tick();
    const wait = Math.max(0, cfg.pollMs - (Date.now() - started));
    for (let waited = 0; waited < wait && !stopping; waited += 250) await new Promise((r) => setTimeout(r, Math.min(250, wait - waited)));
  }
  server.close();
  journal.close();
  log('stopped');
}

const TRUSTED_RELAY = [{ type: 'function', name: 'trustedRelay', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] }] as const;

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
