// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {CCIPLocalRouter} from "@chainlink/local/src/ccip/CCIPLocalRouter.sol";

import {CaseState} from "../../src/shared/RecourseTypes.sol";
import {RecourseCase} from "../../src/arbitrum/RecourseCase.sol";
import {CaseView} from "../../src/arbitrum/IRecourseCase.sol";
import {CaseBase, TestPayloads} from "./CaseBase.sol";
import {MockArbitrator} from "./mocks/MockArbitrator.sol";
import {MockClaimsPeer} from "./mocks/MockClaimsPeer.sol";

/// @dev Drives RecourseCase through random sequences of every public action over a small set of claims, and keeps
/// ghost totals of the ETH that went in and out.
contract CaseHandler is CommonBase, StdUtils {
    uint256 internal constant CLAIMS = 4;

    RecourseCase internal rc;
    MockArbitrator internal arb;
    MockClaimsPeer internal peer;
    CCIPLocalRouter internal router;
    address internal owner;
    uint64 internal sel;

    uint256 public funded;
    uint256 public withdrawn;
    uint256 public paidToCourt;
    bool public wrongAmountPaid;
    bool public ruleReverted;
    bool public stateRegressed;
    uint256 public opens;
    uint256 public refiles;
    uint256 public relays;
    mapping(uint256 => uint256) internal progressOf;

    constructor(
        RecourseCase rc_,
        MockArbitrator arb_,
        MockClaimsPeer peer_,
        CCIPLocalRouter router_,
        address owner_,
        uint64 sel_
    ) {
        rc = rc_;
        arb = arb_;
        peer = peer_;
        router = router_;
        owner = owner_;
        sel = sel_;
    }

    receive() external payable {}

    // ------------------------------------------------------------------ actions

    function deliver(uint256 n) external {
        n = n % CLAIMS;
        vm.deal(address(peer), 1 ether); // the claims side pays its own CCIP fee
        peer.sendClaim(sel, address(rc), TestPayloads.payloadOf(n));
        _check(n);
    }

    function openCase(uint256 n) external {
        n = n % CLAIMS;
        uint256 cost = rc.costNow();
        try rc.openCase(TestPayloads.payloadOf(n)) returns (uint256 disputeId) {
            CaseView memory v = rc.caseOf(TestPayloads.idOf(n));
            if (v.state == CaseState.Opened) {
                _paid(disputeId, cost);
                opens++;
            }
        } catch {}
        _check(n);
    }

    function refile(uint256 n) external {
        n = n % CLAIMS;
        uint256 cost = rc.costNow();
        try rc.refile(TestPayloads.payloadOf(n)) returns (uint256 disputeId) {
            CaseView memory v = rc.caseOf(TestPayloads.idOf(n));
            if (v.state == CaseState.Opened) {
                _paid(disputeId, cost);
                refiles++;
            }
        } catch {}
        _check(n);
    }

    function giveRuling(uint256 n, uint256 ruling, bool olderAttempt) external {
        n = n % CLAIMS;
        ruling = ruling % 6; // 0-3 valid, 4-5 out of range
        CaseView memory v = rc.caseOf(TestPayloads.idOf(n));
        if (v.attempts == 0) return;
        uint256 disputeId = olderAttempt ? v.disputeIds[0] : v.disputeIds[v.attempts - 1];
        try arb.giveRuling(disputeId, ruling) {}
        catch {
            ruleReverted = true;
        }
        _check(n);
    }

    function markStale(uint256 n) external {
        n = n % CLAIMS;
        try rc.markStale(TestPayloads.idOf(n)) {} catch {}
        _check(n);
    }

    function relay(uint256 n, bool native, uint256 extra) external {
        n = n % CLAIMS;
        bytes32 claimId = TestPayloads.idOf(n);
        if (native) {
            extra = bound(extra, 0, 1 ether);
            uint256 fee;
            try rc.quoteRelayNative(claimId) returns (uint256 f) {
                fee = f;
            } catch {
                return;
            }
            vm.deal(address(this), address(this).balance + fee + extra);
            try rc.relayRuling{value: fee + extra}(claimId) {
                relays++;
            } catch {}
        } else {
            try rc.relayRuling(claimId) {
                relays++;
            } catch {}
        }
        _check(n);
    }

    /// @dev Moves claim `n` one step along its path, so random runs reach refiles and relays often.
    function advance(uint256 n, uint256 ruling) public {
        n = n % CLAIMS;
        CaseState st = rc.caseOf(TestPayloads.idOf(n)).state;
        if (st == CaseState.None) this.deliver(n);
        else if (st == CaseState.Received) this.openCase(n);
        else if (st == CaseState.Opened) this.giveRuling(n, ruling, false);
        else if (st == CaseState.RefilePending) this.refile(n);
        else if (st == CaseState.Ruled || st == CaseState.Relayed) this.relay(n, ruling % 2 == 0, ruling);
    }

    /// @dev Extra entry points to the same step, so the fuzzer picks the path step more often than the rest.
    function advanceAgain(uint256 n, uint256 ruling) external {
        advance(n, ruling);
    }

    function advanceOnceMore(uint256 n, uint256 ruling) external {
        advance(n, ruling);
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 50 minutes));
    }

    function setCost(uint256 cost) external {
        arb.setCost(bound(cost, 0, 0.004 ether));
    }

    function setFee(uint256 fee) external {
        router.setFee(bound(fee, 0, 0.5 ether));
    }

    function fund(uint256 amount) external {
        amount = bound(amount, 0, 0.01 ether);
        vm.deal(address(this), address(this).balance + amount);
        rc.fundFeePool{value: amount}();
        funded += amount;
    }

    function withdraw(uint256 amount) external {
        amount = bound(amount, 0, rc.feePool() / 2);
        vm.prank(owner);
        rc.withdrawFeePool(amount);
        withdrawn += amount;
    }

    // ------------------------------------------------------------------ ghost bookkeeping

    function _paid(uint256 disputeId, uint256 cost) internal {
        uint256 paid = arb.disputeOf(disputeId).paid;
        if (paid != cost) wrongAmountPaid = true;
        paidToCourt += paid;
    }

    /// @dev Progress = attempts * 10 + rank; it never decreases along any legal path.
    function _check(uint256 n) internal {
        CaseView memory v = rc.caseOf(TestPayloads.idOf(n));
        uint256 rank;
        if (v.state == CaseState.Received) rank = 1;
        else if (v.state == CaseState.Opened) rank = 2;
        else if (v.state == CaseState.RefilePending) rank = 3;
        else if (v.state == CaseState.Ruled) rank = 4;
        else if (v.state == CaseState.Relayed) rank = 5;
        else if (v.state == CaseState.Stale) rank = 9;
        uint256 p = uint256(v.attempts) * 10 + rank;
        if (p < progressOf[n]) stateRegressed = true;
        progressOf[n] = p;
    }

    // ------------------------------------------------------------------ views for the invariants

    function claims() external pure returns (uint256) {
        return CLAIMS;
    }
}

