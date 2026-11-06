import type { ReactNode } from 'react';
import type { VaultToken } from '@recourse/shared';
import { isRebuilding, type ApiFailure, type Fresh } from './lib/api.js';
import { mockNote } from './lib/format.js';

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
  if (fresh?.degraded?.length) notes.push(`Some sources are running late: ${fresh.degraded.map((d) => lateWords(d, fresh.asOf)).join(', ')}. Figures may lag the chain.`);
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

const SOURCE_WORDS: Record<string, string> = { hedera: 'Hedera', arbitrum: 'Arbitrum', hcs: 'the records topic', params: 'the contract parameters' };

/** One late source and how far behind it is: "Hedera (4 min behind)", "the records topic (not read through yet)". */
export function lateWords(source: string, asOf: Fresh['asOf'], nowMs: number = Date.now()): string {
  const name = SOURCE_WORDS[source] ?? source;
  if (source === 'params') return `${name} (not read yet)`;
  const through = asOf?.[source as 'hedera' | 'arbitrum' | 'hcs'];
  if (through === undefined) return name;
  if (through === null) return `${name} (not read through yet)`;
  const s = Math.max(0, Math.round(nowMs / 1000 - through));
  return `${name} (${s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`} behind)`;
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

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kv">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <p className="muted">Loading {what}…</p>;
}

export function ExtLink({ href, children }: { href: string | null | undefined; children: ReactNode }) {
  if (!href) return <span>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}
