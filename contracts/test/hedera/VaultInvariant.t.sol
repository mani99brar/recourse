// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {DepositVault} from "../../src/hedera/DepositVault.sol";
import {HederaBase} from "./HederaBase.sol";
import {VaultHandler} from "./handlers/VaultHandler.sol";

/// @notice Vault books stay exact under random deposits, requirements, escrows, outcomes,
///         withdrawals and exits.
contract VaultInvariantTest is HederaBase {
    DepositVault internal vault;
    VaultHandler internal handler;

    function setUp() public {
        _setUpHedera();
        vault = new DepositVault(USDC_ADDR, pool, owner);
        handler = new VaultHandler(vault, usdc, owner, pool);
        vm.prank(owner);
        vault.bindClaims(address(handler));
        vault.associateUsdc(false);
        usdc.mockAssociate(pool);

        bytes4[] memory sels = new bytes4[](8);
        sels[0] = VaultHandler.deposit.selector;
        sels[1] = VaultHandler.setRequired.selector;
        sels[2] = VaultHandler.escrow.selector;
        sels[3] = VaultHandler.apply_.selector;
        sels[4] = VaultHandler.withdraw.selector;
        sels[5] = VaultHandler.requestExit.selector;
        sels[6] = VaultHandler.exit.selector;
        sels[7] = VaultHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_balanceEqualsBooks() public view {
        (uint256 d, uint256 e, uint256 c) = vault.totals();
        assertEq(usdc.balanceOf(address(vault)), d + e + c);
    }

    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_totalsMatchPerAccountSums() public view {
        (uint256 d, uint256 e, uint256 c) = vault.totals();
        uint256 sumD;
        uint256 sumE;
        uint256 sumC;
        for (uint256 i; i < handler.platformCount(); ++i) {
            sumD += vault.depositOf(handler.platforms(i));
        }
        for (uint256 i; i < handler.shopCount(); ++i) {
            sumE += vault.shopEscrowOf(handler.shops(i));
        }
        for (uint256 i; i < handler.accountCount(); ++i) {
            sumC += vault.creditOf(handler.accounts(i));
        }
        assertEq(sumD, d, "deposits");
        assertEq(sumE, e, "escrow");
        assertEq(sumC, c, "credits");
    }

    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_openClaimsAndSingleApply() public view {
        for (uint256 i; i < handler.platformCount(); ++i) {
            address p = handler.platforms(i);
            assertEq(vault.openClaimsOf(p), handler.ghostOpenClaims(p), "open claims");
        }
        for (uint256 i; i < handler.claimCount(); ++i) {
            assertLe(handler.appliedCount(handler.claimIds(i)), 1, "applied twice");
        }
        assertFalse(handler.creditFellOutsideWithdraw(), "credit fell outside withdrawCredit");
    }

    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_reservationsAreBackedAndOwnedByOpenClaims() public view {
        for (uint256 i; i < handler.platformCount(); ++i) {
            address p = handler.platforms(i);
            uint256 sum;
            for (uint256 j; j < handler.claimCount(); ++j) {
                bytes32 id = handler.claimIds(j);
                if (!handler.ghostOpen(id)) assertEq(vault.reservationOf(id), 0, "closed claim keeps a reservation");
                else if (handler.claimPlatform(id) == p) sum += vault.reservationOf(id);
            }
            assertEq(vault.reservedOf(p), sum, "reserved total");
            assertLe(vault.reservedOf(p), vault.depositOf(p), "reserved above the deposit");
            assertLe(vault.reservedOf(p), vault.exposureOf(p), "reserved above the exposure");
            assertEq(vault.exposureOf(p), handler.ghostExposure(p), "exposure total");
            assertEq(vault.oldestOpenClaimOf(p), handler.ghostOldest(p), "oldest open claim");
        }
        for (uint256 j; j < handler.claimCount(); ++j) {
            bytes32 id = handler.claimIds(j);
            if (!handler.ghostOpen(id)) assertEq(vault.maxPayoutOf(id), 0, "closed claim keeps a stated maximum");
            else assertEq(vault.maxPayoutOf(id), handler.ghostMax(id), "stated maximum");
        }
    }

    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 64
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_standingIsDerived() public view {
        (uint64 window,,) = vault.params();
        for (uint256 i; i < handler.platformCount(); ++i) {
            address p = handler.platforms(i);
            uint256 req = vault.requiredOf(p);
            uint256 dep = vault.depositOf(p);
            uint256 start = vault.topUpStartedAt(p);
            bool expected;
            if (vault.exitRequestedAt(p) != 0) expected = false;
            else if (req == 0) expected = false;
            else if (dep >= req) expected = true;
            else if (start == 0) expected = false;
            else expected = block.timestamp <= start + window;
            assertEq(vault.inGoodStanding(p), expected, "standing");
            uint256 deadline = (req == 0 || dep >= req || start == 0) ? 0 : start + window;
            assertEq(vault.topUpDeadline(p), deadline, "deadline");
        }
    }
}
