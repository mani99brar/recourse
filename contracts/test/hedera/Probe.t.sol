// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IDepositVault} from "../../src/hedera/interfaces/IDepositVault.sol";
import {HederaBase} from "./HederaBase.sol";

/// @notice Canary for the constructor-revert pattern. This test MUST FAIL.
/// @dev An expected constructor revert goes through the external deploy helper, so the test keeps
///      running after it. The final assertion is false on purpose: if this test ever passes, code
///      after an expected revert is being skipped and every test that relies on it proves nothing.
///      The normal suite runs with `--no-match-contract Probe`; run this alone with
///      `forge test --match-contract Probe` and expect a non-zero exit.
contract ProbeTest is HederaBase {
    function setUp() public {
        _setUpHedera();
    }

    function test_probe_mustFail() public {
        vm.expectRevert(IDepositVault.ZeroAddress.selector);
        deployer.deployVault(address(0), pool, owner);
        assertTrue(false, "probe reached its last line, as it must");
    }
}
