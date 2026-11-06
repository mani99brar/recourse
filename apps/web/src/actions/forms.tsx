// The actions a person can take from these pages, each through the same /v1/actions call the agents
// use: file a claim, contest a finding, add evidence, withdraw credit, and the next step anyone may
// take when the keeper has not.
import { useState } from 'react';
import type { NextCall, VaultToken } from '@recourse/shared';
import { isAddress } from 'viem';
import type { ActionName } from '../lib/actions.js';
import { parseUsdc, usdc, when } from '../lib/format.js';
import { COURT_PERIODS } from '../lib/words.js';
import type { CaseDetail } from '../pages/Case.js';
import { ActionFlow } from './ActionFlow.js';

/** The claim's parties by lower-case address, for the preview's "where it goes" column. */
export function partyNames(d: Pick<CaseDetail, 'shop' | 'shopName' | 'platform' | 'platformName'>): Record<string, string> {
  return {
    [d.shop.toLowerCase()]: d.shopName ?? 'the shop',
    [d.platform.toLowerCase()]: d.platformName ?? 'the agent company',
  };
}

/** Only the side the pre-check went against contests: the agent company when the answer is 1, otherwise the shop. */
export function contesterOf(d: Pick<CaseDetail, 'answer' | 'shop' | 'platform'>): { address: string; who: string; why: string } {
  if (d.answer === 1) return { address: d.platform, who: 'the agent company', why: 'the pre-check found it at fault' };
  const why = d.answer === 2 ? 'the pre-check found it at fault' : d.answer === 3 ? 'the pre-check found neither side at fault, so nothing is paid' : 'the pre-check made no finding';
  return { address: d.shop, who: 'the shop', why };
}

export function ContestAction({ d }: { d: CaseDetail }) {
  const c = contesterOf(d);
  return (
    <ActionFlow
      name="contest"
      request={{ claimId: d.claimId }}
      claimId={d.claimId}
      signer={{ address: c.address, who: c.who }}
      names={partyNames(d)}
      token={d.vaultToken}
      intro={
        <>
          Only {c.who} can contest, because {c.why}
          {d.contest.windowEndsAt ? `; the window ends ${when(d.contest.windowEndsAt)}` : ''}. Contesting sends the claim to the court. It moves no money: the court fee was escrowed when the claim was filed.
        </>
      }
    />
  );
}

/** The evidence string the API builds, `JSON.stringify({ name, description, fileURI? })`, and its UTF-8 size. */
export function evidenceBytes(name: string, description: string, fileURI: string): number {
  return new TextEncoder().encode(JSON.stringify(fileURI ? { name, description, fileURI } : { name, description })).length;
}

export const EVIDENCE_MAX_BYTES = 49152;
const FILE_URI = /^(\/ipfs\/[A-Za-z0-9]+(\/.*)?|https:\/\/.+)$/;

/** The evidence form's problem in words, or null when it can be sent. */
export function evidenceProblem(name: string, description: string, fileURI: string): string | null {
  if (name.trim().length > 200) return 'The title can be at most 200 characters.';
  if (fileURI.trim() && (!FILE_URI.test(fileURI.trim()) || fileURI.trim().length > 512)) return 'The file link must start with /ipfs/ or https:// and be at most 512 characters.';
  const bytes = evidenceBytes(name.trim(), description, fileURI.trim());
  if (bytes > EVIDENCE_MAX_BYTES) return `The evidence is ${bytes.toLocaleString('en-US')} bytes; the most is 49,152.`;
  return null;
}

