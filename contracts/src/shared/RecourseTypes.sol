// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Pointer to an order's six records on HCS: topic number (the N of 0.0.N), the sequence
/// number of each record's message and the SHA-256 of each record document, indexed by kind
/// (0 asked, 1 shown, 2 approval, 3 ordered, 4 packed, 5 arrived). A zero hash marks a missing record.
struct RecordRefs {
    uint64 topicNum;
    uint64[6] seq;
    bytes32[6] hashes;
}

/// @notice Claim status on Hedera. None means no claim is stored for the id.
enum ClaimStatus {
    None,
    Filed,
    PreChecked,
    Contested,
    AtCourt,
    Ruled,
    Settled,
    Closed,
    Expired
}

/// @notice Case state on Arbitrum.
enum CaseState {
    None,
    Received,
    Opened,
    RefilePending,
    Ruled,
    Relayed,
    Stale
}

/// @notice How the Hedera claims contract talks to Arbitrum.
enum BridgeMode {
    Both,
    OutOnly,
    None
}

/// @notice Result of decoding a bridge message.
enum DecodeStatus {
    Ok,
    BadLength,
    BadVersion,
    DirtyWord,
    BadCode
}

/// @notice A claim as stored on Hedera and returned by getClaim, in field order.
struct Claim {
    bytes32 orderId;
    address shop;
    address platform;
    RecordRefs refs;
    uint256 basketUsdc;
    uint256 netLossUsdc;
    uint64 filedAt;
    uint64 preCheckedAt;
    uint8 gap;
    uint8 answer;
    bytes32 packHash;
    address contestedBy;
    uint8 sendCount;
    uint64 lastSendAt;
    bytes32 lastMessageId;
    uint256 disputeId;
    uint8 ruling;
    uint8 attempts;
    ClaimStatus status;
}

/// @notice Hedera -> Arbitrum message: a contested claim going to court.
struct ClaimToCourt {
    uint8 version;
    bytes32 claimId;
    address platform;
    address shop;
    uint8 gap;
    uint8 answer;
    RecordRefs refs;
    bytes32 packHash;
    uint256 basketUsdc;
    uint256 netLossUsdc;
    uint64 filedAt;
}

/// @notice Arbitrum -> Hedera message: the final ruling.
struct RulingBack {
    uint8 version;
    bytes32 claimId;
    uint256 disputeId;
    uint8 ruling;
    uint8 attempts;
}

/// @notice Numeric codes shared with the off-chain services.
library Codes {
    uint8 internal constant GAP_NONE = 0;
    uint8 internal constant GAP_ASKED_VS_SHOWN = 1;
    uint8 internal constant GAP_SHOWN_VS_ORDERED = 2;
    uint8 internal constant GAP_ORDERED_VS_DELIVERED = 3;
    uint8 internal constant GAP_NO_CODE = 255;

    uint8 internal constant ANSWER_UNKNOWN = 0;
    uint8 internal constant ANSWER_PLATFORM = 1;
    uint8 internal constant ANSWER_MERCHANT = 2;
    uint8 internal constant ANSWER_NEITHER = 3;

    uint8 internal constant RULING_REFUSED = 0;
    uint8 internal constant RULING_PLATFORM = 1;
    uint8 internal constant RULING_MERCHANT = 2;
    uint8 internal constant RULING_NEITHER = 3;

    uint8 internal constant KIND_ASKED = 0;
    uint8 internal constant KIND_SHOWN = 1;
    uint8 internal constant KIND_APPROVAL = 2;
    uint8 internal constant KIND_ORDERED = 3;
    uint8 internal constant KIND_PACKED = 4;
    uint8 internal constant KIND_ARRIVED = 5;

    function isGap(uint256 g) internal pure returns (bool) {
        return g <= 3 || g == 255;
    }

    function isAnswer(uint256 a) internal pure returns (bool) {
        return a <= 3;
    }
}
