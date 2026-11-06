// The demo cast's identities on Hedera testnet, from ops/cast/cast.json: for each new shop and agent
// company, a key in KEYSTORE_DIR, a Hedera account the deployer creates and funds, an ERC-8004
// identity with its registration document, its entries in the party map, and for each agent company
// the mock USDC deposit the vault requires of it. Dry run by default: it reads what exists, prints
// the plan and what it costs, and sends nothing. `--send` sends, step by step.
//
//   set -a; . ~/.config/recourse/recourse.env; set +a
//   node --import tsx ops/cast/setup.ts [--send] [--only <shop or company id>]
//
// Idempotent: each step is journaled in CAST_STATE_DIR (default ~/.local/state/recourse/cast) and
// read back before it is sent again (the key file, the account on the mirror node; over
// HEDERA_RPC_URL_1 the registration, balances, the deposit and the requirement), so a rerun skips
// what exists. A register tx is signed here and journaled with its hash before it is broadcast; a
// rerun reads that tx's receipt for the agent id, and registers again only while the registry
// holds no identity of that owner. While HEDERA_RPC_URL_1 does not answer, a dry run says so and
// still prints the plan from the journal, and a send makes the keys and accounts (mirror node and
// the Hedera SDK only) and stops before the EVM steps.
//
// Keys: one per identity, `$KEYSTORE_DIR/cast-<shop>.json`, `cast-<company>-platform.json` and
// `cast-<company>-agent.json`, Foundry v3 keystores made by `cast wallet new` with the password in
// its environment (as ops/wire/rehearse.sh makes them), mode 0600, the password in `<file>.pass`
// (0600). A key is read only through loadSigner and loadKeyBytes and never printed.
//
// Registration documents: the repo's own (agentCompanyRegistration and shopRegistration in
// @recourse/records, as h0-setup registers agents 149 and 150) with the cast's description and one
// more object, `recourse`: { role, kind, label, summary }. They go on chain inline, as a
// `data:application/json;base64,` agentURI; a shop's x402 endpoint is the loopback port that
// ops/cast/orders.sh runs it on for an order (with_shop), since a cast shop runs no service of its
// own (live-order --local-shop runs it on a random port instead).
//
// The party map gains, at its end, one shop entry per shop (its own account as its hcsWriter) and a
// platform and an agent entry per company (the agent's account as the platform's hcsWriter), the
// shape agents 149 and 150 have. Once a role has several parties, every process picks its own with
// RECOURSE_SHOP_ADDRESS, RECOURSE_PLATFORM_ADDRESS and RECOURSE_AGENT_ADDRESS; `--send` refuses to
// add a second party of a role until recourse.env sets that role's variable for the running services.

import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { Abi, TransactionReceipt } from 'viem';
import {
  PARTY_SELECTORS,
  TINYBAR_PER_MICRO_USDC,
  addressBook,
  erc8004IdentityAbi,
  parseParties,
  partyWithRole,
  priceAssetIdOf,
  priceAssetOf,
  type Party,
} from '../../packages/shared/src/index.ts';
import { loadKeyBytes, loadSigner } from '../../packages/shared/src/node/index.ts';
import { agentCompanyRegistration, shopRegistration, toDataUri } from '../../packages/records/src/index.ts';
import { loadAbi, readHederaDeployment } from '../../services/shop/src/chain.ts';

// viem and the Hedera SDK come from the agent's own dependencies: ops/ has no node_modules.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const agentRequire = createRequire(join(ROOT, 'services/agent/package.json'));
const viem = agentRequire('viem') as typeof import('viem');
const { hederaTestnet } = agentRequire('viem/chains') as typeof import('viem/chains');
const sdk = agentRequire('@hiero-ledger/sdk') as typeof import('@hiero-ledger/sdk');

type Env = Record<string, string | undefined>;
type Address = `0x${string}`;
type Hex = `0x${string}`;
type Role = 'shop' | 'platform' | 'agent';

const HBAR = 100_000_000n;
const IDENTITY = addressBook.hedera.erc8004Identity;
/** Fees the deployer pays per step, measured on testnet (docs/keys.md) or rounded up from a similar call. */
const FEE_TINYBAR = { accountCreate: 80_000_000n, mint: 20_000_000n, setRequired: 20_000_000n };
/** Fees an identity pays from its own balance: register measured on agent 149's (gas 453986 used). */
const OWN_FEE_TINYBAR = { register: 80_000_000n, deposit: 60_000_000n };
const mockMintAbi = viem.parseAbi(['function mint(address to, uint256 amount)']);
/** The identity registry is an ERC-721: an owner's balance counts the identities it holds. */
const registryBalanceAbi = viem.parseAbi(['function balanceOf(address owner) view returns (uint256)']);

