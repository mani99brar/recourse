// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title HederaUnits
/// @notice HBAR amounts have two scales on Hedera. Inside the EVM (`msg.value`, `address.balance`,
///         and the CCIP router's native fee) they are tinybars, 8 decimals. Over JSON-RPC
///         (`eth_getBalance`, a transaction's `value`) they are weibars, 18 decimals.
///         1 HBAR = 10^8 tinybar = 10^18 weibar; 1 tinybar = 10^10 weibar.
library HederaUnits {
    uint256 internal constant WEIBAR_PER_TINYBAR = 1e10;
    uint256 internal constant TINYBAR_PER_HBAR = 1e8;

    /// @notice The `value` to put in an RPC transaction that should deliver `tinybar` in the EVM.
    function toWeibar(uint256 tinybar) internal pure returns (uint256) {
        return tinybar * WEIBAR_PER_TINYBAR;
    }

    /// @notice The EVM amount an RPC weibar value becomes (sub-tinybar remainders are dropped).
    function toTinybar(uint256 weibar) internal pure returns (uint256) {
        return weibar / WEIBAR_PER_TINYBAR;
    }

    /// @notice Whether an RPC value is a whole number of tinybars (the relay rejects the rest).
    function isWholeTinybars(uint256 weibar) internal pure returns (bool) {
        return weibar % WEIBAR_PER_TINYBAR == 0;
    }
}
