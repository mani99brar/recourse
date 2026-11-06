import type { ReactNode } from 'react';
import type { VaultToken } from '@recourse/shared';
import { isRebuilding, type ApiFailure, type Fresh } from './lib/api.js';
import { mockNote } from './lib/format.js';
import { useTheme } from './lib/theme.js';
import { SIDE_WORDS } from './lib/words.js';

export function Banner({ fresh, error, token }: { fresh?: Fresh | undefined; error?: ApiFailure | null; token?: VaultToken | undefined }) {
  const notes: string[] = [];
  // The owner's remaining powers come first: they bear on every figure the page shows.
  if (fresh?.configLock?.notice) notes.push(fresh.configLock.notice);
  const mock = mockNote(token ?? fresh?.vaultToken);
  if (mock) notes.push(mock);
  if (error) {
    notes.push(
      isRebuilding(error)
        ? 'The status service is rebuilding its index. Figures will appear in a moment.'
        : error.status === 404
          ? ''
          : 'The status service cannot be reached. What you see may be out of date.',
    );
  }
  if (fresh?.degraded?.length) notes.push(`Some sources are running late: ${fresh.degraded.map((d) => lateWords(d, fresh.asOf, Date.now(), fresh.stale)).join(', ')}. Figures may lag the chain.`);
  const text = notes.filter(Boolean);
  if (!text.length) return null;
  return (
    <div className="banner" role="status">
      {text.map((t) => (
        <p key={t}>{t}</p>
      ))}
    </div>
  );
}

const SOURCE_WORDS: Record<string, string> = {
  hedera: 'Hedera',
  arbitrum: 'Arbitrum',
  hcs: 'the records topic',
  params: 'the contract parameters',
  facts: 'the contract facts',
  vault: 'the deposit and credit figures',
  live: 'the court and cross-chain reads',
  identity: 'the ERC-8004 registrations',
};

const ago = (s: number) => (s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);

/**
 * One late source and how far behind it is: "Hedera (4 min behind)", "the records topic (not read through yet)",
 * "the contract parameters (last read 40 s ago)" for a live read served from its last good value.
 */
export function lateWords(source: string, asOf: Fresh['asOf'], nowMs: number = Date.now(), stale?: Fresh['stale']): string {
  const name = SOURCE_WORDS[source] ?? source;
  if (source === 'hedera' || source === 'arbitrum' || source === 'hcs') {
    const through = asOf?.[source];
    if (through === undefined) return name;
    if (through === null) return `${name} (not read through yet)`;
    return `${name} (${ago(Math.max(0, Math.round(nowMs / 1000 - through)))} behind)`;
  }
  const last = stale?.find((x) => x.read === source);
  if (!last) return name;
  return last.ageS === null ? `${name} (not read yet)` : `${name} (last read ${ago(last.ageS)} ago)`;
}

export function Card({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section className="card" id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function Pill({ tone, children }: { tone: 'ok' | 'wait' | 'bad' | 'plain'; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

/**
 * A side the API names as at fault, in the design's red. Only 'shop' and 'platform' are a fault;
 * 'neither' and 'none' stay plain words.
 */
export function SideWords({ side, suffix = '' }: { side: string; suffix?: string }) {
  const words = `${SIDE_WORDS[side] ?? side}${suffix}`;
  return side === 'shop' || side === 'platform' ? <span className="fault">{words}</span> : <>{words}</>;
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kv">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p className="muted loading" role="status">
      Loading {what}…
    </p>
  );
}

/** The design's mode switch: two pressed-state buttons, dark first. */
export function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  return (
    <div className="theme" role="group" aria-label="Colour mode">
      {(['dark', 'light'] as const).map((t) => (
        <button key={t} type="button" aria-pressed={theme === t} onClick={() => setTheme(t)}>
          {t === 'dark' ? 'Dark' : 'Light'}
        </button>
      ))}
    </div>
  );
}

/** A right-pointing arrow for links styled as buttons or doors (decorative). */
export function Arrow() {
  return (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M2 9h13M9.5 3.5 15 9l-5.5 5.5" />
    </svg>
  );
}

export function ExtLink({ href, children }: { href: string | null | undefined; children: ReactNode }) {
  if (!href) return <span>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}
