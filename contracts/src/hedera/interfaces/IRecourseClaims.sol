// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RecordRefs, Claim, ClaimStatus, BridgeMode} from "../../shared/RecourseTypes.sol";

/// @notice Reason codes carried by `RulingIgnored`. Code 7 is unused.
library IgnoreReason {
    /// @dev The message did not come from the Arbitrum chain selector.
    uint8 internal constant WRONG_SOURCE = 1;
    /// @dev The sender is not the configured peer (or no peer is set).
    uint8 internal constant WRONG_SENDER = 2;
    /// @dev The payload did not decode as a valid ruling (length, dirty word, version, ruling > 3,
    ///      attempts not 1 or 2).
    uint8 internal constant BAD_PAYLOAD = 3;
    /// @dev The bridge mode does not accept rulings over CCIP.
    uint8 internal constant WRONG_MODE = 4;
    /// @dev No claim with this id.
    uint8 internal constant UNKNOWN_CLAIM = 5;
    /// @dev The claim is not at court: a duplicate, a resend copy, or a ruling after expiry.
    uint8 internal constant NOT_AT_COURT = 6;
    /// @dev A refusal (ruling 0) on the first attempt; the court refiles, so the claim stays at court.
    uint8 internal constant REFUSED_FIRST_ATTEMPT = 8;
}

/// @title RecourseClaims: claims, the contest, and the CCIP endpoint on Hedera.
/// @notice All money moves through the bound DepositVault. Amounts are micro-USDC. CCIP fees are
///         paid from this contract's own LINK or HBAR balance; fee amounts are in the fee token's
///         own units (LINK wei, or tinybars for HBAR).
interface IRecourseClaims {
    /// @notice Live parameters. Times in seconds, amounts in micro-USDC.
    struct Params {
        uint64 contestWindow;
        uint64 claimTimeout;
        uint256 courtFeeUsdc;
        uint256 handlingBase;
        uint16 handlingBps;
        uint256 handlingCap;
        uint64 resendGap;
        uint8 maxSends;
    }

    /// @notice Batch draw record. The draw is not built in this version, so every read is empty.
    struct Batch {
        uint16 pBps;
        uint8 k;
        bool drawn;
        bytes32 seed;
        bytes32[] claimIds;
    }

    // ------------------------------------------------------------------ events

    event ClaimFiled(
        bytes32 indexed claimId,
        bytes32 orderId,
        address indexed shop,
        address indexed platform,
        RecordRefs refs,
        uint256 basketUsdc,
        uint256 netLossUsdc,
        uint64 filedAt
    );
    event PreCheckRecorded(bytes32 indexed claimId, uint8 gap, uint8 answer, bytes32 packHash);
    event Contested(bytes32 indexed claimId, address indexed by);
    event ClosedUncontested(bytes32 indexed claimId, uint8 answer, uint256 toShop);
    event SentToCourt(bytes32 indexed claimId, bytes32 indexed messageId);
    event RulingReceived(bytes32 indexed claimId, uint256 disputeId, uint8 ruling, uint8 attempts, bytes32 messageId);
    event RulingIgnored(bytes32 indexed claimIdOrZero, uint8 reason, bytes32 messageId);
    event Settled(bytes32 indexed claimId, uint8 outcome, uint256 toShop, uint256 toPool);
    event ClaimExpired(bytes32 indexed claimId);

    event PeerSet(address peer);
    event ParamsSet(Params params);
    event PreCheckSignerSet(address signer);
    event BridgeModeSet(BridgeMode mode, address relayer);
    event ExtraArgsSet(bytes extraArgs);
    event FeeTokenSet(address token);
    event NativeFunded(address indexed from, uint256 amount);
    event LinkSwept(address indexed to, uint256 amount);
    event NativeSwept(address indexed to, uint256 amount);
    event ConfigLocked();

    // ------------------------------------------------------------------ errors

    error ZeroAddress();
    error ClaimExists(bytes32 claimId);
    error SameParty();
    error ZeroBasket();
    error BasketTooLarge();
    error NetLossAboveBasket();
    error MissingOrdered();
    error BadRefs();
    error NotPreCheckSigner();
    error WrongStatus(ClaimStatus current);
    error BadCode();
    error ZeroPackHash();
    error NotContester();
    error WindowClosed(uint256 closedAt);
    error WindowOpen(uint256 closesAt);
    error NotExpired(uint256 expiresAfter);
    error PeerNotSet();
    error LinkShort(uint256 have, uint256 need);
    error NativeShort(uint256 have, uint256 need);
    error ResendTooSoon(uint256 availableAt);
    error MaxSendsReached();
    error WrongMode(BridgeMode mode);
    error NotRelayer();
    error ConfigIsLocked();
    error BadParams();
    error NotReadyToLock();
    error TransferFailed();
    error AmountZero();

    // ------------------------------------------------------------------ claim lifecycle

    function fileClaim(
        bytes32 orderNonce,
        address platform,
        RecordRefs calldata refs,
        uint256 basketUsdc,
        uint256 netLossUsdc
    ) external returns (bytes32 claimId);

    function recordPreCheck(bytes32 claimId, uint8 gap, uint8 answer, bytes32 packHash) external;

    function contest(bytes32 claimId) external;

    function closeUncontested(bytes32 claimId) external;

    function sendToCourt(bytes32 claimId) external returns (bytes32 messageId);

    function resend(bytes32 claimId) external returns (bytes32 messageId);

    function expireClaim(bytes32 claimId) external;

    function recordRuling(bytes32 claimId, uint256 disputeId, uint8 ruling, uint8 attempts) external;

    function settle(bytes32 claimId) external;

    function fundNative() external payable;

    // ------------------------------------------------------------------ owner

    function setPeer(address peer) external;

    function setParams(Params calldata params) external;

    function setPreCheckSigner(address signer) external;

    function setBridgeMode(BridgeMode mode, address relayer) external;

    function sweepLink(address to) external;

    function sweepNative(address payable to) external;

    function lockConfig() external;

    function setExtraArgs(bytes calldata extraArgs) external;

    function setFeeToken(address token) external;

    // ------------------------------------------------------------------ views

    function getClaim(bytes32 claimId) external view returns (Claim memory);

    function params() external view returns (Params memory);

    function previewSettle(bytes32 claimId) external view returns (uint256 toShop, uint256 refund, uint256 toPool);

    function handlingOf(uint256 basketUsdc) external view returns (uint256);

    function quoteSend(bytes32 claimId) external view returns (uint256 fee);

    function claimIdFor(address platform, address shop, bytes32 orderNonce) external view returns (bytes32);

    function batchOf(bytes32 claimId) external view returns (uint256);

    function getBatch(uint256 batchId) external view returns (Batch memory);

    function peer() external view returns (address);

    function preCheckSigner() external view returns (address);

    function configLocked() external view returns (bool);

    function extraArgs() external view returns (bytes memory);

    function bridgeMode() external view returns (BridgeMode);

    function rulingRelayer() external view returns (address);

    function feeToken() external view returns (address);

    function link() external view returns (address);

    function vault() external view returns (address);

    function arbSelector() external view returns (uint64);
}
