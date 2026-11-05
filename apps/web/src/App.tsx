import { useEffect, useState } from 'react';
import { CasePage } from './pages/Case.js';
import { DocketPage } from './pages/Docket.js';
import { FilePage } from './pages/File.js';
import { HomePage } from './pages/Home.js';
import { PartyPage } from './pages/Party.js';

export function route(hash: string): { name: 'home' | 'claim' | 'party' | 'docket' | 'file'; arg: string } {
  const [, a = '', b = ''] = hash.replace(/^#/, '').split('/');
  if (a === 'claim' && b) return { name: 'claim', arg: b };
  if (a === 'party' && b) return { name: 'party', arg: b };
  if (a === 'docket') return { name: 'docket', arg: '' };
  if (a === 'file') return { name: 'file', arg: '' };
  return { name: 'home', arg: '' };
}

export function Shell({ hash }: { hash: string }) {
  const r = route(hash);
  return (
    <div className="shell">
      <header className="top">
        <a className="brand" href="#/">Recourse</a>
        <nav aria-label="Main">
          <a href="#/" aria-current={r.name === 'home' ? 'page' : undefined}>Claims</a>
          <a href="#/docket" aria-current={r.name === 'docket' ? 'page' : undefined}>Docket</a>
          <a href="#/file" aria-current={r.name === 'file' ? 'page' : undefined}>Check an order</a>
        </nav>
      </header>
      <main>
        {r.name === 'home' && <HomePage />}
        {r.name === 'claim' && <CasePage id={r.arg} />}
        {r.name === 'party' && <PartyPage address={r.arg} />}
        {r.name === 'docket' && <DocketPage />}
        {r.name === 'file' && <FilePage />}
      </main>
      <footer>
        <p>Read-only. Test network only; no real money. Amounts, names and ids come from the chains and the public records. Any value marked "sample" is a made-up example.</p>
      </footer>
    </div>
  );
}

export function App() {
  const [hash, setHash] = useState(typeof location === 'undefined' ? '' : location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return <Shell hash={hash} />;
}
