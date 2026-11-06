// The token the deposit vault holds, from the Hedera deployment record's `usdc` object. Every
// vault-side reader takes the token from here, so one deployment never mixes tokens: either Circle's
// testnet USDC (an HTS token with a mirror-node id and an ERC-20 facade) or the testnet mock, a plain
// ERC-20 with no HTS id, read by `balanceOf` over JSON-RPC and needing no association. A record with
// no `usdc` object is on Circle's USDC. The x402 price asset is a separate matter (priceAsset.ts).

import { getAddress, isAddress, zeroAddress, type Address } from 'viem';
import { addressBook } from './addresses.js';

export type VaultTokenMode = 'circle' | 'mock';

export interface VaultToken {
  mode: VaultTokenMode;
  /** The ERC-20 the vault holds: Circle's HTS facade, or the mock's contract. Checksummed. */
  address: Address;
  decimals: 6;
  /** HTS token id `0.0.N`; null for the mock, which has no mirror-node token rows. */
  tokenId: string | null;
  symbol: 'USDC' | 'mUSDC';
  /** The name shown beside vault amounts. */
  label: 'USDC' | 'mUSDC (testnet mock)';
}

export const CIRCLE_VAULT_TOKEN: VaultToken = Object.freeze({
  mode: 'circle',
  address: addressBook.hedera.usdc.facade,
  decimals: 6,
  tokenId: addressBook.hedera.usdc.tokenId,
  symbol: 'USDC',
  label: 'USDC',
});

function fail(why: string): never {
  throw new Error(`deployment usdc: ${why}`);
}

/**
 * The vault token of a Hedera deployment record (the parsed `hedera.json`, or null when there is
 * none): `usdc.mode` circle or mock, `decimals` 6; a mock names its own 0x address (never Circle's
 * facade or zero) and a null `tokenId`; circle must name Circle's facade and token id. A missing
 * `usdc` key is circle.
 * Throws on anything else, naming the field.
 */
export function vaultTokenOf(record: object | null | undefined): VaultToken {
  const usdc = (record as { usdc?: unknown } | null | undefined)?.usdc;
  if (usdc === undefined) return CIRCLE_VAULT_TOKEN;
  if (typeof usdc !== 'object' || usdc === null || Array.isArray(usdc)) fail('expected an object');
  const u = usdc as Record<string, unknown>;
  if (u.mode !== 'circle' && u.mode !== 'mock') fail(`mode must be circle or mock, not ${JSON.stringify(u.mode)}`);
  if (u.decimals !== 6) fail(`decimals must be 6, not ${JSON.stringify(u.decimals)}`);
  if (typeof u.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(u.address) || !isAddress(u.address, { strict: false })) {
    fail(`address must be a 0x address, not ${JSON.stringify(u.address)}`);
  }
  const address = getAddress(u.address);
  if (u.mode === 'circle') {
    if (address !== CIRCLE_VAULT_TOKEN.address) fail(`circle mode must name Circle's facade ${CIRCLE_VAULT_TOKEN.address}, not ${address}`);
    if (u.tokenId !== CIRCLE_VAULT_TOKEN.tokenId) fail(`circle mode must name token ${CIRCLE_VAULT_TOKEN.tokenId}, not ${JSON.stringify(u.tokenId)}`);
    return CIRCLE_VAULT_TOKEN;
  }
  if (u.tokenId !== null) fail(`mock mode has no HTS token id; tokenId must be null, not ${JSON.stringify(u.tokenId)}`);
  // Circle's facade under a mock label would skip its mirror association checks.
  if (address === CIRCLE_VAULT_TOKEN.address) fail(`mock mode cannot name Circle's facade ${address}`);
  if (address === zeroAddress) fail('mock mode cannot name the zero address');
  return { mode: 'mock', address, decimals: 6, tokenId: null, symbol: 'mUSDC', label: 'mUSDC (testnet mock)' };
}
