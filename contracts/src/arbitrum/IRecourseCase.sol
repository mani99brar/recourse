// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IArbitrableV2} from "@kleros/kleros-v2-contracts/arbitration/interfaces/IArbitrableV2.sol";
import {CaseState} from "../shared/RecourseTypes.sol";

/// @notice One claim's court record on Arbitrum, as returned by `caseOf`.
/// @dev `disputeIds[a - 1]` and `templateIds[a - 1]` belong to court attempt `a` (1 or 2); zero until that attempt
/// opens. `ruling` and `ruledAt` hold the latest ruling stored by `rule` (a first refusal included). `sendCount`,
/// `lastSendAt` and `lastMessageId` describe the CCIP sends of the final ruling back to Hedera.
struct CaseView {
    CaseState state;
    bytes32 payloadHash;
    uint64 receivedAt;
    uint8 attempts;
    uint256[2] disputeIds;
    uint256[2] templateIds;
    uint8 ruling;
    uint64 ruledAt;
    uint8 sendCount;
    uint64 lastSendAt;
    bytes32 lastMessageId;
}

/// @title IRecourseCase
/// @notice Arbitrum end of a Recourse claim. A contested claim arrives from Hedera over CCIP (or, when CCIP is off,
/// from a trusted relay), becomes one Kleros dispute paid from a team-funded fee pool, is refiled once if the court
/// refuses, and its final ruling is sent back to Hedera over CCIP.
///
/// State machine (no transition goes backwards; Stale, Ruled and Relayed are final for the court):
///   None -> Received        `_ccipReceive` or `relayClaim` with a valid, new claim
///   Received -> Opened      `openCase` before `receivedAt + caseDeadline` (attempt 1, openCases + 1)
///   Received -> Stale       `openCase` at or after that deadline (never counted)
///   Opened -> RefilePending `rule` on attempt 1 with ruling 0
///   Opened -> Ruled         `rule` on attempt 1 with ruling 1-3, or on attempt 2 with ruling 0-3 (openCases - 1)
///   RefilePending -> Opened `refile` before `ruledAt + caseDeadline` (attempt 2)
///   RefilePending -> Stale  `refile` at or after that deadline (openCases - 1)
///   Ruled -> Relayed        first `relayRuling`; later sends keep Relayed
///
/// `ClaimRejected` reasons: 1 wrong source chain selector, 2 sender is not the peer, 3 undecodable payload (bad
/// length, dirty word or bad code), 4 unknown payload version.
interface IRecourseCase is IArbitrableV2 {
    // ---------------------------------------------------------------- events

    /// @notice A valid new claim was stored. `messageId` is zero when it came through `relayClaim`.
    event ClaimReceived(bytes32 indexed claimId, bytes32 indexed messageId, bytes payload);
    /// @notice A message for a claim already known was ignored.
    event ClaimDuplicate(bytes32 indexed claimId, bytes32 indexed messageId);
    /// @notice A message was ignored before decoding finished; nothing was stored.
    event ClaimRejected(bytes32 indexed messageId, uint8 reason);
    /// @notice The claim missed its deadline and will not go (back) to court.
    event ClaimStale(bytes32 indexed claimId);
    /// @notice A Kleros dispute was created for the claim. Emitted in the same transaction as `DisputeRequest`.
    event CaseOpened(bytes32 indexed claimId, uint256 indexed disputeId, uint8 attempt);
    /// @notice The court refused on attempt 1; `refile` may now open attempt 2.
    event RefileNeeded(bytes32 indexed claimId);
    /// @notice The final ruling is stored and ready to relay.
    event RulingFinal(bytes32 indexed claimId, uint256 indexed disputeId, uint8 ruling, uint8 attempts);
    /// @notice `rule` was called for a known dispute that can no longer change the case, or with a ruling above 3.
    event RuleIgnored(uint256 indexed disputeId, uint256 ruling);
    /// @notice The final ruling was sent to Hedera.
    event RulingRelayed(bytes32 indexed claimId, uint256 indexed disputeId, uint8 ruling, bytes32 messageId);
    event FeePoolFunded(address indexed from, uint256 amount);
    event FeePoolWithdrawn(address indexed to, uint256 amount);
    event LinkSwept(address indexed to, uint256 amount);
    event TrustedRelaySet(address relay);
    event PeerSet(address peer);
    event ParamsSet(uint64 caseDeadline, uint16 maxOpenCases, uint64 resendGap, uint8 maxSends);
    event ConfigLocked();
    /// @notice New template text; `textHash` is keccak256(abi.encode(parts)).
    event TemplateTextSet(bytes32 textHash);
    event PolicyURISet(string uri);
    event ExtraArgsSet(bytes extraArgs);

    // ---------------------------------------------------------------- errors

    error NotArbitrator();
    error UnknownDispute();
    error WrongState(bytes32 claimId, CaseState state);
    error HashMismatch();
    error CapReached();
    error FeePoolLow(uint256 have, uint256 need);
    error SendTooSoon(uint64 nextAt);
    error MaxSendsReached();
    error PeerNotSet();
    error InsufficientLink(uint256 have, uint256 need);
    error InsufficientValue(uint256 have, uint256 need);
    error ConfigIsLocked();
    error NotTrustedRelay();
    error RelayDisabled();
    error ZeroAddress();
    error WithdrawTooLarge();
    error EthSendFailed();
    error ZeroGasLimit();
    error BadParams();
    error BadPayload();

