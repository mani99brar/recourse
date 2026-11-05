// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Vm} from "forge-std/Test.sol";
import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {IArbitrableV2} from "@kleros/kleros-v2-contracts/arbitration/interfaces/IArbitrableV2.sol";
import {IArbitratorV2} from "@kleros/kleros-v2-contracts/arbitration/interfaces/IArbitratorV2.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {CCIPLocalRouter} from "@chainlink/local/src/ccip/CCIPLocalRouter.sol";

import {BridgeCodec} from "../../src/shared/BridgeCodec.sol";
import {RecourseIds} from "../../src/shared/RecourseIds.sol";
import {CaseState, ClaimToCourt, DecodeStatus, RulingBack} from "../../src/shared/RecourseTypes.sol";
import {RecourseCase} from "../../src/arbitrum/RecourseCase.sol";
import {CaseView, IRecourseCase} from "../../src/arbitrum/IRecourseCase.sol";
import {CaseBase, CaseDeployer, EthRefuser} from "./CaseBase.sol";
import {MockArbitrator} from "./mocks/MockArbitrator.sol";
import {MockClaimsPeer} from "./mocks/MockClaimsPeer.sol";

contract RecourseCaseTest is CaseBase {
    // ================================================================== constructor and constants

    function test_constants() public view {
        assertEq(rc.NUMBER_OF_CHOICES(), 3);
        assertEq(rc.EXTRA_DATA().length, 96);
        assertEq(rc.EXTRA_DATA(), abi.encode(uint256(8), uint256(3), uint256(1)));
        assertEq(rc.TEMPLATE_TAG(), "recourse-v1");
        assertEq(rc.hederaSelector(), sel);
        assertEq(rc.arbitrator(), address(arb));
        assertEq(rc.templateRegistry(), address(reg));
        assertEq(rc.link(), address(link));
        assertEq(rc.extraArgs(), BridgeCodec.extraArgsFor(RELAY_GAS));
        (uint64 d, uint16 m, uint64 g, uint8 s) = rc.params();
        assertEq(d, DEADLINE);
        assertEq(m, MAX_OPEN);
        assertEq(g, RESEND_GAP);
        assertEq(s, MAX_SENDS);
        assertEq(rc.owner(), owner);
        assertEq(rc.trustedRelay(), address(0));
        assertFalse(rc.locked());
        assertEq(rc.feePool(), POOL);
        assertEq(rc.costNow(), COST);
        assertEq(rc.claimTimeout(), CLAIM_TIMEOUT);
    }

    function test_constructor_revertsOnZeroOrBadArgs() public {
        CaseDeployer d = new CaseDeployer();
        RecourseCase.Params memory ok = RecourseCase.Params(DEADLINE, MAX_OPEN, RESEND_GAP, MAX_SENDS);
        // One probe that always succeeds, so the reverts below are about the arguments.
        d.deploy(address(router), address(link), address(arb), address(reg), sel, owner, ok, RELAY_GAS, CLAIM_TIMEOUT);

        vm.expectRevert(abi.encodeWithSelector(CCIPReceiver.InvalidRouter.selector, address(0)));
        d.deploy(address(0), address(link), address(arb), address(reg), sel, owner, ok, RELAY_GAS, CLAIM_TIMEOUT);
        vm.expectRevert(IRecourseCase.ZeroAddress.selector);
        d.deploy(address(router), address(0), address(arb), address(reg), sel, owner, ok, RELAY_GAS, CLAIM_TIMEOUT);
        vm.expectRevert(IRecourseCase.ZeroAddress.selector);
        d.deploy(address(router), address(link), address(0), address(reg), sel, owner, ok, RELAY_GAS, CLAIM_TIMEOUT);
        vm.expectRevert(IRecourseCase.ZeroAddress.selector);
        d.deploy(address(router), address(link), address(arb), address(0), sel, owner, ok, RELAY_GAS, CLAIM_TIMEOUT);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        d.deploy(
            address(router), address(link), address(arb), address(reg), sel, address(0), ok, RELAY_GAS, CLAIM_TIMEOUT
        );
        vm.expectRevert(IRecourseCase.BadParams.selector);
        d.deploy(address(router), address(link), address(arb), address(reg), 0, owner, ok, RELAY_GAS, CLAIM_TIMEOUT);
        vm.expectRevert(IRecourseCase.ZeroGasLimit.selector);
        d.deploy(address(router), address(link), address(arb), address(reg), sel, owner, ok, 0, CLAIM_TIMEOUT);
        vm.expectRevert(IRecourseCase.BadParams.selector);
        d.deploy(
            address(router),
            address(link),
            address(arb),
            address(reg),
            sel,
            owner,
            RecourseCase.Params(0, 1, 0, 1),
            RELAY_GAS,
            CLAIM_TIMEOUT
        );
        vm.expectRevert(IRecourseCase.BadParams.selector);
        d.deploy(address(router), address(link), address(arb), address(reg), sel, owner, ok, RELAY_GAS, 0);
    }

    function test_plainEth_reverts() public {
        (bool ok,) = address(rc).call{value: 1 wei}("");
        assertFalse(ok);
        (ok,) = address(rc).call{value: 1 wei}(hex"deadbeef");
        assertFalse(ok);
        assertEq(address(rc).balance, POOL);
    }

    // ================================================================== receive

    function test_receive_storesNewClaim() public {
        bytes memory payload = payloadOf(1);
        vm.recordLogs();
        bytes32 messageId = deliver(payload);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bool seen;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(rc) && logs[i].topics[0] == IRecourseCase.ClaimReceived.selector) {
                assertEq(logs[i].topics[1], idOf(1));
                assertEq(logs[i].topics[2], messageId);
                assertEq(abi.decode(logs[i].data, (bytes)), payload);
                seen = true;
            }
        }
        assertTrue(seen, "ClaimReceived");
        CaseView memory v = viewOf(idOf(1));
        assertEq(uint8(v.state), uint8(CaseState.Received));
        assertEq(v.payloadHash, keccak256(payload));
        assertEq(v.receivedAt, T0);
        assertEq(v.attempts, 0);
    }

    function test_receive_payloadHashMatchesSharedVector() public {
        string memory j = codecJson();
        bytes memory payload = vm.parseJsonBytes(j, ".claimToCourt[0].encoded");
        deliver(payload);
        assertEq(
            viewOf(vm.parseJsonBytes32(j, ".claimToCourt[0].value.claimId")).payloadHash,
            vm.parseJsonBytes32(j, ".claimToCourt[0].payloadHash")
        );
    }

    function test_receive_duplicateChangesNothing() public {
        bytes memory payload = payloadOf(1);
        deliver(payload);
        vm.warp(T0 + 10);
        // Same claim id, different body: still a duplicate, nothing overwritten.
        ClaimToCourt memory c = claimOf(1);
        c.basketUsdc += 1;
        vm.expectEmit(true, false, false, false, address(rc));
        emit IRecourseCase.ClaimDuplicate(idOf(1), bytes32(0));
        deliver(BridgeCodec.encodeClaimToCourt(c));
        CaseView memory v = viewOf(idOf(1));
        assertEq(v.payloadHash, keccak256(payload));
        assertEq(v.receivedAt, T0);

        // A duplicate after the case moved on leaves it where it is.
        vm.prank(keeper);
        rc.openCase(payload);
        deliver(payload);
        assertEq(uint8(stateOf(idOf(1))), uint8(CaseState.Opened));
    }

    function test_receive_wrongSelector_rejected() public {
        vm.expectEmit(true, false, false, true, address(rc));
        emit IRecourseCase.ClaimRejected(bytes32(uint256(9)), 1);
        deliverRaw(bytes32(uint256(9)), sel + 1, abi.encode(address(peer)), payloadOf(1));
        assertEq(uint8(stateOf(idOf(1))), uint8(CaseState.None));
    }

    function test_receive_wrongSender_rejected() public {
        bytes memory payload = payloadOf(1);
        bytes[5] memory senders = [
            abi.encode(stranger),
            abi.encodePacked(address(peer)),
            abi.encode(address(peer), uint256(0)),
            abi.encode(uint256(uint160(address(peer))) | (uint256(1) << 200)),
            bytes("")
        ];
        for (uint256 i = 0; i < senders.length; i++) {
            vm.expectEmit(true, false, false, true, address(rc));
            emit IRecourseCase.ClaimRejected(bytes32(i + 1), 2);
            deliverRaw(bytes32(i + 1), sel, senders[i], payload);
        }
        assertEq(uint8(stateOf(idOf(1))), uint8(CaseState.None));
    }

    function test_receive_peerUnset_rejectsEverySender() public {
        RecourseCase fresh = _deploy();
        _expectSenderReject(fresh, abi.encode(address(peer)), payloadOf(1));
        assertEq(uint8(fresh.caseOf(idOf(1)).state), uint8(CaseState.None));
    }

    function _expectSenderReject(RecourseCase target, bytes memory sender, bytes memory data) internal {
        vm.recordLogs();
        vm.prank(address(router));
        target.ccipReceive(_any2evm(bytes32(uint256(77)), sel, sender, data));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], IRecourseCase.ClaimRejected.selector);
        assertEq(abi.decode(logs[0].data, (uint8)), 2);
    }

    function test_receive_badPayloads_rejectedWithReason() public {
        ClaimToCourt memory c = claimOf(1);
        bytes memory good = BridgeCodec.encodeClaimToCourt(c);

        bytes memory badVersion = bytes.concat(good);
        badVersion[31] = 0x02;
        _expectRejected(badVersion, 4);

        _expectRejected(bytes.concat(good, hex"00"), 3); // long
        _expectRejected(_slice(good, 0, good.length - 1), 3); // short
        _expectRejected("", 3);

        bytes memory dirty = bytes.concat(good);
        dirty[64] = 0x01; // high byte of the platform word
        _expectRejected(dirty, 3);

        bytes memory badGap = bytes.concat(good);
        badGap[4 * 32 + 31] = 0x07; // gap 7 is not a gap code
        _expectRejected(badGap, 3);

        c.claimId = bytes32(0);
        _expectRejected(BridgeCodec.encodeClaimToCourt(c), 3);
    }

    function testFuzz_receive_neverRevertsOnData(bytes calldata data, bytes32 messageId) public {
        (bool decodes, ClaimToCourt memory c) = _tryDecode(data);
        deliverRaw(messageId, sel, abi.encode(address(peer)), data);
        if (decodes && c.claimId != bytes32(0)) {
            assertEq(uint8(stateOf(c.claimId)), uint8(CaseState.Received));
        }
        assertEq(rc.openCases(), 0);
        assertEq(rc.feePool(), POOL);
    }

    function testFuzz_receive_fuzzedValidPayloadsStored(uint256 n, uint8 gap, uint8 answer, uint256 basket) public {
        ClaimToCourt memory c = claimOf(n);
        c.gap = gap <= 3 ? gap : 255;
        c.answer = answer % 4;
        c.basketUsdc = basket;
        bytes memory payload = BridgeCodec.encodeClaimToCourt(c);
        deliver(payload);
        assertEq(uint8(stateOf(c.claimId)), uint8(CaseState.Received));
        assertEq(viewOf(c.claimId).payloadHash, keccak256(payload));
    }

    function test_receive_onlyRouter() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CCIPReceiver.InvalidRouter.selector, stranger));
        rc.ccipReceive(_any2evm(bytes32(0), sel, abi.encode(address(peer)), payloadOf(1)));
    }

    function test_receive_gas_largestValidPayload() public {
        ClaimToCourt memory c = claimOf(1);
        c.gap = 255;
        c.answer = 3;
        c.basketUsdc = type(uint256).max;
        c.netLossUsdc = type(uint256).max;
        c.filedAt = type(uint64).max;
        c.refs.topicNum = type(uint64).max;
        for (uint256 k = 0; k < 6; k++) {
            c.refs.seq[k] = type(uint64).max;
        }
        bytes memory payload = BridgeCodec.encodeClaimToCourt(c);
        _measureReceive(payload);
    }

    function _measureReceive(bytes memory payload) internal {
        vm.prank(address(router));
        uint256 before = gasleft();
        rc.ccipReceive(_any2evm(bytes32(uint256(1)), sel, abi.encode(address(peer)), payload));
        uint256 used = before - gasleft();
        emit log_named_uint("ccipReceive gas (largest valid payload, cold)", used);
        assertLt(used, 150_000);
    }

    // ================================================================== openCase

    function test_openCase_paysExactLiveCost_andRegistersPreview() public {
        bytes memory payload = payloadOf(1);
        deliver(payload);
        arb.setCost(COST + 12_345); // the live cost changed since the claim arrived
        string memory preview = rc.previewTemplate(payload);
        uint256 id = arb.nextId();
        uint256 ext = rc.externalIdOf(idOf(1), 1);

        vm.expectEmit(true, true, false, true, address(rc));
        emit IArbitrableV2.DisputeRequest(IArbitratorV2(address(arb)), id, ext, 0, "");
        vm.expectEmit(true, true, false, true, address(rc));
        emit IRecourseCase.CaseOpened(idOf(1), id, 1);
        vm.prank(keeper);
        uint256 disputeId = rc.openCase(payload);

        assertEq(disputeId, id);
        MockArbitrator.Dispute memory d = arb.disputeOf(disputeId);
        assertEq(d.paid, COST + 12_345);
        assertEq(d.choices, 3);
        assertEq(d.extraData, abi.encode(uint256(8), uint256(3), uint256(1)));
        assertEq(address(d.arbitrable), address(rc));
        assertEq(reg.templateHashOf(0), keccak256(bytes(preview)));
        assertEq(reg.mappingsHashOf(0), keccak256(""));
        assertEq(rc.feePool(), POOL - COST - 12_345);
        assertEq(address(rc).balance, rc.feePool());
        assertEq(rc.openCases(), 1);

        CaseView memory v = viewOf(idOf(1));
        assertEq(uint8(v.state), uint8(CaseState.Opened));
        assertEq(v.attempts, 1);
        assertEq(v.disputeIds[0], disputeId);
        assertEq(v.templateIds[0], 0);
        (bytes32 claimId, uint8 attempt) = rc.claimOfDispute(disputeId);
        assertEq(claimId, idOf(1));
        assertEq(attempt, 1);
    }

    function test_openCase_secondCallForSameClaimReverts() public {
        bytes memory payload = payloadOf(1);
        receiveAndOpen(1);
        vm.expectRevert(abi.encodeWithSelector(IRecourseCase.WrongState.selector, idOf(1), CaseState.Opened));
        rc.openCase(payload);
        assertEq(arb.disputeCount(), 1);
    }

    function test_openCase_unknownClaimReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IRecourseCase.WrongState.selector, idOf(1), CaseState.None));
        rc.openCase(payloadOf(1));
    }

    function test_openCase_payloadNotStoredReverts() public {
        deliver(payloadOf(1));
        ClaimToCourt memory c = claimOf(1);
        c.netLossUsdc = 1;
        vm.expectRevert(IRecourseCase.HashMismatch.selector);
        rc.openCase(BridgeCodec.encodeClaimToCourt(c));
        vm.expectRevert(IRecourseCase.BadPayload.selector);
        rc.openCase(bytes.concat(payloadOf(1), hex"00"));
    }

    function test_openCase_capReached() public {
        vm.prank(owner);
        rc.setParams(DEADLINE, 2, RESEND_GAP, MAX_SENDS);
        receiveAndOpen(1);
        receiveAndOpen(2);
        bytes memory third = payloadOf(3);
        deliver(third);
        vm.expectRevert(IRecourseCase.CapReached.selector);
        rc.openCase(third);
        // A final ruling frees a slot.
        arb.giveRuling(viewOf(idOf(1)).disputeIds[0], 2);
        rc.openCase(third);
        assertEq(rc.openCases(), 2);
    }

    function test_openCase_feePoolLow() public {
        bytes memory payload = payloadOf(1);
        deliver(payload);
        arb.setCost(POOL + 1);
        vm.expectRevert(abi.encodeWithSelector(IRecourseCase.FeePoolLow.selector, POOL, POOL + 1));
        rc.openCase(payload);
    }

    function test_openCase_templateNotSet() public {
        RecourseCase fresh = _deploy();
        vm.prank(owner);
        fresh.setPeer(address(peer));
        fresh.fundFeePool{value: POOL}();
        bytes memory payload = payloadOf(1);
        peer.sendClaim(sel, address(fresh), payload);
        vm.expectRevert(IRecourseCase.TemplateNotSet.selector);
        fresh.openCase(payload);
        vm.prank(owner);
        fresh.setTemplateText(variantParts(0));
        vm.expectRevert(IRecourseCase.TemplateNotSet.selector);
        fresh.openCase(payload);
        vm.prank(owner);
        fresh.setPolicyURI(policyURI);
        fresh.openCase(payload);
    }

    function test_openCase_staleSpendsNothing() public {
        bytes memory payload = payloadOf(1);
        deliver(payload);
        vm.warp(T0 + DEADLINE - 1);
        bytes32 snap = keccak256(abi.encode(rc.feePool(), arb.disputeCount()));
        vm.warp(T0 + DEADLINE);
        vm.expectEmit(true, false, false, false, address(rc));
        emit IRecourseCase.ClaimStale(idOf(1));
        uint256 disputeId = rc.openCase(payload);
        assertEq(disputeId, 0);
        assertEq(keccak256(abi.encode(rc.feePool(), arb.disputeCount())), snap);
        assertEq(rc.openCases(), 0);
        assertEq(uint8(stateOf(idOf(1))), uint8(CaseState.Stale));
        vm.expectRevert(abi.encodeWithSelector(IRecourseCase.WrongState.selector, idOf(1), CaseState.Stale));
        rc.openCase(payload);
    }

    function test_openCase_justBeforeDeadlineOpens() public {
        bytes memory payload = payloadOf(1);
        deliver(payload);
        vm.warp(T0 + DEADLINE - 1);
        assertGt(rc.openCase(payload) + 1, 0);
        assertEq(uint8(stateOf(idOf(1))), uint8(CaseState.Opened));
    }

    // ================================================================== template bytes

    /// @dev The on-chain template equals the TypeScript builder byte for byte, for every variant and fixture.
    function test_previewTemplate_matchesGoldenFile() public {
        uint256 n = goldenCaseCount();
        assertGt(n, 0);
        for (uint256 i = 0; i < n; i++) {
            (uint256 variant, bytes memory payload, string memory template) = goldenCase(i);
            vm.prank(owner);
            rc.setTemplateText(variantParts(variant - 1));
            assertEq(rc.previewTemplate(payload), template, vm.toString(i));
        }
    }

    function test_previewTemplate_rejectsBadPayload() public {
        vm.expectRevert(IRecourseCase.BadPayload.selector);
        rc.previewTemplate(hex"00");
    }

    function test_registeredTemplate_matchesGoldenFile() public {
        (uint256 variant, bytes memory payload, string memory template) = goldenCase(0);
        vm.prank(owner);
        rc.setTemplateText(variantParts(variant - 1));
        (, ClaimToCourt memory c) = BridgeCodec.tryDecodeClaimToCourt(payload);
        vm.warp(uint256(c.filedAt) + 1 hours); // the fixture's own filing time, so the claim is live
        deliver(payload);
        assertGt(rc.openCase(payload) + 1, 0);
        assertEq(uint8(stateOf(c.claimId)), uint8(CaseState.Opened));
        assertEq(reg.templateHashOf(0), keccak256(bytes(template)));
    }

    // ================================================================== rule

    function test_rule_attempt1Refused_refilePending() public {
        uint256 disputeId = receiveAndOpen(1);
        vm.warp(T0 + 100);
        vm.expectEmit(true, true, false, true, address(rc));
        emit IArbitrableV2.Ruling(IArbitratorV2(address(arb)), disputeId, 0);
        vm.expectEmit(true, false, false, false, address(rc));
        emit IRecourseCase.RefileNeeded(idOf(1));
        arb.giveRuling(disputeId, 0);
        CaseView memory v = viewOf(idOf(1));
        assertEq(uint8(v.state), uint8(CaseState.RefilePending));
        assertEq(v.ruling, 0);
        assertEq(v.ruledAt, T0 + 100);
        assertEq(rc.openCases(), 1);
    }

    function test_rule_attempt1Final_eachRuling() public {
        for (uint256 r = 1; r <= 3; r++) {
            uint256 disputeId = receiveAndOpen(r);
            assertEq(rc.openCases(), 1);
            vm.expectEmit(true, true, false, true, address(rc));
            emit IRecourseCase.RulingFinal(idOf(r), disputeId, uint8(r), 1);
            arb.giveRuling(disputeId, r);
            CaseView memory v = viewOf(idOf(r));
            assertEq(uint8(v.state), uint8(CaseState.Ruled));
            assertEq(v.ruling, r);
            assertEq(rc.openCases(), 0);
        }
    }

    function test_rule_attempt2Final_eachRulingIncludingRefusal() public {
        for (uint256 r = 0; r <= 3; r++) {
            uint256 first = toRuled(10 + r, 0);
            uint256 second = rc.refile(payloadOf(10 + r));
            assertTrue(second != first);
            vm.expectEmit(true, true, false, true, address(rc));
            emit IRecourseCase.RulingFinal(idOf(10 + r), second, uint8(r), 2);
            arb.giveRuling(second, r);
            CaseView memory v = viewOf(idOf(10 + r));
            assertEq(uint8(v.state), uint8(CaseState.Ruled));
            assertEq(v.ruling, r);
            assertEq(v.attempts, 2);
            assertEq(rc.openCases(), 0);
        }
    }

    function test_rule_aboveThreeIgnored() public {
        uint256 disputeId = receiveAndOpen(1);
        vm.expectEmit(true, false, false, true, address(rc));
        emit IRecourseCase.RuleIgnored(disputeId, 4);
        arb.giveRuling(disputeId, 4);
        assertEq(uint8(stateOf(idOf(1))), uint8(CaseState.Opened));
        assertEq(rc.openCases(), 1);
    }

    function test_rule_afterFinalIgnored() public {
        uint256 disputeId = toRuled(1, 2);
        vm.expectEmit(true, false, false, true, address(rc));
        emit IRecourseCase.RuleIgnored(disputeId, 1);
        arb.giveRuling(disputeId, 1);
        assertEq(viewOf(idOf(1)).ruling, 2);
        assertEq(rc.openCases(), 0);
    }

    function test_rule_olderAttemptIgnored() public {
        uint256 first = toRuled(1, 0);
        rc.refile(payloadOf(1));
        vm.expectEmit(true, false, false, true, address(rc));
        emit IRecourseCase.RuleIgnored(first, 1);
        arb.giveRuling(first, 1);
        assertEq(uint8(stateOf(idOf(1))), uint8(CaseState.Opened));
        assertEq(rc.openCases(), 1);
    }

    function test_rule_whileRefilePendingIgnored() public {
        uint256 first = toRuled(1, 0);
        vm.expectEmit(true, false, false, true, address(rc));
        emit IRecourseCase.RuleIgnored(first, 0);
        arb.giveRuling(first, 0);
        assertEq(uint8(stateOf(idOf(1))), uint8(CaseState.RefilePending));
    }

    function test_rule_onlyArbitrator() public {
        uint256 disputeId = receiveAndOpen(1);
        vm.prank(stranger);
        vm.expectRevert(IRecourseCase.NotArbitrator.selector);
        rc.rule(disputeId, 1);
    }

    function test_rule_unknownDispute() public {
        vm.prank(address(arb));
        vm.expectRevert(IRecourseCase.UnknownDispute.selector);
        rc.rule(999_999, 1);
    }

    function testFuzz_rule_neverRevertsForKnownDispute(uint256 ruling, uint256 second, bool refuseFirst) public {
        uint256 disputeId = toRuled(1, refuseFirst ? 0 : 1);
        vm.prank(address(arb));
        rc.rule(disputeId, ruling);
        vm.prank(address(arb));
        rc.rule(disputeId, second);
        CaseState s = stateOf(idOf(1));
        assertTrue(s == CaseState.RefilePending || s == CaseState.Ruled);
        assertLe(viewOf(idOf(1)).ruling, 3);
    }

    function test_rule_gas() public {
        uint256 a = receiveAndOpen(1);
        uint256 b = receiveAndOpen(2);
        vm.startPrank(address(arb));
        uint256 g = gasleft();
        rc.rule(a, 0);
        emit log_named_uint("rule gas (refusal, attempt 1)", g - gasleft());
        g = gasleft();
        rc.rule(b, 1);
        emit log_named_uint("rule gas (final)", g - gasleft());
        g = gasleft();
        rc.rule(b, 2);
        emit log_named_uint("rule gas (ignored)", g - gasleft());
        vm.stopPrank();
    }

    // ================================================================== refile

    function test_refile_opensAttempt2WithCurrentText() public {
        uint256 first = toRuled(1, 0);
        vm.prank(owner);
        rc.setTemplateText(variantParts(1));
        bytes memory payload = payloadOf(1);
        string memory preview = rc.previewTemplate(payload);
        uint256 poolBefore = rc.feePool();
        uint256 ext2 = rc.externalIdOf(idOf(1), 2);
        assertTrue(ext2 != rc.externalIdOf(idOf(1), 1));

        vm.expectEmit(true, true, false, true, address(rc));
        emit IArbitrableV2.DisputeRequest(IArbitratorV2(address(arb)), first + 1, ext2, 1, "");
        vm.expectEmit(true, true, false, true, address(rc));
        emit IRecourseCase.CaseOpened(idOf(1), first + 1, 2);
        uint256 second = rc.refile(payload);

        assertEq(second, first + 1);
        assertEq(reg.templateHashOf(1), keccak256(bytes(preview)));
        assertTrue(reg.templateHashOf(1) != reg.templateHashOf(0));
        assertEq(rc.feePool(), poolBefore - COST);
        assertEq(rc.openCases(), 1);
        CaseView memory v = viewOf(idOf(1));
        assertEq(uint8(v.state), uint8(CaseState.Opened));
        assertEq(v.attempts, 2);
        assertEq(v.disputeIds[0], first);
        assertEq(v.disputeIds[1], second);
        assertEq(v.templateIds[1], 1);
        (bytes32 claimId, uint8 attempt) = rc.claimOfDispute(second);
        assertEq(claimId, idOf(1));
        assertEq(attempt, 2);
    }

    function test_refile_onceOnly() public {
        toRuled(1, 0);
        bytes memory payload = payloadOf(1);
        rc.refile(payload);
        vm.expectRevert(abi.encodeWithSelector(IRecourseCase.WrongState.selector, idOf(1), CaseState.Opened));
        rc.refile(payload);
        arb.giveRuling(viewOf(idOf(1)).disputeIds[1], 0);
        vm.expectRevert(abi.encodeWithSelector(IRecourseCase.WrongState.selector, idOf(1), CaseState.Ruled));
        rc.refile(payload);
        assertEq(arb.disputeCount(), 2);
    }

    function test_refile_wrongStateAndHash() public {
        bytes memory payload = payloadOf(1);
        deliver(payload);
        vm.expectRevert(abi.encodeWithSelector(IRecourseCase.WrongState.selector, idOf(1), CaseState.Received));
        rc.refile(payload);
        rc.openCase(payload);
        arb.giveRuling(viewOf(idOf(1)).disputeIds[0], 0);
        ClaimToCourt memory c = claimOf(1);
        c.gap = 2;
        vm.expectRevert(IRecourseCase.HashMismatch.selector);
        rc.refile(BridgeCodec.encodeClaimToCourt(c));
    }

    function test_refile_staleReleasesCap() public {
        toRuled(1, 0);
        uint64 ruledAt = viewOf(idOf(1)).ruledAt;
        assertEq(rc.openCases(), 1);
        uint256 pool = rc.feePool();
        vm.warp(uint256(ruledAt) + DEADLINE);
        vm.expectEmit(true, false, false, false, address(rc));
        emit IRecourseCase.ClaimStale(idOf(1));
        assertEq(rc.refile(payloadOf(1)), 0);
        assertEq(rc.openCases(), 0);
        assertEq(rc.feePool(), pool);
        assertEq(uint8(stateOf(idOf(1))), uint8(CaseState.Stale));
        assertEq(arb.disputeCount(), 1);
    }

    function test_refile_ignoresCapButNeedsPool() public {
        vm.prank(owner);
        rc.setParams(DEADLINE, 1, RESEND_GAP, MAX_SENDS);
        toRuled(1, 0);
        assertEq(rc.openCases(), 1);
        arb.setCost(rc.feePool() + 1);
        vm.expectRevert(abi.encodeWithSelector(IRecourseCase.FeePoolLow.selector, rc.feePool(), rc.feePool() + 1));
        rc.refile(payloadOf(1));
        arb.setCost(COST);
        rc.refile(payloadOf(1)); // the claim already holds its slot
        assertEq(rc.openCases(), 1);
    }

    // ================================================================== relay

    function test_relay_linkPaysExactFee_andSendsRulingBack() public {
        uint256 disputeId = toRuled(1, 2);
        router.setFee(0.3 ether);
        uint256 before = link.balanceOf(address(rc));
        assertEq(rc.quoteRelay(idOf(1)), 0.3 ether);

        vm.recordLogs();
        vm.prank(stranger);
        bytes32 messageId = rc.relayRuling(idOf(1));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(link.balanceOf(address(rc)), before - 0.3 ether);
        assertEq(link.allowance(address(rc), address(router)), 0);
        assertEq(peer.receivedCount(), 1);
        MockClaimsPeer.Got memory got = peer.receivedAt(0);
        assertEq(got.messageId, messageId);
        assertEq(got.sender, abi.encode(address(rc)));
        assertEq(
            got.data,
            BridgeCodec.encodeRulingBack(
                RulingBack({version: 1, claimId: idOf(1), disputeId: disputeId, ruling: 2, attempts: 1})
            )
        );
        bool seen;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(rc) && logs[i].topics[0] == IRecourseCase.RulingRelayed.selector) {
                assertEq(logs[i].topics[1], idOf(1));
                assertEq(logs[i].topics[2], bytes32(disputeId));
                (uint8 ruling, bytes32 mid) = abi.decode(logs[i].data, (uint8, bytes32));
                assertEq(ruling, 2);
                assertEq(mid, messageId);
                seen = true;
            }
        }
        assertTrue(seen, "RulingRelayed");
        CaseView memory v = viewOf(idOf(1));
        assertEq(uint8(v.state), uint8(CaseState.Relayed));
        assertEq(v.sendCount, 1);
        assertEq(v.lastSendAt, T0);
        assertEq(v.lastMessageId, messageId);
        assertEq(v.ruling, 2);
        assertEq(rc.feePool(), POOL - COST);
    }

    /// @dev The bytes sent back equal the shared golden vector "ruling 1 on the second attempt".
    function test_relay_rulingBackEqualsSharedVector() public {
        string memory j = codecJson();
        bytes memory payload = vm.parseJsonBytes(j, ".claimToCourt[0].encoded");
        uint256 wantDispute = vm.parseJsonUint(j, ".rulingBack[0].value.disputeId");
        assertEq(arb.nextId(), wantDispute - 1);
        deliver(payload);
        uint256 first = rc.openCase(payload);
        arb.giveRuling(first, 0);
        uint256 second = rc.refile(payload);
        assertEq(second, wantDispute);
        arb.giveRuling(second, 1);
        rc.relayRuling(vm.parseJsonBytes32(j, ".rulingBack[0].value.claimId"));
        assertEq(peer.receivedAt(0).data, vm.parseJsonBytes(j, ".rulingBack[0].encoded"));
    }

    function test_relay_resendGapAndMaxSends() public {
        toRuled(1, 3);
        rc.relayRuling(idOf(1));
        uint64 nextAt = uint64(T0 + RESEND_GAP);
        vm.expectRevert(abi.encodeWithSelector(IRecourseCase.SendTooSoon.selector, nextAt));
        rc.relayRuling(idOf(1));
        vm.warp(nextAt - 1);
        vm.expectRevert(abi.encodeWithSelector(IRecourseCase.SendTooSoon.selector, nextAt));
        rc.relayRuling(idOf(1));
        for (uint256 i = 1; i < MAX_SENDS; i++) {
            vm.warp(T0 + i * RESEND_GAP);
            rc.relayRuling(idOf(1));
        }
        assertEq(viewOf(idOf(1)).sendCount, MAX_SENDS);
        vm.warp(T0 + 100 * RESEND_GAP);
        vm.expectRevert(IRecourseCase.MaxSendsReached.selector);
        rc.relayRuling(idOf(1));
        assertEq(peer.receivedCount(), MAX_SENDS);
        for (uint256 i = 0; i < MAX_SENDS; i++) {
            (,,, uint8 ruling,) = abi.decode(peer.receivedAt(i).data, (uint8, bytes32, uint256, uint8, uint8));
            assertEq(ruling, 3);
        }
        assertEq(viewOf(idOf(1)).ruling, 3);
    }

    function test_relay_wrongStates() public {
        bytes memory payload = payloadOf(1);
        vm.expectRevert(abi.encodeWithSelector(IRecourseCase.WrongState.selector, idOf(1), CaseState.None));
        rc.relayRuling(idOf(1));
        deliver(payload);
        vm.expectRevert(abi.encodeWithSelector(IRecourseCase.WrongState.selector, idOf(1), CaseState.Received));
        rc.relayRuling(idOf(1));
        rc.openCase(payload);
        vm.expectRevert(abi.encodeWithSelector(IRecourseCase.WrongState.selector, idOf(1), CaseState.Opened));
        rc.relayRuling(idOf(1));
        arb.giveRuling(viewOf(idOf(1)).disputeIds[0], 0);
        vm.expectRevert(abi.encodeWithSelector(IRecourseCase.WrongState.selector, idOf(1), CaseState.RefilePending));
        rc.relayRuling(idOf(1));
        vm.expectRevert(abi.encodeWithSelector(IRecourseCase.WrongState.selector, idOf(1), CaseState.RefilePending));
        rc.quoteRelay(idOf(1));
    }

    function test_relay_insufficientLink() public {
        toRuled(1, 1);
        router.setFee(6 ether);
        vm.expectRevert(abi.encodeWithSelector(IRecourseCase.InsufficientLink.selector, 5 ether, 6 ether));
        rc.relayRuling(idOf(1));
        assertEq(uint8(stateOf(idOf(1))), uint8(CaseState.Ruled));
    }

    function test_relay_nativeRefundsSurplus() public {
        toRuled(1, 1);
        router.setFee(0.01 ether);
        assertEq(rc.quoteRelayNative(idOf(1)), 0.01 ether);
        vm.deal(stranger, 1 ether);
        uint256 linkBefore = link.balanceOf(address(rc));
        vm.prank(stranger);
        rc.relayRuling{value: 0.05 ether}(idOf(1));
        assertEq(stranger.balance, 1 ether - 0.01 ether);
        assertEq(address(router).balance, 0.01 ether);
        assertEq(address(rc).balance, rc.feePool());
        assertEq(rc.feePool(), POOL - COST);
        assertEq(link.balanceOf(address(rc)), linkBefore);
        assertEq(peer.receivedCount(), 1);
    }

    function test_relay_nativeTooLittle() public {
        toRuled(1, 1);
        router.setFee(0.01 ether);
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IRecourseCase.InsufficientValue.selector, 0.01 ether - 1, 0.01 ether));
        rc.relayRuling{value: 0.01 ether - 1}(idOf(1));
    }

    function test_relay_failedRefundJoinsPool_andDoesNotBlock() public {
        toRuled(1, 1);
        router.setFee(0.01 ether);
        EthRefuser refuser = new EthRefuser();
        vm.deal(address(refuser), 1 ether);
        vm.expectEmit(true, false, false, true, address(rc));
        emit IRecourseCase.FeePoolFunded(address(refuser), 0.04 ether);
        refuser.exec(address(rc), 0.05 ether, abi.encodeCall(IRecourseCase.relayRuling, (idOf(1))));
        assertEq(rc.feePool(), POOL - COST + 0.04 ether);
        assertEq(address(rc).balance, rc.feePool());
        assertEq(uint8(stateOf(idOf(1))), uint8(CaseState.Relayed));
    }

    function test_relay_gas() public {
        toRuled(1, 1);
        router.setFee(0.1 ether);
        uint256 g = gasleft();
        rc.relayRuling(idOf(1));
        emit log_named_uint("relayRuling gas (LINK, local router, includes delivery to mock peer)", g - gasleft());
    }

    // ================================================================== fee pool, LINK, config

    function test_feePool_fundAndWithdraw() public {
        vm.deal(stranger, 1 ether);
        vm.expectEmit(true, false, false, true, address(rc));
        emit IRecourseCase.FeePoolFunded(stranger, 0.2 ether);
        vm.prank(stranger);
        rc.fundFeePool{value: 0.2 ether}();
        assertEq(rc.feePool(), POOL + 0.2 ether);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        rc.withdrawFeePool(1);
        vm.prank(owner);
        vm.expectRevert(IRecourseCase.WithdrawTooLarge.selector);
        rc.withdrawFeePool(POOL + 0.2 ether + 1);

        vm.prank(owner);
        rc.lockConfig();
        vm.expectEmit(true, false, false, true, address(rc));
        emit IRecourseCase.FeePoolWithdrawn(owner, 0.1 ether);
        vm.prank(owner);
        rc.withdrawFeePool(0.1 ether); // allowed after lock
        assertEq(owner.balance, 0.1 ether);
        assertEq(rc.feePool(), POOL + 0.1 ether);
        assertEq(address(rc).balance, rc.feePool());
    }

    function test_feePool_withdrawToRefusingOwnerReverts() public {
        EthRefuser refuser = new EthRefuser();
        vm.prank(owner);
        rc.transferOwnership(address(refuser));
        refuser.exec(address(rc), 0, abi.encodeCall(Ownable2Step.acceptOwnership, ()));
        vm.expectRevert(IRecourseCase.EthSendFailed.selector);
        refuser.exec(address(rc), 0, abi.encodeCall(IRecourseCase.withdrawFeePool, (1)));
        assertEq(rc.feePool(), POOL);
    }

    function test_config_lockGates() public {
        vm.startPrank(owner);
        rc.lockConfig();
        assertTrue(rc.locked());
        vm.expectRevert(IRecourseCase.ConfigIsLocked.selector);
        rc.setPeer(stranger);
        vm.expectRevert(IRecourseCase.ConfigIsLocked.selector);
        rc.setParams(DEADLINE, MAX_OPEN, RESEND_GAP, MAX_SENDS);
        vm.expectRevert(IRecourseCase.ConfigIsLocked.selector);
        rc.setTrustedRelay(stranger);
        vm.expectRevert(IRecourseCase.ConfigIsLocked.selector);
        rc.sweepLink(owner);
        vm.expectRevert(IRecourseCase.ConfigIsLocked.selector);
        rc.lockConfig();
        // Still allowed after lock, affecting later cases and sends only.
        rc.setExtraArgs(BridgeCodec.extraArgsFor(250_000));
        rc.setPolicyURI("/ipfs/bafkreiexample");
        rc.setTemplateText(variantParts(1));
        vm.stopPrank();
        assertEq(rc.extraArgs(), BridgeCodec.extraArgsFor(250_000));
        assertEq(rc.policyURI(), "/ipfs/bafkreiexample");
        assertEq(keccak256(abi.encode(rc.templateParts())), keccak256(abi.encode(variantParts(1))));
    }

    function test_config_ownerGates() public {
        bytes[10] memory calls = [
            abi.encodeCall(IRecourseCase.setPeer, (stranger)),
            abi.encodeCall(IRecourseCase.setParams, (DEADLINE, MAX_OPEN, RESEND_GAP, MAX_SENDS)),
            abi.encodeCall(IRecourseCase.setTrustedRelay, (stranger)),
            abi.encodeCall(IRecourseCase.sweepLink, (stranger)),
            abi.encodeCall(IRecourseCase.lockConfig, ()),
            abi.encodeCall(IRecourseCase.setExtraArgs, (BridgeCodec.extraArgsFor(1))),
            abi.encodeCall(IRecourseCase.setPolicyURI, ("/ipfs/x1")),
            abi.encodeCall(IRecourseCase.setTemplateText, (variantParts(1))),
            abi.encodeCall(IRecourseCase.withdrawFeePool, (1)),
            abi.encodeCall(Ownable.transferOwnership, (stranger))
        ];
        for (uint256 i = 0; i < calls.length; i++) {
            vm.prank(stranger);
            (bool ok, bytes memory ret) = address(rc).call(calls[i]);
            assertFalse(ok, vm.toString(i));
            assertEq(bytes4(ret), Ownable.OwnableUnauthorizedAccount.selector);
        }
    }

    function test_config_validation() public {
        vm.startPrank(owner);
        vm.expectRevert(IRecourseCase.ZeroAddress.selector);
        rc.setPeer(address(0));
        vm.expectRevert(IRecourseCase.BadParams.selector);
        rc.setParams(0, MAX_OPEN, RESEND_GAP, MAX_SENDS);
        vm.expectRevert(IRecourseCase.BadParams.selector);
        rc.setParams(DEADLINE, 0, RESEND_GAP, MAX_SENDS);
        vm.expectRevert(IRecourseCase.BadParams.selector);
        rc.setParams(DEADLINE, MAX_OPEN, RESEND_GAP, 0);
        vm.expectEmit(false, false, false, true, address(rc));
        emit IRecourseCase.ParamsSet(3 hours, 3, 0, 1);
        rc.setParams(3 hours, 3, 0, 1);

        vm.expectRevert(IRecourseCase.ZeroGasLimit.selector);
        rc.setExtraArgs(BridgeCodec.extraArgsFor(0));
        vm.expectRevert(IRecourseCase.ZeroGasLimit.selector);
        rc.setExtraArgs(hex"181dcf10");
        vm.expectRevert(IRecourseCase.ZeroGasLimit.selector);
        rc.setExtraArgs(hex"deadbeef0000000000000000000000000000000000000000000000000000000000030d40");
        vm.expectRevert(IRecourseCase.ZeroGasLimit.selector);
        rc.setExtraArgs("");
        rc.setExtraArgs(abi.encodeWithSelector(bytes4(0x97a657c9), uint256(200_000))); // V1
        rc.setExtraArgs(abi.encodePacked(bytes4(0xa69dd4aa), uint32(200_000), uint16(0))); // V3 prefix
        vm.expectRevert(IRecourseCase.ZeroGasLimit.selector);
        rc.setExtraArgs(abi.encodePacked(bytes4(0xa69dd4aa), uint32(0), uint16(0)));

        vm.expectRevert(IRecourseCase.BadParams.selector);
        rc.setPolicyURI("ipfs://bafkrei");
        vm.expectRevert(IRecourseCase.BadParams.selector);
        rc.setPolicyURI("/ipfs/");
        vm.stopPrank();
    }

    /// @dev The stored extra args set the receive gas of every later send: too little gas for the peer makes the
    /// local router's delivery fail, and restoring it makes the same relay succeed.
    function test_config_extraArgsUsedForLaterSends() public {
        toRuled(1, 1);
        vm.prank(owner);
        rc.setExtraArgs(BridgeCodec.extraArgsFor(5_000));
        vm.expectPartialRevert(CCIPLocalRouter.ReceiverError.selector);
        rc.relayRuling(idOf(1));
        vm.prank(owner);
        rc.setExtraArgs(BridgeCodec.extraArgsFor(RELAY_GAS));
        rc.relayRuling(idOf(1));
        assertEq(peer.receivedCount(), 1);
    }

    function test_sweepLink_beforeLock() public {
        vm.expectEmit(true, false, false, true, address(rc));
        emit IRecourseCase.LinkSwept(owner, 5 ether);
        vm.prank(owner);
        rc.sweepLink(owner);
        assertEq(link.balanceOf(owner), 5 ether);
        assertEq(link.balanceOf(address(rc)), 0);
        vm.prank(owner);
        vm.expectRevert(IRecourseCase.ZeroAddress.selector);
        rc.sweepLink(address(0));
    }

    function test_templateText_eventHash() public {
        string[4] memory parts = variantParts(1);
        vm.expectEmit(false, false, false, true, address(rc));
        emit IRecourseCase.TemplateTextSet(keccak256(abi.encode(parts)));
        vm.prank(owner);
        rc.setTemplateText(parts);
        assertEq(keccak256(abi.encode(rc.templateParts())), keccak256(abi.encode(parts)));
    }

    function test_ownership_twoStep() public {
        vm.prank(owner);
        rc.transferOwnership(stranger);
        assertEq(rc.owner(), owner);
        vm.prank(stranger);
        Ownable2Step(address(rc)).acceptOwnership();
        assertEq(rc.owner(), stranger);
    }

    // ================================================================== claim expiry

    /// @dev A claim filed `age` seconds before now, so it expires `CLAIM_TIMEOUT - age` from now.
    function _freshPayload(uint256 n, uint256 age) internal view returns (bytes memory) {
        ClaimToCourt memory c = claimOf(n);
        c.filedAt = uint64(block.timestamp - age);
        return BridgeCodec.encodeClaimToCourt(c);
    }

    function test_expiresAt_isFiledAtPlusTimeout() public {
        deliver(payloadOf(1));
        assertEq(rc.expiresAt(idOf(1)), claimOf(1).filedAt + CLAIM_TIMEOUT);
        assertEq(rc.expiresAt(idOf(2)), 0);
    }

    function test_expiresAt_saturatesInsteadOfReverting() public {
        ClaimToCourt memory c = claimOf(1);
        c.filedAt = type(uint64).max;
        deliver(BridgeCodec.encodeClaimToCourt(c));
        assertEq(uint8(stateOf(idOf(1))), uint8(CaseState.Received));
        assertEq(rc.expiresAt(idOf(1)), type(uint40).max);
    }

    /// @dev Disputes that never rule would hold every slot for good, also after lock; once their claims expire,
    /// anyone frees the slots and new claims open again. A late ruling for a freed case changes nothing.
    function test_markStale_freesSlotsHeldByUnruledDisputes() public {
        rc.fundFeePool{value: 1 ether}();
        uint256[] memory ids = new uint256[](MAX_OPEN);
        for (uint256 n = 1; n <= MAX_OPEN; ++n) {
            ids[n - 1] = receiveAndOpen(n);
        }
        vm.prank(owner);
        rc.lockConfig();
        assertEq(rc.openCases(), MAX_OPEN);

        vm.warp(rc.expiresAt(idOf(1)));
        bytes memory fresh = _freshPayload(100, 1 hours);
        deliver(fresh);
        vm.prank(keeper);
        vm.expectRevert(IRecourseCase.CapReached.selector);
        rc.openCase(fresh);

        uint256 pool = rc.feePool();
        for (uint256 n = 1; n <= MAX_OPEN; ++n) {
            vm.expectEmit(true, false, false, false, address(rc));
            emit IRecourseCase.ClaimStale(idOf(n));
            vm.prank(stranger);
            rc.markStale(idOf(n));
            assertEq(uint8(stateOf(idOf(n))), uint8(CaseState.Stale));
        }
        assertEq(rc.openCases(), 0);
        assertEq(rc.feePool(), pool);

        vm.prank(keeper);
        assertGt(rc.openCase(fresh), 0);
        assertEq(rc.openCases(), 1);

        vm.expectEmit(true, false, false, true, address(rc));
        emit IRecourseCase.RuleIgnored(ids[0], 1);
        arb.giveRuling(ids[0], 1);
        assertEq(uint8(stateOf(idOf(1))), uint8(CaseState.Stale));
        assertEq(rc.openCases(), 1);
    }

    function test_markStale_notBeforeExpiry() public {
        receiveAndOpen(1);
        uint64 at = rc.expiresAt(idOf(1));
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(IRecourseCase.NotExpired.selector, at));
        rc.markStale(idOf(1));
        vm.warp(at);
        rc.markStale(idOf(1));
        assertEq(rc.openCases(), 0);
    }

    function test_markStale_receivedAndRefilePending() public {
        deliver(payloadOf(1));
        toRuled(2, 0);
        assertEq(rc.openCases(), 1);
        vm.warp(rc.expiresAt(idOf(2)));
        rc.markStale(idOf(1));
        assertEq(rc.openCases(), 1, "a Received claim holds no slot");
        rc.markStale(idOf(2));
        assertEq(rc.openCases(), 0);
        assertEq(uint8(stateOf(idOf(1))), uint8(CaseState.Stale));
        assertEq(uint8(stateOf(idOf(2))), uint8(CaseState.Stale));
    }

    function test_markStale_wrongStates() public {
        vm.warp(T0 + 30 days);
        vm.expectRevert(abi.encodeWithSelector(IRecourseCase.WrongState.selector, idOf(1), CaseState.None));
        rc.markStale(idOf(1));

        vm.warp(T0);
        toRuled(1, 2);
        toRuled(2, 1);
        rc.relayRuling(idOf(2));
        deliver(payloadOf(3));
        vm.warp(T0 + 30 days);
        rc.markStale(idOf(3));
        CaseState[3] memory states = [CaseState.Ruled, CaseState.Relayed, CaseState.Stale];
        for (uint256 i = 0; i < 3; i++) {
            vm.expectRevert(abi.encodeWithSelector(IRecourseCase.WrongState.selector, idOf(i + 1), states[i]));
            rc.markStale(idOf(i + 1));
        }
        // A final ruling still relays after the claim's expiry; Hedera decides what to do with it.
        rc.relayRuling(idOf(1));
    }

    /// @dev A refusal late in the claim's life: the refile window is still open, but the claim has expired, so the
    /// second arbitration cost is not paid.
    function test_refile_afterExpirySpendsNothing() public {
        uint256 first = receiveAndOpen(1);
        vm.warp(block.timestamp + 8100); // about one court round
        arb.giveRuling(first, 0);
        vm.warp(block.timestamp + DEADLINE - 1); // inside ruledAt + caseDeadline, past expiresAt
        assertGe(block.timestamp, rc.expiresAt(idOf(1)));
        uint256 pool = rc.feePool();
        vm.expectEmit(true, false, false, false, address(rc));
        emit IRecourseCase.ClaimStale(idOf(1));
        vm.prank(keeper);
        assertEq(rc.refile(payloadOf(1)), 0);
        assertEq(rc.feePool(), pool);
        assertEq(rc.openCases(), 0);
        assertEq(arb.disputeCount(), 1);
        assertEq(uint8(stateOf(idOf(1))), uint8(CaseState.Stale));
    }

    function test_openCase_afterExpirySpendsNothing() public {
        // Filed 3.5 hours ago: expires in 30 minutes, well before receivedAt + caseDeadline.
        bytes memory payload = _freshPayload(1, 3.5 hours);
        deliver(payload);
        vm.warp(block.timestamp + 30 minutes);
        uint256 pool = rc.feePool();
        assertEq(rc.openCase(payload), 0);
        assertEq(uint8(stateOf(idOf(1))), uint8(CaseState.Stale));
        assertEq(rc.feePool(), pool);
        assertEq(rc.openCases(), 0);
        assertEq(arb.disputeCount(), 0);
    }

    // ================================================================== trusted relay

    function test_relayClaim_offByDefault() public {
        vm.prank(stranger);
        vm.expectRevert(IRecourseCase.RelayDisabled.selector);
        rc.relayClaim(payloadOf(1));
    }

    function test_relayClaim_onlyRelay_andSameStorage() public {
        address relay = makeAddr("relay");
        vm.prank(owner);
        rc.setTrustedRelay(relay);
        vm.prank(stranger);
        vm.expectRevert(IRecourseCase.NotTrustedRelay.selector);
        rc.relayClaim(payloadOf(1));

        bytes memory payload = payloadOf(1);
        vm.expectEmit(true, true, false, true, address(rc));
        emit IRecourseCase.ClaimReceived(idOf(1), bytes32(0), payload);
        vm.prank(relay);
        rc.relayClaim(payload);
        assertEq(viewOf(idOf(1)).payloadHash, keccak256(payload));

        bytes memory bad = bytes.concat(payload);
        bad[31] = 0x09;
        vm.expectEmit(true, false, false, true, address(rc));
        emit IRecourseCase.ClaimRejected(bytes32(0), 4);
        vm.prank(relay);
        rc.relayClaim(bad);

        vm.prank(owner);
        rc.setTrustedRelay(address(0));
        vm.prank(relay);
        vm.expectRevert(IRecourseCase.RelayDisabled.selector);
        rc.relayClaim(payloadOf(2));
    }

    function test_dedupe_acrossBothIngresses() public {
        address relay = makeAddr("relay");
        vm.prank(owner);
        rc.setTrustedRelay(relay);

        deliver(payloadOf(1));
        vm.expectEmit(true, true, false, false, address(rc));
        emit IRecourseCase.ClaimDuplicate(idOf(1), bytes32(0));
        vm.prank(relay);
        rc.relayClaim(payloadOf(1));

        vm.prank(relay);
        rc.relayClaim(payloadOf(2));
        vm.expectEmit(true, false, false, false, address(rc));
        emit IRecourseCase.ClaimDuplicate(idOf(2), bytes32(0));
        deliver(payloadOf(2));
        assertEq(viewOf(idOf(2)).receivedAt, T0);
    }

    function test_relayPath_withoutPeer_relayRulingNeedsPeer() public {
        RecourseCase fresh = _deploy();
        address relay = makeAddr("relay");
        vm.startPrank(owner);
        fresh.setTrustedRelay(relay);
        fresh.setTemplateText(variantParts(0));
        fresh.setPolicyURI(policyURI);
        vm.stopPrank();
        fresh.fundFeePool{value: POOL}();
        bytes memory payload = payloadOf(1);
        vm.prank(relay);
        fresh.relayClaim(payload);
        uint256 disputeId = fresh.openCase(payload);
        arb.giveRuling(disputeId, 1);
        assertEq(uint8(fresh.caseOf(idOf(1)).state), uint8(CaseState.Ruled));
        vm.expectRevert(IRecourseCase.PeerNotSet.selector);
        fresh.relayRuling(idOf(1));
        vm.expectRevert(IRecourseCase.PeerNotSet.selector);
        fresh.quoteRelay(idOf(1));
    }

    // ================================================================== ids

    function test_externalIdOf_matchesSharedVector() public {
        string memory j = vm.readFile(string.concat(VECTORS, "ids.json"));
        address at = vm.parseJsonAddress(j, ".externalId[0].recourseCase");
        vm.chainId(vm.parseJsonUint(j, ".externalId[0].chainId"));
        deployCodeTo(
            "RecourseCase.sol:RecourseCase",
            abi.encode(
                address(router),
                address(link),
                address(arb),
                address(reg),
                sel,
                owner,
                RecourseCase.Params(DEADLINE, MAX_OPEN, RESEND_GAP, MAX_SENDS),
                RELAY_GAS,
                CLAIM_TIMEOUT
            ),
            at
        );
        bytes32 claimId = vm.parseJsonBytes32(j, ".externalId[0].claimId");
        for (uint256 i = 0; i < 2; i++) {
            string memory p = string.concat(".externalId[", vm.toString(i), "]");
            uint8 attempt = uint8(vm.parseJsonUint(j, string.concat(p, ".attempt")));
            assertEq(
                IRecourseCase(at).externalIdOf(claimId, attempt), vm.parseJsonUint(j, string.concat(p, ".expectedUint"))
            );
        }
    }

    // ================================================================== gas of the court calls (mock court)

    function test_openCase_gas_mockCourt() public {
        bytes memory payload = payloadOf(1);
        deliver(payload);
        uint256 g = gasleft();
        rc.openCase(payload);
        emit log_named_uint("openCase gas (mock court and registry)", g - gasleft());
    }

    // ================================================================== helpers

    function _expectRejected(bytes memory data, uint8 reason) internal {
        bytes32 id = keccak256(data);
        vm.expectEmit(true, false, false, true, address(rc));
        emit IRecourseCase.ClaimRejected(id, reason);
        deliverRaw(id, sel, abi.encode(address(peer)), data);
    }

    function _any2evm(bytes32 id, uint64 source, bytes memory sender, bytes memory data)
        internal
        pure
        returns (Client.Any2EVMMessage memory)
    {
        return Client.Any2EVMMessage({
            messageId: id,
            sourceChainSelector: source,
            sender: sender,
            data: data,
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });
    }

    function _tryDecode(bytes memory data) internal pure returns (bool, ClaimToCourt memory) {
        (DecodeStatus s, ClaimToCourt memory m) = BridgeCodec.tryDecodeClaimToCourt(data);
        return (s == DecodeStatus.Ok, m);
    }

    function _slice(bytes memory b, uint256 from, uint256 to) internal pure returns (bytes memory out) {
        out = new bytes(to - from);
        for (uint256 i = from; i < to; i++) {
            out[i - from] = b[i];
        }
    }
}
