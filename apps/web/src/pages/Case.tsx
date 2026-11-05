import { recordHash, utf8ToBytes } from '@recourse/shared';
import { useState } from 'react';
import { Banner, Card, ExtLink, Loading, Pill, Row } from '../components.js';
import { usePoll, type Fresh } from '../lib/api.js';
import { short, usdc, when } from '../lib/format.js';
import { ACTOR_WORDS, CALL_WORDS, COURT_PERIODS, FATE_WORDS, KIND_WORDS, SIDE_WORDS, STATUS_WORDS } from '../lib/words.js';
import type { NextActor, NextCall, StatusKey } from '@recourse/shared';

export interface CaseDetail extends Fresh {
  claimId: string;
  orderId: string;
  shop: string;
  shopName: string | null;
  platform: string;
  platformName: string | null;
  filedAt: string;
  statusKey: StatusKey;
  nextActor: NextActor;
  nextCall: NextCall | null;
  deadline: string | null;
  findingSide: string | null;
  gap: number | null;
  answer: number | null;
  basketUsdc: string;
  netLossUsdc: string;
  refs: { hashes: string[] };
  records: {
    kind: number;
    seq: number;
    cid: string | null;
    hash: string | null;
    payerOk: boolean;
    held: boolean | null;
    hashOk: boolean | null;
    refsMatch: boolean;
  }[];
  precheck: { gap: number; answer: number; side: string; packHash: string; packHashOk: boolean | null } | null;
  contest: { by: string | null; at: string | null; windowEndsAt: string | null };
  court: {
    state: string;
    attempts: number;
    disputeIds: string[];
    period: number | null;
    periodName: string | null;
    currentRuling: string | null;
    tied: boolean | null;
    overridden: boolean | null;
    ruling: number | null;
    evidence: { attempt: number; uri: string; tx: string; explorer: string | null; time: string }[];
    courtLinks: { disputeId: string; url: string }[];
  };
  bridge: { messageId: string; direction: string; sendNo: number; executionState: number; ccipExplorer: string }[];
  money: { owed: string | null; paid: string | null; credited: string | null; notCovered: string | null; escrow: { amount: string; fate: string }; projected: boolean };
  docket: { writeStatus: string; entityKey: string | null; store: string | null };
  events: { name: string; chain: string; tx: string; time: string; explorer: string | null }[];
}

const STEPS: { label: string; events: string[] }[] = [
  { label: 'Claim filed', events: ['ClaimFiled'] },
  { label: 'Pre-check recorded', events: ['PreCheckRecorded'] },
  { label: 'Contested or closed', events: ['Contested', 'ClosedUncontested'] },
  { label: 'Sent to court', events: ['SentToCourt'] },
  { label: 'Court case opened', events: ['CaseOpened'] },
  { label: 'Ruling received', events: ['RulingReceived'] },
  { label: 'Money applied', events: ['Settled', 'ClaimExpired', 'ClosedUncontested'] },
];

