import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import type { StatusKey } from '@recourse/shared';
import ring from '../assets/ring.webp';
import { Arrow, Banner, ExtLink, Loading, Pill, SideWords } from '../components.js';
import { POLL_MS, READS, usePoll, type ApiFailure, type Fresh } from '../lib/api.js';
import { HEDERA_CHAIN_ID, txLink } from '../lib/chains.js';
import { short, usdc, when } from '../lib/format.js';
import { KIND_WORDS, REASON_WORDS, STATUS_WORDS } from '../lib/words.js';
import { contestedBy, type CaseDetail } from './Case.js';
import '../styles/story.css';

/** The claim the story follows: asked M, shown M, ordered L; nobody contested, so the deposit paid the shop. */
export const PAYOUT_CLAIM = '0x8f78143ea47bd370edb87e91a720955110aa4978d79474a5d5fbbf0d1eec6f75';
/** The claim a court decided against the agent company: the first claim's records, contested, Kleros dispute 213, ruling 1. */
export const COURT_CLAIM = '0x00ad6c98af5cc7ae1e17dba7359c524ae8d6c37c32c1c01272830332e69efeae';
/** The claim a court decided neither side at fault (Kleros dispute 212): a size change approved under the buyer's mandate. */
export const MANDATE_CLAIM = '0x392d6f13cdf5fe1ca93289d143e51b511f333de3d6d1769c72ddd0039c7f3c50';
/** Its dispute on Kleros; the story tells it from the record, not from a read. */
export const MANDATE_DISPUTE_URL = 'https://v2-testnet.kleros.builders/#/cases/212/overview';
/** The shop's withdrawal of its credit from the payout claim, on Hedera testnet; the claim read does not carry it. */
export const WITHDRAW_TX = '0xb08f494f57e4e1abf85e7688e29a61e6812c0b7e58bf49d7d89e2fbd38b81539';

/** The two reads the page makes: the claim read the claim page makes, once for each claim. */
export const STORY_READS = [READS.claim(PAYOUT_CLAIM), READS.claim(COURT_CLAIM)] as const;

/** The parts of a claim read (GET /v1/claims/{id}) the story tells. `records[].doc` is the record document once verified. */
export interface StoryClaim extends Fresh {
  claimId: string;
  shop: string;
  shopName: string | null;
  platform: string;
  platformName: string | null;
  filedAt: string;
  statusKey: StatusKey;
  netLossUsdc: string;
  refs: { topicNum: string; seq: string[]; hashes: string[] };
  records: { kind: number; seq: number; hash: string | null; held: boolean | null; doc: { attrs?: Record<string, string> } | null }[];
  precheck: { side: string; preCheckedAt: string; result: { reasonKey?: string } | null } | null;
  contest: CaseDetail['contest'];
  court: Pick<CaseDetail['court'], 'disputeIds' | 'courtLinks' | 'ruling'>;
  messages: Pick<CaseDetail['messages'][number], 'messageId' | 'direction' | 'ccipExplorer'>[];
  money: Pick<CaseDetail['money'], 'owed' | 'paid' | 'credited' | 'escrow'>;
  events: CaseDetail['events'];
}

/** The five records that state a size, in order; the approval record states none. */
const SIZE_KINDS = [0, 1, 3, 4, 5] as const;
/** The sizes as the story tells them, per claim; a record read from the claim replaces its letter with its own. */
const TOLD_PAYOUT: Record<number, string> = { 0: 'M', 1: 'M', 3: 'L', 4: 'L', 5: 'L' };
const TOLD_COURT: Record<number, string> = TOLD_PAYOUT;

/** Asked, shown, ordered, packed and arrived, each with its size and whether the claim read gave it. */
export function sizesOf(d: StoryClaim | null, told: Record<number, string> = TOLD_PAYOUT): { kind: number; label: string; size: string; read: boolean }[] {
  return SIZE_KINDS.map((kind) => {
    const read = d?.records.find((r) => r.kind === kind)?.doc?.attrs?.size;
    return { kind, label: KIND_WORDS[kind], size: read ?? told[kind]!, read: read !== undefined };
  });
}

