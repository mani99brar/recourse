// The contest and withdraw-credit commands against the real contracts on a local anvil, run as
// separate processes the way an operator runs them: each asks a status API (the real one, in this
// process, over the local chain) to build the call, checks it, signs from a throwaway keystore of
// one of anvil's development keys (test funds only) and sends it to the chain. Slow (deploys once);
// run under the suite lock.

import { spawn } from 'node:child_process';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { erc20Abi, keccak256, type Abi, type Address, type Hex } from 'viem';
import { Answer, ClaimStatus, Gap, PARAMS, ZERO_HASH, newOrderNonce, type RecordRefs } from '@recourse/shared';
import { Journal, memoryLogger } from '@recourse/records';
import { chainClients, loadAbi, type ChainClients } from '../../shop/src/chain.js';
import { CallRefused, readClaim, readClaimParams, readCredit, simulateCall, type RecourseContracts } from '../../shop/src/claim-actions.js';
import { ClaimFiler, type FilingJournalRow } from '../../shop/src/filing.js';
import { devAccount, startLocalChain, type LocalChain } from '../../shop/src/local-chain.js';
import { withErrorsOf } from '../../shop/src/reverts.js';
import { startLocalApi, type LocalApi } from './local-api.js';

const PORT = 8579;
const FILE = 'lane04.local.json';
const AGENT_DIR = fileURLToPath(new URL('../', import.meta.url));
const TSX = join(AGENT_DIR, 'node_modules', '.bin', 'tsx');
const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

function refs(): RecordRefs {
  return { topicNum: 7000001n, seq: [11n, 12n, 13n, 14n, 15n, 0n], hashes: [H(1), H(2), H(3), H(4), H(5), ZERO_HASH] };
}

