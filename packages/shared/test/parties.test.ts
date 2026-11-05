import { describe, expect, it } from 'vitest';
import { hcsWritersFor, parseHederaAccountIds, parseParties, partyByRole } from '../src/index.js';

const base = [
  {
    role: 'platform',
    evmAddress: '0x00000000000000000000000000000000000000a1',
    hederaAccountId: '0.0.1001',
    hcsWriters: ['0.0.1002'],
    displayName: 'Example Platform',
  },
  {
    role: 'agent',
    evmAddress: '0x00000000000000000000000000000000000000a2',
    hederaAccountId: '0.0.1002',
    hcsWriters: [],
    agentId: '12',
    displayName: 'Example Agent',
  },
  {
    role: 'shop',
    evmAddress: '0x00000000000000000000000000000000000000a3',
    hederaAccountId: '0.0.1003',
    hcsWriters: ['0.0.1003'],
    displayName: 'Example Shop',
  },
  {
    role: 'ops-arb',
    evmAddress: '0x00000000000000000000000000000000000000a4',
    hcsWriters: [],
    displayName: 'Arbitrum operator',
  },
];

describe('parseParties', () => {
  it('accepts a valid map and builds the writer sets', () => {
    const r = parseParties(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(partyByRole(r.value, 'shop').hederaAccountId).toBe('0.0.1003');
    expect([...hcsWritersFor(r.value, 0)]).toEqual(['0.0.1002']);
    expect([...hcsWritersFor(r.value, 5)]).toEqual(['0.0.1002']);
    expect([...hcsWritersFor(r.value, 4)]).toEqual(['0.0.1003']);
    expect(() => partyByRole(r.value, 'buyer')).toThrow();
  });

  it.each([
    ['not an array', {}],
    ['unknown role', [{ ...base[0], role: 'judge' }]],
    ['bad address', [{ ...base[0], evmAddress: '0x1234' }]],
    ['missing Hedera id on a Hedera role', [{ ...base[0], hederaAccountId: undefined }]],
    ['bad writer id', [{ ...base[0], hcsWriters: ['1002'] }]],
    ['negative agent id', [{ ...base[1], agentId: -1 }]],
    ['empty display name', [{ ...base[0], displayName: ' ' }]],
    ['unknown field', [{ ...base[0], extra: 1 }]],
    ['duplicate address', [base[0], { ...base[1], evmAddress: base[0]!.evmAddress }]],
  ])('rejects %s', (_label, json) => {
    expect(parseParties(JSON.parse(JSON.stringify(json))).ok).toBe(false);
  });
});

describe('parseHederaAccountIds', () => {
  const full =
    'deployer=0.0.1, ops-hedera=0.0.2, precheck-signer=0.0.3, platform=0.0.4, agent=0.0.5, shop=0.0.6, scheme=0.0.7, buyer=0.0.8, facilitator=0.0.9';
  it('parses every Hedera role', () => {
    const r = parseHederaAccountIds(full);
    expect(r.ok && r.value.facilitator).toBe('0.0.9');
  });
  it('rejects a missing, repeated or unknown role', () => {
    expect(parseHederaAccountIds(full.replace(', buyer=0.0.8', '')).ok).toBe(false);
    expect(parseHederaAccountIds(`${full},shop=0.0.10`).ok).toBe(false);
    expect(parseHederaAccountIds(`${full},ops-arb=0.0.11`).ok).toBe(false);
  });
});
