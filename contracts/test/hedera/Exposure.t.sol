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
    /// pre-check finds against the platform and nobody contests. It cannot close while the earlier claim may
    /// still need the deposit; the earlier claim is paid in full when its ruling lands, and the alias gets only
    /// what is left after it.
    function test_aliasClaimCannotTakeWhatAnEarlierOpenClaimMayBeOwed() public {
        bytes32 real = _atCourt(2, 1);
        bytes32 fake = _file(aliasFiler, platform, DEPOSIT, DEPOSIT);
        assertEq(vault.reservationOf(fake), DEPOSIT - (NET_LOSS + H + FEE), "only what the earlier claim cannot need");
        _precheck(fake, 2, 1);
        vm.warp(block.timestamp + _params().contestWindow + 1);
        vm.expectRevert(abi.encodeWithSelector(IDepositVault.EarlierClaimOpen.selector, real));
        claims.closeUncontested(fake);

        _deliver(real, 77, 1, 1);
        claims.settle(real);
        assertEq(vault.creditOf(shop), NET_LOSS + H + FEE, "the earlier claim is paid in full");
        claims.closeUncontested(fake);
        assertEq(vault.creditOf(aliasFiler), DEPOSIT - (NET_LOSS + H + FEE) + FEE, "the alias gets only the rest");
        assertEq(vault.depositOf(platform), 0);
        _assertBooks();
    }

    /// An earlier claim that will never pay (found against its own filer, who contests it so it stays open)
    /// covers the whole deposit. A genuine claim filed after it, found against the platform, waits instead of
    /// closing short, and is paid in full once the earlier claim ends.
    function test_neverPayableEarlierClaimDelaysButNeverShortsALaterClaim() public {
        bytes32 blocker = _file(aliasFiler, platform, DEPOSIT, DEPOSIT);
        _precheck(blocker, 2, 2);
        vm.prank(aliasFiler);
        claims.contest(blocker);

        bytes32 real = _file();
        _precheck(real, 2, 1);
        vm.warp(block.timestamp + _params().contestWindow + 1);
        vm.expectRevert(abi.encodeWithSelector(IDepositVault.EarlierClaimOpen.selector, blocker));
        claims.closeUncontested(real);
        assertEq(uint8(_status(real)), uint8(ClaimStatus.PreChecked), "still open, not closed short");

        vm.warp(uint256(claims.getClaim(blocker).preCheckedAt) + _params().claimTimeout + 1);
        claims.expireClaim(blocker);
        claims.closeUncontested(real);
        assertEq(vault.creditOf(shop), NET_LOSS + H + FEE, "paid in full, fee back");
        assertEq(vault.creditOf(aliasFiler), FEE, "the earlier claim gets its fee back and nothing else");
        assertEq(vault.depositOf(platform), DEPOSIT - (NET_LOSS + H));
        _assertBooks();
    }

    /// The earlier claim's filer lets it expire and files a fresh one for the whole deposit in the same block,
    /// before anyone closes the waiting claim. A new filing can only reserve what no open claim may still be
    /// owed, so the waiting claim is paid in full.
    function test_refiledBlockerCannotTakeWhatAWaitingClaimIsOwed() public {
        bytes32 blocker = _file(aliasFiler, platform, DEPOSIT, DEPOSIT);
        _precheck(blocker, 2, 2);
        vm.prank(aliasFiler);
        claims.contest(blocker);
        bytes32 real = _file();
        _precheck(real, 2, 1);

        vm.warp(uint256(claims.getClaim(blocker).preCheckedAt) + _params().claimTimeout + 1);
        claims.expireClaim(blocker);
        _file(aliasFiler, platform, DEPOSIT, DEPOSIT); // same block, ahead of the close
        claims.closeUncontested(real);
        assertEq(vault.creditOf(shop), NET_LOSS + H + FEE, "paid in full, fee back");
        assertEq(vault.depositOf(platform), DEPOSIT - (NET_LOSS + H));
        _assertBooks();
    }

    /// Two claims wait behind the same earlier claim. When it ends, the later one cannot take what the earlier one
    /// may be owed, even when it is closed first: it waits again, and gets what is left after the earlier one.
    function test_waitingClaimsArePaidInFilingOrder() public {
        uint256 bigBasket = 4_900 * USDC;
        uint256 bigH = 40 * USDC; // capped
        bytes32 blocker = _file(aliasFiler, platform, DEPOSIT, DEPOSIT);
        bytes32 first = _file();
        bytes32 second = _file(shop2, platform, bigBasket, bigBasket);
        _precheck(first, 2, 1);
        _precheck(second, 2, 1);
        vm.warp(uint256(claims.getClaim(blocker).filedAt) + _params().claimTimeout + 1);
        claims.expireClaim(blocker); // never pre-checked: it expires from filing

        vm.expectRevert(abi.encodeWithSelector(IDepositVault.EarlierClaimOpen.selector, first));
        claims.closeUncontested(second);
        claims.closeUncontested(first);
        assertEq(vault.creditOf(shop), NET_LOSS + H + FEE, "the earlier claim in full");

        uint256 left = DEPOSIT - (NET_LOSS + H);
        vm.expectEmit(address(vault));
        emit IDepositVault.Shortfall(second, platform, bigBasket + bigH - left);
        claims.closeUncontested(second);
        assertEq(vault.creditOf(shop2), left + FEE, "the later claim gets what is left");
        assertEq(vault.depositOf(platform), 0);
        _assertBooks();
    }

    /// A shortfall is final only when the deposit itself runs out: the oldest open claim closes short at once.
    function test_oldestOpenClaimClosesShortWhenTheDepositRunsOut() public {
        uint256 small = 150 * USDC;
        _fund(platform2, small);
        vm.startPrank(platform2);
        usdc.approve(address(vault), type(uint256).max);
        vault.postDeposit(platform2, small);
        vm.stopPrank();
        bytes32 first = _file(shop, platform2, BASKET, NET_LOSS);
        bytes32 second = _file(shop2, platform2, BASKET, NET_LOSS);
        _precheck(first, 2, 1);
        _precheck(second, 2, 1);
        vm.warp(block.timestamp + _params().contestWindow + 1);

        vm.expectRevert(abi.encodeWithSelector(IDepositVault.EarlierClaimOpen.selector, first));
        claims.closeUncontested(second);
        claims.closeUncontested(first);
        uint256 left = small - (NET_LOSS + H);
        vm.expectEmit(address(vault));
        emit IDepositVault.Shortfall(second, platform2, NET_LOSS + H - left);
        claims.closeUncontested(second);
        assertEq(uint8(_status(second)), uint8(ClaimStatus.Closed));
        assertEq(vault.creditOf(shop), NET_LOSS + H + FEE);
        assertEq(vault.creditOf(shop2), left + FEE);
        assertEq(vault.depositOf(platform2), 0);
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

    /// A claim filed when the deposit was already fully reserved reserves nothing. While the earlier claim is
    /// open it waits rather than closing short, unless a top-up covers its payout beyond what the earlier claim
    /// may still be owed past its own reservation; it never draws on the earlier claim's reservation.
    function test_reservation_laterClaimWaitsOrDrawsOnATopUpBeyondEarlierClaims() public {
        bytes32 big = _file(aliasFiler, platform, DEPOSIT, DEPOSIT); // reserves all of it
        uint256 bigUncovered = 40 * USDC + FEE; // its handling (capped) and fee are past the deposit
        assertEq(vault.reservationOf(big), DEPOSIT);
        assertEq(vault.exposureOf(platform), DEPOSIT + bigUncovered);
        bytes32 late = _file(); // nothing left to reserve
        assertEq(vault.reservationOf(late), 0);

        _precheck(late, 2, 1);
        vm.warp(block.timestamp + _params().contestWindow + 1);
        assertEq(vault.availableTo(late), 0);
        vm.expectRevert(abi.encodeWithSelector(IDepositVault.EarlierClaimOpen.selector, big));
        claims.closeUncontested(late);

        // A top-up that covers the earlier claim's uncovered part but not this payout: still waiting.
        vm.prank(platform);
        vault.postDeposit(platform, 100 * USDC);
        assertEq(vault.availableTo(late), 100 * USDC - bigUncovered);
        vm.expectRevert(abi.encodeWithSelector(IDepositVault.EarlierClaimOpen.selector, big));
        claims.closeUncontested(late);

        // Enough of a top-up: it closes in full while the earlier claim is still open.
        vm.prank(platform);
        vault.postDeposit(platform, 100 * USDC);
        claims.closeUncontested(late);
        assertEq(vault.creditOf(shop), NET_LOSS + H + FEE, "paid in full from the top-up");
        assertEq(vault.depositOf(platform), DEPOSIT + 200 * USDC - (NET_LOSS + H));
        assertEq(vault.reservedOf(platform), DEPOSIT, "the earlier reservation is untouched");
        assertEq(vault.availableTo(big), DEPOSIT + 200 * USDC - (NET_LOSS + H), "the oldest may draw on it all");
        _assertBooks();
    }

    /// The vault keeps each platform's open claims in filing order, whatever order they end in.
    function test_oldestOpenClaimOf_followsFilingOrder() public {
        assertEq(vault.oldestOpenClaimOf(platform), bytes32(0));
        bytes32 a = _file();
        bytes32 b = _file(shop2, platform, BASKET, NET_LOSS);
        bytes32 c = _file();
        assertEq(vault.oldestOpenClaimOf(platform), a);
        assertEq(vault.maxPayoutOf(b), NET_LOSS + H + FEE);
        assertEq(vault.exposureOf(platform), 3 * (NET_LOSS + H + FEE));

        _precheck(b, 2, 2);
        vm.warp(block.timestamp + _params().contestWindow + 1);
        claims.closeUncontested(b); // out of the middle
        assertEq(vault.maxPayoutOf(b), 0);
        assertEq(vault.availableTo(b), 0);
        assertEq(vault.oldestOpenClaimOf(platform), a);
        assertEq(vault.exposureOf(platform), 2 * (NET_LOSS + H + FEE));

        vm.warp(uint256(claims.getClaim(a).filedAt) + _params().claimTimeout + 1);
        claims.expireClaim(a); // the oldest
        assertEq(vault.oldestOpenClaimOf(platform), c);
        bytes32 d = _file();
        claims.expireClaim(c);
        assertEq(vault.oldestOpenClaimOf(platform), d);
        vm.warp(uint256(claims.getClaim(d).filedAt) + _params().claimTimeout + 1);
        claims.expireClaim(d);
        assertEq(vault.oldestOpenClaimOf(platform), bytes32(0));
        assertEq(vault.exposureOf(platform), 0);
        assertEq(vault.reservedOf(platform), 0);
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
