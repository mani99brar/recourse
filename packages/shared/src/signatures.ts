// EIP-712 signatures carried by record documents. The agent key signs a mandate approval (an
// amount within its spend limit); the buyer key signs an approval above the limit and the report
// of what arrived. The domain and types are the ones the agent service signs with
// (services/agent/src/approval.ts); a test in the pre-check service keeps the two equal.
//
// A reader checks a signature against the party map. The signer a document names is only compared
// with the address recovered from the signature; it never decides who may sign.

import { getAddress, isAddress, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { HEDERA_TESTNET_CHAIN_ID } from './addresses.js';
import { canonicalBytes, isHex32, parseCanonical, recordHash, type CanonicalValue } from './hashing.js';
import { partiesByRole, type Parties } from './parties.js';
import type { RecordKind } from './records.js';

export const APPROVAL_DOMAIN = { name: 'Recourse', version: '1', chainId: HEDERA_TESTNET_CHAIN_ID } as const;

/** Approval of an order's rendered text: binds the order, the text shown, the amount and the payee. */
export const APPROVAL_TYPES = {
  RecourseApproval: [
    { name: 'orderId', type: 'bytes32' },
    { name: 'textHash', type: 'bytes32' },
    { name: 'amount', type: 'uint256' },
    { name: 'payTo', type: 'string' },
    { name: 'decision', type: 'string' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const;

/** The buyer's report of what arrived: the record hash of the arrived record without its two signature fields. */
export const REPORT_TYPES = {
  RecourseArrived: [
    { name: 'orderId', type: 'bytes32' },
    { name: 'bodyHash', type: 'bytes32' },
  ],
} as const;

export type SignerResult = { ok: true; signer: Address } | { ok: false; error: string };

const DECIMAL = /^(0|[1-9]\d*)$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const UINT64_MAX = 2n ** 64n - 1n;
const UINT256_MAX = 2n ** 256n - 1n;

function objectOf(bytes: Uint8Array): Record<string, CanonicalValue | undefined> | undefined {
  const parsed = parseCanonical(bytes);
  if (!parsed.ok) return undefined;
  const v = parsed.value;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  return v;
}

async function recovered(
  run: () => Promise<Address>,
  named: CanonicalValue | undefined,
  field: string,
): Promise<SignerResult> {
  let signer: Address;
  try {
    signer = await run();
  } catch {
    return { ok: false, error: 'the signature does not parse' };
  }
  if (typeof named !== 'string' || !isAddress(named, { strict: false }) || getAddress(named) !== signer) {
    return { ok: false, error: `${field} is not the address that signed` };
  }
  return { ok: true, signer };
}

/**
 * The address that signed an approval record document (`RecourseApproval` over its orderId,
 * textHash, amount, payTo, approval and expiresAt). The document's `signer` field must name that
 * same address. Says nothing about whether that signer may approve.
 */
export async function approvalDocSigner(bytes: Uint8Array): Promise<SignerResult> {
  const d = objectOf(bytes);
  if (d === undefined) return { ok: false, error: 'not a canonical JSON object' };
  const { orderId, textHash, amount, payTo, approval, expiresAt, signature } = d;
  if (!isHex32(orderId)) return { ok: false, error: 'orderId is not 32 bytes of hex' };
  if (!isHex32(textHash)) return { ok: false, error: 'textHash is not 32 bytes of hex' };
  if (typeof amount !== 'string' || !DECIMAL.test(amount) || BigInt(amount) > UINT256_MAX) return { ok: false, error: 'amount is not a decimal uint256' };
  if (typeof payTo !== 'string') return { ok: false, error: 'payTo is missing' };
  if (approval !== 'approved' && approval !== 'not_approved') return { ok: false, error: 'approval is not approved or not_approved' };
  if (typeof expiresAt !== 'string' || !DECIMAL.test(expiresAt) || BigInt(expiresAt) > UINT64_MAX) return { ok: false, error: 'expiresAt is not a decimal uint64' };
  if (typeof signature !== 'string' || !SIGNATURE.test(signature)) return { ok: false, error: 'signature is not 65 bytes of hex' };
  return recovered(
    () =>
      recoverTypedDataAddress({
        domain: APPROVAL_DOMAIN,
        types: APPROVAL_TYPES,
        primaryType: 'RecourseApproval',
        message: { orderId, textHash, amount: BigInt(amount), payTo, decision: approval, expiresAt: BigInt(expiresAt) },
        signature: signature as Hex,
      }),
    d.signer,
    'signer',
  );
}

/**
 * The address that signed an arrived record document (`RecourseArrived` over its orderId and the
 * record hash of the document without buyerSigner and buyerSignature). The document's
 * `buyerSigner` field must name that same address.
 */
export async function arrivedDocSigner(bytes: Uint8Array): Promise<SignerResult> {
  const d = objectOf(bytes);
  if (d === undefined) return { ok: false, error: 'not a canonical JSON object' };
  const { buyerSigner, buyerSignature, ...body } = d;
  if (!isHex32(d.orderId)) return { ok: false, error: 'orderId is not 32 bytes of hex' };
  if (typeof buyerSignature !== 'string' || !SIGNATURE.test(buyerSignature)) {
    return { ok: false, error: 'buyerSignature is not 65 bytes of hex' };
  }
  const bodyHash = recordHash(canonicalBytes(body));
  const orderId = d.orderId;
  return recovered(
    () =>
      recoverTypedDataAddress({
        domain: APPROVAL_DOMAIN,
        types: REPORT_TYPES,
        primaryType: 'RecourseArrived',
        message: { orderId, bodyHash },
        signature: buyerSignature as Hex,
      }),
    buyerSigner,
    'buyerSigner',
  );
}

/** Who may sign one order's records, from the party map. */
export interface RecordSigners {
  /** EVM addresses (checksummed) of the buyer parties. */
  buyers: readonly Address[];
  /** EVM address of the agent party whose Hedera account paid for the record's message; signs mandate approvals. */
  agent?: Address;
}

/**
 * The allowed signers for a record whose HCS message `payer` paid for: every party with the buyer
 * role, and the agent party whose hederaAccountId is the payer (the agent that wrote the record).
 */
export function recordSignersFor(parties: Parties, payer: string): RecordSigners {
  const agent = partiesByRole(parties, 'agent').find((p) => p.hederaAccountId === payer)?.evmAddress;
  const out: RecordSigners = { buyers: partiesByRole(parties, 'buyer').map((p) => p.evmAddress) };
  if (agent !== undefined) out.agent = agent;
  return out;
}

/**
 * Checks the signature a record document must carry. An approval (kind 2) with basis `buyer` must
 * be signed by a buyer party, one with basis `mandate` by the agent that wrote it; an approval with
 * neither basis is refused. An arrived record (kind 5) must be signed by a buyer party. Other kinds
 * carry no signature and pass.
 */
export async function checkRecordSignature(kind: RecordKind, bytes: Uint8Array, signers: RecordSigners): Promise<{ ok: true } | { ok: false; error: string }> {
  if (kind !== 2 && kind !== 5) return { ok: true };
  const r = kind === 2 ? await approvalDocSigner(bytes) : await arrivedDocSigner(bytes);
  if (!r.ok) return r;
  if (kind === 5) return signers.buyers.includes(r.signer) ? { ok: true } : { ok: false, error: `${r.signer} is not a buyer in the party map` };
  const basis = objectOf(bytes)?.approvalBasis;
  if (basis === 'buyer') {
    return signers.buyers.includes(r.signer) ? { ok: true } : { ok: false, error: `${r.signer} is not a buyer in the party map` };
  }
  if (basis === 'mandate') {
    return signers.agent !== undefined && r.signer === signers.agent
      ? { ok: true }
      : { ok: false, error: `${r.signer} is not the agent that wrote the record` };
  }
  return { ok: false, error: 'approvalBasis must be buyer or mandate' };
}
