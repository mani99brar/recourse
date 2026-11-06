import { useEffect, useState } from 'react';
import { WalletBar } from './actions/WalletBar.js';
import { CasePage } from './pages/Case.js';
import { CastPage } from './pages/Cast.js';
import { DocketPage } from './pages/Docket.js';
import { FilePage } from './pages/File.js';
import { HomePage } from './pages/Home.js';
import { PartyPage } from './pages/Party.js';

export function route(hash: string): { name: 'home' | 'claim' | 'party' | 'docket' | 'file' | 'cast'; arg: string } {
  const [, a = '', b = ''] = hash.replace(/^#/, '').split('/');
  if (a === 'claim' && b) return { name: 'claim', arg: b };
  if (a === 'party' && b) return { name: 'party', arg: b };
  if (a === 'docket') return { name: 'docket', arg: '' };
  if (a === 'file') return { name: 'file', arg: '' };
  if (a === 'cast') return { name: 'cast', arg: '' };
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
          <a href="#/cast" aria-current={r.name === 'cast' ? 'page' : undefined}>Shops and agents</a>
          <a href="#/file" aria-current={r.name === 'file' ? 'page' : undefined}>Check or file an order</a>
        </nav>
        <WalletBar />
      </header>
      <main>
        {r.name === 'home' && <HomePage />}
        {r.name === 'claim' && <CasePage id={r.arg} />}
        {r.name === 'party' && <PartyPage address={r.arg} />}
        {r.name === 'docket' && <DocketPage />}
        {r.name === 'file' && <FilePage />}
        {r.name === 'cast' && <CastPage />}
      </main>
      <footer>
        <p>Test networks only; no real money. Reading needs no wallet. To act, your own browser wallet signs each step after you confirm it; this site never holds a key and never signs for you. Amounts, names and ids come from the chains and the public records. Any value marked "sample" is a made-up example.</p>
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
