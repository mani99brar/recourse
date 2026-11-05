import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountIdsFromEnv, hederaAccountOf } from '../src/accounts.js';

// Made-up ids and addresses. The partial set is the one written before every account exists.
const PARTIAL = 'deployer=0.0.1,ops-hedera=0.0.2,platform=0.0.4,agent=0.0.5,shop=0.0.6';

function partiesFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'accounts-')), 'parties.json');
  const parties = [
    { role: 'shop', evmAddress: '0x00000000000000000000000000000000000000b2', hederaAccountId: '0.0.6', hcsWriters: ['0.0.6'], displayName: 'Demo Shop' },
    { role: 'facilitator', evmAddress: '0x00000000000000000000000000000000000000c3', hcsWriters: [], displayName: 'Demo Relay' },
  ];
  writeFileSync(file, JSON.stringify(parties));
  return file;
}

describe('Hedera account resolution with roles that have no account yet', () => {
  it('HEDERA_ACCOUNT_IDS: present roles resolve, an absent one fails naming the role', () => {
    const env = { HEDERA_ACCOUNT_IDS: PARTIAL };
    expect(Object.keys(accountIdsFromEnv(env))).toEqual(['deployer', 'ops-hedera', 'platform', 'agent', 'shop']);
    expect(hederaAccountOf('shop', env)).toEqual({ accountId: '0.0.6', source: 'HEDERA_ACCOUNT_IDS' });
    expect(() => hederaAccountOf('facilitator', env)).toThrow(/^HEDERA_ACCOUNT_IDS: no account id for facilitator$/);
    expect(() => accountIdsFromEnv({ HEDERA_ACCOUNT_IDS: 'shop=0.0.6,shop=0.0.7' })).toThrow(/shop twice/);
  });

  it('parties.json: an entry without hederaAccountId fails only when its id is read', () => {
    const env = { PARTIES_FILE: partiesFile(), HEDERA_ACCOUNT_IDS: PARTIAL };
    expect(hederaAccountOf('shop', env)).toEqual({ accountId: '0.0.6', source: 'parties' });
    expect(() => hederaAccountOf('facilitator', env)).toThrow(/^parties: facilitator has no hederaAccountId$/);
  });
});
