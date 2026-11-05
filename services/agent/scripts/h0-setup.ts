// One-time setup on Hedera testnet: the HCS `records` topic and the ERC-8004 identities of the
// agent company (platform key) and the shop (shop key). Dry run by default: it checks accounts
// and simulates the registrations, and sends nothing. `--broadcast` sends.
//
//   pnpm --filter @recourse/agent h0-setup                 # checks only
//   pnpm --filter @recourse/agent h0-setup --broadcast     # create topic, register both identities
//   pnpm --filter @recourse/agent h0-setup --broadcast --update-uris
//                                                          # point agentURIs at the current URLs
//
// Idempotent: ids already in packages/records/h0-ids.json are read back (topic on the mirror node,
// agent owner on chain) and never created again. The file is rewritten after each step. At the end
// the ids go where the services read them: HCS_RECORDS_TOPIC_ID into the env file
// (RECOURSE_ENV_FILE, default ~/.config/recourse/recourse.env) and each agentId into the party map
// (PARTIES_FILE), once that file exists. A dry run prints those changes instead.
//
// Topic: memo `recourse.records.v1`, no admin key and no submit key (the agent and the shop both
// write to it; readers filter by payer account). Paid by the ops account.
// agentURI: the shop's `<SHOP_PUBLIC_URL>/.well-known/agent-registration.json` when the public URL
// is set; otherwise an inline `data:application/json;base64,` document, changed later with
// `--update-uris`. The agent company's is inline until a pinned document exists.

import { parseArgs } from 'node:util';
import { Client, PrivateKey, TopicCreateTransaction } from '@hiero-ledger/sdk';
import { createPublicClient, createWalletClient, http, parseEventLogs, type Address, type Hex, type PrivateKeyAccount } from 'viem';
import { hederaTestnet } from 'viem/chains';
import { accountIdOf, addressBook, erc8004IdentityAbi } from '@recourse/shared';
import { loadKeyBytes, loadSigner } from '@recourse/shared/node';
import {
  MirrorClient,
  RECORDS_TOPIC_MEMO,
  accountIdsFromEnv,
  agentCompanyRegistration,
  checkAccount,
  describeCheck,
  displayNameOf,
  publishIds,
  readH0Ids,
  shopRegistration,
  toDataUri,
  writeH0Ids,
  type AccountCheck,
  type H0Agent,
  type H0Ids,
} from '@recourse/records';

const HBAR = 100_000_000n;
const IDENTITY = addressBook.hedera.erc8004Identity;

type Env = Record<string, string | undefined>;

interface RunMode {
  broadcast: boolean;
  updateUris: boolean;
}

function now(): string {
  return new Date().toISOString();
}

function shopUri(env: Env, payTo: string, agentId?: string): { uri: string; kind: string } {
  if (env.SHOP_PUBLIC_URL) {
    return { uri: `${env.SHOP_PUBLIC_URL.replace(/\/+$/, '')}/.well-known/agent-registration.json`, kind: 'https' };
  }
  const base = (env.SHOP_BASE_URL || `http://127.0.0.1:${env.SHOP_PORT || '8720'}`).replace(/\/+$/, '');
  const doc = shopRegistration({
    name: displayNameOf('shop', env),
    x402BaseUrl: `${base}/x402/`,
    payTo,
    asset: addressBook.hedera.usdc.tokenId,
    network: 'hedera:testnet',
    ...(agentId ? { agentId } : {}),
  });
  return { uri: toDataUri(doc), kind: 'data' };
}

