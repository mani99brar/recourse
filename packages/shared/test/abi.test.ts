import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { toFunctionSelector, toEventSelector, type AbiEvent, type AbiFunction } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  addressBook,
  ccipOffRampAbi,
  disputeKitClassicAbi,
  evidenceModuleAbi,
  klerosCoreAbi,
  sortitionModuleAbi,
} from '../src/index.js';

// The pinned packages are the oracle: each fragment item must equal an item of the package ABI.
const root = (p: string) => fileURLToPath(new URL(`../../../node_modules/${p}`, import.meta.url));
const require = createRequire(import.meta.url);
const kleros = (require(root('@kleros/kleros-v2-contracts/cjs/deployments/arbitrumSepolia.js')) as {
  default: { chainId: string; contracts: Record<string, { address: string; abi: unknown[] }> };
}).default;
const offRamp = JSON.parse(readFileSync(root('@chainlink/contracts-ccip/abi/v2_0_0/offramp.json'), 'utf8')) as unknown[];

type Item = AbiFunction | AbiEvent;

function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (typeof v !== 'object' || v === null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (k !== 'internalType') out[k] = strip(x);
  return out;
}

const signature = (x: Item) => (x.type === 'function' ? toFunctionSelector(x) : toEventSelector(x));

function expectFromPackage(fragment: readonly Item[], source: unknown[]) {
  const pkg = (strip(source) as Item[]).filter((x) => x.type === 'function' || x.type === 'event');
  for (const item of fragment) {
    const match = pkg.find((x) => x.type === item.type && signature(x) === signature(item));
    expect(match, `${item.type} ${item.name}`).toBeDefined();
    expect(item).toEqual(match);
  }
  expect(new Set(fragment.map(signature)).size).toBe(fragment.length);
}

describe('outside-contract ABI fragments', () => {
  it('Kleros fragments equal the 0.12.0 Arbitrum Sepolia deployment ABIs', () => {
    expect(kleros.chainId).toBe('421614');
    expectFromPackage(klerosCoreAbi, kleros.contracts.KlerosCore!.abi);
    expectFromPackage(sortitionModuleAbi, kleros.contracts.SortitionModule!.abi);
    expectFromPackage(evidenceModuleAbi, kleros.contracts.EvidenceModule!.abi);
    expectFromPackage(disputeKitClassicAbi, kleros.contracts.DisputeKitClassic!.abi);
  });

  it('the OffRamp fragment equals the contracts-ccip 2.0.0 OffRamp ABI', () => {
    expectFromPackage(ccipOffRampAbi, offRamp);
    expect(toFunctionSelector(ccipOffRampAbi[0])).toBe(toFunctionSelector('getExecutionState(bytes32)'));
  });

  it('the evidence call and event have the shapes the court relies on', () => {
    expect(toFunctionSelector(evidenceModuleAbi[0])).toBe(toFunctionSelector('submitEvidence(uint256,string)'));
    expect(toEventSelector(evidenceModuleAbi[1])).toBe(toEventSelector('Evidence(uint256,address,string)'));
  });

  it('the address book matches the package deployment', () => {
    const a = (name: string) => kleros.contracts[name]!.address;
    const arb = addressBook.arbitrum;
    expect([arb.klerosCore, arb.evidenceModule, arb.disputeKitClassic, arb.sortitionModule]).toEqual([
      a('KlerosCore'),
      a('EvidenceModule'),
      a('DisputeKitClassic'),
      a('SortitionModule'),
    ]);
    expect([arb.disputeTemplateRegistry, arb.disputeResolver, arb.pnk, arb.pnkFaucet]).toEqual([
      a('DisputeTemplateRegistry'),
      a('DisputeResolver'),
      a('PNK'),
      a('PNKFaucet'),
    ]);
  });
});
