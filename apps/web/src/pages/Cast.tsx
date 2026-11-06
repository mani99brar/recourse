import { Banner, ExtLink, Loading, Pill, Row } from '../components.js';
import { usePoll, type Fresh } from '../lib/api.js';
import { short, usdc, when } from '../lib/format.js';
import { SIDE_WORDS, STATUS_WORDS } from '../lib/words.js';
import type { StatusKey, VaultToken } from '@recourse/shared';

/** The /v1 read this page makes (GET /v1/cast in openapi.json). */
export const CAST_READ = '/v1/cast';

interface CastClaim {
  claimId: string;
  statusKey: StatusKey;
  answer: number | null;
  findingSide: string | null;
  paid: string | null;
  counterparty: string;
  counterpartyName: string | null;
}
export interface CastMember {
  agentId: string;
  role: string;
  displayName: string;
  address: string;
  owner: string | null;
  ownerIsParty: boolean | null;
  agentURI: string | null;
  registration: { name: string | null; description: string | null; recourse: { role: string; kind: string; label: string; summary: string } | null } | null;
  readAt: number | null;
  current: boolean;
  explorer: string | null;
  ownerExplorer: string | null;
  orders: number;
  claims: CastClaim[];
}
export interface CastBody extends Fresh {
  registry: { chainId: number; address: string; accountId: string; explorer: string | null };
  members: CastMember[];
}

/** What the pre-check found, in plain words. */
function findingWords(c: CastClaim): string {
  if (c.findingSide === null) return 'not pre-checked yet';
  if (c.findingSide === 'none') return 'no finding';
  return `${SIDE_WORDS[c.findingSide] ?? c.findingSide} at fault`;
}

/** "2 (1 closed, not contested; 1 settled)". */
function outcomeWords(claims: CastClaim[]): string {
  if (claims.length === 0) return 'none';
  const n = new Map<string, number>();
  for (const c of claims) {
    const t = (STATUS_WORDS[c.statusKey]?.title ?? c.statusKey).toLowerCase();
    n.set(t, (n.get(t) ?? 0) + 1);
  }
  return `${claims.length} (${[...n].map(([t, k]) => `${k} ${t}`).join('; ')})`;
}

function uriWords(uri: string | null): string {
  if (uri === null) return 'not read yet';
  if (uri.startsWith('data:')) return 'inline in the registry';
  if (uri.startsWith('ipfs://')) return 'on IPFS';
  return 'a web page';
}

function Member({ m, token }: { m: CastMember; token: VaultToken | undefined }) {
  const type = m.registration?.recourse ?? null;
  const name = m.registration?.name ?? m.displayName;
  return (
    <section className="card">
      <h3>{name}</h3>
      <p>
        {type ? <Pill tone="plain">{type.label}</Pill> : <Pill tone="wait">Type not stated</Pill>}
        {!m.current && m.readAt !== null && <Pill tone="wait">as read {when(m.readAt)}</Pill>}
      </p>
      <p className="muted">
        {type?.summary ?? m.registration?.description ?? (m.registration === null ? 'The registration has not been read yet.' : 'Its registration does not say what type it is.')}
      </p>
      <dl>
        <Row label="ERC-8004 id">
          <ExtLink href={m.explorer}>{m.agentId}</ExtLink>
        </Row>
        <Row label="Owner">
          {m.owner ? <ExtLink href={m.ownerExplorer}>{short(m.owner)}</ExtLink> : m.readAt === null ? 'not read yet' : 'no agent with this id on the registry'}
          {m.ownerIsParty === false && m.owner && <span className="muted small"> (not the party's own account)</span>}
        </Row>
        <Row label="Registration">
          {m.agentURI?.startsWith('https://') ? <ExtLink href={m.agentURI}>{uriWords(m.agentURI)}</ExtLink> : uriWords(m.agentURI)}
          {type && <span className="mono"> {type.kind}</span>}
        </Row>
        <Row label="Orders recorded">{m.orders}</Row>
        <Row label="Claims">{outcomeWords(m.claims)}</Row>
      </dl>
      {m.claims.length > 0 && (
        <ul className="claims">
          {m.claims.map((c) => (
            <li key={c.claimId}>
              <a href={`#/claim/${c.claimId}`}>{short(c.claimId)}</a> <Pill tone="plain">{STATUS_WORDS[c.statusKey]?.title ?? c.statusKey}</Pill>{' '}
              <span className="muted small">{`with ${c.counterpartyName ?? short(c.counterparty)}; pre-check: ${findingWords(c)}${c.paid !== null ? `; paid ${usdc(c.paid, token)}` : ''}`}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="small">
        <a href={`#/party/${m.address}`}>Open its worklist</a>
      </p>
    </section>
  );
}

function Group({ title, members, token }: { title: string; members: CastMember[]; token: VaultToken | undefined }) {
  return (
    <>
      <h2>{`${title} (${members.length})`}</h2>
      {members.length === 0 ? (
        <p className="muted">None registered yet.</p>
      ) : (
        <div className="grid">
          {members.map((m) => (
            <Member key={m.agentId} m={m} token={token} />
          ))}
        </div>
      )}
    </>
  );
}

export function CastView({ d }: { d: CastBody }) {
  const shops = d.members.filter((m) => m.role === 'shop');
  const companies = d.members.filter((m) => m.role !== 'shop');
  const notes: string[] = [];
  if (d.degraded?.includes('identity')) notes.push('The ERC-8004 registry on Hedera could not be read just now. Owners, registrations and types below are the last ones read, where there are any.');
  if (shops.length <= 1 && companies.length <= 1) {
    notes.push('The demo cast has not been registered yet. So far the registry holds the first shop and the first agent company; more shop and agent types appear here once they are registered.');
  }
  return (
    <>
      {notes.length > 0 && (
        <div className="banner" role="status">
          {notes.map((t) => (
            <p key={t}>{t}</p>
          ))}
        </div>
      )}
      <Group title="Shops" members={shops} token={d.vaultToken} />
      <Group title="Agent companies" members={companies} token={d.vaultToken} />
      <p className="muted small">
        Read from the ERC-8004 identity registry <ExtLink href={d.registry.explorer}>{short(d.registry.address)}</ExtLink> ({d.registry.accountId}) on Hedera testnet, the records topic and the
        claims contract.
      </p>
    </>
  );
}

export function CastPage() {
  // The API reads the registry at most every 30 s; polling at the usual pace shows a late read as soon as it lands.
  const { data, error } = usePoll<CastBody>(CAST_READ);
  // The page says itself when the registry is behind; the banner names the other sources.
  const fresh = data ? { ...data, degraded: (data.degraded ?? []).filter((s) => s !== 'identity') } : undefined;
  return (
    <>
      <h1>Shops and agents</h1>
      <p className="lead">
        Every shop and agent company in this demo, as registered in ERC-8004 on Hedera testnet: what type it is, how many orders its records name, and how its claims ended.
      </p>
      <Banner fresh={fresh} error={error} />
      {!data && !error && <Loading what="shops and agents" />}
      {data && <CastView d={data} />}
    </>
  );
}
