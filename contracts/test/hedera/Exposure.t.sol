// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {BridgeCodec} from "../../src/shared/BridgeCodec.sol";
import {ClaimStatus} from "../../src/shared/RecourseTypes.sol";
import {IDepositVault} from "../../src/hedera/interfaces/IDepositVault.sol";
import {IRecourseClaims} from "../../src/hedera/interfaces/IRecourseClaims.sol";
import {ClaimsBase} from "./ClaimsBase.sol";

/// @notice What an open claim may be owed stays owed: a later claim against the same platform cannot take it,
///         a parameter change cannot reprice it, and an owner cannot set CCIP args the lane refuses after lock.
contract ExposureTest is ClaimsBase {
    /// @dev Handling for BASKET (120 USDC) under the default parameters: 15 + 5% of 120, under the 40 cap.
    uint256 internal constant H = 21 * USDC;

    address internal aliasFiler = makeAddr("aliasFiler");

    function setUp() public {
        _setUpClaims();
        _fund(aliasFiler, 100 * USDC);
        vm.prank(aliasFiler);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ------------------------------------------------------------ reservation

    /// A shop's claim is at court. A second address the platform controls files for the whole deposit, the
    /// pre-check finds against the platform, nobody contests, and it closes first. The earlier claim is still
    /// paid in full when its ruling lands.
    function test_aliasClaimCannotTakeWhatAnEarlierOpenClaimMayBeOwed() public {
        bytes32 real = _atCourt(2, 1);
        bytes32 fake = _file(aliasFiler, platform, DEPOSIT, DEPOSIT);
        _precheck(fake, 2, 1);
        vm.warp(block.timestamp + _params().contestWindow + 1);
        claims.closeUncontested(fake);

        _deliver(real, 77, 1, 1);
        claims.settle(real);
        assertEq(vault.creditOf(shop), NET_LOSS + H + FEE, "the earlier claim is paid in full");
        assertEq(vault.creditOf(aliasFiler), DEPOSIT - (NET_LOSS + H + FEE) + FEE, "the alias gets only the rest");
        assertEq(vault.depositOf(platform), 0);
        _assertBooks();
    }

    /// Each claim reserves what it may be owed (net loss + H + an amount equal to the fee) at filing, out of the
    /// part of the deposit no earlier open claim reserved, and releases it when it ends.
    function test_reservation_viewsFollowTheClaim() public {
        bytes32 a = _file();
        assertEq(vault.reservationOf(a), NET_LOSS + H + FEE);
        assertEq(vault.reservedOf(platform), NET_LOSS + H + FEE);
        bytes32 b = _file(shop2, platform, BASKET, NET_LOSS);
        assertEq(vault.reservedOf(platform), 2 * (NET_LOSS + H + FEE));

        _precheck(a, 2, 2); // found against the shop: nothing paid
        vm.warp(block.timestamp + _params().contestWindow + 1);
        claims.closeUncontested(a);
        assertEq(vault.reservationOf(a), 0);
        assertEq(vault.reservedOf(platform), NET_LOSS + H + FEE);

        vm.warp(uint256(claims.getClaim(b).filedAt) + _params().claimTimeout + 1);
        claims.expireClaim(b);
        assertEq(vault.reservedOf(platform), 0);
        assertEq(vault.depositOf(platform), DEPOSIT);
        _assertBooks();
    }

    /// A claim filed when the deposit was already fully reserved reserves nothing, can still draw on what is
    /// unreserved when it ends (a top-up included), and never on another open claim's reservation.
    function test_reservation_laterClaimDrawsOnlyOnTheUnreservedRest() public {
        bytes32 big = _file(aliasFiler, platform, DEPOSIT, DEPOSIT); // reserves all of it
        assertEq(vault.reservationOf(big), DEPOSIT);
        bytes32 late = _file(); // nothing left to reserve
        assertEq(vault.reservationOf(late), 0);

        _precheck(late, 2, 1);
        vm.warp(block.timestamp + _params().contestWindow + 1);
        vm.expectEmit(address(vault));
        emit IDepositVault.Shortfall(late, platform, NET_LOSS + H);
        claims.closeUncontested(late);
        assertEq(vault.creditOf(shop), FEE, "fee back, nothing from the reserved deposit");
        assertEq(vault.depositOf(platform), DEPOSIT);

        // After a top-up, a claim filed short draws on the new unreserved part.
        bytes32 late2 = _file();
        vm.prank(platform);
        vault.postDeposit(platform, 50 * USDC);
        _precheck(late2, 2, 1);
        vm.warp(block.timestamp + _params().contestWindow + 1);
        claims.closeUncontested(late2);
        assertEq(vault.creditOf(shop), FEE + 50 * USDC + FEE, "the top-up, not the earlier reservation");
        assertEq(vault.depositOf(platform), DEPOSIT);
        assertEq(vault.reservedOf(platform), DEPOSIT);
        _assertBooks();
    }

    // ------------------------------------------------------------ terms frozen at filing

    function test_claimTermsOf_recordsTheTermsInForceAtFiling() public {
        bytes32 id = _file();
        IRecourseClaims.ClaimTerms memory t = claims.claimTermsOf(id);
        assertEq(t.contestWindow, _params().contestWindow);
        assertEq(t.claimTimeout, _params().claimTimeout);
        assertEq(t.handling, H);
        IRecourseClaims.Params memory p = _params();
        p.contestWindow = 1_800;
        p.claimTimeout = 64_800;
        p.handlingBase = 1 * USDC;
        vm.prank(owner);
        claims.setParams(p);
        t = claims.claimTermsOf(id);
        assertEq(t.contestWindow, 10 minutes);
        assertEq(t.claimTimeout, 18 hours);
        assertEq(t.handling, H);
        t = claims.claimTermsOf(_file());
        assertEq(t.contestWindow, 1_800);
        assertEq(t.handling, claims.handlingOf(BASKET));
        assertEq(claims.claimTermsOf(bytes32("unknown")).claimTimeout, 0);
    }

    /// Raising handling after filing does not change what an uncontested close pays, and a longer contest window
    /// set later does not reopen the claim's own window.
    function test_paramChangeNeverReopensOrRepricesAnUncontestedClaim() public {
        bytes32 id = _file();
        _precheck(id, 2, 1);
        uint256 closesAt = uint256(claims.getClaim(id).preCheckedAt) + _params().contestWindow;

        IRecourseClaims.Params memory p = _params();
        p.handlingBase = 1_000 * USDC;
        p.handlingCap = 1_000 * USDC;
        p.contestWindow = 1 days;
        p.claimTimeout = 2 days;
        vm.prank(owner);
        claims.setParams(p);

        vm.warp(closesAt + 1);
        vm.prank(platform);
        vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.WindowClosed.selector, closesAt));
        claims.contest(id);
        claims.closeUncontested(id);
        assertEq(vault.creditOf(shop), NET_LOSS + H + FEE, "net loss, the handling in force at filing, the fee back");
        _assertBooks();
    }

    /// Raising handling while a claim is at court does not change what its ruling pays.
    function test_paramChangeNeverRepricesARuledClaim() public {
        bytes32 id = _atCourt(2, 1);
        IRecourseClaims.Params memory p = _params();
        p.handlingBase = 1_000 * USDC;
        p.handlingCap = 1_000 * USDC;
        vm.prank(owner);
        claims.setParams(p);

        _deliver(id, 77, 1, 1);
        (uint256 previewed,,) = claims.previewSettle(id);
        assertEq(previewed, NET_LOSS + H + FEE, "preview");
        claims.settle(id);
        assertEq(vault.creditOf(shop), NET_LOSS + H + FEE, "settled with the handling in force at filing");
        _assertBooks();
    }

    /// A shorter claim timeout set later does not let anyone expire a claim at court early.
    function test_paramChangeNeverShortensAClaimsTimeout() public {
        bytes32 id = _atCourt(2, 1);
        uint256 expiresAfter = uint256(claims.getClaim(id).preCheckedAt) + _params().claimTimeout;
        IRecourseClaims.Params memory p = _params();
        p.claimTimeout = p.contestWindow + 1;
        vm.prank(owner);
        claims.setParams(p);

        vm.warp(block.timestamp + 1 hours);
        vm.prank(platform);
        vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.NotExpired.selector, expiresAfter));
        claims.expireClaim(id);
        assertEq(uint8(_status(id)), uint8(ClaimStatus.AtCourt));
    }

    // ------------------------------------------------------------ standing while an exit runs

    /// A platform that asked to exit is no longer in good standing, so a shop that gates orders on standing stops
    /// selling to it before claims against it are refused.
    function test_standingEndsOnceAnExitIsRequested() public {
        assertTrue(vault.inGoodStanding(platform));
        vm.prank(platform);
        vault.requestExit();
        assertFalse(vault.inGoodStanding(platform), "exit requested");
        (, uint64 exitDelay,) = vault.params();
        vm.warp(block.timestamp + exitDelay + 365 days);
        assertFalse(vault.inGoodStanding(platform), "exit due, deposit still in");
        assertEq(vault.depositOf(platform), DEPOSIT);
    }

    /// A platform that changes its mind withdraws the request and is in good standing, and can be claimed
    /// against, again, even past the time the exit would have been due.
    function test_cancelExit_restoresStandingAndClaims() public {
        vm.prank(platform);
        vm.expectRevert(IDepositVault.ExitNotRequested.selector);
        vault.cancelExit();

        vm.prank(platform);
        vault.requestExit();
        (, uint64 exitDelay,) = vault.params();
        vm.warp(block.timestamp + exitDelay);
        vm.prank(shop);
        vm.expectRevert(IDepositVault.ExitDue.selector);
        claims.fileClaim(keccak256("refused"), platform, _refs(), BASKET, NET_LOSS);

        vm.expectEmit(address(vault));
        emit IDepositVault.ExitCancelled(platform);
        vm.prank(platform);
        vault.cancelExit();
        assertEq(vault.exitRequestedAt(platform), 0);
        assertTrue(vault.inGoodStanding(platform));
        _file();
        vm.prank(platform);
        vm.expectRevert(IDepositVault.ExitNotRequested.selector);
        vault.exit();
        vm.prank(platform);
        vault.requestExit(); // and it may ask again
        assertFalse(vault.inGoodStanding(platform));
    }

    // ------------------------------------------------------------ extra args the lane accepts

    /// After the lock the owner can still change the extra args, but only to GenericExtraArgsV2 with a gas limit
    /// the lane takes and out-of-order execution on; anything else would make every send revert at getFee.
    function test_setExtraArgs_refusesArgsTheLaneRejects_afterLock() public {
        bytes4 v2 = BridgeCodec.GENERIC_EXTRA_ARGS_V2_TAG;
        bytes[6] memory bad = [
            bytes(hex"deadbeef"),
            BridgeCodec.extraArgsFor(30_000_000), // above the lane's 3,000,000 cap
            BridgeCodec.extraArgsFor(20_000), // below what the receive needs
            abi.encodeWithSelector(v2, uint256(200_000), false), // in-order execution
            bytes.concat(BridgeCodec.extraArgsFor(200_000), hex"00"), // trailing byte
            abi.encodeWithSelector(bytes4(0x97a657c9), uint256(200_000)) // V1
        ];
        vm.startPrank(owner);
        claims.lockConfig();
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(IRecourseClaims.BadParams.selector);
            claims.setExtraArgs(bad[i]);
        }
        claims.setExtraArgs(BridgeCodec.extraArgsFor(3_000_000));
        claims.setExtraArgs(BridgeCodec.extraArgsFor(200_000));
        vm.stopPrank();
        assertEq(claims.extraArgs(), BridgeCodec.extraArgsFor(200_000));
    }
}
