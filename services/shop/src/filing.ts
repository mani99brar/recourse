// Filing a claim on RecourseClaims from the shop's account.
//
// Never twice: the claim id is known before anything is sent (it is derived from the platform, the
// shop and the order nonce), every transaction is signed first and journaled with its raw bytes,
// and a retry reads the claim on chain and the journaled transaction before signing anything new.
// A restart resends the exact journaled bytes when their nonce is still unused, so at most one
// `fileClaim` can ever be mined per order.
//
// Local refusals come first: `net_loss_above_basket`, `no_order_record` (no ordered record in the
// refs). The caller checks the shop's own payment record (`not_paid`) before calling. `exit_due`:
// the platform's exit from the deposit vault is due, and the vault takes no new claim against it.
// `token_mismatch`: the vault holds a token other than the deployment's, so nothing is approved.

import {
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { RecordKind, ZERO_HASH, claimIdOf, orderIdOf, type RecordRefs } from '@recourse/shared';
import type { Journal, Logger } from '@recourse/records';
import type { ChainClients } from './chain.js';
import { explainRevert, revertOf, withErrorsOf } from './reverts.js';

export type FilingErrorCode =
  | 'net_loss_above_basket'
  | 'no_order_record'
  | 'zero_basket'
  | 'claim_id_mismatch'
  | 'approve_failed'
  | 'escrow_failed'
  | 'exit_due'
  | 'token_mismatch'
  | 'reverted'
  | 'tx_pending';

export class FilingError extends Error {
  constructor(
    readonly code: FilingErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'FilingError';
  }
}

export interface FileClaimInput {
  orderNonce: Hex;
  platform: Address;
  refs: RecordRefs;
  /** µUSDC actually settled for the order. */
  basketUsdc: bigint;
  /** µUSDC the shop claims; at most the basket. */
  netLossUsdc: bigint;
}

type Stamp = { at: string; claimId: Hex };

export type FilingJournalRow =
  | (Stamp & { type: 'signed'; step: 'approve' | 'file'; txHash: Hex; nonce: number; raw: Hex; orderId: Hex })
  | (Stamp & { type: 'mined'; step: 'approve' | 'file'; txHash: Hex; status: 'success' | 'reverted'; blockNumber: string })
  | (Stamp & { type: 'filed'; orderId: Hex; txHash: Hex | null; existing: boolean })
  | (Stamp & { type: 'stopped'; reason: string });

export interface Filed {
  claimId: Hex;
  orderId: Hex;
  txHash: Hex | null;
  /** True when the claim was already on chain (filed earlier, possibly by another run). */
  existing: boolean;
}

export interface ClaimFilerDeps {
  clients: ChainClients;
  claims: Address;
  vault: Address;
  /** The deployment's vault token (`HederaDeployment.usdc`); checked against `vault.usdc()`. */
  usdc: Address;
  claimsAbi: Abi;
  /** The vault's ABI, so reverts raised in the fee escrow (`ExitDue`, say) decode by name. */
  vaultAbi?: Abi;
  journal: Journal<FilingJournalRow>;
  log?: Logger;
  /** Receipt wait per transaction, ms. */
  receiptTimeoutMs?: number;
}

const VAULT_TOKEN_ABI = parseAbi(['function usdc() view returns (address)']);
const GAS_MARGIN_NUM = 13n;
const GAS_MARGIN_DEN = 10n;

export class ClaimFiler {
  private readonly rows: FilingJournalRow[];
  private readonly simulateAbi: Abi;

  constructor(private readonly deps: ClaimFilerDeps) {
    this.rows = [...deps.journal.rows()];
    this.simulateAbi = deps.vaultAbi ? withErrorsOf(deps.claimsAbi, deps.vaultAbi) : deps.claimsAbi;
  }

  private write(row: FilingJournalRow): void {
    this.deps.journal.append(row);
    this.rows.push(row);
  }

  private get shop(): Address {
    return this.deps.clients.account.address;
  }

  /** The claim id this shop's claim for the order will have, from the chain id the RPC reports. */
  async claimIdFor(platform: Address, orderNonce: Hex): Promise<{ claimId: Hex; orderId: Hex }> {
    const chainId = await this.deps.clients.publicClient.getChainId();
    const orderId = orderIdOf(platform, this.shop, orderNonce);
    return { orderId, claimId: claimIdOf(BigInt(chainId), this.deps.claims, orderId) };
  }

  /** `getClaim(claimId).status`, 0 when there is none. */
  async statusOf(claimId: Hex): Promise<number> {
    const claim = (await this.deps.clients.publicClient.readContract({
      address: this.deps.claims,
      abi: this.deps.claimsAbi,
      functionName: 'getClaim',
      args: [claimId],
    })) as { status: number };
    return Number(claim.status);
  }

  async courtFee(): Promise<bigint> {
    const p = (await this.deps.clients.publicClient.readContract({
      address: this.deps.claims,
      abi: this.deps.claimsAbi,
      functionName: 'params',
    })) as { courtFeeUsdc: bigint };
    return p.courtFeeUsdc;
  }

  async fileClaim(input: FileClaimInput): Promise<Filed> {
    if (input.basketUsdc <= 0n) throw new FilingError('zero_basket', 'the basket must be above zero');
    if (input.netLossUsdc > input.basketUsdc) {
      throw new FilingError('net_loss_above_basket', `net loss ${input.netLossUsdc} is above the basket ${input.basketUsdc}`);
    }
    if (input.refs.hashes[RecordKind.Ordered] === ZERO_HASH) {
      throw new FilingError('no_order_record', 'the refs hold no ordered record');
    }
    const { claimId, orderId } = await this.claimIdFor(input.platform, input.orderNonce);
    const onChain = (await this.deps.clients.publicClient.readContract({
      address: this.deps.claims,
      abi: this.deps.claimsAbi,
      functionName: 'claimIdFor',
      args: [input.platform, this.shop, input.orderNonce],
    })) as Hex;
    if (onChain.toLowerCase() !== claimId) {
      throw new FilingError('claim_id_mismatch', `contract derives ${onChain}, expected ${claimId}`);
    }

    const done = this.rows.find((r) => r.claimId === claimId && r.type === 'filed');
    if (done && done.type === 'filed') return { claimId, orderId, txHash: done.txHash, existing: done.existing };

    // A file transaction from an earlier run: settle it before anything else.
    const pendingFile = this.lastSigned(claimId, 'file');
    if (pendingFile) {
      const receipt = await this.settleSigned(pendingFile);
      if (receipt?.status === 'success') return this.markFiled(claimId, orderId, receipt.transactionHash, receipt);
    }
    if ((await this.statusOf(claimId)) !== 0) return this.markFiled(claimId, orderId, null, null);
    await this.refuseIfExitDue(input.platform);

    // Exact allowance for the court fee, never unlimited, and only on the token the vault holds.
    const held = await this.deps.clients.publicClient.readContract({ address: this.deps.vault, abi: VAULT_TOKEN_ABI, functionName: 'usdc' });
    if (getAddress(held) !== getAddress(this.deps.usdc)) {
      throw new FilingError('token_mismatch', `the vault holds ${getAddress(held)}, the deployment names ${getAddress(this.deps.usdc)}`);
    }
    const fee = await this.courtFee();
    const allowance = await this.deps.clients.publicClient.readContract({
      address: this.deps.usdc,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [this.shop, this.deps.vault],
    });
    if (allowance < fee) {
      const pendingApprove = this.lastSigned(claimId, 'approve');
      let receipt = pendingApprove ? await this.settleSigned(pendingApprove) : null;
      if (receipt?.status !== 'success') {
        const signed = await this.sign(claimId, orderId, 'approve', {
          to: this.deps.usdc,
          abi: erc20Abi as Abi,
          functionName: 'approve',
          args: [this.deps.vault, fee],
        });
        receipt = await this.send(signed);
      }
      if (receipt.status !== 'success') {
        this.stop(claimId, `approve(vault, ${fee}) reverted in ${receipt.transactionHash}`);
        throw new FilingError('approve_failed', `approve reverted: ${receipt.transactionHash}`);
      }
    }

    const call = {
      to: this.deps.claims,
      abi: this.deps.claimsAbi,
      functionName: 'fileClaim',
      args: [input.orderNonce, input.platform, input.refs, input.basketUsdc, input.netLossUsdc],
    } as const;
    try {
      await this.deps.clients.publicClient.simulateContract({
        address: call.to,
        abi: this.simulateAbi,
        functionName: call.functionName,
        args: [...call.args],
        account: this.shop,
      });
    } catch (error) {
      const revert = revertOf(error);
      const name = revert?.name ?? null;
      if (name === 'ClaimExists') return this.markFiled(claimId, orderId, null, null);
      if (revert && name === 'ExitDue') throw new FilingError('exit_due', explainRevert(revert));
      if (revert && (name === 'TransferFailed' || name === 'EscrowExists' || name === 'NotAssociatedYet')) {
        this.stop(claimId, `fee escrow refused: ${explainRevert(revert)}`);
        throw new FilingError('escrow_failed', `fee escrow refused: ${explainRevert(revert)}`);
      }
      if (name === 'NetLossAboveBasket') throw new FilingError('net_loss_above_basket', 'refused by the contract');
      if (name === 'MissingOrdered') throw new FilingError('no_order_record', 'refused by the contract');
      throw new FilingError('reverted', `fileClaim would revert: ${revert ? explainRevert(revert) : error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
    }
    const signed = await this.sign(claimId, orderId, 'file', call);
    const receipt = await this.send(signed);
    if (receipt.status !== 'success') {
      // Lost a race with another run, or the state moved: the claim view decides.
      if ((await this.statusOf(claimId)) !== 0) return this.markFiled(claimId, orderId, null, null);
      this.stop(claimId, `fileClaim reverted in ${receipt.transactionHash}`);
      throw new FilingError('reverted', `fileClaim reverted: ${receipt.transactionHash}`);
    }
    return this.markFiled(claimId, orderId, receipt.transactionHash, receipt);
  }

  /**
   * The vault refuses the fee escrow once the platform's requested exit is due; checking first
   * saves an approve that could never be used. Needs the vault ABI; without it the simulate below
   * still refuses.
   */
  private async refuseIfExitDue(platform: Address): Promise<void> {
    if (!this.deps.vaultAbi) return;
    const { publicClient } = this.deps.clients;
    const [requestedAt, params, block] = await Promise.all([
      publicClient.readContract({ address: this.deps.vault, abi: this.deps.vaultAbi, functionName: 'exitRequestedAt', args: [platform] }) as Promise<bigint>,
      publicClient.readContract({ address: this.deps.vault, abi: this.deps.vaultAbi, functionName: 'params' }) as Promise<readonly [bigint, bigint, bigint]>,
      publicClient.getBlock({ blockTag: 'latest' }),
    ]);
    if (requestedAt !== 0n && block.timestamp >= requestedAt + params[1]) {
      throw new FilingError('exit_due', explainRevert({ name: 'ExitDue', args: [] }));
    }
  }

  private lastSigned(claimId: Hex, step: 'approve' | 'file') {
    const rows = this.rows.filter(
      (r): r is Extract<FilingJournalRow, { type: 'signed' }> => r.type === 'signed' && r.claimId === claimId && r.step === step,
    );
    return rows.at(-1) ?? null;
  }

  private stop(claimId: Hex, reason: string): void {
    this.write({ type: 'stopped', at: new Date().toISOString(), claimId, reason });
    this.deps.log?.error('filing_stopped', { claimId, reason });
  }

  private async sign(
    claimId: Hex,
    orderId: Hex,
    step: 'approve' | 'file',
    call: { to: Address; abi: Abi; functionName: string; args: readonly unknown[] },
  ): Promise<Extract<FilingJournalRow, { type: 'signed' }>> {
    const { publicClient, walletClient, account, chain, hedera } = this.deps.clients;
    const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args });
    const estimate = await publicClient.estimateGas({ account: account.address, to: call.to, data });
    const gas = hedera ? (estimate * GAS_MARGIN_NUM) / GAS_MARGIN_DEN : estimate + estimate / 5n;
    const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
    const gasPrice = await publicClient.getGasPrice();
    const raw = await walletClient.signTransaction({
      account,
      chain,
      to: call.to,
      data,
      gas,
      gasPrice,
      nonce,
      type: 'legacy',
    });
    const row = {
      type: 'signed' as const,
      at: new Date().toISOString(),
      claimId,
      orderId,
      step,
      txHash: keccak256(raw),
      nonce,
      raw,
    };
    this.write(row);
    return row;
  }

  /** Broadcasts journaled bytes (again, if need be) and waits for the receipt. */
  private async send(signed: Extract<FilingJournalRow, { type: 'signed' }>): Promise<TransactionReceipt> {
    const { publicClient } = this.deps.clients;
    try {
      await publicClient.sendRawTransaction({ serializedTransaction: signed.raw });
    } catch (error) {
      // Already known to the node, or already mined: the receipt below answers either way.
      this.deps.log?.warn('send_raw_failed', { txHash: signed.txHash, error: error instanceof Error ? error.message.slice(0, 200) : String(error) });
    }
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: signed.txHash,
      timeout: this.deps.receiptTimeoutMs ?? 120_000,
    });
    this.write({
      type: 'mined',
      at: new Date().toISOString(),
      claimId: signed.claimId,
      step: signed.step,
      txHash: signed.txHash,
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString(),
    });
    return receipt;
  }

  /**
   * What became of a journaled transaction: its receipt when mined; resent and awaited when its
   * nonce is still unused; null when that nonce went to another transaction (it can never mine).
   */
  private async settleSigned(signed: Extract<FilingJournalRow, { type: 'signed' }>): Promise<TransactionReceipt | null> {
    const { publicClient, account } = this.deps.clients;
    const receipt = await publicClient.getTransactionReceipt({ hash: signed.txHash }).catch(() => null);
    if (receipt) return receipt;
    const used = await publicClient.getTransactionCount({ address: account.address, blockTag: 'latest' });
    if (used > signed.nonce) return null;
    return this.send(signed);
  }

  private markFiled(claimId: Hex, orderId: Hex, txHash: Hex | null, receipt: TransactionReceipt | null): Filed {
    if (receipt) {
      const event = receipt.logs
        .filter((l) => l.address.toLowerCase() === this.deps.claims.toLowerCase())
        .map((l) => {
          try {
            return decodeEventLog({ abi: this.deps.claimsAbi, data: l.data, topics: l.topics });
          } catch {
            return null;
          }
        })
        .find((e) => e?.eventName === 'ClaimFiled');
      const emitted = (event?.args as { claimId?: Hex } | undefined)?.claimId;
      if (!emitted || emitted.toLowerCase() !== claimId) {
        throw new FilingError('claim_id_mismatch', `ClaimFiled carries ${emitted ?? 'nothing'}, expected ${claimId}`);
      }
    }
    const existing = receipt === null;
    this.write({ type: 'filed', at: new Date().toISOString(), claimId, orderId, txHash, existing });
    this.deps.log?.info('claim_filed', { claimId, orderId, txHash, existing });
    return { claimId, orderId, txHash, existing };
  }
}
