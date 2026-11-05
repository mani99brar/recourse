// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Identifiers. Each is keccak256 over abi.encode (never packed); the TypeScript side
/// computes the same bytes.
library RecourseIds {
    string internal constant ORDER_ID_TAG = "recourse.order.v1";

    /// @notice keccak256(abi.encode(string "recourse.order.v1", platform, shop, orderNonce)).
    function orderIdOf(address platform, address shop, bytes32 orderNonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(ORDER_ID_TAG, platform, shop, orderNonce));
    }

    /// @notice keccak256(abi.encode(chainId, claims, orderId)); the claims contract passes block.chainid and itself.
    function claimIdOf(uint256 chainId, address claims, bytes32 orderId) internal pure returns (bytes32) {
        return keccak256(abi.encode(chainId, claims, orderId));
    }

    /// @notice keccak256(abi.encode(chainId, recourseCase, claimId, attempt)); attempt is 1 or 2.
    function externalIdOf(uint256 chainId, address recourseCase, bytes32 claimId, uint8 attempt)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(chainId, recourseCase, claimId, attempt));
    }
}
