// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Vm} from "forge-std/Test.sol";

import {BridgeCodec} from "../../src/shared/BridgeCodec.sol";
import {
    CaseState,
    ClaimStatus,
    ClaimToCourt,
    Claim,
    DecodeStatus,
    RulingBack
} from "../../src/shared/RecourseTypes.sol";
import {RecourseCase} from "../../src/arbitrum/RecourseCase.sol";
import {CaseView, IRecourseCase} from "../../src/arbitrum/IRecourseCase.sol";
import {IRecourseClaims} from "../../src/hedera/interfaces/IRecourseClaims.sol";
import {CaseTimeouts} from "../../script/arbitrum/CaseTimeouts.sol";
import {ClaimsBase} from "../hedera/ClaimsBase.sol";
import {MockArbitrator} from "./mocks/MockArbitrator.sol";
import {MockTemplateRegistry} from "./mocks/MockTemplateRegistry.sol";

/// @notice Integration on one local EVM (a unit test, not a delivery): the Hedera RecourseClaims sends a contested
/// claim, RecourseCase receives it through the chainlink-local router, a mock court rules, and the ruling goes back
/// to RecourseClaims, which ends Ruled.
/// @dev The local router stamps its own chain selector on what it delivers. RecourseCase is built with that
/// selector as "Hedera", so the claim leg runs through the router unchanged. RecourseClaims accepts rulings only
/// from the Arbitrum selector, so the return leg is routed by the test with that selector and the case as sender,
/// carrying the RulingBack bytes RecourseCase sends (the unit suite pins those bytes to this encoding).
/// The case is built as the testnet deploy builds it: Hedera's claim timeout less the relay budget, so the expiry tests
/// below run on the deployed timing (a ruling's CCIP flight is modelled by warping before the RulingBack is routed).
contract CrossChainTest is ClaimsBase {
    uint256 internal constant COST = 810_000_000_000_000;
    string internal constant GOLDEN = "../packages/court/template/golden.json";
    /// @dev Handling for BASKET (120 USDC) under the default Hedera parameters.
    uint256 internal constant H = 21 * USDC;
    uint64 internal constant ROUND = 2 hours;

    RecourseCase internal rc;
    MockArbitrator internal arb;
    MockTemplateRegistry internal reg;

    function setUp() public {
        _setUpClaims();
        (bool ok, bytes memory ret) = address(sim).staticcall(abi.encodeWithSignature("configuration()"));
        require(ok, "config");
        (uint64 simSelector) = abi.decode(ret, (uint64));

        arb = new MockArbitrator(COST, 500);
        reg = new MockTemplateRegistry();
        rc = new RecourseCase(
            address(router),
            address(linkToken),
            address(arb),
            address(reg),
            simSelector,
            owner,
            RecourseCase.Params({caseDeadline: ROUND, maxOpenCases: 10, resendGap: 30 minutes, maxSends: 5}),
            RECEIVE_GAS,
            CaseTimeouts.caseClaimTimeout(_params().claimTimeout, CaseTimeouts.RELAY_BUDGET)
        );
        string memory golden = vm.readFile(GOLDEN);
        string[4] memory parts;
        for (uint256 k = 0; k < 4; k++) {
            parts[k] = string(vm.parseJsonBytes(golden, string.concat(".variants[0].parts[", vm.toString(k), "]")));
        }
        vm.startPrank(owner);
        rc.setPeer(address(claims));
        rc.setTemplateText(parts);
        rc.setPolicyURI(vm.parseJsonString(golden, ".policyURI"));
        claims.setPeer(address(rc));
        vm.stopPrank();
        vm.deal(address(this), 1 ether);
        rc.fundFeePool{value: 0.01 ether}();
        sim.requestLinkFromFaucet(address(rc), 5 ether);
    }

    function test_claimInRulingBack_eachFinalRuling() public {
        for (uint8 r = 1; r <= 3; r++) {
            (bytes32 id, bytes memory payload) = _toCourt(1, 1);
            uint256 disputeId = rc.openCase(payload);
            arb.giveRuling(disputeId, r);
            _relayAndReturn(id);
            Claim memory c = claims.getClaim(id);
            assertEq(uint8(c.status), uint8(ClaimStatus.Ruled), "Hedera not ruled");
            assertEq(c.ruling, r);
            assertEq(c.attempts, 1);
            assertEq(c.disputeId, disputeId);
        }
    }

    function test_claimInRefusalThenRuling() public {
        (bytes32 id, bytes memory payload) = _toCourt(3, 2);
        uint256 first = rc.openCase(payload);
        arb.giveRuling(first, 0);
        assertEq(uint8(rc.caseOf(id).state), uint8(CaseState.RefilePending));
        uint256 second = rc.refile(payload);
        arb.giveRuling(second, 2);
        _relayAndReturn(id);
        Claim memory c = claims.getClaim(id);
        assertEq(uint8(c.status), uint8(ClaimStatus.Ruled));
        assertEq(c.ruling, 2);
        assertEq(c.attempts, 2);
        assertEq(c.disputeId, second);
    }

    // ------------------------------------------------------------ the two clocks

    /// A ruling 60 s before the case's cut-off, relayed at once, lands 20 min later. Hedera's expiry is the relay
    /// budget further out, so a third party cannot expire the claim first, and the ruling settles.
    function test_xchain_rulingJustBeforeCutOff_landsBeforeHederaExpiry() public {
        uint256 t0 = block.timestamp;
        (bytes32 id, bytes memory payload) = _toCourtAfter(6);
        uint256 disputeId = rc.openCase(payload);
        assertEq(rc.expiresAt(id), t0 + _params().claimTimeout - CaseTimeouts.RELAY_BUDGET);

        vm.warp(rc.expiresAt(id) - 60);
        arb.giveRuling(disputeId, 1);
        rc.relayRuling(id);
        vm.warp(block.timestamp + 20 minutes); // the RulingBack in flight
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.NotExpired.selector, t0 + 6 + _params().claimTimeout));
        claims.expireClaim(id);

        _routeBack(id);
        assertEq(uint8(claims.getClaim(id).status), uint8(ClaimStatus.Ruled));
        claims.settle(id);
        assertEq(vault.creditOf(shop), NET_LOSS + H + FEE, "the shop gets what it won");
        _assertBooks();
    }

    /// A ruling at the cut-off is dropped on Arbitrum (Stale, slot freed, nothing to relay), and the claim expires
    /// on Hedera with the fee refunded: both chains agree there was no ruling.
    function test_xchain_rulingAtCutOff_isStaleThereAndExpiresHere() public {
        (bytes32 id, bytes memory payload) = _toCourtAfter(6);
        uint256 disputeId = rc.openCase(payload);
        vm.warp(rc.expiresAt(id));
        arb.giveRuling(disputeId, 1);
        assertEq(uint8(rc.caseOf(id).state), uint8(CaseState.Stale));
        assertEq(rc.openCases(), 0);
        vm.expectRevert(abi.encodeWithSelector(IRecourseCase.WrongState.selector, id, CaseState.Stale));
        rc.relayRuling(id);

        vm.warp(uint256(claims.getClaim(id).preCheckedAt) + _params().claimTimeout + 1);
        vm.prank(stranger);
        claims.expireClaim(id);
        assertEq(uint8(claims.getClaim(id).status), uint8(ClaimStatus.Expired));
        assertEq(vault.creditOf(shop), FEE, "fee refunded");
        assertEq(vault.reservedOf(platform), 0);
        _assertBooks();
    }

    /// A pre-check 15 h late leaves the case 1 h, less than a court round: it goes Stale on arrival and the fee
    /// pool pays nothing. Hedera keeps counting from the pre-check and then refunds the fee.
    function test_xchain_latePrecheck_caseSpendsNothing_hederaRefunds() public {
        (bytes32 id, bytes memory payload) = _toCourtAfter(15 hours);
        uint256 pool = rc.feePool();
        assertEq(rc.openCase(payload), 0);
        assertEq(uint8(rc.caseOf(id).state), uint8(CaseState.Stale));
        assertEq(rc.feePool(), pool, "no arbitration cost for a case that cannot finish");
        assertEq(arb.disputeCount(), 0);

        uint256 expiresAfter = uint256(claims.getClaim(id).preCheckedAt) + _params().claimTimeout;
        vm.warp(expiresAfter);
        vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.NotExpired.selector, expiresAfter));
        claims.expireClaim(id);
        vm.warp(expiresAfter + 1);
        vm.prank(stranger);
        claims.expireClaim(id);
        assertEq(vault.creditOf(shop), FEE);
        _assertBooks();
    }

    /// A pre-check 12 h late still leaves a round: the case opens. Nobody rules in time; at the cut-off a stranger
    /// frees the slot, a ruling after it is ignored, and Hedera expires the claim from its own clock.
    function test_xchain_latePrecheck_opensThenMarkStaleAtCutOff() public {
        (bytes32 id, bytes memory payload) = _toCourtAfter(12 hours);
        uint256 disputeId = rc.openCase(payload);
        assertGt(disputeId, 0);
        vm.warp(rc.expiresAt(id));
        vm.prank(stranger);
        rc.markStale(id);
        assertEq(rc.openCases(), 0);
        vm.warp(block.timestamp + 1 hours);
        arb.giveRuling(disputeId, 1);
        assertEq(uint8(rc.caseOf(id).state), uint8(CaseState.Stale));
        assertEq(uint8(claims.getClaim(id).status), uint8(ClaimStatus.AtCourt));

        vm.warp(uint256(claims.getClaim(id).preCheckedAt) + _params().claimTimeout + 1);
        vm.prank(stranger);
        claims.expireClaim(id);
        assertEq(vault.creditOf(shop), FEE);
        _assertBooks();
    }

    /// @dev Files a claim now, pre-checks it (finding against the platform) `delay` seconds later, has the platform
    /// contest and sends it; returns the id and the payload the case stored.
    function _toCourtAfter(uint256 delay) internal returns (bytes32 id, bytes memory payload) {
        id = _file();
        vm.warp(block.timestamp + delay);
        _precheck(id, 2, 1);
        _contest(id);
        vm.recordLogs();
        claims.sendToCourt(id);
        payload = _storedPayload(id);
    }

    function _storedPayload(bytes32 id) internal view returns (bytes memory payload) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(rc) && logs[i].topics[0] == IRecourseCase.ClaimReceived.selector) {
                payload = abi.decode(logs[i].data, (bytes));
            }
        }
        assertEq(payload.length, BridgeCodec.CLAIM_TO_COURT_LEN, "case did not receive the claim");
        assertEq(uint8(rc.caseOf(id).state), uint8(CaseState.Received));
    }

    /// @dev Routes to the claims contract, as the Arbitrum source, the RulingBack the case relayed.
    function _routeBack(bytes32 id) internal {
        CaseView memory v = rc.caseOf(id);
        assertEq(uint8(v.state), uint8(CaseState.Relayed));
        bytes memory data = BridgeCodec.encodeRulingBack(
            RulingBack({
                version: 1, claimId: id, disputeId: v.disputeIds[v.attempts - 1], ruling: v.ruling, attempts: v.attempts
            })
        );
        (bool ok,) = _route(_rulingMsg(data, address(rc), ARB_SEL));
        assertTrue(ok, "claims receive reverted");
    }

    /// @dev Files, pre-checks, contests and sends a claim; returns its id and the payload the case stored.
    function _toCourt(uint8 gap, uint8 answer) internal returns (bytes32 id, bytes memory payload) {
        vm.recordLogs();
        id = _atCourt(gap, answer);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(rc) && logs[i].topics[0] == IRecourseCase.ClaimReceived.selector) {
                payload = abi.decode(logs[i].data, (bytes));
            }
        }
        assertEq(payload.length, BridgeCodec.CLAIM_TO_COURT_LEN, "case did not receive the claim");
        (DecodeStatus s, ClaimToCourt memory m) = BridgeCodec.tryDecodeClaimToCourt(payload);
        assertEq(uint8(s), uint8(DecodeStatus.Ok));
        assertEq(m.claimId, id);
        assertEq(m.gap, gap);
        assertEq(m.answer, answer);
        assertEq(uint8(rc.caseOf(id).state), uint8(CaseState.Received));
    }

    /// @dev Relays from the case, then carries the same RulingBack to the claims contract as the Arbitrum source.
    function _relayAndReturn(bytes32 id) internal {
        rc.relayRuling(id);
        CaseView memory v = rc.caseOf(id);
        assertEq(uint8(v.state), uint8(CaseState.Relayed));
        bytes memory data = BridgeCodec.encodeRulingBack(
            RulingBack({
                version: 1, claimId: id, disputeId: v.disputeIds[v.attempts - 1], ruling: v.ruling, attempts: v.attempts
            })
        );
        (bool ok,) = _route(_rulingMsg(data, address(rc), ARB_SEL));
        assertTrue(ok, "claims receive reverted");
    }
}
