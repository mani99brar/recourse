// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";

import {RecourseAddresses as A} from "../../src/shared/RecourseAddresses.sol";
import {CaseTimeouts, IKlerosCoreTimes} from "../../script/arbitrum/CaseTimeouts.sol";

/// @notice Read-only fork of Arbitrum Sepolia: the timing a RecourseCase deploy would use against court 8's period
/// lengths as KlerosCore reports them now. Nothing is sent.
///
///   forge test --match-path 'test/arbitrum/CourtTimingFork.t.sol' --fork-url "$ARB_RPC_URL" -vv
///
/// Skipped without a fork. A failure means the shared parameter set does not fit the live court and the case must not
/// be deployed with it.
contract CourtTimingForkTest is Test {
    string internal constant PARAMS = "../packages/shared/vectors/params.json";
    /// @dev The pre-check and the outbound CCIP leg, at most, before a case can open (the contest window is added).
    uint256 internal constant TO_COURT = 1 hours;

    function test_fork_deployTimingFitsCourt8() public {
        if (block.chainid != A.ARBITRUM_CHAIN_ID) {
            vm.skip(true, "needs --fork-url on Arbitrum Sepolia");
        }
        uint256[4] memory times = IKlerosCoreTimes(A.KLEROS_CORE).getTimesPerPeriod(CaseTimeouts.COURT);
        uint256 round = CaseTimeouts.roundOf(times);
        emit log_named_uint("court 8 round (s)", round);
        assertGt(round, 0, "court 8 has no periods");

        string memory j = vm.readFile(PARAMS);
        uint256 caseDeadline = vm.parseJsonUint(j, ".locked.caseDeadline");
        uint256 contestWindow = vm.parseJsonUint(j, ".locked.contestWindow");
        uint64 hederaTimeout = uint64(vm.parseJsonUint(j, ".locked.claimTimeout"));
        uint64 caseTimeout = CaseTimeouts.caseClaimTimeout(hederaTimeout, CaseTimeouts.RELAY_BUDGET);

        // A case opens only with caseDeadline left before its cut-off, so caseDeadline must hold a whole round.
        assertGe(caseDeadline, round, "caseDeadline is shorter than a court 8 round");
        // A claim reaches court, is refused once and refiled, and both rounds still end before the cut-off.
        assertGe(caseTimeout, TO_COURT + contestWindow + 2 * caseDeadline, "claimTimeout fits no refile");
        // The return leg has the relay budget after the cut-off, before Hedera lets anyone expire the claim.
        assertEq(hederaTimeout - caseTimeout, CaseTimeouts.RELAY_BUDGET);
    }
}
