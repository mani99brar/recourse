// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ClaimToCourt, RulingBack, RecordRefs, DecodeStatus, Codes} from "./RecourseTypes.sol";

/// @notice Byte layouts of the two bridge messages. Both are abi.encode of all-static fields, so
/// each field is one 32-byte word at a fixed offset (ClaimToCourt 23 words, RulingBack 5 words).
/// Receivers must decode with tryDecode*, which never reverts, and map a non-Ok status to their
/// ignore event.
library BridgeCodec {
    uint8 internal constant VERSION = 1;
    uint256 internal constant CLAIM_TO_COURT_LEN = 736;
    uint256 internal constant RULING_BACK_LEN = 160;

    /// @dev Client.GENERIC_EXTRA_ARGS_V2_TAG in @chainlink/contracts-ccip.
    bytes4 internal constant GENERIC_EXTRA_ARGS_V2_TAG = 0x181dcf10;

    error CodecBadVersion();
    error CodecBadCode();

    // ClaimToCourt word indexes.
    uint256 private constant C_VERSION = 0;
    uint256 private constant C_CLAIM_ID = 1;
    uint256 private constant C_PLATFORM = 2;
    uint256 private constant C_SHOP = 3;
    uint256 private constant C_GAP = 4;
    uint256 private constant C_ANSWER = 5;
    uint256 private constant C_TOPIC = 6;
    uint256 private constant C_SEQ = 7; // 7..12
    uint256 private constant C_HASHES = 13; // 13..18
    uint256 private constant C_PACK_HASH = 19;
    uint256 private constant C_BASKET = 20;
    uint256 private constant C_NET_LOSS = 21;
    uint256 private constant C_FILED_AT = 22;

    // RulingBack word indexes.
    uint256 private constant R_VERSION = 0;
    uint256 private constant R_CLAIM_ID = 1;
    uint256 private constant R_DISPUTE_ID = 2;
    uint256 private constant R_RULING = 3;
    uint256 private constant R_ATTEMPTS = 4;

    /// @notice Encodes a ClaimToCourt message; reverts on a bad version or code (sender side only).
    function encodeClaimToCourt(ClaimToCourt memory m) internal pure returns (bytes memory) {
        if (m.version != VERSION) revert CodecBadVersion();
        if (!Codes.isGap(m.gap) || !Codes.isAnswer(m.answer)) revert CodecBadCode();
        return abi.encode(m);
    }

    /// @notice Encodes a RulingBack message; reverts on a bad version, ruling or attempts.
    function encodeRulingBack(RulingBack memory m) internal pure returns (bytes memory) {
        if (m.version != VERSION) revert CodecBadVersion();
        if (m.ruling > 3 || (m.attempts != 1 && m.attempts != 2)) revert CodecBadCode();
        return abi.encode(m);
    }

    /// @notice Decodes a ClaimToCourt message. Never reverts. Checks in order: exact length, no
    /// dirty high bits in uint8/uint64/address words, version 1, gap and answer in range.
    function tryDecodeClaimToCourt(bytes memory data) internal pure returns (DecodeStatus status, ClaimToCourt memory m) {
        if (data.length != CLAIM_TO_COURT_LEN) return (DecodeStatus.BadLength, m);
        if (
            _w(data, C_VERSION) >> 8 != 0 || _w(data, C_GAP) >> 8 != 0 || _w(data, C_ANSWER) >> 8 != 0
                || _w(data, C_PLATFORM) >> 160 != 0 || _w(data, C_SHOP) >> 160 != 0 || _w(data, C_TOPIC) >> 64 != 0
                || _w(data, C_FILED_AT) >> 64 != 0
        ) return (DecodeStatus.DirtyWord, m);
        for (uint256 i = 0; i < 6; i++) {
            if (_w(data, C_SEQ + i) >> 64 != 0) return (DecodeStatus.DirtyWord, m);
        }
        if (_w(data, C_VERSION) != VERSION) return (DecodeStatus.BadVersion, m);
        uint256 gap = _w(data, C_GAP);
        uint256 answer = _w(data, C_ANSWER);
        if (!Codes.isGap(gap) || !Codes.isAnswer(answer)) return (DecodeStatus.BadCode, m);

        m.version = VERSION;
        m.claimId = bytes32(_w(data, C_CLAIM_ID));
        m.platform = address(uint160(_w(data, C_PLATFORM)));
        m.shop = address(uint160(_w(data, C_SHOP)));
        m.gap = uint8(gap);
        m.answer = uint8(answer);
        m.refs.topicNum = uint64(_w(data, C_TOPIC));
        for (uint256 i = 0; i < 6; i++) {
            m.refs.seq[i] = uint64(_w(data, C_SEQ + i));
            m.refs.hashes[i] = bytes32(_w(data, C_HASHES + i));
        }
        m.packHash = bytes32(_w(data, C_PACK_HASH));
        m.basketUsdc = _w(data, C_BASKET);
        m.netLossUsdc = _w(data, C_NET_LOSS);
        m.filedAt = uint64(_w(data, C_FILED_AT));
        return (DecodeStatus.Ok, m);
    }

    /// @notice Decodes a RulingBack message. Never reverts. Same check order; ruling must be 0-3
    /// and attempts 1 or 2.
    function tryDecodeRulingBack(bytes memory data) internal pure returns (DecodeStatus status, RulingBack memory m) {
        if (data.length != RULING_BACK_LEN) return (DecodeStatus.BadLength, m);
        if (_w(data, R_VERSION) >> 8 != 0 || _w(data, R_RULING) >> 8 != 0 || _w(data, R_ATTEMPTS) >> 8 != 0) {
            return (DecodeStatus.DirtyWord, m);
        }
        if (_w(data, R_VERSION) != VERSION) return (DecodeStatus.BadVersion, m);
        uint256 ruling = _w(data, R_RULING);
        uint256 attempts = _w(data, R_ATTEMPTS);
        if (ruling > 3 || (attempts != 1 && attempts != 2)) return (DecodeStatus.BadCode, m);
        m.version = VERSION;
        m.claimId = bytes32(_w(data, R_CLAIM_ID));
        m.disputeId = _w(data, R_DISPUTE_ID);
        m.ruling = uint8(ruling);
        m.attempts = uint8(attempts);
        return (DecodeStatus.Ok, m);
    }

    /// @notice keccak256 of the payload, as the Arbitrum receiver stores it.
    function payloadHash(bytes memory payload) internal pure returns (bytes32) {
        return keccak256(payload);
    }

    /// @notice CCIP extra args: GenericExtraArgsV2{gasLimit, allowOutOfOrderExecution: true}, the
    /// same bytes as Client._argsToBytes. No finality override (full finality).
    function extraArgsFor(uint256 gasLimit) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(GENERIC_EXTRA_ARGS_V2_TAG, gasLimit, true);
    }

    /// @dev Word i of data; callers check the length first.
    function _w(bytes memory data, uint256 i) private pure returns (uint256 v) {
        assembly ("memory-safe") {
            v := mload(add(add(data, 32), mul(i, 32)))
        }
    }
}
