// The browser's own wallet (the injected EIP-1193 provider, window.ethereum), through viem. The page
// never sees a key: it asks the wallet for the account, the network and a signature, and reads
// receipts through the wallet's own connection. Nothing here runs at import or during a server render,
// so every read-only page works with no wallet at all.
import { useSyncExternalStore } from 'react';
import { createPublicClient, createWalletClient, custom, getAddress, type Address, type EIP1193Provider, type Hash } from 'viem';
import { CHAINS, chainLabel } from './chains.js';
import type { UnsignedTx } from './actions.js';

/** The injected provider, or null (no wallet, or not in a browser). */
export function injectedProvider(): EIP1193Provider | null {
  if (typeof window === 'undefined') return null;
  const p = (window as unknown as { ethereum?: unknown }).ethereum;
  return p && typeof (p as { request?: unknown }).request === 'function' ? (p as EIP1193Provider) : null;
}

/** Why a wallet step stopped. `rejected`: the person said no in the wallet. */
export class WalletStop extends Error {
  constructor(
    readonly kind: 'no_wallet' | 'no_account' | 'rejected' | 'wrong_chain' | 'wrong_account' | 'reverted' | 'timeout' | 'wallet' | 'too_late' | 'stale',
    readonly facts: { need?: string; have?: string; hash?: Hash; chainId?: number; said?: string } = {},
  ) {
    super(kind);
  }
}

type Chained = { code?: unknown; name?: unknown; cause?: unknown; data?: { originalError?: unknown } } | undefined;

/** True when anything in the error's chain matches (viem wraps the wallet's own error, sometimes twice). */
function inChain(e: unknown, hit: (x: NonNullable<Chained>) => boolean): boolean {
  for (let x = e as Chained, i = 0; x && i < 8; i++) {
    if (hit(x)) return true;
    const orig = x.data?.originalError as Chained;
    if (orig && hit(orig)) return true;
    x = x.cause as Chained;
  }
  return false;
}

export function hasCode(e: unknown, code: number): boolean {
  return inChain(e, (x) => x.code === code);
}

function hasName(e: unknown, name: string): boolean {
  return inChain(e, (x) => x.name === name);
}

