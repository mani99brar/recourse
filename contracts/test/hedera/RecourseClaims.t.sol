// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {RecourseClaims} from "../../src/hedera/RecourseClaims.sol";
import {IDepositVault} from "../../src/hedera/interfaces/IDepositVault.sol";
import {IRecourseClaims} from "../../src/hedera/interfaces/IRecourseClaims.sol";
import {DepositVault} from "../../src/hedera/DepositVault.sol";
import {BridgeCodec} from "../../src/shared/BridgeCodec.sol";
import {RecourseIds} from "../../src/shared/RecourseIds.sol";
import {BridgeMode, Claim, ClaimStatus, RecordRefs} from "../../src/shared/RecourseTypes.sol";
import {ClaimsBase} from "./ClaimsBase.sol";

/// @notice RecourseClaims: filing, pre-check, contest, close, expiry, settle entry checks,
///         configuration and views. Money amounts per settle row live in Settle.t.sol, CCIP
///         receive in Receive.t.sol, sends and modes in BridgeModes.t.sol.
contract RecourseClaimsTest is ClaimsBase {
    function setUp() public {
        _setUpClaims();
    }

    // ------------------------------------------------------------ construction

    function test_constructor_rejectsZeroInputs() public {
        vm.expectRevert(abi.encodeWithSelector(CCIPReceiver.InvalidRouter.selector, address(0)));
        deployer.deployClaims(address(0), address(linkToken), address(vault), ARB_SEL, owner);
        vm.expectRevert(IRecourseClaims.ZeroAddress.selector);
        deployer.deployClaims(address(router), address(0), address(vault), ARB_SEL, owner);
        vm.expectRevert(IRecourseClaims.ZeroAddress.selector);
        deployer.deployClaims(address(router), address(linkToken), address(0), ARB_SEL, owner);
        vm.expectRevert(IRecourseClaims.ZeroAddress.selector);
        deployer.deployClaims(address(router), address(linkToken), address(vault), 0, owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        deployer.deployClaims(address(router), address(linkToken), address(vault), ARB_SEL, address(0));
    }

    function test_constructor_defaults() public {
        RecourseClaims c = deployer.deployClaims(address(router), address(linkToken), address(vault), ARB_SEL, owner);
        IRecourseClaims.Params memory p = c.params();
        assertEq(p.contestWindow, 600);
        assertEq(p.claimTimeout, 18 hours);
        assertEq(p.courtFeeUsdc, 3_000_000);
        assertEq(p.handlingBase, 15_000_000);
        assertEq(p.handlingBps, 500);
        assertEq(p.handlingCap, 40_000_000);
        assertEq(p.resendGap, 30 minutes);
        assertEq(p.maxSends, 5);
        assertEq(c.extraArgs(), BridgeCodec.extraArgsFor(150_000));
        assertEq(c.feeToken(), address(linkToken));
        assertEq(c.link(), address(linkToken));
        assertEq(c.vault(), address(vault));
        assertEq(c.arbSelector(), ARB_SEL);
        assertEq(c.getRouter(), address(router));
        assertEq(uint8(c.bridgeMode()), uint8(BridgeMode.Both));
        assertEq(c.peer(), address(0));
        assertEq(c.preCheckSigner(), address(0));
        assertFalse(c.configLocked());
    }

    // ------------------------------------------------------------ fileClaim

    function test_fileClaim_storesClaimAndEscrowsFee() public {
        bytes32 nonce = keccak256("order-1");
        bytes32 orderId = RecourseIds.orderIdOf(platform, shop, nonce);
        bytes32 expected = RecourseIds.claimIdOf(296, address(claims), orderId);
        RecordRefs memory refs = _refs();

        vm.expectEmit(address(claims));
        emit IRecourseClaims.ClaimFiled(expected, orderId, shop, platform, refs, BASKET, NET_LOSS, uint64(T0));
        vm.expectEmit(address(vault));
        emit IDepositVault.FeeEscrowed(expected, shop, FEE);
        vm.prank(shop);
        bytes32 id = claims.fileClaim(nonce, platform, refs, BASKET, NET_LOSS);

        assertEq(id, expected);
        assertEq(claims.claimIdFor(platform, shop, nonce), expected);
        Claim memory c = claims.getClaim(id);
        assertEq(c.orderId, orderId);
        assertEq(c.shop, shop);
        assertEq(c.platform, platform);
        assertEq(c.refs.topicNum, refs.topicNum);
        for (uint256 i; i < 6; ++i) {
            assertEq(c.refs.seq[i], refs.seq[i]);
            assertEq(c.refs.hashes[i], refs.hashes[i]);
        }
        assertEq(c.basketUsdc, BASKET);
        assertEq(c.netLossUsdc, NET_LOSS);
        assertEq(c.filedAt, T0);
        assertEq(uint8(c.status), uint8(ClaimStatus.Filed));
        assertEq(vault.escrowOf(id).amount, FEE);
        assertEq(vault.shopEscrowOf(shop), FEE);
        assertEq(vault.openClaimsOf(platform), 1);
        _assertBooks();
    }

    function test_fileClaim_inputChecks() public {
        RecordRefs memory refs = _refs();
        vm.startPrank(shop);
        vm.expectRevert(IRecourseClaims.ZeroAddress.selector);
        claims.fileClaim(bytes32("n"), address(0), refs, BASKET, NET_LOSS);
        vm.expectRevert(IRecourseClaims.ZeroBasket.selector);
        claims.fileClaim(bytes32("n"), platform, refs, 0, 0);
        vm.expectRevert(IRecourseClaims.BasketTooLarge.selector);
        claims.fileClaim(bytes32("n"), platform, refs, uint256(type(uint128).max) + 1, 0);
        vm.expectRevert(IRecourseClaims.NetLossAboveBasket.selector);
        claims.fileClaim(bytes32("n"), platform, refs, BASKET, BASKET + 1);

        RecordRefs memory noTopic = _refs();
        noTopic.topicNum = 0;
        vm.expectRevert(IRecourseClaims.BadRefs.selector);
        claims.fileClaim(bytes32("n"), platform, noTopic, BASKET, NET_LOSS);

        RecordRefs memory noOrdered = _refs();
        noOrdered.hashes[3] = bytes32(0);
        vm.expectRevert(IRecourseClaims.MissingOrdered.selector);
        claims.fileClaim(bytes32("n"), platform, noOrdered, BASKET, NET_LOSS);
        vm.stopPrank();

        vm.prank(platform);
        vm.expectRevert(IRecourseClaims.SameParty.selector);
        claims.fileClaim(bytes32("n"), platform, refs, BASKET, NET_LOSS);

        // Other missing records are allowed at filing; the basket cap itself is accepted.
        RecordRefs memory partialRefs = _refs();
        partialRefs.hashes[4] = bytes32(0);
        partialRefs.hashes[5] = bytes32(0);
        vm.prank(shop);
        claims.fileClaim(bytes32("n"), platform, partialRefs, type(uint128).max, NET_LOSS);
    }

    function test_fileClaim_oncePerOrder() public {
        vm.startPrank(shop);
        bytes32 id = claims.fileClaim(bytes32("n"), platform, _refs(), BASKET, NET_LOSS);
        vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.ClaimExists.selector, id));
        claims.fileClaim(bytes32("n"), platform, _refs(), BASKET, NET_LOSS);
        vm.stopPrank();
    }

    function test_fileClaim_competingFilerCannotBlockTheShop() public {
        bytes32 nonce = keccak256("contested-order");
        vm.prank(shop2);
        bytes32 rogue = claims.fileClaim(nonce, platform, _refs(), BASKET, NET_LOSS);
        vm.prank(shop);
        bytes32 real = claims.fileClaim(nonce, platform, _refs(), BASKET, NET_LOSS);
        assertTrue(rogue != real);
        assertEq(claims.getClaim(real).shop, shop);
        assertEq(claims.getClaim(rogue).shop, shop2);
    }

    function test_fileClaim_againstPlatformWithNoDeposit() public {
        bytes32 id = _file(shop, platform2, BASKET, NET_LOSS);
        assertEq(uint8(_status(id)), uint8(ClaimStatus.Filed));
        assertEq(vault.depositOf(platform2), 0);
    }

    function test_fileClaim_failsWithoutAllowanceOrAssociation() public {
        vm.prank(shop);
        usdc.approve(address(vault), 0);
        vm.prank(shop);
        vm.expectRevert(IDepositVault.TransferFailed.selector);
        claims.fileClaim(bytes32("n"), platform, _refs(), BASKET, NET_LOSS);

        DepositVault v2 = new DepositVault(USDC_ADDR, pool, owner);
        RecourseClaims c2 = new RecourseClaims(address(router), address(linkToken), address(v2), ARB_SEL, owner);
        vm.prank(owner);
        v2.bindClaims(address(c2));
        vm.prank(shop);
        vm.expectRevert(IDepositVault.NotAssociatedYet.selector);
        c2.fileClaim(bytes32("n"), platform, _refs(), BASKET, NET_LOSS);
    }

    // ------------------------------------------------------------ recordPreCheck

    function test_recordPreCheck_onlySignerAndOnce() public {
        bytes32 id = _file();
        vm.prank(stranger);
        vm.expectRevert(IRecourseClaims.NotPreCheckSigner.selector);
        claims.recordPreCheck(id, 1, 1, bytes32("p"));

        vm.expectEmit(address(claims));
        emit IRecourseClaims.PreCheckRecorded(id, 2, 1, bytes32("p"));
        vm.prank(signer);
        claims.recordPreCheck(id, 2, 1, bytes32("p"));
        Claim memory c = claims.getClaim(id);
        assertEq(c.gap, 2);
        assertEq(c.answer, 1);
        assertEq(c.packHash, bytes32("p"));
        assertEq(c.preCheckedAt, T0);
        assertEq(uint8(c.status), uint8(ClaimStatus.PreChecked));

        vm.prank(signer);
        vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.WrongStatus.selector, ClaimStatus.PreChecked));
        claims.recordPreCheck(id, 2, 1, bytes32("p"));
    }

    function test_recordPreCheck_codeChecks() public {
        bytes32 id = _file();
        vm.startPrank(signer);
        vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.WrongStatus.selector, ClaimStatus.None));
        claims.recordPreCheck(bytes32("unknown"), 1, 1, bytes32("p"));
        vm.expectRevert(IRecourseClaims.BadCode.selector);
        claims.recordPreCheck(id, 4, 1, bytes32("p"));
        vm.expectRevert(IRecourseClaims.BadCode.selector);
        claims.recordPreCheck(id, 254, 1, bytes32("p"));
        vm.expectRevert(IRecourseClaims.BadCode.selector);
        claims.recordPreCheck(id, 1, 4, bytes32("p"));
        vm.expectRevert(IRecourseClaims.BadCode.selector);
        claims.recordPreCheck(id, 255, 3, bytes32("p"));
        vm.expectRevert(IRecourseClaims.ZeroPackHash.selector);
        claims.recordPreCheck(id, 1, 1, bytes32(0));
        vm.stopPrank();
    }

    function test_recordPreCheck_acceptsEveryValidPair() public {
        uint8[5] memory gaps = [0, 1, 2, 3, 255];
        for (uint256 g; g < gaps.length; ++g) {
            for (uint8 a; a <= 3; ++a) {
                if (gaps[g] == 255 && a == 3) continue;
                bytes32 id = _file();
                _precheck(id, gaps[g], a);
                assertEq(uint8(_status(id)), uint8(ClaimStatus.PreChecked));
            }
        }
    }

    // ------------------------------------------------------------ contest

    function test_contest_platformWhenAnswerIsPlatform() public {
        bytes32 id = _file();
        _precheck(id, 1, 1);
        vm.prank(shop);
        vm.expectRevert(IRecourseClaims.NotContester.selector);
        claims.contest(id);
        vm.expectEmit(address(claims));
        emit IRecourseClaims.Contested(id, platform);
        vm.prank(platform);
        claims.contest(id);
        Claim memory c = claims.getClaim(id);
        assertEq(c.contestedBy, platform);
        assertEq(uint8(c.status), uint8(ClaimStatus.Contested));
    }

    function test_contest_shopOtherwise() public {
        for (uint8 a = 0; a <= 3; ++a) {
            if (a == 1) continue;
            bytes32 id = _file();
            _precheck(id, 0, a);
            vm.prank(platform);
            vm.expectRevert(IRecourseClaims.NotContester.selector);
            claims.contest(id);
            vm.prank(stranger);
            vm.expectRevert(IRecourseClaims.NotContester.selector);
            claims.contest(id);
            vm.prank(shop);
            claims.contest(id);
            assertEq(claims.getClaim(id).contestedBy, shop);
        }
    }

    function test_contest_windowBoundary() public {
        bytes32 id = _file();
        _precheck(id, 1, 1);
        bytes32 id2 = _file();
        _precheck(id2, 1, 1);
        vm.warp(T0 + 600); // last second of the window
        vm.prank(platform);
        claims.contest(id);
        vm.warp(T0 + 601);
        vm.prank(platform);
        vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.WindowClosed.selector, T0 + 600));
        claims.contest(id2);
    }

    // ------------------------------------------------------------ closeUncontested

    function test_closeUncontested_afterWindowOnly() public {
        bytes32 id = _file();
        vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.WrongStatus.selector, ClaimStatus.Filed));
        claims.closeUncontested(id);
        _precheck(id, 3, 2);
        vm.warp(T0 + 600);
        vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.WindowOpen.selector, T0 + 600));
        claims.closeUncontested(id);
        vm.warp(T0 + 601);
        vm.expectEmit(address(claims));
        emit IRecourseClaims.ClosedUncontested(id, 2, 0);
        vm.prank(stranger);
        claims.closeUncontested(id);
        assertEq(uint8(_status(id)), uint8(ClaimStatus.Closed));
        vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.WrongStatus.selector, ClaimStatus.Closed));
        claims.closeUncontested(id);
        _assertBooks();
    }

    // ------------------------------------------------------------ expireClaim

    function test_expireClaim_fromFiledContestedAndAtCourt() public {
        bytes32 filed = _file();
        bytes32 contested = _file();
        _precheck(contested, 1, 1);
        _contest(contested);
        bytes32 atCourt = _atCourt(2, 2);

        vm.warp(T0 + 18 hours);
        vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.NotExpired.selector, T0 + 18 hours));
        claims.expireClaim(filed);
        vm.warp(T0 + 18 hours + 1);

        bytes32[3] memory ids = [filed, contested, atCourt];
        for (uint256 i; i < 3; ++i) {
            vm.expectEmit(address(claims));
            emit IRecourseClaims.ClaimExpired(ids[i]);
            vm.expectEmit(address(vault));
            emit IDepositVault.OutcomeApplied(ids[i], platform, shop, 0, FEE, 0);
            vm.prank(stranger);
            claims.expireClaim(ids[i]);
            assertEq(uint8(_status(ids[i])), uint8(ClaimStatus.Expired));
        }
        assertEq(vault.creditOf(shop), 3 * FEE);
        assertEq(vault.depositOf(platform), DEPOSIT);
        assertEq(vault.openClaimsOf(platform), 0);
        _assertBooks();
    }

    function test_expireClaim_neverFromPreCheckedRuledOrTerminal() public {
        bytes32 pre = _file();
        _precheck(pre, 1, 1);
        bytes32 ruled = _ruled(1, 1, 1, 1);
        bytes32 closed = _file();
        _precheck(closed, 0, 0);
        vm.warp(T0 + 601);
        claims.closeUncontested(closed);
        vm.warp(T0 + 1 days);
        vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.WrongStatus.selector, ClaimStatus.PreChecked));
        claims.expireClaim(pre);
        vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.WrongStatus.selector, ClaimStatus.Ruled));
        claims.expireClaim(ruled);
        vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.WrongStatus.selector, ClaimStatus.Closed));
        claims.expireClaim(closed);
        vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.WrongStatus.selector, ClaimStatus.None));
        claims.expireClaim(bytes32("unknown"));
    }

    // ------------------------------------------------------------ state table

    /// @dev Every lifecycle call from every status it is not allowed in reverts with WrongStatus.
    function test_stateTable_forbiddenMovesRevert() public {
        bytes32[] memory ids = new bytes32[](8);
        ids[0] = bytes32("none"); // None
        ids[1] = _file(); // Filed
        ids[2] = _file();
        _precheck(ids[2], 1, 1); // PreChecked
        ids[3] = _file();
        _precheck(ids[3], 1, 1);
        _contest(ids[3]); // Contested
        ids[4] = _atCourt(1, 1); // AtCourt
        ids[5] = _ruled(1, 1, 2, 1); // Ruled
        ids[6] = _ruled(1, 1, 2, 1);
        claims.settle(ids[6]); // Settled
        ids[7] = _file();
        _precheck(ids[7], 0, 0); // -> Closed below
        vm.warp(T0 + 601);
        claims.closeUncontested(ids[7]);

        for (uint256 i; i < ids.length; ++i) {
            ClaimStatus s = _status(ids[i]);
            if (s != ClaimStatus.Filed) {
                vm.prank(signer);
                vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.WrongStatus.selector, s));
                claims.recordPreCheck(ids[i], 1, 1, bytes32("p"));
            }
            if (s != ClaimStatus.PreChecked) {
                vm.prank(platform);
                vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.WrongStatus.selector, s));
                claims.contest(ids[i]);
                vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.WrongStatus.selector, s));
                claims.closeUncontested(ids[i]);
            }
            if (s != ClaimStatus.Contested) {
                vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.WrongStatus.selector, s));
                claims.sendToCourt(ids[i]);
            }
            if (s != ClaimStatus.AtCourt) {
                vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.WrongStatus.selector, s));
                claims.resend(ids[i]);
            }
            if (s != ClaimStatus.Ruled) {
                vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.WrongStatus.selector, s));
                claims.settle(ids[i]);
            }
        }
    }

    function test_settle_onlyOnceAndByAnyone() public {
        bytes32 id = _ruled(1, 1, 1, 1);
        vm.prank(stranger);
        claims.settle(id);
        assertEq(uint8(_status(id)), uint8(ClaimStatus.Settled));
        vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.WrongStatus.selector, ClaimStatus.Settled));
        claims.settle(id);
        _assertBooks();
    }

    // ------------------------------------------------------------ owner configuration

    function test_owner_settersAreOwnerOnly() public {
        IRecourseClaims.Params memory p = _params();
        vm.startPrank(stranger);
        bytes memory unauthorized = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger);
        vm.expectRevert(unauthorized);
        claims.setPeer(address(1));
        vm.expectRevert(unauthorized);
        claims.setParams(p);
        vm.expectRevert(unauthorized);
        claims.setPreCheckSigner(address(1));
        vm.expectRevert(unauthorized);
        claims.setBridgeMode(BridgeMode.None, address(1));
        vm.expectRevert(unauthorized);
        claims.sweepLink(stranger);
        vm.expectRevert(unauthorized);
        claims.sweepNative(payable(stranger));
        vm.expectRevert(unauthorized);
        claims.lockConfig();
        vm.expectRevert(unauthorized);
        claims.setExtraArgs(hex"01020304");
        vm.expectRevert(unauthorized);
        claims.setFeeToken(address(0));
        vm.stopPrank();
    }

    function test_owner_settersStoreAndEmit() public {
        vm.startPrank(owner);
        vm.expectEmit(address(claims));
        emit IRecourseClaims.PeerSet(address(0xCa5e));
        claims.setPeer(address(0xCa5e));
        assertEq(claims.peer(), address(0xCa5e));
        vm.expectEmit(address(claims));
        emit IRecourseClaims.PreCheckSignerSet(address(0x5161));
        claims.setPreCheckSigner(address(0x5161));
        assertEq(claims.preCheckSigner(), address(0x5161));
        vm.expectEmit(address(claims));
        emit IRecourseClaims.BridgeModeSet(BridgeMode.OutOnly, relayer);
        claims.setBridgeMode(BridgeMode.OutOnly, relayer);
        assertEq(uint8(claims.bridgeMode()), uint8(BridgeMode.OutOnly));
        assertEq(claims.rulingRelayer(), relayer);

        IRecourseClaims.Params memory p = _params();
        p.contestWindow = 1800;
        p.claimTimeout = 20 hours;
        vm.expectEmit(address(claims));
        emit IRecourseClaims.ParamsSet(p);
        claims.setParams(p);
        assertEq(_params().contestWindow, 1800);
        assertEq(_params().claimTimeout, 20 hours);

        bytes memory args = BridgeCodec.extraArgsFor(250_000);
        vm.expectEmit(address(claims));
        emit IRecourseClaims.ExtraArgsSet(args);
        claims.setExtraArgs(args);
        assertEq(claims.extraArgs(), args);

        vm.expectRevert(IRecourseClaims.ZeroAddress.selector);
        claims.setPeer(address(0));
        vm.expectRevert(IRecourseClaims.ZeroAddress.selector);
        claims.setPreCheckSigner(address(0));
        vm.expectRevert(IRecourseClaims.ZeroAddress.selector);
        claims.setBridgeMode(BridgeMode.Both, address(0));
        vm.expectRevert(IRecourseClaims.BadParams.selector);
        claims.setExtraArgs(hex"010203");
        vm.stopPrank();
    }

    function test_setParams_bounds() public {
        IRecourseClaims.Params[] memory bad = new IRecourseClaims.Params[](8);
        for (uint256 i; i < bad.length; ++i) {
            bad[i] = _params(); // a fresh copy each time; memory structs alias on assignment
        }
        bad[0].contestWindow = 0;
        bad[1].claimTimeout = bad[1].contestWindow;
        bad[2].handlingBps = 10_001;
        bad[3].maxSends = 0;
        bad[4].courtFeeUsdc = 0;
        bad[5].courtFeeUsdc = uint256(type(uint128).max) + 1;
        bad[6].handlingBase = uint256(type(uint128).max) + 1;
        bad[7].handlingCap = uint256(type(uint128).max) + 1;
        vm.startPrank(owner);
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(IRecourseClaims.BadParams.selector);
            claims.setParams(bad[i]);
        }
        IRecourseClaims.Params memory good = _params();
        good.handlingBps = 10_000;
        claims.setParams(good);
        vm.stopPrank();
    }

    function test_feeToken_linkOrNativeOnly_alwaysCallable() public {
        vm.startPrank(owner);
        vm.expectRevert(IRecourseClaims.BadParams.selector);
        claims.setFeeToken(USDC_ADDR);
        vm.expectEmit(address(claims));
        emit IRecourseClaims.FeeTokenSet(address(0));
        claims.setFeeToken(address(0));
        assertEq(claims.feeToken(), address(0));
        // Emitted on every call, including a repeat.
        vm.expectEmit(address(claims));
        emit IRecourseClaims.FeeTokenSet(address(0));
        claims.setFeeToken(address(0));
        claims.lockConfig();
        vm.expectEmit(address(claims));
        emit IRecourseClaims.FeeTokenSet(address(linkToken));
        claims.setFeeToken(address(linkToken));
        assertEq(claims.feeToken(), address(linkToken));
        // Extra args also stay callable after the lock.
        claims.setExtraArgs(BridgeCodec.extraArgsFor(350_000));
        vm.stopPrank();
    }

    function test_lockConfig_requirementsAndEffect() public {
        RecourseClaims c = new RecourseClaims(address(router), address(linkToken), address(vault), ARB_SEL, owner);
        vm.startPrank(owner);
        vm.expectRevert(IRecourseClaims.NotReadyToLock.selector); // no signer, no peer
        c.lockConfig();
        c.setPreCheckSigner(signer);
        vm.expectRevert(IRecourseClaims.NotReadyToLock.selector); // mode Both needs a peer
        c.lockConfig();
        c.setPeer(casePeer);
        vm.expectRevert(IRecourseClaims.NotReadyToLock.selector); // vault bound to another claims
        c.lockConfig();
        vm.stopPrank();

        vm.startPrank(owner);
        vm.expectEmit(address(claims));
        emit IRecourseClaims.ConfigLocked();
        claims.lockConfig();
        assertTrue(claims.configLocked());
        IRecourseClaims.Params memory p = _params();
        vm.expectRevert(IRecourseClaims.ConfigIsLocked.selector);
        claims.setParams(p);
        vm.expectRevert(IRecourseClaims.ConfigIsLocked.selector);
        claims.setPeer(address(1));
        vm.expectRevert(IRecourseClaims.ConfigIsLocked.selector);
        claims.setPreCheckSigner(address(1));
        vm.expectRevert(IRecourseClaims.ConfigIsLocked.selector);
        claims.setBridgeMode(BridgeMode.None, relayer);
        vm.expectRevert(IRecourseClaims.ConfigIsLocked.selector);
        claims.sweepLink(owner);
        vm.expectRevert(IRecourseClaims.ConfigIsLocked.selector);
        claims.sweepNative(payable(owner));
        vm.expectRevert(IRecourseClaims.ConfigIsLocked.selector);
        claims.lockConfig();
        vm.stopPrank();
    }

    function test_lockConfig_modeNoneNeedsNoPeer() public {
        DepositVault v = new DepositVault(USDC_ADDR, pool, owner);
        RecourseClaims c = new RecourseClaims(address(router), address(linkToken), address(v), ARB_SEL, owner);
        vm.startPrank(owner);
        v.bindClaims(address(c));
        c.setPreCheckSigner(signer);
        c.setBridgeMode(BridgeMode.None, relayer);
        c.lockConfig();
        vm.stopPrank();
        assertTrue(c.configLocked());
    }

    function test_sweeps_moveOnlyTheirAssetBeforeLock() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        claims.fundNative{value: 0.5 ether}();
        // Stray USDC on the claims contract is never touched by a sweep.
        usdc.mockAssociate(address(claims));
        usdc.mint(address(claims), 1 * USDC);

        vm.startPrank(owner);
        vm.expectEmit(address(claims));
        emit IRecourseClaims.LinkSwept(owner, 10 ether);
        claims.sweepLink(owner);
        vm.expectEmit(address(claims));
        emit IRecourseClaims.NativeSwept(payable(owner), 0.5 ether);
        claims.sweepNative(payable(owner));
        vm.expectRevert(IRecourseClaims.ZeroAddress.selector);
        claims.sweepLink(address(0));
        vm.stopPrank();
        assertEq(linkToken.balanceOf(owner), 10 ether);
        assertEq(owner.balance, 0.5 ether);
        assertEq(address(claims).balance, 0);
        assertEq(usdc.balanceOf(address(claims)), 1 * USDC);
    }

    function test_ownerCannotMoveUsdcOrRule() public {
        bytes32 id = _atCourt(1, 1);
        vm.startPrank(owner);
        vm.expectRevert(IRecourseClaims.NotRelayer.selector);
        claims.recordRuling(id, 1, 1, 1);
        vm.expectRevert(IDepositVault.OnlyClaims.selector);
        vault.applyOutcome(id, platform, shop, 1, 0);
        vm.expectRevert(IDepositVault.OnlyClaims.selector);
        vault.escrowFee(owner, platform, 1, bytes32("x"));
        vm.stopPrank();
    }

    // ------------------------------------------------------------ views

    function test_views_unknownIdsReturnZeros() public view {
        bytes32 unknown = bytes32("unknown");
        Claim memory c = claims.getClaim(unknown);
        assertEq(uint8(c.status), uint8(ClaimStatus.None));
        assertEq(c.shop, address(0));
        (uint256 a, uint256 b, uint256 d) = claims.previewSettle(unknown);
        assertEq(a + b + d, 0);
        assertEq(claims.quoteSend(unknown), 0);
        assertEq(claims.batchOf(unknown), 0);
        IRecourseClaims.Batch memory batch = claims.getBatch(7);
        assertEq(batch.pBps, 0);
        assertEq(batch.claimIds.length, 0);
        assertFalse(batch.drawn);
    }

    function test_handlingOf() public view {
        assertEq(claims.handlingOf(0), 15_000_000);
        assertEq(claims.handlingOf(100 * USDC), 20_000_000);
        assertEq(claims.handlingOf(500 * USDC), 40_000_000);
        assertEq(claims.handlingOf(10_000 * USDC), 40_000_000);
        assertEq(claims.handlingOf(19), 15_000_000);
        assertEq(claims.handlingOf(39), 15_000_001);
    }

    // ------------------------------------------------------------ native value

    function test_onlyFundNativeAcceptsValue() public {
        bytes4[22] memory sels = [
            IRecourseClaims.fileClaim.selector,
            IRecourseClaims.recordPreCheck.selector,
            IRecourseClaims.contest.selector,
            IRecourseClaims.closeUncontested.selector,
            IRecourseClaims.sendToCourt.selector,
            IRecourseClaims.resend.selector,
            IRecourseClaims.expireClaim.selector,
            IRecourseClaims.recordRuling.selector,
            IRecourseClaims.settle.selector,
            IRecourseClaims.setPeer.selector,
            IRecourseClaims.setParams.selector,
            IRecourseClaims.setPreCheckSigner.selector,
            IRecourseClaims.setBridgeMode.selector,
            IRecourseClaims.sweepLink.selector,
            IRecourseClaims.sweepNative.selector,
            IRecourseClaims.lockConfig.selector,
            IRecourseClaims.setExtraArgs.selector,
            IRecourseClaims.setFeeToken.selector,
            IRecourseClaims.getClaim.selector,
            IRecourseClaims.quoteSend.selector,
            CCIPReceiver.ccipReceive.selector,
            bytes4(0xdeadbeef)
        ];
        vm.deal(owner, 10 ether);
        for (uint256 i; i < sels.length; ++i) {
            vm.prank(owner);
            (bool ok,) = address(claims).call{value: 1}(abi.encodePacked(sels[i], new bytes(1024)));
            assertFalse(ok, "value accepted");
        }
        vm.prank(owner);
        (bool sent,) = address(claims).call{value: 1}("");
        assertFalse(sent, "plain transfer accepted");

        vm.expectEmit(address(claims));
        emit IRecourseClaims.NativeFunded(owner, 2);
        vm.prank(owner);
        claims.fundNative{value: 2}();
        assertEq(address(claims).balance, 2);
        vm.prank(owner);
        vm.expectRevert(IRecourseClaims.AmountZero.selector);
        claims.fundNative();
    }

    // ------------------------------------------------------------ expiry clock and exit

    /// A shop that keeps filing cheap claims cannot hold a platform's exit open: once the exit is
    /// due, new claims are refused, and the exit goes through when the open ones end.
    function test_exit_rollingClaimsCannotBlockExit() public {
        address griefer = shop2;
        vm.prank(platform);
        vault.requestExit();
        (, uint64 exitDelay,) = vault.params();

        bytes32 first = _file(griefer, platform, 1, 0); // during the notice period
        vm.warp(block.timestamp + exitDelay);
        vm.prank(platform);
        vm.expectRevert(abi.encodeWithSelector(IDepositVault.OpenClaims.selector, 1));
        vault.exit();

        vm.prank(griefer);
        vm.expectRevert(IDepositVault.ExitDue.selector);
        claims.fileClaim(keccak256("next in the roll"), platform, _refs(), 1, 0);

        vm.warp(uint256(claims.getClaim(first).filedAt) + _params().claimTimeout + 1);
        claims.expireClaim(first);
        uint256 held = vault.depositOf(platform);
        vm.prank(platform);
        assertEq(vault.exit(), held);
        assertEq(vault.depositOf(platform), 0);
        assertEq(vault.creditOf(platform), held);
        _assertBooks();
    }

    /// A slow pre-check followed by a late contest no longer lets the platform expire the claim in
    /// the same breath: past the pre-check the clock counts from `preCheckedAt`.
    function test_expiry_latePrecheckAndContestKeepTheCourtsTime() public {
        uint256 t0 = block.timestamp;
        uint64 timeout = _params().claimTimeout;
        bytes32 id = _file();
        vm.warp(t0 + timeout - 1);
        _precheck(id, 2, 1);
        vm.warp(t0 + timeout + 1);
        _contest(id); // the platform, inside its window, already past filedAt + claimTimeout
        uint256 expiresAfter = t0 + timeout - 1 + timeout;

        vm.prank(platform);
        vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.NotExpired.selector, expiresAfter));
        claims.expireClaim(id);
        claims.sendToCourt(id);
        vm.warp(t0 + timeout + 2 hours);
        vm.prank(platform);
        vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.NotExpired.selector, expiresAfter));
        claims.expireClaim(id);

        _deliver(id, 7, 1, 1); // the court finds against the platform
        claims.settle(id);
        assertEq(vault.creditOf(shop), NET_LOSS + 21 * USDC + FEE);
        _assertBooks();
    }

    /// The refile path (a refusal, a second case, a second ruling: two full court rounds) ends
    /// well inside the pre-lock timeout, so the losing side cannot expire it first.
    function test_expiry_refilePathFitsThePreLockTimeout() public {
        uint64 timeout = _params().claimTimeout;
        assertEq(timeout, 64_800);
        uint256 t0 = block.timestamp;
        bytes32 id = _file();
        vm.warp(t0 + 60);
        _precheck(id, 2, 1);
        vm.warp(t0 + 120);
        _contest(id);
        vm.warp(t0 + 180);
        claims.sendToCourt(id);

        vm.warp(t0 + 180 + 8_100);
        _deliver(id, 98, 0, 1); // first attempt refused; ignored, the claim stays at court
        assertEq(uint8(_status(id)), uint8(ClaimStatus.AtCourt));

        vm.warp(t0 + 180 + 2 * 8_100 + 20 minutes);
        vm.prank(platform);
        vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.NotExpired.selector, t0 + 60 + timeout));
        claims.expireClaim(id);
        _deliver(id, 99, 1, 2);
        assertEq(uint8(_status(id)), uint8(ClaimStatus.Ruled));
        claims.settle(id);
        assertEq(vault.creditOf(shop), NET_LOSS + 21 * USDC + FEE);
        _assertBooks();
    }

    /// With the locked parameters, a claim at court expires exactly `claimTimeout` after its
    /// pre-check, however long it waited to be pre-checked; a Filed claim still counts from filing.
    function test_expiry_courtClaimsCountFromPreCheck() public {
        IRecourseClaims.Params memory p = _params();
        p.contestWindow = 1_800;
        p.claimTimeout = 64_800;
        vm.prank(owner);
        claims.setParams(p);

        uint256 t0 = block.timestamp;
        bytes32 waiting = _file();
        bytes32 id = _file();
        vm.warp(t0 + 5 hours);
        _precheck(id, 2, 1);
        _contest(id);
        claims.sendToCourt(id);

        vm.warp(t0 + p.claimTimeout + 1);
        claims.expireClaim(waiting); // Filed: from filedAt
        vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.NotExpired.selector, t0 + 5 hours + p.claimTimeout));
        claims.expireClaim(id);

        vm.warp(t0 + 5 hours + p.claimTimeout + 1);
        claims.expireClaim(id);
        assertEq(uint8(_status(id)), uint8(ClaimStatus.Expired));
        assertEq(uint8(_status(waiting)), uint8(ClaimStatus.Expired));
        _assertBooks();
    }
}
