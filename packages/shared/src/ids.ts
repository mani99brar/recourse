// Identifiers. Every id is keccak256 over `abi.encode` (never packed), so Solidity computes the
// same bytes with `keccak256(abi.encode(...))`.

import { encodeAbiParameters, hexToBigInt, keccak256, type Address, type Hex } from 'viem';

export const ORDER_ID_TAG = 'recourse.order.v1';

/** keccak256(abi.encode(string "recourse.order.v1", address platform, address shop, bytes32 orderNonce)). */
export function orderIdOf(platform: Address, shop: Address, orderNonce: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }],
      [ORDER_ID_TAG, platform, shop, orderNonce],
    ),
  );
}

/** keccak256(abi.encode(uint256 chainId, address claims, bytes32 orderId)). On chain: block.chainid, address(this). */
export function claimIdOf(chainId: bigint | number, claims: Address, orderId: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }],
      [BigInt(chainId), claims, orderId],
    ),
  );
}

/** keccak256(abi.encode(uint256 chainId, address recourseCase, bytes32 claimId, uint8 attempt)); attempt is 1 or 2. */
export function externalIdOf(chainId: bigint | number, recourseCase: Address, claimId: Hex, attempt: number): Hex {
  if (attempt !== 1 && attempt !== 2) throw new RangeError('externalIdOf: attempt must be 1 or 2');
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint8' }],
      [BigInt(chainId), recourseCase, claimId, attempt],
    ),
  );
}

/** `externalIdOf` as the uint256 the Kleros EvidenceModule takes. */
export function externalIdUint(chainId: bigint | number, recourseCase: Address, claimId: Hex, attempt: number): bigint {
  return hexToBigInt(externalIdOf(chainId, recourseCase, claimId, attempt));
}

/** 32 random bytes from the platform CSPRNG (Web Crypto; available in Node and browsers). */
export function newOrderNonce(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let hex = '0x';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex as Hex;
}
