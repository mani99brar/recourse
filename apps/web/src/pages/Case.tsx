import { recordHash, utf8ToBytes } from '@recourse/shared';
import { useState } from 'react';
import { ClaimActions, EvidenceAction, anyoneAction } from '../actions/forms.js';
import { Banner, Card, ExtLink, Loading, Pill, Row } from '../components.js';
import { READS, usePoll, type Fresh } from '../lib/api.js';
import { short, usdc, when, whenS } from '../lib/format.js';
import { ACTOR_WORDS, CALL_WORDS, COURT_PERIODS, FATE_WORDS, KIND_WORDS, SIDE_WORDS, STATUS_WORDS, deadlineLabel, statusPlain } from '../lib/words.js';
import type { NextActor, NextCall, StatusKey } from '@recourse/shared';
import '../styles/case.css';

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
    /** The topic has not been read far enough to say whether the message exists. */
    unread?: boolean;
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
  messages: { messageId: string; direction: string; sendNo: number; executionState: number | null; ccipExplorer: string }[];
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

const FINAL_KEYS: StatusKey[] = ['settled', 'closed_uncontested', 'closed_undrawn', 'expired', 'unresolved'];

/**
 * The seven steps from filing to the money, one row each. `facts` holds an optional line per step,
 * read from the claim itself (who contested, the dispute, the ruling, what was paid).
 */
