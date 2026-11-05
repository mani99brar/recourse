// The chain events the docket follows, as fragments typed from the interface file, and the
// normalised shape the rest of the service works with. Replace the fragments with the deployed
// ABIs when they are published; the normalised events do not change.

import { decodeEventLog, getAddress, type Hex } from 'viem';

export const claimsEventsAbi = [
  { type: 'event', name: 'ClaimFiled', inputs: [
    { name: 'claimId', type: 'bytes32', indexed: true },
    { name: 'orderId', type: 'bytes32', indexed: false },
    { name: 'shop', type: 'address', indexed: true },
    { name: 'platform', type: 'address', indexed: true },
    { name: 'refs', type: 'tuple', indexed: false, components: [
      { name: 'topicNum', type: 'uint64' },
      { name: 'seq', type: 'uint64[6]' },
      { name: 'hashes', type: 'bytes32[6]' },
    ] },
    { name: 'basketUsdc', type: 'uint256', indexed: false },
    { name: 'netLossUsdc', type: 'uint256', indexed: false },
    { name: 'filedAt', type: 'uint64', indexed: false },
  ] },
  { type: 'event', name: 'PreCheckRecorded', inputs: [
    { name: 'claimId', type: 'bytes32', indexed: true },
    { name: 'gap', type: 'uint8', indexed: false },
    { name: 'answer', type: 'uint8', indexed: false },
    { name: 'packHash', type: 'bytes32', indexed: false },
  ] },
  { type: 'event', name: 'ClosedUncontested', inputs: [
    { name: 'claimId', type: 'bytes32', indexed: true },
    { name: 'answer', type: 'uint8', indexed: false },
    { name: 'toShop', type: 'uint256', indexed: false },
  ] },
  { type: 'event', name: 'RulingReceived', inputs: [
    { name: 'claimId', type: 'bytes32', indexed: true },
    { name: 'disputeId', type: 'uint256', indexed: false },
    { name: 'ruling', type: 'uint8', indexed: false },
    { name: 'attempts', type: 'uint8', indexed: false },
    { name: 'messageId', type: 'bytes32', indexed: false },
  ] },
  { type: 'event', name: 'Settled', inputs: [
    { name: 'claimId', type: 'bytes32', indexed: true },
    { name: 'outcome', type: 'uint8', indexed: false },
    { name: 'toShop', type: 'uint256', indexed: false },
    { name: 'toPool', type: 'uint256', indexed: false },
  ] },
  { type: 'event', name: 'ClaimExpired', inputs: [{ name: 'claimId', type: 'bytes32', indexed: true }] },
] as const;

export const vaultEventsAbi = [
  { type: 'event', name: 'OutcomeApplied', inputs: [
    { name: 'claimId', type: 'bytes32', indexed: true },
    { name: 'platform', type: 'address', indexed: true },
    { name: 'shop', type: 'address', indexed: true },
    { name: 'paid', type: 'uint256', indexed: false },
    { name: 'refund', type: 'uint256', indexed: false },
    { name: 'toPool', type: 'uint256', indexed: false },
  ] },
  { type: 'event', name: 'Shortfall', inputs: [
    { name: 'claimId', type: 'bytes32', indexed: true },
    { name: 'platform', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false },
  ] },
] as const;

export const caseEventsAbi = [
  { type: 'event', name: 'CaseOpened', inputs: [
    { name: 'claimId', type: 'bytes32', indexed: true },
    { name: 'disputeId', type: 'uint256', indexed: false },
    { name: 'attempt', type: 'uint8', indexed: false },
  ] },
] as const;

export type Chain = 'hedera' | 'arbitrum';

/** Where an event came from; `ts` is the chain's own time in unix seconds. */
export interface EventMeta {
  chain: Chain;
  tx: string;
  index: number;
  ts: number;
}

export type EventBody =
  | { name: 'ClaimFiled'; claimId: Hex; shop: string; platform: string; filedAt: number }
  | { name: 'PreCheckRecorded'; claimId: Hex; gap: number; answer: number }
  | { name: 'ClosedUncontested'; claimId: Hex }
  | { name: 'ClaimExpired'; claimId: Hex }
  | { name: 'ClosedUndrawn'; claimId: Hex }
  | { name: 'RulingReceived'; claimId: Hex; disputeId: string; ruling: number; attempts: number }
  | { name: 'Settled'; claimId: Hex }
  | { name: 'OutcomeApplied'; claimId: Hex; paid: string; refund: string; toPool: string }
  | { name: 'Shortfall'; claimId: Hex; amount: string }
  | { name: 'CaseOpened'; claimId: Hex; disputeId: string; attempt: number };

export type DocketEvent = EventMeta & EventBody;

export function eventKey(e: EventMeta): string {
  return `${e.chain}:${e.tx.toLowerCase()}:${e.index}`;
}

export interface RawLog {
  topics: readonly string[];
  data: string;
}

/** Decodes a log from the claims, vault or case contract; null for an event the docket ignores. */
export function decodeDocketLog(chain: Chain, meta: Omit<EventMeta, 'chain'>, log: RawLog): DocketEvent | null {
  const abi = chain === 'arbitrum' ? caseEventsAbi : ([...claimsEventsAbi, ...vaultEventsAbi] as const);
  let decoded: { eventName?: string; args?: unknown };
  try {
    decoded = decodeEventLog({ abi: abi as never, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex }) as never;
  } catch {
    return null;
  }
  const a = (decoded.args ?? {}) as Record<string, unknown>;
  const base = { chain, ...meta };
  const id = String(a.claimId).toLowerCase() as Hex;
  switch (decoded.eventName) {
    case 'ClaimFiled':
      return { ...base, name: 'ClaimFiled', claimId: id, shop: getAddress(a.shop as string), platform: getAddress(a.platform as string), filedAt: Number(a.filedAt) };
    case 'PreCheckRecorded':
      return { ...base, name: 'PreCheckRecorded', claimId: id, gap: Number(a.gap), answer: Number(a.answer) };
    case 'ClosedUncontested':
      return { ...base, name: 'ClosedUncontested', claimId: id };
    case 'ClaimExpired':
      return { ...base, name: 'ClaimExpired', claimId: id };
    case 'RulingReceived':
      return { ...base, name: 'RulingReceived', claimId: id, disputeId: String(a.disputeId), ruling: Number(a.ruling), attempts: Number(a.attempts) };
    case 'Settled':
      return { ...base, name: 'Settled', claimId: id };
    case 'OutcomeApplied':
      return { ...base, name: 'OutcomeApplied', claimId: id, paid: String(a.paid), refund: String(a.refund), toPool: String(a.toPool) };
    case 'Shortfall':
      return { ...base, name: 'Shortfall', claimId: id, amount: String(a.amount) };
    case 'CaseOpened':
      return { ...base, name: 'CaseOpened', claimId: id, disputeId: String(a.disputeId), attempt: Number(a.attempt) };
    default:
      return null;
  }
}
