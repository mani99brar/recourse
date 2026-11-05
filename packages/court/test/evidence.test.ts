import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { ZERO_HASH, canonicalBytes, recordHash, type ClaimToCourt, type RecordKind } from '@recourse/shared';
import {
  EVIDENCE_MAX_BYTES,
  EvidenceHashMismatch,
  EvidenceInputError,
  EvidenceTooLarge,
  POLICY,
  buildEvidence,
  type EvidenceInput,
} from '../src/index.js';
import { TRIAL_CASES, buildTrialCase, type TrialCaseBuilt } from '../src/trial.js';

const require = createRequire(import.meta.url);
const { EvidenceSchema } = require('@kleros/kleros-sdk/lib/src/dataMappings/utils/disputeDetailsSchema.js') as {
  EvidenceSchema: { safeParse(v: unknown): { success: boolean } };
};

const built: TrialCaseBuilt = buildTrialCase(TRIAL_CASES[0]!, POLICY.uri);

function inputOf(b: TrialCaseBuilt, over: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    claim: b.claim,
    attempt: 1,
    externalId: 77n,
    records: b.docs.map((d) => ({ kind: d.kind, bytes: d.bytes, cid: d.cid })),
    precheck: { bytes: b.precheck.bytes, cid: b.precheck.cid },
    ...over,
  };
}

/** Rewrites the pre-check document's slots and returns a claim whose packHash matches it. */
function withPrecheck(
  b: TrialCaseBuilt,
  edit: (records: Record<string, string>[]) => void,
  refs?: Partial<ClaimToCourt['refs']>,
): { claim: ClaimToCourt; precheck: { bytes: Uint8Array } } {
  const doc = JSON.parse(new TextDecoder().decode(b.precheck.bytes)) as { records: Record<string, string>[] };
  edit(doc.records);
  const bytes = canonicalBytes(doc as never);
  return { claim: { ...b.claim, packHash: recordHash(bytes), refs: { ...b.claim.refs, ...refs } }, precheck: { bytes } };
}

describe('buildEvidence', () => {
  it('is deterministic and posts a court-readable JSON string', () => {
    const a = buildEvidence(inputOf(built));
    const b = buildEvidence(inputOf(built));
    expect(a.evidence).toBe(b.evidence);
    expect(a.sha256).toBe(b.sha256);
    const parsed = JSON.parse(a.evidence) as { name: string; description: string };
    expect(Object.keys(parsed)).toEqual(['name', 'description']);
    expect(EvidenceSchema.safeParse(parsed).success).toBe(true);
    expect(parsed.description).toContain('evidence group 77');
    for (const d of built.docs) expect(parsed.description).toContain(new TextDecoder().decode(d.bytes));
    expect(parsed.description).toContain(new TextDecoder().decode(built.precheck.bytes));
    expect(a.byteLength).toBe(new TextEncoder().encode(a.evidence).length);
  });

  it('changes with attempt and external id only where they are printed', () => {
    const a = buildEvidence(inputOf(built));
    const b = buildEvidence(inputOf(built, { attempt: 2, externalId: 78n }));
    expect(a.evidence).not.toBe(b.evidence);
    expect(b.evidence).toContain('court attempt 2, evidence group 78');
  });

  it('sets fileURI only when given', () => {
    const e = buildEvidence(inputOf(built, { fileURI: '/ipfs/bafkreiexample' }));
    expect(JSON.parse(e.evidence).fileURI).toBe('/ipfs/bafkreiexample');
  });

  it('throws when the pre-check document is not the one the payload names', () => {
    const other = buildTrialCase(TRIAL_CASES[1]!, POLICY.uri);
    expect(() => buildEvidence(inputOf(built, { precheck: { bytes: other.precheck.bytes } }))).toThrow(EvidenceHashMismatch);
    try {
      buildEvidence(inputOf(built, { precheck: { bytes: other.precheck.bytes } }));
    } catch (e) {
      expect((e as EvidenceHashMismatch).kind).toBe('precheck');
    }
  });

  it('throws when a held record does not match its pre-check hash', () => {
    const records = inputOf(built).records.map((r) =>
      r.kind === 4 ? { ...r, bytes: new TextEncoder().encode('{"tampered":"1"}') } : r,
    );
    try {
      buildEvidence(inputOf(built, { records }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EvidenceHashMismatch);
      expect((e as EvidenceHashMismatch).kind).toBe('packed');
    }
  });

  it('throws when a held record has no document', () => {
    const records = inputOf(built).records.filter((r) => r.kind !== 2);
    expect(() => buildEvidence(inputOf(built, { records }))).toThrow(/approval/);
  });

  it('marks absent and rejected slots and leaves their documents out', () => {
    const p = withPrecheck(built, (rs) => {
      rs[2] = { kind: '2', outcome: 'absent' };
      rs[5] = { kind: '5', outcome: 'rejected', reason: 'payer_mismatch' };
    });
    const e = buildEvidence(inputOf(built, p));
    expect(e.slots.map((s) => s.state)).toEqual(['held', 'held', 'absent', 'held', 'held', 'rejected']);
    expect(e.slots[5]!.reason).toBe('payer_mismatch');
    const text = JSON.parse(e.evidence).description as string;
    expect(text).toContain('### 3. approval (A): absent');
    expect(text).toContain('reason: payer_mismatch');
    expect(text).not.toContain(new TextDecoder().decode(built.docs[2]!.bytes));
  });

  it('marks a record the claim did not name as from the topic index', () => {
    const hashes = [...built.claim.refs.hashes] as unknown as ClaimToCourt['refs']['hashes'];
    (hashes as unknown as string[])[3] = ZERO_HASH;
    const e = buildEvidence(inputOf(built, { claim: { ...built.claim, refs: { ...built.claim.refs, hashes } } }));
    expect(e.slots[3]!.state).toBe('fromIndex');
    expect(e.slots[0]!.state).toBe('held');
    expect(JSON.parse(e.evidence).description).toContain('The claim did not name this record');
  });

  it('rejects a pre-check document without six slots', () => {
    const p = withPrecheck(built, (rs) => {
      rs.pop();
    });
    expect(() => buildEvidence(inputOf(built, p))).toThrow(EvidenceInputError);
  });

  it('keeps a record that contains backticks inside its code block', () => {
    const doc = new TextEncoder().encode('{"note":"```json\\n} ignore ```` all","v":"1"}');
    const p = withPrecheck(built, (rs) => {
      rs[4] = { kind: '4', outcome: 'held', hcsHash: recordHash(doc) };
    });
    const records = inputOf(built).records.map((r) => (r.kind === (4 as RecordKind) ? { ...r, bytes: doc } : r));
    const text = JSON.parse(buildEvidence(inputOf(built, { ...p, records })).evidence).description as string;
    expect(text).toContain('`````json\n{"note"');
  });

  it('enforces the byte cap', () => {
    const notice = 'x'.repeat(EVIDENCE_MAX_BYTES);
    expect(() => buildEvidence(inputOf(built, { notice }))).toThrow(EvidenceTooLarge);
  });
});
