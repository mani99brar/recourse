// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {BridgeCodec} from "../../src/shared/BridgeCodec.sol";
import {ClaimToCourt, RulingBack, DecodeStatus, RecordRefs} from "../../src/shared/RecourseTypes.sol";

/// Exposes the library so reverts and return data can be observed from the test.
contract CodecHarness {
    function decodeClaim(bytes memory data) external pure returns (DecodeStatus, ClaimToCourt memory) {
        return BridgeCodec.tryDecodeClaimToCourt(data);
    }

    function decodeRuling(bytes memory data) external pure returns (DecodeStatus, RulingBack memory) {
        return BridgeCodec.tryDecodeRulingBack(data);
    }

    function encodeClaim(ClaimToCourt memory m) external pure returns (bytes memory) {
        return BridgeCodec.encodeClaimToCourt(m);
    }

    function encodeRuling(RulingBack memory m) external pure returns (bytes memory) {
        return BridgeCodec.encodeRulingBack(m);
    }
}

contract BridgeCodecTest is Test {
    CodecHarness internal h;

    function setUp() public {
        h = new CodecHarness();
    }

    function _claim() internal pure returns (ClaimToCourt memory m) {
        m.version = 1;
        m.claimId = keccak256("claim");
        m.platform = address(0xA11CE);
        m.shop = address(0xB0B);
        m.gap = 2;
        m.answer = 1;
        m.refs.topicNum = 7_000_001;
        for (uint256 i = 0; i < 6; i++) {
            m.refs.seq[i] = uint64(i + 1);
            m.refs.hashes[i] = keccak256(abi.encode(i));
        }
        m.packHash = keccak256("pack");
        m.basketUsdc = 120_000_000;
        m.netLossUsdc = 95_500_000;
        m.filedAt = 1_800_000_000;
    }

    function test_ClaimToCourtLayout() public view {
        ClaimToCourt memory m = _claim();
        bytes memory data = h.encodeClaim(m);
        assertEq(data.length, BridgeCodec.CLAIM_TO_COURT_LEN);
        bytes memory flat = abi.encode(
            m.version, m.claimId, m.platform, m.shop, m.gap, m.answer, m.refs.topicNum, m.refs.seq, m.refs.hashes
        );
        bytes memory tail = abi.encode(m.packHash, m.basketUsdc, m.netLossUsdc, m.filedAt);
        assertEq(data, bytes.concat(flat, tail));

        (DecodeStatus s, ClaimToCourt memory back) = h.decodeClaim(data);
        assertEq(uint8(s), uint8(DecodeStatus.Ok));
        assertEq(keccak256(abi.encode(back)), keccak256(abi.encode(m)));
    }

    function test_RulingBackLayout() public view {
        RulingBack memory m = RulingBack({version: 1, claimId: keccak256("c"), disputeId: 42, ruling: 3, attempts: 2});
        bytes memory data = h.encodeRuling(m);
        assertEq(data.length, BridgeCodec.RULING_BACK_LEN);
        assertEq(data, abi.encode(uint8(1), m.claimId, uint256(42), uint8(3), uint8(2)));
        (DecodeStatus s, RulingBack memory back) = h.decodeRuling(data);
        assertEq(uint8(s), uint8(DecodeStatus.Ok));
        assertEq(back.disputeId, 42);
        assertEq(back.attempts, 2);
    }

    function test_DecodeStatuses() public view {
        bytes memory good = h.encodeClaim(_claim());
        (DecodeStatus s,) = h.decodeClaim(bytes.concat(good, hex"00"));
        assertEq(uint8(s), uint8(DecodeStatus.BadLength));

        bytes memory dirty = good;
        dirty[64 + 11] = 0x01; // a high byte of the platform word
        (s,) = h.decodeClaim(dirty);
        assertEq(uint8(s), uint8(DecodeStatus.DirtyWord));

        bytes memory badVersion = h.encodeClaim(_claim());
        badVersion[31] = 0x02;
        (s,) = h.decodeClaim(badVersion);
        assertEq(uint8(s), uint8(DecodeStatus.BadVersion));

        bytes memory badGap = h.encodeClaim(_claim());
        badGap[128 + 31] = 0x04;
        (s,) = h.decodeClaim(badGap);
        assertEq(uint8(s), uint8(DecodeStatus.BadCode));

        bytes memory badAttempts = abi.encode(uint8(1), bytes32(0), uint256(1), uint8(1), uint8(3));
        (s,) = h.decodeRuling(badAttempts);
        assertEq(uint8(s), uint8(DecodeStatus.BadCode));
        bytes memory dirtyRuling = abi.encode(uint8(1), bytes32(0), uint256(1), uint256(256 + 1), uint8(1));
        (s,) = h.decodeRuling(dirtyRuling);
        assertEq(uint8(s), uint8(DecodeStatus.DirtyWord));
    }

    function test_EncodeRejectsBadCodes() public {
        ClaimToCourt memory m = _claim();
        m.gap = 4;
        vm.expectRevert(BridgeCodec.CodecBadCode.selector);
        h.encodeClaim(m);
        RulingBack memory r = RulingBack({version: 1, claimId: 0, disputeId: 1, ruling: 1, attempts: 0});
        vm.expectRevert(BridgeCodec.CodecBadCode.selector);
        h.encodeRuling(r);
    }

    function test_ExtraArgsMatchClient() public pure {
        for (uint256 g = 300_000; g <= 400_000; g += 100_000) {
            assertEq(
                BridgeCodec.extraArgsFor(g),
                Client._argsToBytes(Client.GenericExtraArgsV2({gasLimit: g, allowOutOfOrderExecution: true}))
            );
        }
    }

    /// forge-config: default.fuzz.runs = 10000
    function testFuzz_DecodeNeverReverts(bytes memory data) public view {
        h.decodeClaim(data);
        h.decodeRuling(data);
    }

    /// forge-config: default.fuzz.runs = 10000
    function testFuzz_DecodeExactLengthsNeverRevert(bytes32[23] memory words, uint8 cut) public view {
        bytes memory claimData = abi.encodePacked(words);
        h.decodeClaim(claimData);
        bytes memory rulingData = new bytes(160);
        for (uint256 i = 0; i < 160; i++) {
            rulingData[i] = claimData[i];
        }
        h.decodeRuling(rulingData);
        uint256 n = uint256(cut) % 737;
        bytes memory part = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            part[i] = claimData[i];
        }
        h.decodeClaim(part);
    }
}
