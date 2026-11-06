// An action this page builds itself (an ERC-8004 registration, a deposit), run the way ActionFlow
// runs one the API built: the page shows what it will do, the person confirms, their wallet signs
// each transaction in order, and the page reads the result back. The gas of each step is estimated
// through the wallet's own connection before the preview; a step that needs the one before it mined
// keeps its budget until then, and is estimated again once it has.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPublicClient, custom, isAddress, isHex, type Abi, type Address, type EIP1193Provider, type Hash } from 'viem';
import { erc8004IdentityAbi } from '@recourse/shared';
import type { NativeFee, Preview, PreviewAmount, UnsignedTx } from '../lib/actions.js';
import { callProblem } from '../lib/calls.js';
import { CHAINS, isOurChain, units } from '../lib/chains.js';
import { freshSteps, signAll, type Signable, type Step } from '../lib/flow.js';
import { REGISTRY_LABEL } from '../lib/identity.js';
import { WalletStop, connectWallet, injectedProvider, stopFrom, stopWords, useWallet, walletOps, type WalletState } from '../lib/wallet.js';
import { PreviewView, ProblemLine, Stages, StepsView, WalletLine, stageOf, type Problem } from './ActionFlow.js';

/** What the page asks to be signed: its transactions (gas not yet estimated) and the preview's words. */
export interface LocalPlan {
  transactions: UnsignedTx[];
  summary: string;
  amounts?: PreviewAmount[];
  changes?: string[];
  notes?: string[];
}

/** A plan with its gas filled in and its fee, in the shape the preview and the signing runner take. */
export interface LocalBuilt extends Signable {
  chainId: number;
  preview: Preview;
}

export type LocalPhase =
  | { kind: 'form' }
  | { kind: 'building' }
  | { kind: 'refused'; problem: Problem }
  | { kind: 'preview'; built: LocalBuilt; problems: string[] }
  | { kind: 'signing'; built: LocalBuilt; steps: Step[] }
  | { kind: 'reading'; built: LocalBuilt; steps: Step[] }
  | { kind: 'done'; built: LocalBuilt; steps: Step[]; after: ReactNode }
  | { kind: 'stopped'; built: LocalBuilt; steps: Step[]; problem: Problem };

export interface LocalFlowProps {
  title: string;
  intro?: ReactNode;
  /** The form's fields, shown until the preview. */
  children?: ReactNode;
  /** The transactions for the connected account; null while the form is incomplete. May throw a sentence for the person. */
  plan: ((from: Address) => LocalPlan | Promise<LocalPlan>) | null;
  /** More reasons not to sign this plan (deposit.ts depositProblems), beside the checks every plan gets. */
  problems?: (txs: readonly UnsignedTx[]) => string[];
  /** After every step mined: what the chain now says (identity.ts readBack), in the page's own words. */
  after?: (hashes: Hash[], provider: EIP1193Provider) => Promise<ReactNode>;
  /** Lower-case address to words, for the preview's amounts. */
  names?: Record<string, string>;
}

/** The contracts a plan built here may call, and the fragments its data is checked against (ERC-8004 is not in CALL_ABIS). */
const OWN_ABIS: Record<string, Abi> = { [REGISTRY_LABEL]: erc8004IdentityAbi as Abi };
const LOCAL_CALLS = new Set([`${REGISTRY_LABEL}.register`, `${REGISTRY_LABEL}.setAgentURI`, 'VaultToken.approve', 'DepositVault.postDeposit']);

/** Every reason not to sign a plan built here, in plain words; empty when it may go to the wallet. */
export function localProblems(txs: readonly UnsignedTx[]): string[] {
  const out: string[] = [];
  if (txs.length === 0) out.push('There is nothing to sign.');
  txs.forEach((tx, i) => {
    const n = txs.length > 1 ? `Step ${i + 1}` : 'The transaction';
    if (!isOurChain(tx.chainId)) out.push(`${n} is for network ${tx.chainId}; this page signs only on Hedera testnet and Arbitrum Sepolia.`);
    if (!isAddress(tx.to) || !isHex(tx.data)) out.push(`${n} has no valid target or data.`);
    else {
      const why = callProblem(tx.data, tx.call, OWN_ABIS[tx.call.contract]);
      if (why) out.push(`${n} does not match the call shown: ${why}.`);
    }
    if (!LOCAL_CALLS.has(`${tx.call.contract}.${tx.call.function}`)) out.push(`${n} calls ${tx.call.contract}.${tx.call.function}, which this page never builds.`);
    if (tx.value !== '0') out.push(`${n} sends a value with it, which no call built here needs.`);
  });
  return out;
}

