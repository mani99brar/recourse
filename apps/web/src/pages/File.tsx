import { useState } from 'react';
import {
  ATTRIBUTES,
  RECORD_KEYS,
  canonicalBytes,
  ruleSlotFromDoc,
  withSlot,
  type AttrRecordKey,
  type Attribute,
  type PrecheckResult,
  type RecordKind,
  type RuleInput,
  type VaultToken,
} from '@recourse/shared';
import { FileClaimAction } from '../actions/forms.js';
import { Banner, Card, Loading, Row } from '../components.js';
import { ApiFailure, READS, getRead, usePoll, type Fresh } from '../lib/api.js';
import { parseUsdc, usdc } from '../lib/format.js';
import { precheckFromRecords, type ServedRecord, type PrecheckOutcome } from '../lib/precheck.js';
import { KIND_WORDS, REASON_WORDS, SIDE_WORDS } from '../lib/words.js';
import type { Hex } from 'viem';
import '../styles/file.css';

interface OrderRecords {
  orderId: Hex;
  claimId: string | null;
  records: ServedRecord[];
}
interface ParamsBody extends Fresh {
  /** `defaulted`: the chain has not been read yet, so these are the built-in defaults. */
  params: { claims: { courtFeeUsdc: string; contestWindow: string; handlingBase: string; handlingBps: string; handlingCap: string }; defaulted?: boolean };
  vaultToken?: VaultToken;
}
export interface PartyBody {
  role: string;
  displayName: string | null;
  balance: string | null;
  required: string | null;
  inGoodStanding: boolean | null;
}

/** The side a finding points to, as the band names it: the agent company, the shop, neither, or no finding. */
export function findingSide(result: PrecheckResult): 'agent' | 'shop' | 'neither' | 'none' {
  return result.answer === 1 ? 'agent' : result.answer === 2 ? 'shop' : result.answer === 3 ? 'neither' : 'none';
}

/**
 * The finding as a band across the records: the side it points to fills red and says so in large
 * words, the middle states it in plain words. No finding and neither side stay on the sheet.
 */
export function Finding({ result }: { result: PrecheckResult }) {
  const who = findingSide(result);
  return (
    <div className="finding">
      <div className="band" data-who={who}>
        <div className="band-side band-shop" aria-hidden="true">
          <i />
          <b>Points to the shop</b>
        </div>
        <div className="band-mid">
          <p className="band-title">{result.answer === 0 ? 'No finding' : `At fault: ${SIDE_WORDS[result.side]}`}</p>
          <p>{REASON_WORDS[result.reasonKey]}</p>
        </div>
        <div className="band-side band-agent" aria-hidden="true">
          <i />
          <b>Points to the agent company</b>
        </div>
      </div>
      <div className="finding-notes">
        {result.gap === 255 && result.answer === 0 && <p className="muted">Gap 255 with no answer means not enough record.</p>}
        {result.gap === 255 && result.answer !== 0 && <p className="muted">A record is missing and counts against {SIDE_WORDS[result.side]}.</p>}
        {result.flaggedCells.length > 0 && (
          <p>
            Cells behind the finding:{' '}
            {result.flaggedCells.map((c) => `${c.attribute} in ${c.record}`).join(', ')}.
          </p>
        )}
        {result.notCompared.length > 0 && <p>Not compared (no second record to compare with): {result.notCompared.join(', ')}.</p>}
        {result.unreadPrice.length > 0 && <p>A price could not be read as a number in: {result.unreadPrice.join(', ')}. It was compared as text.</p>}
      </div>
    </div>
  );
}

/** Defaults stand in when the chain has never been read: say so rather than show them as live. */
export function chainNote(defaulted: boolean | undefined): string {
  return defaulted === true ? ' (default, not read from the chain yet)' : '';
}

/** The agent company's deposit in words. A standing that could not be read says so; it is never "not in good standing". */
export function standingWords(s: PartyBody, token?: VaultToken): string {
  if (s.inGoodStanding === null) return 'not read right now; its standing is not known';
  return `${s.inGoodStanding ? 'in good standing' : 'not in good standing'}; holds ${usdc(s.balance, token)} of ${usdc(s.required, token)} required`;
}

const ATTR_WORDS: Record<Attribute, string> = { brand: 'Brand', size: 'Size', colour: 'Colour', quantity: 'Quantity', price: 'Price', merchant: 'Shop' };
/** The five records that hold attributes, by kind, in the order the rule reads them. */
const COLUMNS: { kind: RecordKind; key: AttrRecordKey }[] = [
  { kind: 0, key: 'asked' },
  { kind: 1, key: 'shown' },
  { kind: 3, key: 'ordered' },
  { kind: 4, key: 'packed' },
  { kind: 5, key: 'arrived' },
];

