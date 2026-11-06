import { useState } from 'react';
import type { PrecheckResult, VaultToken } from '@recourse/shared';
import { Banner, Card, Loading, Pill, Row } from '../components.js';
import { ApiFailure, getApi, usePoll, type Fresh } from '../lib/api.js';
import { parseUsdc, usdc } from '../lib/format.js';
import { precheckFromRecords, type ServedRecord, type PrecheckOutcome } from '../lib/precheck.js';
import { KIND_WORDS, REASON_WORDS, SIDE_WORDS } from '../lib/words.js';
import type { Hex } from 'viem';

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

export function Finding({ result }: { result: PrecheckResult }) {
  const tone = result.answer === 0 ? 'wait' : result.answer === 3 ? 'ok' : 'bad';
  return (
    <div>
      <p>
        <Pill tone={tone}>{result.answer === 0 ? 'No finding' : `At fault: ${SIDE_WORDS[result.side]}`}</Pill>
      </p>
      <p>{REASON_WORDS[result.reasonKey]}</p>
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

export function FilePage() {
  const [orderId, setOrderId] = useState('');
  const [basket, setBasket] = useState('');
  const [netLoss, setNetLoss] = useState('');
  const [platform, setPlatform] = useState('');
  const [state, setState] = useState<{ loading: boolean; error: string | null; data: OrderRecords | null }>({ loading: false, error: null, data: null });
  const params = usePoll<ParamsBody>('/params', 30000);
  const standing = usePoll<PartyBody>(/^0x[0-9a-fA-F]{40}$/.test(platform) ? `/parties/${platform}` : null, 15000);

  const idOk = /^0x[0-9a-fA-F]{64}$/.test(orderId.trim());
  const b = parseUsdc(basket);
  const n = parseUsdc(netLoss);
  const lossProblem = b !== null && n !== null && n > b ? 'The net loss cannot be more than the basket.' : basket && b === null ? 'Basket must be an amount like 60.00.' : netLoss && n === null ? 'Net loss must be an amount like 50.00.' : null;

  async function load() {
    setState({ loading: true, error: null, data: null });
    try {
      const data = await getApi<OrderRecords>(`/orders/${orderId.trim().toLowerCase()}/records`);
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
    <>
      <h1>Check an order before filing</h1>
      <p className="lead">
        Load the records of an order and see what the pre-check would say. This page only checks. It does not sign, send or file anything; a shop files through its own service.
      </p>
      <Banner fresh={params.data ?? undefined} error={params.error} token={token} />
      <Card title="1. The order">
        <label htmlFor="oid">Order id</label>
        <input id="oid" value={orderId} onChange={(e) => setOrderId(e.target.value)} placeholder="0x…" spellCheck={false} />
        <button type="button" disabled={!idOk || state.loading} onClick={load}>
          Load records
        </button>
        {state.loading && <Loading what="records" />}
        {state.error && <p className="error">{state.error}</p>}
        {state.data?.claimId && (
          <p>
            This order already has a claim: <a href={`#/claim/${state.data.claimId}`}>open it</a>.
          </p>
        )}
      </Card>
      {state.data && outcome && (
        <Card title="2. What the records say">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Record</th>
                  <th>Used by the check</th>
                </tr>
              </thead>
              <tbody>
                {state.data.records.map((r) => {
                  const skip = outcome.skipped.find((s) => s.kind === r.kind);
                  return (
                    <tr key={r.kind}>
                      <td>{KIND_WORDS[r.kind]}</td>
                      <td>{skip ? <span className="muted">No: {skip.why}</span> : <Pill tone="ok">Yes</Pill>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Finding result={outcome.result} />
          <p className="muted small">The same rule runs on the pre-check service. If a record is not yet held, the real pre-check may differ.</p>
        </Card>
      )}
      <Card title="3. The amounts">
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
    </>
  );
}
