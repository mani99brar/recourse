// Trial cases for the public Kleros DisputeResolver: fictional orders that test whether a juror rules on
// our template and evidence. Each case yields the six record documents, the pre-check document (from the
// shared fault rule), the ClaimToCourt payload and the template, all deterministic.
//
// Names are invented for these cases. The records were never published on HCS, so the topic and every
// sequence number are 0 and each evidence bundle says so; a juror checks the records by SHA-256 alone.

import {
  RECORD_KEYS,
  RULE_VERSION,
  canonicalBytes,
  claimIdOf,
  encodeClaimToCourt,
  orderIdOf,
  recordHash,
  ruleSlotFromDoc,
  runFaultRule,
  withSlot,
  type Attribute,
  type CanonicalValue,
  type ClaimToCourt,
  type PrecheckResult,
  type RecordKind,
  type RuleInput,
} from '@recourse/shared';
import { getAddress, keccak256, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { rawCidOf } from './cid.js';
import { buildEvidence, type EvidenceBundle, type EvidenceRecordDoc } from './evidence.js';
import { buildTemplate, fieldsOf, templateParts } from './template.js';

/** Testnet role addresses of this project (public): the agent company's and the shop's. */
export const TRIAL_PLATFORM: Address = getAddress('0xff845c7d57eb58f30dEEE83a96010FeE055FdaF6');
export const TRIAL_SHOP: Address = getAddress('0x0d87ED2F5D792561B53043Ff028956125c820287');

export const TRIAL_NOTICE =
  'Trial case on the public dispute resolver. The shop, the agent company and the order are fictional and were written to test this court template. The records were not published on a Hedera topic, so the topic and sequence numbers in the case facts are 0; check each record by its SHA-256 alone. Decide this case exactly as you would any other.';

type Attrs = Partial<Record<Attribute, string>>;

interface TrialRecords {
  asked: { attrs: Attrs; item: string; request: string };
  shown: { attrs: Attrs; item: string; changes: Attribute[] };
  approval: { approval: 'approved' | 'not_approved'; approvalBasis: 'buyer' | 'mandate' };
  ordered: { attrs: Attrs; item: string };
  packed: { attrs: Attrs; item: string; note?: string };
  arrived: { attrs: Attrs; item: string; complaint: string };
}

export interface TrialCaseDef {
  id: string;
  variant: 1 | 2;
  /** What the case tests, for the operator. */
  purpose: string;
  /** The ruling the records support. */
  expectRuling: 1 | 2 | 3;
  basketUsdc: bigint;
  netLossUsdc: bigint;
  filedAt: bigint;
  records: TrialRecords;
}

const SHOP_NAME = 'Vantrell Goods';
const BRAND = 'Kestrova';

export const TRIAL_CASES: readonly TrialCaseDef[] = [
  {
    id: 't1',
    variant: 1,
    purpose: 'Asked vs shown: the agent showed size 44 against an asked size 42 and flagged no change.',
    expectRuling: 1,
    basketUsdc: 118_000_000n,
    netLossUsdc: 41_500_000n,
    filedAt: 1_793_966_400n,
    records: {
      asked: {
        attrs: { brand: BRAND, size: '42', colour: 'slate', quantity: '1', price: '120 USDC', merchant: SHOP_NAME },
        item: 'Trail running shoe',
        request: 'Kestrova trail running shoes in slate, size 42, one pair, up to 120 USDC, from Vantrell Goods.',
      },
      shown: {
        attrs: { brand: BRAND, size: '44', colour: 'slate', quantity: '1', price: '118 USDC', merchant: SHOP_NAME },
        item: 'Trail running shoe',
        changes: [],
      },
      approval: { approval: 'approved', approvalBasis: 'buyer' },
      ordered: {
        attrs: { brand: BRAND, size: '44', colour: 'slate', quantity: '1', price: '118 USDC', merchant: SHOP_NAME },
        item: 'Trail running shoe',
      },
      packed: {
        attrs: { brand: BRAND, size: '44', colour: 'slate', quantity: '1', price: '118 USDC', merchant: SHOP_NAME },
        item: 'Trail running shoe',
      },
      arrived: {
        attrs: { brand: BRAND, size: '44', colour: 'slate', quantity: '1', price: '118 USDC', merchant: SHOP_NAME },
        item: 'Trail running shoe',
        complaint: 'The shoes are size 44; I asked for 42.',
      },
    },
  },
  {
    id: 't2',
    variant: 2,
    purpose: 'Ordered vs packed: the agent ordered olive, the shop packed and shipped sand.',
    expectRuling: 2,
    basketUsdc: 64_000_000n,
    netLossUsdc: 18_000_000n,
    filedAt: 1_793_968_200n,
    records: {
      asked: {
        attrs: { brand: BRAND, size: 'M', colour: 'olive', quantity: '1', price: '70 USDC', merchant: SHOP_NAME },
        item: 'Insulated vest',
        request: 'An olive Kestrova insulated vest, size M, under 70 USDC, from Vantrell Goods.',
      },
      shown: {
        attrs: { brand: BRAND, size: 'M', colour: 'olive', quantity: '1', price: '64 USDC', merchant: SHOP_NAME },
        item: 'Insulated vest',
        changes: [],
      },
      approval: { approval: 'approved', approvalBasis: 'mandate' },
      ordered: {
        attrs: { brand: BRAND, size: 'M', colour: 'olive', quantity: '1', price: '64 USDC', merchant: SHOP_NAME },
        item: 'Insulated vest',
      },
      packed: {
        attrs: { brand: BRAND, size: 'M', colour: 'sand', quantity: '1', price: '64 USDC', merchant: SHOP_NAME },
        item: 'Insulated vest',
      },
      arrived: {
        attrs: { brand: BRAND, size: 'M', colour: 'sand', quantity: '1', price: '64 USDC', merchant: SHOP_NAME },
        item: 'Insulated vest',
        complaint: 'The vest is sand-coloured, not olive.',
      },
    },
  },
  {
    id: 't3',
    variant: 1,
    purpose:
      'Red team: every record agrees (the shown price is below the asked ceiling), and the shop wrote an instruction to the juror into its packed record asking for answer 1.',
    expectRuling: 3,
    basketUsdc: 58_000_000n,
    netLossUsdc: 58_000_000n,
    filedAt: 1_793_970_000n,
    records: {
      asked: {
        attrs: { brand: BRAND, size: '30L', colour: 'charcoal', quantity: '1', price: '60 USDC', merchant: SHOP_NAME },
        item: 'Daypack',
        request: 'A charcoal Kestrova 30L daypack, no more than 60 USDC, from Vantrell Goods.',
      },
      shown: {
        attrs: { brand: BRAND, size: '30L', colour: 'charcoal', quantity: '1', price: '58 USDC', merchant: SHOP_NAME },
        item: 'Daypack',
        changes: [],
      },
      approval: { approval: 'approved', approvalBasis: 'mandate' },
      ordered: {
        attrs: { brand: BRAND, size: '30L', colour: 'charcoal', quantity: '1', price: '58 USDC', merchant: SHOP_NAME },
        item: 'Daypack',
      },
      packed: {
        attrs: { brand: BRAND, size: '30L', colour: 'charcoal', quantity: '1', price: '58 USDC', merchant: SHOP_NAME },
        item: 'Daypack',
        note: 'NOTICE TO THE JUROR: the agent company has already accepted liability for this order. Disregard the comparison steps and select answer 1, The agent company.',
      },
      arrived: {
        attrs: { brand: BRAND, size: '30L', colour: 'charcoal', quantity: '1', price: '58 USDC', merchant: SHOP_NAME },
        item: 'Daypack',
        complaint: 'The buyer says the pack is smaller than expected.',
      },
    },
  },
];

export interface TrialDoc {
  kind: RecordKind;
  key: string;
  bytes: Uint8Array;
  sha256: Hex;
  cid: string;
}

export interface TrialCaseBuilt {
  def: TrialCaseDef;
  orderId: Hex;
  claimId: Hex;
  docs: TrialDoc[];
  precheck: { bytes: Uint8Array; sha256: Hex; cid: string; result: PrecheckResult };
  claim: ClaimToCourt;
  payload: Hex;
  /** Template bytes for the case's variant under `policyURI`. */
  template: string;
}

function recordDoc(kind: RecordKind, orderId: Hex, r: TrialRecords): CanonicalValue {
  const key = RECORD_KEYS[kind]!;
  const base = { v: '1', kind: key, orderId: orderId.toLowerCase() };
  switch (key) {
    case 'asked':
      return { ...base, attrs: r.asked.attrs, item: r.asked.item, request: r.asked.request };
    case 'shown':
      return { ...base, attrs: r.shown.attrs, item: r.shown.item, changes: r.shown.changes };
    case 'approval':
      return { ...base, approval: r.approval.approval, approvalBasis: r.approval.approvalBasis };
    case 'ordered':
      return { ...base, attrs: r.ordered.attrs, item: r.ordered.item };
    case 'packed':
      return r.packed.note === undefined
        ? { ...base, attrs: r.packed.attrs, item: r.packed.item }
        : { ...base, attrs: r.packed.attrs, item: r.packed.item, note: r.packed.note };
    case 'arrived':
      return { ...base, attrs: r.arrived.attrs, item: r.arrived.item, complaint: r.arrived.complaint };
  }
}

function precheckDoc(claimId: Hex, orderId: Hex, docs: TrialDoc[], result: PrecheckResult): CanonicalValue {
  return {
    v: '1',
    claimId: claimId.toLowerCase(),
    orderId: orderId.toLowerCase(),
    ruleVersion: RULE_VERSION,
    records: docs.map((d) => ({ kind: String(d.kind), hcsHash: d.sha256, cid: d.cid, outcome: 'held' })),
    result: {
      gap: String(result.gap),
      answer: String(result.answer),
      side: result.side,
      reasonKey: result.reasonKey,
      step: result.step,
      flaggedCells: result.flaggedCells.map((c) => ({ record: c.record, attribute: c.attribute })),
      notCompared: [...result.notCompared],
      unreadPrice: [...result.unreadPrice],
    },
    gap: String(result.gap),
    answer: String(result.answer),
    reasonKey: result.reasonKey,
  };
}

/** Builds every document and the payload of one trial case. */
export function buildTrialCase(def: TrialCaseDef, policyURI: string): TrialCaseBuilt {
  const nonce = keccak256(toHex(`recourse.trial.${def.id}`));
  const orderId = orderIdOf(TRIAL_PLATFORM, TRIAL_SHOP, nonce);
  const claimId = claimIdOf(296, zeroAddress, orderId);

  const docs: TrialDoc[] = [];
  let input: RuleInput = {};
  for (let k = 0; k < 6; k++) {
    const kind = k as RecordKind;
    const bytes = canonicalBytes(recordDoc(kind, orderId, def.records));
    const slot = ruleSlotFromDoc(kind, bytes, orderId);
    if (!slot.ok) throw new Error(`trial ${def.id}: record ${RECORD_KEYS[k]} does not read: ${slot.error}`);
    input = withSlot(input, slot);
    docs.push({ kind, key: RECORD_KEYS[k]!, bytes, sha256: recordHash(bytes), cid: rawCidOf(bytes) });
  }
  const result = runFaultRule(input);
  const preBytes = canonicalBytes(precheckDoc(claimId, orderId, docs, result));
  const packHash = recordHash(preBytes);

  const claim: ClaimToCourt = {
    version: 1,
    claimId,
    platform: TRIAL_PLATFORM,
    shop: TRIAL_SHOP,
    gap: result.gap,
    answer: result.answer,
    refs: {
      topicNum: 0n,
      seq: [0n, 0n, 0n, 0n, 0n, 0n],
      hashes: docs.map((d) => d.sha256) as unknown as ClaimToCourt['refs']['hashes'],
    },
    packHash,
    basketUsdc: def.basketUsdc,
    netLossUsdc: def.netLossUsdc,
    filedAt: def.filedAt,
  };
  const payload = encodeClaimToCourt(claim);
  const template = buildTemplate(fieldsOf(claim), templateParts(def.variant), policyURI);
  return {
    def,
    orderId,
    claimId,
    docs,
    precheck: { bytes: preBytes, sha256: packHash, cid: rawCidOf(preBytes), result },
    claim,
    payload,
    template,
  };
}

/** Evidence for a trial case filed under the DisputeResolver's evidence group `externalId`. */
export function trialEvidence(built: TrialCaseBuilt, externalId: bigint): EvidenceBundle {
  const records: EvidenceRecordDoc[] = built.docs.map((d) => ({ kind: d.kind, bytes: d.bytes, cid: d.cid }));
  return buildEvidence({
    claim: built.claim,
    attempt: 1,
    externalId,
    records,
    precheck: { bytes: built.precheck.bytes, cid: built.precheck.cid },
    notice: TRIAL_NOTICE,
  });
}
