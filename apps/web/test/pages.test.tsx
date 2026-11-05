import { STATUS_KEYS } from '@recourse/shared';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Shell, route } from '../src/App.js';
import { Banner } from '../src/components.js';
import { ApiFailure } from '../src/lib/api.js';
import { parseUsdc, usdc } from '../src/lib/format.js';
import { ACTOR_WORDS, CALL_WORDS, FATE_WORDS, GROUP_WORDS, REASON_WORDS, STATUS_WORDS } from '../src/lib/words.js';
import { CaseView, type CaseDetail } from '../src/pages/Case.js';
import { Finding } from '../src/pages/File.js';
import { ClaimList } from '../src/pages/Party.js';
import { RateTable } from '../src/pages/Docket.js';
import { REASON_KEYS } from '@recourse/shared';

function detail(statusKey: CaseDetail['statusKey'], over: Partial<CaseDetail> = {}): CaseDetail {
  return {
    claimId: '0x' + '11'.repeat(32), orderId: '0x' + '22'.repeat(32), shop: '0x' + '33'.repeat(20), shopName: 'Example Shop (sample)',
    platform: '0x' + '44'.repeat(20), platformName: 'Example Agent Co (sample)', filedAt: '1700000000', statusKey, nextActor: 'anyone', nextCall: 'settle',
    deadline: null, findingSide: 'platform', gap: 1, answer: 1, basketUsdc: '60000000', netLossUsdc: '50000000', refs: { hashes: [] },
    records: [0, 1, 2, 3, 4, 5].map((kind) => ({ kind, seq: kind + 1, cid: `bafysample${kind}`, hash: '0x' + '00'.repeat(32), payerOk: true, held: true, hashOk: true, refsMatch: true })),
    precheck: { gap: 1, answer: 1, side: 'platform', packHash: '0x' + '55'.repeat(32), packHashOk: true },
    contest: { by: null, at: null, windowEndsAt: '1700000600' },
    court: { state: 'none', attempts: 0, disputeIds: [], period: null, periodName: null, currentRuling: null, tied: null, overridden: null, ruling: null, evidence: [], courtLinks: [] },
    messages: [], money: { owed: null, paid: null, credited: null, notCovered: null, escrow: { amount: '3000000', fate: 'held' }, projected: false },
    docket: { writeStatus: 'none', entityKey: null, store: null }, events: [{ name: 'ClaimFiled', chain: 'hedera', tx: '0x' + '66'.repeat(32), time: '1700000000', explorer: null }],
    ...over,
  };
}

describe('words', () => {
  it('has a word for every status key, actor, call, reason and group', () => {
    for (const k of STATUS_KEYS) expect(STATUS_WORDS[k].title.length).toBeGreaterThan(0);
    for (const k of REASON_KEYS) expect(REASON_WORDS[k]).toBeTruthy();
    expect(Object.keys(ACTOR_WORDS)).toHaveLength(7);
    expect(Object.keys(CALL_WORDS)).toHaveLength(12);
    expect(Object.keys(FATE_WORDS)).toContain('kept_by_pool');
    expect(Object.keys(GROUP_WORDS)).toHaveLength(5);
  });
});

describe('pages render', () => {
  for (const k of STATUS_KEYS) {
    it(`case page for ${k}`, () => {
      const html = renderToString(<CaseView d={detail(k)} />);
      expect(html).toContain(STATUS_WORDS[k].title);
      expect(html).toContain('does not send anything');
    });
  }
  it('shows a stuck claim with its next call', () => {
    expect(renderToString(<CaseView d={detail('stuck', { nextCall: 'resend' })} />)).toContain('resend the message');
  });
  it('shows an unpaid shortfall apart from paid', () => {
    const html = renderToString(<CaseView d={detail('settled', { money: { owed: '68000000', paid: '20000000', credited: '20000000', notCovered: '48000000', escrow: { amount: '3000000', fate: 'kept_by_pool' }, projected: false } })} />);
    expect(html).toContain('48.00 USDC');
    expect(html).toContain('20.00 USDC');
  });
  it('degraded and unreachable states show a banner, not a crash', () => {
    expect(renderToString(<Banner fresh={{ degraded: ['hedera'] }} />)).toContain('running late');
    expect(renderToString(<Banner error={new ApiFailure(0, 'unreachable')} />)).toContain('cannot be reached');
    expect(renderToString(<Banner error={new ApiFailure(503, 'rebuilding')} />)).toContain('rebuilding');
  });
  it('renders every route shell and an empty docket', () => {
    for (const h of ['#/', '#/docket', '#/file', '#/claim/0x12', '#/party/0x12']) expect(renderToString(<Shell hash={h} />)).toContain('Recourse');
    expect(renderToString(<RateTable rates={[]} />)).toContain('No ruled cases');
    expect(renderToString(<ClaimList rows={[]} />)).toContain('No claims');
  });
  it('explains a finding in plain words', () => {
    const html = renderToString(<Finding result={{ gap: 255, answer: 0, side: 'none', reasonKey: 'not_enough_record', step: '1', flaggedCells: [], notCompared: [], unreadPrice: [] }} />);
    expect(html).toContain('not enough records');
    expect(html).toContain('No finding');
  });
});

describe('deadlines', () => {
  it('labels the filed and contested expiry in plain words', () => {
    const f = renderToString(<CaseView d={detail('filed', { nextActor: 'preCheckSigner', nextCall: 'recordPreCheck', deadline: '1700014400' })} />);
    expect(f).toContain('Expires if not pre-checked by');
    expect(f).toContain('2023-11-14');
    const c = renderToString(<CaseView d={detail('contested', { nextCall: 'sendToCourt', deadline: '1700014400' })} />);
    expect(c).toContain('Expires if no ruling by');
  });
  it('renders with no deadline at all', () => {
    const html = renderToString(<CaseView d={detail('settled', { nextCall: null, deadline: null })} />);
    expect(html).not.toContain('Expires');
  });
});

describe('helpers', () => {
  it('routes hashes', () => {
    expect(route('#/claim/0xab')).toEqual({ name: 'claim', arg: '0xab' });
    expect(route('#/nothing').name).toBe('home');
  });
  it('formats and parses amounts', () => {
    expect(usdc('3000000')).toBe('3.00 USDC');
    expect(parseUsdc('12.5')).toBe(12_500_000n);
    expect(parseUsdc('-1')).toBeNull();
    expect(parseUsdc('1.1234567')).toBeNull();
  });
});
