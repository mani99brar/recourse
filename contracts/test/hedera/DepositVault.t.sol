// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {DepositVault} from "../../src/hedera/DepositVault.sol";
import {IDepositVault} from "../../src/hedera/interfaces/IDepositVault.sol";
import {HederaBase} from "./HederaBase.sol";

/// @notice Unit tests for DepositVault. This test contract plays the bound claims contract.
contract DepositVaultTest is HederaBase {
    DepositVault internal vault;

    bytes32 internal constant C1 = keccak256("claim-1");
    bytes32 internal constant C2 = keccak256("claim-2");
    bytes32 internal constant C3 = keccak256("claim-3");
    uint256 internal constant FEE = 3 * USDC;

    function setUp() public {
        _setUpHedera();
        vault = _deployVault(address(this));
        _fund(platform, 10_000 * USDC);
        _fund(platform2, 10_000 * USDC);
        _fund(shop, 1_000 * USDC);
        _fund(shop2, 1_000 * USDC);
        _fund(stranger, 1_000 * USDC);
        vm.prank(platform);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(shop);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ------------------------------------------------------------ helpers

    function _deposit(address p, uint256 amount) internal {
        vm.prank(p);
        vault.postDeposit(p, amount);
    }

    function _require(address p, uint256 amount) internal {
        vm.prank(owner);
        vault.setRequired(p, amount);
    }

    function _assertBooks() internal view {
        (uint256 d, uint256 e, uint256 c) = vault.totals();
        assertEq(usdc.balanceOf(address(vault)), d + e + c, "balance == deposits + escrow + credits");
    }

    // ------------------------------------------------------------ construction and setup

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(IDepositVault.ZeroAddress.selector);
        deployer.deployVault(address(0), pool, owner);
        vm.expectRevert(IDepositVault.ZeroAddress.selector);
        deployer.deployVault(USDC_ADDR, address(0), owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        deployer.deployVault(USDC_ADDR, pool, address(0));
    }

    function test_constructor_storesImmutablesAndDefaults() public {
        DepositVault v = deployer.deployVault(USDC_ADDR, pool, owner);
        assertEq(v.usdc(), USDC_ADDR);
        assertEq(v.pool(), pool);
        assertEq(v.owner(), owner);
        assertEq(v.claims(), address(0));
        assertFalse(v.usdcAssociated());
        assertFalse(v.configLocked());
        (uint64 w, uint64 x, uint256 m) = v.params();
        assertEq(w, 7 days);
        assertEq(x, 10 minutes);
        assertEq(m, 0);
    }

    function test_bindClaims_onceByOwner() public {
        DepositVault v = new DepositVault(USDC_ADDR, pool, owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        v.bindClaims(address(1));

        vm.startPrank(owner);
        vm.expectRevert(IDepositVault.ZeroAddress.selector);
        v.bindClaims(address(0));
        vm.expectEmit(address(v));
        emit IDepositVault.ClaimsBound(address(1));
        v.bindClaims(address(1));
        vm.expectRevert(IDepositVault.AlreadyBound.selector);
        v.bindClaims(address(2));
        vm.stopPrank();
        assertEq(v.claims(), address(1));
    }

    function test_setParams_andLock() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        vault.setParams(1, 2, 3);

        vm.startPrank(owner);
        vm.expectEmit(address(vault));
        emit IDepositVault.ParamsSet(7 days, 120 days, 2_500 * USDC);
        vault.setParams(7 days, 120 days, 2_500 * USDC);
        (uint64 w, uint64 x, uint256 m) = vault.params();
        assertEq(w, 7 days);
        assertEq(x, 120 days);
        assertEq(m, 2_500 * USDC);

        vm.expectEmit(address(vault));
        emit IDepositVault.ConfigLocked();
        vault.lockConfig();
        assertTrue(vault.configLocked());

        vm.expectRevert(IDepositVault.ConfigIsLocked.selector);
        vault.setParams(1, 2, 3);
        vm.expectRevert(IDepositVault.ConfigIsLocked.selector);
        vault.lockConfig();
        vm.expectRevert(IDepositVault.ConfigIsLocked.selector);
        vault.bindClaims(address(9));
        // setRequired stays available after the lock.
        vault.setRequired(platform, 2_500 * USDC);
        vm.stopPrank();
        assertEq(vault.requiredOf(platform), 2_500 * USDC);
    }

    function test_lockConfig_needsClaimsBound() public {
        DepositVault v = new DepositVault(USDC_ADDR, pool, owner);
        vm.prank(owner);
        vm.expectRevert(IDepositVault.ClaimsNotBound.selector);
        v.lockConfig();
    }

    // ------------------------------------------------------------ association

    function test_associate_viaHts_isIdempotent() public {
        DepositVault v = new DepositVault(USDC_ADDR, pool, owner);
        vm.expectEmit(address(v));
        emit IDepositVault.UsdcAssociated(22);
        assertEq(v.associateUsdc(false), 22);
        assertTrue(v.usdcAssociated());
        assertTrue(usdc.associatedAccount(address(v)));
        vm.expectEmit(address(v));
        emit IDepositVault.UsdcAssociated(194);
        assertEq(v.associateUsdc(false), 194);
        assertTrue(v.usdcAssociated());
    }

    function test_associate_viaHrc() public {
        DepositVault v = new DepositVault(USDC_ADDR, pool, owner);
        assertEq(v.associateUsdc(true), 22);
        assertTrue(v.usdcAssociated());
        assertTrue(usdc.associatedAccount(address(v)));
        assertEq(v.associateUsdc(true), 194);
        // Both paths mark the same registry.
        assertEq(v.associateUsdc(false), 194);
    }

    function test_associate_failureCodeReverts() public {
        DepositVault v = new DepositVault(USDC_ADDR, pool, owner);
        hts.setResponseCode(167);
        vm.expectRevert(abi.encodeWithSelector(IDepositVault.AssociationFailed.selector, int256(167)));
        v.associateUsdc(false);
        assertFalse(v.usdcAssociated());

        hts.clearResponseCode();
        hts.setRevert(true);
        vm.expectRevert(abi.encodeWithSelector(IDepositVault.AssociationFailed.selector, int256(-1)));
        v.associateUsdc(false);
        assertFalse(v.usdcAssociated());

        // The token-side path still works.
        assertEq(v.associateUsdc(true), 22);
        assertTrue(v.usdcAssociated());
    }

    // ------------------------------------------------------------ deposits

    function test_postDeposit_needsAssociation() public {
        DepositVault v = new DepositVault(USDC_ADDR, pool, owner);
        vm.prank(platform);
        vm.expectRevert(IDepositVault.NotAssociatedYet.selector);
        v.postDeposit(platform, 1);
    }

    function test_postDeposit_inputChecks() public {
        vm.startPrank(platform);
        vm.expectRevert(IDepositVault.AmountZero.selector);
        vault.postDeposit(platform, 0);
        vm.expectRevert(IDepositVault.ZeroAddress.selector);
        vault.postDeposit(address(0), 1);
        vm.stopPrank();
    }

    function test_postDeposit_pullsFromSender() public {
        vm.expectEmit(address(vault));
        emit IDepositVault.DepositPosted(platform, platform, 100 * USDC, 100 * USDC);
        _deposit(platform, 100 * USDC);

        // Anyone may top up a platform; the funds come from the caller.
        vm.startPrank(stranger);
        usdc.approve(address(vault), 50 * USDC);
        vm.expectEmit(address(vault));
        emit IDepositVault.DepositPosted(platform, stranger, 50 * USDC, 150 * USDC);
        vault.postDeposit(platform, 50 * USDC);
        vm.stopPrank();

        assertEq(vault.depositOf(platform), 150 * USDC);
        assertEq(usdc.balanceOf(stranger), 950 * USDC);
        (uint256 d,,) = vault.totals();
        assertEq(d, 150 * USDC);
        _assertBooks();
    }

    function test_postDeposit_failedPullReverts() public {
        vm.prank(stranger); // no allowance
        vm.expectRevert(IDepositVault.TransferFailed.selector);
        vault.postDeposit(platform, 1);

        usdc.setReturnFalse(true);
        vm.prank(stranger);
        vm.expectRevert(IDepositVault.TransferFailed.selector);
        vault.postDeposit(platform, 1);
        assertEq(vault.depositOf(platform), 0);
    }

    // ------------------------------------------------------------ required and standing

    function test_setRequired_bounds() public {
        vm.startPrank(owner);
        vault.setParams(7 days, 10 minutes, 100 * USDC);
        vm.expectRevert(abi.encodeWithSelector(IDepositVault.BelowMinDeposit.selector, 99 * USDC, 100 * USDC));
        vault.setRequired(platform, 99 * USDC);
        vm.expectRevert(IDepositVault.ZeroAddress.selector);
        vault.setRequired(address(0), 100 * USDC);
        vm.expectEmit(address(vault));
        emit IDepositVault.RequiredSet(platform, 100 * USDC);
        vault.setRequired(platform, 100 * USDC);
        vault.setRequired(platform, 0);
        vm.stopPrank();
        assertEq(vault.requiredOf(platform), 0);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vault.setRequired(platform, 100 * USDC);
    }

    function test_standing_row1_noRequirement() public {
        _deposit(platform, 500 * USDC);
        assertFalse(vault.inGoodStanding(platform));
        assertEq(vault.topUpDeadline(platform), 0);
    }

    function test_standing_row2_depositMeetsRequirement() public {
        _deposit(platform, 500 * USDC);
        _require(platform, 500 * USDC);
        assertTrue(vault.inGoodStanding(platform));
        assertEq(vault.topUpDeadline(platform), 0);
        assertEq(vault.topUpStartedAt(platform), 0);
    }

    function test_standing_row3_shortWithoutClock() public {
        _require(platform, 500 * USDC); // deposit 0: no clock
        assertFalse(vault.inGoodStanding(platform));
        assertEq(vault.topUpDeadline(platform), 0);
        _deposit(platform, 100 * USDC); // a first partial deposit starts nothing
        assertFalse(vault.inGoodStanding(platform));
        assertEq(vault.topUpDeadline(platform), 0);
    }

    function test_standing_row3_partialDepositBeforeFirstRequirement() public {
        _deposit(platform, 1); // posted before the owner first sets a requirement
        vm.recordLogs();
        _require(platform, 500 * USDC); // the deposit never met a requirement: no clock
        assertEq(vm.getRecordedLogs().length, 1, "only RequiredSet");
        assertEq(vault.topUpStartedAt(platform), 0);
        assertEq(vault.topUpDeadline(platform), 0);
        assertFalse(vault.inGoodStanding(platform));
        _require(platform, 400 * USDC); // nor does a second requirement it never met
        assertEq(vault.topUpStartedAt(platform), 0);
        assertFalse(vault.inGoodStanding(platform));
    }

    function test_standing_row3_requirementRemovedThenSetAgainStartsNoClock() public {
        _deposit(platform, 100 * USDC);
        _require(platform, 100 * USDC);
        _require(platform, 500 * USDC);
        assertEq(vault.topUpStartedAt(platform), T0);
        vm.warp(T0 + 7 days + 1);
        assertFalse(vault.inGoodStanding(platform));

        // Removing the requirement and setting it again does not give the lapsed platform a new window.
        _require(platform, 0);
        _require(platform, 500 * USDC);
        assertEq(vault.topUpStartedAt(platform), 0);
        assertEq(vault.topUpDeadline(platform), 0);
        assertFalse(vault.inGoodStanding(platform));
    }

    function test_standing_rows4and5_clockRunsThenLapses() public {
        _deposit(platform, 100 * USDC);
        _require(platform, 100 * USDC); // in good standing
        vm.expectEmit(address(vault));
        emit IDepositVault.TopUpClockStarted(platform, T0 + 7 days);
        _require(platform, 500 * USDC); // raised above the deposit: the clock starts
        assertEq(vault.topUpStartedAt(platform), T0);
        assertEq(vault.topUpDeadline(platform), T0 + 7 days);
        assertTrue(vault.inGoodStanding(platform));

        vm.warp(T0 + 7 days); // inclusive
        assertTrue(vault.inGoodStanding(platform));
        vm.warp(T0 + 7 days + 1);
        assertFalse(vault.inGoodStanding(platform));
        assertEq(vault.topUpDeadline(platform), T0 + 7 days);

        // A lapsed clock is never restarted by raising the requirement again.
        _require(platform, 600 * USDC);
        assertEq(vault.topUpStartedAt(platform), T0);
        assertFalse(vault.inGoodStanding(platform));

        // Topping up clears it.
        vm.expectEmit(address(vault));
        emit IDepositVault.TopUpCleared(platform);
        _deposit(platform, 500 * USDC);
        assertEq(vault.topUpStartedAt(platform), 0);
        assertTrue(vault.inGoodStanding(platform));
    }

    function test_setRequired_clearsClockWhenLowered() public {
        _deposit(platform, 100 * USDC);
        _require(platform, 100 * USDC);
        _require(platform, 500 * USDC);
        assertEq(vault.topUpStartedAt(platform), T0);
        vm.expectEmit(address(vault));
        emit IDepositVault.TopUpCleared(platform);
        _require(platform, 100 * USDC);
        assertEq(vault.topUpStartedAt(platform), 0);

        _require(platform, 500 * USDC);
        assertEq(vault.topUpStartedAt(platform), T0);
        _require(platform, 0);
        assertEq(vault.topUpStartedAt(platform), 0);
        assertFalse(vault.inGoodStanding(platform));
    }

    function test_setRequired_doesNotRestartRunningClock() public {
        _deposit(platform, 100 * USDC);
        _require(platform, 100 * USDC);
        _require(platform, 500 * USDC);
        vm.warp(T0 + 1 days);
        _require(platform, 700 * USDC);
        assertEq(vault.topUpStartedAt(platform), T0);
        assertEq(vault.topUpDeadline(platform), T0 + 7 days);
    }

    // ------------------------------------------------------------ escrow

    function test_escrowFee_onlyClaims() public {
        vm.prank(owner);
        vm.expectRevert(IDepositVault.OnlyClaims.selector);
        vault.escrowFee(shop, platform, FEE, C1);
        vm.prank(shop);
        vm.expectRevert(IDepositVault.OnlyClaims.selector);
        vault.escrowFee(shop, platform, FEE, C1);
    }

    function test_escrowFee_needsAssociation() public {
        DepositVault v = new DepositVault(USDC_ADDR, pool, owner);
        vm.prank(owner);
        v.bindClaims(address(this));
        vm.expectRevert(IDepositVault.NotAssociatedYet.selector);
        v.escrowFee(shop, platform, FEE, C1);
    }

    function test_escrowFee_recordsAndPullsFromShop() public {
        vm.expectEmit(address(vault));
        emit IDepositVault.FeeEscrowed(C1, shop, FEE);
        vault.escrowFee(shop, platform, FEE, C1);

        IDepositVault.Escrow memory e = vault.escrowOf(C1);
        assertEq(e.shop, shop);
        assertEq(e.platform, platform);
        assertEq(e.amount, FEE);
        assertEq(uint8(e.state), uint8(IDepositVault.EscrowState.Open));
        assertEq(usdc.balanceOf(shop), 1_000 * USDC - FEE);
        assertEq(vault.shopEscrowOf(shop), FEE);
        assertEq(vault.openClaimsOf(platform), 1);
        _assertBooks();

        vm.expectRevert(abi.encodeWithSelector(IDepositVault.EscrowExists.selector, C1));
        vault.escrowFee(shop, platform, FEE, C1);
        vm.expectRevert(IDepositVault.AmountZero.selector);
        vault.escrowFee(shop, platform, 0, C2);
    }

    function test_escrowFee_neverPullsFromAnyoneButShop() public {
        // shop2 has not approved; another account's allowance does not help.
        vm.expectRevert(IDepositVault.TransferFailed.selector);
        vault.escrowFee(shop2, platform, FEE, C1);
        assertEq(uint8(vault.escrowOf(C1).state), uint8(IDepositVault.EscrowState.None));
        assertEq(usdc.balanceOf(shop), 1_000 * USDC);
    }

    function test_shopEscrowAndTotalsSumOpenClaims() public {
        vm.prank(shop2);
        usdc.approve(address(vault), type(uint256).max);
        vault.escrowFee(shop, platform, FEE, C1);
        vault.escrowFee(shop, platform2, 2 * USDC, C2);
        vault.escrowFee(shop2, platform, FEE, C3);
        assertEq(vault.shopEscrowOf(shop), 5 * USDC);
        assertEq(vault.shopEscrowOf(shop2), FEE);
        (, uint256 e,) = vault.totals();
        assertEq(e, 8 * USDC);
        assertEq(vault.openClaimsOf(platform), 2);
        assertEq(vault.openClaimsOf(platform2), 1);

        vault.applyOutcome(C2, platform2, shop, 0, 2 * USDC);
        assertEq(vault.shopEscrowOf(shop), FEE);
        (, e,) = vault.totals();
        assertEq(e, 6 * USDC);
        assertEq(vault.openClaimsOf(platform2), 0);
        _assertBooks();
    }

    // ------------------------------------------------------------ outcomes

    function test_applyOutcome_onlyClaims() public {
        vault.escrowFee(shop, platform, FEE, C1);
        vm.prank(owner);
        vm.expectRevert(IDepositVault.OnlyClaims.selector);
        vault.applyOutcome(C1, platform, shop, 0, FEE);
    }

    function test_applyOutcome_rejectsUnknownOrMismatched() public {
        vm.expectRevert(abi.encodeWithSelector(IDepositVault.UnknownEscrow.selector, C1));
        vault.applyOutcome(C1, platform, shop, 0, 0);

        vault.escrowFee(shop, platform, FEE, C1);
        vm.expectRevert(abi.encodeWithSelector(IDepositVault.UnknownEscrow.selector, C1));
        vault.applyOutcome(C1, platform2, shop, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(IDepositVault.UnknownEscrow.selector, C1));
        vault.applyOutcome(C1, platform, shop2, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(IDepositVault.RefundAboveEscrow.selector, FEE + 1, FEE));
        vault.applyOutcome(C1, platform, shop, 0, FEE + 1);

        vault.applyOutcome(C1, platform, shop, 0, FEE);
        // Never twice.
        vm.expectRevert(abi.encodeWithSelector(IDepositVault.UnknownEscrow.selector, C1));
        vault.applyOutcome(C1, platform, shop, 0, FEE);
    }

    function test_applyOutcome_paysFromDepositAsCredit() public {
        _deposit(platform, 1_000 * USDC);
        _require(platform, 1_000 * USDC);
        vault.escrowFee(shop, platform, FEE, C1);
        uint256 toShop = 80 * USDC;

        vm.expectEmit(address(vault));
        emit IDepositVault.OutcomeApplied(C1, platform, shop, toShop, 0, FEE);
        uint256 paid = vault.applyOutcome(C1, platform, shop, toShop, 0);
        assertEq(paid, toShop);
        assertEq(vault.depositOf(platform), 920 * USDC);
        assertEq(vault.creditOf(shop), toShop);
        assertEq(vault.creditOf(pool), FEE);
        assertEq(vault.openClaimsOf(platform), 0);
        IDepositVault.Escrow memory e = vault.escrowOf(C1);
        assertEq(uint8(e.state), uint8(IDepositVault.EscrowState.Closed));
        assertEq(e.refunded, 0);
        // Nothing was pushed out.
        assertEq(usdc.balanceOf(address(vault)), 1_000 * USDC + FEE);
        _assertBooks();

        // Payout took the platform below its requirement: the grace clock starts.
        assertEq(vault.topUpStartedAt(platform), T0);
        assertTrue(vault.inGoodStanding(platform));
    }

    function test_applyOutcome_refundGoesToShop() public {
        vault.escrowFee(shop, platform, FEE, C1);
        vault.applyOutcome(C1, platform, shop, 0, FEE);
        assertEq(vault.creditOf(shop), FEE);
        assertEq(vault.creditOf(pool), 0);
        assertEq(vault.escrowOf(C1).refunded, FEE);
        _assertBooks();
    }

    function test_applyOutcome_shortfallCapsAtDepositAndStartsClock() public {
        _deposit(platform, 50 * USDC);
        _require(platform, 50 * USDC);
        vault.escrowFee(shop, platform, FEE, C1);

        vm.expectEmit(address(vault));
        emit IDepositVault.OutcomeApplied(C1, platform, shop, 50 * USDC, 0, FEE);
        vm.expectEmit(address(vault));
        emit IDepositVault.Shortfall(C1, platform, 33 * USDC);
        vm.expectEmit(address(vault));
        emit IDepositVault.TopUpClockStarted(platform, T0 + 7 days);
        uint256 paid = vault.applyOutcome(C1, platform, shop, 83 * USDC, 0);

        assertEq(paid, 50 * USDC);
        assertEq(vault.depositOf(platform), 0);
        assertEq(vault.creditOf(shop), 50 * USDC);
        assertEq(vault.topUpDeadline(platform), T0 + 7 days);
        _assertBooks();
    }

    function test_applyOutcome_unknownPlatformShortfallNoClock() public {
        // Platform never on the scheme: no deposit, no requirement.
        vault.escrowFee(shop, platform2, FEE, C1);
        vm.expectEmit(address(vault));
        emit IDepositVault.Shortfall(C1, platform2, 83 * USDC);
        uint256 paid = vault.applyOutcome(C1, platform2, shop, 83 * USDC, 0);
        assertEq(paid, 0);
        assertEq(vault.topUpStartedAt(platform2), 0);
        assertEq(vault.creditOf(pool), FEE);
        _assertBooks();
    }

    function test_applyOutcome_alreadyShortPlatformGetsNoClock() public {
        _require(platform, 500 * USDC);
        _deposit(platform, 100 * USDC); // short, no clock, not in standing
        vault.escrowFee(shop, platform, FEE, C1);
        vault.applyOutcome(C1, platform, shop, 10 * USDC, 0);
        assertEq(vault.topUpStartedAt(platform), 0);
        assertFalse(vault.inGoodStanding(platform));
    }

    function test_applyOutcome_runningClockNotRestarted() public {
        _deposit(platform, 500 * USDC);
        _require(platform, 500 * USDC);
        vault.escrowFee(shop, platform, FEE, C1);
        vault.escrowFee(shop, platform, FEE, C2);
        vault.applyOutcome(C1, platform, shop, 10 * USDC, 0);
        assertEq(vault.topUpStartedAt(platform), T0);
        vm.warp(T0 + 3 days);
        vault.applyOutcome(C2, platform, shop, 10 * USDC, 0);
        assertEq(vault.topUpStartedAt(platform), T0);
    }

    // ------------------------------------------------------------ credits

    function test_withdrawCredit_paysCaller() public {
        vault.escrowFee(shop, platform, FEE, C1);
        vault.applyOutcome(C1, platform, shop, 0, 1 * USDC);
        vm.expectRevert(IDepositVault.NoCredit.selector);
        vm.prank(stranger);
        vault.withdrawCredit();

        vm.expectEmit(address(vault));
        emit IDepositVault.CreditWithdrawn(shop, 1 * USDC);
        vm.prank(shop);
        assertEq(vault.withdrawCredit(), 1 * USDC);
        assertEq(vault.creditOf(shop), 0);
        assertEq(usdc.balanceOf(shop), 1_000 * USDC - FEE + 1 * USDC);

        vm.prank(pool);
        vault.withdrawCredit();
        assertEq(usdc.balanceOf(pool), 2 * USDC);
        assertEq(usdc.balanceOf(address(vault)), 0);
        _assertBooks();
    }

    function test_withdrawCredit_notAssociatedKeepsCredit_revertMode() public {
        vault.escrowFee(shop, platform, FEE, C1);
        vault.applyOutcome(C1, platform, shop, 0, FEE);
        usdc.mockDissociate(shop);
        vm.prank(shop);
        vm.expectRevert(abi.encodeWithSelector(IDepositVault.NotAssociated.selector, shop));
        vault.withdrawCredit();
        assertEq(vault.creditOf(shop), FEE);
        _assertBooks();
    }

    function test_withdrawCredit_notAssociatedKeepsCredit_falseMode() public {
        vault.escrowFee(shop, platform, FEE, C1);
        vault.applyOutcome(C1, platform, shop, 0, FEE);
        usdc.mockDissociate(shop);
        usdc.setReturnFalse(true);
        vm.prank(shop);
        vm.expectRevert(abi.encodeWithSelector(IDepositVault.NotAssociated.selector, shop));
        vault.withdrawCredit();
        assertEq(vault.creditOf(shop), FEE);

        // Once associated, the same credit comes out.
        usdc.setReturnFalse(false);
        usdc.mockAssociate(shop);
        vm.prank(shop);
        vault.withdrawCredit();
        assertEq(vault.creditOf(shop), 0);
        _assertBooks();
    }

    // ------------------------------------------------------------ exit

    function test_exit_flow() public {
        vm.prank(platform);
        vm.expectRevert(IDepositVault.NoDeposit.selector);
        vault.requestExit();

        _deposit(platform, 300 * USDC);
        _require(platform, 300 * USDC);
        _require(platform, 500 * USDC); // clock running
        vm.prank(platform);
        vm.expectRevert(IDepositVault.ExitNotRequested.selector);
        vault.exit();

        vm.expectEmit(address(vault));
        emit IDepositVault.ExitRequested(platform, T0 + 10 minutes);
        vm.prank(platform);
        vault.requestExit();
        assertEq(vault.exitRequestedAt(platform), T0);
        vm.prank(platform);
        vm.expectRevert(IDepositVault.ExitPending.selector);
        vault.requestExit();

        // New claims are still accepted during the wait, and an open one blocks the exit.
        vault.escrowFee(shop, platform, FEE, C1);
        vm.warp(T0 + 10 minutes - 1);
        vm.prank(platform);
        vm.expectRevert(abi.encodeWithSelector(IDepositVault.ExitTooSoon.selector, T0 + 10 minutes));
        vault.exit();
        vm.warp(T0 + 10 minutes);
        vm.prank(platform);
        vm.expectRevert(abi.encodeWithSelector(IDepositVault.OpenClaims.selector, 1));
        vault.exit();

        vault.applyOutcome(C1, platform, shop, 20 * USDC, 0);
        vm.expectEmit(address(vault));
        emit IDepositVault.Exited(platform, 280 * USDC);
        vm.expectEmit(address(vault));
        emit IDepositVault.TopUpCleared(platform);
        vm.prank(platform);
        assertEq(vault.exit(), 280 * USDC);

        assertEq(vault.depositOf(platform), 0);
        assertEq(vault.creditOf(platform), 280 * USDC);
        assertEq(vault.exitRequestedAt(platform), 0);
        assertEq(vault.topUpStartedAt(platform), 0);
        _assertBooks();

        vm.prank(platform);
        vault.withdrawCredit();
        assertEq(usdc.balanceOf(platform), 10_000 * USDC - 20 * USDC);
        _assertBooks();
    }

    function test_exit_delayReadAtExitTime() public {
        _deposit(platform, 300 * USDC);
        vm.prank(platform);
        vault.requestExit();
        vm.prank(owner);
        vault.setParams(7 days, 1 days, 0);
        vm.warp(T0 + 10 minutes);
        vm.prank(platform);
        vm.expectRevert(abi.encodeWithSelector(IDepositVault.ExitTooSoon.selector, T0 + 1 days));
        vault.exit();
    }

    // ------------------------------------------------------------ native value and stray USDC

    function test_noFunctionAcceptsNativeValue() public {
        bytes4[24] memory sels = [
            IDepositVault.bindClaims.selector,
            IDepositVault.setParams.selector,
            IDepositVault.lockConfig.selector,
            IDepositVault.setRequired.selector,
            IDepositVault.associateUsdc.selector,
            IDepositVault.postDeposit.selector,
            IDepositVault.withdrawCredit.selector,
            IDepositVault.requestExit.selector,
            IDepositVault.exit.selector,
            IDepositVault.escrowFee.selector,
            IDepositVault.applyOutcome.selector,
            IDepositVault.params.selector,
            IDepositVault.depositOf.selector,
            IDepositVault.creditOf.selector,
            IDepositVault.escrowOf.selector,
            IDepositVault.totals.selector,
            IDepositVault.topUpDeadline.selector,
            IDepositVault.inGoodStanding.selector,
            Ownable.transferOwnership.selector,
            Ownable.renounceOwnership.selector,
            bytes4(keccak256("acceptOwnership()")),
            IDepositVault.usdcAssociated.selector,
            IDepositVault.claims.selector,
            bytes4(0xdeadbeef)
        ];
        vm.deal(owner, 10 ether);
        for (uint256 i; i < sels.length; ++i) {
            vm.prank(owner);
            (bool ok,) = address(vault).call{value: 1}(abi.encodePacked(sels[i], new bytes(160)));
            assertFalse(ok, "value accepted");
        }
        vm.prank(owner);
        (bool sent,) = address(vault).call{value: 1}("");
        assertFalse(sent, "plain transfer accepted");
        assertEq(address(vault).balance, 0);
    }

    function test_strayUsdcIsNeverCounted() public {
        _deposit(platform, 100 * USDC);
        usdc.mockAssociate(address(vault));
        vm.prank(stranger);
        usdc.transfer(address(vault), 7 * USDC);

        (uint256 d, uint256 e, uint256 c) = vault.totals();
        assertEq(usdc.balanceOf(address(vault)), d + e + c + 7 * USDC);

        // Everything still works and the excess stays where it is.
        vault.escrowFee(shop, platform, FEE, C1);
        vault.applyOutcome(C1, platform, shop, 100 * USDC, 0);
        vm.prank(shop);
        vault.withdrawCredit();
        vm.prank(pool);
        vault.withdrawCredit();
        (d, e, c) = vault.totals();
        assertEq(d + e + c, 0);
        assertEq(usdc.balanceOf(address(vault)), 7 * USDC);
    }

    function test_escrowFee_refusedOnceExitDue() public {
        _deposit(platform, 300 * USDC);
        vm.prank(platform);
        vault.requestExit();

        // During the notice period claims are still accepted.
        vm.warp(T0 + 10 minutes - 1);
        vault.escrowFee(shop, platform, FEE, C1);

        // From the moment the exit is due, no new claim can keep the platform open.
        vm.warp(T0 + 10 minutes);
        vm.expectRevert(IDepositVault.ExitDue.selector);
        vault.escrowFee(shop, platform, FEE, C2);
        vault.escrowFee(shop, platform2, FEE, C3); // other platforms are unaffected

        vm.prank(platform);
        vm.expectRevert(abi.encodeWithSelector(IDepositVault.OpenClaims.selector, 1));
        vault.exit();
        vault.applyOutcome(C1, platform, shop, 0, FEE);
        vm.prank(platform);
        assertEq(vault.exit(), 300 * USDC);

        // After the exit the request is cleared, and claims are accepted again as for any platform.
        vault.escrowFee(shop, platform, FEE, C2);
        assertEq(vault.openClaimsOf(platform), 1);
        _assertBooks();
    }
}