/** An amount without its unit ("2.575"), exact as usdc() gives it. */
function figure(v: bigint): string {
  return usdc(v).replace(/ USDC$/, '');
}

/** An amount in the vault token's symbol ("2.575 mUSDC"); null when the read has not given it. */
function amount(v: bigint | null | undefined, d: Fresh | null): string | null {
  return v === null || v === undefined ? null : `${figure(v)} ${d?.vaultToken?.symbol ?? 'mUSDC'}`;
}

/**
 * What the deposit paid on the payout claim, from its read: the loss claimed plus handling (what was owed less
 * the loss), the court fee when it was returned, and the shop's credit. Null before the read lands.
 */
export function payoutMoney(d: StoryClaim | null): { basket: bigint; handling: bigint | null; paid: bigint | null; fee: bigint | null; credited: bigint | null } | null {
  if (!d) return null;
  const { owed, paid, credited, escrow } = d.money;
  const basket = BigInt(d.netLossUsdc);
  return {
    basket,
    handling: owed !== null && BigInt(owed) >= basket ? BigInt(owed) - basket : null,
    paid: paid === null ? null : BigInt(paid),
    fee: escrow.fate === 'refunded' ? BigInt(escrow.amount) : null,
    credited: credited === null ? null : BigInt(credited),
  };
}

/** The claim's own contest window ("10-minute"): from when the pre-check was recorded to the window's end. */
export function windowWords(d: StoryClaim | null): string | null {
  if (!d?.precheck || d.contest.windowEndsAt === null) return null;
  const s = Number(d.contest.windowEndsAt) - Number(d.precheck.preCheckedAt);
  if (!(s > 0)) return null;
  return s % 60 === 0 ? `${s / 60}-minute` : `${s}-second`;
}

/** When the claim's event of that name happened, or null. */
function at(d: StoryClaim | null, name: string): string | null {
  const e = d?.events.find((x) => x.name === name);
  return e ? when(e.time) : null;
}

/** A ruling as the second claim's prose and its route panel say it (1 the agent company, 2 the shop, 3 neither). */
const RULED: Record<number, string> = { 1: 'the agent company was at fault', 2: 'the shop was at fault', 3: 'neither side was at fault' };
const APPLIED: Record<number, string> = { 1: 'the agent company at fault', 2: 'the shop at fault', 3: 'neither side at fault' };
/** Where the shop's court fee went, by its escrow's fate. */
const FEE_WENT: Record<string, string> = {
  kept_by_pool: 'went to the fee pool',
  refunded: 'came back to the shop',
  split: 'was partly returned to the shop and partly kept by the fee pool',
};

/** What the court claim's read says the jurors decided and where the court fee went; null for what it does not say yet. */
export function courtOutcome(d: StoryClaim | null): { ruled: string | null; applied: string | null; fee: string | null } {
  const ruling = d?.court.ruling ?? null;
  return {
    ruled: ruling === null ? null : (RULED[ruling] ?? null),
    applied: ruling === null ? null : (APPLIED[ruling] ?? null),
    fee: d ? (FEE_WENT[d.money.escrow.fate] ?? null) : null,
  };
}

/**
 * What the deposit paid on a claim the court ruled against the agent company: the loss claimed, handling, and the shop's
 * court fee repaid (owed less these is nothing). Null unless the ruling is 1 and the read gives the amounts.
 */
export function courtPaid(d: StoryClaim | null): { paid: bigint; basket: bigint; handling: bigint; fee: bigint } | null {
  if (!d || d.court.ruling !== 1 || d.money.paid === null) return null;
  const paid = BigInt(d.money.paid);
  const basket = BigInt(d.netLossUsdc);
  const fee = BigInt(d.money.escrow.amount);
  const handling = paid - basket - fee;
  return fee > 0n && handling >= 0n ? { paid, basket, handling, fee } : null;
}

