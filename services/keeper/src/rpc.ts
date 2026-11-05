// viem-backed JSON-RPC for the sender and for reads, plus revert decoding. Transport failures
// become TransientError; reverts become RevertError with the raw data when the node returns it.

import {
  BaseError,
  createPublicClient,
  decodeErrorResult,
  fallback,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type Transport,
} from 'viem';
import { knownErrorsAbi } from './abi.js';
import { TransientError } from './net.js';
import { RevertError, type FeeFields, type TxReceipt, type TxRpc } from './sender.js';

export interface ClientOptions {
  chainId: number;
  /** One or more RPC URLs; later ones are fallbacks. Empty strings are ignored. */
  urls: readonly string[];
  timeoutMs?: number;
}

export function makeClient(o: ClientOptions): PublicClient {
  const urls = o.urls.filter((u) => u !== '');
  if (urls.length === 0) throw new Error(`no RPC URL for chain ${o.chainId}`);
  const transports = urls.map((u) => http(u, { timeout: o.timeoutMs ?? 20_000, retryCount: 1 }));
  const transport: Transport = transports.length === 1 ? transports[0]! : fallback(transports);
  return createPublicClient({ transport, cacheTime: 0 }) as PublicClient;
}

const HEX_DATA = /^0x[0-9a-fA-F]*$/;

function findRevertData(err: unknown): Hex | undefined {
  let found: Hex | undefined;
  const visit = (e: unknown, depth: number) => {
    if (found !== undefined || depth > 8 || typeof e !== 'object' || e === null) return;
    const o = e as Record<string, unknown>;
    if (typeof o.data === 'string' && HEX_DATA.test(o.data) && o.data.length >= 10) {
      found = o.data as Hex;
      return;
    }
    if (typeof o.data === 'object' && o.data !== null) visit(o.data, depth + 1);
    visit(o.cause, depth + 1);
    visit(o.error, depth + 1);
  };
  visit(err, 0);
  return found;
}

function isRevert(err: unknown): boolean {
  if (findRevertData(err) !== undefined) return true;
  const text = err instanceof Error ? `${err.name} ${err.message} ${(err as BaseError).details ?? ''}` : String(err);
  return /revert|CONTRACT_REVERT_EXECUTED|execution reverted/i.test(text);
}

/** Maps a viem error to RevertError or TransientError. */
export function classifyRpcError(err: unknown): Error {
  if (isRevert(err)) return new RevertError(findRevertData(err), err instanceof Error ? err.message.split('\n')[0] : 'reverted');
  return new TransientError(err instanceof Error ? err.message.split('\n')[0]! : String(err));
}

export interface DecodedRevert {
  name: string;
  args: readonly unknown[];
}

/** Decodes revert data against the known custom errors; undefined when it matches none. */
export function decodeRevert(data: Hex | undefined, abi: Abi = knownErrorsAbi as unknown as Abi): DecodedRevert | undefined {
  if (data === undefined || data.length < 10) return undefined;
  try {
    const r = decodeErrorResult({ abi, data });
    return { name: r.errorName, args: (r.args ?? []) as readonly unknown[] };
  } catch {
    if (data.startsWith('0x08c379a0')) return { name: 'Error', args: [] };
    return undefined;
  }
}

export interface ViemTxRpcOptions {
  chainId: number;
  client: PublicClient;
  /** 'legacy' sends a gasPrice; 'eip1559' sends max fees from the latest base fee. */
  feeMode: 'legacy' | 'eip1559';
  /** Legacy gas price multiplier in basis points (default 11,000 = 1.1x). */
  gasPriceBps?: bigint;
}

export function viemTxRpc(o: ViemTxRpcOptions): TxRpc {
  const c = o.client;
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw classifyRpcError(err);
    }
  };
  return {
    chainId: o.chainId,
    async call(tx) {
      await wrap(() => c.call({ account: tx.from, to: tx.to, data: tx.data, value: tx.value }));
    },
    async estimateGas(tx) {
      return wrap(() => c.estimateGas({ account: tx.from, to: tx.to, data: tx.data, value: tx.value }));
    },
    async fees(): Promise<FeeFields> {
      if (o.feeMode === 'legacy') {
        const gp = await wrap(() => c.getGasPrice());
        return { type: 'legacy', gasPrice: (gp * (o.gasPriceBps ?? 11_000n)) / 10_000n };
      }
      const block = await wrap(() => c.getBlock({ blockTag: 'latest' }));
      const base = block.baseFeePerGas ?? (await wrap(() => c.getGasPrice()));
      const tip = 1_000_000n; // 0.001 gwei; Arbitrum ignores most of the tip
      return { type: 'eip1559', maxFeePerGas: base * 3n + tip, maxPriorityFeePerGas: tip };
    },
    async nonce(address: Address, tag) {
      return wrap(() => c.getTransactionCount({ address, blockTag: tag }));
    },
    async sendRaw(raw: Hex) {
      return wrap(() => c.sendRawTransaction({ serializedTransaction: raw }));
    },
    async receipt(hash: Hex): Promise<TxReceipt | null> {
      try {
        const r = await c.getTransactionReceipt({ hash });
        return { status: r.status, blockNumber: r.blockNumber };
      } catch (err) {
        if (err instanceof BaseError && err.name === 'TransactionReceiptNotFoundError') return null;
        throw classifyRpcError(err);
      }
    },
    async known(hash: Hex) {
      try {
        await c.getTransaction({ hash });
        return true;
      } catch (err) {
        if (err instanceof BaseError && err.name === 'TransactionNotFoundError') return false;
        throw classifyRpcError(err);
      }
    },
  };
}