function shortSaid(e: unknown): string {
  const m = (e as { shortMessage?: unknown; message?: unknown } | null)?.shortMessage ?? (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? m.split('\n')[0]!.slice(0, 200) : 'unknown error';
}

/** A wallet error as a stop: a refusal (4001) is `rejected`; anything else keeps the wallet's first line. */
export function stopFrom(e: unknown): WalletStop {
  if (e instanceof WalletStop) return e;
  if (hasCode(e, 4001) || hasName(e, 'UserRejectedRequestError')) return new WalletStop('rejected');
  if (hasName(e, 'ChainMismatchError')) return new WalletStop('wrong_chain');
  return new WalletStop('wallet', { said: shortSaid(e) });
}

export interface Receipt {
  status: 'success' | 'reverted';
  hash: Hash;
}

export interface WalletOps {
  /** The accounts the wallet already shares with the page; no prompt. */
  accounts(): Promise<Address[]>;
  /** Asks the person to connect. */
  connect(): Promise<Address[]>;
  chainId(): Promise<number>;
  /** Switches the wallet to the network, adding it first if the wallet does not know it. */
  ensureChain(id: number): Promise<void>;
  /** Sends one built transaction from `from`: target, data, value and gas limit as built; the wallet sets the fee. */
  send(tx: UnsignedTx, from: Address): Promise<Hash>;
  /** Waits for the receipt, through the wallet's connection to that network. `onHash` hears a sped-up replacement. */
  wait(chainId: number, hash: Hash, onHash?: (h: Hash) => void): Promise<Receipt>;
}

export function walletOps(provider: EIP1193Provider, opts: { receiptTimeoutMs?: number; pollMs?: number } = {}): WalletOps {
  // A wallet prompt is never retried: a second prompt after a refusal would be wrong.
  const transport = custom(provider, { retryCount: 0 });
  const wallet = createWalletClient({ transport });
  const chainId = async () => wallet.getChainId();
  return {
    async accounts() {
      return ((await provider.request({ method: 'eth_accounts' })) as string[]).map((a) => getAddress(a));
    },
    async connect() {
      try {
        return await wallet.requestAddresses();
      } catch (e) {
        throw stopFrom(e);
      }
    },
    chainId,
    async ensureChain(id) {
      const chain = CHAINS[id];
      if (!chain) throw new WalletStop('wrong_chain', { chainId: id });
      try {
        if ((await chainId()) === id) return;
        try {
          await wallet.switchChain({ id });
        } catch (e) {
          // 4902: the wallet does not know the network yet. Add it (which most wallets also switch to).
          if (!hasCode(e, 4902)) throw e;
          await wallet.addChain({ chain });
          if ((await chainId()) !== id) await wallet.switchChain({ id });
        }
      } catch (e) {
        const stop = stopFrom(e);
        throw stop.kind === 'rejected' ? stop : new WalletStop('wrong_chain', { chainId: id, said: stop.facts.said });
      }
      const now = await chainId();
      if (now !== id) throw new WalletStop('wrong_chain', { chainId: id, have: String(now) });
    },
    async send(tx, from) {
      try {
        // viem checks the wallet is on tx.chainId first (ChainMismatchError otherwise).
        return await wallet.sendTransaction({
          account: from,
          chain: CHAINS[tx.chainId] ?? null,
          to: tx.to,
          data: tx.data,
          value: BigInt(tx.value),
          gas: BigInt(tx.gas),
        });
      } catch (e) {
        const stop = stopFrom(e);
        throw stop.kind === 'wrong_chain' ? new WalletStop('wrong_chain', { chainId: tx.chainId }) : stop;
      }
    },
    async wait(id, hash, onHash) {
      const client = createPublicClient({ chain: CHAINS[id], transport, pollingInterval: opts.pollMs ?? 2000 });
      try {
        const r = await client.waitForTransactionReceipt({
          hash,
          timeout: opts.receiptTimeoutMs ?? 180_000,
          onReplaced: (x) => onHash?.(x.transaction.hash),
        });
        return { status: r.status, hash: r.transactionHash };
      } catch (e) {
        if (hasName(e, 'WaitForTransactionReceiptTimeoutError')) throw new WalletStop('timeout', { hash, chainId: id });
        throw stopFrom(e);
      }
    },
  };
}

// ---- the page-wide wallet state, for the header and every action panel ----

export interface WalletState {
  available: boolean;
  account: Address | null;
  chainId: number | null;
  connecting: boolean;
  error: string | null;
}

export const NO_WALLET: WalletState = Object.freeze({ available: false, account: null, chainId: null, connecting: false, error: null });

let state: WalletState = NO_WALLET;
let started = false;
const listeners = new Set<() => void>();

function set(next: Partial<WalletState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function start(): void {
  if (started) return;
  started = true;
  const p = injectedProvider();
  if (!p) return;
  set({ available: true });
  const ops = walletOps(p);
  void ops.accounts().then((a) => set({ account: a[0] ?? null }), () => undefined);
  void ops.chainId().then((id) => set({ chainId: id }), () => undefined);
  p.on?.('accountsChanged', (a: readonly string[]) => {
    try {
      set({ account: a[0] ? getAddress(a[0]) : null });
    } catch {
      set({ account: null });
    }
  });
  p.on?.('chainChanged', (id: string) => set({ chainId: Number(id) }));
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  start();
  return () => listeners.delete(l);
}

/** The wallet as the page sees it. A server render, or a browser with no wallet, gets NO_WALLET. */
export function useWallet(): WalletState {
  return useSyncExternalStore(subscribe, () => state, () => NO_WALLET);
}

export async function connectWallet(): Promise<void> {
  const p = injectedProvider();
  if (!p) return;
  set({ connecting: true, error: null });
  try {
    const ops = walletOps(p);
    const a = await ops.connect();
    set({ account: a[0] ?? null, chainId: await ops.chainId(), connecting: false });
  } catch (e) {
    const stop = stopFrom(e);
    set({ connecting: false, error: stop.kind === 'rejected' ? 'You declined the connection in your wallet.' : `The wallet did not connect: ${stop.facts.said ?? stop.kind}.` });
  }
}

/** A stop in words, for the step that hit it. */
export function stopWords(s: WalletStop): string {
  switch (s.kind) {
    case 'no_wallet':
      return 'No browser wallet was found. Reading works without one; to sign, use a browser with a wallet that supports Hedera testnet and Arbitrum Sepolia.';
    case 'no_account':
      return 'Connect your wallet first.';
    case 'rejected':
      return 'You declined in your wallet, so nothing was sent for this step.';
    case 'wrong_chain':
      return `Your wallet is not on ${s.facts.chainId ? chainLabel(s.facts.chainId) : 'the network this step needs'}${s.facts.have ? ` (it is on chain ${s.facts.have})` : ''}. Switch it in your wallet and try again.${s.facts.said ? ` The wallet said: ${s.facts.said}` : ''}`;
    case 'wrong_account':
      return `This was built for ${s.facts.need}, but your wallet is now on ${s.facts.have ?? 'no account'}. Switch back to ${s.facts.need} in your wallet, or build it again for the new account.`;
    case 'reverted':
      return 'The transaction failed on chain (it reverted). Nothing after it was sent.';
    case 'timeout':
      return 'The transaction was sent, but no receipt came within three minutes. Look it up on the explorer; the claim page updates on its own once it mines.';
    case 'too_late':
      return 'The deadline for this call has passed, so it would fail. Build it again to see where the claim stands.';
    case 'stale':
      return 'This preview is more than five minutes old. Build it again so the amounts and fees are current.';
    default:
      return `Your wallet stopped the request: ${s.facts.said ?? 'no reason given'}.`;
  }
}