/** Hedera's margin on the node's estimate, as the API and the shop sign with it (x1.3). */
const withMargin = (gas: bigint): bigint => (gas * 13n + 9n) / 10n;

/**
 * Fills each step's gas through the wallet's connection: an estimate with the margin (simulated)
 * when the node can run the call now; else, for a later step, the budget it was built with. A first
 * step that cannot be estimated would fail, so it throws the node's reason.
 */
export async function estimatePlan(provider: EIP1193Provider, from: Address, plan: LocalPlan, nowS: number = Math.floor(Date.now() / 1000)): Promise<LocalBuilt> {
  const chainId = plan.transactions[0]?.chainId ?? 0;
  const client = createPublicClient({ chain: CHAINS[chainId], transport: custom(provider, { retryCount: 1 }) });
  const gasPrice = await client.getGasPrice();
  const transactions: UnsignedTx[] = [];
  for (const [i, tx] of plan.transactions.entries()) {
    try {
      const gas = await client.estimateGas({ account: from, to: tx.to, data: tx.data, value: BigInt(tx.value) });
      transactions.push({ ...tx, gas: withMargin(gas).toString(), gasPrice: gasPrice.toString(), simulated: true });
    } catch (e) {
      if (i === 0 || !/^[1-9][0-9]*$/.test(tx.gas)) throw new Error(`The network would refuse ${tx.call.function}: ${stopFrom(e).facts.said ?? 'no reason given'}.`);
      transactions.push({ ...tx, gasPrice: gasPrice.toString(), simulated: false });
    }
  }
  const gas = transactions.reduce((s, t) => s + BigInt(t.gas), 0n);
  const native = CHAINS[chainId]?.nativeCurrency ?? { decimals: 18, symbol: 'HBAR' };
  const fee: NativeFee = {
    amount: (gas * gasPrice).toString(),
    decimals: native.decimals,
    symbol: native.symbol,
    display: units(gas * gasPrice, native.decimals, native.symbol),
    gas: gas.toString(),
    gasPrice: gasPrice.toString(),
    basis: transactions.every((t) => t.simulated) ? 'estimate' : 'budget',
  };
  return {
    chainId,
    from,
    transactions,
    builtAt: String(nowS),
    notAfter: null,
    preview: { summary: plan.summary, amounts: plan.amounts ?? [], fee, changes: plan.changes ?? [], statusAfter: null, notes: plan.notes ?? [] },
  };
}

/** The action, built in the page and signed by the browser wallet. */
export function LocalFlow(p: LocalFlowProps) {
  const wallet = useWallet();
  const [phase, setPhase] = useState<LocalPhase>({ kind: 'form' });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const show = (next: LocalPhase) => {
    if (alive.current) setPhase(next);
  };

  async function build() {
    const from = wallet.account;
    const provider = injectedProvider();
    if (!from || !p.plan) return;
    if (!provider) {
      show({ kind: 'refused', problem: { text: stopWords(new WalletStop('no_wallet')), code: 'no_wallet' } });
      return;
    }
    show({ kind: 'building' });
    try {
      const plan = await p.plan(from);
      const first = plan.transactions[0];
      // The estimate goes through the wallet, so the wallet must be on the plan's network first.
      if (first) await walletOps(provider).ensureChain(first.chainId);
      const built = await estimatePlan(provider, from, plan);
      show({ kind: 'preview', built, problems: [...localProblems(built.transactions), ...(p.problems?.(built.transactions) ?? [])] });
    } catch (e) {
      const stop = e instanceof WalletStop ? e : null;
      show({ kind: 'refused', problem: stop ? { text: stopWords(stop), code: stop.kind } : { text: e instanceof Error ? e.message : 'The plan could not be built.' } });
    }
  }

  async function confirm(built: LocalBuilt) {
    let steps = freshSteps(built);
    const provider = injectedProvider();
    if (!provider) {
      show({ kind: 'stopped', built, steps, problem: { text: stopWords(new WalletStop('no_wallet')), code: 'no_wallet' } });
      return;
    }
    show({ kind: 'signing', built, steps });
    try {
      // A step that needed the one before it is estimated again now that it has mined.
      const regas = async (tx: UnsignedTx) => {
        const again = await estimatePlan(provider, built.from, { transactions: [tx], summary: '' });
        return again.transactions[0]!.simulated ? again.transactions[0]!.gas : null;
      };
      const hashes = await signAll(
        built,
        walletOps(provider),
        (i, step) => {
          steps = steps.map((s, j) => (j === i ? step : s));
          show({ kind: 'signing', built, steps });
        },
        undefined,
        regas,
      );
      show({ kind: 'reading', built, steps });
      const after = p.after ? await p.after(hashes, provider).catch(() => null) : null;
      show({ kind: 'done', built, steps, after });
    } catch (e) {
      const stop = e instanceof WalletStop ? e : new WalletStop('wallet', { said: e instanceof Error ? e.message : 'unknown error' });
      show({ kind: 'stopped', built, steps, problem: { text: stopWords(stop), code: stop.kind } });
    }
  }

  return (
    <LocalFlowView
      {...p}
      wallet={wallet}
      phase={phase}
      onConnect={() => void connectWallet()}
      onBuild={() => void build()}
      onConfirm={(b) => void confirm(b)}
      onBack={() => show({ kind: 'form' })}
    />
  );
}