contract RecourseCaseInvariantTest is CaseBase {
    CaseHandler internal handler;

    function setUp() public override {
        super.setUp();
        arb = new MockArbitrator(COST, 0); // dispute 0 is a real id on KlerosCore; cover it
        rc = _deploy();
        vm.startPrank(owner);
        rc.setPeer(address(peer));
        rc.setTemplateText(variantParts(0));
        rc.setPolicyURI(policyURI);
        rc.setParams(DEADLINE, 4, RESEND_GAP, MAX_SENDS);
        vm.stopPrank();
        rc.fundFeePool{value: POOL}();
        sim.requestLinkFromFaucet(address(rc), 50 ether);

        handler = new CaseHandler(rc, arb, peer, router, owner, sel);
        targetContract(address(handler));
    }

    /// Shows how deep the random runs reached (opens, refiles, relays summed over a run).
    function afterInvariant() public {
        emit log_named_uint("opens", handler.opens());
        emit log_named_uint("refiles", handler.refiles());
        emit log_named_uint("relays", handler.relays());
    }

    /// ETH leaves only to the court (exactly the live cost each time) and to the owner.
    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 100
    function invariant_ethConserved() public view {
        assertEq(address(rc).balance, rc.feePool());
        assertEq(rc.feePool() + handler.paidToCourt() + handler.withdrawn(), POOL + handler.funded());
        assertEq(address(arb).balance, handler.paidToCourt());
        assertFalse(handler.wrongAmountPaid());
    }

    /// At most two disputes per claim, and every dispute the court holds belongs to one of our claims.
    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 100
    function invariant_atMostTwoDisputesPerClaim() public view {
        uint256 total;
        for (uint256 n = 0; n < handler.claims(); n++) {
            CaseView memory v = rc.caseOf(idOf(n));
            assertLe(v.attempts, 2);
            total += v.attempts;
        }
        assertEq(arb.disputeCount(), total);
    }

    /// The cap counts exactly the Opened and RefilePending cases.
    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 100
    function invariant_openCasesCount() public view {
        uint256 open;
        for (uint256 n = 0; n < handler.claims(); n++) {
            CaseState s = rc.caseOf(idOf(n)).state;
            if (s == CaseState.Opened || s == CaseState.RefilePending) open++;
        }
        assertEq(rc.openCases(), open);
        (, uint16 maxOpen,,) = rc.params();
        assertLe(rc.openCases(), maxOpen);
    }

    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 100
    function invariant_statesNeverGoBack() public view {
        assertFalse(handler.stateRegressed());
    }

    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 100
    function invariant_ruleNeverRevertsForKnownDisputes() public view {
        assertFalse(handler.ruleReverted());
    }

    /// The ruling relayed is the ruling stored; a refusal is never relayed on attempt 1.
    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 100
    function invariant_relayedRulingIsStored() public view {
        for (uint256 i = 0; i < peer.receivedCount(); i++) {
            (, bytes32 claimId, uint256 disputeId, uint8 ruling, uint8 attempts) =
                abi.decode(peer.receivedAt(i).data, (uint8, bytes32, uint256, uint8, uint8));
            CaseView memory v = rc.caseOf(claimId);
            assertEq(ruling, v.ruling);
            assertEq(attempts, v.attempts);
            assertEq(disputeId, v.disputeIds[attempts - 1]);
            assertTrue(ruling != 0 || attempts == 2);
        }
    }
}
