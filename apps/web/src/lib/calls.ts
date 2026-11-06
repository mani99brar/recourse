// The contract calls the web app will ever ask a wallet to sign, and the check that a built
// transaction's data is exactly the call it shows. The Recourse fragments follow the generated ABIs
// in deployments/abi; a test checks each one against them, the token's against viem's ERC-20 ABI and
// the evidence module's against the shared Kleros ABI.
import { decodeFunctionData, parseAbi, type Abi, type Hex } from 'viem';
import type { ActionName } from './actions.js';

export const CALL_ABIS = {
  RecourseClaims: parseAbi([
    'struct RecordRefs { uint64 topicNum; uint64[6] seq; bytes32[6] hashes; }',
    'function fileClaim(bytes32 orderNonce, address platform, RecordRefs refs, uint256 basketUsdc, uint256 netLossUsdc) returns (bytes32 claimId)',
    'function contest(bytes32 claimId)',
    'function closeUncontested(bytes32 claimId)',
    'function sendToCourt(bytes32 claimId)',
    'function resend(bytes32 claimId)',
    'function expireClaim(bytes32 claimId)',
    'function settle(bytes32 claimId)',
  ]),
  DepositVault: parseAbi(['function withdrawCredit()', 'function postDeposit(address platform, uint256 amount)']),
  RecourseCase: parseAbi(['function openCase(bytes payload)', 'function refile(bytes payload)', 'function relayRuling(bytes32 claimId) payable']),
  EvidenceModule: parseAbi(['function submitEvidence(uint256 _externalDisputeID, string _evidence)']),
  VaultToken: parseAbi(['function approve(address spender, uint256 amount) returns (bool)']),
} as const satisfies Record<string, Abi>;

export type CallContract = keyof typeof CALL_ABIS;

/** Per action, the only contract functions its transactions may call, in signing order. */
export const ACTION_CALLS: Record<ActionName, readonly `${CallContract}.${string}`[]> = {
  fileClaim: ['VaultToken.approve', 'RecourseClaims.fileClaim'],
  contest: ['RecourseClaims.contest'],
  submitEvidence: ['EvidenceModule.submitEvidence'],
  withdrawCredit: ['DepositVault.withdrawCredit'],
  closeUncontested: ['RecourseClaims.closeUncontested'],
  sendToCourt: ['RecourseClaims.sendToCourt'],
  resend: ['RecourseClaims.resend'],
  expireClaim: ['RecourseClaims.expireClaim'],
  settle: ['RecourseClaims.settle'],
  openCase: ['RecourseCase.openCase'],
  refile: ['RecourseCase.refile'],
  relayRuling: ['RecourseCase.relayRuling'],
};

export interface ShownCall {
  contract: string;
  function: string;
  args: Record<string, unknown>;
}

/** Integers as decimal text, hex in lower case, so a decoded value and the API's text compare equal. */
function norm(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return /^0x[0-9a-fA-F]*$/.test(v) ? v.toLowerCase() : v;
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, norm(o[k])]));
  }
  return v;
}

/**
 * Null when `data` decodes, against this app's own fragment for `call.contract`, to `call.function`
 * with exactly `call.args`; otherwise why not, in plain words. Nothing is signed unless this is null.
 */
export function callProblem(data: Hex, call: ShownCall, own?: Abi): string | null {
  // `own`: a contract outside CALL_ABIS that the page builds calls for itself (the ERC-8004 registry).
  const abi = own ?? (CALL_ABIS as Record<string, Abi>)[call.contract];
  if (!abi) return `it calls ${call.contract}, a contract this page does not sign for`;
  let decoded: { functionName: string; args?: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi, data }) as { functionName: string; args?: readonly unknown[] };
  } catch {
    return `its data is not a ${call.contract} call this page knows`;
  }
  if (decoded.functionName !== call.function) return `its data calls ${decoded.functionName}, not ${call.function}`;
  const fn = abi.find((f) => f.type === 'function' && f.name === decoded.functionName);
  const inputs = fn && fn.type === 'function' ? fn.inputs : [];
  const named = Object.fromEntries(inputs.map((input, i) => [input.name ?? String(i), decoded.args?.[i]]));
  if (JSON.stringify(norm(named)) !== JSON.stringify(norm(call.args))) return 'its data carries different arguments from the ones shown';
  return null;
}
