// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {CCIPLocalRouter} from "@chainlink/local/src/ccip/CCIPLocalRouter.sol";
import {CCIPLocalSimulator} from "@chainlink/local/src/ccip/CCIPLocalSimulator.sol";
import {LinkToken} from "@chainlink/local/src/shared/LinkToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DepositVault} from "../../src/hedera/DepositVault.sol";
import {RecourseClaims} from "../../src/hedera/RecourseClaims.sol";
import {IDepositVault} from "../../src/hedera/interfaces/IDepositVault.sol";
import {IRecourseClaims} from "../../src/hedera/interfaces/IRecourseClaims.sol";
import {RecourseAddresses} from "../../src/shared/RecourseAddresses.sol";
import {BridgeMode, ClaimStatus} from "../../src/shared/RecourseTypes.sol";
import {MockUsdc} from "../../src/testnet/MockUsdc.sol";
import {ClaimsBase} from "./ClaimsBase.sol";

/// @notice DepositVault and RecourseClaims on MockUsdc, the testnet stand-in token, with the
///         pre-lock parameters from the shared parameter file (the ones `Deploy.s.sol` sets).
///         The HTS mocks stay at their system addresses, so the HTS association path can be shown
///         to fail on the mock. The platform and the shop each get 20 mUSDC from the owner.
contract MockUsdcTest is ClaimsBase {
    string internal constant PARAMS = "../packages/shared/vectors/params.json";
    uint256 internal constant MINTED = 20 * USDC;
    /// @dev Small enough that the platform's minimum deposit covers the whole payout.
    uint256 internal constant SMALL_BASKET = 2 * USDC;
    uint256 internal constant SMALL_LOSS = 2 * USDC;

    MockUsdc internal token;
    uint256 internal minDeposit;
    uint256 internal courtFee;

    function setUp() public {
        _setUpHedera();
        token = new MockUsdc(owner);
        sim = new CCIPLocalSimulator();
        (, IRouterClient r,,, LinkToken l,,) = sim.configuration();
        router = CCIPLocalRouter(address(r));
        linkToken = l;

        IRecourseClaims.Params memory p = _preLockClaims();
        courtFee = p.courtFeeUsdc;
        minDeposit = _preLock("minDeposit");

        vault = new DepositVault(address(token), pool, owner);
        claims = new RecourseClaims(address(r), address(l), address(vault), ARB_SEL, owner);
        vm.startPrank(owner);
        vault.bindClaims(address(claims));
        vault.setParams(uint64(_preLock("topUpWindow")), uint64(_preLock("exitDelay")), minDeposit);
        claims.setParams(p);
        claims.setPreCheckSigner(signer);
        claims.setBridgeMode(BridgeMode.Both, relayer);
        claims.setPeer(casePeer);
        token.mint(platform, MINTED);
        token.mint(shop, MINTED);
        vm.stopPrank();
        vault.associateUsdc(true);
        sim.requestLinkFromFaucet(address(claims), 10 ether);
    }

    // ------------------------------------------------------------ helpers

    function _preLock(string memory key) internal view returns (uint256) {
        return vm.parseJsonUint(vm.readFile(PARAMS), string.concat(".preLock.", key));
    }

    function _preLockClaims() internal view returns (IRecourseClaims.Params memory p) {
        p.contestWindow = uint64(_preLock("contestWindow"));
        p.claimTimeout = uint64(_preLock("claimTimeout"));
        p.courtFeeUsdc = _preLock("courtFeeUsdc");
        p.handlingBase = _preLock("handlingBase");
        p.handlingBps = uint16(_preLock("handlingBps"));
        p.handlingCap = _preLock("handlingCap");
        p.resendGap = uint64(_preLock("resendGap"));
        p.maxSends = uint8(_preLock("maxSends"));
    }

    /// @dev The platform posts the minimum deposit and the owner requires exactly that.
    function _depositMinimum() internal {
        vm.startPrank(platform);
        token.approve(address(vault), minDeposit);
        vault.postDeposit(platform, minDeposit);
        vm.stopPrank();
        vm.prank(owner);
        vault.setRequired(platform, minDeposit);
    }

    function _fileSmall() internal returns (bytes32 id) {
        vm.prank(shop);
        token.approve(address(vault), courtFee);
        id = _file(shop, platform, SMALL_BASKET, SMALL_LOSS);
    }

    function _assertMockBooks() internal view {
        (uint256 d, uint256 e, uint256 c) = vault.totals();
        assertEq(token.balanceOf(address(vault)), d + e + c, "balance == deposits + escrow + credits");
        assertEq(token.balanceOf(address(claims)), 0, "claims holds no mUSDC");
    }

    // ------------------------------------------------------------ the token

    function test_token_isMarkedAsAMock() public view {
        assertEq(token.name(), "Mock USD Coin (testnet)");
        assertEq(token.symbol(), "mUSDC");
        assertEq(token.decimals(), 6);
        assertEq(token.owner(), owner);
        assertTrue(address(token) != RecourseAddresses.HEDERA_USDC, "not at Circle's facade");
        assertEq(token.totalSupply(), 2 * MINTED);
    }

    function test_token_zeroOwnerRejected() public {
        vm.expectRevert(MockUsdc.ZeroOwner.selector);
        new MockUsdc(address(0));
    }

    function test_mint_ownerOnly() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(MockUsdc.NotOwner.selector, stranger));
        token.mint(stranger, 1);
        vm.prank(platform);
        vm.expectRevert(abi.encodeWithSelector(MockUsdc.NotOwner.selector, platform));
        token.mint(platform, 1);

        vm.expectEmit(address(token));
        emit IERC20.Transfer(address(0), stranger, 7 * USDC);
        vm.prank(owner);
        token.mint(stranger, 7 * USDC);
        assertEq(token.balanceOf(stranger), 7 * USDC);
        assertEq(token.totalSupply(), 2 * MINTED + 7 * USDC);
    }

    function test_token_associationAnswers() public {
        vm.prank(stranger);
        assertEq(token.associate(), 22);
        vm.prank(stranger);
        assertTrue(token.isAssociated());
        // Nothing to associate: an account that never called associate() still holds and sends it.
        vm.prank(shop);
        assertTrue(token.transfer(stranger, 1));
        assertEq(token.balanceOf(stranger), 1);
    }

    // ------------------------------------------------------------ association

    function test_associateUsdc_viaToken_succeeds() public {
        DepositVault v = new DepositVault(address(token), pool, owner);
        assertFalse(v.usdcAssociated());
        vm.expectEmit(address(v));
        emit IDepositVault.UsdcAssociated(22);
        assertEq(v.associateUsdc(true), 22);
        assertTrue(v.usdcAssociated());
        // Idempotent: a second call answers SUCCESS again.
        assertEq(v.associateUsdc(true), 22);
        assertTrue(v.usdcAssociated());
    }

    /// @dev The HTS system contract associates HTS tokens only, and MockUsdc is a plain EVM
    ///      contract. Whatever the live precompile does with it, the vault sees one of three shapes:
    ///      a revert, an empty answer or a code that is neither 22 nor 194. Each must revert with
    ///      AssociationFailed and leave the vault unassociated, with no mUSDC accepted; the three
    ///      are below. The tests do not show which shape the live precompile gives.
    function test_associateUsdc_viaHts_failsCleanlyOnTheMock() public {
        DepositVault v = new DepositVault(address(token), pool, owner);

        // A revert: the HTS mock forwards to a hook that only the HTS token mock has.
        vm.expectRevert(abi.encodeWithSelector(IDepositVault.AssociationFailed.selector, int256(-1)));
        v.associateUsdc(false);
        assertFalse(v.usdcAssociated());

        // A failure code (167 is INVALID_TOKEN_ID in Hedera's ResponseCodeEnum).
        hts.setResponseCode(167);
        vm.expectRevert(abi.encodeWithSelector(IDepositVault.AssociationFailed.selector, int256(167)));
        v.associateUsdc(false);
        assertFalse(v.usdcAssociated());
        hts.clearResponseCode();

        // An empty answer: no code at the system address.
        vm.etch(HTS_ADDR, "");
        vm.expectRevert(abi.encodeWithSelector(IDepositVault.AssociationFailed.selector, int256(-1)));
        v.associateUsdc(false);
        assertFalse(v.usdcAssociated());

        vm.startPrank(platform);
        token.approve(address(v), minDeposit);
        vm.expectRevert(IDepositVault.NotAssociatedYet.selector);
        v.postDeposit(platform, minDeposit);
        vm.stopPrank();

        // The token-side path still works afterwards.
        assertEq(v.associateUsdc(true), 22);
        assertTrue(v.usdcAssociated());
    }

    // ------------------------------------------------------------ platform deposit and shop fee

    function test_postDeposit_platform() public {
        vm.prank(platform);
        vm.expectRevert(IDepositVault.TransferFailed.selector);
        vault.postDeposit(platform, minDeposit); // no allowance yet

        vm.prank(platform);
        token.approve(address(vault), minDeposit);
        vm.expectEmit(address(vault));
        emit IDepositVault.DepositPosted(platform, platform, minDeposit, minDeposit);
        vm.prank(platform);
        vault.postDeposit(platform, minDeposit);
        vm.prank(owner);
        vault.setRequired(platform, minDeposit);

        assertEq(vault.depositOf(platform), minDeposit);
        assertEq(token.balanceOf(platform), MINTED - minDeposit);
        assertEq(token.balanceOf(address(vault)), minDeposit);
        assertTrue(vault.inGoodStanding(platform));
        _assertMockBooks();
    }

    function test_escrowFee_shop() public {
        _depositMinimum();
        vm.prank(shop);
        vm.expectRevert(IDepositVault.TransferFailed.selector);
        claims.fileClaim(bytes32("no allowance"), platform, _refs(), SMALL_BASKET, SMALL_LOSS);

        bytes32 id = _fileSmall();
        IDepositVault.Escrow memory e = vault.escrowOf(id);
        assertEq(uint8(e.state), uint8(IDepositVault.EscrowState.Open));
        assertEq(e.shop, shop);
        assertEq(e.platform, platform);
        assertEq(e.amount, courtFee);
        assertEq(vault.shopEscrowOf(shop), courtFee);
        assertEq(token.balanceOf(shop), MINTED - courtFee);
        assertEq(token.balanceOf(address(vault)), minDeposit + courtFee);
        _assertMockBooks();
    }

    // ------------------------------------------------------------ payouts and withdrawals

    /// @dev Ruled against the platform: the payout comes out of the deposit, the fee goes to the
    ///      pool, and both withdraw their credit in mUSDC.
    function test_settle_payoutAndWithdrawals() public {
        _depositMinimum();
        bytes32 id = _fileSmall();
        _precheck(id, 1, 1);
        _contest(id);
        claims.sendToCourt(id);
        _deliver(id, 77, 1, 1);
        assertEq(uint8(_status(id)), uint8(ClaimStatus.Ruled));

        (uint256 owed, uint256 refund, uint256 toPool) = claims.previewSettle(id);
        assertGt(owed, 0, "something owed");
        assertLe(owed, minDeposit, "the deposit covers the payout");
        assertEq(refund, 0);
        assertEq(toPool, courtFee);

        vm.prank(stranger);
        claims.settle(id);
        assertEq(vault.depositOf(platform), minDeposit - owed);
        assertEq(vault.creditOf(shop), owed);
        assertEq(vault.creditOf(pool), courtFee);
        _assertMockBooks();

        vm.expectEmit(address(vault));
        emit IDepositVault.CreditWithdrawn(shop, owed);
        vm.prank(shop);
        assertEq(vault.withdrawCredit(), owed);
        assertEq(token.balanceOf(shop), MINTED - courtFee + owed);

        vm.prank(pool);
        assertEq(vault.withdrawCredit(), courtFee);
        assertEq(token.balanceOf(pool), courtFee);

        vm.prank(shop);
        vm.expectRevert(IDepositVault.NoCredit.selector);
        vault.withdrawCredit();

        assertEq(token.balanceOf(address(vault)), minDeposit - owed);
        _assertMockBooks();
    }

    /// @dev Closed uncontested with the fee refunded to the shop, then the platform exits and
    ///      withdraws what is left of its deposit; the vault ends empty.
    function test_closeUncontested_refundThenExit() public {
        _depositMinimum();
        bytes32 id = _fileSmall();
        _precheck(id, 3, 2);
        vm.warp(uint256(claims.getClaim(id).preCheckedAt) + _preLock("contestWindow") + 1);
        (uint256 owed, uint256 refund,) = claims.previewSettle(id);
        assertEq(refund, courtFee);
        claims.closeUncontested(id);
        assertEq(vault.creditOf(shop), owed + courtFee);
        _assertMockBooks();

        vm.prank(shop);
        vault.withdrawCredit();
        assertEq(token.balanceOf(shop), MINTED + owed);

        vm.prank(platform);
        vault.requestExit();
        vm.warp(block.timestamp + _preLock("exitDelay"));
        vm.prank(platform);
        assertEq(vault.exit(), minDeposit - owed);
        vm.prank(platform);
        vault.withdrawCredit();
        assertEq(token.balanceOf(platform), MINTED - owed);

        (uint256 d, uint256 e, uint256 c) = vault.totals();
        assertEq(d + e + c, 0);
        assertEq(token.balanceOf(address(vault)), 0);
    }
}
