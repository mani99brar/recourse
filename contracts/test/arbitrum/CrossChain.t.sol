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
contract CrossChainTest is ClaimsBase {
    uint256 internal constant COST = 810_000_000_000_000;
    string internal constant GOLDEN = "../packages/court/template/golden.json";

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
            RecourseCase.Params({caseDeadline: 2 hours, maxOpenCases: 10, resendGap: 30 minutes, maxSends: 5}),
            RECEIVE_GAS
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
