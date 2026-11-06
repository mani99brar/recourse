// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {BridgeCodec} from "../../src/shared/BridgeCodec.sol";
import {CaseState, ClaimToCourt} from "../../src/shared/RecourseTypes.sol";
import {RecourseCase} from "../../src/arbitrum/RecourseCase.sol";
import {IRecourseCase} from "../../src/arbitrum/IRecourseCase.sol";
import {CaseBase} from "./CaseBase.sol";
import {MockArbitrator} from "./mocks/MockArbitrator.sol";

/// @notice Court timing against a realistic claim timeout: a case waits for a slot or the fee pool instead of
/// going Stale, never pays for a dispute that cannot finish before `expiresAt`, and drops a ruling that arrives at
/// or after `expiresAt`. Also the lock-time guards on the template, the policy and the trusted relay.
contract CaseTimingTest is CaseBase {
    /// @dev Hedera's 18 h less a 2 h relay budget.
    uint64 internal constant LONG_TIMEOUT = 16 hours;
    /// @dev The time a court round needs (`caseDeadline`): court 8's four periods.
    uint64 internal constant ROUND = 8_100;

    function setUp() public override {
        super.setUp();
        rc = new RecourseCase(
            address(router),
            address(link),
            address(arb),
            address(reg),
            sel,
            owner,
            RecourseCase.Params({caseDeadline: ROUND, maxOpenCases: 1, resendGap: RESEND_GAP, maxSends: MAX_SENDS}),
            RELAY_GAS,
            LONG_TIMEOUT
        );
        vm.startPrank(owner);
        rc.setPeer(address(peer));
        rc.setTemplateText(variantParts(0));
        rc.setPolicyURI(policyURI);
        vm.stopPrank();
        rc.fundFeePool{value: POOL}();
        sim.requestLinkFromFaucet(address(rc), 5 ether);
    }

    /// @dev Claim `n` filed `ago` seconds before now.
    function _payload(uint256 n, uint256 ago) internal view returns (bytes memory) {
        ClaimToCourt memory c = claimOf(n);
        c.filedAt = uint64(block.timestamp - ago);
        return BridgeCodec.encodeClaimToCourt(c);
    }

    function _open(uint256 n, uint256 ago) internal returns (bytes memory payload, uint256 disputeId) {
        payload = _payload(n, ago);
        deliver(payload);
        disputeId = rc.openCase(payload);
    }

    // ------------------------------------------------------------ waiting for capacity

    /// The cap is full for longer than a court round. When the slot frees, the waiting claim still opens.
    function test_capFull_caseWaitsForASlotInsteadOfGoingStale() public {
        (, uint256 first) = _open(1, 30 minutes);
        bytes memory second = _payload(2, 30 minutes);
        deliver(second);
        vm.expectRevert(IRecourseCase.CapReached.selector);
        rc.openCase(second);

        vm.warp(block.timestamp + 3 hours); // past receivedAt + caseDeadline
        vm.expectRevert(IRecourseCase.CapReached.selector);
        rc.openCase(second);
        arb.giveRuling(first, 2); // frees the slot

        assertGt(rc.openCase(second), 0);
        assertEq(uint8(stateOf(idOf(2))), uint8(CaseState.Opened));
        assertEq(rc.openCases(), 1);
    }

    /// With the court taking a full round (the mock refuses to rule earlier), a cap that stays full for that round
    /// keeps the next claim waiting past the old 2 h cliff, and it opens when the round ends.
    function test_capFullForARealRound_caseOpensWhenTheRoundEnds() public {
        arb.setMinTimeToRuling(ROUND);
        (, uint256 first) = _open(1, 30 minutes);
        uint256 openedAt = block.timestamp;
        bytes memory second = _payload(2, 30 minutes);
        deliver(second);
        vm.warp(openedAt + 2 hours);
        vm.expectRevert(abi.encodeWithSelector(MockArbitrator.MockTooEarly.selector, openedAt + ROUND));
        arb.giveRuling(first, 1);
        vm.expectRevert(IRecourseCase.CapReached.selector);
        rc.openCase(second);

        vm.warp(openedAt + ROUND);
        arb.giveRuling(first, 1);
        assertGt(rc.openCase(second), 0);
        assertEq(uint8(stateOf(idOf(2))), uint8(CaseState.Opened));
        // The second case keeps a full round before its own cut-off.
        assertGe(uint256(rc.expiresAt(idOf(2))) - block.timestamp, ROUND);
    }

    /// The fee pool is short for hours. Once it is funded, the waiting claim opens.
    function test_poolLow_caseWaitsForFundingInsteadOfGoingStale() public {
        vm.prank(owner);
        rc.withdrawFeePool(POOL);
        bytes memory payload = _payload(1, 30 minutes);
        deliver(payload);
        vm.expectRevert(abi.encodeWithSelector(IRecourseCase.FeePoolLow.selector, 0, COST));
        rc.openCase(payload);

        vm.warp(block.timestamp + 5 hours);
        vm.expectRevert(abi.encodeWithSelector(IRecourseCase.FeePoolLow.selector, 0, COST));
        rc.openCase(payload);
        rc.fundFeePool{value: COST}();
        assertGt(rc.openCase(payload), 0);
        assertEq(uint8(stateOf(idOf(1))), uint8(CaseState.Opened));
    }

    // ------------------------------------------------------------ no dispute that cannot finish

    /// A late pre-check leaves less than a court round before `expiresAt`: the case goes Stale on arrival and the
    /// pool pays nothing, even with a slot and the pool free.
    function test_latePrecheck_caseThatCannotFinishSpendsNothing() public {
        bytes memory payload = _payload(1, LONG_TIMEOUT - ROUND + 1);
        deliver(payload);
        uint256 pool = rc.feePool();
        vm.expectEmit(true, false, false, false, address(rc));
        emit IRecourseCase.ClaimStale(idOf(1));
        assertEq(rc.openCase(payload), 0);
        assertEq(rc.feePool(), pool);
        assertEq(arb.disputeCount(), 0);
        assertEq(uint8(stateOf(idOf(1))), uint8(CaseState.Stale));
    }

    /// Exactly a court round left: still opens.
    function test_latePrecheck_aFullRoundLeftStillOpens() public {
        bytes memory payload = _payload(1, LONG_TIMEOUT - ROUND - 1);
        deliver(payload);
        assertGt(rc.openCase(payload), 0);
    }

    /// A refusal leaves less than a court round: refile frees the slot and spends nothing.
    function test_refile_withLessThanARoundLeftGoesStale() public {
        (bytes memory payload, uint256 first) = _open(1, 30 minutes);
        vm.warp(block.timestamp + LONG_TIMEOUT - 30 minutes - ROUND);
        arb.giveRuling(first, 0);
        assertEq(uint8(stateOf(idOf(1))), uint8(CaseState.RefilePending));
        uint256 pool = rc.feePool();
        assertEq(rc.refile(payload), 0);
        assertEq(uint8(stateOf(idOf(1))), uint8(CaseState.Stale));
        assertEq(rc.feePool(), pool);
        assertEq(rc.openCases(), 0);
    }

    /// The pool is short when the refusal comes and stays short past a round: the refile waits for funding.
    function test_refile_waitsForFunding() public {
        (bytes memory payload, uint256 first) = _open(1, 30 minutes);
        arb.giveRuling(first, 0);
        uint256 left = rc.feePool();
        vm.prank(owner);
        rc.withdrawFeePool(left);
        vm.warp(block.timestamp + 4 hours);
        vm.expectRevert(abi.encodeWithSelector(IRecourseCase.FeePoolLow.selector, 0, COST));
        rc.refile(payload);
        rc.fundFeePool{value: COST}();
        assertGt(rc.refile(payload), 0);
        assertEq(viewOf(idOf(1)).attempts, 2);
    }

    // ------------------------------------------------------------ ruling at the cut-off

    /// A ruling at `expiresAt` is too late for Hedera's relay budget: the case goes Stale, frees its slot and has
    /// nothing to relay.
    function test_rulingAtExpiry_isStaleAndNeverRelayed() public {
        (, uint256 disputeId) = _open(1, 30 minutes);
        vm.warp(rc.expiresAt(idOf(1)));
        vm.expectEmit(true, false, false, true, address(rc));
        emit IRecourseCase.RuleIgnored(disputeId, 1);
        vm.expectEmit(true, false, false, false, address(rc));
        emit IRecourseCase.ClaimStale(idOf(1));
        arb.giveRuling(disputeId, 1);
        assertEq(uint8(stateOf(idOf(1))), uint8(CaseState.Stale));
        assertEq(rc.openCases(), 0);
        assertEq(viewOf(idOf(1)).ruledAt, 0);
        vm.expectRevert(abi.encodeWithSelector(IRecourseCase.WrongState.selector, idOf(1), CaseState.Stale));
        rc.relayRuling(idOf(1));
    }

    /// One second earlier the ruling stands and is relayed.
    function test_rulingJustBeforeExpiry_isFinal() public {
        (, uint256 disputeId) = _open(1, 30 minutes);
        vm.warp(rc.expiresAt(idOf(1)) - 1);
        arb.giveRuling(disputeId, 1);
        assertEq(uint8(stateOf(idOf(1))), uint8(CaseState.Ruled));
        rc.relayRuling(idOf(1));
        assertEq(uint8(stateOf(idOf(1))), uint8(CaseState.Relayed));
    }

    // ------------------------------------------------------------ lock

    /// The template text, which says what rulings 1, 2 and 3 mean, and the policy are frozen at lock.
    function test_lock_freezesTemplateAndPolicy() public {
        vm.startPrank(owner);
        rc.lockConfig();
        vm.expectRevert(IRecourseCase.ConfigIsLocked.selector);
        rc.setTemplateText(variantParts(1));
        vm.expectRevert(IRecourseCase.ConfigIsLocked.selector);
        rc.setPolicyURI("/ipfs/bafkreiexample");
        vm.stopPrank();
        assertEq(keccak256(abi.encode(rc.templateParts())), keccak256(abi.encode(variantParts(0))));
        assertEq(rc.policyURI(), policyURI);
    }

    /// A lock without the template or the policy would leave a case that can never open a dispute.
    function test_lock_needsTemplateAndPolicy() public {
        RecourseCase fresh = _deploy();
        vm.startPrank(owner);
        fresh.setPeer(address(peer));
        vm.expectRevert(IRecourseCase.TemplateNotSet.selector);
        fresh.lockConfig();
        fresh.setTemplateText(variantParts(0));
        vm.expectRevert(IRecourseCase.TemplateNotSet.selector);
        fresh.lockConfig();
        fresh.setPolicyURI(policyURI);
        fresh.lockConfig();
        vm.stopPrank();
        assertTrue(fresh.locked());
    }

    /// With a CCIP peer set, a trusted relay left in place could store forged facts under a real claim id ahead
    /// of the CCIP copy. The lock clears it.
    function test_lock_clearsATrustedRelayAlongsideThePeer() public {
        address relay = makeAddr("relay");
        vm.startPrank(owner);
        rc.setTrustedRelay(relay);
        vm.expectEmit(false, false, false, true, address(rc));
        emit IRecourseCase.TrustedRelaySet(address(0));
        rc.lockConfig();
        vm.stopPrank();
        assertEq(rc.trustedRelay(), address(0));
        vm.prank(relay);
        vm.expectRevert(IRecourseCase.RelayDisabled.selector);
        rc.relayClaim(payloadOf(1));
    }

    /// The no-CCIP path (no peer) keeps its relay through the lock; a case with neither ingress cannot lock.
    function test_lock_relayOnlyPathKeepsItsRelay() public {
        RecourseCase fresh = _deploy();
        address relay = makeAddr("relay");
        vm.startPrank(owner);
        fresh.setTemplateText(variantParts(0));
        fresh.setPolicyURI(policyURI);
        vm.expectRevert(IRecourseCase.PeerNotSet.selector);
        fresh.lockConfig();
        fresh.setTrustedRelay(relay);
        fresh.lockConfig();
        vm.stopPrank();
        assertEq(fresh.trustedRelay(), relay);
    }

    // ------------------------------------------------------------ extra args the lane accepts

    function test_setExtraArgs_refusesArgsTheLaneRejects_afterLock() public {
        bytes4 v2 = BridgeCodec.GENERIC_EXTRA_ARGS_V2_TAG;
        bytes[6] memory bad = [
            abi.encodeWithSelector(bytes4(0x97a657c9), uint256(200_000)), // V1: no out-of-order flag
            abi.encodePacked(bytes4(0xa69dd4aa), uint32(200_000), uint16(0)), // V3 prefix
            BridgeCodec.extraArgsFor(30_000_000), // above the lane's cap
            BridgeCodec.extraArgsFor(5_000), // below what the RulingBack receive needs
            abi.encodeWithSelector(v2, uint256(200_000), false), // in-order execution
            bytes.concat(BridgeCodec.extraArgsFor(200_000), hex"00") // trailing byte
        ];
        vm.startPrank(owner);
        rc.lockConfig();
        for (uint256 i; i < bad.length; ++i) {
            (bool ok,) = address(rc).call(abi.encodeCall(IRecourseCase.setExtraArgs, (bad[i])));
            assertFalse(ok, vm.toString(i));
        }
        rc.setExtraArgs(BridgeCodec.extraArgsFor(3_000_000));
        rc.setExtraArgs(BridgeCodec.extraArgsFor(200_000));
        vm.stopPrank();
        assertEq(rc.extraArgs(), BridgeCodec.extraArgsFor(200_000));
    }
}