interface CastFile {
  shops: { id: string; name: string; description: string; recourse: Recourse; port: number; hbar: string; usdc: string; catalogue: { sku: string; unitUsdc: string }[] }[];
  agentCompanies: { id: string; name: string; agentName: string; description: string; recourse: Recourse; hbar: { platform: string; agent: string }; depositUsdc: string }[];
  orders: { id: string; company: string; shop: string; sku: string }[];
}
interface Recourse {
  role: 'shop' | 'platform';
  kind: string;
  label: string;
  summary: string;
}

interface Identity {
  /** Key file stem in KEYSTORE_DIR and the journal's key. */
  key: string;
  role: Role;
  displayName: string;
  /** The shop or company id in cast.json. */
  castId: string;
  hbar: bigint;
  /** mUSDC the deployer mints to it: a shop's court fees, a platform's deposit. */
  usdc: bigint;
  registration?: (accountId: string) => object;
}

interface Known {
  address?: Address;
  accountId?: string;
  agentId?: string;
  done: Set<string>;
}

function hbarOf(text: string, at: string): bigint {
  if (!/^\d+(\.\d{1,8})?$/.test(text)) throw new Error(`${at}: expected HBAR as a decimal`);
  const [i, f = ''] = text.split('.') as [string, string?];
  return BigInt(i) * HBAR + BigInt(f.padEnd(8, '0'));
}

function fmtHbar(tinybar: bigint): string {
  return `${tinybar / HBAR}.${(tinybar % HBAR).toString().padStart(8, '0').replace(/0{1,6}$/, '')}`;
}

function fmtUsdc(micro: bigint): string {
  return `${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, '0').replace(/0{1,4}$/, '')}`;
}

function identitiesOf(cast: CastFile, env: Env): Identity[] {
  const hbarOrders = priceAssetOf(env) === 'hbar';
  const priceOf = (shopId: string, sku: string) => {
    const item = cast.shops.find((s) => s.id === shopId)?.catalogue.find((i) => i.sku === sku);
    if (!item) throw new Error(`cast.json: order for ${shopId}/${sku}: no such item`);
    return BigInt(item.unitUsdc);
  };
  const out: Identity[] = [];
  for (const s of cast.shops) {
    out.push({
      key: `cast-${s.id}`,
      role: 'shop',
      displayName: s.name,
      castId: s.id,
      hbar: hbarOf(s.hbar, `shops.${s.id}.hbar`),
      usdc: BigInt(s.usdc),
      registration: (accountId) => ({
        ...shopRegistration({ name: s.name, x402BaseUrl: `http://127.0.0.1:${s.port}/x402/`, payTo: accountId, asset: priceAssetIdOf(priceAssetOf(env)), network: 'hedera:testnet' }),
        description: s.description,
        recourse: s.recourse,
      }),
    });
  }
  for (const c of cast.agentCompanies) {
    // Paying in HBAR, the agent also holds the price of each of its planned orders.
    const orders = cast.orders.filter((o) => o.company === c.id).reduce((sum, o) => sum + priceOf(o.shop, o.sku), 0n);
    out.push({
      key: `cast-${c.id}-platform`,
      role: 'platform',
      displayName: c.name,
      castId: c.id,
      hbar: hbarOf(c.hbar.platform, `agentCompanies.${c.id}.hbar.platform`),
      usdc: BigInt(c.depositUsdc),
      registration: () => ({ ...agentCompanyRegistration({ name: c.name }), description: c.description, recourse: c.recourse }),
    });
    out.push({
      key: `cast-${c.id}-agent`,
      role: 'agent',
      displayName: c.agentName,
      castId: c.id,
      hbar: hbarOf(c.hbar.agent, `agentCompanies.${c.id}.hbar.agent`) + (hbarOrders ? orders * TINYBAR_PER_MICRO_USDC : 0n),
      usdc: 0n,
    });
  }
  return out;
}

