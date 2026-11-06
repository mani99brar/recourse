import { useState } from 'react';
import { Banner, Card, Loading } from '../components.js';
import { getApi, usePoll } from '../lib/api.js';
import { ClaimList, type ClaimsBody } from './Party.js';

interface SearchBody {
  hits: { type: string; id: string; claimId: string | null }[];
}

const TYPE_WORDS: Record<string, string> = {
  claim: 'claim', order: 'order', message: 'bridge message', packHash: 'pre-check document', tx: 'transaction', recordHash: 'record', dispute: 'court dispute', hcsMessage: 'record message', party: 'party', topic: 'records topic',
};

export function HomePage() {
  const { data, error } = usePoll<ClaimsBody>('/claims');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchBody['hits'] | null>(null);
  async function search() {
    try {
      setHits((await getApi<SearchBody>(`/search?q=${encodeURIComponent(q.trim())}`)).hits);
    } catch {
      setHits([]);
    }
  }
  return (
    <>
      <h1>Recourse</h1>
      <p className="lead">
        When an AI shopping agent buys the wrong thing, a shop can file a claim and be paid from the agent company's deposit. This site shows every claim, read from the chains. It never holds a key: when a party acts here, their own wallet signs.
      </p>
      <Banner fresh={data ?? undefined} error={error} />
      <Card title="Find a claim">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <label htmlFor="q">Claim, order, transaction, message, dispute number or address</label>
          <input id="q" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
          <button type="submit" disabled={q.trim() === ''}>
            Search
          </button>
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
        {data && <ClaimList rows={data.rows.slice(0, 20)} />}
      </Card>
    </>
  );
}
