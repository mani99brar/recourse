// The keeper's hand-written fragments must match the ABIs the contracts build: same names, same
// argument types, same indexed flags, same return types. Every error in a contract's ABI must be
// decodable by the keeper.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { caseAbi, claimsAbi, knownErrorsAbi, vaultAbi } from '../src/abi.js';

interface Param {
  type: string;
  indexed?: boolean;
  components?: readonly Param[];
}
interface Item {
  type: string;
  name?: string;
  inputs?: readonly Param[];
  outputs?: readonly Param[];
  stateMutability?: string;
}

function typeOf(p: Param): string {
  if (p.type.startsWith('tuple')) return `(${(p.components ?? []).map(typeOf).join(',')})${p.type.slice('tuple'.length)}`;
  return p.type;
}

function shape(x: Item): string {
  const ins = (x.inputs ?? []).map((p) => `${typeOf(p)}${x.type === 'event' && p.indexed ? ' indexed' : ''}`).join(',');
  const outs = x.type === 'function' ? ` -> (${(x.outputs ?? []).map(typeOf).join(',')}) ${x.stateMutability}` : '';
  return `${x.type} ${x.name}(${ins})${outs}`;
}

const root = join(import.meta.dirname, '..', '..', '..', 'deployments', 'abi');
const load = (file: string): Item[] => JSON.parse(readFileSync(join(root, file), 'utf8')) as Item[];

const pairs: [string, readonly Item[], string][] = [
  ['RecourseClaims', claimsAbi as readonly Item[], 'RecourseClaims.json'],
  ['DepositVault', vaultAbi as readonly Item[], 'DepositVault.json'],
  // Kleros events listed on the case contract for log decoding are not part of its own ABI.
  ['RecourseCase', (caseAbi as readonly Item[]).filter((x) => x.name !== 'DisputeRequest' && x.name !== 'Ruling'), 'RecourseCase.json'],
];

describe('ABI fragments match the generated ABIs', () => {
  for (const [name, mine, file] of pairs) {
    it(`${name}: every fragment exists with the same shape`, () => {
      const built = new Set(load(file).filter((x) => x.type !== 'constructor').map(shape));
      const shapes = mine.filter((x) => x.type !== 'struct').map(shape);
      expect(shapes.length).toBeGreaterThan(1);
      expect(shapes.filter((s) => !built.has(s))).toEqual([]);
    });
  }

  it('every contract error decodes', () => {
    const known = new Set((knownErrorsAbi as readonly Item[]).map(shape));
    const errors = ['RecourseClaims.json', 'RecourseCase.json'].flatMap((f) => load(f).filter((x) => x.type === 'error').map(shape));
    expect(errors.filter((e) => !known.has(e))).toEqual([]);
  });

  it('the case contract emits the Kleros arbitrable events with these shapes', () => {
    const built = new Set(load('RecourseCase.json').map(shape));
    for (const ev of (caseAbi as readonly Item[]).filter((x) => x.name === 'DisputeRequest' || x.name === 'Ruling')) {
      expect(built.has(shape(ev)), shape(ev)).toBe(true);
    }
  });
});
