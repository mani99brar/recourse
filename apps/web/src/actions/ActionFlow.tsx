// One action from form to read-back: the API builds it, the page shows what it will do, the person
// confirms, their wallet signs each transaction in order, and the page reads the new state back.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { VaultToken } from '@recourse/shared';
import { ExtLink, Pill, Row } from '../components.js';
import { ApiFailure } from '../lib/api.js';
import {
  ACTION_WORDS, amountName, amountText, errorWords, feeWords, mockLabelled, movementWords, postAction, sameAddress, sameCallGas, signingProblems,
  type ActionName, type ActionResponse, type ReadBody,
} from '../lib/actions.js';
import { CHAINS, addressLink, chainLabel, chainName, explorerName, isOurChain, txLink, units } from '../lib/chains.js';
import { freshSteps, readBack, signAll, type Step, type StepState } from '../lib/flow.js';
import { short, usdc, when, whenS } from '../lib/format.js';
import { STATUS_WORDS } from '../lib/words.js';
import { WalletStop, connectWallet, injectedProvider, stopWords, useWallet, walletOps, type WalletState } from '../lib/wallet.js';
import '../styles/case.css';

export interface Problem {
  text: string;
  code?: string;
  /** A claim the problem points at (claim_exists): linked. */
  claimId?: string | null;
}

export type Phase =
  | { kind: 'form' }
  | { kind: 'building' }
  | { kind: 'refused'; problem: Problem }
  | { kind: 'preview'; resp: ActionResponse; problems: string[] }
  | { kind: 'signing'; resp: ActionResponse; steps: Step[] }
  | { kind: 'reading'; resp: ActionResponse; steps: Step[] }
  | { kind: 'done'; resp: ActionResponse; steps: Step[]; after: ReadBody | null; shows: boolean }
  | { kind: 'stopped'; resp: ActionResponse; steps: Step[]; problem: Problem };

type Token = Pick<VaultToken, 'label'> | undefined;

export interface ActionFlowProps {
  name: ActionName;
  /** The request without `from` (the connected account is added); null while the form is incomplete. */
  request: Record<string, unknown> | null;
  /** When only one account may sign, who: checked before building and shown. */
  signer?: { address: string; who: string } | null;
  /** Lower-case address to words ("the agent company"), for the preview's amounts. */
  names?: Record<string, string>;
  token?: Token;
  claimId?: string | null;
  title?: string;
  intro?: ReactNode;
  /** The form's fields, shown until the preview. */
  children?: ReactNode;
  /** Hears the error code of a refused build (the file form shows more fields on some). */
  onRefused?: (code: string) => void;
  /**
   * The action is due now (default true). The pages keep a panel mounted after it stops being due,
   * so an action that just landed keeps its hashes and read-back on screen; a panel that is not due
   * and not yet started shows nothing.
   */
  offered?: boolean;
}

/** The action, wired to the API and the browser wallet. */
export function ActionFlow(p: ActionFlowProps) {
  const wallet = useWallet();
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const show = (next: Phase) => {
    if (alive.current) setPhase(next);
  };
  /** The body the shown preview was built from: a later step is estimated again from the same one. */
  const sent = useRef<Record<string, unknown> | null>(null);

  async function build() {
    const from = wallet.account;
    if (!from || !p.request) return;
    show({ kind: 'building' });
    try {
      const body = { from, ...p.request };
      sent.current = body;
      const resp = await postAction(p.name, body);
      show({ kind: 'preview', resp, problems: signingProblems(resp, { name: p.name, from, claimId: p.claimId ?? null }) });
    } catch (e) {
      const f = e instanceof ApiFailure ? e : new ApiFailure(0, 'unreachable');
      p.onRefused?.(f.code);
      show({ kind: 'refused', problem: { text: errorWords(f, { from, token: p.token }), code: f.code, claimId: typeof f.details.claimId === 'string' ? f.details.claimId : null } });
    }
  }

  async function confirm(resp: ActionResponse) {
    let steps = freshSteps(resp);
    const provider = injectedProvider();
    if (!provider) {
      show({ kind: 'stopped', resp, steps, problem: { text: stopWords(new WalletStop('no_wallet')), code: 'no_wallet' } });
      return;
    }
    show({ kind: 'signing', resp, steps });
    try {
      const body = sent.current;
      const regas = body ? async (tx: ActionResponse['transactions'][number]) => sameCallGas(resp, await postAction(p.name, body), tx) : undefined;
      const hashes = await signAll(
        resp,
        walletOps(provider),
        (i, step) => {
          steps = steps.map((s, j) => (j === i ? step : s));
          show({ kind: 'signing', resp, steps });
        },
        undefined,
        regas,
      );
      show({ kind: 'reading', resp, steps });
      const r = await readBack(resp, hashes, { alive: () => alive.current });
      show({ kind: 'done', resp, steps, after: r.body, shows: r.shows });
    } catch (e) {
      const stop = e instanceof WalletStop ? e : new WalletStop('wallet', { said: e instanceof Error ? e.message : 'unknown error' });
      show({ kind: 'stopped', resp, steps, problem: { text: stopWords(stop), code: stop.kind } });
    }
  }

  return (
    <ActionFlowView
      {...p}
      wallet={wallet}
      phase={phase}
      onConnect={() => void connectWallet()}
      onBuild={() => void build()}
      onConfirm={(resp) => void confirm(resp)}
      onBack={() => show({ kind: 'form' })}
    />
  );
}