export interface LocalFlowViewProps extends LocalFlowProps {
  wallet: WalletState;
  phase: LocalPhase;
  onConnect?: () => void;
  onBuild?: () => void;
  onConfirm?: (built: LocalBuilt) => void;
  onBack?: () => void;
}

/** What the action shows in each phase, with ActionFlow's pieces and words; no effects. */
export function LocalFlowView(v: LocalFlowViewProps) {
  const { phase, wallet } = v;
  const editing = phase.kind === 'form' || phase.kind === 'building' || phase.kind === 'refused';
  return (
    <section className="card act">
      <h2>{v.title}</h2>
      <Stages at={stageOf(phase)} />
      {v.intro && <p className="act-intro">{v.intro}</p>}
      <WalletLine wallet={wallet} onConnect={v.onConnect} />
      {editing && (
        <>
          {v.children}
          <div className="actions-row">
            <button type="button" disabled={!wallet.account || !v.plan || phase.kind === 'building'} onClick={v.onBuild}>
              {phase.kind === 'building' ? 'Estimating through your wallet…' : 'Show what this will do'}
            </button>
          </div>
          <p className="muted small">Nothing is signed yet. Your wallet may ask to switch to Hedera testnet so the fee can be estimated; the next screen shows the network and the fee, and your wallet signs only after you confirm.</p>
          {phase.kind === 'refused' && <ProblemLine problem={phase.problem} />}
        </>
      )}
      {phase.kind === 'preview' && (
        <>
          <PreviewView resp={phase.built} names={v.names} checkedBy="this page" />
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
            <button type="button" disabled={phase.problems.length > 0} onClick={() => v.onConfirm?.(phase.built)}>
              {phase.built.transactions.length > 1 ? `Confirm and sign ${phase.built.transactions.length} transactions` : 'Confirm and sign in your wallet'}
            </button>
            <button type="button" className="secondary" onClick={v.onBack}>
              Back
            </button>
          </div>
        </>
      )}
      {(phase.kind === 'signing' || phase.kind === 'reading' || phase.kind === 'done' || phase.kind === 'stopped') && (
        <>
          <StepsView resp={phase.built} steps={phase.steps} />
          {phase.kind === 'signing' && phase.built.transactions.length > 1 && <p className="muted small">Keep this page open until every step is mined.</p>}
          {phase.kind === 'reading' && <p className="muted">Mined. Reading the result back from the chain…</p>}
          {phase.kind === 'done' && (phase.after ?? <p className="muted">Mined. The pages here show the change once the status service reads it.</p>)}
          {phase.kind === 'stopped' && (
            <>
              <ProblemLine problem={phase.problem} />
              {phase.steps.some((s) => s.state === 'mined') && <p className="muted small">The steps marked mined are on chain; building again starts from the first step.</p>}
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
