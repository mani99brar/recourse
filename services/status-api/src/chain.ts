// Chain reads and simulation for the /v1 actions. `ActionReads` is the seam the tests replace;
// `ViemActionReads` is the real one, over the same JSON-RPC endpoints the live reads use. Every
// read and every simulation runs against the latest block, as the signer's transaction will.
//
// A revert and an RPC fault are told apart from the node's error body, never from the client
// library's error class alone: code 3, or "revert" in the node's message or data, is a revert
// (its data may be hex, "0x" or missing); a VM abort word also counts as a revert with no data;
// anything else (HTTP, socket, timeout, rate limit, an unknown body) is the RPC being unavailable.

import { createPublicClient, fallback, http, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { CASE_ABI, CLAIMS_ABI, TOKEN_ABI, VAULT_ABI } from './abi/deployed.js';
import { klerosAbi } from './abi/outside.js';

export type ChainName = 'hedera' | 'arbitrum';

export interface EvmTx {
  from: Address;
  to: Address;
  data: Hex;
  value?: bigint;
}

/** One simulated transaction: its gas estimate, or the revert bytes (null when the node gave none). */
export type SimResult = { ok: true; gas: bigint } | { ok: false; data: Hex | null };

/** The claim as `RecourseClaims.getClaim` returns it. */
export interface ChainClaim {
  orderId: Hex;
  shop: Address;
  platform: Address;
  basketUsdc: bigint;
  netLossUsdc: bigint;
  filedAt: bigint;
  preCheckedAt: bigint;
  gap: number;
  answer: number;
  packHash: Hex;
  contestedBy: Address;
  sendCount: number;
  lastSendAt: bigint;
  lastMessageId: Hex;
  disputeId: bigint;
  ruling: number;
  attempts: number;
  status: number;
}

/** `RecourseClaims.claimTermsOf`: fixed at filing; all zero for an unknown claim. */
export interface ClaimTerms {
  contestWindow: bigint;
  claimTimeout: bigint;
  handling: bigint;
}

/** `RecourseCase.caseOf` plus `expiresAt`, read at the latest block. */
export interface CaseNow {
  state: number;
  payloadHash: Hex;
  receivedAt: bigint;
  attempts: number;
  disputeIds: readonly [bigint, bigint];
  ruling: number;
  ruledAt: bigint;
  sendCount: number;
  lastSendAt: bigint;
  lastMessageId: Hex;
  expiresAt: bigint;
}

export interface CourtNow {
  /** `costNow()`: what one dispute costs now, in wei. */
  costNow: bigint;
  feePool: bigint;
  openCases: number;
  maxOpenCases: number;
  caseDeadline: bigint;
  resendGap: bigint;
  maxSends: number;
  peer: Address;
}

export interface HederaClaimsNow {
  courtFeeUsdc: bigint;
  /** `params()` now: what a claims contract without per-claim terms checks every claim against. */
  contestWindow: bigint;
  claimTimeout: bigint;
  resendGap: bigint;
  maxSends: number;
  bridgeMode: number;
  peer: Address;
  /** The CCIP fee token: LINK, or the zero address for HBAR. */
  feeToken: Address;
}

export interface ActionReads {
  /** Number and timestamp of the latest block. */
  head(chain: ChainName): Promise<{ number: bigint; timestamp: bigint }>;
  gasPrice(chain: ChainName): Promise<bigint>;
  /** eth_call as `from` at the latest block, then eth_estimateGas when it did not revert. */
  simulate(chain: ChainName, tx: EvmTx): Promise<SimResult>;
  claim(claimId: Hex): Promise<ChainClaim>;
  /** Throws ChainRevert on a claims contract from before per-claim terms (it has no `claimTermsOf`). */
  claimTerms(claimId: Hex): Promise<ClaimTerms>;
  claimsNow(): Promise<HederaClaimsNow>;
  previewSettle(claimId: Hex): Promise<{ toShop: bigint; refund: bigint; toPool: bigint }>;
  quoteSend(claimId: Hex): Promise<bigint>;
  handlingOf(basketUsdc: bigint): Promise<bigint>;
  claimIdFor(platform: Address, shop: Address, orderNonce: Hex): Promise<Hex>;
  /** `vault.usdc()`: the token the vault pulls the court fee in. */
  vaultToken(): Promise<Address>;
  /** `balanceOf(owner)` and `allowance(owner, spender)` on the token. */
  tokenOf(token: Address, owner: Address, spender: Address): Promise<{ balance: bigint; allowance: bigint }>;
  /** What the vault checks before it escrows a fee against `platform`. */
  vaultGate(platform: Address): Promise<{ exitRequestedAt: bigint; exitDelay: bigint; usdcAssociated: boolean }>;
  /** Whether the vault reserves a platform's deposit for each claim filed (`escrowAndReserve`); a vault from before reservations does not. */
  vaultReserves(): Promise<boolean>;
  creditOf(account: Address): Promise<bigint>;
  escrowOf(claimId: Hex): Promise<bigint>;
  caseNow(claimId: Hex): Promise<CaseNow>;
  courtNow(): Promise<CourtNow>;
  quoteRelay(claimId: Hex, native: boolean): Promise<bigint>;
  /** KlerosCore `disputes(id).period`, null when the court does not expose it. */
  period(disputeId: bigint): Promise<number | null>;
}

/** The node answered: the call reverts. `data` is the revert bytes, null when it sent none. */
export class ChainRevert extends Error {
  constructor(
    readonly chain: ChainName,
    readonly data: Hex | null,
  ) {
    super('execution reverted');
  }
}

/** The chain could not be read: the RPC failed, timed out or answered something unknown. */
export class ChainUnavailable extends Error {
  constructor(readonly chain: ChainName) {
    super(`${chain} rpc unavailable`);
  }
}

const HEX = /^0x([0-9a-fA-F]{2})*$/;
const ABORT_WORDS = /out of gas|invalid opcode|stack underflow|invalid jump|InvalidFEOpcode|OpcodeNotFound|StackUnderflow|InvalidJump|CONTRACT_REVERT_EXECUTED/;

/** The revert or the fault behind an error thrown by a viem client call. */
export function classify(e: unknown, chain: ChainName): ChainRevert | ChainUnavailable {
  let cur: unknown = e;
  let data: Hex | null = null;
  let revert = false;
  for (let i = 0; i < 12 && cur !== null && typeof cur === 'object'; i++) {
    const o = cur as { code?: unknown; data?: unknown; raw?: unknown; details?: unknown; name?: unknown; cause?: unknown };
    const d = typeof o.data === 'object' && o.data !== null ? (o.data as { data?: unknown }).data : o.data;
    if (typeof o.raw === 'string' && HEX.test(o.raw) && o.raw.length >= 10 && data === null) data = o.raw as Hex;
    if (typeof d === 'string' && HEX.test(d) && d.length >= 10 && data === null) data = d as Hex;
    if (typeof d === 'string' && /revert/i.test(d)) revert = true;
    if (o.code === 3) revert = true;
    if (o.name === 'ContractFunctionRevertedError' || o.name === 'RawContractError') revert = true;
    const text = typeof o.details === 'string' ? o.details : '';
    if (/revert/i.test(text) || ABORT_WORDS.test(text)) revert = true;
    cur = o.cause;
  }
  if (data !== null) revert = true;
  return revert ? new ChainRevert(chain, data) : new ChainUnavailable(chain);
}

export interface ViemActionReadsConfig {
  hederaRpcUrls: string[];
  /** Empty: Arbitrum actions answer upstream_unavailable. */
  arbRpcUrl: string;
  timeoutMs: number;
  claims: Address;
  vault: Address;
  caseAddress: Address | null;
  klerosCore: Address;
}

export class ViemActionReads implements ActionReads {
  private hedera: PublicClient;
  private arb: PublicClient | null;
  private token: Address | null = null;
  private reserves: boolean | null = null;
  private termsMissing = false;

  constructor(private cfg: ViemActionReadsConfig) {
    this.hedera = createPublicClient({ transport: fallback(cfg.hederaRpcUrls.map((u) => http(u, { timeout: cfg.timeoutMs }))) }) as PublicClient;
    this.arb = cfg.arbRpcUrl ? (createPublicClient({ transport: http(cfg.arbRpcUrl, { timeout: cfg.timeoutMs }) }) as PublicClient) : null;
  }

  private client(chain: ChainName): PublicClient {
    if (chain === 'hedera') return this.hedera;
    if (!this.arb || !this.cfg.caseAddress) throw new ChainUnavailable('arbitrum');
    return this.arb;
  }

  private async read<T>(chain: ChainName, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
    const c = this.client(chain);
    try {
      return (await c.readContract({ address, abi, functionName, args } as never)) as T;
    } catch (e) {
      throw classify(e, chain);
    }
  }

  private kase(): Address {
    if (!this.cfg.caseAddress) throw new ChainUnavailable('arbitrum');
    return this.cfg.caseAddress;
  }

  async head(chain: ChainName) {
    const c = this.client(chain);
    try {
      const b = await c.getBlock({ blockTag: 'latest' });
      return { number: b.number ?? 0n, timestamp: b.timestamp };
    } catch {
      throw new ChainUnavailable(chain);
    }
  }

  async gasPrice(chain: ChainName) {
    const c = this.client(chain);
    try {
      return await c.getGasPrice();
    } catch {
      throw new ChainUnavailable(chain);
    }
  }

  async simulate(chain: ChainName, tx: EvmTx): Promise<SimResult> {
    const c = this.client(chain);
    const req = { account: tx.from, to: tx.to, data: tx.data, ...(tx.value ? { value: tx.value } : {}) };
    try {
      await c.call(req);
    } catch (e) {
      const k = classify(e, chain);
      if (k instanceof ChainRevert) return { ok: false, data: k.data };
      throw k;
    }
    try {
      return { ok: true, gas: await c.estimateGas(req) };
    } catch (e) {
      const k = classify(e, chain);
      if (k instanceof ChainRevert) return { ok: false, data: k.data };
      throw k;
    }
  }

  async claim(claimId: Hex): Promise<ChainClaim> {
    const c = await this.read<Record<string, unknown>>('hedera', this.cfg.claims, CLAIMS_ABI, 'getClaim', [claimId]);
    return {
      orderId: c.orderId as Hex,
      shop: c.shop as Address,
      platform: c.platform as Address,
      basketUsdc: c.basketUsdc as bigint,
      netLossUsdc: c.netLossUsdc as bigint,
      filedAt: BigInt(c.filedAt as bigint),
      preCheckedAt: BigInt(c.preCheckedAt as bigint),
      gap: Number(c.gap),
      answer: Number(c.answer),
      packHash: c.packHash as Hex,
      contestedBy: c.contestedBy as Address,
      sendCount: Number(c.sendCount),
      lastSendAt: BigInt(c.lastSendAt as bigint),
      lastMessageId: c.lastMessageId as Hex,
      disputeId: c.disputeId as bigint,
      ruling: Number(c.ruling),
      attempts: Number(c.attempts),
      status: Number(c.status),
    };
  }

  async claimTerms(claimId: Hex): Promise<ClaimTerms> {
    // A claims contract from before per-claim terms reverts every claimTermsOf, and its code never
    // changes: after the first revert the call is not sent again.
    if (this.termsMissing) throw new ChainRevert('hedera', null);
    try {
      const t = await this.read<{ contestWindow: bigint; claimTimeout: bigint; handling: bigint }>('hedera', this.cfg.claims, CLAIMS_ABI, 'claimTermsOf', [claimId]);
      return { contestWindow: BigInt(t.contestWindow), claimTimeout: BigInt(t.claimTimeout), handling: t.handling };
    } catch (e) {
      if (e instanceof ChainRevert) this.termsMissing = true;
      throw e;
    }
  }

  async claimsNow(): Promise<HederaClaimsNow> {
    const a = this.cfg.claims;
    const [p, bridgeMode, peer, feeToken] = await Promise.all([
      this.read<{ courtFeeUsdc: bigint; contestWindow: bigint; claimTimeout: bigint; resendGap: bigint; maxSends: number }>('hedera', a, CLAIMS_ABI, 'params'),
      this.read<number>('hedera', a, CLAIMS_ABI, 'bridgeMode'),
      this.read<Address>('hedera', a, CLAIMS_ABI, 'peer'),
      this.read<Address>('hedera', a, CLAIMS_ABI, 'feeToken'),
    ]);
    return {
      courtFeeUsdc: p.courtFeeUsdc,
      contestWindow: BigInt(p.contestWindow),
      claimTimeout: BigInt(p.claimTimeout),
      resendGap: BigInt(p.resendGap),
      maxSends: Number(p.maxSends),
      bridgeMode: Number(bridgeMode),
      peer,
      feeToken,
    };
  }

  async previewSettle(claimId: Hex) {
    const [toShop, refund, toPool] = await this.read<readonly [bigint, bigint, bigint]>('hedera', this.cfg.claims, CLAIMS_ABI, 'previewSettle', [claimId]);
    return { toShop, refund, toPool };
  }

  quoteSend(claimId: Hex) {
    return this.read<bigint>('hedera', this.cfg.claims, CLAIMS_ABI, 'quoteSend', [claimId]);
  }

  handlingOf(basketUsdc: bigint) {
    return this.read<bigint>('hedera', this.cfg.claims, CLAIMS_ABI, 'handlingOf', [basketUsdc]);
  }

  claimIdFor(platform: Address, shop: Address, orderNonce: Hex) {
    return this.read<Hex>('hedera', this.cfg.claims, CLAIMS_ABI, 'claimIdFor', [platform, shop, orderNonce]);
  }

  async vaultToken(): Promise<Address> {
    // The vault's token is set at construction and never changes.
    if (this.token === null) this.token = await this.read<Address>('hedera', this.cfg.vault, VAULT_ABI, 'usdc');
    return this.token;
  }

  async tokenOf(token: Address, owner: Address, spender: Address) {
    const [balance, allowance] = await Promise.all([
      this.read<bigint>('hedera', token, TOKEN_ABI, 'balanceOf', [owner]),
      this.read<bigint>('hedera', token, TOKEN_ABI, 'allowance', [owner, spender]),
    ]);
    return { balance, allowance };
  }

  async vaultGate(platform: Address) {
    const v = this.cfg.vault;
    const [exitRequestedAt, params, usdcAssociated] = await Promise.all([
      this.read<bigint>('hedera', v, VAULT_ABI, 'exitRequestedAt', [platform]),
      this.read<readonly [bigint, bigint, bigint]>('hedera', v, VAULT_ABI, 'params'),
      this.read<boolean>('hedera', v, VAULT_ABI, 'usdcAssociated'),
    ]);
    return { exitRequestedAt: BigInt(exitRequestedAt), exitDelay: BigInt(params[1]), usdcAssociated };
  }

  async vaultReserves(): Promise<boolean> {
    // A contract's code never changes: `reservedOf` answers on a vault that reserves and reverts on
    // one from before reservations. Only a definite answer is kept; an RPC fault is thrown.
    if (this.reserves === null) {
      try {
        await this.read<bigint>('hedera', this.cfg.vault, VAULT_ABI, 'reservedOf', ['0x0000000000000000000000000000000000000000']);
        this.reserves = true;
      } catch (e) {
        if (!(e instanceof ChainRevert)) throw e;
        this.reserves = false;
      }
    }
    return this.reserves;
  }

  creditOf(account: Address) {
    return this.read<bigint>('hedera', this.cfg.vault, VAULT_ABI, 'creditOf', [account]);
  }

  async escrowOf(claimId: Hex) {
    const e = await this.read<{ amount: bigint }>('hedera', this.cfg.vault, VAULT_ABI, 'escrowOf', [claimId]);
    return e.amount;
  }

  async caseNow(claimId: Hex): Promise<CaseNow> {
    const a = this.kase();
    const [v, expiresAt] = await Promise.all([
      this.read<Record<string, unknown>>('arbitrum', a, CASE_ABI, 'caseOf', [claimId]),
      this.read<bigint>('arbitrum', a, CASE_ABI, 'expiresAt', [claimId]),
    ]);
    const ids = v.disputeIds as readonly bigint[];
    return {
      state: Number(v.state),
      payloadHash: v.payloadHash as Hex,
      receivedAt: BigInt(v.receivedAt as bigint),
      attempts: Number(v.attempts),
      disputeIds: [ids[0] ?? 0n, ids[1] ?? 0n],
      ruling: Number(v.ruling),
      ruledAt: BigInt(v.ruledAt as bigint),
      sendCount: Number(v.sendCount),
      lastSendAt: BigInt(v.lastSendAt as bigint),
      lastMessageId: v.lastMessageId as Hex,
      expiresAt: BigInt(expiresAt),
    };
  }

  async courtNow(): Promise<CourtNow> {
    const a = this.kase();
    const [costNow, feePool, openCases, params, peer] = await Promise.all([
      this.read<bigint>('arbitrum', a, CASE_ABI, 'costNow'),
      this.read<bigint>('arbitrum', a, CASE_ABI, 'feePool'),
      this.read<number>('arbitrum', a, CASE_ABI, 'openCases'),
      this.read<readonly [bigint, number, bigint, number]>('arbitrum', a, CASE_ABI, 'params'),
      this.read<Address>('arbitrum', a, CASE_ABI, 'peer'),
    ]);
    return {
      costNow,
      feePool,
      openCases: Number(openCases),
      caseDeadline: BigInt(params[0]),
      maxOpenCases: Number(params[1]),
      resendGap: BigInt(params[2]),
      maxSends: Number(params[3]),
      peer,
    };
  }

  quoteRelay(claimId: Hex, native: boolean) {
    return this.read<bigint>('arbitrum', this.kase(), CASE_ABI, native ? 'quoteRelayNative' : 'quoteRelay', [claimId]);
  }

  async period(disputeId: bigint): Promise<number | null> {
    try {
      const d = await this.read<readonly unknown[]>('arbitrum', this.cfg.klerosCore, klerosAbi as Abi, 'disputes', [disputeId]);
      return Number(d[2]);
    } catch (e) {
      if (e instanceof ChainUnavailable) throw e;
      return null;
    }
  }
}
