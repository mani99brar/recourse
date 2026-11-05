import { useEffect, useState } from 'react';
import type { RateResult } from '@recourse/docket';
import { Banner, Card, Loading, Pill } from '../components.js';
import { usePoll, type Fresh } from '../lib/api.js';
import { readDocket } from '../lib/arkiv.js';
import { short } from '../lib/format.js';
import type { Address } from 'viem';

interface ParamsBody extends Fresh {
  schemeWallet: string | null;
  docket: { rateConfig: { publishThreshold?: number } | null } | null;
}
interface Party {
  evmAddress: string;
}

const KIND_WORDS: Record<string, string> = {
  platform_fault: 'Share of ruled cases decided against the agent company',
  fulfilment_fault: 'Share of ruled cases decided against the shop (fulfilment)',
  claim_accuracy: 'Share of shop claims upheld',
};

export function RateTable({ rates }: { rates: RateResult[] }) {
  if (rates.length === 0) return <p className="muted">No ruled cases yet.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Party</th>
            <th>What is measured</th>
            <th>Rate</th>
            <th>Ruled cases</th>
            <th>Closed without a fight</th>
          </tr>
        </thead>
        <tbody>
          {rates.map((r) => (
            <tr key={`${r.kind}-${r.party}`}>
              <td className="mono">{short(r.party)}</td>
              <td>{KIND_WORDS[r.kind] ?? r.kind}</td>
              <td>
                {r.published && r.rate !== null ? (
                  <>
                    {(r.rate * 100).toFixed(0)}% <span className="muted small">({((r.low ?? 0) * 100).toFixed(0)}% to {((r.high ?? 0) * 100).toFixed(0)}%)</span>
                  </>
                ) : (
                  <Pill tone="plain">not published yet</Pill>
                )}
                {r.sample && <Pill tone="wait">sample</Pill>}
              </td>
              <td>{r.units}</td>
              <td>
                {r.closedUncontested} <span className="muted small">counted beside, not inside, the rate</span>
                {r.unresolved > 0 && <span className="muted small"> · {r.unresolved} unresolved</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DocketPage() {
  const params = usePoll<ParamsBody>('/params', 60000);
  const writer = params.data?.schemeWallet ?? null;
  const threshold = params.data?.docket?.rateConfig?.publishThreshold ?? 20;
  const [state, setState] = useState<{ rates: RateResult[] | null; rows: number; error: string | null }>({ rates: null, rows: 0, error: null });
  useEffect(() => {
    if (!writer) return;
    let live = true;
    readDocket(writer as Address, import.meta.env?.VITE_ARKIV_PUBLIC_RPC_URL as string | undefined, threshold)
      .then((d) => live && setState({ rates: d.rates, rows: d.rows.length, error: null }))
      .catch(() => live && setState({ rates: null, rows: 0, error: 'The public docket could not be read from Arkiv right now. The public endpoint is rate limited; try again in a minute.' }));
    return () => {
      live = false;
    };
  }, [writer, threshold]);
  return (
    <>
      <h1>Public docket</h1>
      <p className="lead">
        Fault rates from cases the court has ruled on. Each rate carries its range, and nothing is ranked. Cases that closed without a contest are counted next to the rates, not in them.
      </p>
      <Banner fresh={params.data ?? undefined} error={params.error} />
      <Card title="Method">
        <p>
          A rate is the weighted share of ruled cases that went a given way. The range is the Wilson 95% interval, taken at the effective sample size of the weights. A rate is shown only after {threshold} ruled cases for that party; before that it reads "not published yet". Cases with no usable outcome are counted as unresolved.
        </p>
        <p className="muted small">Read live from Arkiv in your browser, from entities written by {writer ? short(writer) : 'the docket writer'}.</p>
      </Card>
      <Card title="Rates">
        {!writer && !params.error && <Loading what="writer address" />}
        {state.error && <p className="error">{state.error}</p>}
        {writer && !state.rates && !state.error && <Loading what="docket from Arkiv" />}
        {state.rates && <RateTable rates={state.rates} />}
        {state.rates && <p className="muted small">Read {state.rows} ruled case{state.rows === 1 ? '' : 's'} from Arkiv just now.</p>}
      </Card>
    </>
  );
}