/** A Foundry-style v3 scrypt keystore (cheap KDF settings: a test key only). */
function writeKeystore(path: string, key: Uint8Array, password: string): void {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const n = 1024;
  const dk = scryptSync(password, salt, 32, { N: n, r: 8, p: 1 });
  const cipher = createCipheriv('aes-128-ctr', dk.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
  const mac = keccak256(Buffer.concat([dk.subarray(16, 32), ciphertext])).slice(2);
  const doc = {
    crypto: {
      cipher: 'aes-128-ctr',
      cipherparams: { iv: iv.toString('hex') },
      ciphertext: ciphertext.toString('hex'),
      kdf: 'scrypt',
      kdfparams: { dklen: 32, n, p: 1, r: 8, salt: salt.toString('hex') },
      mac,
    },
    id: '00000000-0000-4000-8000-000000000000',
    version: 3,
  };
  writeFileSync(path, JSON.stringify(doc), { mode: 0o600 });
  writeFileSync(`${path}.pass`, password, { mode: 0o600 });
}

let chain: LocalChain;
let keyDir: string;
let deploymentFile: string;
let contracts: RecourseContracts;
let shop: ChainClients;
let platformClients: ChainClients;
let signerClients: ChainClients;
let platform: Address;
let api: LocalApi;

/** Runs a command as its own process; not spawnSync, so the status API in this process can answer it. */
function cli(name: 'contest' | 'withdraw-credit', args: string[], envOverride: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(TSX, [join('scripts', `${name}.ts`), ...args, '--wait', '0'], {
    cwd: AGENT_DIR,
    env: {
      ...process.env,
      HEDERA_LOCAL_FILE: FILE,
      HEDERA_RPC_URL_1: chain.rpcUrl,
      STATUS_API_URL: api.url,
      PLATFORM_KEY_FILE: join(keyDir, 'platform.json'),
      SHOP_KEY_FILE: join(keyDir, 'shop.json'),
      ...envOverride,
    },
    timeout: 120_000,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
  child.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function fileAndPreCheck(answer: number): Promise<{ claimId: Hex; orderId: Hex }> {
  const filer = new ClaimFiler({
    clients: shop,
    claims: contracts.claims,
    vault: contracts.vault,
    usdc: chain.deployment.usdc,
    claimsAbi: contracts.claimsAbi,
    vaultAbi: contracts.vaultAbi,
    journal: Journal.open<FilingJournalRow>(join(mkdtempSync(join(tmpdir(), 'contest-')), 'claims.jsonl')),
    log: memoryLogger(),
    receiptTimeoutMs: 20_000,
  });
  const filed = await filer.fileClaim({ orderNonce: newOrderNonce(), platform, refs: refs(), basketUsdc: 2_000_000n, netLossUsdc: 1_500_000n });
  const hash = await signerClients.walletClient.writeContract({
    account: signerClients.account,
    chain: signerClients.chain,
    address: contracts.claims,
    abi: contracts.claimsAbi,
    functionName: 'recordPreCheck',
    args: [filed.claimId, Gap.AskedVsShown, answer, H(0xbeef)],
  });
  expect((await signerClients.publicClient.waitForTransactionReceipt({ hash })).status).toBe('success');
  return { claimId: filed.claimId, orderId: filed.orderId };
}

async function write(clients: ChainClients, address: Address, abi: Abi, functionName: string, args: unknown[]) {
  const hash = await clients.walletClient.writeContract({ account: clients.account, chain: clients.chain, address, abi, functionName, args });
  expect((await clients.publicClient.waitForTransactionReceipt({ hash })).status).toBe('success');
}

async function passTime(seconds: bigint): Promise<void> {
  await chain.rpc('evm_increaseTime', [Number(seconds)]);
  await chain.rpc('evm_mine');
}

const usdcOf = (who: Address) =>
  shop.publicClient.readContract({ address: chain.deployment.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [who] });

beforeAll(async () => {
  chain = await startLocalChain(PORT, { file: FILE });
  deploymentFile = chain.deployment.file;
  contracts = {
    claims: chain.deployment.claims,
    vault: chain.deployment.vault,
    claimsAbi: loadAbi('RecourseClaims'),
    vaultAbi: loadAbi('DepositVault'),
  };
  platform = chain.deployment.roles!.platform!;
  expect(devAccount(3).address).toBe(platform);
  expect(devAccount(4).address).toBe(chain.deployment.roles!.shop);
  const opts = { rpcUrl: chain.rpcUrl, chainId: chain.deployment.chainId };
  shop = chainClients({ ...opts, account: devAccount(4) });
  platformClients = chainClients({ ...opts, account: devAccount(3) });
  signerClients = chainClients({ ...opts, account: devAccount(2) });

  keyDir = mkdtempSync(join(tmpdir(), 'lane04-keys-'));
  writeKeystore(join(keyDir, 'platform.json'), devAccount(3).getHdKey().privateKey!, 'platform-test');
  writeKeystore(join(keyDir, 'shop.json'), devAccount(4).getHdKey().privateKey!, 'shop-test');
  api = await startLocalApi(chain.rpcUrl, deploymentFile);
}, 900_000);

afterAll(async () => {
  try {
    await api?.close();
    await chain?.stop();
  } finally {
    if (keyDir) rmSync(keyDir, { recursive: true, force: true });
  }
  expect(existsSync(deploymentFile)).toBe(false);
});

describe('contest and withdraw-credit on the local contracts', () => {
  let lapsed: { claimId: Hex; orderId: Hex };

  it('lets only the losing side contest, through the status API, and moves no USDC', async () => {
    const { claimId } = await fileAndPreCheck(Answer.Platform);
    lapsed = await fileAndPreCheck(Answer.Platform);

    const wrongSide = await cli('contest', ['--claim', claimId, '--as', 'shop']);
    expect(wrongSide.status).toBe(2);
    expect(wrongSide.stderr).toContain('contest: not_contester: Only the platform may contest this finding.');

    const wrongKey = await cli('contest', ['--claim', claimId, '--as', 'platform'], { PLATFORM_KEY_FILE: join(keyDir, 'shop.json') });
    expect(wrongKey.status).toBe(2);
    expect(wrongKey.stderr).toContain(`not_contester`);
    expect(wrongKey.stderr).toContain(`contester ${platform}`);

    const dry = await cli('contest', ['--claim', claimId, '--as', 'platform']);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(`contest on local chain 31337, signed by ${platform}`);
    expect(dry.stdout).toContain('Contest the pre-check finding against the platform');
    const fee = PARAMS.preLock.courtFeeUsdc; // DeployLocal applies the preLock set
    expect(dry.stdout).toContain(`courtFee:`);
    expect(dry.stdout).toContain(`(${fee} base units)`);
    expect(dry.stdout).toContain(`step 1 of 1: RecourseClaims.contest at ${contracts.claims}`);
    expect(dry.stdout).toContain('dry run');
    expect((await readClaim(shop.publicClient, contracts, claimId)).status).toBe(ClaimStatus.PreChecked);

    // By order id too: the command derives the claim id from the deployment.
    const byOrder = await cli('contest', ['--order', lapsed.orderId, '--as', 'platform']);
    expect(byOrder.status, byOrder.stderr).toBe(0);
    expect(byOrder.stdout).toContain(`claim ${lapsed.claimId}`);

    const usdcBefore = await usdcOf(platform);
    const sent = await cli('contest', ['--claim', claimId, '--as', 'platform', '--send']);
    expect(sent.status, sent.stderr).toBe(0);
    expect(sent.stdout).toMatch(/step 1: signed 0x[0-9a-f]{64} \(nonce \d+\); sending/);
    expect(sent.stdout).toMatch(/step 1: mined in block \d+/);
    expect(sent.stdout).toMatch(/sent 0x[0-9a-f]{64}/);
    const claim = await readClaim(shop.publicClient, contracts, claimId);
    expect(claim.status).toBe(ClaimStatus.Contested);
    expect(claim.contestedBy).toBe(platform);
    expect(await usdcOf(platform)).toBe(usdcBefore);

    const again = await cli('contest', ['--claim', claimId, '--as', 'platform', '--send']);
    expect(again.status).toBe(2);
    expect(again.stderr).toContain('wrong_status: The claim is Contested, which does not allow this call.');
  }, 300_000);

  it('refuses once the contest window has closed', async () => {
    const params = await readClaimParams(shop.publicClient, contracts);
    await passTime(params.contestWindow + 1n);
    const late = await cli('contest', ['--claim', lapsed.claimId, '--as', 'platform', '--send']);
    expect(late.status).toBe(2);
    expect(late.stderr).toContain('window_closed: The contest window closed at');
    expect((await readClaim(shop.publicClient, contracts, lapsed.claimId)).status).toBe(ClaimStatus.PreChecked);
  }, 120_000);

  it('withdraws the shop credit through the status API', async () => {
    const none = await cli('withdraw-credit', ['--as', 'shop']);
    expect(none.status).toBe(2);
    expect(none.stderr).toContain('withdraw-credit: no_credit: The signer has no credit in the deposit vault.');

    await write(signerClients, contracts.claims, contracts.claimsAbi, 'closeUncontested', [lapsed.claimId]);
    const credit = await readCredit(shop.publicClient, contracts, shop.account.address);
    expect(credit).toBeGreaterThan(BigInt(PARAMS.preLock.courtFeeUsdc)); // more than the refunded fee

    const dry = await cli('withdraw-credit', ['--as', 'shop']);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(`withdrawCredit on local chain 31337, signed by ${shop.account.address}`);
    expect(dry.stdout).toMatch(new RegExp(`credit: .* \\(${credit} base units\\), arrives in the account`));
    expect(dry.stdout).toContain(`step 1 of 1: DepositVault.withdrawCredit at ${contracts.vault}`);
    expect(dry.stdout).toContain('dry run');

    const usdcBefore = await usdcOf(shop.account.address);
    const sent = await cli('withdraw-credit', ['--as', 'shop', '--send']);
    expect(sent.status, sent.stderr).toBe(0);
    expect(sent.stdout).toMatch(/sent 0x[0-9a-f]{64}/);
    expect(await readCredit(shop.publicClient, contracts, shop.account.address)).toBe(0n);
    expect(await usdcOf(shop.account.address)).toBe(usdcBefore + credit);

    const again = await cli('withdraw-credit', ['--as', 'shop', '--send']);
    expect(again.status).toBe(2);
    expect(again.stderr).toContain('no_credit');
  }, 300_000);

  it('names ExitDue when filing against a platform whose exit is due', async () => {
    await write(platformClients, contracts.vault, contracts.vaultAbi, 'requestExit', []);
    const vaultParams = (await shop.publicClient.readContract({ address: contracts.vault, abi: contracts.vaultAbi, functionName: 'params' })) as readonly [
      bigint,
      bigint,
      bigint,
    ];
    await passTime(vaultParams[1]);

    const orderNonce = newOrderNonce();
    const input = { orderNonce, platform, refs: refs(), basketUsdc: 2_000_000n, netLossUsdc: 1_000_000n };
    const filer = new ClaimFiler({
      clients: shop,
      claims: contracts.claims,
      vault: contracts.vault,
      usdc: chain.deployment.usdc,
      claimsAbi: contracts.claimsAbi,
      vaultAbi: contracts.vaultAbi,
      journal: Journal.open<FilingJournalRow>(join(mkdtempSync(join(tmpdir(), 'exit-due-')), 'claims.jsonl')),
      log: memoryLogger(),
      receiptTimeoutMs: 20_000,
    });
    const nonce = await shop.publicClient.getTransactionCount({ address: shop.account.address });
    await expect(filer.fileClaim(input)).rejects.toMatchObject({ code: 'exit_due' });
    expect(await shop.publicClient.getTransactionCount({ address: shop.account.address })).toBe(nonce);

    // The contract's own revert, raised in the vault, decodes through the claims ABI plus the vault's errors.
    const call = {
      address: contracts.claims,
      abi: withErrorsOf(contracts.claimsAbi, contracts.vaultAbi),
      functionName: 'fileClaim',
      args: [orderNonce, platform, input.refs, input.basketUsdc, input.netLossUsdc],
    };
    const refused = await simulateCall(shop.publicClient, shop.account.address, call).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CallRefused);
    expect((refused as CallRefused).revert.name).toBe('ExitDue');
    expect((refused as CallRefused).message).toContain("the platform's exit from the deposit vault is due");
  }, 120_000);
});
