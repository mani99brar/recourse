// Gathers what the court evidence needs for one attempt and builds it with the shared evidence
// format: the decoded claim payload, the pre-check result document (found through the pre-check
// service, or by the raw-block CID of its hash) and each record document the pre-check held,
// every one checked against its hash before use. The keeper adds no text of its own.

import { DecodeStatus, sha256, tryDecodeClaimToCourt, type RecordKind } from '@recourse/shared';
import type { Hex } from 'viem';
import { getJson, type FetchLike } from './net.js';

export type EvidenceBuild =
  | { ok: true; text: string; sha256: Hex }
  | { ok: false; kind: 'transient' | 'hash_mismatch' | 'too_large' | 'input'; message: string };

export interface EvidenceRequest {
  claimId: Hex;
  payload: Hex;
  attempt: 1 | 2;
  externalId: bigint;
}

export interface EvidencePort {
  build(req: EvidenceRequest): Promise<EvidenceBuild>;
}

/** Shape of the builder from the court package, injected so tests can stand in for it. */
export type BuildEvidence = (input: {
  claim: NonNullable<ReturnType<typeof decodeOk>>;
  attempt: 1 | 2;
  externalId: bigint;
  records: { kind: RecordKind; bytes: Uint8Array; cid?: string; hcsSeq?: bigint }[];
  precheck: { bytes: Uint8Array; cid?: string };
}) => { evidence: string; sha256: Hex };

function decodeOk(payload: Hex) {
  const d = tryDecodeClaimToCourt(payload);
  return d.status === DecodeStatus.Ok ? d.value : undefined;
}

export interface AssemblerOptions {
  /** Base URL of the pre-check service (GET /results/:claimId gives the document's cid). */
  precheckUrl?: string;
  /** Fetches document bytes by CID (the IPFS gateway); null when not found. */
  fetchDoc: (cid: string) => Promise<Uint8Array | null>;
  /** CID of the raw block whose multihash is this SHA-256. */
  rawCidOfHash: (hash: Hex) => string;
  build: BuildEvidence;
  fetch?: FetchLike;
}

interface PrecheckRecord {
  kind?: string;
  outcome?: string;
  hcsHash?: string;
  cid?: string;
  seq?: string;
}

export function evidenceAssembler(o: AssemblerOptions): EvidencePort {
  const transient = (message: string): EvidenceBuild => ({ ok: false, kind: 'transient', message });

  async function precheckDoc(claimId: Hex, packHash: Hex): Promise<{ bytes: Uint8Array; cid: string } | EvidenceBuild> {
    const cids: string[] = [];
    if (o.precheckUrl) {
      try {
        const r = await getJson<{ cid?: string }>(`${o.precheckUrl.replace(/\/+$/, '')}/results/${claimId}`, { fetch: o.fetch });
        if (r && typeof r.cid === 'string' && r.cid !== '') cids.push(r.cid);
      } catch {
        // fall through to the hash-derived CID
      }
    }
    cids.push(o.rawCidOfHash(packHash));
    let lastProblem = 'pre-check document not found';
    for (const cid of cids) {
      let bytes: Uint8Array | null;
      try {
        bytes = await o.fetchDoc(cid);
      } catch (err) {
        lastProblem = `pre-check document fetch failed: ${err instanceof Error ? err.message : String(err)}`;
        continue;
      }
      if (bytes === null) continue;
      if (sha256(bytes).toLowerCase() !== packHash.toLowerCase()) {
        lastProblem = `pre-check document at ${cid} does not hash to the payload packHash`;
        continue;
      }
      return { bytes, cid };
    }
    return transient(lastProblem);
  }

  return {
    async build(req) {
      const claim = decodeOk(req.payload);
      if (claim === undefined) return { ok: false, kind: 'input', message: 'payload does not decode as ClaimToCourt' };
      const pre = await precheckDoc(req.claimId, claim.packHash);
      if ('ok' in pre) return pre;
      let doc: { records?: PrecheckRecord[] };
      try {
        doc = JSON.parse(new TextDecoder().decode(pre.bytes)) as { records?: PrecheckRecord[] };
      } catch {
        return { ok: false, kind: 'input', message: 'pre-check document is not JSON' };
      }
      const records: { kind: RecordKind; bytes: Uint8Array; cid?: string; hcsSeq?: bigint }[] = [];
      for (let k = 0; k < 6; k++) {
        const r = doc.records?.[k];
        if (r?.outcome !== 'held') continue;
        if (typeof r.cid !== 'string' || typeof r.hcsHash !== 'string') {
          return { ok: false, kind: 'input', message: `pre-check slot ${k} is held without cid and hash` };
        }
        let bytes: Uint8Array | null;
        try {
          bytes = await o.fetchDoc(r.cid);
        } catch (err) {
          return transient(`record ${k} fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (bytes === null) return transient(`record ${k} not found at ${r.cid}`);
        if (sha256(bytes).toLowerCase() !== r.hcsHash.toLowerCase()) return transient(`record ${k} at ${r.cid} does not match its hash`);
        records.push({ kind: k as RecordKind, bytes, cid: r.cid, ...(r.seq ? { hcsSeq: BigInt(r.seq) } : {}) });
      }
      try {
        const bundle = o.build({ claim, attempt: req.attempt, externalId: req.externalId, records, precheck: pre });
        return { ok: true, text: bundle.evidence, sha256: bundle.sha256 };
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        const message = err instanceof Error ? err.message : String(err);
        // Matched by name so the builder can be swapped without importing its classes here.
        if (name === 'EvidenceHashMismatch') return { ok: false, kind: 'hash_mismatch', message };
        if (name === 'EvidenceTooLarge') return { ok: false, kind: 'too_large', message };
        return { ok: false, kind: 'input', message };
      }
    },
  };
}
