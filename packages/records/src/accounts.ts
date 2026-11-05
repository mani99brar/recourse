// Hedera account ids per role. The party map (PARTIES_FILE) is the source once it exists; before
// it is built, HEDERA_ACCOUNT_IDS is the fallback, and callers log which one they used.

import { existsSync } from 'node:fs';
import { hcsWritersFor, parseHederaAccountIds, partyByRole, type HederaRole, type PartyRole } from '@recourse/shared';
import { readParties } from '@recourse/shared/node';

type Env = Record<string, string | undefined>;

export interface ResolvedAccount {
  accountId: string;
  source: 'parties' | 'HEDERA_ACCOUNT_IDS';
}

export function hederaAccountOf(role: HederaRole, env: Env = process.env): ResolvedAccount {
  // The party map is built from the setup ids, so a configured but not yet written file falls
  // back to HEDERA_ACCOUNT_IDS when that is set.
  const partiesReady = !!env.PARTIES_FILE && (existsSync(env.PARTIES_FILE) || !env.HEDERA_ACCOUNT_IDS);
  if (partiesReady) {
    const party = partyByRole(readParties(env), role);
    if (!party.hederaAccountId) throw new Error(`parties: ${role} has no hederaAccountId`);
    return { accountId: party.hederaAccountId, source: 'parties' };
  }
  return { accountId: accountIdsFromEnv(env)[role], source: 'HEDERA_ACCOUNT_IDS' };
}

export function accountIdsFromEnv(env: Env = process.env): Record<HederaRole, string> {
  const text = env.HEDERA_ACCOUNT_IDS;
  if (!text) throw new Error('HEDERA_ACCOUNT_IDS: not set');
  const parsed = parseHederaAccountIds(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

/** Names used before the party map exists. Fictional. */
export const DEFAULT_DISPLAY_NAMES = { shop: 'Demo Shop', platform: 'Demo Agent Co' } as const;

/** The party's display name from the party map, or the default while the map does not exist yet. */
export function displayNameOf(role: 'shop' | 'platform', env: Env = process.env): string {
  if (env.PARTIES_FILE && existsSync(env.PARTIES_FILE)) return partyByRole(readParties(env), role as PartyRole).displayName;
  return DEFAULT_DISPLAY_NAMES[role];
}

/**
 * Checks that `payer` is in the writer set for the records it will write (the platform's writers
 * for every kind but packed, the shop's for packed). Messages from any other account are ignored
 * by every reader, so a service must not start writing with one. Skipped, returning false, while
 * the party map does not exist yet.
 */
export function assertRecordWriter(role: 'agent' | 'shop', payer: string, env: Env = process.env): boolean {
  if (!env.PARTIES_FILE || !existsSync(env.PARTIES_FILE)) return false;
  const kind = role === 'shop' ? 4 : 0;
  const writers = hcsWritersFor(readParties(env), kind);
  if (!writers.has(payer)) {
    const owner = role === 'shop' ? 'shop' : 'platform';
    throw new Error(`records: ${payer} is not in the ${owner} party's hcsWriters (${[...writers].join(', ') || 'none'}); its records would be ignored`);
  }
  return true;
}
