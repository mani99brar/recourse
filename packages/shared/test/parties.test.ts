import { describe, expect, it } from 'vitest';
import { accountIdOf, hcsWritersFor, hederaAccountIdOf, parseHederaAccountIds, parseParties, partyByRole } from '../src/index.js';

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

  it('accepts a Hedera role with no account yet; reading its id then fails naming the role', () => {
    const signer = { role: 'precheck-signer', evmAddress: '0x00000000000000000000000000000000000000a5', hcsWriters: [], displayName: 'Pre-check' };
    const r = parseParties([...base, signer]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = partyByRole(r.value, 'precheck-signer');
    expect(p.hederaAccountId).toBeUndefined();
    expect(() => hederaAccountIdOf(p)).toThrow(/^parties: precheck-signer has no hederaAccountId$/);
    expect(hederaAccountIdOf(partyByRole(r.value, 'shop'))).toBe('0.0.1003');
  });

  it.each([
    ['not an array', {}],
    ['unknown role', [{ ...base[0], role: 'judge' }]],
    ['bad address', [{ ...base[0], evmAddress: '0x1234' }]],
    ['malformed Hedera id', [{ ...base[0], hederaAccountId: '0.0.' }]],
    ['Hedera id that is not a string', [{ ...base[0], hederaAccountId: 1001 }]],
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
  it('accepts absent roles; reading one fails naming the role', () => {
    const r = parseHederaAccountIds('deployer=0.0.1,ops-hedera=0.0.2,platform=0.0.4,agent=0.0.5,shop=0.0.6');
    expect(r).toEqual({ ok: true, value: { deployer: '0.0.1', 'ops-hedera': '0.0.2', platform: '0.0.4', agent: '0.0.5', shop: '0.0.6' } });
    if (!r.ok) return;
    expect(accountIdOf(r.value, 'shop')).toBe('0.0.6');
    expect(() => accountIdOf(r.value, 'facilitator')).toThrow(/^HEDERA_ACCOUNT_IDS: no account id for facilitator$/);
    expect(parseHederaAccountIds('')).toEqual({ ok: true, value: {} });
  });
  it.each([
    ['a repeated role', `${full},shop=0.0.10`, /shop twice/],
    ['an unknown role', `${full},ops-arb=0.0.11`, /unknown role ops-arb/],
    ['a malformed id', 'shop=0.0', /bad account id for shop/],
    ['an id with letters', 'shop=0.0.6a', /bad account id for shop/],
    ['a pair without =', 'shop', /expected role=0\.0\.N pairs/],
  ])('rejects %s', (_label, text, error) => {
    const r = parseHederaAccountIds(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(error);
  });
});
