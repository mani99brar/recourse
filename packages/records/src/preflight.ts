// Account checks on the mirror node before anything is sent: the account exists, has a key (is not
// hollow), holds enough HBAR, is associated with USDC and, for EVM signers, carries the keystore's
// EVM address so the JSON-RPC relay maps the signature to this account.

import { addressBook } from '@recourse/shared';
import type { MirrorClient } from './mirror.js';

export interface AccountRequirement {
  role: string;
  accountId: string;
  minTinybar?: bigint;
  usdc?: { minBalance?: bigint };
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
  usdcAssociated: boolean | null;
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
    const rel = await mirror.tokenRelationship(req.accountId, addressBook.hedera.usdc.tokenId);
    out.usdcAssociated = rel.associated;
    out.usdcBalance = rel.balance;
    if (!rel.associated) out.failures.push('usdc_not_associated');
    else if (req.usdc.minBalance !== undefined && rel.balance < req.usdc.minBalance) out.failures.push('usdc_low');
  }
  out.ok = out.failures.length === 0;
  return out;
}

export function describeCheck(c: AccountCheck): string {
  const hbar = c.hbarTinybar === null ? '?' : (Number(c.hbarTinybar) / 1e8).toFixed(2);
  const usdc = c.usdcBalance === null ? '' : ` usdc=${(Number(c.usdcBalance) / 1e6).toFixed(2)}`;
  return `${c.role} ${c.accountId}: ${c.ok ? 'ok' : c.failures.join(',')} hbar=${hbar}${usdc}`;
}
