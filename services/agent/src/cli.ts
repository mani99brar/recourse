// Shared bits of the agent's commands: the journal lock, attribute flags and the buyer key.

import type { LocalAccount } from 'viem';
import { getAddress } from 'viem';
import type { Attrs, Parties } from '@recourse/shared';
import { loadSigner } from '@recourse/shared/node';
import { withFileLock, type MirrorClient } from '@recourse/records';
import { ORDERS_JOURNAL } from './setup.js';

type Env = Record<string, string | undefined>;

/** Holds the order journal's lock: one writing command at a time. The approvals service only reads. */
export function withOrdersLock<T>(fn: () => Promise<T>): Promise<T> {
  return withFileLock(`${ORDERS_JOURNAL}.lock`, fn);
}

export const ATTR_OPTIONS = {
  brand: { type: 'string' },
  size: { type: 'string' },
  colour: { type: 'string' },
  quantity: { type: 'string' },
  price: { type: 'string' },
  merchant: { type: 'string' },
} as const;

/** The attributes given as flags; absent flags stay absent. */
export function attrsFrom(values: Partial<Record<keyof typeof ATTR_OPTIONS, string | undefined>>): Attrs {
  const attrs: Attrs = {};
  for (const k of Object.keys(ATTR_OPTIONS) as (keyof typeof ATTR_OPTIONS)[]) {
    const v = values[k];
    if (typeof v === 'string' && v.trim() !== '') attrs[k] = v;
  }
  return attrs;
}

/** The buyer key; when the party map names a buyer, the key must be that buyer's. */
export function loadBuyer(env: Env, parties: Parties): LocalAccount {
  const account = loadSigner('BUYER_KEY_FILE', env);
  const party = parties.find((p) => p.role === 'buyer');
  if (party && getAddress(party.evmAddress) !== getAddress(account.address)) {
    throw new Error(`BUYER_KEY_FILE is ${account.address}, the party map's buyer is ${party.evmAddress}`);
  }
  return account;
}

/** HashScan link for a Hedera transaction id, by its consensus timestamp once the mirror shows it. */
export async function hashscanLink(mirror: MirrorClient, txId: string, attempts = 10): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const tx = await mirror.transaction(txId).catch(() => null);
    if (tx) return `https://hashscan.io/testnet/transaction/${tx.consensusTimestamp}`;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return `(not on the mirror node yet; look up ${txId} on https://hashscan.io/testnet)`;
}
