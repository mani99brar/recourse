// Sends `recordPreCheck` for one claim, once. Before a send it reads the claim on chain; it never
// sends for a claim that has left Filed, and it never sends a second time while an earlier
// transaction of ours for the claim is open or has succeeded. The keeper's Sender journals the
// signed bytes before broadcast, so a restart rebroadcasts the same transaction.

import {
  claimsAbi,
  classifyRpcError,
  decodeRevert,
  isTransient,
  TransientError,
  type Alerter,
  type JournalRecord,
  type Sender,
} from '@recourse/keeper';
import { ClaimStatus, isSendPaused, type SendPauseWindow } from '@recourse/shared';
import { encodeFunctionData, type Address, type Hex, type PublicClient } from 'viem';
import type { Clock } from './clock.js';
import type { DocStore } from './docs.js';

export interface ChainClaim {
  status: number;
  packHash: Hex;
}

/** The one chain read the writer needs. */
export interface ClaimsChain {
  getClaim(claimId: Hex): Promise<ChainClaim>;
}

export function viemClaimsChain(client: PublicClient, claims: Address): ClaimsChain {
  return {
    async getClaim(claimId) {
      try {
        const c = await client.readContract({ address: claims, abi: claimsAbi, functionName: 'getClaim', args: [claimId] });
        return { status: c.status, packHash: c.packHash };
      } catch (err) {
        const e = classifyRpcError(err);
        throw isTransient(e) ? e : new TransientError(e.message);
      }
    },
  };
}

type IntentState = 'open' | 'success' | 'reverted' | 'superseded';

export interface WriteRequest {
  claimId: Hex;
  gap: number;
  answer: number;
  packHash: Hex;
  /** The pinned document: it must read back from its CID before a send. Not needed in a dry run. */
  doc?: { cid: string; bytes: Uint8Array };
}

export type WriteResult =
  | { kind: 'waiting'; why: string }
  | { kind: 'sent'; hash: Hex }
  | { kind: 'dry' }
  | { kind: 'conflict'; onchain: Hex }
  | { kind: 'closed'; status: number };

export interface RecordWriterOptions {
  sender: Sender;
  chain: ClaimsChain;
  claims: Address;
  docs: DocStore;
  alerter: Alerter;
  windows: readonly SendPauseWindow[];
  clock: Clock;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

const ZERO = /^0x0{64}$/;

export class RecordWriter {
  private readonly intents = new Map<string, { id: string; state: IntentState }>();
  private readonly verified = new Set<string>();

  constructor(private readonly o: RecordWriterOptions) {}

  /** Follows the sender's journal records (call it on replay and on every append). */
  observe(rec: JournalRecord): void {
    if (rec.t === 'intent' && rec.call === 'recordPreCheck' && typeof rec.claimId === 'string' && typeof rec.id === 'string') {
      this.intents.set(rec.claimId.toLowerCase(), { id: rec.id, state: 'open' });
    } else if (rec.t === 'result' && typeof rec.id === 'string') {
      for (const entry of this.intents.values()) {
        if (entry.id === rec.id && (rec.outcome === 'success' || rec.outcome === 'reverted' || rec.outcome === 'superseded')) {
          entry.state = rec.outcome;
        }
      }
    }
  }

  /** True when a transaction of ours for the claim is open or has succeeded. */
  hasIntent(claimId: Hex): boolean {
    return this.intents.has(claimId.toLowerCase());
  }

  async write(req: WriteRequest): Promise<WriteResult> {
    const mine = this.intents.get(req.claimId.toLowerCase());
    if (mine?.state === 'open') return { kind: 'waiting', why: 'a transaction for this claim is still open' };
    if (mine?.state === 'success') return { kind: 'waiting', why: 'sent; waiting for PreCheckRecorded on the mirror' };

    const onchain = await this.o.chain.getClaim(req.claimId);
    if (onchain.status === ClaimStatus.None) throw new TransientError('the claim is not visible on the rpc yet');
    if (onchain.status !== ClaimStatus.Filed) {
      if (onchain.packHash.toLowerCase() === req.packHash.toLowerCase()) {
        return { kind: 'waiting', why: 'recorded on chain; waiting for PreCheckRecorded on the mirror' };
      }
      if (ZERO.test(onchain.packHash)) return { kind: 'closed', status: onchain.status };
      return { kind: 'conflict', onchain: onchain.packHash };
    }

    if (isSendPaused(this.o.windows, 'hedera', Math.floor(this.o.clock.now() / 1000))) {
      return { kind: 'waiting', why: 'sends are paused' };
    }
    if (this.o.sender.openIntents().length > 0) return { kind: 'waiting', why: 'another transaction is open' };

    if (!this.o.sender.dryRun) {
      if (req.doc === undefined) throw new Error('write: a send needs the pinned document');
      const key = `${req.doc.cid}:${req.packHash}`;
      if (!this.verified.has(key)) {
        const back = await this.o.docs.fetch(req.doc.cid, { fresh: true });
        if (back === null || !same(back, req.doc.bytes)) {
          throw new TransientError(`the pinned document does not read back from ${req.doc.cid} yet`);
        }
        this.verified.add(key);
      }
    }

    const data = encodeFunctionData({
      abi: claimsAbi,
      functionName: 'recordPreCheck',
      args: [req.claimId, req.gap, req.answer, req.packHash],
    });
    const out = await this.o.sender.send({ to: this.o.claims, data, call: 'recordPreCheck', claimId: req.claimId });
    switch (out.kind) {
      case 'dry':
        return { kind: 'dry' };
      case 'busy':
        return { kind: 'waiting', why: 'another transaction is open' };
      case 'pending':
        return { kind: 'sent', hash: out.hash };
      case 'rejected':
        this.failed(req.claimId, `simulation reverted: ${decodeRevert(out.revertData)?.name ?? out.message}`);
        throw new TransientError('recordPreCheck would revert; will look again');
      case 'mined':
        if (out.status === 'success') return { kind: 'sent', hash: out.hash };
        this.failed(req.claimId, `transaction reverted: ${decodeRevert(out.revertData)?.name ?? 'unknown'}`);
        throw new TransientError('recordPreCheck reverted; will look again');
    }
  }

  private failed(claimId: Hex, detail: string): void {
    this.o.alerter.raise({
      kind: 'call_failed',
      claimId,
      state: 'precheck',
      hint: 'recordPreCheck did not go through; the claim is read again before any retry',
      detail: { call: 'recordPreCheck', problem: detail },
    });
  }
}
