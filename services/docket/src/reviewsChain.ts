// The ReviewChain port over viem, for the Hedera JSON-RPC relay and the mirror node.

import { addressBook, erc8004IdentityAbi, erc8004ReputationAbi } from '@recourse/shared';
import {
  BaseError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  type Address,
  type Hex,
  type Transport,
} from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import type { FetchLike } from './sources.js';
import type { FeedbackArgs, ReviewChain, SimResult } from './reviews.js';
import { feedbackCalldata } from './reviews.js';

export interface ViemReviewChainOptions {
  account: PrivateKeyAccount;
  transport?: Transport;
  rpcUrl?: string;
  mirrorUrl: string;
  reputation?: Address;
  identity?: Address;
  fetch?: FetchLike;
  /** Receipt wait before a send counts as timed out. */
  timeoutMs?: number;
}

/** How far before a review's first try the registry logs are read, for clock skew. */
const EXISTING_MARGIN_S = 3600;
/** Pages of registry logs read per lookup; a lookup that needs more fails rather than miss a review. */
const EXISTING_MAX_PAGES = 50;

/** The contract reverted, as against a request that failed (timeout, rate limit, HTTP error). */
function isRevert(error: unknown): boolean {
  return error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ExecutionRevertedError) !== null;
}

export function viemReviewChain(o: ViemReviewChainOptions): ReviewChain {
  const transport = o.transport ?? http(o.rpcUrl);
  const reputation = o.reputation ?? addressBook.hedera.erc8004Reputation;
  const identity = o.identity ?? addressBook.hedera.erc8004Identity;
  const chain = { id: addressBook.hedera.chainId, name: 'hedera-testnet', nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 }, rpcUrls: { default: { http: [o.rpcUrl ?? ''] } } } as const;
  const pub = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ chain, transport, account: o.account });
  const fetcher = o.fetch ?? ((url, init) => fetch(url, init));

  return {
    schemeAddress: o.account.address,

    async ownerOf(agentId) {
      try {
        return await pub.readContract({ address: identity, abi: erc8004IdentityAbi, functionName: 'ownerOf', args: [agentId] });
      } catch (error) {
        if (isRevert(error)) return null; // an unregistered id reverts
        throw error;
      }
    },

    async simulate(from, args): Promise<SimResult> {
      try {
        await pub.call({ account: from, to: reputation, data: feedbackCalldata(args) });
        return { ok: true };
      } catch (error) {
        if (!isRevert(error)) throw error;
        const text = error instanceof Error ? `${error.message} ${(error as { details?: string }).details ?? ''}` : String(error);
        return { ok: false, reason: text };
      }
    },

    async send(args, onSent) {
      const hash = await wallet.writeContract({
        address: reputation,
        abi: erc8004ReputationAbi,
        functionName: 'giveFeedback',
        args: [args.agentId, args.value, args.valueDecimals, args.tag1, args.tag2, args.endpoint, args.feedbackURI, args.feedbackHash],
        chain,
      });
      onSent?.(hash);
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: o.timeoutMs ?? 60_000 });
      if (receipt.status !== 'success') throw new Error('review transaction reverted');
      return { txHash: hash };
    },

    async receipt(txHash) {
      try {
        const r = await pub.getTransactionReceipt({ hash: txHash as Hex });
        return r.status === 'success' ? 'success' : 'reverted';
      } catch (error) {
        if (error instanceof BaseError && error.walk((e) => e instanceof TransactionReceiptNotFoundError) !== null) return null;
        throw error;
      }
    },

    async existing(agentId: bigint, feedbackHash: Hex, since: number) {
      // Mirror node logs of the shared registry from just before the review's first try, matched
      // to our wallet as the client address. The mirror filters by topic only over a range under
      // 7 days, so the logs are read unfiltered.
      const root = o.mirrorUrl.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
      let next: string | null = `/api/v1/contracts/${reputation}/results/logs?order=asc&limit=100&timestamp=gte:${Math.max(0, Math.floor(since) - EXISTING_MARGIN_S)}`;
      for (let page = 0; next !== null && page < EXISTING_MAX_PAGES; page++) {
        const res: Response = await fetcher(`${root}${next}`);
        if (!res.ok) throw new Error(`mirror node answered ${res.status}`);
        const body = (await res.json()) as { logs?: { topics: string[]; data: string; transaction_hash: string }[]; links?: { next?: string | null } };
        for (const log of body.logs ?? []) {
          try {
            const ev = decodeEventLog({ abi: erc8004ReputationAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
            if (ev.eventName !== 'NewFeedback') continue;
            const a = ev.args;
            if (a.agentId === agentId && a.clientAddress.toLowerCase() === o.account.address.toLowerCase() && a.feedbackHash === feedbackHash) {
              return { txHash: log.transaction_hash };
            }
          } catch {
            /* not a NewFeedback log */
          }
        }
        next = body.links?.next ?? null;
      }
      if (next !== null) throw new Error(`registry logs since the first try run past ${EXISTING_MAX_PAGES} pages; not sending again blind`);
      return null;
    },
  };
}
