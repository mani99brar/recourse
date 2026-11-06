import { describe, expect, it } from 'vitest';
import { CIRCLE_VAULT_TOKEN, addressBook, vaultTokenOf } from '../src/index.js';

const MOCK = '0x1111111111111111111111111111111111111111';
const FACADE = addressBook.hedera.usdc.facade;
const circle = { mode: 'circle', address: FACADE, decimals: 6, tokenId: '0.0.429274' };
const mock = { mode: 'mock', address: MOCK, decimals: 6, tokenId: null };

describe('vault token', () => {
  it('is Circle USDC for a record with no usdc key, or no record', () => {
    for (const record of [{}, { chainId: 296 }, null, undefined]) {
      expect(vaultTokenOf(record)).toEqual({
        mode: 'circle',
        address: '0x0000000000000000000000000000000000068cDa',
        decimals: 6,
        tokenId: '0.0.429274',
        symbol: 'USDC',
        label: 'USDC',
      });
    }
  });

  it('reads circle mode, in any address case', () => {
    expect(vaultTokenOf({ usdc: circle })).toEqual(CIRCLE_VAULT_TOKEN);
    expect(vaultTokenOf({ usdc: { ...circle, address: FACADE.toLowerCase() } })).toEqual(CIRCLE_VAULT_TOKEN);
  });

  it('reads mock mode with its own address and label', () => {
    expect(vaultTokenOf({ usdc: { ...mock, address: MOCK.toLowerCase() } })).toEqual({
      mode: 'mock',
      address: MOCK,
      decimals: 6,
      tokenId: null,
      symbol: 'mUSDC',
      label: 'mUSDC (testnet mock)',
    });
  });

  it('refuses a mode other than circle or mock', () => {
    expect(() => vaultTokenOf({ usdc: { ...mock, mode: 'hts' } })).toThrow('mode must be circle or mock');
    expect(() => vaultTokenOf({ usdc: { ...mock, mode: undefined } })).toThrow('mode must be circle or mock');
    expect(() => vaultTokenOf({ usdc: null })).toThrow('expected an object');
    expect(() => vaultTokenOf({ usdc: 'mock' })).toThrow('expected an object');
  });

  it('refuses a circle record that is not Circle USDC', () => {
    expect(() => vaultTokenOf({ usdc: { ...circle, address: MOCK } })).toThrow("must name Circle's facade");
    expect(() => vaultTokenOf({ usdc: { ...circle, tokenId: null } })).toThrow('must name token 0.0.429274');
    expect(() => vaultTokenOf({ usdc: { ...circle, tokenId: '0.0.1' } })).toThrow('must name token 0.0.429274');
  });

  it('refuses a mock with a token id or without a 0x address', () => {
    expect(() => vaultTokenOf({ usdc: { ...mock, tokenId: '0.0.429274' } })).toThrow('tokenId must be null');
    expect(() => vaultTokenOf({ usdc: { ...mock, tokenId: undefined } })).toThrow('tokenId must be null');
    for (const address of [undefined, '', '0x1234', MOCK.slice(2), `${MOCK}00`, 7]) {
      expect(() => vaultTokenOf({ usdc: { ...mock, address } })).toThrow('address must be a 0x address');
    }
  });

  it("refuses a mock at Circle's facade or the zero address", () => {
    for (const address of [FACADE, FACADE.toLowerCase()]) {
      expect(() => vaultTokenOf({ usdc: { ...mock, address } })).toThrow("mock mode cannot name Circle's facade");
    }
    expect(() => vaultTokenOf({ usdc: { ...mock, address: `0x${'0'.repeat(40)}` } })).toThrow('cannot name the zero address');
  });

  it('refuses a mock whose tokenId is any string, even one that reads like null', () => {
    for (const tokenId of ['<null>', 'null', '']) {
      expect(() => vaultTokenOf({ usdc: { ...mock, tokenId } })).toThrow('tokenId must be null');
    }
  });

  it('refuses anything but 6 decimals', () => {
    expect(() => vaultTokenOf({ usdc: { ...mock, decimals: 18 } })).toThrow('decimals must be 6');
    expect(() => vaultTokenOf({ usdc: { ...mock, decimals: '6' } })).toThrow('decimals must be 6');
    expect(() => vaultTokenOf({ usdc: { ...circle, decimals: undefined } })).toThrow('decimals must be 6');
    // JSON 6.0 parses to the number 6, so a record that writes it is accepted (the bash reader agrees).
    expect(vaultTokenOf(JSON.parse(`{"usdc":{"mode":"mock","address":"${MOCK}","decimals":6.0,"tokenId":null}}`)).mode).toBe('mock');
  });

  it('leaves the address book on Circle USDC', () => {
    expect(addressBook.hedera.usdc).toEqual({ tokenId: '0.0.429274', facade: '0x0000000000000000000000000000000000068cDa', decimals: 6 });
  });
});
