// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DepositVault: every USDC unit Recourse holds on Hedera.
/// @notice USDC sits in exactly one of three buckets: a platform's deposit, a claim's fee escrow,
///         or an account's withdrawable credit. Nothing is ever pushed to an account; holders pull
///         their credit with `withdrawCredit`. All amounts are integer micro-USDC (6 decimals).
interface IDepositVault {
    enum EscrowState {
        None,
        Open,
        Closed
    }

    /// @notice One claim's court-fee escrow. `refunded` is the part returned to the shop when it closed.
    struct Escrow {
        address shop;
        EscrowState state;
        address platform;
        uint256 amount;
        uint256 refunded;
    }

    // ------------------------------------------------------------------ events

    event ClaimsBound(address indexed claims);
    event UsdcAssociated(int256 responseCode);
    event DepositPosted(address indexed platform, address indexed from, uint256 amount, uint256 balance);
    event RequiredSet(address indexed platform, uint256 amount);
    event FeeEscrowed(bytes32 indexed claimId, address indexed shop, uint256 amount);
    event OutcomeApplied(
        bytes32 indexed claimId,
        address indexed platform,
        address indexed shop,
        uint256 paid,
        uint256 refund,
        uint256 toPool
    );
    event Shortfall(bytes32 indexed claimId, address indexed platform, uint256 amount);
    event CreditWithdrawn(address indexed account, uint256 amount);
    event TopUpClockStarted(address indexed platform, uint256 deadline);
    event TopUpCleared(address indexed platform);
    event ExitRequested(address indexed platform, uint256 availableAt);
    event Exited(address indexed platform, uint256 amount);
    event ParamsSet(uint64 topUpWindow, uint64 exitDelay, uint256 minDeposit);
    event ConfigLocked();

    // ------------------------------------------------------------------ errors

    error ZeroAddress();
    error AlreadyBound();
    error ClaimsNotBound();
    error ConfigIsLocked();
    error AssociationFailed(int256 responseCode);
    error NotAssociatedYet();
    error AmountZero();
    error TransferFailed();
    error BelowMinDeposit(uint256 amount, uint256 minDeposit);
    error OnlyClaims();
    error EscrowExists(bytes32 claimId);
    error UnknownEscrow(bytes32 claimId);
    error RefundAboveEscrow(uint256 refund, uint256 escrow);
    error NoCredit();
    error NotAssociated(address account);
    error NoDeposit();
    error ExitPending();
    error ExitNotRequested();
    error ExitTooSoon(uint256 availableAt);
    error OpenClaims(uint256 count);

    // ------------------------------------------------------------------ setup (owner)

    function bindClaims(address claims) external;

    function setParams(uint64 topUpWindow, uint64 exitDelay, uint256 minDeposit) external;

    function lockConfig() external;

    function setRequired(address platform, uint256 amount) external;

    // ------------------------------------------------------------------ anyone

    function associateUsdc(bool viaHrc) external returns (int256 responseCode);

    function postDeposit(address platform, uint256 amount) external;

    function withdrawCredit() external returns (uint256 amount);

    function requestExit() external;

    function exit() external returns (uint256 amount);

    // ------------------------------------------------------------------ claims contract only

    function escrowFee(address shop, address platform, uint256 amount, bytes32 claimId) external;

    function applyOutcome(bytes32 claimId, address platform, address shop, uint256 toShop, uint256 refundToShop)
        external
        returns (uint256 paid);

    // ------------------------------------------------------------------ views

    function params() external view returns (uint64 topUpWindow, uint64 exitDelay, uint256 minDeposit);

    function depositOf(address platform) external view returns (uint256);

    function requiredOf(address platform) external view returns (uint256);

    function creditOf(address account) external view returns (uint256);

    function escrowOf(bytes32 claimId) external view returns (Escrow memory);

    function shopEscrowOf(address shop) external view returns (uint256);

    function totals() external view returns (uint256 deposits, uint256 escrow, uint256 credits);

    function topUpStartedAt(address platform) external view returns (uint64);

    function topUpDeadline(address platform) external view returns (uint256);

    function openClaimsOf(address platform) external view returns (uint256);

    function exitRequestedAt(address platform) external view returns (uint64);

    function inGoodStanding(address platform) external view returns (bool);

    function usdcAssociated() external view returns (bool);

    function configLocked() external view returns (bool);

    function pool() external view returns (address);

    function claims() external view returns (address);

    function usdc() external view returns (address);
}