export interface ActionFlowViewProps extends ActionFlowProps {
  wallet: WalletState;
  phase: Phase;
  onConnect?: () => void;
  onBuild?: () => void;
  onConfirm?: (resp: ActionResponse) => void;
  onBack?: () => void;
}

const STAGES = ['Preview', 'Sign', 'Read the result'] as const;

/** Which of the three stages a phase is in: 0 preview, 1 sign, 2 read back; 3 once all are done. */
export function stageOf(phase: Pick<Phase, 'kind'>): number {
  switch (phase.kind) {
    case 'form':
    case 'building':
    case 'refused':
      return 0;
    case 'preview':
    case 'signing':
    case 'stopped':
      return 1;
    case 'reading':
      return 2;
    case 'done':
      return 3;
  }
}

/** The three stages of every action, the one it is in marked. */
export function Stages({ at }: { at: number }) {
  return (
    <ol className="act-stages" aria-label="Stages">
      {STAGES.map((s, i) => (
        <li key={s} className={i < at ? 'done' : i === at ? 'now' : 'later'} aria-current={i === at ? 'step' : undefined}>
          <span className="act-n" aria-hidden>
            {i + 1}
          </span>
          {s}
        </li>
      ))}
    </ol>
  );
}

/** What the action shows in each phase; no effects, so every phase renders on its own. */
export function ActionFlowView(v: ActionFlowViewProps) {
  const { phase, wallet } = v;
  const wrongSigner = !!(v.signer && wallet.account && !sameAddress(v.signer.address, wallet.account));
  const editing = phase.kind === 'form' || phase.kind === 'building' || phase.kind === 'refused';
  if (v.offered === false && (phase.kind === 'form' || phase.kind === 'refused')) return null;
  return (
    <section className="card act">
      <h2>{v.title ?? ACTION_WORDS[v.name]}</h2>
      <Stages at={stageOf(phase)} />
      {v.intro && <p className="act-intro">{v.intro}</p>}
      <WalletLine wallet={wallet} onConnect={v.onConnect} />
      {v.signer && wrongSigner && (
        <p className="error" role="alert">
          This must be signed by {v.signer.who} ({short(v.signer.address)}). Your wallet is on {short(wallet.account!)}: switch to that account in your wallet.
        </p>
      )}
      {editing && (
        <>
          {v.children}
          <div className="actions-row">
            <button type="button" disabled={!wallet.account || !v.request || wrongSigner || phase.kind === 'building'} onClick={v.onBuild}>
              {phase.kind === 'building' ? 'Asking the API…' : 'Show what this will do'}
            </button>
          </div>
          <p className="muted small">Nothing is signed yet. The next screen shows the amounts, the network and the fee; your wallet signs only after you confirm.</p>
          {phase.kind === 'refused' && <ProblemLine problem={phase.problem} />}
        </>
      )}
      {phase.kind === 'preview' && (
        <>
          <PreviewView resp={phase.resp} names={v.names} />
          {phase.problems.length > 0 && (
            <div className="banner" role="alert">
              <p>
                <strong>This page will not ask your wallet to sign this:</strong>
              </p>
              {phase.problems.map((t) => (
                <p key={t}>{t}</p>
              ))}
            </div>
          )}
          <div className="actions-row">
            <button type="button" disabled={phase.problems.length > 0} onClick={() => v.onConfirm?.(phase.resp)}>
              {phase.resp.transactions.length > 1 ? `Confirm and sign ${phase.resp.transactions.length} transactions` : 'Confirm and sign in your wallet'}
            </button>
            <button type="button" className="secondary" onClick={v.onBack}>
              Back
            </button>
          </div>
        </>
      )}
      {(phase.kind === 'signing' || phase.kind === 'reading' || phase.kind === 'done' || phase.kind === 'stopped') && (
        <>
          <StepsView resp={phase.resp} steps={phase.steps} />
          {phase.kind === 'signing' && phase.resp.transactions.length > 1 && <p className="muted small">Keep this page open until every step is mined.</p>}
          {phase.kind === 'reading' && <p className="muted">Mined. Reading the new state back from the chain…</p>}
          {phase.kind === 'done' && <ReadBackView resp={phase.resp} after={phase.after} shows={phase.shows} token={v.token} />}
          {phase.kind === 'stopped' && (
            <>
              <ProblemLine problem={phase.problem} />
              {phase.steps.some((s) => s.state === 'mined') && <p className="muted small">The steps marked mined are on chain. Building again picks up from there.</p>}
              <div className="actions-row">
                <button type="button" className="secondary" onClick={v.onBack}>
                  Build it again
                </button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

export function WalletLine({ wallet, onConnect }: { wallet: WalletState; onConnect?: (() => void) | undefined }) {
  if (!wallet.available) {
    return <p className="muted small">To do this, open the page in a browser with a wallet (one that can add Hedera testnet and Arbitrum Sepolia). Everything else on this site works without one.</p>;
  }
  if (!wallet.account) {
    return (
      <div className="actions-row">
        <button type="button" className="secondary" disabled={wallet.connecting} onClick={onConnect}>
          {wallet.connecting ? 'Connecting…' : 'Connect wallet'}
        </button>
        {wallet.error && <span className="error small">{wallet.error}</span>}
      </div>
    );
  }
  return (
    <p className="muted small">
      Your wallet: <span className="mono">{wallet.account}</span>, on {chainName(wallet.chainId)}.{!isOurChain(wallet.chainId) && ' It is asked to switch network when you sign.'}
    </p>
  );
}

export function ProblemLine({ problem }: { problem: Problem }) {
  return (
    <p className="error" role="alert">
      {problem.text}
      {problem.claimId && (
        <>
          {' '}
          <a href={`#/claim/${problem.claimId}`}>Open that claim</a>.
        </>
      )}
      {problem.code && <span className="muted small mono"> ({problem.code})</span>}
    </p>
  );
}

/** What a preview needs: the API's answer, or one this page built itself (LocalFlow). */
export type Previewable = Pick<ActionResponse, 'chainId' | 'from' | 'transactions' | 'preview' | 'builtAt' | 'notAfter'>;

/**
 * The preview the API built, in the app's words: amounts with units, the network and the fee.
 * `checkedBy` names who checked a step it could not simulate ("the API" unless the page built it).
 */
export function PreviewView({ resp, names = {}, checkedBy = 'the API' }: { resp: Previewable; names?: Record<string, string> | undefined; checkedBy?: string }) {
  const p = resp.preview;
  const native = CHAINS[resp.chainId]?.nativeCurrency.symbol ?? 'native units';
  const n = resp.transactions.length;
  return (
    <div className="preview">
      <h3>Before you sign</h3>
      <p>{mockLabelled(p.summary)}</p>
      <dl>
        <Row label="Network">{chainLabel(resp.chainId)}</Row>
        <Row label="Signed by">
          <span className="mono">{resp.from}</span> (your wallet)
        </Row>
        {p.statusAfter && <Row label="Claim status after">{STATUS_WORDS[p.statusAfter]?.title ?? p.statusAfter}</Row>}
        {resp.notAfter && <Row label="Must be mined by">{when(resp.notAfter)}</Row>}
        <Row label="Checked against the chain at">{whenS(resp.builtAt)}</Row>
      </dl>
      <h3>Amounts</h3>
      {p.amounts.length === 0 ? (
        <p className="muted">No money moves.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>What</th>
                <th>Amount</th>
                <th>Where it goes</th>
              </tr>
            </thead>
            <tbody>
              {p.amounts.map((a) => (
                <tr key={a.name}>
                  <td>{amountName(a.name)}</td>
                  <td>{amountText(a)}</td>
                  <td>{movementWords(a, resp.from, names)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>Network fee</h3>
      {feeWords(p.fee, resp.chainId).map((t) => (
        <p key={t} className="small">
          {t}
        </p>
      ))}
      <h3>{n > 1 ? `${n} transactions, signed in this order` : 'The transaction'}</h3>
      <ol className="steps">
        {resp.transactions.map((t, i) => (
          <li key={i}>
            {mockLabelled(t.description)}{' '}
            <span className="muted small">
              <span className="mono">
                {t.call.contract}.{t.call.function}
              </span>{' '}
              at <ExtLink href={addressLink(t.chainId, t.to)}>{short(t.to)}</ExtLink>
              {t.value !== '0' && <>; sends {units(t.value, 18, native)}</>}
              {!t.simulated && `; checked by ${checkedBy} but not simulated, because it needs the step before it mined first: its gas is estimated again once that step has mined`}
            </span>
          </li>
        ))}
      </ol>
      {p.changes.length > 0 && (
        <>
          <h3>What changes on chain</h3>
          <ul>
            {p.changes.map((c) => (
              <li key={c}>{mockLabelled(c)}</li>
            ))}
          </ul>
        </>
      )}
      {p.notes.length > 0 && (
        <div className="banner" role="note">
          {p.notes.map((t) => (
            <p key={t}>{mockLabelled(t)}</p>
          ))}
        </div>
      )}
    </div>
  );
}

const STEP_WORDS: Record<StepState, string> = {
  waiting: 'waiting',
  estimating: 'estimating its gas now that the step before it has mined',
  chain: 'checking the network',
  sign: 'waiting for your signature',
  mining: 'sent, waiting to be mined',
  mined: 'mined',
  failed: 'stopped',
};

export function StepsView({ resp, steps }: { resp: Pick<ActionResponse, 'transactions'>; steps: Step[] }) {
  return (
    <ol className="steps">
      {resp.transactions.map((t, i) => {
        const s = steps[i] ?? { state: 'waiting', hash: null };
        return (
          <li key={i}>
            <Pill tone={s.state === 'mined' ? 'ok' : s.state === 'failed' ? 'bad' : 'wait'}>{STEP_WORDS[s.state]}</Pill> {mockLabelled(t.description)}
            {s.hash && (
              <span className="tx">
                Transaction <span className="mono">{s.hash}</span> <ExtLink href={txLink(t.chainId, s.hash)}>{`on ${explorerName(t.chainId)}`}</ExtLink>
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The state after the action, as the status API reads it from the chain. */
export function ReadBackView({ resp, after, shows, token }: { resp: ActionResponse; after: ReadBody | null; shows: boolean; token?: Token }) {
  const claimLink = resp.claimId ? (
    <p>
      <a href={`#/claim/${resp.claimId}`}>Open the claim</a>
    </p>
  ) : null;
  if (!after) {
    return (
      <>
        <p className="muted">Mined, but the status service has not answered with the new state yet. The pages here update on their own once it does.</p>
        {claimLink}
      </>
    );
  }
  const lead = shows ? 'Read back from the chain through the status service:' : 'Mined, but the index has not shown the change yet. This is the latest it has; the pages here update on their own.';
  if ('party' in after) {
    return (
      <>
        <p>{lead}</p>
        <dl>
          <Row label="Credit now">{usdc(after.party.credit, after.meta?.vaultToken ?? token)}</Row>
        </dl>
      </>
    );
  }
  const c = after.claim;
  const t = after.meta?.vaultToken ?? token;
  return (
    <>
      <p>{lead}</p>
      <dl>
        <Row label="Claim status now">
          <Pill tone="plain">{STATUS_WORDS[c.statusKey]?.title ?? c.statusKey}</Pill>
        </Row>
        {STATUS_WORDS[c.statusKey] && <Row label="What that means">{STATUS_WORDS[c.statusKey].plain}</Row>}
        {c.contest?.by && <Row label="Contested by">{short(c.contest.by)}</Row>}
        {resp.action === 'submitEvidence' && <Row label="Evidence on file">{c.court?.evidence?.length ?? 0}</Row>}
        {resp.action === 'fileClaim' && c.escrow && <Row label="Court fee in escrow">{usdc(c.escrow.amount, t)}</Row>}
      </dl>
      <p>
        <a href={`#/claim/${c.claimId}`}>Open the claim</a>
      </p>
    </>
  );
}
