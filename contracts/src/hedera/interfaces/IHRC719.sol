// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Token-side association calls on an HTS token's EVM address.
/// @notice Each call acts on `msg.sender`, so a contract that calls `associate()` on a token
///         associates itself with that token.
interface IHRC719 {
    function associate() external returns (uint256 responseCode);

    function dissociate() external returns (uint256 responseCode);

    function isAssociated() external view returns (bool associated);
}
