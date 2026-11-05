// Claim filing against the real contracts on a local anvil. Slow (deploys once per file); run
// under the suite lock like every test here.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { erc20Abi, type Address, type Hex, type PublicClient } from 'viem';
import { ZERO_HASH, claimIdOf, newOrderNonce, orderIdOf, type RecordRefs } from '@recourse/shared';
import { Journal, memoryLogger, readJournal } from '@recourse/records';
import { chainClients, loadAbi, type ChainClients } from '../src/chain.js';
import { ClaimFiler, type FilingJournalRow } from '../src/filing.js';
import { devAccount, startLocalChain, type LocalChain } from './anvil.js';

const PORT = 8572;
const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

function refs(withOrdered = true): RecordRefs {
  return {
    topicNum: 7000001n,
    seq: [11n, 12n, 13n, withOrdered ? 14n : 0n, 15n, 0n],
    hashes: [H(1), H(2), H(3), withOrdered ? H(4) : ZERO_HASH, H(5), ZERO_HASH],
  };
}

let chain: LocalChain;
let clients: ChainClients;
let platform: Address;

function filer(journalPath: string, override?: Partial<ChainClients>) {
  return new ClaimFiler({
    clients: { ...clients, ...override },
    claims: chain.deployment.claims,
    vault: chain.deployment.vault,
    usdc: chain.deployment.usdc,
    claimsAbi: loadAbi('RecourseClaims'),
    journal: Journal.open<FilingJournalRow>(journalPath),
    log: memoryLogger(),
    receiptTimeoutMs: 20_000,
  });
}

const journalPath = () => join(mkdtempSync(join(tmpdir(), 'filing-')), 'claims.jsonl');

beforeAll(async () => {
  chain = await startLocalChain(PORT);
  const shop = devAccount(4);
  expect(shop.address).toBe(chain.deployment.roles?.shop);
  platform = chain.deployment.roles!.platform!;
  clients = chainClients({ rpcUrl: chain.rpcUrl, chainId: chain.deployment.chainId, account: shop });
}, 600_000);

afterAll(async () => {
  await chain?.stop();
});

describe('file-claim on the local contracts', () => {
  it('refuses locally before sending anything', async () => {
    const f = filer(journalPath());
    const nonce = await clients.publicClient.getTransactionCount({ address: clients.account.address });
    const base = { orderNonce: newOrderNonce(), platform, refs: refs(), basketUsdc: 42_000_000n };
    await expect(f.fileClaim({ ...base, netLossUsdc: 42_000_001n })).rejects.toMatchObject({ code: 'net_loss_above_basket' });
    await expect(f.fileClaim({ ...base, refs: refs(false), netLossUsdc: 1n })).rejects.toMatchObject({ code: 'no_order_record' });
    expect(await clients.publicClient.getTransactionCount({ address: clients.account.address })).toBe(nonce);
  }, 60_000);

  it('approves exactly the court fee, files once and checks the claim id', async () => {
    const path = journalPath();
    const f = filer(path);
    const orderNonce = newOrderNonce();
    const input = { orderNonce, platform, refs: refs(), basketUsdc: 42_000_000n, netLossUsdc: 10_000_000n };
    const filed = await f.fileClaim(input);
    const orderId = orderIdOf(platform, clients.account.address, orderNonce);
    expect(filed.orderId).toBe(orderId);
    expect(filed.claimId).toBe(claimIdOf(31337n, chain.deployment.claims, orderId));
    expect(filed.existing).toBe(false);
    expect(await f.statusOf(filed.claimId)).toBe(1);
    const rows = readJournal<FilingJournalRow>(path).rows;
    const approves = rows.filter((r) => r.type === 'signed' && r.step === 'approve');
    expect(approves).toHaveLength(1);
    // The vault pulled the whole allowance: nothing is left approved.
    const left = await clients.publicClient.readContract({
      address: chain.deployment.usdc,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [clients.account.address, chain.deployment.vault],
    });
    expect(left).toBe(0n);

    // Same journal: answered from it. Fresh journal: read from the chain. No new transaction either way.
    const nonce = await clients.publicClient.getTransactionCount({ address: clients.account.address });
    expect(await f.fileClaim(input)).toMatchObject({ claimId: filed.claimId, existing: false });
    expect(await filer(journalPath()).fileClaim(input)).toMatchObject({ claimId: filed.claimId, existing: true });
    expect(await clients.publicClient.getTransactionCount({ address: clients.account.address })).toBe(nonce);
  }, 60_000);

  it('after a crash between signing and sending, resends the journaled bytes', async () => {
    const path = journalPath();
    const killed = new Proxy(clients.publicClient, {
      get(target, prop, receiver) {
        if (prop === 'sendRawTransaction' || prop === 'waitForTransactionReceipt') {
          return async () => {
            throw new Error('process killed');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as PublicClient;
    const input = { orderNonce: newOrderNonce(), platform, refs: refs(), basketUsdc: 20_000_000n, netLossUsdc: 20_000_000n };
    await expect(filer(path, { publicClient: killed }).fileClaim(input)).rejects.toThrow('process killed');
    const signed = readJournal<FilingJournalRow>(path).rows.filter((r) => r.type === 'signed');
    expect(signed).toHaveLength(1);

    const filed = await filer(path).fileClaim(input);
    expect(filed.existing).toBe(false);
    const rows = readJournal<FilingJournalRow>(path).rows;
    const approveRows = rows.filter((r) => r.type === 'signed' && r.step === 'approve');
    expect(approveRows).toHaveLength(1);
    const mined = rows.filter((r) => r.type === 'mined');
    expect(mined.map((r) => r.type === 'mined' && r.txHash)).toContain(signed[0]!.type === 'signed' && signed[0]!.txHash);
    expect(rows.filter((r) => r.type === 'signed' && r.step === 'file')).toHaveLength(1);
  }, 60_000);
});