export function Timeline({ events }: { events: CaseDetail['events'] }) {
  let reachedCurrent = false;
  return (
    <ol className="timeline">
      {STEPS.map((s) => {
        const hit = events.find((e) => s.events.includes(e.name));
        const cls = hit ? 'done' : !reachedCurrent ? 'current' : 'todo';
        if (!hit) reachedCurrent = true;
        return (
          <li key={s.label} className={cls}>
            <span className="dot" aria-hidden />
            <span className="tl-label">{s.label}</span>
            <span className="tl-when">{hit ? when(hit.time) : cls === 'current' ? 'next' : ''}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function CaseView({ d }: { d: CaseDetail }) {
  const word = STATUS_WORDS[d.statusKey];
  const tone = ['settled', 'closed_uncontested', 'closed_undrawn'].includes(d.statusKey) ? 'ok' : ['stuck', 'expired', 'unresolved'].includes(d.statusKey) ? 'bad' : 'wait';
  return (
    <>
      <header className="case-head">
        <p className="eyebrow">Claim {short(d.claimId)}</p>
        <h1>
          <Pill tone={tone}>{word.title}</Pill>
        </h1>
        <p className="lead">{word.plain}</p>
        {d.nextCall && (
          <p className="next">
            <strong>Next:</strong> {ACTOR_WORDS[d.nextActor]} can {CALL_WORDS[d.nextCall]}
            {d.deadline ? ` (by ${when(d.deadline)})` : ''}. This page does not send anything.
          </p>
        )}
      </header>
      <div className="grid">
        <Card title="Timeline">
          <Timeline events={d.events} />
        </Card>
        <Card title="Money">
          <dl>
            <Row label="Basket">{usdc(d.basketUsdc)}</Row>
            <Row label="Net loss claimed">{usdc(d.netLossUsdc)}</Row>
            <Row label={d.money.projected ? 'Owed (projected)' : 'Owed'}>{usdc(d.money.owed)}</Row>
            <Row label="Paid from deposit">{usdc(d.money.paid)}</Row>
            <Row label="Not covered by the deposit">{usdc(d.money.notCovered)}</Row>
            <Row label="Credited to the shop">{usdc(d.money.credited)}</Row>
            <Row label="Court fee escrow">
              {usdc(d.money.escrow.amount)}: {FATE_WORDS[d.money.escrow.fate] ?? d.money.escrow.fate}
            </Row>
          </dl>
        </Card>
        <Card title="Parties and pre-check">
          <dl>
            <Row label="Shop">{d.shopName ?? short(d.shop)}</Row>
            <Row label="Agent company">{d.platformName ?? short(d.platform)}</Row>
            <Row label="Filed">{when(d.filedAt)}</Row>
            {d.precheck ? (
              <>
                <Row label="Pre-check says">At fault: {SIDE_WORDS[d.precheck.side] ?? d.precheck.side}</Row>
                <Row label="Contest window ends">{when(d.contest.windowEndsAt)}</Row>
                <Row label="Result document">
                  {d.precheck.packHashOk === true ? 'matches the hash on chain' : d.precheck.packHashOk === false ? 'does NOT match the hash on chain' : 'not checked yet'}
                </Row>
              </>
            ) : (
              <Row label="Pre-check">not run yet</Row>
            )}
            {d.contest.by && <Row label="Contested by">{d.contest.by === d.platform ? 'the agent company' : 'the shop'}</Row>}
          </dl>
        </Card>
        <Card title="Court">
          {d.court.attempts === 0 && d.court.disputeIds.length === 0 ? (
            <p className="muted">Not at court.</p>
          ) : (
            <dl>
              <Row label="Attempts">{d.court.attempts}</Row>
              <Row label="Dispute">
                {d.court.disputeIds.map((id) => {
                  const link = d.court.courtLinks.find((l) => l.disputeId === id);
                  return (
                    <span key={id} className="chip">
                      <ExtLink href={link?.url}>#{id}</ExtLink>
                    </span>
                  );
                })}
              </Row>
              <Row label="Stage">{d.court.periodName ? (COURT_PERIODS[d.court.periodName] ?? d.court.periodName) : 'not read yet'}</Row>
              <Row label="Current ruling">{d.court.currentRuling === null ? 'none yet' : rulingWord(d.court.currentRuling)}{d.court.tied ? ' (tied)' : ''}{d.court.overridden ? ' (overridden by appeal)' : ''}</Row>
              <Row label="Evidence">
                {d.court.evidence.length === 0 ? 'none seen yet' : d.court.evidence.map((e) => <ExtLink key={e.tx} href={e.explorer}>attempt {e.attempt}, {when(e.time)}</ExtLink>)}
              </Row>
            </dl>
          )}
        </Card>
        <Card title="Messages between chains">
          {d.bridge.length === 0 ? (
            <p className="muted">None yet.</p>
          ) : (
            <ul className="plain">
              {d.bridge.map((b) => (
                <li key={b.messageId}>
                  {b.direction === 'toArbitrum' ? 'To the court chain' : 'Back to Hedera'}, send {b.sendNo}: {['not delivered yet', 'in progress', 'delivered', 'failed'][b.executionState]}{' '}
                  <ExtLink href={b.ccipExplorer}>{short(b.messageId)}</ExtLink>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Public docket">
          <p>
            {{ none: 'Not published yet.', pending: 'Being published.', written: 'Published.', failed: 'Publishing failed; it will be retried.', unreachable: 'The docket service cannot be reached.' }[d.docket.writeStatus] ?? d.docket.writeStatus}
            {d.docket.store === 'local' ? ' (kept in a local store, not on Arkiv)' : ''}
          </p>
        </Card>
      </div>
      <Card title="Records" id="records">
        <p className="muted">
          Record documents are public to anyone who has their content id. Buyer details inside them appear only as salted hashes.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Record</th>
                <th>On topic</th>
                <th>Checks</th>
                <th>Content id</th>
              </tr>
            </thead>
            <tbody>
              {d.records.map((r) => (
                <tr key={r.kind}>
                  <td>{KIND_WORDS[r.kind]}</td>
                  <td>{r.seq > 0 ? `#${r.seq}` : r.cid ? 'found by order' : 'missing'}</td>
                  <td>
                    {r.held === true ? <Pill tone="ok">verified</Pill> : r.held === null ? <Pill tone="wait">unchecked</Pill> : <Pill tone="bad">not held</Pill>}{' '}
                    <span className="muted small">{r.hashOk === false ? 'content differs from its hash; ' : ''}{!r.payerOk && r.cid ? 'wrong payer; ' : ''}{r.cid && !r.refsMatch ? 'not the one the shop referenced' : ''}</span>
                  </td>
                  <td className="mono">{r.cid ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <RecordCheck hashes={d.refs.hashes} />
      </Card>
      <Card title="Everything that happened">
        <ul className="plain events">
          {d.events.map((e) => (
            <li key={`${e.tx}-${e.name}-${e.time}`}>
              <span className="mono">{when(e.time)}</span> {e.name} <span className="muted small">on {e.chain}</span> <ExtLink href={e.explorer}>{short(e.tx, 4)}</ExtLink>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

function rulingWord(r: string): string {
  return { '0': 'refused to rule', '1': 'for the shop (agent company pays)', '2': 'against the claim', '3': 'neither side at fault' }[r] ?? `ruling ${r}`;
}

/** Paste a record's exact text; the browser hashes it and compares with the hashes the shop filed. */
export function RecordCheck({ hashes }: { hashes: string[] }) {
  const [text, setText] = useState('');
  const hash = text === '' ? null : recordHash(utf8ToBytes(text));
  const idx = hash ? hashes.findIndex((h) => h === hash) : -1;
  return (
    <div className="check">
      <h3>Check a record</h3>
      <label htmlFor="rc">Paste the exact text of a record document. It is hashed here in your browser and nothing is sent anywhere.</label>
      <textarea id="rc" rows={4} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      {hash && (
        <p className="mono small">
          SHA-256: {hash}
          <br />
          {idx >= 0 ? <strong>Matches the {KIND_WORDS[idx]} record on this claim.</strong> : 'Does not match any record on this claim.'}
        </p>
      )}
    </div>
  );
}

export function CasePage({ id }: { id: string }) {
  const { data, error } = usePoll<CaseDetail>(`/claims/${id}`);
  return (
    <>
      <Banner fresh={data ?? undefined} error={error} />
      {error?.status === 404 && <p>No claim with that id. Check the id, or search by order, transaction or message.</p>}
      {error?.status === 400 && <p>That does not look like a claim id (0x followed by 64 hex characters).</p>}
      {!data && !error && <Loading what="claim" />}
      {data && <CaseView d={data} />}
    </>
  );
}