function platformUri(env: Env, agentId?: string): { uri: string; kind: string } {
  const doc = agentCompanyRegistration({ name: displayNameOf('platform', env), ...(agentId ? { agentId } : {}) });
  return { uri: toDataUri(doc), kind: 'data' };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { broadcast: { type: 'boolean', default: false }, 'update-uris': { type: 'boolean', default: false } },
  });
  const mode: RunMode = { broadcast: values.broadcast ?? false, updateUris: values['update-uris'] ?? false };
  const env = process.env;
  console.log(mode.broadcast ? 'h0-setup: BROADCAST (transactions will be sent)' : 'h0-setup: dry run (nothing is sent)');

  const known = accountIdsFromEnv(env);
  // Required here: the senders and the agent (the platform's record writer). The facilitator is
  // optional: without an account it is reported and left out of the setup ids.
  const ids = {
    'ops-hedera': accountIdOf(known, 'ops-hedera'),
    platform: accountIdOf(known, 'platform'),
    shop: accountIdOf(known, 'shop'),
    agent: accountIdOf(known, 'agent'),
  };
  const facilitatorId = known.facilitator;
  const rpcUrl = env.HEDERA_RPC_URL_1;
  if (!rpcUrl) throw new Error('HEDERA_RPC_URL_1: not set');
  const mirror = new MirrorClient(env.HEDERA_MIRROR_URL || addressBook.hedera.mirrorUrl);

  const platform = loadSigner('PLATFORM_KEY_FILE', env);
  const shop = loadSigner('SHOP_KEY_FILE', env);
  const agentAddress = loadSigner('AGENT_KEY_FILE', env).address;
  const facilitatorAddress = facilitatorId === undefined ? undefined : loadSigner('FACILITATOR_KEY_FILE', env).address;

  // Accounts this script sends from must pass; the others are reported for the payment check.
  const fatal = await Promise.all([
    checkAccount(mirror, { role: 'ops-hedera', accountId: ids['ops-hedera'], minTinybar: 1n * HBAR }),
    checkAccount(mirror, { role: 'platform', accountId: ids.platform, minTinybar: 1n * HBAR, evmAddress: platform.address }),
    checkAccount(mirror, { role: 'shop', accountId: ids.shop, minTinybar: 1n * HBAR, evmAddress: shop.address }),
  ]);
  const report = await Promise.all([
    checkAccount(mirror, { role: 'agent', accountId: ids.agent, minTinybar: 1n * HBAR, evmAddress: agentAddress, usdc: { minBalance: 1n } }),
    checkAccount(mirror, { role: 'shop (usdc)', accountId: ids.shop, usdc: {} }),
    checkAccount(mirror, { role: 'platform (usdc)', accountId: ids.platform, usdc: {} }),
    ...(facilitatorId !== undefined && facilitatorAddress !== undefined
      ? [checkAccount(mirror, { role: 'facilitator', accountId: facilitatorId, minTinybar: 1n * HBAR, evmAddress: facilitatorAddress })]
      : []),
  ]);
  for (const c of fatal) console.log(`check ${describeCheck(c)}`);
  for (const c of report) console.log(`info  ${describeCheck(c)}`);
  if (facilitatorId === undefined) console.log('info  facilitator: no account id in HEDERA_ACCOUNT_IDS; skipped');
  const failed: AccountCheck[] = fatal.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.error(`h0-setup: stopped: ${failed.map((c) => `${c.role} ${c.failures.join('+')}`).join('; ')}`);
    return 2;
  }

  const existing = readH0Ids();
  const out: H0Ids = existing ?? { v: 1, network: 'hedera:testnet', chainId: 296, agents: {}, parties: [] };
  out.parties = [
    { role: 'platform', evmAddress: platform.address, hederaAccountId: ids.platform, hcsWriters: [ids.agent] },
    { role: 'agent', evmAddress: agentAddress, hederaAccountId: ids.agent, hcsWriters: [] },
    { role: 'shop', evmAddress: shop.address, hederaAccountId: ids.shop, hcsWriters: [ids.shop] },
    ...(facilitatorId !== undefined && facilitatorAddress !== undefined
      ? [{ role: 'facilitator' as const, evmAddress: facilitatorAddress, hederaAccountId: facilitatorId, hcsWriters: [] }]
      : []),
  ];
  const save = () => {
    if (mode.broadcast) writeH0Ids(out);
  };

  // --- topic ---
  if (out.topic) {
    const t = await mirror.topic(out.topic.topicId);
    if (!t) throw new Error(`topic ${out.topic.topicId} is in h0-ids.json but not on the mirror node`);
    if (t.memo !== RECORDS_TOPIC_MEMO || t.hasSubmitKey || t.hasAdminKey || t.deleted) {
      throw new Error(`topic ${t.topicId} does not match: memo=${t.memo} submitKey=${t.hasSubmitKey} adminKey=${t.hasAdminKey} deleted=${t.deleted}`);
    }
    console.log(`topic ${t.topicId}: exists, memo ${t.memo}, no admin key, no submit key`);
  } else if (!mode.broadcast) {
    console.log(`topic: would create (memo ${RECORDS_TOPIC_MEMO}, no admin key, no submit key) paid by ops-hedera ${ids['ops-hedera']}`);
  } else {
    out.topic = await createTopic(ids['ops-hedera'], env);
    save();
    console.log(`topic ${out.topic.topicId}: created, tx ${out.topic.txId}`);
  }

  // --- identities ---
  const publicClient = createPublicClient({ chain: hederaTestnet, transport: http(rpcUrl, { timeout: 60_000 }) });
  const chainId = await publicClient.getChainId();
  if (chainId !== addressBook.hedera.chainId) throw new Error(`HEDERA_RPC_URL_1: chain id ${chainId}, expected 296`);

  for (const [role, account] of [
    ['platform', platform],
    ['shop', shop],
  ] as const) {
    const current = out.agents[role];
    const desired = role === 'shop' ? shopUri(env, ids.shop, current?.agentId) : platformUri(env, current?.agentId);
    if (current) {
      const owner = (await publicClient.readContract({
        address: IDENTITY,
        abi: erc8004IdentityAbi,
        functionName: 'ownerOf',
        args: [BigInt(current.agentId)],
      })) as Address;
      if (owner.toLowerCase() !== account.address.toLowerCase()) {
        throw new Error(`${role} agent ${current.agentId}: owner ${owner} is not ${account.address}`);
      }
      const uri = (await publicClient.readContract({
        address: IDENTITY,
        abi: erc8004IdentityAbi,
        functionName: 'tokenURI',
        args: [BigInt(current.agentId)],
      })) as string;
      console.log(`${role} agent ${current.agentId}: exists, owner ${owner}, uri ${describeUri(uri)}`);
      if (mode.updateUris && uri !== desired.uri) {
        if (!mode.broadcast) {
          console.log(`${role}: would set agentURI to ${describeUri(desired.uri)}`);
        } else {
          const txHash = await sendSetUri(publicClient, rpcUrl, account, BigInt(current.agentId), desired.uri);
          current.agentUri = desired.uri;
          current.uriKind = desired.kind;
          current.uriUpdates = [...(current.uriUpdates ?? []), { agentUri: desired.uri, txHash, at: now() }];
          save();
          console.log(`${role}: agentURI updated, tx ${txHash}`);
        }
      }
      continue;
    }
    if (desired.kind === 'data') console.log(`${role}: no public URL, using an inline data: agentURI (change later with --update-uris)`);
    const gas = await publicClient.estimateContractGas({
      address: IDENTITY,
      abi: erc8004IdentityAbi,
      functionName: 'register',
      args: [desired.uri],
      account: account.address,
    });
    if (!mode.broadcast) {
      console.log(`${role}: would register from ${account.address} (estimated gas ${gas}), uri ${describeUri(desired.uri)}`);
      continue;
    }
    const registered = await sendRegister(publicClient, rpcUrl, account, desired.uri, gas);
    out.agents[role] = { ...registered, uriKind: desired.kind };
    save();
    console.log(`${role} agent ${registered.agentId}: registered, tx ${registered.txHash}`);
  }

  if (mode.broadcast) {
    save();
    console.log('h0-ids.json written');
  }
  const published = publishIds(out, { env, write: mode.broadcast });
  for (const c of published.changes) console.log(`${mode.broadcast ? 'wrote' : 'would write'} ${c}`);
  for (const p of published.pending) console.log(`pending: ${p}`);
  if (!mode.broadcast) console.log('dry run complete; rerun with --broadcast to send');
  return 0;
}

