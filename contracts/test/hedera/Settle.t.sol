// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IDepositVault} from "../../src/hedera/interfaces/IDepositVault.sol";
import {IRecourseClaims} from "../../src/hedera/interfaces/IRecourseClaims.sol";
import {Claim} from "../../src/shared/RecourseTypes.sol";
import {ClaimsBase} from "./ClaimsBase.sol";

/// @notice Every settle-table row, end to end through the vault, with full and short deposits.
///         Defaults: basket 120 USDC, net loss 100 USDC, fee 3 USDC, so handling is
///         min(15 + 120 * 5%, 40) = 21 USDC.
contract SettleTest is ClaimsBase {
    uint256 internal constant H = 21 * USDC;
    uint256 internal constant N = NET_LOSS;

    function setUp() public {
        _setUpClaims();
    }

    // ------------------------------------------------------------ checkers

    function _expectApplied(bytes32 id, uint256 owed, uint256 refund, uint256 toPool) internal {
        Claim memory c = claims.getClaim(id);
        uint256 held = vault.depositOf(c.platform);
        uint256 paid = owed < held ? owed : held;
        vm.expectEmit(address(vault));
        emit IDepositVault.OutcomeApplied(id, c.platform, c.shop, paid, refund, toPool);
        if (owed > paid) {
            vm.expectEmit(address(vault));
            emit IDepositVault.Shortfall(id, c.platform, owed - paid);
        }
    }

    /// @dev Settles a Ruled claim and checks preview, events and every balance it touches.
    function _checkSettle(bytes32 id, uint8 outcome, uint256 owed) internal {
        Claim memory c = claims.getClaim(id);
        (uint256 pShop, uint256 pRefund, uint256 pPool) = claims.previewSettle(id);
        assertEq(pShop, owed, "preview toShop");
        assertEq(pRefund, 0, "preview refund");
        assertEq(pPool, FEE, "preview toPool");

        uint256 held = vault.depositOf(c.platform);
        uint256 shopCredit = vault.creditOf(c.shop);
        uint256 poolCredit = vault.creditOf(pool);
        uint256 paid = owed < held ? owed : held;

        vm.expectEmit(address(claims));
        emit IRecourseClaims.Settled(id, outcome, owed, FEE);
        _expectApplied(id, owed, 0, FEE);
        vm.prank(stranger);
        claims.settle(id);

        assertEq(vault.depositOf(c.platform), held - paid, "deposit");
        assertEq(vault.creditOf(c.shop), shopCredit + paid, "shop credit");
        assertEq(vault.creditOf(pool), poolCredit + FEE, "pool credit");
        assertEq(uint8(vault.escrowOf(id).state), uint8(IDepositVault.EscrowState.Closed));
        _assertBooks();
    }

    /// @dev Closes a PreChecked claim after its window and checks the same things.
    function _checkClose(bytes32 id, uint256 owed) internal {
        Claim memory c = claims.getClaim(id);
        vm.warp(uint256(c.preCheckedAt) + 601);
        (uint256 pShop, uint256 pRefund, uint256 pPool) = claims.previewSettle(id);
        assertEq(pShop, owed, "preview toShop");
        assertEq(pRefund, FEE, "preview refund");
        assertEq(pPool, 0, "preview toPool");

        uint256 held = vault.depositOf(c.platform);
        uint256 shopCredit = vault.creditOf(c.shop);
        uint256 poolCredit = vault.creditOf(pool);
        uint256 paid = owed < held ? owed : held;

        vm.expectEmit(address(claims));
        emit IRecourseClaims.ClosedUncontested(id, c.answer, owed);
        _expectApplied(id, owed, FEE, 0);
        claims.closeUncontested(id);

        assertEq(vault.depositOf(c.platform), held - paid, "deposit");
        assertEq(vault.creditOf(c.shop), shopCredit + paid + FEE, "shop credit");
        assertEq(vault.creditOf(pool), poolCredit, "pool credit");
        _assertBooks();
    }

    /// @dev Gives platform2 a deposit of `amount` with the same requirement (in good standing).
    function _platform2WithDeposit(uint256 amount) internal {
        usdc.mint(platform2, amount);
        vm.startPrank(platform2);
        usdc.approve(address(vault), amount);
        vault.postDeposit(platform2, amount);
        vm.stopPrank();
        vm.prank(owner);
        vault.setRequired(platform2, amount);
    }

    function _ruledAgainst(address p, uint8 gap, uint8 answer, uint8 ruling, uint8 attempts)
        internal
        returns (bytes32 id)
    {
        id = _file(shop, p, BASKET, NET_LOSS);
        _precheck(id, gap, answer);
        _contest(id);
        claims.sendToCourt(id);
        _deliver(id, 5, ruling, attempts);
    }

    // ------------------------------------------------------------ ruled rows

    function test_S1_rulingPlatform() public {
        _checkSettle(_ruled(1, 1, 1, 1), 1, N + H + FEE);
    }

    function test_S1_rulingPlatform_afterRefile() public {
        _checkSettle(_ruled(2, 2, 1, 2), 1, N + H + FEE);
    }

    function test_S2_rulingMerchant() public {
        _checkSettle(_ruled(1, 1, 2, 1), 2, 0);
    }

    function test_S3_rulingNeither_gap1() public {
        _checkSettle(_ruled(1, 1, 3, 1), 3, FEE);
    }

    function test_S3_rulingNeither_gap2() public {
        _checkSettle(_ruled(2, 2, 3, 1), 3, FEE);
    }

    function test_S4_rulingNeither_gap0() public {
        _checkSettle(_ruled(0, 2, 3, 1), 3, 0);
    }

    function test_S4_rulingNeither_gap3() public {
        _checkSettle(_ruled(3, 2, 3, 1), 3, 0);
    }

    function test_S4_rulingNeither_gap255() public {
        _checkSettle(_ruled(255, 1, 3, 1), 3, 0);
    }

    function test_S5a_zeroTwice_answerPlatform() public {
        _checkSettle(_ruled(1, 1, 0, 2), 1, N + H + FEE);
    }

    function test_S5a_zeroTwice_answerPlatform_missingRecord() public {
        _checkSettle(_ruled(255, 1, 0, 2), 1, N + H + FEE);
    }

    function test_S5b_zeroTwice_answerMerchant() public {
        _checkSettle(_ruled(3, 2, 0, 2), 2, 0);
    }

    function test_S5c_zeroTwice_answerNeither_gap1() public {
        _checkSettle(_ruled(1, 3, 0, 2), 3, FEE);
    }

    function test_S5c_zeroTwice_answerNeither_gap2() public {
        _checkSettle(_ruled(2, 3, 0, 2), 3, FEE);
    }

    function test_S5d_zeroTwice_answerNeither_otherGap() public {
        _checkSettle(_ruled(3, 3, 0, 2), 3, 0);
    }

    function test_S6_zeroTwice_noAnswer() public {
        _checkSettle(_ruled(255, 0, 0, 2), 0, FEE / 2);
    }

    // ------------------------------------------------------------ closed and expired rows

    function test_U1_uncontested_answerPlatform() public {
        bytes32 id = _file();
        _precheck(id, 1, 1);
        _checkClose(id, N + H);
    }

    function test_U2_uncontested_otherAnswers() public {
        for (uint8 a = 0; a <= 3; ++a) {
            if (a == 1) continue;
            bytes32 id = _file();
            _precheck(id, a == 0 ? 255 : 3, a);
            _checkClose(id, 0);
        }
    }

    function test_E1_expired_refundsInFull() public {
        bytes32 id = _atCourt(1, 1);
        vm.warp(T0 + 18 hours + 1);
        _expectApplied(id, 0, FEE, 0);
        claims.expireClaim(id);
        assertEq(vault.creditOf(shop), FEE);
        assertEq(vault.creditOf(pool), 0);
        assertEq(vault.depositOf(platform), DEPOSIT);
        _assertBooks();
    }

    // ------------------------------------------------------------ shortfall variants

    function test_shortfall_S1_capsAndStartsClock() public {
        _platform2WithDeposit(50 * USDC);
        bytes32 id = _ruledAgainst(platform2, 1, 1, 1, 1);
        assertEq(vault.topUpStartedAt(platform2), 0);
        _checkSettle(id, 1, N + H + FEE);
        assertEq(vault.depositOf(platform2), 0);
        assertEq(vault.topUpStartedAt(platform2), block.timestamp);
        assertTrue(vault.inGoodStanding(platform2)); // inside the grace window
        vm.warp(block.timestamp + 7 days + 1);
        assertFalse(vault.inGoodStanding(platform2));
    }

    function test_shortfall_U1() public {
        _platform2WithDeposit(50 * USDC);
        bytes32 id = _file(shop, platform2, BASKET, NET_LOSS);
        _precheck(id, 1, 1);
        _checkClose(id, N + H);
        assertEq(vault.depositOf(platform2), 0);
        assertEq(vault.creditOf(shop), 50 * USDC + FEE);
    }

    function test_shortfall_S3() public {
        _platform2WithDeposit(2 * USDC);
        _checkSettle(_ruledAgainst(platform2, 2, 2, 3, 1), 3, FEE);
        assertEq(vault.depositOf(platform2), 0);
    }

    function test_shortfall_S6() public {
        _platform2WithDeposit(1 * USDC);
        _checkSettle(_ruledAgainst(platform2, 255, 0, 0, 2), 0, FEE / 2);
        assertEq(vault.depositOf(platform2), 0);
    }

    function test_shortfall_platformNotOnScheme() public {
        bytes32 id = _ruledAgainst(platform2, 1, 1, 1, 1);
        _checkSettle(id, 1, N + H + FEE);
        assertEq(vault.creditOf(shop), 0);
        assertEq(vault.topUpStartedAt(platform2), 0);
    }

    // ------------------------------------------------------------ handling and fee source

    function test_handling_atBase() public {
        bytes32 id = _file(shop, platform, 1, 1);
        _precheck(id, 1, 1);
        _checkClose(id, 1 + 15 * USDC);
    }

    function test_handling_atCap() public {
        bytes32 id = _file(shop, platform, 1_000 * USDC, 900 * USDC);
        _precheck(id, 1, 1);
        _checkClose(id, 900 * USDC + 40 * USDC);
    }

    function test_handling_rounding() public {
        // 333_333 * 500 / 10_000 = 16_666.65, floored to 16_666.
        bytes32 id = _file(shop, platform, 333_333, 333_333);
        _precheck(id, 2, 1);
        _contest(id);
        claims.sendToCourt(id);
        _deliver(id, 1, 1, 1);
        _checkSettle(id, 1, 333_333 + 15_016_666 + FEE);
    }

    function test_settleUsesEscrowedFeeNotCurrentParam() public {
        bytes32 id = _ruled(1, 1, 1, 1);
        IRecourseClaims.Params memory p = _params();
        p.courtFeeUsdc = 4 * USDC;
        vm.prank(owner);
        claims.setParams(p);
        _checkSettle(id, 1, N + H + FEE);
    }
}
