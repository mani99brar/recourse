// Hedera account ids per role. The party map (PARTIES_FILE) is the source once it exists; before
// it is built, HEDERA_ACCOUNT_IDS is the fallback, and callers log which one they used.

import { existsSync } from 'node:fs';
import { parseHederaAccountIds, partyByRole, type HederaRole } from '@recourse/shared';
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
