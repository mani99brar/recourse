import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import type { StatusKey } from '@recourse/shared';
import ring from '../assets/ring.webp';
import { Arrow, Banner, ExtLink, Loading, Pill, SideWords } from '../components.js';
import { POLL_MS, READS, usePoll, type Fresh } from '../lib/api.js';
import { HEDERA_CHAIN_ID, txLink } from '../lib/chains.js';
import { short, usdc, when } from '../lib/format.js';
import { KIND_WORDS, REASON_WORDS, STATUS_WORDS } from '../lib/words.js';
import { contestedBy, type CaseDetail } from './Case.js';
import '../styles/story.css';

/** The claim the story follows: asked M, shown M, ordered L; nobody contested, so the deposit paid the shop. */
export const PAYOUT_CLAIM = '0x8f78143ea47bd370edb87e91a720955110aa4978d79474a5d5fbbf0d1eec6f75';
/** The claim a court decided: a size change approved under the buyer's mandate, ruled neither side at fault. */
export const COURT_CLAIM = '0x392d6f13cdf5fe1ca93289d143e51b511f333de3d6d1769c72ddd0039c7f3c50';
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
const TOLD_COURT: Record<number, string> = { 0: 'M', 1: 'L', 3: 'L', 4: 'L', 5: 'L' };

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
          <span className="pay-n">{money.paid === null ? 'not yet known' : figure(money.paid)}</span>
          <span className="pay-u">{d.vaultToken?.symbol ?? 'mUSDC'} paid</span>
        </p>
      </div>
      <dl className="ledger">
        <div>
          <dt>Basket claimed</dt>
          <dd>{sum(money.basket)}</dd>
        </div>
        <div>
          <dt>Handling</dt>
          <dd>{sum(money.handling) ?? 'not yet known'}</dd>
        </div>
        <div className="tot">
          <dt>Paid from the deposit</dt>
          <dd>{sum(money.paid) ?? 'not yet known'}</dd>
        </div>
        <div>
          <dt>Court fee returned</dt>
          <dd>{sum(money.fee) ?? 'not returned'}</dd>
        </div>
        <div className="tot">
          <dt>Credited to the shop</dt>
          <dd>{sum(money.credited) ?? 'not yet known'}</dd>
        </div>
      </dl>
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
  const [courtAsked, courtShown] = sizesOf(court, TOLD_COURT).map((s) => s.size) as [string, string];
  const money = payoutMoney(payout);
  const sum = (v: bigint | null) => amount(v, payout);
  const windowLen = windowWords(payout);
  const topic = payout ? `0.0.${payout.refs.topicNum}` : null;
  const reason = payout?.precheck?.result?.reasonKey;
  const dispute = court?.court.disputeIds[0] ?? null;
  const disputeUrl = court?.court.courtLinks.find((l) => l.disputeId === dispute)?.url ?? null;
  const by = court ? contestedBy(court) : null;
  const toCourt = court?.messages.find((m) => m.direction === 'toArbitrum') ?? null;
  const back = court?.messages.find((m) => m.direction === 'toHedera') ?? null;
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
            The story follows one claim, <a href={`#/claim/${PAYOUT_CLAIM}`}>{short(PAYOUT_CLAIM)}</a>, and ends with a second one that went to court.
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
                <li key={s.kind} className={s.size === asked ? undefined : 'off'} style={{ '--i': i } as CSSProperties}>
                  <span className="k">{s.label}</span>
                  <span className="v">{s.size}</span>
                </li>
              ))}
            </ol>
            <figcaption>{sizes.every((s) => s.read) ? 'The size each record of the order states, read from the claim.' : 'The size each record of the order states.'}</figcaption>
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
          <figure className="rail-fig">
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
              <span className="rail-mark">First difference</span> {reason && REASON_WORDS[reason] ? REASON_WORDS[reason] : 'What the agent showed differs from what it ordered.'}
            </p>
            <p className="rail-fault">
              At fault: <SideWords side={payout?.precheck?.side ?? 'platform'} />
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
                <span className="what">{court?.court.ruling === 3 ? 'Ruling applied: neither side at fault' : 'The ruling settles the claim'}</span>
                {at(court, 'Settled') && <span className="t">{at(court, 'Settled')}</span>}
              </li>
            </ol>
            <figcaption>The second claim's way to the court and back.</figcaption>
          </figure>
        }
      >
        <p className="note">
          Either side can contest the pre-check's finding within the claim's contest window. A contested claim travels from Hedera to Arbitrum Sepolia, another test network, over Chainlink CCIP, a service that carries messages between chains. There human jurors in a Kleros court decide, and the ruling comes back over CCIP to settle the claim on Hedera.
        </p>
        <p className="note small-note">
          That is what happened to a second claim. The agent showed {courtShown} where the buyer asked for {courtAsked}, and the records showed the change was approved under the buyer's standing spending mandate, the limits the buyer set in advance for what the agent may buy.{' '}
          {by ? `${by[0]!.toUpperCase()}${by.slice(1)} contested.` : 'A side contested.'} In {dispute ? `dispute ${dispute}` : 'its dispute'} the jurors ruled that neither side was at fault, and the court fee, which the shop pays when it files a claim, went to the fee pool.
        </p>
        <p className="beat-links">
          <a href={`#/claim/${COURT_CLAIM}`}>Open the second claim</a>
          {disputeUrl && <ExtLink href={disputeUrl}>The dispute on Kleros</ExtLink>}
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
          <Door href={`#/claim/${COURT_CLAIM}`} kicker="The second claim" title="Decided in court">
            {dispute ? `Kleros dispute ${dispute}` : 'A Kleros dispute'}: the jurors ruled neither side at fault.
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

/** How a claim runs, told through two real cases on the test networks. */
export function StoryPage() {
  const ref = useReveal();
  // both claims are finished, so a slow re-read is enough
  const payout = usePoll<StoryClaim>(STORY_READS[0], POLL_MS * 12);
  const court = usePoll<StoryClaim>(STORY_READS[1], POLL_MS * 12);
  const error = payout.error ?? court.error;
  return (
    <div className="story-page" ref={ref}>
      <div className="page-head">
        <h1>How it works</h1>
        <p className="lead">
          A shopping agent is software that buys for a person, and the agent company that runs it answers for what it buys. When it buys the wrong thing, who pays the shop? Here is one claim from start to end in five steps, and a second claim that went to court, both read from the test networks.
        </p>
      </div>
      <Banner error={error} />
      {!payout.data && !error && <Loading what="the two claims" />}
      {!payout.data && error && <p className="empty">The status service did not return the claims, so their names and amounts are not shown.</p>}
      <StoryView payout={payout.data} court={court.data} />
    </div>
  );
}
