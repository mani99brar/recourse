// The party page's pieces, rendered from the shapes the status API answers for a shop and an
// agent company (/v1/claims?party=…). Names and amounts here are test values, not live ones.
import type { VaultToken } from '@recourse/shared';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StandingCard, Worklist, depositState, worklistLine, type Standing } from '../src/pages/Party.js';

const mock: VaultToken = { mode: 'mock', address: `0x${'6d'.repeat(20)}`, decimals: 6, symbol: 'mUSDC', label: 'mUSDC (testnet mock)', tokenId: null };
const SHOP = '0x' + '33'.repeat(20);
const AGENT = '0x' + '44'.repeat(20);
const C1 = '0x' + '11'.repeat(32);
const C2 = '0x' + '22'.repeat(32);

const shop: Standing = {
  address: SHOP, role: 'shop', displayName: 'Example Shop (sample)', hederaAccountId: '0.0.1001', balance: null, required: null, inGoodStanding: null,
  topUpDeadline: null, credit: null, escrowOpen: '0', openClaims: 0, exitRequestedAt: null,
};
const agent = (over: Partial<Standing> = {}): Standing => ({
  address: AGENT, role: 'platform', displayName: 'Example Agent Co (sample)', hederaAccountId: '0.0.1002', balance: '18000000', required: '18000000',
  inGoodStanding: true, topUpDeadline: '0', credit: '0', escrowOpen: '0', openClaims: 0, exitRequestedAt: null, ...over,
});
const row = (claimId: string, owed: string | null = '0') => ({
  claimId, statusKey: 'settled' as const, shopName: 'Example Shop (sample)', platformName: 'Example Agent Co (sample)', shop: SHOP, platform: AGENT, updatedAt: '1700000000', owed,
});

describe('the party page', () => {
  it('a shop shows its credit row and no deposit or mark', () => {
    const html = renderToString(<StandingCard s={shop} address={SHOP} token={mock} />);
    expect(html).toContain('Credit to withdraw');
    expect(html).toContain('Standing');
    expect(html).not.toContain('class="mark');
    expect(html).not.toContain('Deposit');
    expect(html).not.toContain('Bonded');
  });

  it('a bonded agent company carries the ringed mark with the vault figure', () => {
    const html = renderToString(<StandingCard s={agent()} address={AGENT} token={mock} />).replace(/<!-- -->/g, '');
    expect(html).toContain('Credit to withdraw');
    expect(html).toContain('The deposit');
    expect(html).toContain('class="mark mark-on"');
    expect(html).toContain('<image');
    expect(html).toContain('BONDED AGENT');
    expect(html).toContain('18.00');
    expect(html).toContain('mUSDC deposit');
    expect(html).toContain('18.00 mUSDC (testnet mock) of 18.00 mUSDC (testnet mock) required');
    expect(html).not.toContain('deposit (sample)');
  });

  it('an unread deposit is never called short, and an unread figure is never drawn in the ring', () => {
    const s = agent({ balance: null, required: null, inGoodStanding: null, topUpDeadline: null });
    expect(depositState(s)).toBe('unread');
    const html = renderToString(<StandingCard s={s} address={AGENT} token={mock} />);
    expect(html).not.toContain('not in good standing');
    expect(html).not.toContain('NOT IN GOOD STANDING');
    expect(html).not.toContain('<image');
    expect(html).toContain('NOT READ RIGHT NOW');
    expect(html).not.toContain('>not yet known</text>');
  });

  it('a company below its figure shows the top-up clock or the plain word, never the bonded ring', () => {
    expect(depositState(agent({ inGoodStanding: false, topUpDeadline: '1800000000' }))).toBe('due');
    expect(depositState(agent({ inGoodStanding: false, topUpDeadline: '0' }))).toBe('short');
    const due = renderToString(<StandingCard s={agent({ balance: '5000000', inGoodStanding: false, topUpDeadline: '1800000000' })} address={AGENT} token={mock} />);
    expect(due).toContain('TOP-UP DUE');
    expect(due).not.toContain('BONDED AGENT');
    const empty = renderToString(<StandingCard s={agent({ balance: '0', inGoodStanding: false, topUpDeadline: '0' })} address={AGENT} token={mock} />);
    expect(empty).toContain('NOT IN GOOD STANDING');
    expect(empty).not.toContain('<image');
  });

  it('the worklist counts every group, lists the claims of each one that has any, and links each claim', () => {
    const groups = { waitingOnYou: [], waitingOnOther: [], openToAnyone: [C2], owedToYou: [C2], finished: [C1] };
    const html = renderToString(<Worklist rows={[row(C1), row(C2, '7500000')]} groups={groups} role="shop" token={mock} />);
    expect(html).toContain(`href="#/claim/${C1}"`);
    expect(html).toContain(`href="#/claim/${C2}"`);
    expect(html).toContain('Waiting on you');
    expect(html).toContain('Owed to the shop');
    expect(html).toContain('7.50 mUSDC (testnet mock)');
    expect(html).toContain('Example Agent Co (sample)');
    expect((html.match(/<tbody>/g) ?? []).length).toBe(3);
    const none = renderToString(<Worklist rows={[]} groups={{}} role="platform" token={mock} />);
    expect(none).toContain('No claim names this account yet');
  });

  it('the head line counts the claims, the open ones and those waiting on the account', () => {
    expect(worklistLine([], {})).toBe('No claim names this account yet.');
    expect(worklistLine([1, 2], { finished: ['a', 'b'] })).toBe('2 claims name this account: all are finished.');
    expect(worklistLine([1, 2, 3], { finished: ['a'], waitingOnYou: ['b'] })).toBe('3 claims name this account: 2 are open, 1 waiting on it.');
    expect(worklistLine([1], { finished: [] })).toBe('1 claim names this account: 1 is open.');
  });
});
