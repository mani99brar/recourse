import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { addressBook, chainSelectorOf } from '../src/index.js';

describe('address book', () => {
  it('holds checksummed EVM addresses', () => {
    for (const chain of [addressBook.hedera, addressBook.arbitrum]) {
      for (const [key, value] of Object.entries(chain)) {
        if (typeof value === 'string' && value.startsWith('0x') && value.length === 42 && key !== 'facade') {
          expect(getAddress(value), key).toBe(value);
        }
      }
    }
  });

  it('maps chain ids to CCIP selectors', () => {
    expect(chainSelectorOf(296)).toBe(222782988166878823n);
    expect(chainSelectorOf(421614)).toBe(3478487238524512106n);
    expect(() => chainSelectorOf(1)).toThrow();
  });
});
