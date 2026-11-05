import type { ReactNode } from 'react';
import type { ApiFailure, Fresh } from './lib/api.js';

export function Banner({ fresh, error }: { fresh?: Fresh | undefined; error?: ApiFailure | null }) {
  const notes: string[] = [];
  if (error) {
    notes.push(
      error.code === 'rebuilding'
        ? 'The status service is rebuilding its index. Figures will appear in a moment.'
        : error.status === 404
          ? ''
          : 'The status service cannot be reached. What you see may be out of date.',
    );
  }
  if (fresh?.degraded?.length) notes.push(`Some sources are running late (${fresh.degraded.join(', ')}). Figures may lag the chain.`);
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
