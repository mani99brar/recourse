import { decodeEventLog, type Abi, type Hex } from 'viem';
import { caseAbi } from './abi/case.js';
import { claimsAbi } from './abi/claims.js';
import { vaultAbi } from './abi/vault.js';
import type { Chain, ContractName, IndexedEvent, RawLog } from './types.js';

const ABIS: Record<ContractName, Abi> = { claims: claimsAbi, vault: vaultAbi, case: caseAbi };

/** Decodes one log of a known contract. Returns null when the log does not match its ABI. */
export function decodeLog(chain: Chain, contract: ContractName, raw: RawLog): IndexedEvent | null {
  try {
    const d = decodeEventLog({ abi: ABIS[contract], topics: raw.topics as unknown as [Hex, ...Hex[]], data: raw.data, strict: true });
    const args = (d.args ?? {}) as Record<string, unknown>;
    const event: IndexedEvent = {
      key: `${chain}:${raw.tx}:${raw.logIndex}`,
      chain,
      contract,
      name: String(d.eventName),
      args,
      tx: raw.tx,
      logIndex: raw.logIndex,
      time: raw.time,
      order: raw.order,
    };
    if (raw.block !== undefined) event.block = raw.block;
    return event;
  } catch {
    return null;
  }
}

/** Sort key across both chains: time, then chain, then position on the chain. */
export function compareEvents(a: IndexedEvent, b: IndexedEvent): number {
  if (a.time !== b.time) return a.time < b.time ? -1 : 1;
  if (a.chain !== b.chain) return a.chain < b.chain ? -1 : 1;
  return a.order < b.order ? -1 : a.order > b.order ? 1 : 0;
}

/** `sec.nanos` mirror timestamp to a sortable fixed-width text. */
export function padTimestamp(ts: string): string {
  const [s = '0', n = '0'] = ts.split('.');
  return `${s.padStart(12, '0')}.${n.padEnd(9, '0').slice(0, 9)}`;
}

export function secondsOf(ts: string): bigint {
  return BigInt(ts.split('.')[0] ?? '0');
}
