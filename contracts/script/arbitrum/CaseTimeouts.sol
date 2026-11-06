// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @notice How RecourseCase's timing parameters follow from Hedera's and from court 8. Shared by the deploy script
/// and the tests, so the tests check the values a deploy would use.
library CaseTimeouts {
    /// @dev The longest a final ruling may take to land on Hedera: the first send and up to four resends 30 min apart
    /// (`resendGap`, `maxSends` 5), the last one with about 25 min to execute.
    uint64 internal constant RELAY_BUDGET = 2 hours;

    /// @dev Kleros court the case contract uses (`EXTRA_DATA`).
    uint96 internal constant COURT = 8;

    /// @dev RecourseCase's `claimTimeout` for a Hedera claim timeout: shorter by the relay budget. Arbitrum stops
    /// taking rulings at `filedAt + caseTimeout`, Hedera at `preCheckedAt + hederaTimeout` or later, so a ruling the
    /// case accepts has at least the budget to land before anyone can expire the claim on Hedera.
    function caseClaimTimeout(uint64 hederaClaimTimeout, uint64 relayBudget) internal pure returns (uint64) {
        require(hederaClaimTimeout > relayBudget, "CaseTimeouts: Hedera claim timeout within the relay budget");
        return hederaClaimTimeout - relayBudget;
    }

    /// @dev One court round: the evidence, commit, vote and appeal periods, in seconds.
    function roundOf(uint256[4] memory timesPerPeriod) internal pure returns (uint256) {
        return timesPerPeriod[0] + timesPerPeriod[1] + timesPerPeriod[2] + timesPerPeriod[3];
    }
}

/// @notice The KlerosCore view that gives a court's period lengths.
interface IKlerosCoreTimes {
    function getTimesPerPeriod(uint96 courtID) external view returns (uint256[4] memory timesPerPeriod);
}
