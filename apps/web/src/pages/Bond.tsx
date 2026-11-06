// The agent company's door: what a deposit of its size would cover, what it agrees to, the bonded
// mark shops read, and, from the person's own wallet, an ERC-8004 registration and a deposit in the
// vault. Every figure is read from the status API (GET /v1/params, /v1/cast, /v1/parties) or the
// chain, or is a number the person typed; the suggestion is labelled an estimate. Nothing here
// signs: the wallet does, after the preview (actions/LocalFlow.tsx).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPublicClient, custom, erc20Abi, getAddress, isAddress, parseAbi, zeroAddress, type Address, type EIP1193Provider, type Hash } from 'viem';
import { TINYBAR_PER_MICRO_USDC, type VaultToken } from '@recourse/shared';
import { LocalFlow, type LocalPlan } from '../actions/LocalFlow.js';
import { Banner, ExtLink, Loading, Pill, Row, lateWords } from '../components.js';
import { READS, usePoll, type ApiFailure, type Fresh } from '../lib/api.js';
import { CHAINS, HEDERA_CHAIN_ID, txLink } from '../lib/chains.js';
import { bondedMark, buildApprove, buildPostDeposit, depositProblems, type BondedMark, type PartyDeposit } from '../lib/deposit.js';
import { parseUsdc, short, usdc, when } from '../lib/format.js';
import { MAX_URI_BYTES, buildRegister, dataUri, readBack as readRegistered, registrationDoc, uriSize, type Registered } from '../lib/identity.js';
import { injectedProvider, useWallet, walletOps } from '../lib/wallet.js';
import { CAST_READ, type CastBody, type CastMember } from './Cast.js';
import { chainNote } from './File.js';
import { Mark, type DepositState, type Standing } from './Party.js';
import '../styles/bond.css';

/** The fields of GET /v1/params this page reads (Params in openapi.json), unwrapped. */
export interface BondParams extends Fresh {
  addresses: { vault: string | null; usdc: string };
  params: {
    claims: { contestWindow: string; courtFeeUsdc: string; handlingBase: string; handlingBps: string; handlingCap: string };
    vault: { topUpWindow: string; exitDelay: string; minDeposit: string } | null;
    /** The chain has not been read yet, so these are the built-in defaults. */
    defaulted?: boolean;
  };
}
type ClaimParams = BondParams['params']['claims'];
type PartyRead = Standing & Fresh;

/** The steps only the operator can take, one line each; the page states them where they apply. */
export const OPERATOR_STEPS = {
  partyMap: 'A new ERC-8004 identity is not in the party map (deployments/parties.json) until the operator adds it; until then the shop service, the agent and the Shops and agents page do not know it.',
  mint: "mUSDC is the vault's testnet mock token, and only the operator, as its owner, can mint it.",
  required: "Only the operator, as the vault's owner, sets a company's required deposit (setRequired); until it is set and met, the company is not in good standing.",
} as const;

/** The two claims the demo has run to the end: one closed by itself, one ruled by the court. */
const PAID_CLAIM = '0x8f78143ea47bd370edb87e91a720955110aa4978d79474a5d5fbbf0d1eec6f75';
const COURT_CLAIM = '0x392d6f13cdf5fe1ca93289d143e51b511f333de3d6d1769c72ddd0039c7f3c50';

/** Seconds as a parameter reads: "10 minutes", "7 days". */
export function duration(sec: string | number): string {
  const s = Number(sec);
  const unit = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;
  if (s > 0 && s % 86_400 === 0) return unit(s / 86_400, 'day');
  if (s > 0 && s % 3600 === 0) return unit(s / 3600, 'hour');
  if (s > 0 && s % 60 === 0) return unit(s / 60, 'minute');
  return unit(s, 'second');
}

/** The vault token's symbol until GET /v1/params or /v1/cast names it: the demo's vault runs on the mUSDC testnet mock. */
const UNIT = 'mUSDC';
/** The token as usdc() and bondedMark() label it, with the mock's own label as the fallback, so no amount is ever labelled bare USDC. */
const labelled = (t: VaultToken | undefined): Pick<VaultToken, 'label'> => t ?? { label: 'mUSDC (testnet mock)' };

/** HBAR per 1 USDC of list price at the demo's fixed rate for orders priced in HBAR (1 HBAR is 10^8 tinybar). */
export const HBAR_PER_USDC = Number((1_000_000n * TINYBAR_PER_MICRO_USDC) / 100_000_000n);

/** A vault amount without its unit ("2.575"), for a figure whose unit is set beside it. */
const figure = (v: bigint | string) => usdc(v).replace(/ USDC$/, '');
/** Amounts with the token's symbol alone, where the page has said once that mUSDC is a testnet mock. */
const inUnit = (unit: string) => (v: bigint | string) => `${figure(v)} ${unit}`;

// ---- your numbers ----

/** What the person types into Your numbers; each field stays text until it reads as a number. */
export interface NumbersInput {
  orders: string;
  /** Average order value, in the vault token. */
  order: string;
  /** Percent of orders that end in a claim the agent company loses. */
  share: string;
  /** Average handling per claim; empty takes the claims contract's rule for the average order. */
  handling: string;
  /** Months of expected payouts the suggestion covers: this page's assumption, not a rule. */
  months: 1 | 2 | 3;
}
type NumberField = 'orders' | 'order' | 'share' | 'handling';