/** The records the check used, read the way the rule reads them: only those it used, so the table shows what it compared. */
export function readUsed(orderId: Hex, records: readonly ServedRecord[], used: readonly number[]): RuleInput {
  let input: RuleInput = {};
  for (const r of records) {
    if (!used.includes(r.kind) || r.doc === null || r.doc === undefined) continue;
    const slot = ruleSlotFromDoc(r.kind as RecordKind, canonicalBytes(r.doc as never), orderId);
    if (slot.ok) input = withSlot(input, slot);
  }
  return input;
}

/** The approval record in words. An approval under the agent's spending mandate is not the buyer's own. */
export function approvalWords(input: RuleInput): string | null {
  const a = input.approval;
  if (!a) return null;
  if (a.approval === 'not_approved') return 'Not approved';
  return a.approvalBasis === 'mandate' ? "Approved under the agent's spending mandate" : a.approvalBasis === 'buyer' ? 'Approved by the buyer' : 'Approved';
}

/** What each record holds, side by side, with the cells behind the finding filled red. */
export function RecordTable({ orderId, records, outcome }: { orderId: Hex; records: readonly ServedRecord[]; outcome: PrecheckOutcome }) {
  const input = readUsed(orderId, records, outcome.used);
  const flagged = (key: AttrRecordKey, a: Attribute) => outcome.result.flaggedCells.some((c) => c.record === key && c.attribute === a);
  const why = (kind: number) => {
    if (!records.some((r) => r.kind === kind)) return 'not served';
    const s = outcome.skipped.find((x) => x.kind === kind);
    return s ? s.why : null;
  };
  const approval = approvalWords(input);
  const approvalWhy = why(2);
  const shown = input.shown;
  return (
    <div className="table-wrap">
      <table className="mx">
        <thead>
          <tr>
            <td />
            {COLUMNS.map((c) => {
              const w = why(c.kind);
              return (
                <th key={c.key} scope="col">
                  {KIND_WORDS[c.kind]}
                  <small className={w ? 'mx-why' : 'mx-why mx-used'}>{w ? `Not used: ${w}` : 'Used by the check'}</small>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {ATTRIBUTES.map((a) => (
            <tr key={a}>
              <th scope="row">{ATTR_WORDS[a]}</th>
              {COLUMNS.map((c) => {
                const v = input[c.key]?.attrs[a];
                const bad = flagged(c.key, a);
                return (
                  <td key={c.key} className={bad ? 'bad' : undefined}>
                    {v ?? (bad ? <span className="mx-nil">none</span> : '')}
                  </td>
                );
              })}
            </tr>
          ))}
          <tr>
            <th scope="row">Changes shown</th>
            <td />
            <td colSpan={COLUMNS.length - 1}>
              {shown ? (shown.changes.length ? shown.changes.map((a) => ATTR_WORDS[a]).join(', ') : 'The screen named no change.') : <span className="mx-nil">No Shown record was used.</span>}
            </td>
          </tr>
          <tr>
            <th scope="row">{KIND_WORDS[2]}</th>
            <td />
            <td colSpan={COLUMNS.length - 1}>{approval ?? <span className="mx-nil">Not used: {approvalWhy ?? 'not held'}</span>}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** How the check reads the records, in the shared rule's own order. */
function RuleNote() {
  return (
    <section className="file-rule" aria-labelledby="file-rule-h">
      <h2 id="file-rule-h" className="h3">
        How the check reads the records
      </h2>
      <ul className="rlines">
        <li>
          <b>In order:</b> the records are compared step by step, and the first break decides. With no Ordered record there is no finding, since every other record is compared with it.
        </li>
        <li>
          <b>Points to the agent company:</b> the order or the screen departed from what the buyer asked for, and the change was not shown and approved (gap 1), or the order differs from what the screen showed (gap 2).
        </li>
        <li>
          <b>Points to the shop:</b> what it packed differs from the order, or what arrived differs from what it packed, or from the order when there is no packing record (gap 3).
        </li>
        <li>
          <b>Missing records:</b> a missing Asked, Shown or approval counts against the agent company, a missing packing record against the shop. With records missing on both sides, there is no finding.
        </li>
        <li>
          <b>Points to neither:</b> the records agree, or the screen showed the change and it was approved. A value with nothing to compare it with is named.
        </li>
        <li>
          <b>Who writes what:</b> the shop writes Packed. The agent company writes Asked, Shown, the approval, Ordered and Arrived.
        </li>
      </ul>
    </section>
  );
}

export function FilePage() {
  const [orderId, setOrderId] = useState('');
  const [basket, setBasket] = useState('');
  const [netLoss, setNetLoss] = useState('');
  const [platform, setPlatform] = useState('');
  const [state, setState] = useState<{ loading: boolean; error: string | null; data: OrderRecords | null }>({ loading: false, error: null, data: null });
  const params = usePoll<ParamsBody>(READS.params(), 30000);
  const standing = usePoll<PartyBody>(/^0x[0-9a-fA-F]{40}$/.test(platform) ? READS.party(platform) : null, 15000);

  const idOk = /^0x[0-9a-fA-F]{64}$/.test(orderId.trim());
  const b = parseUsdc(basket);
  const n = parseUsdc(netLoss);
  const lossProblem = b !== null && n !== null && n > b ? 'The net loss cannot be more than the basket.' : basket && b === null ? 'Basket must be an amount like 60.00.' : netLoss && n === null ? 'Net loss must be an amount like 50.00.' : null;

  async function load() {
    setState({ loading: true, error: null, data: null });
    try {
      const data = await getRead<OrderRecords>(READS.orderRecords(orderId.trim().toLowerCase()));
      setState({ loading: false, error: null, data });
    } catch (e) {
      setState({ loading: false, error: e instanceof ApiFailure ? (e.status === 400 ? 'That is not an order id.' : 'The records could not be loaded.') : 'The records could not be loaded.', data: null });
    }
  }

  const outcome = state.data ? precheckFromRecords(state.data.orderId, state.data.records) : null;
  const p = params.data?.params.claims;
  const fromChain = chainNote(params.data?.params.defaulted);
  const token = params.data?.vaultToken;
  return (
    <div className="file-page">
      <div className="page-head">
        <p className="eyebrow">Check or file an order</p>
        <h1>Check an order before filing</h1>
        <p className="lead">
          Load the records of an order and see what the pre-check would say. The shop that took the order can then file the claim here: the page shows what filing will do, and the shop's own wallet signs. Checking needs no wallet.
        </p>
      </div>
      <Banner fresh={params.data ?? undefined} error={params.error} token={token} />
      <div className="file-path">
        <Card title="1. The order" id="file-order">
          <label htmlFor="oid">Order id</label>
          <div className="with">
            <input id="oid" value={orderId} onChange={(e) => setOrderId(e.target.value)} placeholder="0x…" spellCheck={false} />
            <button type="button" disabled={!idOk || state.loading} onClick={load}>
              Load records
            </button>
          </div>
          {state.loading && <Loading what="records" />}
          {state.error && (
            <p className="error" role="alert">
              {state.error}
            </p>
          )}
          {state.data?.claimId && (
            <p className="next">
              This order already has a claim: <a href={`#/claim/${state.data.claimId}`}>open it</a>.
            </p>
          )}
        </Card>
        {state.data && outcome ? (
          <Card title="2. What the records say" id="file-records">
            <RecordTable orderId={state.data.orderId} records={state.data.records} outcome={outcome} />
            <Finding result={outcome.result} />
            <p className="muted small">The same rule runs on the pre-check service. If a record is not yet held, the real pre-check may differ.</p>
          </Card>
        ) : (
          <div className="file-wait">
            <p>Load an order to see its records side by side, and what the check would say.</p>
          </div>
        )}
        <Card title="3. The amounts" id="file-amounts">
          <div className="fields">
            <div>
              <label htmlFor="bk">Basket ({token?.symbol ?? 'USDC'})</label>
              <input id="bk" inputMode="decimal" value={basket} onChange={(e) => setBasket(e.target.value)} placeholder="60.00" />
            </div>
            <div>
              <label htmlFor="nl">Net loss ({token?.symbol ?? 'USDC'})</label>
              <input id="nl" inputMode="decimal" value={netLoss} onChange={(e) => setNetLoss(e.target.value)} placeholder="50.00" />
            </div>
            <div>
              <label htmlFor="pf">Agent company address (optional)</label>
              <input id="pf" value={platform} onChange={(e) => setPlatform(e.target.value)} placeholder="0x…" spellCheck={false} />
            </div>
          </div>
          {lossProblem && <p className="error">{lossProblem}</p>}
          <dl>
            <Row label="Court fee you escrow">{p ? `${usdc(p.courtFeeUsdc, token)}${fromChain}` : 'loading'}</Row>
            <Row label="Contest window">{p ? `${Number(p.contestWindow) / 60} minutes after the pre-check${fromChain}` : 'loading'}</Row>
            {standing.data && <Row label="Agent company deposit">{standingWords(standing.data, token)}</Row>}
            {standing.data && standing.data.role === 'unknown' && <Row label="Note">This address is not on Recourse. A claim against it can still be filed, but any payout may be short (nothing is held for it).</Row>}
          </dl>
          <p className="muted small">The court fee comes back to you if the claim closes uncontested, expires, or is not drawn.</p>
        </Card>
        <RuleNote />
        {state.data && !state.data.claimId && (
          <div className="file-act">
            <FileClaimAction
              key={state.data.orderId}
              orderId={state.data.orderId}
              packedHeld={state.data.records.find((r) => r.kind === 4)?.held === true}
              platform={platform.trim()}
              netLoss={netLoss}
              token={token}
            />
          </div>
        )}
      </div>
    </div>
  );
}