class CastJournal {
  readonly path: string;
  private readonly rows: { key: string; step: string; [k: string]: unknown }[] = [];
  constructor(dir: string, private readonly write: boolean) {
    this.path = join(dir, 'journal.jsonl');
    if (existsSync(this.path)) {
      for (const line of readFileSync(this.path, 'utf8').split('\n')) if (line.trim() !== '') this.rows.push(JSON.parse(line));
    }
  }
  known(key: string): Known {
    const k: Known = { done: new Set() };
    for (const r of this.rows.filter((r) => r.key === key)) {
      k.done.add(r.step);
      if (typeof r.address === 'string') k.address = r.address as Address;
      if (typeof r.accountId === 'string') k.accountId = r.accountId;
      if (typeof r.agentId === 'string') k.agentId = r.agentId;
    }
    return k;
  }
  /** A row of this step for this key whose fields hold these values (a mint of this token, a deposit in this vault). */
  has(key: string, step: string, match: Record<string, string>): boolean {
    return this.rows.some((r) => r.key === key && r.step === step && Object.entries(match).every(([f, v]) => String(r[f]).toLowerCase() === v.toLowerCase()));
  }
  /** The tx hashes of this key's rows of this step, oldest first. */
  txHashes(key: string, step: string): Hex[] {
    return this.rows.filter((r) => r.key === key && r.step === step && typeof r.txHash === 'string').map((r) => r.txHash as Hex);
  }
  add(key: string, step: string, data: Record<string, unknown>): void {
    const row = { at: new Date().toISOString(), key, step, ...data };
    this.rows.push(row);
    if (this.write) appendFileSync(this.path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  }
}

async function mirrorAccount(mirror: string, address: string): Promise<{ accountId: string; tinybar: bigint } | null> {
  const res = await fetch(`${mirror}/api/v1/accounts/${address}`, { signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`mirror node: ${res.status} reading ${address}`);
  const j = (await res.json()) as { account: string; balance: { balance: number | string } };
  return { accountId: j.account, tinybar: BigInt(j.balance.balance) };
}

function keyEnv(dir: string, key: string): Env {
  return { CAST_KEY_FILE: join(dir, `${key}.json`) };
}

/** A new Foundry v3 keystore and its password file, both 0600. Nothing about the key is printed. */
function createKey(dir: string, key: string): void {
  const file = join(dir, `${key}.json`);
  const pass = `${file}.pass`;
  if (!existsSync(pass)) writeFileSync(pass, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  chmodSync(pass, 0o600);
  const r = spawnSync('cast', ['wallet', 'new', dir, `${key}.json`], {
    env: { ...process.env, CAST_PASSWORD: readFileSync(pass, 'utf8').trim() },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (r.status !== 0 || !existsSync(file)) throw new Error(`${key}: cast wallet new failed (${String(r.stderr ?? '').split('\n')[0]?.slice(0, 160)})`);
  chmodSync(file, 0o600);
}

async function createAccount(env: Env, deployerId: string, dir: string, key: string, tinybar: bigint): Promise<{ accountId: string; txId: string }> {
  const opBytes = loadKeyBytes('DEPLOYER_KEY_FILE', env);
  const newBytes = loadKeyBytes('CAST_KEY_FILE', keyEnv(dir, key));
  let operator: InstanceType<typeof sdk.PrivateKey>;
  let fresh: InstanceType<typeof sdk.PrivateKey>;
  try {
    operator = sdk.PrivateKey.fromBytesECDSA(opBytes);
    fresh = sdk.PrivateKey.fromBytesECDSA(newBytes);
  } finally {
    opBytes.fill(0);
    newBytes.fill(0);
  }
  const client = sdk.Client.forTestnet().setOperator(deployerId, operator);
  try {
    // The alias makes the account's EVM address the key's own, as an account created by a value
    // transfer has; -1 auto-associations as for the other roles' accounts.
    const tx = await new sdk.AccountCreateTransaction()
      .setECDSAKeyWithAlias(fresh.publicKey)
      .setInitialBalance(sdk.Hbar.fromTinybars(tinybar.toString()))
      .setMaxAutomaticTokenAssociations(-1)
      .freezeWith(client)
      .sign(fresh);
    const response = await tx.execute(client);
    const receipt = await response.getReceipt(client);
    if (!receipt.accountId) throw new Error(`${key}: account create receipt has no account id`);
    return { accountId: receipt.accountId.toString(), txId: response.transactionId.toString() };
  } finally {
    client.close();
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { send: { type: 'boolean', default: false }, only: { type: 'string' } } });
  const send = values.send ?? false;
  const env: Env = process.env;
  console.log(send ? 'cast setup: SEND (accounts, registrations and deposits on Hedera testnet)' : 'cast setup: dry run (nothing is created or sent)');

  const cast = JSON.parse(readFileSync(join(ROOT, 'ops/cast/cast.json'), 'utf8')) as CastFile;
  const keystoreDir = env.KEYSTORE_DIR || join(homedir(), '.config/recourse/keys');
  const stateDir = env.CAST_STATE_DIR || join(homedir(), '.local/state/recourse/cast');
  const partiesFile = env.PARTIES_FILE || join(ROOT, 'deployments/parties.json');
  const mirror = (env.HEDERA_MIRROR_URL || addressBook.hedera.mirrorUrl).replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  if (send) mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const journal = new CastJournal(stateDir, send);

  const parsed = parseParties(JSON.parse(readFileSync(partiesFile, 'utf8')));
  if (!parsed.ok) throw new Error(`PARTIES_FILE: ${parsed.error}`);
  const parties = parsed.value;
  const deployer = parties.find((p) => p.role === 'deployer');
  if (!deployer?.hederaAccountId) throw new Error('parties: the deployer has no hederaAccountId');
  const deployment = readHederaDeployment({ env });
  const mock = deployment.token.mode === 'mock';
  const minDeposit = BigInt((JSON.parse(readFileSync(deployment.file, 'utf8')) as { params?: { locked?: { minDeposit?: number } } }).params?.locked?.minDeposit ?? 0);

  const all = identitiesOf(cast, env);
  const identities = values.only ? all.filter((i) => i.castId === values.only) : all;
  if (identities.length === 0) throw new Error(`--only: no shop or company ${values.only} in cast.json`);
  for (const c of cast.agentCompanies) {
    if (BigInt(c.depositUsdc) < minDeposit) throw new Error(`cast.json: ${c.id} deposit ${c.depositUsdc} is below the vault's minDeposit ${minDeposit}`);
  }

  // The EVM side: identities, balances and the deposit. Hedera's relay can be down; say so and go on.
  const rpcUrl = env.HEDERA_RPC_URL_1;
  let rpcDown: string | null = rpcUrl ? null : 'HEDERA_RPC_URL_1 is not set';
  const publicClient = rpcUrl ? viem.createPublicClient({ chain: hederaTestnet, transport: viem.http(rpcUrl, { timeout: 20_000, retryCount: 0 }) }) : null;
  if (publicClient) {
    try {
      const id = await publicClient.getChainId();
      if (id !== addressBook.hedera.chainId) throw new Error(`HEDERA_RPC_URL_1: chain id ${id}, expected ${addressBook.hedera.chainId}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('HEDERA_RPC_URL_1: chain id')) throw error;
      rpcDown = `HEDERA_RPC_URL_1 does not answer (${shortError(error)})`;
    }
  }
  if (rpcDown) console.log(`note  Hedera EVM reads are down: ${rpcDown}. Registrations, balances and deposits are not read or simulated; the plan assumes the journal is right.`);
  const vaultAbi = loadAbi('DepositVault', env);

  type Reader = NonNullable<typeof publicClient>;
  /**
   * The identity an earlier register made, from the receipt of a journaled register tx; 'held' when
   * the registry holds an identity of this owner that no readable receipt names; null when it holds
   * none, so a register may be sent.
   */
  const registrationOf = async (pc: Reader, key: string, owner: Address): Promise<{ agentId: string; txHash: Hex } | 'held' | null> => {
    for (const hash of journal.txHashes(key, 'register_sent')) {
      let receipt: TransactionReceipt;
      try {
        receipt = await pc.getTransactionReceipt({ hash });
      } catch (error) {
        if (error instanceof viem.TransactionReceiptNotFoundError) continue;
        throw error;
      }
      const agentId = receipt.status === 'success' ? registeredId(receipt) : undefined;
      if (agentId) return { agentId, txHash: hash };
    }
    const held = await pc.readContract({ address: IDENTITY, abi: registryBalanceAbi, functionName: 'balanceOf', args: [owner] });
    return held > 0n ? 'held' : null;
  };
  /** What an identity's mUSDC still needs, read on chain: the mint, a platform's deposit, and whether its requirement is to be set. */
  const fundingOf = async (pc: Reader, i: Identity, holder: Address): Promise<{ mint: bigint; deposit: bigint; setRequired: boolean }> => {
    const balance = await pc.readContract({ address: deployment.usdc, abi: viem.erc20Abi, functionName: 'balanceOf', args: [holder] });
    // A shop's court fees are minted once per token; what it has spent on claims is not topped up.
    if (i.role !== 'platform') return { mint: journal.has(i.key, 'minted', { token: deployment.usdc }) ? 0n : atLeastZero(i.usdc - balance), deposit: 0n, setRequired: false };
    const held = (await pc.readContract({ address: deployment.vault, abi: vaultAbi, functionName: 'depositOf', args: [holder] })) as bigint;
    const required = (await pc.readContract({ address: deployment.vault, abi: vaultAbi, functionName: 'requiredOf', args: [holder] })) as bigint;
    return { mint: atLeastZero(i.usdc - held - balance), deposit: atLeastZero(i.usdc - held), setRequired: required !== i.usdc };
  };

  // --- plan and cost ---
  let fromDeployer = 0n;
  let fees = 0n;
  let minted = 0n;
  const lines: string[] = [];
  const state = new Map<string, Known>();
  for (const i of identities) {
    const k = journal.known(i.key);
    const file = join(keystoreDir, `${i.key}.json`);
    if (existsSync(file)) k.address = loadSigner('CAST_KEY_FILE', keyEnv(keystoreDir, i.key)).address;
    if (k.address && !k.accountId) {
      const a = await mirrorAccount(mirror, k.address);
      if (a) k.accountId = a.accountId;
    }
    state.set(i.key, k);
    const steps: string[] = [];
    if (!k.address) steps.push('create key');
    if (!k.accountId) {
      steps.push(`create account with ${fmtHbar(i.hbar)} HBAR`);
      fromDeployer += i.hbar;
      fees += FEE_TINYBAR.accountCreate;
    }
    // With the RPC up, the registration and funding are read on chain as --send reads them; else from the journal.
    const evm = publicClient && !rpcDown && k.address ? publicClient : null;
    if (i.registration && !k.agentId) {
      const back = evm
        ? await registrationOf(evm, i.key, k.address!).catch((error: unknown) => {
            steps.push(`(registration not read: ${shortError(error)})`);
            return undefined;
          })
        : undefined;
      const sent = journal.txHashes(i.key, 'register_sent');
      if (back === 'held') steps.push('stop: it holds an ERC-8004 identity that no journaled register tx names; --send will not register a second');
      else if (back) steps.push(`journal agent ${back.agentId}, registered by the earlier tx ${back.txHash}`);
      else if (back === undefined && sent.length > 0) steps.push(`read back the register tx ${sent.at(-1)} sent earlier, and register only if it made no identity`);
      else steps.push(`register in ERC-8004 (about ${fmtHbar(OWN_FEE_TINYBAR.register)} HBAR from its own balance)`);
    }
    if (i.usdc > 0n) {
      const f = evm && mock
        ? await fundingOf(evm, i, k.address!).catch((error: unknown) => {
            steps.push(`(balances not read: ${shortError(error)}; from the journal)`);
            return undefined;
          })
        : undefined;
      if (f) {
        if (f.mint > 0n) steps.push(`mint ${fmtUsdc(f.mint)} mUSDC${i.role === 'platform' ? '' : ' for court fees'}`);
        if (f.deposit > 0n) steps.push(`approve and postDeposit ${fmtUsdc(f.deposit)} mUSDC (deposit to ${fmtUsdc(i.usdc)})`);
        if (f.setRequired) steps.push(`setRequired ${fmtUsdc(i.usdc)}`);
        minted += f.mint;
        fees += (f.mint > 0n ? FEE_TINYBAR.mint : 0n) + (f.setRequired ? FEE_TINYBAR.setRequired : 0n);
      } else {
        // Mints and deposits count for the deployment they were made on: after a redeploy they are made again.
        const funded = i.role === 'platform' ? journal.has(i.key, 'deposited', { vault: deployment.vault }) : journal.has(i.key, 'minted', { token: deployment.usdc });
        if (!funded) {
          steps.push(i.role === 'platform' ? `mint ${fmtUsdc(i.usdc)} mUSDC, approve and postDeposit it, setRequired ${fmtUsdc(i.usdc)}` : `mint ${fmtUsdc(i.usdc)} mUSDC for court fees`);
          minted += i.usdc;
          fees += FEE_TINYBAR.mint + (i.role === 'platform' ? FEE_TINYBAR.setRequired : 0n);
        }
      }
    }
    lines.push(`${i.key.padEnd(24)} ${i.role.padEnd(8)} ${i.displayName}: ${k.address ?? '(no key yet)'} ${k.accountId ?? ''} ${k.agentId ? `agent ${k.agentId}` : ''}`);
    lines.push(`${''.padEnd(24)} ${steps.length > 0 ? `to do: ${steps.join('; ')}` : 'done'}`);
  }
  for (const l of lines) console.log(l);
  const deployerNow = await mirrorAccount(mirror, deployer.hederaAccountId).catch(() => null);
  console.log(`cost  from the deployer ${deployer.hederaAccountId}: ${fmtHbar(fromDeployer)} HBAR in initial balances + about ${fmtHbar(fees)} HBAR in fees; ${fmtUsdc(minted)} mUSDC minted${mock ? '' : ' (the vault is on Circle USDC: nothing can be minted, fund the platforms and shops by hand)'}`);
  console.log(`cost  each identity pays its own registration and deposit fees from its initial balance; the deployer holds ${deployerNow ? `${fmtHbar(deployerNow.tinybar)} HBAR` : '(mirror node did not answer)'}`);
  if (priceAssetOf(env) === 'usdc') console.log('note  PRICE_ASSET=usdc: the agents pay x402 orders in Circle USDC, which this script cannot mint or send');
  if (deployerNow && deployerNow.tinybar < fromDeployer + fees + 10n * HBAR) {
    console.log('stop  the deployer would keep under 10 HBAR for the redeploy and wiring');
    if (send) return 2;
  }

  // --- the selector guard: the running services must name their own party first ---
  const adding = new Set(identities.map((i) => i.role));
  // Set, and naming a party of that role already in the map (not a mistyped address the services would meet at restart).
  const unset = [...adding].filter((role) => parties.some((p) => p.role === role) && !partyWithRole(parties, role, env[PARTY_SELECTORS[role]] ?? ''));
  for (const role of unset) {
    const first = parties.find((p) => p.role === role)!;
    console.log(`guard ${PARTY_SELECTORS[role]} names no ${role} party of the party map: add ${PARTY_SELECTORS[role]}=${first.evmAddress} (${first.displayName}) to recourse.env before --send, so the running services keep their own ${role}`);
  }
  if (!send) {
    console.log('dry run complete; rerun with --send to send');
    return 0;
  }
  if (unset.length > 0) return 2;

  // --- send ---
  for (const i of identities) {
    const k = state.get(i.key)!;
    // A key or account that exists but is not journaled (a journal lost or moved) is journaled now.
    if (k.address && !k.done.has('key')) journal.add(i.key, 'key', { address: k.address, file: `${i.key}.json`, found: true });
    if (k.accountId && !k.done.has('account')) journal.add(i.key, 'account', { address: k.address, accountId: k.accountId, found: 'mirror' });
    if (!k.address) {
      createKey(keystoreDir, i.key);
      k.address = loadSigner('CAST_KEY_FILE', keyEnv(keystoreDir, i.key)).address;
      journal.add(i.key, 'key', { address: k.address, file: `${i.key}.json` });
      console.log(`${i.key}: key created, address ${k.address}`);
    }
    if (!k.accountId) {
      const created = await createAccount(env, deployer.hederaAccountId, keystoreDir, i.key, i.hbar);
      k.accountId = created.accountId;
      journal.add(i.key, 'account', { address: k.address, accountId: created.accountId, txId: created.txId, tinybar: i.hbar.toString() });
      console.log(`${i.key}: account ${created.accountId} with ${fmtHbar(i.hbar)} HBAR, tx ${created.txId}`);
      await waitForMirror(mirror, k.address);
    }
  }
  if (rpcDown) {
    console.log(`stop  ${rpcDown}: keys and accounts are done; rerun --send once it answers for the registrations and deposits`);
    return 2;
  }
  const pc = publicClient!;
  const gasPrice = await pc.getGasPrice();
  const wallet = (key: string, envName = 'CAST_KEY_FILE', from: Env = keyEnv(keystoreDir, key)) =>
    viem.createWalletClient({ account: loadSigner(envName, from), chain: hederaTestnet, transport: viem.http(rpcUrl, { timeout: 60_000 }) });
  const sendCall = async (w: ReturnType<typeof wallet>, call: { address: Address; abi: Abi; functionName: string; args: unknown[] }): Promise<{ hash: Hex; receipt: TransactionReceipt }> => {
    const gas = await pc.estimateContractGas({ ...call, account: w.account } as Parameters<typeof pc.estimateContractGas>[0]);
    const hash = await w.writeContract({ ...call, gas: (gas * 13n) / 10n, gasPrice } as Parameters<typeof w.writeContract>[0]);
    const receipt = await pc.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== 'success') throw new Error(`${call.functionName} reverted, tx ${hash}`);
    return { hash, receipt };
  };
  const deployerWallet = wallet('deployer', 'DEPLOYER_KEY_FILE', env);

  for (const i of identities) {
    const k = state.get(i.key)!;
    if (i.registration && !k.agentId) {
      const owner = k.address!;
      const doc = i.registration(k.accountId!);
      const uri = toDataUri(doc as Parameters<typeof toDataUri>[0]);
      // Read back first: a register sent by an earlier run whose answer or receipt was lost.
      const back = await registrationOf(pc, i.key, owner);
      if (back === 'held') {
        throw new Error(`${i.key}: ${owner} already holds an ERC-8004 identity, but no journaled register tx shows its agent id (yet); rerun later, or journal it as a "registered" row with its agentId, rather than register a second one`);
      }
      let hash: Hex;
      if (back) {
        hash = back.txHash;
        k.agentId = back.agentId;
        console.log(`${i.key}: agent ${k.agentId}, registered by the earlier tx ${hash}`);
      } else {
        const w = wallet(i.key);
        const call = { address: IDENTITY, abi: erc8004IdentityAbi as unknown as Abi, functionName: 'register', args: [uri] };
        const gas = await pc.estimateContractGas({ ...call, account: w.account } as Parameters<typeof pc.estimateContractGas>[0]);
        // Signed here, so its hash is journaled before the relay sees it and a rerun can read it back.
        const request = await w.prepareTransactionRequest({ to: IDENTITY, data: viem.encodeFunctionData(call), gas: (gas * 13n) / 10n, gasPrice } as Parameters<typeof w.prepareTransactionRequest>[0]);
        const serialized = await w.signTransaction(request as Parameters<typeof w.signTransaction>[0]);
        hash = viem.keccak256(serialized);
        journal.add(i.key, 'register_sent', { txHash: hash, nonce: request.nonce });
        const relayHash = await w.sendRawTransaction({ serializedTransaction: serialized });
        // The relay's own hash for the tx is journaled too if it differs, so a rerun reads either.
        if (relayHash.toLowerCase() !== hash.toLowerCase()) {
          journal.add(i.key, 'register_sent', { txHash: relayHash, nonce: request.nonce, from: 'relay' });
          hash = relayHash;
        }
        const receipt = await pc.waitForTransactionReceipt({ hash, timeout: 120_000 });
        if (receipt.status !== 'success') throw new Error(`register reverted, tx ${hash}`);
        const agentId = registeredId(receipt);
        if (!agentId) throw new Error(`${i.key}: no Registered event in tx ${hash}`);
        k.agentId = agentId;
        console.log(`${i.key}: agent ${k.agentId} registered, tx ${hash}`);
      }
      mkdirSync(join(stateDir, 'registrations'), { recursive: true });
      writeFileSync(join(stateDir, 'registrations', `${i.key}.json`), `${JSON.stringify(doc, null, 2)}\n`);
      journal.add(i.key, 'registered', { agentId: k.agentId, txHash: hash, ...(back ? { found: 'receipt' } : { agentUri: uri }) });
    }
    if (i.usdc > 0n && mock) {
      const holder = k.address!;
      // Read, not guessed: a failed read stops the run rather than minting or depositing twice.
      const { mint: short, deposit: need } = await fundingOf(pc, i, holder);
      if (short > 0n) {
        const { hash } = await sendCall(deployerWallet, { address: deployment.usdc, abi: mockMintAbi, functionName: 'mint', args: [holder, short] });
        journal.add(i.key, 'minted', { amount: short.toString(), token: deployment.usdc, txHash: hash });
        console.log(`${i.key}: minted ${fmtUsdc(short)} mUSDC, tx ${hash}`);
      }
      if (i.role === 'platform') {
        if (need > 0n) {
          const platform = wallet(i.key);
          const a = await sendCall(platform, { address: deployment.usdc, abi: viem.erc20Abi, functionName: 'approve', args: [deployment.vault, need] });
          const d = await sendCall(platform, { address: deployment.vault, abi: vaultAbi, functionName: 'postDeposit', args: [holder, need] });
          journal.add(i.key, 'deposited', { amount: need.toString(), vault: deployment.vault, approveTx: a.hash, txHash: d.hash });
          console.log(`${i.key}: deposited ${fmtUsdc(need)} mUSDC, tx ${d.hash}`);
        }
        const required = (await pc.readContract({ address: deployment.vault, abi: vaultAbi, functionName: 'requiredOf', args: [holder] })) as bigint;
        if (required !== i.usdc) {
          const { hash } = await sendCall(deployerWallet, { address: deployment.vault, abi: vaultAbi, functionName: 'setRequired', args: [holder, i.usdc] });
          journal.add(i.key, 'required', { amount: i.usdc.toString(), vault: deployment.vault, txHash: hash });
          console.log(`${i.key}: setRequired ${fmtUsdc(i.usdc)} mUSDC, tx ${hash}`);
        }
      }
    }
  }

  // --- the party map ---
  const entries: Party[] = [];
  for (const i of all) {
    const k = journal.known(i.key);
    const addr = existsSync(join(keystoreDir, `${i.key}.json`)) ? loadSigner('CAST_KEY_FILE', keyEnv(keystoreDir, i.key)).address : undefined;
    if (!addr || !k.accountId || (i.registration && !k.agentId)) continue;
    const writer = i.role === 'shop' ? [k.accountId] : i.role === 'platform' ? [journal.known(`cast-${i.castId}-agent`).accountId] : [];
    if (writer.some((w) => w === undefined)) continue;
    entries.push({ role: i.role, evmAddress: addr, hederaAccountId: k.accountId, hcsWriters: writer as string[], ...(k.agentId ? { agentId: k.agentId } : {}), displayName: i.displayName });
  }
  const raw = JSON.parse(readFileSync(partiesFile, 'utf8')) as Party[];
  let changed = false;
  for (const e of entries) {
    const at = raw.findIndex((p) => p.evmAddress.toLowerCase() === e.evmAddress.toLowerCase());
    if (at < 0) {
      raw.push(e);
      changed = true;
    } else if (raw[at]!.role !== e.role) {
      throw new Error(`parties: ${e.evmAddress} is already a ${raw[at]!.role}`);
    } else if (JSON.stringify(raw[at]) !== JSON.stringify({ ...raw[at], ...e })) {
      raw[at] = { ...raw[at]!, ...e };
      changed = true;
    }
  }
  if (changed) {
    const check = parseParties(raw);
    if (!check.ok) throw new Error(`parties after the cast: ${check.error}`);
    const tmp = `${partiesFile}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o644 });
    renameSync(tmp, partiesFile);
    console.log(`wrote ${partiesFile}: ${entries.length} cast parties`);
  } else {
    console.log(`${partiesFile}: already holds every finished cast party`);
  }
  return 0;
}

async function waitForMirror(mirror: string, address: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (await mirrorAccount(mirror, address).catch(() => null)) return;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  console.log(`note  ${address} is not on the mirror node yet; a rerun reads it from the journal`);
}

/** The agent id in a register tx's Registered event, from the identity registry itself. */
function registeredId(receipt: TransactionReceipt): string | undefined {
  const logs = viem.parseEventLogs({ abi: erc8004IdentityAbi, logs: receipt.logs, eventName: 'Registered' });
  return logs.find((l) => l.address.toLowerCase() === IDENTITY.toLowerCase())?.args.agentId.toString();
}

function atLeastZero(n: bigint): bigint {
  return n > 0n ? n : 0n;
}

function shortError(error: unknown): string {
  // A keyed RPC URL can appear in a transport error: keep only the first line, cut at the first URL.
  const text = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
  return text.replace(/https?:\/\/\S+/g, '<url>').slice(0, 160);
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`cast setup: ${shortError(error)}`);
    process.exit(1);
  },
);