/** The figures the page opens with: an example, labelled as one on the page. */
export const EXAMPLE_NUMBERS: NumbersInput = { orders: '200', order: '1.50', share: '2', handling: '', months: 3 };

export interface Estimate {
  /** Claims lost a month (orders × share), for display. */
  lost: number;
  order: bigint;
  handling: bigint;
  /** The handling is the claims contract's rule for the average order, not a typed figure. */
  handlingFromRule: boolean;
  /** What one lost claim pays the shop: the order's loss (at most its value) plus handling. */
  each: bigint;
  month: bigint;
  /** `month` times the months covered. */
  cover: bigint;
  /** `cover` rounded up to a whole unit, and raised to the floor when under it. */
  suggested: bigint;
  /** The floor raised the figure; null while the floor is not read. */
  floorApplies: boolean | null;
}

/** A percent with at most two decimals, in basis points ("2.5" is 250); null when it is not one. */
export function percentBps(text: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bps <= 10_000 ? bps : null;
}

/** The claims contract's handling for one claim: min(base + order × bps / 10,000, cap), as SettleMath has it. */
export function handlingFor(order: bigint, c: Pick<ClaimParams, 'handlingBase' | 'handlingBps' | 'handlingCap'>): bigint {
  const h = BigInt(c.handlingBase) + (order * BigInt(c.handlingBps)) / 10_000n;
  const cap = BigInt(c.handlingCap);
  return h < cap ? h : cap;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const MAX_AMOUNT = 100_000_000_000n; // 100,000 in micro-units: a ceiling on what the fields take

/**
 * Your numbers worked through, in micro-units: the field problems, or the estimate. `waiting`: the
 * handling comes from the contract's rule and the parameters are not read yet.
 */
export function estimate(i: NumbersInput, p: BondParams['params'] | null | undefined): { problems: Partial<Record<NumberField, string>>; est: Estimate | null; waiting: boolean } {
  const problems: Partial<Record<NumberField, string>> = {};
  const orders = /^\d{1,7}$/.test(i.orders.trim()) ? Number(i.orders.trim()) : 0;
  if (orders < 1 || orders > 1_000_000) problems.orders = 'Enter whole orders, 1 to 1,000,000.';
  const order = parseUsdc(i.order);
  if (order === null || order <= 0n || order > MAX_AMOUNT) problems.order = 'Enter an amount above 0 and up to 100,000, like 1.50.';
  const bps = percentBps(i.share);
  if (bps === null) problems.share = 'Enter a percent from 0 to 100, like 2 or 2.5.';
  const fromRule = i.handling.trim() === '';
  let handling: bigint | null = null;
  if (!fromRule) {
    handling = parseUsdc(i.handling);
    if (handling === null || handling > MAX_AMOUNT) {
      problems.handling = "Enter an amount like 1.075, or leave it empty for the claims contract's figure.";
      handling = null;
    }
  } else if (order !== null && p) handling = handlingFor(order, p.claims);
  const waiting = fromRule && !p;
  if (Object.keys(problems).length > 0 || order === null || bps === null || handling === null) return { problems, est: null, waiting };
  const each = order + handling;
  const month = ceilDiv(BigInt(orders) * BigInt(bps) * each, 10_000n);
  const cover = month * BigInt(i.months);
  const whole = ceilDiv(cover, 1_000_000n) * 1_000_000n;
  const floor = p?.vault ? BigInt(p.vault.minDeposit) : null;
  return {
    problems,
    waiting,
    est: { lost: (orders * bps) / 10_000, order, handling, handlingFromRule: fromRule, each, month, cover, suggested: floor !== null && whole < floor ? floor : whole, floorApplies: floor === null ? null : whole < floor },
  };
}

/** One number field with its label, hint and problem, tied together for a screen reader. */
function NumberInput(f: { id: string; label: string; value: string; hint: ReactNode; problem: string | undefined; placeholder?: string; inputMode: 'numeric' | 'decimal'; onChange: (v: string) => void }) {
  return (
    <div className="bond-field">
      <label htmlFor={f.id}>{f.label}</label>
      <input
        id={f.id}
        inputMode={f.inputMode}
        value={f.value}
        placeholder={f.placeholder}
        autoComplete="off"
        aria-invalid={f.problem ? true : undefined}
        aria-describedby={`${f.id}-h${f.problem ? ` ${f.id}-e` : ''}`}
        onChange={(e) => f.onChange(e.target.value)}
      />
      <p className="hint" id={`${f.id}-h`}>
        {f.hint}
      </p>
      {f.problem && (
        <p className="error small" id={`${f.id}-e`}>
          {f.problem}
        </p>
      )}
    </div>
  );
}

/** Your numbers: the fields beside the estimate they give. Every constant is read from /v1/params or labelled. */
export function NumbersCard({ input, onChange, p, token, failed = false }: { input: NumbersInput; onChange: (next: NumbersInput) => void; p: BondParams | null; token: VaultToken | undefined; failed?: boolean }) {
  const unit = token?.symbol ?? UNIT;
  const own = inUnit(unit);
  const c = p?.params.claims;
  const v = p?.params.vault;
  const note = chainNote(p?.params.defaulted);
  const { problems, est, waiting } = estimate(input, p?.params);
  const order = parseUsdc(input.order);
  const rule = c ? `${figure(c.handlingBase)} plus ${Number(c.handlingBps) / 100}% of the order, at most ${figure(c.handlingCap)}` : null;
  const set = (k: keyof NumbersInput) => (value: string) => onChange({ ...input, [k]: value });
  return (
    <section className="card bond-numbers" id="bond-numbers" aria-labelledby="bond-numbers-h">
      <h2 id="bond-numbers-h">Your numbers</h2>
      <p className="bond-intro">
        How large a deposit your agent company might post: what the claims it loses could cost in a month. Each lost claim pays the shop its loss on the order plus handling, the claims contract's allowance for the
        shop's costs of a claim. The figures filled in are an example; type your own.
      </p>
      <div className="bond-numbers-in">
        <form className="bond-form" noValidate onSubmit={(e) => e.preventDefault()}>
          <NumberInput id="bn-orders" label="Orders a month" inputMode="numeric" value={input.orders} onChange={set('orders')} problem={problems.orders} hint="Whole orders your agent places in a month." />
          <div className="fields">
            <NumberInput
              id="bn-order"
              label={`Average order value (${unit})`}
              inputMode="decimal"
              value={input.order}
              onChange={set('order')}
              problem={problems.order}
              hint={`Orders in this demo are paid in HBAR, at its fixed rate of ${HBAR_PER_USDC} HBAR per 1 USDC of list price (the shop's price unit); claims and deposits count in ${unit}.`}
            />
            <NumberInput
              id="bn-share"
              label="Orders that end in a claim you lose (%)"
              inputMode="decimal"
              value={input.share}
              onChange={set('share')}
              problem={problems.share}
              hint="Your own expectation: the share of orders whose records show your agent at fault."
            />
          </div>
          <NumberInput
            id="bn-handling"
            label={`Average handling per claim (${unit}, optional)`}
            inputMode="decimal"
            value={input.handling}
            onChange={set('handling')}
            problem={problems.handling}
            placeholder={c && order !== null && order > 0n ? figure(handlingFor(order, c)) : undefined}
            hint={
              rule
                ? `Empty: the claims contract's handling for an order of the average value (${rule}${note}).`
                : "Empty: the claims contract's handling for an order of the average value, once its parameters are read."
            }
          />
          <fieldset className="bond-k">
            <legend>Months of payouts the deposit covers (an assumption of this page, not a rule)</legend>
            <div className="bond-opts">
              {([1, 2, 3] as const).map((k) => (
                <label key={k}>
                  <input type="radio" name="bn-months" value={k} checked={input.months === k} onChange={() => onChange({ ...input, months: k })} />
                  <span>{k === 1 ? '1 month' : `${k} months`}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </form>
        <div className="bond-sum" aria-labelledby="bond-sum-h">
          <h3 id="bond-sum-h">The estimate</h3>
          {est ? (
            <dl>
              <Row label="Claims you lose a month">
                {est.lost.toLocaleString('en-US', { maximumFractionDigits: 2 })} ({Number(input.orders).toLocaleString('en-US')} orders × {input.share.trim()}%)
              </Row>
              <Row label="Each one pays the shop">
                {own(est.each)} ({figure(est.order)} for the order, the most its loss can be, plus {figure(est.handling)} handling{est.handlingFromRule ? " by the contract's rule" : ''})
              </Row>
              <Row label="Expected payouts a month">{own(est.month)}</Row>
              <Row label={`Over ${input.months === 1 ? '1 month' : `${input.months} months`}`}>{own(est.cover)}</Row>
            </dl>
          ) : (
            <p className="muted">
              {!waiting
                ? 'Fix the numbers marked in the form to see the estimate.'
                : failed
                  ? "The claims contract's handling rule could not be read just now; type a handling figure to see the estimate."
                  : "Reading the claims contract's handling rule…"}
            </p>
          )}
          <div className="bond-total" aria-live="polite">
            <span>
              Suggested deposit
              <small>An estimate, not the required amount</small>
            </span>
            {est ? (
              <b>
                {figure(est.suggested)}
                <small> {unit}</small>
              </b>
            ) : (
              <b className="bond-nofig">no figure yet</b>
            )}
          </div>
          <ul className="bond-notes">
            <li>
              {v
                ? `Rounded up to a whole ${unit}, and never under the floor: the operator cannot set a required deposit below ${own(v.minDeposit)} (the vault's minDeposit${note}).`
                : `Rounded up to a whole ${unit}. The vault's floor for a required deposit is not read yet.`}
              {est?.floorApplies && ` These numbers come to less (${own(ceilDiv(est.cover, 1_000_000n) * 1_000_000n)}), so the floor is shown.`}
            </li>
            <li>The required amount for your company is the operator's to set (setRequired on the vault), and it can differ from this estimate.</li>
            <li>
              {v
                ? `Top-up window: ${duration(v.topUpWindow)}. When a payout takes a deposit that met its required amount below it, the company stays in good standing for ${duration(v.topUpWindow)} while it tops up; after that, shops stop accepting its orders until it does.`
                : 'Top-up window: not read yet.'}
            </li>
            <li>A claim your agent loses in court also repays the shop's {c ? `${own(c.courtFeeUsdc)} ` : ''}court fee; that is not counted here.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}

// ---- what you agree to ----

export function TermsCard({ p, token }: { p: BondParams | null; token: VaultToken | undefined }) {
  const c = p?.params.claims;
  const own = inUnit(token?.symbol ?? UNIT);
  return (
    <section className="card" id="bond-terms" aria-labelledby="bond-terms-h">
      <h2 id="bond-terms-h">What you agree to</h2>
      <p className="bond-intro">Posting a deposit (your agent company's bond) in the vault holds you to four rules, and the claims contract applies them.</p>
      <ol className="bond-terms">
        <li>
          <b>Your agent writes its records before it pays.</b>
          For each order it writes, on the records topic (a public Hedera Consensus Service topic), what the buyer asked for (the Asked record), what it showed the buyer (Shown) and the buyer's approval of any change, and only
          then what it ordered (Ordered); after delivery, what arrived (Arrived). The shop writes what it packed. A missing Asked, Shown or approval counts against you.
        </li>
        <li>
          <b>The side at fault pays.</b>
          When the records show your agent at fault, the shop is paid from your deposit: its loss on the order (at most the order's value) plus handling
          {c ? `, ${figure(c.handlingBase)} plus ${Number(c.handlingBps) / 100}% of the order and at most ${own(c.handlingCap)}` : " by the claims contract's rule"}. When they show the shop at fault, your deposit pays
          nothing.
        </li>
        <li>
          <b>Contest within the window.</b>
          Each claim gets a pre-check: a signed check of the order's records against the fault rule. If it finds your agent at fault, you may contest within {c ? `${duration(c.contestWindow)} of the pre-check` : 'the contest window'}, and the
          claim goes to a Kleros court, where jurors rule on the records. If nobody contests, the claim closes by itself on the pre-check. See <a href={`#/claim/${PAID_CLAIM}`}>a claim that closed by itself</a> and{' '}
          <a href={`#/claim/${COURT_CLAIM}`}>one the court ruled</a>.
        </li>
        <li>
          <b>The court's loser pays the court fee.</b>
          To file, the shop escrows a court fee{c ? ` of ${own(c.courtFeeUsdc)}` : ''}. If the jurors find your agent at fault, your deposit repays it to the shop with the payout; if they find the shop at fault, the shop
          loses it. If they find neither, the fee goes to the court's fee pool, and your deposit repays the shop when the pre-check had found a gap in your agent's own records.
        </li>
      </ol>
    </section>
  );
}

// ---- what a shop sees ----

const MARK_STATE: Record<BondedMark['state'], DepositState> = { bonded: 'bonded', 'top-up': 'due', 'not-bonded': 'short', unknown: 'unread' };

/** The mark's state as a pill: bonded, needs a top-up by a date, not bonded, or not read. */
export function markPill(mark: BondedMark, read: PartyDeposit | null): { tone: 'ok' | 'wait' | 'bad' | 'plain'; text: string } {
  if (mark.state === 'bonded') return { tone: 'ok', text: 'Bonded' };
  if (mark.state === 'top-up') return { tone: 'wait', text: `Needs a top-up by ${when(read?.topUpDeadline).slice(0, 10)}` };
  if (mark.state === 'not-bonded') return { tone: 'bad', text: 'Not bonded' };
  return { tone: 'plain', text: 'Not read' };
}

/** One agent company as a shop sees it: the mark, its state, and the vault's figures behind them. */
export function SeenCard({ m, read, failed, token }: { m: Pick<CastMember, 'address' | 'displayName'>; read: PartyRead | null; failed: boolean; token: VaultToken | undefined }) {
  // the section says once that the amounts are in the testnet mock, so each card names the symbol alone
  const unit = token?.symbol ?? UNIT;
  const amount = (v: string | null) => (v === null ? 'not read' : inUnit(unit)(v));
  // usdc() prints the label as given; the symbol stands in for it here (the type lists only the two full labels)
  const mark = bondedMark(read, { label: unit } as Pick<VaultToken, 'label'>);
  // before the first read lands, the pill says it is reading rather than "not read"
  const pill = !read && !failed ? { tone: 'plain' as const, text: 'Reading' } : markPill(mark, read);
  const name = m.displayName;
  const late = read?.degraded?.includes('vault') ? lateWords('vault', read.asOf, Date.now(), read.stale) : null;
  return (
    <article className="seen" aria-label={name}>
      <Mark name={name} balance={read?.balance ?? null} state={MARK_STATE[mark.state]} token={token} />
      <div className="seen-head">
        <h3>{name}</h3>
        <Pill tone={pill.tone}>{pill.text}</Pill>
      </div>
      {!read && !failed && <Loading what="its deposit" />}
      {!read && failed && <p className="muted small">The status service did not return its deposit just now.</p>}
      {read && (
        <>
          <p className="seen-words">{mark.state === 'unknown' ? 'Its deposit could not be read from the vault just now.' : mark.words}</p>
          <dl>
            <Row label="Deposit held">{amount(read.balance)}</Row>
            <Row label="Required (set by the operator)">{amount(read.required)}</Row>
            {mark.state === 'top-up' && <Row label="Top-up by">{when(read.topUpDeadline)}</Row>}
            <Row label="Shops accept its orders">{read.inGoodStanding === null ? 'not read' : read.inGoodStanding ? 'yes' : 'no'}</Row>
          </dl>
          {late && <p className="muted small">Running late: {late}.</p>}
        </>
      )}
      <a className="read" href={`#/party/${m.address}`}>
        Open its worklist
      </a>
    </article>
  );
}

/** A company's card with its own read of GET /v1/parties/{address}; that read is slow, so it is polled every 30 s. */
function Seen({ m, token }: { m: CastMember; token: VaultToken | undefined }) {
  const { data, error } = usePoll<PartyRead>(READS.party(m.address), 30_000);
  return <SeenCard m={m} read={data} failed={!data && error !== null} token={data?.vaultToken ?? token} />;
}

export function SeenSection({ cast, castError, token, v }: { cast: CastBody | null; castError: ApiFailure | null; token: VaultToken | undefined; v: BondParams['params']['vault'] | undefined }) {
  const unit = token?.symbol ?? UNIT;
  const companies = cast?.members.filter((m) => m.role === 'platform') ?? [];
  return (
    <section className="card" id="bond-seen" aria-labelledby="bond-seen-h">
      <h2 id="bond-seen-h">What a shop sees</h2>
      <p className="bond-intro">
        Before it accepts an order, a shop asks the vault whether the agent's company is in good standing (inGoodStanding): a required deposit is set, no exit is pending, and the deposit meets it or its top-up window
        {v ? ` (${duration(v.topUpWindow)})` : ''} is still open. Shops accept orders only from companies in good standing. Here is each agent company in this demo's party map, as the vault reads it now; amounts
        are in {unit}, the vault's testnet mock token. Each card links to the company's worklist: its claims, and what waits on it.
      </p>
      {!cast && !castError && <Loading what="the agent companies" />}
      {!cast && castError && <p className="empty">The status service did not return the list of agent companies, so no mark is shown.</p>}
      {cast && companies.length === 0 && <p className="empty">The party map lists no agent company yet.</p>}
      {companies.length > 0 && (
        <div className="bond-seen">
          {companies.map((m) => (
            <Seen key={m.address} m={m} token={token} />
          ))}
        </div>
      )}
    </section>
  );
}

/** The three steps only the operator can take, stated where a new company meets them; a bold lead word each, as Join states its own. */
export function OperatorSteps() {
  return (
    <section className="card bond-ops" aria-labelledby="bond-ops-h">
      <h2 id="bond-ops-h">Steps only the operator can take</h2>
      <ul>
        <li>
          <b>Party map:</b> {OPERATOR_STEPS.partyMap}
        </li>
        <li>
          <b>Minting:</b> {OPERATOR_STEPS.mint}
        </li>
        <li>
          <b>Required deposits:</b> {OPERATOR_STEPS.required}
        </li>
      </ul>
    </section>
  );
}

// ---- register ----

/** The agent company types in the registry today, as the demo cast's own registrations name them. */
export const AGENT_KINDS = [
  { kind: 'personal-shopper', label: 'Personal shopping agent' },
  { kind: 'general-shopper', label: 'General shopping agent' },
  { kind: 'procurement-approval', label: 'Procurement agent with buyer approval' },
  { kind: 'data-api-buyer', label: 'Data agent buying API calls' },
] as const;

export interface RegisterInput {
  name: string;
  kind: string;
  summary: string;
}

/** The registration an agent company would sign: its inline URI and size, or why it is not ready yet. */
export function registerPlan(i: RegisterInput): { bytes: number | null; missing: string | null; problem: string | null; plan: ((from: Address) => LocalPlan) | null } {
  const name = i.name.trim();
  const summary = i.summary.trim();
  if (!name || !summary) return { bytes: null, missing: !name ? 'Name the agent company to continue.' : 'Say in one sentence what your agent buys to continue.', problem: null, plan: null };
  const type = AGENT_KINDS.find((k) => k.kind === i.kind) ?? AGENT_KINDS[0];
  const uri = dataUri(registrationDoc({ role: 'platform', name, kind: type.kind, label: type.label, summary }));
  const size = uriSize(uri);
  if (size.problem) return { bytes: size.bytes, missing: null, problem: size.problem, plan: null };
  return {
    bytes: size.bytes,
    missing: null,
    problem: null,
    plan: () => ({
      transactions: [buildRegister(uri)],
      summary: `Register ${name} as an agent company (${type.label.toLowerCase()}) in the ERC-8004 identity registry on Hedera testnet.`,
      changes: [`A new ERC-8004 identity owned by your account, with its registration stored inline in the registry (${size.bytes.toLocaleString('en-US')} bytes).`],
      notes: [OPERATOR_STEPS.partyMap],
    }),
  };
}

/** What the registry says once the register call mined. */
export function RegisteredView({ r, hash }: { r: Registered | null; hash: Hash | null }) {
  return (
    <div className="next bond-after" role="status">
      {r ? (
        <>
          <p>
            <strong>Registered: ERC-8004 id {r.agentId}.</strong> The registry gives its owner as <span className="mono">{r.owner}</span>, and its registration is inline in the registry.
          </p>
          {!r.matches && <p>The owner or registration the registry gives now differs from the one the transaction recorded; look it up on HashScan, Hedera's public block explorer.</p>}
        </>
      ) : (
        <p>
          Mined, but the new id could not be read back from the receipt just now.{' '}
          {hash && <ExtLink href={txLink(HEDERA_CHAIN_ID, hash)}>See the transaction on HashScan, Hedera's public block explorer</ExtLink>}
        </p>
      )}
      <p className="small">{OPERATOR_STEPS.partyMap}</p>
    </div>
  );
}

/** The read-back after register: the id from the receipt, then its owner and URI (identity.ts). Errors become words here. */
export async function afterRegister(hashes: Hash[], provider: EIP1193Provider): Promise<ReactNode> {
  const hash = hashes[0] ?? null;
  const r = hash ? await readRegistered(provider, hash).catch(() => null) : null;
  return <RegisteredView r={r} hash={hash} />;
}

function RegisterCard() {
  const [input, setInput] = useState<RegisterInput>({ name: '', kind: AGENT_KINDS[0].kind, summary: '' });
  const r = registerPlan(input);
  const set = (k: keyof RegisterInput) => (e: { target: { value: string } }) => setInput({ ...input, [k]: e.target.value });
  return (
    <div className="bond-act" id="bond-register">
      <LocalFlow
        title="Register your agent company"
        intro="An ERC-8004 identity is your company's entry in a public registry of agents on Hedera testnet. Anyone may register one; your wallet's account owns it, and its registration document is stored inline."
        plan={r.plan}
        after={afterRegister}
      >
        <label htmlFor="rg-name">Company name</label>
        <input id="rg-name" value={input.name} onChange={set('name')} maxLength={60} autoComplete="organization" aria-describedby="rg-name-h" />
        <p className="hint" id="rg-name-h">
          The name shops and buyers see. Use a made-up name on this testnet.
        </p>
        <label htmlFor="rg-kind">Type of agent</label>
        <select id="rg-kind" value={input.kind} onChange={set('kind')}>
          {AGENT_KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </select>
        <label htmlFor="rg-sum">What your agent buys</label>
        <textarea id="rg-sum" value={input.summary} onChange={set('summary')} maxLength={200} rows={2} aria-describedby="rg-sum-h" />
        <p className="hint" id="rg-sum-h">
          One sentence, up to 200 characters, as the Shops and agents page shows it.
        </p>
        {r.bytes !== null && !r.problem && (
          <p className="muted small">
            The registration is {r.bytes.toLocaleString('en-US')} bytes, stored inline in the registry (at most {MAX_URI_BYTES.toLocaleString('en-US')}).
          </p>
        )}
        {r.problem && (
          <p className="error" role="alert">
            {r.problem}
          </p>
        )}
        {r.missing && <p className="muted small">{r.missing}</p>}
      </LocalFlow>
    </div>
  );
}

// ---- your deposit ----

/** The vault's own reads of a company's deposit; checked against deployments/abi/DepositVault.json in the tests. */
export const VAULT_READS = parseAbi([
  'function depositOf(address platform) view returns (uint256)',
  'function requiredOf(address platform) view returns (uint256)',
  'function inGoodStanding(address platform) view returns (bool)',
  'function topUpDeadline(address platform) view returns (uint256)',
  'function exitRequestedAt(address platform) view returns (uint64)',
]);

const hederaClient = (provider: EIP1193Provider) => createPublicClient({ chain: CHAINS[HEDERA_CHAIN_ID], transport: custom(provider, { retryCount: 1 }) });

/** The account's balance of the vault token, read through the wallet's connection to Hedera testnet. */
export async function walletHolds(provider: EIP1193Provider, token: Address, account: Address): Promise<bigint> {
  return hederaClient(provider).readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
}

/**
 * A company's deposit as the vault holds it now, read through the wallet: the status service reads
 * only the addresses in its party map, so a new company's deposit is read here straight after it mined.
 */
export async function vaultNow(provider: EIP1193Provider, vault: Address, platform: Address): Promise<PartyDeposit> {
  const client = hederaClient(provider);
  const at = { address: vault, abi: VAULT_READS, args: [platform] } as const;
  const [balance, required, good, deadline, exit] = await Promise.all([
    client.readContract({ ...at, functionName: 'depositOf' }),
    client.readContract({ ...at, functionName: 'requiredOf' }),
    client.readContract({ ...at, functionName: 'inGoodStanding' }),
    client.readContract({ ...at, functionName: 'topUpDeadline' }),
    client.readContract({ ...at, functionName: 'exitRequestedAt' }),
  ]);
  return { balance: balance.toString(), required: required.toString(), inGoodStanding: good, topUpDeadline: deadline.toString(), exitRequestedAt: exit === 0n ? null : exit.toString() };
}

export interface DepositArgs {
  vault: Address;
  token: Address;
  amount: bigint;
  /** The company the deposit is for; null posts it for the signing account itself. */
  platform: Address | null;
  vaultToken?: VaultToken | undefined;
  names?: Record<string, string>;
}

/**
 * The approve and postDeposit pair for the signer. With a wallet, it first moves the wallet to
 * Hedera testnet and checks it holds the amount, so a deposit the vault could not take is never built.
 */
export function depositPlan(a: DepositArgs, provider: EIP1193Provider | null, onTarget?: (platform: Address) => void): (from: Address) => Promise<LocalPlan> {
  return async (from) => {
    const platform = a.platform ?? from;
    const amount = usdc(a.amount, labelled(a.vaultToken));
    if (provider) {
      await walletOps(provider).ensureChain(HEDERA_CHAIN_ID);
      // a failed read says so in a sentence, not as the RPC client's error dump
      const held = await walletHolds(provider, a.token, from).catch(() => {
        throw new Error("Your wallet's mUSDC balance could not be read on Hedera testnet just now; try again.");
      });
      if (held < a.amount) throw new Error(`Your wallet holds ${usdc(held, labelled(a.vaultToken))}, less than the ${amount} deposit, so the vault could not take it. ${OPERATOR_STEPS.mint}`);
    }
    onTarget?.(platform);
    const self = platform.toLowerCase() === from.toLowerCase();
    const who = self ? 'your account' : (a.names?.[platform.toLowerCase()] ?? short(platform));
    return {
      transactions: [buildApprove(a.token, a.vault, a.amount), buildPostDeposit(a.vault, platform, a.amount)],
      summary: `Post ${amount} from your wallet into the deposit vault, as the deposit of ${who}.`,
      amounts: [{ name: 'Deposit', amount: a.amount.toString(), decimals: 6, symbol: a.vaultToken?.symbol ?? UNIT, display: '', movement: 'deposit', account: platform }],
      changes: [
        `The vault holds ${amount} more for ${who}. It leaves the deposit only as payouts on claims or when the company exits.`,
        ...(self ? [] : [`The deposit is ${who}'s from then on: only that company can take it out, by exiting.`]),
      ],
      notes: [OPERATOR_STEPS.required],
    };
  };
}

/** The agent company the deposit is typed for: its address, or why it cannot take one. Empty posts for the signer itself. */
export function platformOf(text: string): { platform: Address | null; problem: string | null } {
  const typed = text.trim();
  if (!typed) return { platform: null, problem: null };
  if (!isAddress(typed, { strict: false })) return { platform: null, problem: 'That is not an address. Leave it empty to post for your own account.' };
  const platform = getAddress(typed);
  // the vault refuses a deposit for the zero address, but only once approve has mined and its gas is spent
  if (platform === zeroAddress) return { platform: null, problem: "That is the zero address; type the agent company's account, or leave it empty for your own." };
  return { platform, problem: null };
}

/** What the vault says once the deposit mined, read straight from the chain. */
export function DepositedView({ read, who, token }: { read: PartyDeposit | null; who: string; token: VaultToken | undefined }) {
  return (
    <div className="next bond-after" role="status">
      {read ? (
        <p>
          <strong>Posted.</strong> As the vault reads it now, for {who}: {bondedMark(read, labelled(token)).words}
        </p>
      ) : (
        <p>Mined. The vault could not be read back just now; the deposit shows here once the status service reads it.</p>
      )}
      <p className="small">{OPERATOR_STEPS.required}</p>
    </div>
  );
}

/** The wallet's own vault-token balance while it is on Hedera testnet, read again every 20 s; null until read. */
function useWalletHolds(token: Address | null, account: Address | null, chainId: number | null): bigint | null {
  const [held, setHeld] = useState<{ key: string; v: bigint } | null>(null);
  const key = `${token}:${account}:${chainId}`;
  useEffect(() => {
    const provider = injectedProvider();
    if (!provider || !token || !account || chainId !== HEDERA_CHAIN_ID) return;
    let mounted = true;
    const run = () =>
      walletHolds(provider, token, account).then(
        (v) => {
          if (mounted) setHeld({ key, v });
        },
        () => undefined,
      );
    void run();
    const t = setInterval(run, 20_000);
    return () => {
      mounted = false;
      clearInterval(t);
    };
  }, [key, token, account, chainId]);
  return held && held.key === key ? held.v : null;
}

function DepositCard({ p, token, suggested, names }: { p: BondParams | null; token: VaultToken | undefined; suggested: bigint | null; names: Record<string, string> }) {
  const wallet = useWallet();
  const [amountText, setAmount] = useState('');
  const [platformText, setPlatform] = useState('');
  const target = useRef<Address | null>(null);
  const own = inUnit(token?.symbol ?? UNIT);
  const vault = p?.addresses.vault && isAddress(p.addresses.vault) ? getAddress(p.addresses.vault) : null;
  const tokenAddr = p?.addresses.usdc && isAddress(p.addresses.usdc) ? getAddress(p.addresses.usdc) : null;
  const floor = p?.params.vault ? BigInt(p.params.vault.minDeposit) : null;
  const amount = parseUsdc(amountText);
  const typed = platformText.trim();
  const { platform, problem: platformProblem } = platformOf(platformText);
  const held = useWalletHolds(tokenAddr, wallet.account, wallet.chainId);
  const shown = platform ?? wallet.account;
  const standing = usePoll<PartyRead>(shown ? READS.party(shown) : null, 30_000);

  const amountProblem = amountText.trim() && (amount === null || amount <= 0n) ? 'Enter an amount above 0, like 5.00.' : null;
  const ready = vault !== null && tokenAddr !== null && amount !== null && amount > 0n && (!typed || platform !== null);
  const plan = ready
    ? depositPlan({ vault, token: tokenAddr, amount, platform, vaultToken: token, names }, injectedProvider(), (t) => {
        target.current = t;
      })
    : null;
  const after = async (_hashes: Hash[], provider: EIP1193Provider) => {
    const t = target.current;
    if (!vault || !t) return <DepositedView read={null} who="the company" token={token} />;
    const read = await vaultNow(provider, vault, t).catch(() => null);
    const who = wallet.account && t.toLowerCase() === wallet.account.toLowerCase() ? 'your account' : (names[t.toLowerCase()] ?? short(t));
    return <DepositedView read={read} who={who} token={token} />;
  };

  return (
    <div className="bond-act" id="bond-deposit">
      <LocalFlow
        title="Your deposit"
        intro="Two transactions from your wallet: approve lets the vault take this amount of mUSDC once, then postDeposit moves it into the deposit. Anyone may post a deposit for any agent company."
        plan={plan}
        problems={depositProblems}
        after={after}
        names={names}
      >
        <div className="bond-held">
          <p className="small">
            {!wallet.account
              ? 'Connect a wallet that holds some mUSDC to post a deposit.'
              : held !== null
                ? `Your wallet holds ${usdc(held, labelled(token))}.`
                : wallet.chainId === HEDERA_CHAIN_ID
                  ? "Reading your wallet's mUSDC…"
                  : "Your wallet's mUSDC is read once it is on Hedera testnet; the next step asks it to switch."}
          </p>
          <p className="small">{OPERATOR_STEPS.mint}</p>
        </div>
        <label htmlFor="dp-amount">Amount ({token?.symbol ?? UNIT})</label>
        <input
          id="dp-amount"
          inputMode="decimal"
          value={amountText}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={floor !== null ? figure(floor) : '5.00'}
          aria-invalid={amountProblem ? true : undefined}
          aria-describedby={`dp-amount-h${amountProblem ? ' dp-amount-e' : ''}`}
          autoComplete="off"
        />
        <p className="hint" id="dp-amount-h">
          {floor !== null && (
            <>
              <button type="button" className="linkish" onClick={() => setAmount(figure(floor))}>
                Use the floor, {own(floor)}
              </button>
              {suggested !== null && suggested !== floor && (
                <>
                  {' · '}
                  <button type="button" className="linkish" onClick={() => setAmount(figure(suggested))}>
                    Use your estimate, {own(suggested)}
                  </button>
                </>
              )}
              . {amount !== null && amount > 0n && amount < floor ? 'This is under the floor: enough for a top-up, but a first deposit this small cannot meet any required amount.' : ''}
            </>
          )}
          {floor === null && 'The floor is not read yet.'}
        </p>
        {amountProblem && (
          <p className="error" id="dp-amount-e">
            {amountProblem}
          </p>
        )}
        <label htmlFor="dp-platform">Agent company address (optional)</label>
        <input
          id="dp-platform"
          value={platformText}
          onChange={(e) => setPlatform(e.target.value)}
          placeholder="Empty: your wallet's own account"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={platformProblem ? true : undefined}
          aria-describedby={`dp-platform-h${platformProblem ? ' dp-platform-e' : ''}`}
        />
        <p className="hint" id="dp-platform-h">
          The deposit belongs to this company. Leave it empty to post for your own account.
        </p>
        {platformProblem && (
          <p className="error" id="dp-platform-e">
            {platformProblem}
          </p>
        )}
        {!vault && <p className="muted small">The vault address is not read yet.</p>}
        {shown && (
          <div className="bond-now">
            <h3>Now, as the status service reads it</h3>
            <p className="small">
              {standing.data ? bondedMark(standing.data, labelled(token)).words : standing.error ? 'The status service did not answer just now.' : 'Reading…'}
            </p>
          </div>
        )}
      </LocalFlow>
    </div>
  );
}

// ---- the page ----

export function BondView({ p, pError, cast, castError }: { p: BondParams | null; pError: ApiFailure | null; cast: CastBody | null; castError: ApiFailure | null }) {
  const [numbers, setNumbers] = useState<NumbersInput>(EXAMPLE_NUMBERS);
  const token = p?.vaultToken ?? cast?.vaultToken;
  const { est } = estimate(numbers, p?.params);
  const names = Object.fromEntries((cast?.members ?? []).map((m) => [m.address.toLowerCase(), m.displayName]));
  return (
    <div className="bond-page">
      <div className="page-head">
        <p className="eyebrow">For agent companies</p>
        <h1>I run a shopping agent</h1>
        <p className="lead">
          An agent company is the business that runs a shopping agent. It registers an ERC-8004 identity on Hedera testnet (ERC-8004 is a standard public registry of identities for agents and the businesses
          behind them) and posts a deposit, its bond, in the vault: the contract that holds the deposits and pays claims from them. When an order's records show the agent got it wrong, the shop is paid from that
          deposit.
        </p>
      </div>
      <Banner fresh={p ?? undefined} error={pError} token={token} />
      <NumbersCard input={numbers} onChange={setNumbers} p={p} token={token} failed={!p && pError !== null} />
      <TermsCard p={p} token={token} />
      <SeenSection cast={cast} castError={castError} token={token} v={p?.params.vault} />
      <OperatorSteps />
      <div className="bond-acts">
        <RegisterCard />
        <DepositCard p={p} token={token} suggested={est?.suggested ?? null} names={names} />
      </div>
    </div>
  );
}

/** An agent company registers an ERC-8004 identity and posts its deposit in the vault. */
export function BondPage() {
  const params = usePoll<BondParams>(READS.params(), 30_000);
  const cast = usePoll<CastBody>(CAST_READ, 30_000);
  return <BondView p={params.data} pError={params.error} cast={cast.data} castError={cast.error} />;
}
