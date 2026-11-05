import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toEventSelector, type Abi } from 'viem';
import { describe, expect, it } from 'vitest';
import { claimsAbi } from '../src/abi/claims.js';
import { vaultAbi } from '../src/abi/vault.js';
import { caseAbi } from '../src/abi/case.js';

const dir = join(__dirname, '../../../deployments/abi');

function check(name: string, mine: Abi) {
  const file = join(dir, `${name}.json`);
  describe.skipIf(!existsSync(file))(`${name} ABI matches the deployed interface`, () => {
    const real = (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []) as Abi;
    const sel = (a: Abi) => new Map((a.filter((x) => x.type === 'event') as { name: string }[]).map((e) => [e.name, toEventSelector(e as never)]));
    const mineSel = sel(mine);
    const realSel = sel(real);
    it('every event I decode has the same signature on chain', () => {
      for (const [n, s] of mineSel) expect(realSel.get(n), n).toBe(s);
    });
    it('every event the contract emits is one I decode', () => {
      for (const n of realSel.keys()) expect(mineSel.has(n), n).toBe(true);
    });
    it('every view I call exists', () => {
      const names = new Set(((real as unknown) as { type: string; name?: string }[]).filter((x) => x.type === 'function').map((x) => x.name));
      for (const f of ((mine as unknown) as { type: string; name?: string }[]).filter((x) => x.type === 'function')) expect(names.has(f.name), f.name).toBe(true);
    });
  });
}
check('RecourseClaims', claimsAbi);
check('DepositVault', vaultAbi);
check('RecourseCase', caseAbi);