export function Timeline({ events, statusKey, facts = [] }: { events: CaseDetail['events']; statusKey?: StatusKey; facts?: readonly (string | null)[] }) {
  const final = statusKey !== undefined && FINAL_KEYS.includes(statusKey);
  let reachedCurrent = final;
  return (
    <ol className="timeline">
      {STEPS.map((s, i) => {
        const hit = events.find((e) => s.events.includes(e.name));
        const cls = hit ? 'done' : !reachedCurrent ? 'current' : 'todo';
        if (!hit) reachedCurrent = true;
        const fact = facts[i] ?? null;
        return (
          <li key={s.label} className={cls} aria-current={cls === 'current' ? 'step' : undefined}>
            <span className="dot" aria-hidden />
            <span className="tl-text">
              <span className="tl-label">{s.label}</span>
              {fact && <span className="tl-fact">{fact}</span>}
              <span className="tl-when">{hit ? when(hit.time) : cls === 'current' ? 'next' : final ? 'did not happen' : ''}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** One line per step, from what the claim read says; null where it says nothing more than the step's name. */
export function stepFacts(d: CaseDetail): (string | null)[] {
  const closed = d.events.some((e) => e.name === 'ClosedUncontested');
  const paid = d.money.paid !== null && d.money.paid !== '0' ? `${usdc(d.money.paid, d.vaultToken)} paid from the deposit` : null;
  return [
    null,
    d.precheck ? `At fault: ${SIDE_WORDS[d.precheck.side] ?? d.precheck.side}` : null,
    d.contest.by ? `Contested by ${d.contest.by === d.platform ? 'the agent company' : 'the shop'}` : closed ? 'Closed with no contest' : d.contest.windowEndsAt && (d.statusKey === 'finding_made' || d.statusKey === 'no_finding') ? `Contest window ends ${when(d.contest.windowEndsAt)}` : null,
    d.court.attempts > 1 ? `Attempt ${d.court.attempts}` : null,
    d.court.disputeIds.length > 0 ? `Dispute ${d.court.disputeIds.map((id) => `#${id}`).join(', ')}` : null,
    d.court.ruling !== null ? `Ruling: ${rulingWord(String(d.court.ruling))}` : null,
    paid,
  ];
}

/** A party named as the claim read names it, linked to its own page. */
function PartyLink({ address, name, role }: { address: string; name: string | null; role: string }) {
  return (
    <a className="party" href={`#/party/${address}`}>
      <span className="party-name">{name ?? <span className="mono">{short(address)}</span>}</span>
      <span className="party-role">{role}</span>
    </a>
  );
}

export function CaseView({ d }: { d: CaseDetail }) {
  const word = STATUS_WORDS[d.statusKey];
  const tone = ['settled', 'closed_uncontested', 'closed_undrawn'].includes(d.statusKey) ? 'ok' : ['stuck', 'expired', 'unresolved'].includes(d.statusKey) ? 'bad' : 'wait';
  return (
    <div className="case-page">
      <header className="case-head">
        <p className="eyebrow">
          Order <span className="mono">{short(d.orderId)}</span>
        </p>
        <h1>
          <span className="case-id">
            Claim <span className="mono">{short(d.claimId)}</span>
          </span>{' '}
          <Pill tone={tone}>{word.title}</Pill>
        </h1>
        <p className="case-parties">
          <PartyLink address={d.shop} name={d.shopName} role="the shop" />
          <span className="case-v" aria-hidden>
            v
          </span>
          <PartyLink address={d.platform} name={d.platformName} role="the agent company" />
        </p>
        <p className="lead">{statusPlain(d.statusKey, d.nextCall, d.court.state)}</p>
        {d.nextCall && (
          <p className="next">
            <strong>Next:</strong> {ACTOR_WORDS[d.nextActor]} can {CALL_WORDS[d.nextCall]}.
            {(d.nextCall === 'contest' || anyoneAction(d.nextCall)) && ' It can be done below with a browser wallet; nothing is sent until you confirm.'}
          </p>
        )}
        {d.deadline && (
          <p className="next">
            <strong>{deadlineLabel(d.statusKey, d.nextCall)}:</strong> {when(d.deadline)}
          </p>
        )}
      </header>
      <Card title="Timeline">
        <Timeline events={d.events} statusKey={d.statusKey} facts={stepFacts(d)} />
      </Card>
      <ClaimActions key={d.claimId} d={d} />
      <div className="grid">
        <Card title="Money">
          <dl>
            <Row label="Basket">{usdc(d.basketUsdc, d.vaultToken)}</Row>
            <Row label="Net loss claimed">{usdc(d.netLossUsdc, d.vaultToken)}</Row>
            <Row label={d.money.projected ? 'Owed (projected)' : 'Owed'}>{usdc(d.money.owed, d.vaultToken)}</Row>
            <Row label="Paid from deposit">{usdc(d.money.paid, d.vaultToken)}</Row>
            <Row label="Not covered">{usdc(d.money.notCovered, d.vaultToken)}</Row>
            <Row label="Credited to the shop">{usdc(d.money.credited, d.vaultToken)}</Row>
            <Row label="Court fee escrow">
              {usdc(d.money.escrow.amount, d.vaultToken)}: {FATE_WORDS[d.money.escrow.fate] ?? d.money.escrow.fate}
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
                <Row label={d.statusKey === 'finding_made' || d.statusKey === 'no_finding' ? 'Contest window ends' : 'Contest window closed'}>{when(d.contest.windowEndsAt)}</Row>
                <Row label="Result document">
                  {d.precheck.packHashOk === true ? 'matches the hash on chain' : d.precheck.packHashOk === false ? 'does NOT match the hash on chain' : 'not available'}
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
              <Row label="Stage">{d.court.periodName ? (COURT_PERIODS[d.court.periodName] ?? d.court.periodName) : d.court.ruling !== null ? 'Finished' : 'not read yet'}</Row>
              <Row label={d.court.ruling !== null ? 'Ruling' : 'Current ruling'}>{d.court.ruling !== null ? rulingWord(String(d.court.ruling)) : d.court.currentRuling === null ? 'none yet' : rulingWord(d.court.currentRuling)}{d.court.tied ? ' (tied)' : ''}{d.court.overridden ? ' (overridden by appeal)' : ''}</Row>
              <Row label="Evidence">
                {d.court.evidence.length === 0 ? 'none seen yet' : d.court.evidence.map((e) => <ExtLink key={e.tx} href={e.explorer}>attempt {e.attempt}, {when(e.time)}</ExtLink>)}
              </Row>
            </dl>
          )}
        </Card>
        <Card title="Messages between chains">
          {d.messages.length === 0 ? (
            <p className="muted">None yet.</p>
          ) : (
            <ul className="plain">
              {d.messages.map((b) => (
                <li key={b.messageId}>
                  {b.direction === 'toArbitrum' ? 'To the court chain' : 'Back to Hedera'}, send {b.sendNo}:{' '}
                  {b.executionState === null ? 'delivery not read yet' : ['not delivered yet', 'in progress', 'delivered', 'failed'][b.executionState]}{' '}
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
      {d.court.disputeIds.length > 0 && <EvidenceAction key={d.claimId} d={d} />}
      <Card title="Records" id="records">
        <p className="muted">
          Each record document is fetched by its content id and checked against the hash on the records topic. A record that could not be fetched yet reads as unchecked, never as verified. Buyer details inside the documents appear only as salted hashes.
        </p>
        <div className="table-wrap">
          <table className="records">
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
                  <td>{r.cid ? (r.seq > 0 ? `#${r.seq}` : 'found by order') : r.unread ? (r.seq > 0 ? `listed (#${r.seq}), not read from the topic yet` : 'not read from the topic yet') : r.seq > 0 ? `listed (#${r.seq}), not on the topic` : 'missing'}</td>
                  <td>
                    {r.held === true ? <Pill tone="ok">verified</Pill> : r.held === null ? <Pill tone="wait">unchecked</Pill> : <Pill tone="bad">not held</Pill>}{' '}
                    <span className="muted small">{r.hashOk === false ? 'content differs from its hash; ' : ''}{!r.payerOk && r.cid ? 'wrong payer; ' : ''}{r.cid && !r.refsMatch ? 'not the one the shop referenced' : ''}</span>
                  </td>
                  <td className="mono hash">{r.cid ?? '-'}</td>
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
              <span className="mono ev-time">{whenS(e.time)}</span> <span className="ev-name">{e.name}</span> <span className="muted small ev-chain">on {e.chain}</span> <ExtLink href={e.explorer}>{short(e.tx, 4)}</ExtLink>
            </li>
          ))}
        </ul>
      </Card>
    </div>
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
        <p className="proof">
          <span className="proof-k">SHA-256</span> <span className="mono">{hash}</span>
          <span className="proof-says">{idx >= 0 ? <strong>Matches the {KIND_WORDS[idx]} record on this claim.</strong> : 'Does not match any record on this claim.'}</span>
        </p>
      )}
    </div>
  );
}

export function CasePage({ id }: { id: string }) {
  const { data, error } = usePoll<CaseDetail>(READS.claim(id));
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
