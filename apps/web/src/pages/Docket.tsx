import { useEffect, useState } from 'react';
import '../styles/docket.css';
import type { RateResult } from '@recourse/docket';
import { Banner, Card, Loading, Pill } from '../components.js';
import { READS, usePoll, type Fresh } from '../lib/api.js';
import { readDocket } from '../lib/arkiv.js';
import { short } from '../lib/format.js';
import type { Address } from 'viem';

interface ParamsBody extends Fresh {
  schemeWallet: string | null;
  /** `store`: where the docket service writes ('arkiv', or 'local' on its own host); null when unknown. */
  docket: { rateConfig: { publishThreshold?: number } | null; store?: string | null } | null;
}
interface Party {
  evmAddress: string;
}

const KIND_WORDS: Record<string, string> = {
  platform_fault: 'Share of ruled cases decided against the agent company',
  fulfilment_fault: 'Share of ruled cases decided against the shop (fulfilment)',
  claim_accuracy: 'Share of shop claims upheld',
};

const GROUPS: [RateResult['role'], string][] = [
  ['shop', 'Shops'],
  ['platform', 'Agent companies'],
];

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

/** A measured rate: a flat bar for its 95% interval and a tick at the rate. A picture, never a control. */
function RateMark({ r }: { r: RateResult }) {
  if (r.rate === null || r.low === null || r.high === null) return null;
  return (
    <span className="rm" role="img" aria-label={`${pct(r.rate)}, 95% interval ${pct(r.low)} to ${pct(r.high)}, from ${r.units} ruled case${r.units === 1 ? '' : 's'}`}>
      <i style={{ left: `${r.low * 100}%`, width: `${(r.high - r.low) * 100}%` }} />
      <i className="at" style={{ left: `${r.rate * 100}%` }} />
    </span>
  );
}

/** `countsRead` false: the monthly counts could not be read, so the uncontested figures are unknown, not 0. */
export function RateTable({ rates, countsRead = true }: { rates: RateResult[]; countsRead?: boolean }) {
  if (rates.length === 0) return <p className="empty">No ruled cases yet.</p>;
  return (
    <div className="table-wrap">
      <table className="dk">
        <thead>
          <tr>
            <th scope="col">Party</th>
            <th scope="col">What is measured</th>
            <th scope="col">Rate</th>
            <th scope="col">Ruled cases</th>
            <th scope="col">Closed without a fight</th>
          </tr>
        </thead>
        {GROUPS.map(([role, title]) => {
          const rows = rates.filter((r) => r.role === role);
          if (rows.length === 0) return null;
          return (
            <tbody key={role}>
              <tr className="grp">
                <th colSpan={5} scope="rowgroup">
                  {title}
                </th>
              </tr>
              {rows.map((r) => (
                <tr key={`${r.kind}-${r.party}`}>
                  <td className="mono">
                    <a href={`#/party/${r.party}`}>{short(r.party)}</a>
                  </td>
                  <td>{KIND_WORDS[r.kind] ?? r.kind}</td>
                  <td>
                    {r.published && r.rate !== null ? (
                      <>
                        <span className="fig">{pct(r.rate)}</span> <span className="muted small">({pct(r.low ?? 0)} to {pct(r.high ?? 0)})</span>
                        <RateMark r={r} />
                      </>
                    ) : (
                      <Pill tone="plain">not published yet</Pill>
                    )}
                    {r.sample && <Pill tone="wait">sample</Pill>}
                  </td>
                  <td>{r.units}</td>
                  <td>
                    {countsRead ? r.closedUncontested : 'not read'} <span className="muted small">counted beside, not inside, the rate</span>
                    {r.unresolved > 0 && <span className="muted small"> · {r.unresolved} unresolved</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

/** The docket service keeps its entries on its own host: nothing below has reached Arkiv. */
export function LocalStoreNote() {
  return (
    <div className="banner" role="status">
      <p>The docket service is keeping its entries in a store on its own host for now, not on Arkiv. Nothing has been published to Arkiv yet, so the rates below, read from Arkiv, are empty even where cases have been ruled.</p>
    </div>
  );
}

export function DocketPage() {
  const params = usePoll<ParamsBody>(READS.params(), 60000);
  const writer = params.data?.schemeWallet ?? null;
  const threshold = params.data?.docket?.rateConfig?.publishThreshold ?? 20;
  const store = params.data?.docket?.store ?? null;
  const [state, setState] = useState<{ rates: RateResult[] | null; rows: number; countsRead: boolean; error: string | null }>({ rates: null, rows: 0, countsRead: true, error: null });
  useEffect(() => {
    if (!writer) return;
    let live = true;
    readDocket(writer as Address, import.meta.env?.VITE_ARKIV_PUBLIC_RPC_URL as string | undefined, threshold)
      .then((d) => live && setState({ rates: d.rates, rows: d.rows.length, countsRead: d.countsRead, error: null }))
      .catch(() => live && setState({ rates: null, rows: 0, countsRead: true, error: 'The public docket could not be read from Arkiv right now. The public endpoint is rate limited; try again in a minute.' }));
    return () => {
      live = false;
    };
  }, [writer, threshold]);
  return (
    <div className="docket-page">
      <div className="page-head">
        <h1>Public docket</h1>
        <p className="lead">
          Fault rates from cases the court has ruled on. Each rate carries its range, and nothing is ranked. Cases that closed without a contest are counted next to the rates, not in them.
        </p>
      </div>
      <Banner fresh={params.data ?? undefined} error={params.error} />
      <div className="method">
        <Card title="Method">
          <p>
            A rate is the weighted share of ruled cases that went a given way. The range is the Wilson 95% interval, taken at the effective sample size of the weights. A rate is shown only after {threshold} ruled cases for that party; before that it reads "not published yet". Cases with no usable outcome are counted as unresolved.
          </p>
          <p className="muted small">Read live from Arkiv in your browser, from entities written by {writer ? <span className="mono">{short(writer)}</span> : 'the docket writer'}.</p>
        </Card>
      </div>
      {store === 'local' && <LocalStoreNote />}
      <Card title="Rates">
        {!writer && !params.error && <Loading what="writer address" />}
        {!writer && params.error && <p className="empty">The docket writer's address could not be read from the status service, so the rates cannot be read from Arkiv. The page asks again every minute.</p>}
        {state.error && <p className="error">{state.error}</p>}
        {writer && !state.rates && !state.error && <Loading what="docket from Arkiv" />}
        {state.rates && <RateTable rates={state.rates} countsRead={state.countsRead} />}
        {state.rates && <p className="count">Read {state.rows} ruled case{state.rows === 1 ? '' : 's'} from Arkiv just now.</p>}
      </Card>
    </div>
  );
}
