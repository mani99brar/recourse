// Account checks on the mirror node before anything is sent: the account exists, has a key (is not
// hollow), holds enough HBAR, is associated with USDC and, for EVM signers, carries the keystore's
// EVM address so the JSON-RPC relay maps the signature to this account. A USDC check on the vault's
// testnet mock reads `balanceOf` over JSON-RPC instead: the mock is a plain ERC-20 with no mirror rows.

import { addressBook, type VaultToken, type VaultTokenMode } from '@recourse/shared';
import type { Address } from 'viem';
import type { MirrorClient } from './mirror.js';

/** `balanceOf(holder)` on the ERC-20 at `token`, by eth_call. */
export type BalanceReader = (token: Address, holder: Address) => Promise<bigint>;

export interface AccountRequirement {
  role: string;
  accountId: string;
  minTinybar?: bigint;
  /**
   * Without `token`: Circle's USDC, the x402 asset, from the mirror's token row. With the vault's
   * token (`vaultTokenOf`): Circle's the same way; the mock by `balanceOf`, which needs the reader.
   */
  usdc?: { minBalance?: bigint; token?: VaultToken; balanceOf?: BalanceReader };
  /** Expected EVM address (any case); checked against the mirror node's `evm_address`. */
  evmAddress?: string;
}

export interface AccountCheck {
  role: string;
  accountId: string;
  ok: boolean;
  /** Named failures, e.g. `account_hollow`, `usdc_not_associated`. */
  failures: string[];
  hbarTinybar: bigint | null;
  usdcBalance: bigint | null;
  /** True for the mock, which every account can hold. */
  usdcAssociated: boolean | null;
  /** Which USDC was checked; null when none was. */
  usdcMode: VaultTokenMode | null;
}

export async function checkAccount(mirror: MirrorClient, req: AccountRequirement): Promise<AccountCheck> {
  const out: AccountCheck = {
    role: req.role,
    accountId: req.accountId,
    ok: false,
    failures: [],
    hbarTinybar: null,
    usdcBalance: null,
    usdcAssociated: null,
    usdcMode: null,
  };
  const account = await mirror.account(req.accountId);
  if (!account) {
    out.failures.push('account_missing');
    return out;
  }
  out.hbarTinybar = account.balanceTinybar;
  if (account.deleted) out.failures.push('account_deleted');
  if (account.keyType === null) out.failures.push('account_hollow');
  if (req.minTinybar !== undefined && account.balanceTinybar < req.minTinybar) out.failures.push('hbar_low');
  if (req.evmAddress !== undefined) {
    if (!account.evmAddress || account.evmAddress.toLowerCase() !== req.evmAddress.toLowerCase()) {
      out.failures.push('evm_address_mismatch');
    }
  }
  if (req.usdc) {
    const token = req.usdc.token;
    out.usdcMode = token?.mode ?? 'circle';
    if (token?.mode === 'mock') {
      if (!req.usdc.balanceOf) throw new Error(`checkAccount: ${req.role}: the mock USDC check needs a balanceOf reader`);
      const holder = req.evmAddress ?? account.evmAddress;
      out.usdcAssociated = true;
      if (!holder) {
        out.failures.push('usdc_holder_unknown');
      } else {
        out.usdcBalance = await req.usdc.balanceOf(token.address, holder as Address);
        if (req.usdc.minBalance !== undefined && out.usdcBalance < req.usdc.minBalance) out.failures.push('usdc_low');
      }
    } else {
      const rel = await mirror.tokenRelationship(req.accountId, token?.tokenId ?? addressBook.hedera.usdc.tokenId);
      out.usdcAssociated = rel.associated;
      out.usdcBalance = rel.balance;
      if (!rel.associated) out.failures.push('usdc_not_associated');
      else if (req.usdc.minBalance !== undefined && rel.balance < req.usdc.minBalance) out.failures.push('usdc_low');
    }
  }
  out.ok = out.failures.length === 0;
  return out;
}

export function describeCheck(c: AccountCheck): string {
  const hbar = c.hbarTinybar === null ? '?' : (Number(c.hbarTinybar) / 1e8).toFixed(2);
  const amount = c.usdcBalance === null ? '' : (Number(c.usdcBalance) / 1e6).toFixed(2);
  const usdc = amount === '' ? '' : c.usdcMode === 'mock' ? ` mUSDC=${amount} (testnet mock)` : ` usdc=${amount}`;
  return `${c.role} ${c.accountId}: ${c.ok ? 'ok' : c.failures.join(',')} hbar=${hbar}${usdc}`;
}
