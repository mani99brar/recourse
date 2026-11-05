// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title The slice of the Hedera Token Service system contract (0x167) that Recourse uses.
/// @notice Response codes are Hedera `ResponseCodeEnum` values: 22 = SUCCESS,
///         194 = TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT.
interface IHederaTokenService {
    /// @notice Associates `token` with `account`. A contract may associate itself.
    function associateToken(address account, address token) external returns (int64 responseCode);
}
