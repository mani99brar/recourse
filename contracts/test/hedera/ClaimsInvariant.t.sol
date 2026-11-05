// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IDepositVault} from "../../src/hedera/interfaces/IDepositVault.sol";
import {Claim, ClaimStatus} from "../../src/shared/RecourseTypes.sol";
import {ClaimsBase} from "./ClaimsBase.sol";
import {ClaimsHandler} from "./handlers/ClaimsHandler.sol";

/// @notice The money path end to end under random sequences: Claims never holds USDC, the
///         vault's books equal its balance, open-claim counts and escrows follow the claims, and
///         every claim moves only along the state table.
contract ClaimsInvariantTest is ClaimsBase {
    ClaimsHandler internal handler;

    function setUp() public {
        _setUpClaims();
        // A second platform with a small deposit, so payouts run short and start top-up clocks.
        usdc.mint(platform2, 10_000 * USDC);
        vm.startPrank(platform2);
        usdc.approve(address(vault), type(uint256).max);
        vault.postDeposit(platform2, 50 * USDC);
        vm.stopPrank();
        vm.prank(owner);
        vault.setRequired(platform2, 50 * USDC);
        // Top-ups by the main platform need headroom beyond the fixture's deposit.
        usdc.mint(platform, 10_000 * USDC);
        usdc.mint(shop, 100_000 * USDC);
        usdc.mint(shop2, 100_000 * USDC);

        address[] memory shops_ = new address[](2);
        shops_[0] = shop;
        shops_[1] = shop2;
        address[] memory platforms_ = new address[](2);
        platforms_[0] = platform;
        platforms_[1] = platform2;
        handler = new ClaimsHandler(claims, vault, router, signer, casePeer, ARB_SEL, shops_, platforms_, pool);

        bytes4[] memory sels = new bytes4[](15);
        sels[0] = ClaimsHandler.file.selector;
        sels[1] = ClaimsHandler.precheck.selector;
        sels[2] = ClaimsHandler.contest.selector;
        sels[3] = ClaimsHandler.close.selector;
        sels[4] = ClaimsHandler.send.selector;
        sels[5] = ClaimsHandler.resend.selector;
        sels[6] = ClaimsHandler.deliver.selector;
        sels[7] = ClaimsHandler.settle.selector;
        sels[8] = ClaimsHandler.expire.selector;
        sels[9] = ClaimsHandler.topUp.selector;
        sels[10] = ClaimsHandler.withdraw.selector;
        sels[11] = ClaimsHandler.warp.selector;
        sels[12] = ClaimsHandler.file.selector; // filing twice as often keeps claims flowing
        sels[13] = ClaimsHandler.requestExit.selector;
        sels[14] = ClaimsHandler.exit.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 200
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_moneyPath() public view {
        // Claims never holds USDC; the vault holds exactly its books.
        assertEq(usdc.balanceOf(address(claims)), 0, "claims holds USDC");
        (uint256 deposits, uint256 escrow, uint256 credits) = vault.totals();
        assertEq(usdc.balanceOf(address(vault)), deposits + escrow + credits, "books != balance");

        // Escrows and open-claim counts follow the claims.
        uint256 openEscrow;
        uint256[] memory open = new uint256[](handler.platformCount());
        for (uint256 i; i < handler.claimCount(); ++i) {
            bytes32 id = handler.claimIds(i);
            Claim memory c = claims.getClaim(id);
            assertEq(uint8(c.status), uint8(handler.lastStatus(id)), "status moved outside the handler");
            IDepositVault.Escrow memory e = vault.escrowOf(id);
            bool live = _live(c.status);
            assertEq(e.state == IDepositVault.EscrowState.Open, live, "escrow state vs claim status");
            if (live) {
                openEscrow += e.amount;
                for (uint256 j; j < open.length; ++j) {
                    if (handler.platforms(j) == c.platform) ++open[j];
                }
            }
        }
        assertEq(openEscrow, escrow, "escrow total");
        for (uint256 j; j < open.length; ++j) {
            assertEq(vault.openClaimsOf(handler.platforms(j)), open[j], "open claims");
        }

        uint256 sumCredits;
        for (uint256 i; i < handler.accountCount(); ++i) {
            sumCredits += vault.creditOf(handler.accounts(i));
        }
        assertEq(sumCredits, credits, "credits total");

        assertFalse(handler.illegalTransition(), "claim moved outside the state table");
        assertFalse(handler.receiveReverted(), "ccipReceive reverted");
    }

    function _live(ClaimStatus s) internal pure returns (bool) {
        return s == ClaimStatus.Filed || s == ClaimStatus.PreChecked || s == ClaimStatus.Contested
            || s == ClaimStatus.AtCourt || s == ClaimStatus.Ruled;
    }
}
