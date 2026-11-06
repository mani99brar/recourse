// Signing a built action and reading the result back. The wallet signs each transaction in the
// order the API gave, each only after the one before it has mined, and only while the wallet is on
// the account the API built for. Then the API's readBack path is polled until it shows the change.
import type { Hash } from 'viem';
import { getApi } from './api.js';
import { readBackPath, readBackShows, sameAddress, isStale, type ActionResponse, type ReadBody, type UnsignedTx } from './actions.js';
import { WalletStop, type WalletOps } from './wallet.js';

export type StepState = 'waiting' | 'estimating' | 'chain' | 'sign' | 'mining' | 'mined' | 'failed';

/**
 * For a step the API could not simulate (it needs the step before it mined, as fileClaim needs its
 * approve): asks the API to build the action again now, and answers the gas it estimates for the
 * same call, or null when it has none.
 */
export type Regas = (tx: UnsignedTx) => Promise<string | null>;
export interface Step {
  state: StepState;
  hash: Hash | null;
}

export function freshSteps(resp: ActionResponse): Step[] {
  return resp.transactions.map(() => ({ state: 'waiting', hash: null }));
}

/**
 * Signs and sends every transaction, waiting for each receipt. Throws a WalletStop (with the hash
 * when one exists) at the first step that cannot go on; the steps before it stay sent.
 *
 * A step built with a fixed gas budget because it could not be simulated takes the API's estimate
 * once the steps before it have mined (`regas`), when that is at most the budget. Above the budget
 * the preview's fee no longer holds, so it stops there (`fee_changed`); with no estimate it keeps the
 * budget.
 */
export async function signAll(
  resp: ActionResponse,
  ops: WalletOps,
  on: (i: number, step: Step) => void,
  nowS: () => number = () => Date.now() / 1000,
  regas?: Regas,
): Promise<Hash[]> {
  // A passed deadline is the more useful thing to say, so it is checked before the preview's age.
  if (resp.notAfter !== null && nowS() > Number(resp.notAfter)) throw new WalletStop('too_late');
  if (isStale(resp, nowS())) throw new WalletStop('stale');
  const hashes: Hash[] = [];
  for (let i = 0; i < resp.transactions.length; i++) {
    let tx = resp.transactions[i]!;
    let hash: Hash | null = null;
    try {
      if (resp.notAfter !== null && nowS() > Number(resp.notAfter)) throw new WalletStop('too_late');
      if (!tx.simulated && i > 0 && regas) {
        on(i, { state: 'estimating', hash: null });
        const gas = await regas(tx).catch(() => null);
        if (gas !== null && /^[0-9]+$/.test(gas) && BigInt(gas) > 0n) {
          if (BigInt(gas) > BigInt(tx.gas)) throw new WalletStop('fee_changed', { gas, budget: tx.gas });
          tx = { ...tx, gas };
        }
      }
      on(i, { state: 'chain', hash: null });
      await ops.ensureChain(tx.chainId);
      const [account] = await ops.accounts();
      if (!account) throw new WalletStop('no_account');
      if (!sameAddress(account, resp.from)) throw new WalletStop('wrong_account', { need: resp.from, have: account });
      on(i, { state: 'sign', hash: null });
      hash = await ops.send(tx, resp.from);
      on(i, { state: 'mining', hash });
      const r = await ops.wait(tx.chainId, hash, (h) => {
        hash = h;
        on(i, { state: 'mining', hash: h });
      });
      hash = r.hash;
      if (r.status !== 'success') throw new WalletStop('reverted', { hash: r.hash, chainId: tx.chainId });
      on(i, { state: 'mined', hash: r.hash });
      hashes.push(r.hash);
    } catch (e) {
      on(i, { state: 'failed', hash });
      throw e instanceof WalletStop ? e : new WalletStop('wallet', { said: e instanceof Error ? e.message.split('\n')[0] : 'unknown error', ...(hash ? { hash } : {}) });
    }
  }
  return hashes;
}

export interface ReadBackResult {
  body: ReadBody | null;
  /** The read showed the change. False: it timed out first, and `body` is the last read, if any. */
  shows: boolean;
}

/**
 * Polls the answer's readBack path until it shows the sent transactions. A claim filed moments ago
 * answers 404 until the index reaches it, so a 404 is waited through like any other miss.
 */
export async function readBack(
  resp: ActionResponse,
  hashes: readonly string[],
  opts: { get?: (path: string) => Promise<ReadBody>; intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; alive?: () => boolean } = {},
): Promise<ReadBackResult> {
  const path = readBackPath(resp.readBack);
  if (!path) return { body: null, shows: false };
  const get = opts.get ?? ((p: string) => getApi<ReadBody>(p));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = opts.intervalMs ?? 3000;
  const tries = Math.max(1, Math.ceil((opts.timeoutMs ?? 180_000) / interval));
  let last: ReadBody | null = null;
  for (let i = 0; i < tries; i++) {
    if (opts.alive && !opts.alive()) break;
    try {
      const body = await get(path);
      last = body;
      if (readBackShows(resp, body, hashes)) return { body, shows: true };
    } catch {
      // A 404 before the index reaches a new claim, a 503 or a dropped connection: try again.
    }
    if (i < tries - 1) await sleep(interval);
  }
  return { body: last, shows: false };
}
