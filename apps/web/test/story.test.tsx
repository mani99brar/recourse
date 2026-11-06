// The story page (#/story), rendered from the shapes the status API answers for the two claims it tells
// (GET /v1/claims/{id}), and in its loading state. The fetch is mocked; ids, names and amounts follow the two
// claims on the test networks, and the hashes are test values.
import { readFileSync } from 'node:fs';
import type { VaultToken } from '@recourse/shared';
import { renderToString } from 'react-dom/server';
import { prerender } from 'react-dom/static';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Shell } from '../src/App.js';
import { READS, apiUrl, fromV1, getRead } from '../src/lib/api.js';
import { ApiFailure } from '../src/lib/api.js';
import { COURT_CLAIM, PAYOUT_CLAIM, STORY_READS, StoryBody, StoryView, WITHDRAW_TX, courtOutcome, payoutMoney, sizesOf, windowWords, type StoryClaim } from '../src/pages/Story.js';

const mock: VaultToken = { mode: 'mock', address: `0x${'6d'.repeat(20)}`, decimals: 6, symbol: 'mUSDC', label: 'mUSDC (testnet mock)', tokenId: null };
const SHOP = '0x' + '0d'.repeat(20);
const AGENT = '0x' + 'ff'.repeat(20);
const KEYS = ['asked', 'shown', 'approval', 'ordered', 'packed', 'arrived'] as const;
const hex = (n: number) => '0x' + n.toString(16).padStart(2, '0').repeat(32);
const ev = (name: string, chain: string, time: string) => ({ name, chain, tx: hex(time.length + name.length), time, explorer: null });

/** A claim body as the API answers it: `{ claim, meta }`, the six records each with its size (approval has none). */
function body(claimId: string, sizes: string[], seq0: number, claim: Record<string, unknown>) {
  return {
    claim: {
      claimId,
      orderId: hex(seq0),
      shop: SHOP,
      shopName: 'Halden Supply',
      platform: AGENT,
      platformName: 'Parcel Minds',
      basketUsdc: '1500000',
      netLossUsdc: '1500000',
      refs: { topicNum: '11335218', seq: KEYS.map((_, i) => String(seq0 + i)), hashes: KEYS.map((_, i) => hex(0x80 + seq0 + i)) },
      records: KEYS.map((key, kind) => ({
        kind, key, seq: seq0 + kind, payer: '0.0.11329682', payerOk: true, hash: hex(0x80 + seq0 + kind), cid: `bafk${kind}`, held: true, hashOk: true, refsMatch: true, unread: false,
        doc: key === 'approval' ? { kind: key, approval: 'approved', approvalBasis: 'mandate' } : { kind: key, attrs: { brand: 'Northwind', colour: 'Navy', size: sizes[kind] } },
      })),
      ...claim,
    },
    meta: { apiVersion: '1', asOf: { hedera: 1_794_002_538, arbitrum: 1_794_002_535, hcs: 1_794_002_538 }, degraded: [], vaultToken: mock },
  };
}

const payoutBody = body(PAYOUT_CLAIM, ['M', 'M', '', 'L', 'L', 'L'], 13, {
  filedAt: '1793993006',
  statusKey: 'closed_uncontested',
  nextActor: 'shop',
  nextCall: 'withdrawCredit',
  findingSide: 'platform',
  precheck: { gap: 2, answer: 1, side: 'platform', packHash: hex(1), preCheckedAt: '1793993040', result: { state: 'recorded', reasonKey: 'gap2_shown_vs_ordered' }, packHashOk: true },
  contest: { by: null, at: null, windowEndsAt: '1793993640' },
  court: { state: 'none', attempts: 0, disputeIds: [], period: null, periodName: null, currentRuling: null, tied: null, overridden: null, ruling: null, evidence: [], courtLinks: [] },
  messages: [],
  money: { owed: '2575000', paid: '2575000', credited: '3575000', notCovered: '0', escrow: { amount: '1000000', fate: 'refunded' }, projected: false },
  events: [ev('ClaimFiled', 'hedera', '1793993007'), ev('PreCheckRecorded', 'hedera', '1793993040'), ev('ClosedUncontested', 'hedera', '1793993727')],
});

