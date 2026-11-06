import { useId } from 'react';
import { WithdrawAction } from '../actions/forms.js';
import ring from '../assets/ring.webp';
import { Banner, Card, Loading, Pill, Row } from '../components.js';
import { READS, usePoll, type Fresh } from '../lib/api.js';
import { short, usdc, when } from '../lib/format.js';
import { GROUP_WORDS, STATUS_WORDS } from '../lib/words.js';
import type { StatusKey, VaultToken } from '@recourse/shared';
import '../styles/party.css';

interface RowT {
  claimId: string;
  statusKey: StatusKey;
  shopName: string | null;
  platformName: string | null;
  shop: string;
  platform: string;
  updatedAt: string;
  owed: string | null;
}
export interface Standing {
  address?: string;
  role: string;
  displayName: string | null;
  hederaAccountId?: string | null;
  balance: string | null;
  required: string | null;
  inGoodStanding: boolean | null;
  topUpDeadline: string | null;
  credit: string | null;
  escrowOpen: string;
  openClaims: number;
  exitRequestedAt: string | null;
}
export interface ClaimsBody extends Fresh {
  rows: RowT[];
  standing?: Standing;
  groups?: Record<string, string[]>;
}

export function ClaimList({ rows }: { rows: RowT[] }) {
  if (rows.length === 0) return <p className="muted">No claims.</p>;
  return (
    <ul className="claims">
      {rows.map((r) => (
        <li key={r.claimId}>
          <a href={`#/claim/${r.claimId}`}>{short(r.claimId)}</a> <Pill tone="plain">{STATUS_WORDS[r.statusKey]?.title ?? r.statusKey}</Pill>{' '}
          <span className="muted small">
            {r.shopName ?? short(r.shop)} against {r.platformName ?? short(r.platform)}, updated {when(r.updatedAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function roleWord(role: string): string {
  return role === 'unknown' ? 'Not a known party' : role === 'platform' ? 'Agent company' : role === 'shop' ? 'Shop' : role;
}

/** The one word for an agent company's deposit, read from the vault's own standing; null when unread. */
export type DepositState = 'bonded' | 'due' | 'short' | 'unread';
export function depositState(s: Pick<Standing, 'inGoodStanding' | 'topUpDeadline'>): DepositState {
  if (s.inGoodStanding === null) return 'unread';
  if (s.inGoodStanding) return 'bonded';
  return s.topUpDeadline && s.topUpDeadline !== '0' ? 'due' : 'short';
}
export const DEPOSIT_WORDS: Record<DepositState, string> = {
  bonded: 'Bonded',
  due: 'Top-up due',
  short: 'Not in good standing',
  unread: 'Not read right now',
};

/** How many claims name the account, how many are still open, and how many wait on it. */
export function worklistLine(rows: readonly unknown[], groups: Record<string, string[]> | undefined): string {
  const n = rows.length;
  if (n === 0) return 'No claim names this account yet.';
  const open = n - (groups?.finished?.length ?? 0);
  const mine = groups?.waitingOnYou?.length ?? 0;
  const head = `${n} claim${n === 1 ? ' names' : 's name'} this account`;
  const state = open <= 0 ? (n === 1 ? 'it is finished' : 'all are finished') : `${open} ${open === 1 ? 'is' : 'are'} open`;
  return `${head}: ${state}${mine ? `, ${mine} waiting on it` : ''}.`;
}

export function PartyPage({ address }: { address: string }) {
  const { data, error } = usePoll<ClaimsBody>(READS.partyClaims(address));
  const s = data?.standing;
  return (
    <div className="party-page">
      <Banner fresh={data ?? undefined} error={error} />
      {error?.status === 400 && <p>That does not look like an address.</p>}
      {!data && !error && <Loading what="worklist" />}
      {s && (
        <header className="page-head party-head">
          <p className="eyebrow">{roleWord(s.role)}</p>
          <h1>{s.displayName ?? <span className="mono">{short(address)}</span>}</h1>
          <p className="lead">{worklistLine(data.rows, data.groups)}</p>
        </header>
      )}
      {(s || data?.groups) && (
        <div className="party-cols">
          {s && (
            <div className="party-side">
              <StandingCard s={s} address={address} token={data?.vaultToken} />
              <WithdrawAction key={address.toLowerCase()} address={address} credit={s.credit} token={data?.vaultToken} />
            </div>
          )}
          {data?.groups && <Worklist rows={data.rows} groups={data.groups} role={s?.role ?? 'unknown'} token={data.vaultToken} />}
        </div>
      )}
    </div>
  );
}

export function StandingCard({ s, address, token }: { s: Standing; address: string; token: VaultToken | undefined }) {
  const agent = s.role === 'platform';
  const state = depositState(s);
  return (
    <Card title={agent ? 'The deposit' : 'Standing'}>
      {agent && <Mark name={s.displayName ?? short(address, 4)} balance={s.balance} state={state} token={token} />}
      <dl>
        <Row label="Role">{roleWord(s.role)}</Row>
        {agent && (
          <>
            <Row label="Deposit">
              {usdc(s.balance, token)} of {usdc(s.required, token)} required
            </Row>
            <Row label="Good standing">{state === 'unread' ? 'not read' : state === 'bonded' ? 'yes' : 'no'}</Row>
            <Row label="Top-up due">{s.topUpDeadline && s.topUpDeadline !== '0' ? when(s.topUpDeadline) : 'nothing due'}</Row>
          </>
        )}
        <Row label="Credit to withdraw">{usdc(s.credit, token)}</Row>
        <Row label="Court fees held in escrow">{usdc(s.escrowOpen, token)}</Row>
        <Row label="Open claims">{s.openClaims}</Row>
        {s.exitRequestedAt && <Row label="Exit requested">{when(s.exitRequestedAt)}</Row>}
        <Row label="Address">
          <span className="mono">{s.address ?? address}</span>
        </Row>
        {s.hederaAccountId && (
          <Row label="Hedera account">
            <span className="mono">{s.hederaAccountId}</span>
          </Row>
        )}
      </dl>
    </Card>
  );
}

/**
 * The bonded mark: the ring, the company's name and what its deposit holds. The ring is drawn only
 * while the vault says the company is bonded (or its top-up clock runs) and something is held; any
 * other state is a dashed ring with the state's word around it. Every figure is the vault's.
 */
export function Mark({ name, balance, state, token }: { name: string; balance: string | null; state: DepositState; token: VaultToken | undefined }) {
  const path = `mark-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const held = balance !== null && BigInt(balance) > 0n;
  const on = held && (state === 'bonded' || state === 'due');
  const word = DEPOSIT_WORDS[state];
  const ringText = on
    ? state === 'due'
      ? 'TOP-UP DUE · RECOURSE · TOP-UP DUE · RECOURSE ·'
      : 'BONDED AGENT · RECOURSE · BONDED AGENT · RECOURSE ·'
    : Array(Math.max(1, Math.round(51 / (word.length + 3))))
        .fill(`${word.toUpperCase()} ·`)
        .join(' ');
  const amount = balance === null ? '' : usdc(balance).replace(/ USDC$/, '');
  const unit = token?.symbol ?? 'USDC';
  const nameSize = Math.min(20, Math.floor((106 / (name.length * 0.62)) * 10) / 10);
  const amountSize = amount ? Math.min(25, Math.floor((106 / (amount.length * 0.66)) * 10) / 10) : 0;
  const label = on ? `${word} mark for ${name}: ${amount} ${unit} deposit` : `${name}: ${word.toLowerCase()}${amount ? `, ${amount} ${unit} held` : ''}`;
  return (
    <svg className={`mark${on ? ' mark-on' : ''}`} viewBox="0 0 200 200" role="img" aria-label={label}>
      <defs>
        <path id={path} d="M100 27a73 73 0 1 1-.01 0" />
      </defs>
      {on ? (
        <image href={ring} width="200" height="200" />
      ) : (
        <g fill="none" stroke="currentColor" strokeDasharray="4 5">
          <circle cx="100" cy="100" r="97" strokeWidth="1.4" />
          <circle cx="100" cy="100" r="90" strokeWidth="1" />
          <circle cx="100" cy="100" r="62" strokeWidth="1" />
        </g>
      )}
      <text fontSize="12.5" fontWeight="600" letterSpacing="1">
        <textPath href={`#${path}`} textLength="445" lengthAdjust="spacing">
          {ringText}
        </textPath>
      </text>
      <text x="100" y={amount ? 90 : 104} textAnchor="middle" fontSize={nameSize} fontWeight="700" className="mark-name">
        {name}
      </text>
      {amount && (
        <>
          <text x="100" y="118" textAnchor="middle" fontSize={amountSize} fontWeight="600" className="mark-amount">
            {amount}
          </text>
          <text x="100" y="135" textAnchor="middle" fontSize="11">
            {`${unit} ${on ? 'deposit' : 'held'}`}
          </text>
        </>
      )}
    </svg>
  );
}

const OTHER_SIDE: Record<string, string> = { shop: 'Agent company', platform: 'Shop' };

/** The worklist: every group with its count, then the claims of each group that has any, in the API's order. */
export function Worklist({ rows, groups, role, token }: { rows: RowT[]; groups: Record<string, string[]>; role: string; token: VaultToken | undefined }) {
  const byId = new Map(rows.map((r) => [r.claimId, r]));
  const all = Object.entries(GROUP_WORDS).map(([key, label]) => ({
    key,
    label,
    rows: (groups[key] ?? []).map((id) => byId.get(id)).filter((r): r is RowT => r !== undefined),
  }));
  const full = all.filter((g) => g.rows.length > 0);
  const other = OTHER_SIDE[role] ?? 'Shop and agent company';
  const otherName = (r: RowT) =>
    role === 'shop' ? (r.platformName ?? short(r.platform)) : role === 'platform' ? (r.shopName ?? short(r.shop)) : `${r.shopName ?? short(r.shop)} against ${r.platformName ?? short(r.platform)}`;
  return (
    <section className="card worklist" aria-labelledby="wl-title">
      <h2 id="wl-title">Worklist</h2>
      <ul className="wl-tally">
        {all.map((g) => (
          <li key={g.key} className={g.rows.length ? '' : 'wl-zero'}>
            <span>{g.label}</span> <b>{g.rows.length}</b>
          </li>
        ))}
      </ul>
      {full.length === 0 && <p className="empty">No claim names this account yet.</p>}
      {full.map((g) => (
        <div className="wl-group" key={g.key}>
          <h3>
            {g.label} <span className="wl-n">({g.rows.length})</span>
          </h3>
          <table className="wl">
            <thead>
              <tr>
                <th scope="col">Claim</th>
                <th scope="col">Status</th>
                <th scope="col">{other}</th>
                {g.key === 'owedToYou' && <th scope="col">Owed to the shop</th>}
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {g.rows.map((r) => (
                <tr key={r.claimId}>
                  <td className="wl-id">
                    <a className="mono" href={`#/claim/${r.claimId}`}>
                      {short(r.claimId)}
                    </a>
                  </td>
                  <td className="wl-st">
                    <Pill tone="plain">{STATUS_WORDS[r.statusKey]?.title ?? r.statusKey}</Pill>
                  </td>
                  <td className="wl-other">{otherName(r)}</td>
                  {g.key === 'owedToYou' && <td className="wl-owed">{usdc(r.owed, token)}</td>}
                  <td className="wl-when">{when(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}
