// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUsdc (testnet only)
/// @notice A testnet stand-in for USDC, for a deployment that cannot get Circle's testnet USDC.
///         It is NOT Circle's token, is backed by nothing and is worth nothing. Its name and symbol
///         say so ("Mock USD Coin (testnet)", "mUSDC"), and the Hedera deploy script refuses it in
///         place of Circle's USDC and the reverse. A plain ERC-20 with 6 decimals, like USDC; only
///         the owner set at construction can mint, and the owner can do nothing else.
/// @dev Not an HTS token, so every account can hold it without an association. `associate()` and
///      `isAssociated()` answer the token-side association calls so that
///      `DepositVault.associateUsdc(true)` succeeds; they change nothing.
contract MockUsdc is ERC20 {
    /// @dev Hedera `ResponseCodeEnum` SUCCESS, what the vault expects from `associate()`.
    uint256 internal constant HTS_SUCCESS = 22;

    /// @notice The only account that can mint. It cannot be changed.
    address public immutable owner;

    error NotOwner(address caller);
    error ZeroOwner();

    constructor(address owner_) ERC20("Mock USD Coin (testnet)", "mUSDC") {
        if (owner_ == address(0)) revert ZeroOwner();
        owner = owner_;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Creates `amount` (micro-units, 6 decimals) for `to`. Owner only.
    function mint(address to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _mint(to, amount);
    }

    /// @notice Always SUCCESS: there is nothing to associate.
    function associate() external pure returns (uint256 responseCode) {
        return HTS_SUCCESS;
    }

    /// @notice Always true: every account can hold the token.
    function isAssociated() external pure returns (bool) {
        return true;
    }
}
