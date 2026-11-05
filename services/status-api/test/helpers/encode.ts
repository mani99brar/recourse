// Builds raw logs from the same ABIs the decoder uses, so fixtures exercise the real decode path.
import { encodeAbiParameters, encodeEventTopics, type Abi, type AbiEvent, type Hex } from 'viem';
import { caseAbi } from '../../src/abi/case.js';
import { claimsAbi } from '../../src/abi/claims.js';
import { vaultAbi } from '../../src/abi/vault.js';
import { padTimestamp } from '../../src/decode.js';
import type { Chain, ContractName, RawLog } from '../../src/types.js';

const ABIS: Record<ContractName, Abi> = { claims: claimsAbi, vault: vaultAbi, case: caseAbi };

export function encodeLog(contract: ContractName, name: string, args: Record<string, unknown>): { topics: Hex[]; data: Hex } {
  const abi = ABIS[contract];
  const item = abi.find((x) => x.type === 'event' && x.name === name) as AbiEvent | undefined;
  if (!item) throw new Error(`no event ${name}`);
  const indexedArgs: Record<string, unknown> = {};
  for (const i of item.inputs) if (i.indexed) indexedArgs[i.name!] = args[i.name!];
  const topics = (encodeEventTopics as unknown as (a: unknown) => Hex[])({ abi: [item], eventName: name, args: indexedArgs });
  const rest = item.inputs.filter((i) => !i.indexed);
  const data = rest.length ? encodeAbiParameters(rest, rest.map((i) => args[i.name!])) : ('0x' as Hex);
  return { topics, data };
}

let txCounter = 0;
export function nextTx(): Hex {
  txCounter++;
  return ('0x' + txCounter.toString(16).padStart(64, '0')) as Hex;
}

export interface SimLog {
  chain: Chain;
  contract: ContractName;
  raw: RawLog;
  /** Mirror-style timestamp for Hedera logs. */
  ts: string;
}

/** Collects logs of a scenario with a clock; Hedera logs get consensus timestamps, Arbitrum logs block numbers. */
export class Sim {
  logs: SimLog[] = [];
  private block = 1000n;
  private index = 0;
  constructor(public t = 1_700_000_000n) {}

  at(t: bigint): this {
    this.t = t;
    return this;
  }
  tick(dt: bigint | number): this {
    this.t += BigInt(dt);
    return this;
  }

  emit(chain: Chain, contract: ContractName, name: string, args: Record<string, unknown>, opts: { tx?: Hex; address?: `0x${string}` } = {}): this {
    const { topics, data } = encodeLog(contract, name, args);
    const tx = opts.tx ?? nextTx();
    const logIndex = this.index++;
    const ts = `${this.t}.${String(logIndex).padStart(9, '0')}`;
    if (chain === 'hedera') {
      this.logs.push({
        chain,
        contract,
        ts,
        raw: { address: opts.address ?? '0x0000000000000000000000000000000000000001', topics, data, tx, logIndex, time: this.t, order: `${padTimestamp(ts)}:${String(logIndex).padStart(6, '0')}` },
      });
    } else {
      this.block += 1n;
      this.logs.push({
        chain,
        contract,
        ts,
        raw: { address: opts.address ?? '0x0000000000000000000000000000000000000002', topics, data, tx, logIndex, time: this.t, order: `${this.block.toString().padStart(12, '0')}:${String(logIndex).padStart(6, '0')}`, block: this.block },
      });
    }
    return this;
  }
  hedera(contract: 'claims' | 'vault', name: string, args: Record<string, unknown>): this {
    return this.emit('hedera', contract, name, args);
  }
  arb(name: string, args: Record<string, unknown>): this {
    return this.emit('arbitrum', 'case', name, args);
  }
}
