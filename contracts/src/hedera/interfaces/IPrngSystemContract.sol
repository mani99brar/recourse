// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title The Hedera pseudo-random number system contract (0x169).
interface IPrngSystemContract {
    /// @notice A 32-byte seed derived from the network's running hash. Not a view: it is a system call.
    function getPseudorandomSeed() external returns (bytes32 seed);
}
