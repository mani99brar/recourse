import { WithdrawAction } from '../actions/forms.js';
import { Banner, Card, Loading, Pill, Row } from '../components.js';
import { usePoll, type Fresh } from '../lib/api.js';
import { short, usdc, when } from '../lib/format.js';
import { GROUP_WORDS, STATUS_WORDS } from '../lib/words.js';
import type { StatusKey, VaultToken } from '@recourse/shared';

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
interface Standing {
  role: string;
  displayName: string | null;
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

/** Credit that a withdrawal would pay out: read, and above zero. */
export function hasCredit(credit: string | null): credit is string {
  return credit !== null && /^\d+$/.test(credit) && BigInt(credit) > 0n;
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

export function PartyPage({ address }: { address: string }) {
  const { data, error } = usePoll<ClaimsBody>(`/claims?party=${address}`);
  return (
    <>
      <Banner fresh={data ?? undefined} error={error} />
      {error?.status === 400 && <p>That does not look like an address.</p>}
      {!data && !error && <Loading what="worklist" />}
      {data?.standing && <Standing s={data.standing} address={address} token={data.vaultToken} />}
      {data?.standing && hasCredit(data.standing.credit) && <WithdrawAction address={address} credit={data.standing.credit} token={data.vaultToken} />}
      {data?.groups &&
        Object.entries(GROUP_WORDS).map(([k, label]) => {
          const ids = new Set(data.groups?.[k] ?? []);
          return (
            <Card key={k} title={`${label} (${ids.size})`}>
              <ClaimList rows={data.rows.filter((r) => ids.has(r.claimId))} />
            </Card>
          );
        })}
    </>
  );
}

function Standing({ s, address, token }: { s: Standing; address: string; token: VaultToken | undefined }) {
  return (
    <Card title="Standing">
      <h1>{s.displayName ?? short(address)}</h1>
      <dl>
        <Row label="Role">{s.role === 'unknown' ? 'Not a known party' : s.role === 'platform' ? 'Agent company' : s.role === 'shop' ? 'Shop' : s.role}</Row>
        {s.role !== 'shop' && (
          <>
            <Row label="Deposit">{usdc(s.balance, token)} of {usdc(s.required, token)} required</Row>
            <Row label="Good standing">{s.inGoodStanding === null ? 'not read' : s.inGoodStanding ? 'yes' : 'no'}</Row>
            <Row label="Top-up due">{s.topUpDeadline && s.topUpDeadline !== '0' ? when(s.topUpDeadline) : 'nothing due'}</Row>
          </>
        )}
        <Row label="Credit to withdraw">{usdc(s.credit, token)}</Row>
        <Row label="Court fees held in escrow">{usdc(s.escrowOpen, token)}</Row>
        <Row label="Open claims">{s.openClaims}</Row>
        {s.exitRequestedAt && <Row label="Exit requested">{when(s.exitRequestedAt)}</Row>}
      </dl>
    </Card>
  );
}