const KLEROS = 'https://v2-testnet.kleros.builders/#/cases/212/overview';
const courtBody = body(COURT_CLAIM, ['M', 'L', '', 'L', 'L', 'L'], 7, {
  filedAt: '1793955957',
  statusKey: 'settled',
  findingSide: 'neither',
  precheck: { gap: 0, answer: 3, side: 'neither', packHash: hex(2), preCheckedAt: '1793955978', result: { state: 'recorded', reasonKey: 'no_gap_approved_change' }, packHashOk: true },
  contest: { by: SHOP, at: '1793956006', windowEndsAt: '1793956578' },
  court: { state: 'relayed', attempts: 1, disputeIds: ['212'], period: 4, periodName: 'execution', currentRuling: '3', tied: false, overridden: false, ruling: 3, evidence: [], courtLinks: [{ disputeId: '212', url: KLEROS }] },
  messages: [
    { messageId: hex(3), direction: 'toArbitrum', sendNo: 1, sentAt: '1793956025', executionState: 2, ccipExplorer: `https://ccip.chain.link/msg/${hex(3)}` },
    { messageId: hex(4), direction: 'toHedera', sendNo: 1, sentAt: '1793962317', executionState: 2, ccipExplorer: `https://ccip.chain.link/msg/${hex(4)}` },
  ],
  money: { owed: '0', paid: '0', credited: '0', notCovered: '0', escrow: { amount: '1000000', fate: 'kept_by_pool' }, projected: false },
  events: [ev('Contested', 'hedera', '1793956006'), ev('CaseOpened', 'arbitrum', '1793956101'), ev('Ruling', 'arbitrum', '1793961786'), ev('RulingReceived', 'hedera', '1793963435'), ev('Settled', 'hedera', '1793963452')],
});

const payout = () => fromV1(structuredClone(payoutBody)) as StoryClaim;
const court = () => fromV1(structuredClone(courtBody)) as StoryClaim;
/** Server-rendered HTML without React's `<!-- -->` text separators, so copy can be matched whole. */
const render = (p: StoryClaim | null, c: StoryClaim | null) => renderToString(<StoryView payout={p} court={c} />).replaceAll('<!-- -->', '');
/** The visible words only, tags dropped. */
const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