/** Adds .reveal to the page once an observer can run, and .in to each beat as it scrolls into view. */
function useReveal() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    // with reduced motion, or no observer, every beat is simply there
    if (!el || typeof IntersectionObserver === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.12 },
    );
    el.classList.add('reveal');
    el.querySelectorAll('.beat').forEach((b) => io.observe(b));
    return () => {
      io.disconnect();
      el.classList.remove('reveal');
    };
  }, []);
  return ref;
}

/** One beat: its number and name, the line, the words, and beside them what the records show. */
function Beat({ n, name, title, art, children }: { n: number; name: string; title: ReactNode; art: ReactNode; children: ReactNode }) {
  return (
    <section className={`beat beat-${n}`} aria-labelledby={`beat-${n}`}>
      <div className="beat-copy">
        <p className="eyebrow">
          {n} of 5 · {name}
        </p>
        <h2 id={`beat-${n}`}>{title}</h2>
        {children}
      </div>
      <div className="beat-art">{art}</div>
    </section>
  );
}

/** A way out of the story, in the home page's door terms: who it is for, where it goes, what is there. */
function Door({ href, kicker, title, children }: { href: string; kicker: string; title: string; children: ReactNode }) {
  return (
    <li>
      <a className="story-door" href={href}>
        <span className="sd-kicker">{kicker}</span>
        <span className="sd-title">
          {title}
          <Arrow />
        </span>
        <span className="sd-text">{children}</span>
      </a>
    </li>
  );
}

/** What the deposit paid, part by part, with the ring the deposit mark uses; figures from the payout claim's read. */
function PayArt({ d, money }: { d: StoryClaim; money: NonNullable<ReturnType<typeof payoutMoney>> }) {
  const sum = (v: bigint | null) => amount(v, d);
  // the bar's three parts in proportion: the loss claimed, handling and the returned fee
  const parts = money.handling !== null && money.fee !== null ? [money.basket, money.handling, money.fee] : null;
  return (
    <figure className="pay-fig">
      <div className="pay-ring">
        <img src={ring} width={640} height={640} alt="" loading="lazy" decoding="async" />
        <p>
          {money.paid === null ? (
            <span className="pay-u">not yet known</span>
          ) : (
            // sized to its length, so a longer figure stays inside the ring
            <span className="pay-n" style={{ '--chars': figure(money.paid).length } as CSSProperties}>
              {figure(money.paid)}
            </span>
          )}
          <span className="pay-u">{d.vaultToken?.symbol ?? 'mUSDC'} paid</span>
        </p>
      </div>
      <dl className="ledger">
        <div>
          <dt>
            {parts && <i className="sw sw-1" aria-hidden="true" />}
            Basket claimed
          </dt>
          <dd>{sum(money.basket)}</dd>
        </div>
        <div>
          <dt>
            {parts && <i className="sw sw-2" aria-hidden="true" />}
            Handling
          </dt>
          <dd>{sum(money.handling) ?? 'not yet known'}</dd>
        </div>
        <div className="tot">
          <dt>Paid from the deposit</dt>
          <dd>{sum(money.paid) ?? 'not yet known'}</dd>
        </div>
        <div>
          <dt>
            {parts && <i className="sw sw-3" aria-hidden="true" />}
            Court fee returned
          </dt>
          <dd>{sum(money.fee) ?? 'not returned'}</dd>
        </div>
        <div className="tot">
          <dt>Credited to the shop</dt>
          <dd>{sum(money.credited) ?? 'not yet known'}</dd>
        </div>
      </dl>
      {/* the three parts in proportion, each drawn as the swatch beside its row */}
      {parts && (
        <div className="bar" aria-hidden="true">
          {parts.map((p, i) => (
            <span key={i} style={{ flexGrow: Number(p) }} />
          ))}
        </div>
      )}
      <figcaption>
        Read from the first claim. <ExtLink href={txLink(HEDERA_CHAIN_ID, WITHDRAW_TX)}>The shop's withdrawal on HashScan</ExtLink>
      </figcaption>
    </figure>
  );
}