    // ---------------------------------------------------------------- court flow

    /// @notice Opens attempt 1 for a Received claim. Anyone may call. Pays exactly the live arbitration cost from
    /// the fee pool, registers the template (`previewTemplate(payload)`), creates the dispute and emits
    /// `DisputeRequest` and `CaseOpened` in this transaction. After the deadline it marks the claim Stale, emits
    /// `ClaimStale`, spends nothing and returns 0.
    /// @param payload The exact `ClaimToCourt` bytes from `ClaimReceived`.
    function openCase(bytes calldata payload) external returns (uint256 disputeId);

    /// @notice Opens attempt 2 for a RefilePending claim, with the template text and policy current now. Anyone
    /// may call; at most once per claim. After the deadline it marks the claim Stale and returns 0.
    function refile(bytes calldata payload) external returns (uint256 disputeId);

    /// @notice Sends the final ruling to Hedera. Anyone may call, at most `maxSends` times, `resendGap` apart.
    /// With no value attached the fee is paid in LINK held by this contract. With value attached the fee is paid
    /// from `msg.value` and any surplus is returned to the caller; the fee pool is never used for relays.
    function relayRuling(bytes32 claimId) external payable returns (bytes32 messageId);

    /// @notice Stores a claim without CCIP. Only the trusted relay, and only when one is set.
    function relayClaim(bytes calldata payload) external;

    /// @notice Adds `msg.value` to the fee pool that pays arbitration costs.
    function fundFeePool() external payable;

    // ---------------------------------------------------------------- owner

    /// @notice Returns `amount` of the fee pool to the owner. Always allowed (team money).
    function withdrawFeePool(uint256 amount) external;
    /// @notice Hedera peer (`RecourseClaims`). Before lock only.
    function setPeer(address peer_) external;
    /// @notice Before lock only. `maxOpenCases`, `maxSends` and `caseDeadline` must be non-zero.
    function setParams(uint64 caseDeadline, uint16 maxOpenCases, uint64 resendGap, uint8 maxSends) external;
    /// @notice Address allowed to call `relayClaim`; zero turns it off. Before lock only.
    function setTrustedRelay(address relay) external;
    /// @notice Sends all LINK held to `to`. Before lock only.
    function sweepLink(address to) external;
    /// @notice Ends every before-lock power. One way.
    function lockConfig() external;
    /// @notice CCIP extra args for ruling relays (a non-zero gas limit). Always; affects later sends only.
    function setExtraArgs(bytes calldata extraArgs_) external;
    /// @notice `/ipfs/<cid>` of the court policy. Always; affects cases opened afterwards only.
    function setPolicyURI(string calldata uri) external;
    /// @notice The four fixed template parts. Always; affects cases opened afterwards only.
    function setTemplateText(string[4] calldata parts) external;

    // ---------------------------------------------------------------- views

    function caseOf(bytes32 claimId) external view returns (CaseView memory);
    /// @notice Claim and attempt of one of our disputes; zero claim id when unknown.
    function claimOfDispute(uint256 disputeId) external view returns (bytes32 claimId, uint8 attempt);
    /// @notice Cases counted against `maxOpenCases` (Opened or RefilePending).
    function openCases() external view returns (uint16);
    function feePool() external view returns (uint256);
    /// @notice Live `arbitrationCost(EXTRA_DATA)`.
    function costNow() external view returns (uint256);
    /// @notice Kleros extra data: court 8, 3 jurors, dispute kit 1 (`abi.encode(8, 3, 1)`, 96 bytes).
    function EXTRA_DATA() external view returns (bytes memory);
    function NUMBER_OF_CHOICES() external view returns (uint256);
    function TEMPLATE_TAG() external view returns (string memory);
    function trustedRelay() external view returns (address);
    function locked() external view returns (bool);
    function peer() external view returns (address);
    /// @notice CCIP selector of Hedera, fixed at deploy.
    function hederaSelector() external view returns (uint64);
    function params() external view returns (uint64 caseDeadline, uint16 maxOpenCases, uint64 resendGap, uint8 maxSends);
    function extraArgs() external view returns (bytes memory);
    function policyURI() external view returns (string memory);
    function templateParts() external view returns (string[4] memory);
    /// @notice The exact template bytes `openCase` or `refile` would register now for `payload`. No state check;
    /// reverts `BadPayload` if the payload does not decode.
    function previewTemplate(bytes calldata payload) external view returns (string memory);
    /// @notice uint256(keccak256(abi.encode(block.chainid, address(this), claimId, attempt))), the evidence group id.
    function externalIdOf(bytes32 claimId, uint8 attempt) external view returns (uint256);
    /// @notice LINK fee for relaying the claim's ruling now.
    function quoteRelay(bytes32 claimId) external view returns (uint256);
    /// @notice Native fee for relaying the claim's ruling now.
    function quoteRelayNative(bytes32 claimId) external view returns (uint256);
    function arbitrator() external view returns (address);
    function templateRegistry() external view returns (address);
    function link() external view returns (address);
}