/** Words the operator never wants on a page of this demo. */
const FORBIDDEN = /AI court|mainnet|production|audited|anyone can re-run it|USDC settlement|\blive\b|\blocked\b|\bsample\b|Fennick|Talvo|Tallowmere|Case 881/i;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the story page', () => {
  it('tells the five beats in order, each a section under its own h2', () => {
    const html = render(payout(), court());
    const order = [...html.matchAll(/<h2 id="([^"]+)">/g)].map((m) => m[1]);
    expect(order).toEqual(['beat-1', 'beat-2', 'beat-3', 'beat-4', 'beat-5', 'story-next']);
    for (let n = 1; n <= 5; n++) expect(html).toContain(`<section class="beat beat-${n}" aria-labelledby="beat-${n}">`);
    expect(html).not.toContain('<h1');
  });

  it('beat 1: what was asked, shown, ordered, packed and arrived, the sizes read from the records', () => {
    const p = payout();
    expect(sizesOf(p).map((s) => `${s.label} ${s.size} ${s.read}`)).toEqual(['Asked M true', 'Shown M true', 'Ordered L true', 'Packed L true', 'Arrived L true']);
    const text = words(render(p, court()));
    expect(text).toContain('The buyer asked for a navy tee in size M. The agent ordered size L.');
    expect(text).toContain('The agent, run by Parcel Minds, showed the buyer M at checkout, but its order to Halden Supply said L. The shop packed L, and the buyer reported that L arrived.');
    expect(text).toContain('read from the claim');
  });

  it('beat 2: a record cannot change, with the hash defined and the six records on the public topic', () => {
    const html = render(payout(), court());
    const text = words(html);
    expect(text).toContain('A record cannot change once it is written.');
    expect(text).toContain('a short fingerprint of its exact text');
    expect(text).toContain('public Hedera Consensus Service topic');
    expect(text).toContain('It does not show the record is true.');
    expect(html).toContain('href="https://hashscan.io/testnet/topic/0.0.11335218"');
    for (const seq of ['#13', '#14', '#15', '#16', '#17', '#18']) expect(html).toContain(`>${seq}<`);
  });

  it('beat 3: the first place the records differ, Shown against Ordered, and the side the pre-check names', () => {
    const html = render(payout(), court());
    const text = words(html);
    expect(text).toContain('The records show the first place they differ.');
    expect(text).toContain('a signed check of the records against the fault rule');
    // the Shown record is what the agent showed the buyer
    expect(text).toContain('What the agent showed differs from what it ordered.');
    expect(text).not.toContain('was shown');
    expect(html).toMatch(/<li class="cut"><span class="k">Shown<\/span><span class="v">M<\/span><\/li><li class="off"><span class="k">Ordered<\/span><span class="v">L<\/span>/);
    expect(html).toContain('At fault: <span class="fault">the agent company</span>');
  });

  it('beat 4: a Kleros court of human jurors, over Chainlink CCIP and back, dispute 212 ruled neither side at fault', () => {
    const html = render(payout(), court());
    const text = words(html);
    expect(text).toContain('If a side disagrees, a Kleros court decides.');
    // only the side the finding goes against may contest it (the shop, when it finds neither side at fault)
    expect(text).toContain("The side the pre-check finds at fault can contest it within the claim's contest window (when it finds neither side at fault, the shop can).");
    expect(text).not.toContain('Either side can contest');
    expect(text).toContain('human jurors in a Kleros court decide');
    expect(text).toContain('Chainlink CCIP, a service that carries messages between chains');
    expect(text).toContain("approved under the buyer's standing spending mandate");
    expect(text).toContain('The agent showed L where the buyer asked for M');
    expect(text).toContain('Contested by the shop');
    expect(text).toContain('The shop contested. In dispute 212 the jurors ruled that neither side was at fault');
    expect(text).toContain('went to the fee pool');
    expect(text).toContain('Ruling applied: neither side at fault');
    expect(text).toContain('Kleros dispute 212: the jurors ruled that neither side was at fault.');
    expect(html).toContain(`href="${KLEROS}"`);
    expect(html).toContain(`href="https://ccip.chain.link/msg/${hex(3)}"`);
    expect(html).toContain(`href="https://ccip.chain.link/msg/${hex(4)}"`);
  });

  it('beat 4: the ruling and the court fee are told from the court claim read, not fixed in the page', () => {
    expect(courtOutcome(court())).toEqual({ ruled: 'neither side was at fault', applied: 'neither side at fault', fee: 'went to the fee pool' });
    const other = court();
    other.court.ruling = 1;
    other.money.escrow.fate = 'refunded';
    expect(courtOutcome(other)).toEqual({ ruled: 'the agent company was at fault', applied: 'the agent company at fault', fee: 'came back to the shop' });
    const text = words(render(payout(), other));
    expect(text).toContain('In dispute 212 the jurors ruled that the agent company was at fault, and the court fee, which the shop pays when it files a claim, came back to the shop.');
    expect(text).toContain('Ruling applied: the agent company at fault');
    expect(text).toContain('Kleros dispute 212: the jurors ruled that the agent company was at fault.');
    expect(text).not.toContain('neither side was at fault');
    expect(text).not.toContain('fee pool');
    // before the read, the outcome is not stated
    const before = words(render(payout(), null));
    expect(before).toContain('In its dispute the jurors ruled on the records.');
    expect(before).toContain('The ruling settles the claim');
    expect(before).not.toMatch(/neither side was at fault|fee pool/);
  });

  it('beat 5: the deposit paid the shop, every figure from the claim read', () => {
    const p = payout();
    expect(payoutMoney(p)).toEqual({ basket: 1_500_000n, handling: 1_075_000n, paid: 2_575_000n, fee: 1_000_000n, credited: 3_575_000n });
    expect(windowWords(p)).toBe('10-minute');
    const html = render(p, court());
    const text = words(html);
    expect(text).toContain('Nobody contested the first claim within its 10-minute window, so it closed by itself');
    expect(text).toContain('Parcel Minds paid Halden Supply 2.575 mUSDC from its deposit');
    expect(text).toContain('the basket claimed, 1.50 mUSDC, plus handling, 1.075 mUSDC');
    expect(text).toContain("The shop's 1.00 mUSDC court fee came back too. The shop withdrew 3.575 mUSDC in all.");
    expect(text).toContain('mUSDC is a testnet mock of USDC that only the operator can mint.');
    expect(text).toContain('paid in HBAR');
    expect(html).toContain(`href="https://hashscan.io/testnet/transaction/${WITHDRAW_TX}"`);
    // the figure is sized to its length; each part of the bar has its swatch beside its row
    expect(html).toContain('<span class="pay-n" style="--chars:5">2.575</span>');
    for (const n of [1, 2, 3]) expect(html).toContain(`<i class="sw sw-${n}" aria-hidden="true"></i>`);
    // the one image: lazy, with its size set so nothing shifts when it lands
    const img = html.match(/<img [^>]+>/g) ?? [];
    expect(img).toHaveLength(1);
    expect(img[0]).toMatch(/width="640" height="640" alt="" loading="lazy" decoding="async"/);
  });

  it('ends with the two claims, the docket, the two sign-up pages and the operator steps', () => {
    const html = render(payout(), court());
    for (const href of [`#/claim/${PAYOUT_CLAIM}`, `#/claim/${COURT_CLAIM}`, '#/docket', '#/join', '#/bond']) expect(html).toContain(`href="${href}"`);
    const text = words(html);
    expect(text).toContain('I run a shop');
    expect(text).toContain('I run a shopping agent');
    expect(text).toContain("is not in the demo's party map until the operator adds it.");
    expect(text).toContain('Only the operator can mint mUSDC and set the deposit an agent company must keep.');
    expect(html).toContain('<div class="banner" role="note">');
  });

  it('before the reads land: the prose stands, and no figure is shown that was not read', () => {
    const html = render(null, null);
    const text = words(html);
    expect(text).toContain('The buyer asked for a navy tee in size M. The agent ordered size L.');
    expect(text).toContain('The amounts appear here once the claim is read.');
    expect(text).toContain('not read yet');
    expect(text).not.toMatch(/\d+\.\d+ mUSDC/);
    expect(text).not.toContain('212');
    expect(text).not.toContain('10-minute');
    expect(text).not.toContain('read from the claim');
    expect(html).not.toContain('<img');
    // the story's own letters and finding are muted and said to be unread, never shown as read values
    expect(html.match(/<li class="[^"]*told[^"]*"/g)).toHaveLength(5);
    expect(html).toContain('<figure class="rail-fig told">');
    expect(text).toContain('as the story tells it; the claim is not read yet');
    expect(text).toContain('At fault, as the story tells it: the agent company. The claim is not read yet.');
    expect(html).not.toContain('class="fault"');
    expect(text).not.toMatch(/neither side was at fault|fee pool/);
    // the prose still names the operator steps and every way out
    expect(text).toContain('Only the operator can mint mUSDC');
    for (const href of ['#/docket', '#/join', '#/bond']) expect(html).toContain(`href="${href}"`);
  });

  it("shows the site-wide notice from the claim read's meta (the owner's remaining powers), and one notice when the reads fail", () => {
    const notice = 'The owner can still change the contest window, the court fee and the handling.';
    const lock = { allLocked: false, notice };
    const p = fromV1({ ...structuredClone(payoutBody), meta: { ...payoutBody.meta, configLock: lock } }) as StoryClaim;
    const html = renderToString(<StoryBody payout={p} court={court()} error={null} />);
    expect(html).toContain('<div class="banner" role="status">');
    expect(html).toContain(notice);
    expect(html).toContain('a testnet mock of USDC');
    // the API down before any read: the dashed box says so, and the banner does not say it again
    const down = words(renderToString(<StoryBody payout={null} court={null} error={new ApiFailure(0, 'unreachable')} />));
    expect(down).toContain('The status service did not return the claims');
    expect(down).not.toContain('cannot be reached');
    // a read that later fails, with the claims already read: the banner says the figures may be out of date
    expect(words(renderToString(<StoryBody payout={payout()} court={court()} error={new ApiFailure(0, 'unreachable')} />))).toContain('cannot be reached');
  });

  it('nothing here signs or claims to be signed: no wallet control, and the only signature named is the pre-check service', () => {
    for (const html of [render(payout(), court()), render(null, null)]) {
      expect(html).not.toContain('<button');
      expect(html).not.toContain('<form');
      expect(html).not.toContain('Connect wallet');
      expect(words(html).match(/\bsign\w*/gi)).toEqual(['signed']);
      expect(words(html)).toContain('a signed check of the records');
    }
  });

  it('keeps to the copy rules and names no made-up case', () => {
    for (const html of [render(payout(), court()), render(null, null)]) expect(words(html)).not.toMatch(FORBIDDEN);
    const src = readFileSync(new URL('../src/pages/Story.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(FORBIDDEN);
    expect(src).not.toMatch(/<video|\.mp4|\.webm/);
  });

  it('reads the two claims with the claim read the claim page makes, through the API client', async () => {
    expect([...STORY_READS]).toEqual([READS.claim(PAYOUT_CLAIM), READS.claim(COURT_CLAIM)]);
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify(url.includes(PAYOUT_CLAIM) ? payoutBody : courtBody), { status: 200 });
    });
    const p = await getRead<StoryClaim>(STORY_READS[0]);
    const c = await getRead<StoryClaim>(STORY_READS[1]);
    expect(asked).toEqual([apiUrl(`/v1/claims/${PAYOUT_CLAIM}`), apiUrl(`/v1/claims/${COURT_CLAIM}`)]);
    expect(p.vaultToken?.symbol).toBe('mUSDC');
    const text = words(render(p, c));
    expect(text).toContain('Halden Supply v Parcel Minds');
    expect(text).toContain('Closed, not contested');
    expect(text).toContain('Kleros dispute 212');
  });

  it('opens loading, its head unchanged and every beat already there, with nothing hidden before a script runs', async () => {
    vi.stubGlobal('fetch', () => new Promise(() => {}));
    const { prelude } = await prerender(<Shell hash="#/story" />);
    const html = (await new Response(prelude).text()).replaceAll('<!-- -->', '');
    expect(html).toContain('<h1>How it works</h1>');
    expect(html).toContain('Loading the two claims');
    expect(html).toContain('<div class="story-page">');
    for (let n = 1; n <= 5; n++) expect(html).toContain(`id="beat-${n}"`);
    expect(html).not.toContain('Connect wallet');
  });

  it('moves only transform and opacity, and hides a beat only for the reveal, under no-preference', () => {
    const css = readFileSync(new URL('../src/styles/story.css', import.meta.url), 'utf8');
    const [before, motion = ''] = css.split('@media screen and (prefers-reduced-motion: no-preference)');
    expect(motion).not.toBe('');
    // outside the reveal block nothing starts hidden or scaled to nothing
    expect(before).not.toMatch(/opacity:\s*0[;\s]/);
    expect(before).not.toMatch(/scale[XY]?\(0\)/);
    for (const t of css.match(/transition:[^;]+;/g) ?? []) expect(t).not.toMatch(/\b(width|height|top|left|right|bottom|margin|padding|flex|gap)\b/);
    expect(css).not.toMatch(/animation:/);
  });
});
