import { describe, expect, it } from 'vitest';
import { getAddress, type Address } from 'viem';
import { vaultTokenOf } from '@recourse/shared';
import { MirrorClient, checkAccount, describeCheck, type FetchLike } from '../src/index.js';

const ACCOUNT = '0.0.3001';
const EVM = '0x00000000000000000000000000000000000000b2';
const MOCK = getAddress('0x1111111111111111111111111111111111111111');

const circle = vaultTokenOf({ usdc: { mode: 'circle', address: '0x0000000000000000000000000000000000068cDa', decimals: 6, tokenId: '0.0.429274' } });
const mock = vaultTokenOf({ usdc: { mode: 'mock', address: MOCK, decimals: 6, tokenId: null } });

/** A mirror with one complete account; `usdc` is its Circle USDC row, or none. */
function mirror(usdc: bigint | null): { client: MirrorClient; paths: string[] } {
  const paths: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    const path = input.replace('https://mirror.test/api/v1', '');
    paths.push(path);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === `/accounts/${ACCOUNT}`) return json({ account: ACCOUNT, key: { _type: 'ECDSA_SECP256K1' }, evm_address: EVM, balance: { balance: 5e8 }, deleted: false });
    if (path.startsWith(`/accounts/${ACCOUNT}/tokens`)) return json({ tokens: usdc === null ? [] : [{ token_id: '0.0.429274', balance: Number(usdc) }] });
    return new Response('{}', { status: 404 });
  };
  return { client: new MirrorClient('https://mirror.test', fetchImpl), paths };
}

function reader(balances: Record<string, bigint>) {
  const calls: [Address, Address][] = [];
  const balanceOf = async (token: Address, holder: Address) => {
    calls.push([token, holder]);
    return balances[holder.toLowerCase()] ?? 0n;
  };
  return { balanceOf, calls };
}

describe('account preflight, USDC', () => {
  it('reads Circle USDC from the mirror when no token is given (the x402 asset)', async () => {
    const m = mirror(2_000_000n);
    const c = await checkAccount(m.client, { role: 'agent', accountId: ACCOUNT, usdc: { minBalance: 1_000_000n } });
    expect(c).toMatchObject({ ok: true, usdcBalance: 2_000_000n, usdcAssociated: true, usdcMode: 'circle' });
    expect(m.paths).toContain(`/accounts/${ACCOUNT}/tokens?token.id=0.0.429274&limit=1`);
    expect(describeCheck(c)).toBe(`agent ${ACCOUNT}: ok hbar=5.00 usdc=2.00`);
  });

  it('reads the vault token from the mirror in circle mode, and names a missing association', async () => {
    const r = reader({});
    const ok = await checkAccount(mirror(500n).client, { role: 'shop', accountId: ACCOUNT, usdc: { token: circle, balanceOf: r.balanceOf } });
    expect(ok).toMatchObject({ ok: true, usdcBalance: 500n, usdcMode: 'circle' });
    const none = await checkAccount(mirror(null).client, { role: 'shop', accountId: ACCOUNT, usdc: { token: circle, balanceOf: r.balanceOf } });
    expect(none).toMatchObject({ ok: false, failures: ['usdc_not_associated'], usdcAssociated: false });
    expect(r.calls).toEqual([]);
  });

  it('reads the mock by balanceOf at the account EVM address, never the mirror token rows', async () => {
    const m = mirror(null);
    const r = reader({ [EVM]: 3_000_000n });
    const c = await checkAccount(m.client, { role: 'shop', accountId: ACCOUNT, usdc: { token: mock, balanceOf: r.balanceOf, minBalance: 1_000_000n } });
    expect(c).toMatchObject({ ok: true, usdcBalance: 3_000_000n, usdcAssociated: true, usdcMode: 'mock' });
    expect(r.calls).toEqual([[MOCK, EVM]]);
    expect(m.paths.some((p) => p.includes('/tokens'))).toBe(false);
    expect(describeCheck(c)).toBe(`shop ${ACCOUNT}: ok hbar=5.00 mUSDC=3.00 (testnet mock)`);
  });

  it('flags a low mock balance, and reads at the expected EVM address when one is given', async () => {
    const other = '0x00000000000000000000000000000000000000c3';
    const r = reader({ [other]: 9n });
    const c = await checkAccount(mirror(null).client, { role: 'platform', accountId: ACCOUNT, evmAddress: other, usdc: { token: mock, balanceOf: r.balanceOf, minBalance: 10n } });
    expect(c.failures).toEqual(['evm_address_mismatch', 'usdc_low']);
    expect(r.calls).toEqual([[MOCK, other]]);
  });

  it('refuses a mock check without a reader rather than passing it', async () => {
    await expect(checkAccount(mirror(null).client, { role: 'shop', accountId: ACCOUNT, usdc: { token: mock } })).rejects.toThrow('needs a balanceOf reader');
  });
});