async function createTopic(opsAccountId: string, env: Env) {
  const bytes = loadKeyBytes('OPS_HEDERA_KEY_FILE', env);
  let key: PrivateKey;
  try {
    key = PrivateKey.fromBytesECDSA(bytes);
  } finally {
    bytes.fill(0);
  }
  const client = Client.forTestnet().setOperator(opsAccountId, key);
  try {
    const response = await new TopicCreateTransaction().setTopicMemo(RECORDS_TOPIC_MEMO).execute(client);
    const receipt = await response.getReceipt(client);
    if (!receipt.topicId) throw new Error('topic create: receipt has no topic id');
    return {
      topicId: receipt.topicId.toString(),
      memo: RECORDS_TOPIC_MEMO,
      adminKey: null,
      submitKey: null,
      txId: response.transactionId.toString(),
      createdAt: now(),
    } as const;
  } finally {
    client.close();
  }
}

type Pub = ReturnType<typeof createPublicClient>;

async function sendRegister(
  publicClient: Pub,
  rpcUrl: string,
  account: PrivateKeyAccount,
  uri: string,
  gasEstimate: bigint,
): Promise<Omit<H0Agent, 'uriKind'>> {
  const wallet = createWalletClient({ account, chain: hederaTestnet, transport: http(rpcUrl, { timeout: 60_000 }) });
  const gasPrice = await publicClient.getGasPrice();
  const txHash = await wallet.writeContract({
    address: IDENTITY,
    abi: erc8004IdentityAbi,
    functionName: 'register',
    args: [uri],
    gas: (gasEstimate * 13n) / 10n,
    gasPrice,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error(`register reverted, tx ${txHash}`);
  const logs = parseEventLogs({ abi: erc8004IdentityAbi, logs: receipt.logs, eventName: 'Registered' });
  const log = logs.find((l) => l.address.toLowerCase() === IDENTITY.toLowerCase());
  if (!log) throw new Error(`register: no Registered event in tx ${txHash}`);
  return {
    agentId: log.args.agentId.toString(),
    owner: account.address,
    agentUri: uri,
    txHash,
    registeredAt: now(),
  };
}

async function sendSetUri(publicClient: Pub, rpcUrl: string, account: PrivateKeyAccount, agentId: bigint, uri: string): Promise<Hex> {
  const wallet = createWalletClient({ account, chain: hederaTestnet, transport: http(rpcUrl, { timeout: 60_000 }) });
  const gas = await publicClient.estimateContractGas({
    address: IDENTITY,
    abi: erc8004IdentityAbi,
    functionName: 'setAgentURI',
    args: [agentId, uri],
    account: account.address,
  });
  const txHash = await wallet.writeContract({
    address: IDENTITY,
    abi: erc8004IdentityAbi,
    functionName: 'setAgentURI',
    args: [agentId, uri],
    gas: (gas * 13n) / 10n,
    gasPrice: await publicClient.getGasPrice(),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error(`setAgentURI reverted, tx ${txHash}`);
  return txHash;
}

function describeUri(uri: string): string {
  return uri.startsWith('data:') ? `data: (${uri.length} chars)` : uri;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`h0-setup: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
