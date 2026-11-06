import { Component, Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import { WalletBar } from './actions/WalletBar.js';
import { Loading, ThemeSwitch } from './components.js';
import { CasePage } from './pages/Case.js';
import { CastPage } from './pages/Cast.js';
import { DocketPage } from './pages/Docket.js';
import { FilePage } from './pages/File.js';
import { HomePage } from './pages/Home.js';
import { PartyPage } from './pages/Party.js';

// The story and the two sign-up pages load on their own when opened, so the home page never fetches them.
const StoryPage = lazy(() => import('./pages/Story.js').then((m) => ({ default: m.StoryPage })));
const JoinPage = lazy(() => import('./pages/Join.js').then((m) => ({ default: m.JoinPage })));
const BondPage = lazy(() => import('./pages/Bond.js').then((m) => ({ default: m.BondPage })));

/**
 * A page that loads on its own can fail to: a tab opened before a redeploy asks for files the new
 * build no longer has. The page then says so in a line, and the header and nav stay, rather than the
 * whole app going blank.
 */
export class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <p className="empty" role="alert">
        This page could not load; reload to get the latest version.{' '}
        <button type="button" className="linkish" onClick={() => location.reload()}>
          Reload the page
        </button>
      </p>
    );
  }
}

export type RouteName = 'home' | 'claim' | 'party' | 'docket' | 'file' | 'cast' | 'story' | 'join' | 'bond';

export function route(hash: string): { name: RouteName; arg: string } {
  const [, a = '', b = ''] = hash.replace(/^#/, '').split('/');
  if (a === 'claim' && b) return { name: 'claim', arg: b };
  if (a === 'party' && b) return { name: 'party', arg: b };
  if (a === 'docket') return { name: 'docket', arg: '' };
  if (a === 'file') return { name: 'file', arg: '' };
  if (a === 'cast') return { name: 'cast', arg: '' };
  if (a === 'story') return { name: 'story', arg: '' };
  if (a === 'join') return { name: 'join', arg: '' };
  if (a === 'bond') return { name: 'bond', arg: '' };
  return { name: 'home', arg: '' };
}

export function Shell({ hash }: { hash: string }) {
  const r = route(hash);
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    // On a phone the nav is one row that scrolls inside itself: bring the current page's link into view
    // there, clear of the fade at its end. Only the nav scrolls, never the page.
    const n = nav.current;
    const a = n?.querySelector<HTMLElement>('a[aria-current="page"]');
    if (!n || !a || n.scrollWidth <= n.clientWidth) return;
    const box = n.getBoundingClientRect();
    const at = a.getBoundingClientRect();
    if (at.left < box.left) n.scrollLeft -= box.left - at.left + 4;
    else if (at.right > box.right - 28) n.scrollLeft += at.right - (box.right - 28);
  }, [r.name]);
  return (
    <div className="shell" data-route={r.name}>
      {/* the hash carries the route, so the skip link moves focus instead of changing the address */}
      <a
        className="skip"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        Skip to the page
      </a>
      <header className="top">
        <a className="brand word" href="#/">
          Recourse
        </a>
        <nav aria-label="Main" ref={nav}>
          <a href="#/" aria-current={r.name === 'home' ? 'page' : undefined}>Claims</a>
          <a href="#/docket" aria-current={r.name === 'docket' ? 'page' : undefined}>Docket</a>
          <a href="#/cast" aria-current={r.name === 'cast' ? 'page' : undefined}>Shops and agents</a>
          <a href="#/file" aria-current={r.name === 'file' ? 'page' : undefined}>Check or file an order</a>
          <a href="#/story" aria-current={r.name === 'story' ? 'page' : undefined}>How it works</a>
        </nav>
        <div className="top-end">
          <ThemeSwitch />
          <WalletBar />
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        {r.name === 'home' && <HomePage />}
        {r.name === 'claim' && <CasePage id={r.arg} />}
        {r.name === 'party' && <PartyPage address={r.arg} />}
        {r.name === 'docket' && <DocketPage />}
        {r.name === 'file' && <FilePage />}
        {r.name === 'cast' && <CastPage />}
        {(r.name === 'story' || r.name === 'join' || r.name === 'bond') && (
          <PageBoundary key={r.name}>
            <Suspense fallback={<Loading what="the page" />}>
              {r.name === 'story' && <StoryPage />}
              {r.name === 'join' && <JoinPage />}
              {r.name === 'bond' && <BondPage />}
            </Suspense>
          </PageBoundary>
        )}
      </main>
      <footer className="foot">
        <div className="foot-in">
          <span className="key">Recourse</span>
          <p>Test networks only; no real money. Reading needs no wallet. To act, your own browser wallet signs each step after you confirm it; this site never holds a key and never signs for you. Amounts, names and ids come from the chains and the public records. Any value marked "sample" is a made-up example.</p>
        </div>
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
