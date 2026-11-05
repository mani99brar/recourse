// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {console2} from "forge-std/console2.sol";

import {RecourseClaims} from "../../src/hedera/RecourseClaims.sol";
import {IRecourseClaims, IgnoreReason} from "../../src/hedera/interfaces/IRecourseClaims.sol";
import {BridgeMode, Claim, ClaimStatus} from "../../src/shared/RecourseTypes.sol";
import {ClaimsBase} from "./ClaimsBase.sol";

/// @notice The CCIP receive path never reverts: each bad message emits RulingIgnored with its
///         reason and leaves the claim as it was.
contract ReceiveTest is ClaimsBase {
    uint64 internal constant SIM_SELECTOR = 16015286601757825753;

    function setUp() public {
        _setUpClaims();
    }

    function _expectIgnored(bytes32 claimIdOrZero, uint8 reason, bytes32 messageId) internal {
        vm.expectEmit(address(claims));
        emit IRecourseClaims.RulingIgnored(claimIdOrZero, reason, messageId);
    }

    function _routeOk(Client.Any2EVMMessage memory m) internal {
        (bool ok,) = _route(m);
        assertTrue(ok, "receiver reverted");
    }

    // ------------------------------------------------------------ the valid path

    function test_validRuling_isRecorded() public {
        bytes32 id = _atCourt(1, 1);
        Client.Any2EVMMessage memory m = _rulingMsg(_rulingData(id, 4242, 2, 1), casePeer, ARB_SEL);
        vm.expectEmit(address(claims));
        emit IRecourseClaims.RulingReceived(id, 4242, 2, 1, m.messageId);
        _routeOk(m);
        Claim memory c = claims.getClaim(id);
        assertEq(uint8(c.status), uint8(ClaimStatus.Ruled));
        assertEq(c.ruling, 2);
        assertEq(c.disputeId, 4242);
        assertEq(c.attempts, 1);
    }

    function test_zeroOnSecondAttempt_isRecorded() public {
        bytes32 id = _atCourt(1, 1);
        _deliver(id, 7, 0, 2);
        assertEq(uint8(_status(id)), uint8(ClaimStatus.Ruled));
        assertEq(claims.getClaim(id).attempts, 2);
    }

    function test_directRouterCallAlsoWorks() public {
        bytes32 id = _atCourt(1, 1);
        Client.Any2EVMMessage memory m = _rulingMsg(_rulingData(id, 1, 1, 1), casePeer, ARB_SEL);
        vm.prank(address(router));
        claims.ccipReceive(m);
        assertEq(uint8(_status(id)), uint8(ClaimStatus.Ruled));
    }

    function test_onlyRouterMayCall() public {
        bytes32 id = _atCourt(1, 1);
        Client.Any2EVMMessage memory m = _rulingMsg(_rulingData(id, 1, 1, 1), casePeer, ARB_SEL);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CCIPReceiver.InvalidRouter.selector, stranger));
        claims.ccipReceive(m);
    }

    // ------------------------------------------------------------ reasons in order

    function test_reason1_wrongSource() public {
        bytes32 id = _atCourt(1, 1);
        Client.Any2EVMMessage memory m = _rulingMsg(_rulingData(id, 1, 1, 1), casePeer, SIM_SELECTOR);
        _expectIgnored(bytes32(0), IgnoreReason.WRONG_SOURCE, m.messageId);
        _routeOk(m);
        assertEq(uint8(_status(id)), uint8(ClaimStatus.AtCourt));
    }

    function test_reason2_wrongSender() public {
        bytes32 id = _atCourt(1, 1);
        Client.Any2EVMMessage memory m = _rulingMsg(_rulingData(id, 1, 1, 1), stranger, ARB_SEL);
        _expectIgnored(bytes32(0), IgnoreReason.WRONG_SENDER, m.messageId);
        _routeOk(m);

        // Packed 20-byte sender and over-long sender bytes are rejected without decoding.
        m.sender = abi.encodePacked(casePeer);
        _expectIgnored(bytes32(0), IgnoreReason.WRONG_SENDER, m.messageId);
        _routeOk(m);
        m.sender = abi.encode(casePeer, uint256(0));
        _expectIgnored(bytes32(0), IgnoreReason.WRONG_SENDER, m.messageId);
        _routeOk(m);
        m.sender = "";
        _expectIgnored(bytes32(0), IgnoreReason.WRONG_SENDER, m.messageId);
        _routeOk(m);
        assertEq(uint8(_status(id)), uint8(ClaimStatus.AtCourt));
    }

    function test_reason2_noPeerSet() public {
        RecourseClaims fresh = new RecourseClaims(address(router), address(linkToken), address(vault), ARB_SEL, owner);
        // A zero sender would equal an unset peer's encoding; it must still be rejected.
        Client.Any2EVMMessage memory m = _rulingMsg(_rulingData(bytes32("x"), 1, 1, 1), address(0), ARB_SEL);
        vm.expectEmit(address(fresh));
        emit IRecourseClaims.RulingIgnored(bytes32(0), IgnoreReason.WRONG_SENDER, m.messageId);
        (bool ok,,) = router.routeMessage(m, 5_000, RECEIVE_GAS, address(fresh));
        assertTrue(ok);
    }

    function test_reason3_badPayloads() public {
        bytes32 id = _atCourt(1, 1);
        bytes memory good = _rulingData(id, 1, 1, 1);
        bytes[] memory bad = new bytes[](9);
        bad[0] = "";
        bad[1] = abi.encodePacked(good, uint8(0)); // 161 bytes
        bad[2] = abi.encode(uint8(1), id, uint256(1), uint8(1)); // 128 bytes
        bad[3] = abi.encode(uint256(2), id, uint256(1), uint256(1), uint256(1)); // version 2
        bad[4] = abi.encode(uint256(1), id, uint256(1), uint256(4), uint256(1)); // ruling 4
        bad[5] = abi.encode(uint256(1), id, uint256(1), uint256(1), uint256(0)); // attempts 0
        bad[6] = abi.encode(uint256(1), id, uint256(1), uint256(1), uint256(3)); // attempts 3
        bad[7] = abi.encode(uint256(1), id, uint256(1), uint256(1) | (1 << 8), uint256(1)); // dirty ruling
        bad[8] = abi.encode(uint256(1) | (1 << 200), id, uint256(1), uint256(1), uint256(1)); // dirty version
        for (uint256 i; i < bad.length; ++i) {
            Client.Any2EVMMessage memory m = _rulingMsg(bad[i], casePeer, ARB_SEL);
            _expectIgnored(bytes32(0), IgnoreReason.BAD_PAYLOAD, m.messageId);
            _routeOk(m);
        }
        assertEq(uint8(_status(id)), uint8(ClaimStatus.AtCourt));
    }

    function test_reason4_wrongMode() public {
        bytes32 id = _atCourt(1, 1);
        vm.prank(owner);
        claims.setBridgeMode(BridgeMode.OutOnly, relayer);
        Client.Any2EVMMessage memory m = _rulingMsg(_rulingData(id, 1, 1, 1), casePeer, ARB_SEL);
        _expectIgnored(id, IgnoreReason.WRONG_MODE, m.messageId);
        _routeOk(m);
        assertEq(uint8(_status(id)), uint8(ClaimStatus.AtCourt));
    }

    function test_reason5_unknownClaim() public {
        Client.Any2EVMMessage memory m = _rulingMsg(_rulingData(bytes32("nope"), 1, 1, 1), casePeer, ARB_SEL);
        _expectIgnored(bytes32("nope"), IgnoreReason.UNKNOWN_CLAIM, m.messageId);
        _routeOk(m);
    }

    function test_reason6_notAtCourt() public {
        bytes32 filed = _file();
        bytes32 pre = _file();
        _precheck(pre, 1, 1);
        bytes32 contested = _file();
        _precheck(contested, 1, 1);
        _contest(contested);
        bytes32[3] memory ids = [filed, pre, contested];
        for (uint256 i; i < 3; ++i) {
            ClaimStatus before = _status(ids[i]);
            Client.Any2EVMMessage memory m = _rulingMsg(_rulingData(ids[i], 1, 1, 1), casePeer, ARB_SEL);
            _expectIgnored(ids[i], IgnoreReason.NOT_AT_COURT, m.messageId);
            _routeOk(m);
            assertEq(uint8(_status(ids[i])), uint8(before));
        }
    }

    function test_reason6_duplicateAndResendCopiesIgnored() public {
        bytes32 id = _atCourt(1, 1);
        vm.warp(T0 + 30 minutes);
        claims.resend(id);
        Client.Any2EVMMessage memory first = _deliver(id, 11, 1, 1);
        // The same message again, and a copy answering the resend with another dispute and ruling.
        _expectIgnored(id, IgnoreReason.NOT_AT_COURT, first.messageId);
        _routeOk(first);
        Client.Any2EVMMessage memory copy = _rulingMsg(_rulingData(id, 12, 2, 1), casePeer, ARB_SEL);
        _expectIgnored(id, IgnoreReason.NOT_AT_COURT, copy.messageId);
        _routeOk(copy);
        Claim memory c = claims.getClaim(id);
        assertEq(c.ruling, 1);
        assertEq(c.disputeId, 11);
        // Also after settlement.
        claims.settle(id);
        _routeOk(copy);
        assertEq(uint8(_status(id)), uint8(ClaimStatus.Settled));
    }

    function test_reason6_lateRulingAfterExpiry() public {
        bytes32 id = _atCourt(1, 1);
        vm.warp(T0 + 4 hours + 1);
        claims.expireClaim(id);
        Client.Any2EVMMessage memory m = _rulingMsg(_rulingData(id, 1, 1, 1), casePeer, ARB_SEL);
        _expectIgnored(id, IgnoreReason.NOT_AT_COURT, m.messageId);
        _routeOk(m);
        assertEq(uint8(_status(id)), uint8(ClaimStatus.Expired));
        _assertBooks();
    }

    function test_reason8_firstRefusalLeavesClaimAtCourt() public {
        bytes32 id = _atCourt(1, 1);
        Client.Any2EVMMessage memory m = _rulingMsg(_rulingData(id, 3, 0, 1), casePeer, ARB_SEL);
        _expectIgnored(id, IgnoreReason.REFUSED_FIRST_ATTEMPT, m.messageId);
        _routeOk(m);
        assertEq(uint8(_status(id)), uint8(ClaimStatus.AtCourt));
        // The refiled case's ruling is then applied normally.
        _deliver(id, 4, 2, 2);
        assertEq(uint8(_status(id)), uint8(ClaimStatus.Ruled));
    }

    function test_reason8_thenExpires() public {
        bytes32 id = _atCourt(1, 1);
        _routeOk(_rulingMsg(_rulingData(id, 3, 0, 1), casePeer, ARB_SEL));
        vm.warp(T0 + 4 hours + 1);
        claims.expireClaim(id);
        assertEq(uint8(_status(id)), uint8(ClaimStatus.Expired));
    }

    // ------------------------------------------------------------ fuzz: never reverts

    function testFuzz_randomPayloadNeverReverts(bytes calldata data) public {
        bytes32 id = _atCourt(1, 1);
        _routeOk(_rulingMsg(data, casePeer, ARB_SEL));
        ClaimStatus s = _status(id);
        assertTrue(s == ClaimStatus.AtCourt || s == ClaimStatus.Ruled);
    }

    function testFuzz_randomWordsNeverRevert(uint256 v, uint256 d, uint256 r, uint256 a, bool useClaim) public {
        bytes32 id = _atCourt(1, 1);
        bytes memory data = abi.encode(v, useClaim ? id : bytes32(d), d, r, a);
        _routeOk(_rulingMsg(data, casePeer, ARB_SEL));
    }

    function testFuzz_randomEnvelopeNeverReverts(bytes calldata sender, uint64 source, bytes calldata data) public {
        _atCourt(1, 1);
        Client.Any2EVMMessage memory m = _rulingMsg(data, casePeer, source);
        m.sender = sender;
        _routeOk(m);
    }

    // ------------------------------------------------------------ gas

    function test_receiveGas() public {
        bytes32 id = _atCourt(1, 1);
        (bool ok, uint256 gasValid) = _route(_rulingMsg(_rulingData(id, type(uint256).max, 3, 2), casePeer, ARB_SEL));
        assertTrue(ok);
        bytes32 id2 = _atCourt(1, 1);
        (, uint256 gasIgnored) = _route(_rulingMsg(_rulingData(id2, 1, 0, 1), casePeer, ARB_SEL));
        (, uint256 gasBadSender) = _route(_rulingMsg(_rulingData(id2, 1, 1, 1), stranger, ARB_SEL));
        console2.log("ccipReceive gas, valid ruling:", gasValid);
        console2.log("ccipReceive gas, refusal ignored:", gasIgnored);
        console2.log("ccipReceive gas, wrong sender:", gasBadSender);
        assertLe(gasValid, 300_000);
        assertLe(gasIgnored, 300_000);
    }
}
