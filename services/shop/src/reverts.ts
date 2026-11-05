// Readable reverts from RecourseClaims and DepositVault.
//
// A revert raised inside the vault (during `fileClaim`'s fee escrow, say) bubbles up through the
// claims contract unchanged, but its error is declared only in the vault's ABI. Decoding with the
// claims ABI plus the vault's errors names every revert either contract can raise.

import { BaseError, ContractFunctionRevertedError, type Abi, type AbiParameter } from 'viem';

type ErrorItem = Extract<Abi[number], { type: 'error' }>;

function signatureOf(item: ErrorItem): string {
  return `${item.name}(${item.inputs.map((i: AbiParameter) => i.type).join(',')})`;
}

/** `abi` plus every error of the other ABIs that it does not declare already. */
export function withErrorsOf(abi: Abi, ...others: Abi[]): Abi {
  const seen = new Set(abi.filter((i): i is ErrorItem => i.type === 'error').map(signatureOf));
  const extra: ErrorItem[] = [];
  for (const other of others) {
    for (const item of other) {
      if (item.type !== 'error') continue;
      const sig = signatureOf(item);
      if (seen.has(sig)) continue;
      seen.add(sig);
      extra.push(item);
    }
  }
  return [...abi, ...extra];
}

export interface Revert {
  /** The custom error's name, `reverted` when the node gave no reason. */
  name: string;
  args: readonly unknown[];
}

/** The custom error a viem call failed with, or null when it did not revert. */
export function revertOf(error: unknown): Revert | null {
  if (!(error instanceof BaseError)) return null;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return null;
  if (revert.data?.errorName) return { name: revert.data.errorName, args: revert.data.args ?? [] };
  return { name: revert.reason ?? 'reverted', args: [] };
}

const STATUS_NAMES = ['None', 'Filed', 'PreChecked', 'Contested', 'AtCourt', 'Ruled', 'Settled', 'Closed', 'Expired'];

export function statusName(status: number | bigint): string {
  return STATUS_NAMES[Number(status)] ?? `status ${status}`;
}

function at(seconds: unknown): string {
  try {
    return new Date(Number(seconds) * 1000).toISOString();
  } catch {
    return String(seconds);
  }
}

const MESSAGES: Record<string, (args: readonly unknown[]) => string> = {
  // RecourseClaims
  WrongStatus: (a) => `the claim is ${statusName(a[0] as number)}, which this call does not accept`,
  WindowClosed: (a) => `the contest window closed at ${at(a[0])}`,
  WindowOpen: (a) => `the contest window is open until ${at(a[0])}`,
  NotContester: () => 'only the side the pre-check went against can contest this claim',
  NotExpired: (a) => `the claim does not expire before ${at(a[0])}`,
  ClaimExists: () => 'a claim for this order is already filed',
  SameParty: () => 'the shop and the platform are the same account',
  ZeroBasket: () => 'the basket must be above zero',
  BasketTooLarge: () => 'the basket is above the contract limit',
  NetLossAboveBasket: () => 'the net loss is above the basket',
  MissingOrdered: () => 'the refs hold no ordered record',
  BadRefs: () => 'the record refs are malformed',
  NotPreCheckSigner: () => 'only the pre-check signer can record a pre-check',
  // DepositVault
  ExitDue: () => "the platform's exit from the deposit vault is due, so the vault takes no new claim against it",
  NoCredit: () => 'this account has no credit in the deposit vault',
  NotAssociated: (a) => `the USDC transfer to ${String(a[0])} failed; associate that account with the USDC token first`,
  NotAssociatedYet: () => 'the deposit vault is not associated with the USDC token yet',
  TransferFailed: () => 'a USDC transfer failed (balance or allowance too low)',
  EscrowExists: () => 'the court fee for this claim is already escrowed',
  UnknownEscrow: () => 'no open escrow matches this claim',
  ExitTooSoon: (a) => `the exit is not available before ${at(a[0])}`,
  OpenClaims: (a) => `the platform still has ${String(a[0])} open claim(s)`,
  ExitPending: () => 'an exit is already requested',
  ExitNotRequested: () => 'no exit was requested',
  NoDeposit: () => 'this account has no deposit',
  BelowMinDeposit: () => 'the deposit is below the minimum',
};

/** One line for a revert: the error name, then what it means. */
export function explainRevert(revert: Revert): string {
  const message = MESSAGES[revert.name];
  return message ? `${revert.name}: ${message(revert.args)}` : `${revert.name}${revert.args.length ? `(${revert.args.map(String).join(', ')})` : ''}`;
}
