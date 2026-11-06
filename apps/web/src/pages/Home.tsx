import { useState, type ReactNode } from 'react';
import type { StatusKey } from '@recourse/shared';
import hand from '../assets/hand.webp';
import { Arrow, Banner, Card, Loading } from '../components.js';
import { READS, getRead, usePoll } from '../lib/api.js';
import { useWallet } from '../lib/wallet.js';
import { ClaimList, type ClaimsBody } from './Party.js';
import '../styles/home.css';

interface SearchBody {
  hits: { type: string; id: string; claimId: string | null }[];
}

const TYPE_WORDS: Record<string, string> = {
  claim: 'claim', order: 'order', message: 'bridge message', packHash: 'pre-check document', tx: 'transaction', recordHash: 'record', dispute: 'court dispute', hcsMessage: 'record message', party: 'party', topic: 'records topic',
};

const FINISHED: StatusKey[] = ['settled', 'closed_uncontested', 'closed_undrawn', 'expired', 'unresolved'];
const AT_COURT: StatusKey[] = ['contested', 'at_court', 'refused_once'];

/** Live counts from the claims read: every number here is a count of rows the status service returned. */
export function claimCounts(rows: { statusKey: StatusKey }[]): { label: string; n: number }[] {
  const finished = rows.filter((r) => FINISHED.includes(r.statusKey)).length;
  const court = rows.filter((r) => AT_COURT.includes(r.statusKey)).length;
  return [
    { label: 'Claims', n: rows.length },
    { label: 'Open', n: rows.length - finished },
    { label: 'Contested or at court', n: court },
    { label: 'Finished', n: finished },
  ];
}

function Door({ href, onClick, kicker, title, children }: { href?: string; onClick?: () => void; kicker: string; title: string; children: ReactNode }) {
  const inner = (
    <>
      <span className="door-kicker">{kicker}</span>
      <span className="door-title">
        {title}
        <Arrow />
      </span>
      <span className="door-text">{children}</span>
    </>
  );
  if (href) {
    return (
      <a className="door" href={href}>
        {inner}
      </a>
    );
  }
  return (
    <button type="button" className="door" onClick={onClick}>
      {inner}
    </button>
  );
}

export function HomePage() {
  const { data, error } = usePoll<ClaimsBody>(READS.claims());
  const wallet = useWallet();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchBody['hits'] | null>(null);
  async function search() {
    try {
      setHits((await getRead<SearchBody>(READS.search(q.trim()))).hits);
    } catch {
      setHits([]);
    }
  }
  const counts = data ? claimCounts(data.rows) : null;
  const findAddress = () => {
    const el = typeof document === 'undefined' ? null : (document.getElementById('q') as HTMLInputElement | null);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.focus({ preventScroll: true });
  };
  return (
    <>
      <section className="hero bleed" aria-labelledby="hero-title">
        <div className="hero-in">
          <div className="hero-copy">
            <p className="eyebrow">Test networks only. No real money.</p>
            <h1 id="hero-title">
              <span>The agent</span> <span>bought</span> <span>
                <em>wrong.</em>
              </span>{' '}
              <span>Who pays?</span>
            </h1>
            <p className="hero-sub">
              When an AI shopping agent buys the wrong thing, a shop can file a claim and be paid from the agent company's deposit. This site shows every claim, read from the chains. It never holds a key: when a party acts here, their own wallet signs.
            </p>
            <div className="acts">
              <a className="btn" href="#/docket">
                Read the docket
                <Arrow />
              </a>
              <a className="btn ghost" href="#/file">
                Check or file an order
              </a>
            </div>
          </div>
          <img className="hero-art" src={hand} width={880} height={700} alt="" aria-hidden="true" decoding="async" />
        </div>
      </section>

      <Banner fresh={data ?? undefined} error={error} />

      {counts && (
        <section className="counts" aria-label="Claims right now">
          <dl className="count-row">
            {counts.map((c) => (
              <div key={c.label} className="count">
                <dt>{c.label}</dt>
                <dd>{c.n}</dd>
              </div>
            ))}
          </dl>
          <p className="muted small">Counted from the status service's read of the chains, refreshed every few seconds.</p>
        </section>
      )}

      <nav className="doors" aria-label="Where to go">
        <Door href="#/file" kicker="Shops" title="Check or file an order">
          Load an order's records to see whether they differ, then file a claim from your own wallet.
        </Door>
        <Door href="#/docket" kicker="Everyone" title="The docket">
          Fault rates from cases the court has ruled on, each with its range. Nothing is ranked.
        </Door>
        <Door href="#/cast" kicker="Shops and agent companies" title="Shops and agents">
          Every shop and agent company in this demo, the orders its records name, and how its claims ended.
        </Door>
        {wallet.account ? (
          <Door href={`#/party/${wallet.account}`} kicker="Your wallet" title="Your worklist">
            Claims that wait on you, money owed to you, and credit you can withdraw.
          </Door>
        ) : (
          <Door onClick={findAddress} kicker="A party" title="Look up a worklist">
            Search an address below to see the claims that wait on that party. Connecting a wallet links your own.
          </Door>
        )}
      </nav>

      <Card title="Find a claim">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <label htmlFor="q">Claim, order, transaction, message, dispute number or address</label>
          <div className="with">
            <input id="q" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
            <button type="submit" disabled={q.trim() === ''}>
              Search
            </button>
          </div>
        </form>
        {hits && hits.length === 0 && <p className="muted">Nothing matches exactly.</p>}
        {hits && hits.length > 0 && (
          <ul className="plain">
            {hits.map((h) => (
              <li key={`${h.type}-${h.id}-${h.claimId}`}>
                {TYPE_WORDS[h.type] ?? h.type}:{' '}
                {h.claimId ? <a href={`#/claim/${h.claimId}`}>open claim</a> : h.type === 'party' ? <a href={`#/party/${h.id}`}>open worklist</a> : <span className="mono">{h.id}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Latest claims">
        {!data && !error && <Loading what="claims" />}
        {!data && error && <p className="empty">The claims could not be read just now.</p>}
        {data && <ClaimList rows={data.rows.slice(0, 20)} />}
      </Card>
    </>
  );
}
