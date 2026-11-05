import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { claimIdOf, externalIdOf, externalIdUint, newOrderNonce, orderIdOf } from '../src/index.js';
import { vector } from './vectors.js';

// Expected values in ids.json were computed with `cast keccak $(cast abi-encode ...)`.
const v = vector('ids.json');

describe('ids', () => {
  it('orderIdOf', () => {
    const o = v.orderId;
    expect(orderIdOf(o.platform as Address, o.shop as Address, o.orderNonce as Hex)).toBe(o.expected);
  });

  it('claimIdOf', () => {
    for (const c of v.claimId) expect(claimIdOf(BigInt(c.chainId), c.claims, c.orderId)).toBe(c.expected);
  });

  it('externalIdOf and its uint form', () => {
    for (const e of v.externalId) {
      expect(externalIdOf(BigInt(e.chainId), e.recourseCase, e.claimId, e.attempt)).toBe(e.expected);
      expect(externalIdUint(BigInt(e.chainId), e.recourseCase, e.claimId, e.attempt)).toBe(BigInt(e.expectedUint));
    }
    expect(() => externalIdOf(1, v.externalId[0].recourseCase, v.externalId[0].claimId, 3)).toThrow();
  });

  it('newOrderNonce gives 32 fresh random bytes', () => {
    const a = newOrderNonce();
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(newOrderNonce()).not.toBe(a);
  });
});
