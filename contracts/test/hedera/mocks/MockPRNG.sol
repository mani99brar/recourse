// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title MockPRNG (local tests and anvil only; never deployed to a live network)
/// @notice Stands in for the Hedera PRNG system contract at 0x169 with a settable seed.
/// @dev Etch-safe: no constructor.
contract MockPRNG {
    bytes32 public seed;

    function setSeed(bytes32 seed_) external {
        seed = seed_;
    }

    function getPseudorandomSeed() external view returns (bytes32) {
        return seed;
    }
}
