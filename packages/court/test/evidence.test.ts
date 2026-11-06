import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { RECORD_DOC_MAX_BYTES, RECORD_KEYS, ZERO_HASH, canonicalBytes, rawCidOfHash, recordHash, type ClaimToCourt, type RecordKind } from '@recourse/shared';
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
    const text = JSON.parse(e.evidence).description as string;
    expect(text).toContain('The claim did not name this record');
    // The policy tells jurors the evidence marks such a record "from the topic index".
    expect(text).toContain('### 4. ordered (O): held, from the topic index\n');
    expect(text).toContain('### 1. asked (I): held\n');
    expect(text.split('from the topic index').length - 1).toBe(2);
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

  it('six records of the largest size the pre-check holds, built to cost the most, always fit', () => {
    const orderId = `0x${'ab'.repeat(32)}` as const;
    const claimId = `0x${'cd'.repeat(32)}` as const;
    // The longest note that keeps the document within RECORD_DOC_MAX_BYTES.
    const fill = (kind: number, filler: (n: number) => string) => {
      const base = { v: '1', kind: RECORD_KEYS[kind]!, orderId };
      let n = RECORD_DOC_MAX_BYTES;
      while (canonicalBytes({ ...base, note: filler(n) }).length > RECORD_DOC_MAX_BYTES) n -= 1;
      return canonicalBytes({ ...base, note: filler(n) });
    };
    const BIG = '18446744073709551615';
    const ATTRS = ['brand', 'size', 'colour', 'quantity', 'price', 'merchant'];
    const RECS = ['asked', 'shown', 'ordered', 'packed', 'arrived'];
    let largest = 0;
    for (const filler of [(n: number) => '`'.repeat(n), (n: number) => '"'.repeat(n), (n: number) => '\\'.repeat(n), (n: number) => '`'.repeat(n >> 1) + '"'.repeat(n >> 1)]) {
      const docs = [0, 1, 2, 3, 4, 5].map((k) => fill(k, filler));
      for (const d of docs) expect(d.length).toBeLessThanOrEqual(RECORD_DOC_MAX_BYTES);
      // A pre-check document with every field at its longest: all six held from the index.
      const pre = canonicalBytes({
        v: '1',
        claimId,
        orderId,
        ruleVersion: '1',
        records: docs.map((d, k) => ({
          kind: String(k),
          outcome: 'held',
          seq: BIG,
          hcsHash: recordHash(d),
          cid: rawCidOfHash(recordHash(d)),
          payer: `0.0.${BIG}`,
          consensusAt: `${BIG}.999999999`,
          refsSeq: BIG,
          refsHash: `0x${'ef'.repeat(32)}`,
          refsReason: 'hash_mismatch_hcs',
        })),
        result: {
          gap: '255',
          answer: '1',
          side: 'platform',
          reasonKey: 'missing_record_platform',
          step: '2a-iii',
          flaggedCells: ATTRS.flatMap((attribute) => RECS.map((record) => ({ record, attribute }))),
          notCompared: ATTRS,
          unreadPrice: RECS,
        },
        gap: '255',
        answer: '1',
        reasonKey: 'no_gap_in_compared',
        reasonText: 'No difference was found between the records that could be compared, but some held attributes or records had no counterpart to compare with.',
      });
      const claim: ClaimToCourt = {
        ...built.claim,
        claimId,
        packHash: recordHash(pre),
        refs: { topicNum: 2n ** 64n - 1n, seq: [0n, 0n, 0n, 0n, 0n, 0n], hashes: [ZERO_HASH, ZERO_HASH, ZERO_HASH, ZERO_HASH, ZERO_HASH, ZERO_HASH] },
      };
      const e = buildEvidence({
        claim,
        attempt: 2,
        externalId: 2n ** 256n - 1n,
        records: docs.map((bytes, k) => ({ kind: k as RecordKind, bytes, cid: rawCidOfHash(recordHash(bytes)), hcsSeq: 2n ** 64n - 1n })),
        precheck: { bytes: pre, cid: rawCidOfHash(recordHash(pre)) },
        notice: 'TRIAL CASE: this case tests the court flow and moves no real money. '.repeat(2),
        fileURI: `/ipfs/${rawCidOfHash(recordHash(pre))}`,
      });
      expect(e.slots.every((s) => s.state === 'fromIndex')).toBe(true);
      largest = Math.max(largest, e.byteLength);
    }
    expect(largest).toBeGreaterThan(16 * 1024); // the old cap did not fit this
    expect(largest).toBeLessThanOrEqual(EVIDENCE_MAX_BYTES);
  });

  it('enforces the byte cap', () => {
    const notice = 'x'.repeat(EVIDENCE_MAX_BYTES);
    expect(() => buildEvidence(inputOf(built, { notice }))).toThrow(EvidenceTooLarge);
  });
});