export function StoryView({ payout, court }: { payout: StoryClaim | null; court: StoryClaim | null }) {
  const shop = payout?.shopName ?? null;
  const company = payout?.platformName ?? null;
  const sizes = sizesOf(payout);
  const [asked, shown, ordered, packed, arrived] = sizes.map((s) => s.size) as [string, string, string, string, string];
  const [courtAsked, courtShown, courtOrdered] = sizesOf(court, TOLD_COURT).map((s) => s.size) as [string, string, string];
  const sameRecords = courtAsked === asked && courtShown === shown && courtOrdered === ordered;
  const paidByCourt = courtPaid(court);
  const money = payoutMoney(payout);
  const sum = (v: bigint | null) => amount(v, payout);
  const windowLen = windowWords(payout);
  const topic = payout ? `0.0.${payout.refs.topicNum}` : null;
  const reason = payout?.precheck?.result?.reasonKey;
  const dispute = court?.court.disputeIds[0] ?? null;
  const disputeUrl = court?.court.courtLinks.find((l) => l.disputeId === dispute)?.url ?? null;
  const by = court ? contestedBy(court) : null;
  const outcome = courtOutcome(court);
  // until the payout claim is read, its letters and its finding are the story's, shown muted
  const sizesRead = sizes.every((s) => s.read);
  const toCourt = court?.messages.find((m) => m.direction === 'toArbitrum') ?? null;
  const back = court?.messages.find((m) => m.direction === 'toHedera') ?? null;
  // what the jurors' ruling did, in the read's own words: the deposit paid the shop when they ruled against the agent company
  const ruledWords = outcome.ruled ? `the jurors ruled that ${outcome.ruled}` : 'the jurors ruled on the records';
  const deposit = `${court?.platformName ?? 'the agent company'}'s deposit`;
  const feeWords = outcome.fee ? `, and the court fee, which the shop pays when it files a claim, ${outcome.fee}` : '';
  const courtDid = paidByCourt
    ? `${ruledWords}, and ${deposit} paid ${court?.shopName ?? 'the shop'} ${amount(paidByCourt.paid, court)}: the basket, ${amount(paidByCourt.basket, court)}, handling, ${amount(paidByCourt.handling, court)}, and the shop's ${amount(paidByCourt.fee, court)} court fee back.`
    : court?.court.ruling === 1
      ? `${ruledWords}, and the agent company's deposit paid the shop the basket, handling and the shop's court fee back.`
      : `${ruledWords}${feeWords}.`;
  return (
    <>
      <p className="story-case">
        {payout ? (
          <>
            The story follows one claim:{' '}
            <a href={`#/claim/${PAYOUT_CLAIM}`}>
              {shop ?? short(payout.shop)} v {company ?? short(payout.platform)}
            </a>
            , filed {when(payout.filedAt)}. <Pill tone="ok">{STATUS_WORDS[payout.statusKey].title}</Pill>
          </>
        ) : (
          <>
            The story follows one claim, <a href={`#/claim/${PAYOUT_CLAIM}`}>{short(PAYOUT_CLAIM)}</a>, and ends with a third one that went to court.
          </>
        )}
      </p>

      <Beat
        n={1}
        name="What was asked, what was bought"
        title={
          <>
            The buyer asked for a navy tee in size {asked}. The agent ordered <em>size {ordered}.</em>
          </>
        }
        art={
          <figure className="sizes-fig">
            <ol className="sizes">
              {sizes.map((s, i) => (
                <li key={s.kind} className={[s.size === asked ? '' : 'off', s.read ? '' : 'told'].filter(Boolean).join(' ') || undefined} style={{ '--i': i } as CSSProperties}>
                  <span className="k">{s.label}</span>
                  <span className="v">{s.size}</span>
                </li>
              ))}
            </ol>
            <figcaption>{sizesRead ? 'The size each record of the order states, read from the claim.' : 'The size each record of the order states, as the story tells it; the claim is not read yet.'}</figcaption>
          </figure>
        }
      >
        <p className="note">
          The agent{company ? `, run by ${company},` : ''} showed the buyer {shown} at checkout, but its order{shop ? ` to ${shop}` : ''} said {ordered}. The shop packed {packed}, and the buyer reported that {arrived} arrived.
        </p>
      </Beat>

      <Beat
        n={2}
        name="The records"
        title="A record cannot change once it is written."
        art={
          <figure className="chain-fig">
            <p className="chain-head">
              Records topic{' '}
              {topic ? (
                <ExtLink href={`https://hashscan.io/testnet/topic/${topic}`}>
                  <span className="mono">{topic}</span>
                </ExtLink>
              ) : (
                <span className="muted">not read yet</span>
              )}
            </p>
            <ol className="chain">
              {KIND_WORDS.map((k, i) => {
                const seq = payout?.refs.seq[i];
                const hash = payout?.refs.hashes[i];
                return (
                  <li key={k} style={{ '--i': i } as CSSProperties}>
                    <span className="mono seq">{seq && seq !== '0' ? `#${seq}` : ''}</span>
                    <span className="kind">{k}</span>
                    <span className="mono hash">{hash ? short(hash, 4) : 'not read yet'}</span>
                  </li>
                );
              })}
            </ol>
            <figcaption>The order's six records, by message number on the topic, each with its hash.</figcaption>
          </figure>
        }
      >
        <p className="note">
          Each step of the order is kept as a record. Each record's hash, a short fingerprint of its exact text that changes if a single character changes, goes on a public Hedera Consensus Service topic: a message log on Hedera that anyone can read and nobody can edit.
        </p>
        <p className="note small-note">A matching hash shows a record has not changed since it was written. It does not show the record is true.</p>
      </Beat>

      <Beat
        n={3}
        name="The pre-check"
        title={
          <>
            The records show the first place they <em>differ.</em>
          </>
        }
        art={
          <figure className={sizesRead ? 'rail-fig' : 'rail-fig told'}>
            <ol className="rail">
              <li>
                <span className="k">Asked</span>
                <span className="v">{asked}</span>
              </li>
              <li className="cut">
                <span className="k">Shown</span>
                <span className="v">{shown}</span>
              </li>
              <li className="off">
                <span className="k">Ordered</span>
                <span className="v">{ordered}</span>
              </li>
            </ol>
            <p className="rail-gap">
              {/* the Shown record is what the agent showed the buyer, so this claim's gap is told in the story's own words */}
              <span className="rail-mark">First difference</span>{' '}
              {reason && reason !== 'gap2_shown_vs_ordered' && REASON_WORDS[reason] ? REASON_WORDS[reason] : 'What the agent showed differs from what it ordered.'}
            </p>
            <p className="rail-fault">
              {payout?.precheck ? (
                <>
                  At fault: <SideWords side={payout.precheck.side} />
                </>
              ) : (
                <span className="muted">At fault, as the story tells it: the agent company. The claim is not read yet.</span>
              )}
            </p>
          </figure>
        }
      >
        <p className="note">
          The pre-check, a signed check of the records against the fault rule, reads them in order and stops at the first place two of them differ. Here what the agent showed ({shown}) and what it ordered ({ordered}) differ, so it found the agent company at fault.
        </p>
      </Beat>

      <Beat
        n={4}
        name="The court"
        title="If a side disagrees, a Kleros court decides."
        art={
          <figure className="route-fig">
            <ol className="route">
              <li className="stop">
                <span className="net">Hedera testnet</span>
                <span className="what">{by ? `Contested by ${by}` : 'The claim is contested'}</span>
                {at(court, 'Contested') && <span className="t">{at(court, 'Contested')}</span>}
              </li>
              <li className="hop">
                Over Chainlink CCIP
                {toCourt && (
                  <>
                    {' · '}
                    <ExtLink href={toCourt.ccipExplorer}>the message</ExtLink>
                  </>
                )}
              </li>
              <li className="stop court">
                <span className="net">Arbitrum Sepolia</span>
                <span className="what">
                  {dispute ? <ExtLink href={disputeUrl}>Kleros dispute {dispute}</ExtLink> : 'A Kleros dispute'}: human jurors rule
                </span>
                {at(court, 'Ruling') && <span className="t">Ruled {at(court, 'Ruling')}</span>}
              </li>
              <li className="hop">
                Back over Chainlink CCIP
                {back && (
                  <>
                    {' · '}
                    <ExtLink href={back.ccipExplorer}>the message</ExtLink>
                  </>
                )}
              </li>
              <li className="stop">
                <span className="net">Hedera testnet</span>
                <span className="what">{outcome.applied ? `Ruling applied: ${outcome.applied}` : 'The ruling settles the claim'}</span>
                {at(court, 'Settled') && <span className="t">{at(court, 'Settled')}</span>}
              </li>
            </ol>
            <figcaption>The third claim's way to the court and back.</figcaption>
          </figure>
        }
      >
        <p className="note">
          The side the pre-check finds at fault can contest it within the claim's contest window (when it finds neither side at fault, the shop can). A contested claim travels from Hedera to Arbitrum Sepolia, another test network, over Chainlink CCIP, a service that carries messages between chains. There human jurors in a Kleros court decide, and the ruling comes back over CCIP to settle the claim on Hedera.
        </p>
        <p className="note small-note">
          {sameRecords ? 'That is what happened to a third claim, which had the same records as the first: ' : 'That is what happened to a third claim: '}
          the buyer asked for {courtAsked}, the agent showed {courtShown}, and its order said {courtOrdered}. {by ? `This time ${by} contested.` : 'This time a side contested.'} In {dispute ? `dispute ${dispute}` : 'its dispute'} {courtDid}
        </p>
        <p className="note small-note">
          The court does not only side with shops. In dispute 212 the records showed that the buyer's standing spending mandate, the limits the buyer set in advance for what the agent may buy, had approved the size change, so the jurors ruled that neither side was at fault.
        </p>
        <p className="beat-links">
          <a href={`#/claim/${COURT_CLAIM}`}>Open the third claim</a>
          {disputeUrl && <ExtLink href={disputeUrl}>Dispute {dispute} on Kleros</ExtLink>}
          <a href={`#/claim/${MANDATE_CLAIM}`}>Open the claim of dispute 212</a>
          <ExtLink href={MANDATE_DISPUTE_URL}>Dispute 212 on Kleros</ExtLink>
        </p>
      </Beat>

      <Beat
        n={5}
        name="Who pays"
        title={
          <>
            The agent company's deposit <em>pays the shop.</em>
          </>
        }
        art={payout && money ? <PayArt d={payout} money={money} /> : <p className="muted">The amounts appear here once the claim is read.</p>}
      >
        {money ? (
          <p className="note">
            Nobody contested the first claim within its {windowLen ?? 'contest'} window, so it closed by itself on the pre-check's finding. {company ?? 'The agent company'} paid {shop ?? 'the shop'} {sum(money.paid) ?? 'an amount not read yet'} from its deposit, money an agent company keeps in the vault to cover claims: the basket claimed, {sum(money.basket)}
            {money.handling !== null && <>, plus handling, {sum(money.handling)}, the claims contract's allowance for the shop's costs</>}.
            {money.fee !== null && <> The shop's {sum(money.fee)} court fee came back too.</>}
            {money.credited !== null && <> The shop withdrew {sum(money.credited)} in all.</>}
          </p>
        ) : (
          <p className="note">Nobody contested the first claim within its window, so it closed by itself on the pre-check's finding, and the agent company's deposit paid the shop.</p>
        )}
        <p className="note small-note">mUSDC is a testnet mock of USDC that only the operator can mint. Orders in this demo are paid in HBAR, Hedera's own coin.</p>
      </Beat>

      <section className="story-next" aria-labelledby="story-next">
        <h2 id="story-next">Read the claims yourself</h2>
        <ul className="story-doors">
          <Door href={`#/claim/${PAYOUT_CLAIM}`} kicker="The first claim" title="Paid from the deposit">
            Asked M, ordered L. Nobody contested, so the agent company's deposit paid the shop.
          </Door>
          <Door href={`#/claim/${COURT_CLAIM}`} kicker="The third claim" title={court?.court.ruling === 1 ? 'Lost in court' : 'Decided in court'}>
            Same records, but the agent company contested. {dispute ? `Kleros dispute ${dispute}` : 'A Kleros dispute'}: {outcome.ruled ? `the jurors ruled that ${outcome.ruled}.` : 'human jurors ruled on the records.'}
          </Door>
          <Door href={`#/claim/${MANDATE_CLAIM}`} kicker="The second claim" title="Neither side at fault">
            Kleros dispute 212: the buyer's standing mandate had approved the size change, and the jurors ruled that neither side was at fault.
          </Door>
          <Door href="#/docket" kicker="Everyone" title="The docket">
            Ruled cases and monthly counts, read from Arkiv testnet, a public data store.
          </Door>
          <Door href="#/join" kicker="Shops" title="I run a shop">
            Register your shop, then file a claim when an agent's order goes wrong.
          </Door>
          <Door href="#/bond" kicker="Agent companies" title="I run a shopping agent">
            Register your agent company and post a deposit that covers its claims.
          </Door>
        </ul>
        <div className="banner" role="note">
          <p>A shop or agent company that registers an ERC-8004 identity, its public entry in the identity registry on Hedera, is not in the demo's party map until the operator adds it.</p>
          <p>Only the operator can mint mUSDC and set the deposit an agent company must keep.</p>
        </div>
      </section>
    </>
  );
}

/**
 * The story under the page head: the site-wide notice (the owner's remaining powers and late sources,
 * from the claim read's meta) and the five beats. With no claim read, one notice says why.
 */
export function StoryBody({ payout, court, error }: { payout: StoryClaim | null; court: StoryClaim | null; error: ApiFailure | null }) {
  return (
    <>
      <Banner fresh={payout ?? court ?? undefined} error={payout ? error : null} />
      {!payout && !error && <Loading what="the two claims" />}
      {!payout && error && <p className="empty">The status service did not return the claims, so their names and amounts are not shown.</p>}
      <StoryView payout={payout} court={court} />
    </>
  );
}

/** How a claim runs, told through two real cases on the test networks. */
export function StoryPage() {
  const ref = useReveal();
  // both claims are finished, so a slow re-read is enough
  const payout = usePoll<StoryClaim>(STORY_READS[0], POLL_MS * 12);
  const court = usePoll<StoryClaim>(STORY_READS[1], POLL_MS * 12);
  return (
    <div className="story-page" ref={ref}>
      <div className="page-head">
        <p className="eyebrow">The story</p>
        <h1>How it works</h1>
        <p className="lead">
          A shopping agent is software that buys for a person, and the agent company that runs it answers for what it buys. When it buys the wrong thing, who pays the shop? Here is one claim from start to end in five steps, and a third claim, with the same records, that went to court, both read from the test networks.
        </p>
      </div>
      <StoryBody payout={payout.data} court={court.data} error={payout.error ?? court.error} />
    </div>
  );
}