export function EvidenceAction({ d }: { d: CaseDetail }) {
  const ids = d.court.disputeIds;
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [uri, setUri] = useState('');
  const [attempt, setAttempt] = useState(Math.max(1, Math.min(ids.length, 2)));
  const problem = evidenceProblem(name, text, uri);
  const ready = name.trim() !== '' && text.trim() !== '' && problem === null;
  const request = ready
    ? { claimId: d.claimId, ...(ids.length > 1 ? { attempt } : {}), name: name.trim(), description: text, ...(uri.trim() ? { fileURI: uri.trim() } : {}) }
    : null;
  const stage = d.court.periodName && d.court.periodName !== 'evidence' ? (COURT_PERIODS[d.court.periodName] ?? d.court.periodName) : null;
  return (
    <ActionFlow
      name="submitEvidence"
      title="Add evidence to the court case"
      request={request}
      claimId={d.claimId}
      names={partyNames(d)}
      token={d.vaultToken}
      intro={
        <>
          Evidence goes to the claim's Kleros case on Arbitrum Sepolia. It is public and permanent, and the court shows it under the address that signs. This page uploads nothing: link a file you have put on IPFS or the web yourself.
          {stage && ` The case is at the "${stage}" stage; evidence is still taken, but jurors may already be voting.`}
        </>
      }
    >
      <label htmlFor="ev-name">Title</label>
      <input id="ev-name" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
      <label htmlFor="ev-text">What it shows (the court shows it as Markdown)</label>
      <textarea id="ev-text" rows={5} value={text} onChange={(e) => setText(e.target.value)} />
      <label htmlFor="ev-uri">Link to a file (optional): /ipfs/&lt;content id&gt; or https://…</label>
      <input id="ev-uri" value={uri} onChange={(e) => setUri(e.target.value)} spellCheck={false} />
      {ids.length > 1 && (
        <>
          <label htmlFor="ev-att">Which court case</label>
          <select id="ev-att" value={attempt} onChange={(e) => setAttempt(Number(e.target.value))}>
            {ids.map((id, i) => (
              <option key={id} value={i + 1}>
                {i === 0 ? 'First' : 'Second'} case (dispute #{id})
              </option>
            ))}
          </select>
        </>
      )}
      <p className="muted small">
        {evidenceBytes(name.trim(), text, uri.trim()).toLocaleString('en-US')} of 49,152 bytes
      </p>
      {problem && <p className="error">{problem}</p>}
    </ActionFlow>
  );
}

const NONCE = /^0x[0-9a-fA-F]{64}$/;

/** The fileClaim request without `from`, or a problem. The basket is never sent: the API reads it from the ordered record. */
export function fileRequest(f: { orderId: string; netLoss: string; nonce: string; platform: string; unpacked: boolean; withNonce: boolean }): { request: Record<string, unknown> | null; problem: string | null } {
  const loss = f.netLoss.trim() ? parseUsdc(f.netLoss) : null;
  if (f.netLoss.trim() && loss === null) return { request: null, problem: 'The net loss in step 3 must be an amount like 50.00.' };
  if (f.withNonce) {
    if (!NONCE.test(f.nonce.trim())) return { request: null, problem: 'The order nonce is 0x followed by 64 hex characters.' };
    if (!isAddress(f.platform.trim())) return { request: null, problem: 'Enter the agent company address the order was paid through.' };
  }
  return {
    problem: null,
    request: {
      orderId: f.orderId,
      ...(f.withNonce ? { platform: f.platform.trim(), orderNonce: f.nonce.trim() } : {}),
      ...(loss !== null ? { netLossUsdc: loss.toString() } : {}),
      ...(f.unpacked ? { allowUnpacked: true } : {}),
    },
  };
}

export function FileClaimAction({ orderId, packedHeld, platform, netLoss, token }: { orderId: string; packedHeld: boolean; platform: string; netLoss: string; token?: VaultToken | undefined }) {
  const [withNonce, setWithNonce] = useState(false);
  const [nonce, setNonce] = useState('');
  const [plat, setPlat] = useState(platform);
  const [unpacked, setUnpacked] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const { request, problem } = fileRequest({ orderId, netLoss, nonce, platform: plat, unpacked, withNonce });
  const showUnpacked = !packedHeld || refused === 'no_packed_record' || unpacked;
  return (
    <ActionFlow
      name="fileClaim"
      title="4. File the claim"
      request={request}
      token={token}
      onRefused={(code) => {
        setRefused(code);
        if (code === 'order_nonce_unknown') {
          setWithNonce(true);
          if (!plat) setPlat(platform);
        }
      }}
      intro={
        <>
          The shop that took the order files, so connect the shop's account. Filing escrows the court fee from your wallet and reserves the most the claim can pay from the agent company's deposit. The API reads the basket and the record references from the records topic itself; the net loss is {netLoss.trim() ? 'the amount in step 3' : 'the whole basket unless you enter one in step 3'}.
        </>
      }
    >
      <label className="check-row">
        <input type="checkbox" checked={withNonce} onChange={(e) => setWithNonce(e.target.checked)} /> I will enter the order nonce and agent company (needed when the shop service does not know the order)
      </label>
      {withNonce && (
        <div className="fields">
          <div>
            <label htmlFor="fc-nonce">Order nonce (the x-recourse-order-nonce the order was paid with)</label>
            <input id="fc-nonce" value={nonce} onChange={(e) => setNonce(e.target.value)} placeholder="0x…" spellCheck={false} />
          </div>
          <div>
            <label htmlFor="fc-plat">Agent company address (the x-recourse-platform)</label>
            <input id="fc-plat" value={plat} onChange={(e) => setPlat(e.target.value)} placeholder="0x…" spellCheck={false} />
          </div>
        </div>
      )}
      {showUnpacked && (
        <label className="check-row">
          <input type="checkbox" checked={unpacked} onChange={(e) => setUnpacked(e.target.checked)} /> File without a packing record. The topic shows no packing record from the shop for this order; without one, the pre-check finds against the shop from the packing step on.
        </label>
      )}
      {problem && <p className="error">{problem}</p>}
    </ActionFlow>
  );
}

export function WithdrawAction({ address, credit, token }: { address: string; credit: string; token?: VaultToken | undefined }) {
  return (
    <ActionFlow
      name="withdrawCredit"
      request={{}}
      signer={{ address, who: 'this account' }}
      token={token}
      intro={`This account has ${usdc(credit, token)} of credit in the deposit vault. Withdrawing pays all of it into the account's own wallet. Only the account itself can do it.`}
    />
  );
}

/** The calls anyone may make (the keeper makes them on its own); each is an action of the same name. */
export const ANYONE_ACTIONS = ['closeUncontested', 'sendToCourt', 'resend', 'expireClaim', 'settle', 'openCase', 'refile', 'relayRuling'] as const satisfies readonly ActionName[];
export type AnyoneAction = (typeof ANYONE_ACTIONS)[number];

export function anyoneAction(call: NextCall | null): AnyoneAction | null {
  return call !== null && (ANYONE_ACTIONS as readonly string[]).includes(call) ? (call as AnyoneAction) : null;
}

export function NextStepAction({ d, action }: { d: CaseDetail; action: AnyoneAction }) {
  const [payIn, setPayIn] = useState<'native' | 'link'>('native');
  return (
    <ActionFlow
      name={action}
      request={{ claimId: d.claimId, ...(action === 'relayRuling' ? { payIn } : {}) }}
      claimId={d.claimId}
      names={partyNames(d)}
      token={d.vaultToken}
      intro="Anyone may take this step. The Recourse keeper takes it on its own; do it yourself only if the keeper has not."
    >
      {action === 'relayRuling' && (
        <>
          <label htmlFor="rr-pay">Who pays the cross-chain fee</label>
          <select id="rr-pay" value={payIn} onChange={(e) => setPayIn(e.target.value === 'link' ? 'link' : 'native')}>
            <option value="native">I pay it in ETH with the transaction</option>
            <option value="link">The contract pays it from its own LINK</option>
          </select>
        </>
      )}
    </ActionFlow>
  );
}

/** The claim's actions, for its page: contest and the next step when due. Null when none is due. */
export function ClaimActions({ d }: { d: CaseDetail }) {
  const contest = d.nextCall === 'contest' && (d.statusKey === 'finding_made' || d.statusKey === 'no_finding');
  const next = anyoneAction(d.nextCall);
  if (!contest && !next) return null;
  return (
    <section aria-label="Act on this claim">
      {contest && <ContestAction d={d} />}
      {next && <NextStepAction key={next} d={d} action={next} />}
    </section>
  );
}
