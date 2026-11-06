import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  APPROVAL_DOMAIN,
  APPROVAL_TYPES,
  REPORT_TYPES,
  approvalDocSigner,
  arrivedDocSigner,
  canonicalBytes,
  checkRecordSignature,
  parseParties,
  recordHash,
  recordSignersFor,
  type CanonicalValue,
} from '../src/index.js';

const agent = privateKeyToAccount(generatePrivateKey());
const buyer = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const orderId = `0x${'ab'.repeat(32)}` as const;
const textHash = `0x${'cd'.repeat(32)}` as const;

type Account = typeof agent;

async function approval(signedBy: Account, basis: 'buyer' | 'mandate' | undefined, over: Record<string, CanonicalValue> = {}) {
  const fields = { amount: '20000000', payTo: '0.0.5005', approval: 'approved', expiresAt: '1700000600' };
  const signature = await signedBy.signTypedData({
    domain: APPROVAL_DOMAIN,
    types: APPROVAL_TYPES,
    primaryType: 'RecourseApproval',
    message: { orderId, textHash, amount: BigInt(fields.amount), payTo: fields.payTo, decision: fields.approval, expiresAt: BigInt(fields.expiresAt) },
  });
  const doc: Record<string, CanonicalValue> = { v: '1', kind: 'approval', orderId, textHash, asset: 'HBAR', ...fields, signer: signedBy.address, signature };
  if (basis !== undefined) doc.approvalBasis = basis;
  return canonicalBytes({ ...doc, ...over });
}

async function arrived(signedBy: Account, over: Record<string, CanonicalValue> = {}, attrs: Record<string, string> = { size: 'm' }) {
  const body = { v: '1', kind: 'arrived', orderId, attrs, reportedAt: '1700000900' };
  const buyerSignature = await signedBy.signTypedData({
    domain: APPROVAL_DOMAIN,
    types: REPORT_TYPES,
    primaryType: 'RecourseArrived',
    message: { orderId, bodyHash: recordHash(canonicalBytes(body)) },
  });
  return canonicalBytes({ ...body, buyerSigner: signedBy.address, buyerSignature, ...over });
}

const signers = { buyers: [buyer.address], agent: agent.address };

describe('record signatures', () => {
  it('recovers the signer of an approval and of an arrived record', async () => {
    expect(await approvalDocSigner(await approval(agent, 'mandate'))).toEqual({ ok: true, signer: agent.address });
    expect(await arrivedDocSigner(await arrived(buyer))).toEqual({ ok: true, signer: buyer.address });
  });

  it('a mandate approval must be signed by the agent that wrote it', async () => {
    expect(await checkRecordSignature(2, await approval(agent, 'mandate'), signers)).toEqual({ ok: true });
    expect((await checkRecordSignature(2, await approval(stranger, 'mandate'), signers)).ok).toBe(false);
    // The buyer's key does not make a mandate approval either, nor does a missing agent.
    expect((await checkRecordSignature(2, await approval(buyer, 'mandate'), signers)).ok).toBe(false);
    expect((await checkRecordSignature(2, await approval(agent, 'mandate'), { buyers: [buyer.address] })).ok).toBe(false);
  });

  it('a buyer approval must be signed by a buyer in the party map, whatever signer it names', async () => {
    expect(await checkRecordSignature(2, await approval(buyer, 'buyer'), signers)).toEqual({ ok: true });
    expect((await checkRecordSignature(2, await approval(agent, 'buyer'), signers)).ok).toBe(false);
    // Signed by a stranger but naming the buyer as signer.
    const forged = await approval(stranger, 'buyer', { signer: buyer.address });
    expect(await checkRecordSignature(2, forged, signers)).toEqual({ ok: false, error: 'signer is not the address that signed' });
  });

  it('an approval with no basis, no signature or an altered field is refused', async () => {
    expect(await checkRecordSignature(2, await approval(agent, undefined), signers)).toEqual({ ok: false, error: 'approvalBasis must be buyer or mandate' });
    const unsigned = canonicalBytes({ v: '1', kind: 'approval', orderId, approval: 'approved', approvalBasis: 'buyer' });
    expect((await checkRecordSignature(2, unsigned, signers)).ok).toBe(false);
    // The signed amount was 20 USDC; the document says 2000.
    expect((await checkRecordSignature(2, await approval(buyer, 'buyer', { amount: '2000000000' }), signers)).ok).toBe(false);
    expect((await checkRecordSignature(2, await approval(buyer, 'buyer', { signature: '0x1234' }), signers)).ok).toBe(false);
  });

  it('an arrived record must be signed by a buyer over exactly its body', async () => {
    expect(await checkRecordSignature(5, await arrived(buyer), signers)).toEqual({ ok: true });
    expect((await checkRecordSignature(5, await arrived(agent), signers)).ok).toBe(false);
    // Attributes changed after the buyer signed.
    expect((await checkRecordSignature(5, await arrived(buyer, { attrs: { size: 'xl' } }), signers)).ok).toBe(false);
    // A stranger's signature with the buyer named as signer.
    expect((await checkRecordSignature(5, await arrived(stranger, { buyerSigner: buyer.address }), signers)).ok).toBe(false);
    expect((await checkRecordSignature(5, canonicalBytes({ v: '1', kind: 'arrived', orderId, attrs: {} }), signers)).ok).toBe(false);
  });

  it('other kinds carry no signature', async () => {
    for (const kind of [0, 1, 3, 4] as const) {
      expect(await checkRecordSignature(kind, canonicalBytes({ v: '1' }), { buyers: [] })).toEqual({ ok: true });
    }
  });

  it('takes the buyers and the agent whose account paid from the party map', () => {
    const r = parseParties([
      { role: 'platform', evmAddress: '0x00000000000000000000000000000000000000a1', hederaAccountId: '0.0.1001', hcsWriters: ['0.0.1002'], displayName: 'Example Platform' },
      { role: 'agent', evmAddress: agent.address, hederaAccountId: '0.0.1002', hcsWriters: [], displayName: 'Example Agent' },
      { role: 'buyer', evmAddress: buyer.address, hcsWriters: [], displayName: 'Example Buyer' },
    ]);
    if (!r.ok) throw new Error(r.error);
    expect(recordSignersFor(r.value, '0.0.1002')).toEqual({ buyers: [buyer.address], agent: agent.address });
    expect(recordSignersFor(r.value, '0.0.1001')).toEqual({ buyers: [buyer.address] });
  });
});
