// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {Vm} from "forge-std/Vm.sol";

import {DepositVault} from "../../src/hedera/DepositVault.sol";
import {RecourseClaims} from "../../src/hedera/RecourseClaims.sol";
import {IRecourseClaims, IgnoreReason} from "../../src/hedera/interfaces/IRecourseClaims.sol";
import {BridgeCodec} from "../../src/shared/BridgeCodec.sol";
import {BridgeMode, Claim, ClaimStatus, ClaimToCourt, DecodeStatus} from "../../src/shared/RecourseTypes.sol";
import {HederaUnits} from "../../script/hedera/HederaUnits.sol";
import {ClaimsBase} from "./ClaimsBase.sol";

/// @notice Sending to court and receiving rulings in each bridge mode, and paying CCIP fees in
///         LINK or in HBAR.
contract BridgeModesTest is ClaimsBase {
    /// @dev 0.12345678 HBAR, in tinybars: the unit both the router's fee and `msg.value` use
    ///      inside the Hedera EVM.
    uint256 internal constant NATIVE_FEE = 12_345_678;
    uint256 internal constant ONE_HBAR = 100_000_000;

    function setUp() public {
        _setUpClaims();
    }

    function _contested(uint8 gap, uint8 answer) internal returns (bytes32 id) {
        id = _file();
        _precheck(id, gap, answer);
        _contest(id);
    }

    function _setMode(BridgeMode mode) internal {
        vm.prank(owner);
        claims.setBridgeMode(mode, relayer);
    }

    function _expectedMessage(bytes32 id, address token, bytes memory args)
        internal
        view
        returns (Client.EVM2AnyMessage memory)
    {
        Claim memory c = claims.getClaim(id);
        bytes memory data = BridgeCodec.encodeClaimToCourt(
            ClaimToCourt({
                version: 1,
                claimId: id,
                platform: c.platform,
                shop: c.shop,
                gap: c.gap,
                answer: c.answer,
                refs: c.refs,
                packHash: c.packHash,
                basketUsdc: c.basketUsdc,
                netLossUsdc: c.netLossUsdc,
                filedAt: c.filedAt
            })
        );
        return Client.EVM2AnyMessage({
            receiver: abi.encode(casePeer),
            data: data,
            tokenAmounts: new Client.EVMTokenAmount[](0),
            feeToken: token,
            extraArgs: args
        });
    }

    function _record(bytes32 id, uint256 disputeId, uint8 ruling, uint8 attempts) internal {
        vm.prank(relayer);
        claims.recordRuling(id, disputeId, ruling, attempts);
    }

    // ------------------------------------------------------------ mode Both: send

    function test_both_sendCarriesExactPayload() public {
        bytes32 id = _contested(2, 1);
        Client.EVM2AnyMessage memory expected = _expectedMessage(id, address(linkToken), BridgeCodec.extraArgsFor(300_000));
        vm.expectCall(address(router), abi.encodeCall(IRouterClient.ccipSend, (ARB_SEL, expected)));
        vm.prank(stranger);
        bytes32 mid = claims.sendToCourt(id);

        Claim memory c = claims.getClaim(id);
        assertTrue(mid != bytes32(0));
        assertEq(uint8(c.status), uint8(ClaimStatus.AtCourt));
        assertEq(c.sendCount, 1);
        assertEq(c.lastSendAt, T0);
        assertEq(c.lastMessageId, mid);

        (DecodeStatus st, ClaimToCourt memory m) = BridgeCodec.tryDecodeClaimToCourt(expected.data);
        assertEq(uint8(st), uint8(DecodeStatus.Ok));
        assertEq(expected.data.length, BridgeCodec.CLAIM_TO_COURT_LEN);
        assertEq(m.claimId, id);
        assertEq(m.platform, platform);
        assertEq(m.shop, shop);
        assertEq(m.gap, 2);
        assertEq(m.answer, 1);
        assertEq(m.packHash, c.packHash);
        assertEq(m.basketUsdc, BASKET);
        assertEq(m.netLossUsdc, NET_LOSS);
        assertEq(m.filedAt, T0);
        assertEq(m.refs.hashes[3], c.refs.hashes[3]);
    }

    function test_both_sendEmitsReturnedMessageId() public {
        bytes32 id = _contested(1, 1);
        vm.recordLogs();
        bytes32 mid = claims.sendToCourt(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(claims) && logs[i].topics[0] == IRecourseClaims.SentToCourt.selector) {
                assertEq(logs[i].topics[1], id);
                assertEq(logs[i].topics[2], mid);
                found = true;
            }
        }
        assertTrue(found, "SentToCourt not emitted");
    }

    function test_both_noPeerMeansNoSend() public {
        DepositVault v = new DepositVault(USDC_ADDR, pool, owner);
        RecourseClaims c = new RecourseClaims(address(router), address(linkToken), address(v), ARB_SEL, owner);
        vm.startPrank(owner);
        v.bindClaims(address(c));
        c.setPreCheckSigner(signer);
        vm.stopPrank();
        v.associateUsdc(false);
        vm.prank(shop);
        usdc.approve(address(v), FEE);
        vm.prank(shop);
        bytes32 id = c.fileClaim(bytes32("n"), platform, _refs(), BASKET, NET_LOSS);
        vm.prank(signer);
        c.recordPreCheck(id, 2, 2, bytes32("p"));
        vm.prank(shop);
        c.contest(id);
        assertEq(c.quoteSend(id), 0);
        vm.expectRevert(IRecourseClaims.PeerNotSet.selector);
        c.sendToCourt(id);
        assertEq(uint8(c.getClaim(id).status), uint8(ClaimStatus.Contested));
    }

    // ------------------------------------------------------------ fees in LINK

    function test_linkFee_approvesAndPaysExactly() public {
        router.setFee(0.2 ether);
        bytes32 id = _contested(1, 1);
        assertEq(claims.quoteSend(id), 0.2 ether);
        uint256 before = linkToken.balanceOf(address(claims));
        claims.sendToCourt(id);
        assertEq(linkToken.balanceOf(address(claims)), before - 0.2 ether);
        assertEq(linkToken.balanceOf(address(router)), 0.2 ether);
        assertEq(linkToken.allowance(address(claims), address(router)), 0);
    }

    function test_linkFee_shortReverts() public {
        router.setFee(11 ether);
        bytes32 id = _contested(1, 1);
        vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.LinkShort.selector, 10 ether, 11 ether));
        claims.sendToCourt(id);
        assertEq(uint8(_status(id)), uint8(ClaimStatus.Contested));
        // Anyone can top up, then the send goes through.
        sim.requestLinkFromFaucet(address(claims), 1 ether);
        claims.sendToCourt(id);
        assertEq(linkToken.balanceOf(address(claims)), 0);
    }

    // ------------------------------------------------------------ fees in HBAR

    function test_nativeFee_paysTinybarsFromOwnBalance() public {
        router.setFee(NATIVE_FEE);
        vm.prank(owner);
        claims.setFeeToken(address(0));
        vm.deal(stranger, ONE_HBAR);
        vm.prank(stranger);
        claims.fundNative{value: ONE_HBAR}();

        bytes32 id = _contested(1, 1);
        assertEq(claims.quoteSend(id), NATIVE_FEE);
        Client.EVM2AnyMessage memory expected = _expectedMessage(id, address(0), BridgeCodec.extraArgsFor(300_000));
        vm.expectCall(address(router), NATIVE_FEE, abi.encodeCall(IRouterClient.ccipSend, (ARB_SEL, expected)));
        uint256 linkBefore = linkToken.balanceOf(address(claims));
        claims.sendToCourt(id);

        assertEq(address(claims).balance, ONE_HBAR - NATIVE_FEE);
        assertEq(address(claims).balance, 87_654_322);
        assertEq(address(router).balance, NATIVE_FEE);
        assertEq(linkToken.balanceOf(address(claims)), linkBefore, "no LINK spent in native mode");
    }

    function test_nativeFee_shortReverts() public {
        router.setFee(NATIVE_FEE);
        vm.prank(owner);
        claims.setFeeToken(address(0));
        vm.deal(stranger, NATIVE_FEE - 1);
        vm.prank(stranger);
        claims.fundNative{value: NATIVE_FEE - 1}();
        bytes32 id = _contested(1, 1);
        vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.NativeShort.selector, NATIVE_FEE - 1, NATIVE_FEE));
        claims.sendToCourt(id);
        assertEq(uint8(_status(id)), uint8(ClaimStatus.Contested));
    }

    function test_nativeFee_rpcScaling() public pure {
        // Inside the EVM: tinybars (8 decimals). Over JSON-RPC: weibars (18 decimals).
        assertEq(HederaUnits.toWeibar(NATIVE_FEE), 123_456_780_000_000_000);
        assertEq(HederaUnits.toWeibar(ONE_HBAR), 1e18);
        assertEq(HederaUnits.toTinybar(1e18), ONE_HBAR);
        assertEq(HederaUnits.toTinybar(123_456_780_000_000_000), NATIVE_FEE);
        // Sub-tinybar weibar is not representable; it rounds down.
        assertEq(HederaUnits.toTinybar(1e10 - 1), 0);
        assertTrue(HederaUnits.isWholeTinybars(1e10));
        assertFalse(HederaUnits.isWholeTinybars(1e10 + 1));
    }

    function test_feeTokenSwitch_keepsPayloadBytes() public {
        bytes32 id = _contested(1, 1);
        Client.EVM2AnyMessage memory viaLink = _expectedMessage(id, address(linkToken), BridgeCodec.extraArgsFor(300_000));
        claims.sendToCourt(id);

        router.setFee(NATIVE_FEE);
        vm.startPrank(owner);
        claims.setFeeToken(address(0));
        claims.setExtraArgs(BridgeCodec.extraArgsFor(350_000));
        vm.stopPrank();
        vm.deal(address(this), ONE_HBAR);
        claims.fundNative{value: ONE_HBAR}();

        vm.warp(T0 + 30 minutes);
        Client.EVM2AnyMessage memory viaNative = _expectedMessage(id, address(0), BridgeCodec.extraArgsFor(350_000));
        assertEq(keccak256(viaNative.data), keccak256(viaLink.data), "payload bytes changed");
        vm.expectCall(address(router), NATIVE_FEE, abi.encodeCall(IRouterClient.ccipSend, (ARB_SEL, viaNative)));
        claims.resend(id);
        assertEq(claims.getClaim(id).sendCount, 2);
    }

    // ------------------------------------------------------------ resend

    function test_resend_gapAndCap() public {
        bytes32 id = _contested(1, 1);
        Client.EVM2AnyMessage memory expected = _expectedMessage(id, address(linkToken), BridgeCodec.extraArgsFor(300_000));
        bytes32 first = claims.sendToCourt(id);

        vm.warp(T0 + 30 minutes - 1);
        vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.ResendTooSoon.selector, T0 + 30 minutes));
        claims.resend(id);

        bytes32 last = first;
        for (uint256 n = 2; n <= 5; ++n) {
            vm.warp(T0 + (n - 1) * 30 minutes);
            vm.expectCall(address(router), abi.encodeCall(IRouterClient.ccipSend, (ARB_SEL, expected)));
            vm.prank(stranger);
            bytes32 mid = claims.resend(id);
            assertTrue(mid != last, "each send gets a new message id");
            last = mid;
            Claim memory c = claims.getClaim(id);
            assertEq(c.sendCount, n);
            assertEq(c.lastSendAt, T0 + (n - 1) * 30 minutes);
            assertEq(c.lastMessageId, mid);
        }
        vm.warp(T0 + 5 * 30 minutes);
        vm.expectRevert(IRecourseClaims.MaxSendsReached.selector);
        claims.resend(id);
    }

    // ------------------------------------------------------------ mode Both: rulings

    function test_both_recordRulingRefused() public {
        bytes32 id = _atCourt(1, 1);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.WrongMode.selector, BridgeMode.Both));
        claims.recordRuling(id, 1, 1, 1);
    }

    // ------------------------------------------------------------ mode OutOnly

    function test_outOnly_sendsAndRelayerRecords() public {
        _setMode(BridgeMode.OutOnly);
        bytes32 id = _contested(1, 1);
        vm.expectCall(address(router), abi.encodeWithSelector(IRouterClient.ccipSend.selector));
        bytes32 mid = claims.sendToCourt(id);
        assertTrue(mid != bytes32(0));
        vm.warp(T0 + 30 minutes);
        claims.resend(id);

        // CCIP rulings are ignored in this mode.
        Client.Any2EVMMessage memory m = _rulingMsg(_rulingData(id, 1, 2, 1), casePeer, ARB_SEL);
        vm.expectEmit(address(claims));
        emit IRecourseClaims.RulingIgnored(id, IgnoreReason.WRONG_MODE, m.messageId);
        (bool ok,) = _route(m);
        assertTrue(ok);

        vm.prank(stranger);
        vm.expectRevert(IRecourseClaims.NotRelayer.selector);
        claims.recordRuling(id, 9, 1, 1);

        vm.expectEmit(address(claims));
        emit IRecourseClaims.RulingReceived(id, 9, 1, 1, bytes32(0));
        _record(id, 9, 1, 1);
        Claim memory c = claims.getClaim(id);
        assertEq(uint8(c.status), uint8(ClaimStatus.Ruled));
        assertEq(c.disputeId, 9);
        claims.settle(id);
        assertEq(uint8(_status(id)), uint8(ClaimStatus.Settled));
        _assertBooks();
    }

    function test_relayed_ignoreReasons() public {
        _setMode(BridgeMode.OutOnly);
        bytes32 id = _atCourt(1, 1);

        uint8[4] memory badRulings = [4, 1, 1, 255];
        uint8[4] memory badAttempts = [1, 0, 3, 1];
        for (uint256 i; i < 4; ++i) {
            vm.expectEmit(address(claims));
            emit IRecourseClaims.RulingIgnored(id, IgnoreReason.BAD_PAYLOAD, bytes32(0));
            _record(id, 1, badRulings[i], badAttempts[i]);
        }
        vm.expectEmit(address(claims));
        emit IRecourseClaims.RulingIgnored(bytes32("nope"), IgnoreReason.UNKNOWN_CLAIM, bytes32(0));
        _record(bytes32("nope"), 1, 1, 1);
        vm.expectEmit(address(claims));
        emit IRecourseClaims.RulingIgnored(id, IgnoreReason.REFUSED_FIRST_ATTEMPT, bytes32(0));
        _record(id, 1, 0, 1);
        assertEq(uint8(_status(id)), uint8(ClaimStatus.AtCourt));

        _record(id, 2, 0, 2);
        assertEq(uint8(_status(id)), uint8(ClaimStatus.Ruled));
        vm.expectEmit(address(claims));
        emit IRecourseClaims.RulingIgnored(id, IgnoreReason.NOT_AT_COURT, bytes32(0));
        _record(id, 3, 1, 1);
        assertEq(claims.getClaim(id).disputeId, 2);
    }

    // ------------------------------------------------------------ mode None

    function test_none_noSendRelayerRecords() public {
        _setMode(BridgeMode.None);
        router.setFee(1 ether);
        bytes32 id = _contested(1, 1);
        assertEq(claims.quoteSend(id), 0);
        uint256 linkBefore = linkToken.balanceOf(address(claims));
        vm.expectCall(address(router), abi.encodeWithSelector(IRouterClient.ccipSend.selector), 0);
        vm.expectEmit(address(claims));
        emit IRecourseClaims.SentToCourt(id, bytes32(0));
        bytes32 mid = claims.sendToCourt(id);
        assertEq(mid, bytes32(0));
        Claim memory c = claims.getClaim(id);
        assertEq(uint8(c.status), uint8(ClaimStatus.AtCourt));
        assertEq(c.sendCount, 0);
        assertEq(c.lastSendAt, T0);
        assertEq(c.lastMessageId, bytes32(0));
        assertEq(linkToken.balanceOf(address(claims)), linkBefore);

        vm.warp(T0 + 1 days);
        vm.expectRevert(abi.encodeWithSelector(IRecourseClaims.WrongMode.selector, BridgeMode.None));
        claims.resend(id);

        _record(id, 5, 2, 1);
        claims.settle(id);
        assertEq(uint8(_status(id)), uint8(ClaimStatus.Settled));
        _assertBooks();
    }

    // ------------------------------------------------------------ the same path in every mode

    function test_everyMode_fullPathAndExpiry() public {
        BridgeMode[3] memory modes = [BridgeMode.Both, BridgeMode.OutOnly, BridgeMode.None];
        for (uint256 i; i < 3; ++i) {
            _setMode(modes[i]);
            bytes32 id = _contested(1, 1);
            bytes32 stuck = _contested(2, 2);
            claims.sendToCourt(id);
            claims.sendToCourt(stuck);
            if (modes[i] == BridgeMode.Both) _deliver(id, 1, 1, 1);
            else _record(id, 1, 1, 1);
            claims.settle(id);
            assertEq(uint8(_status(id)), uint8(ClaimStatus.Settled));

            vm.warp(block.timestamp + 4 hours + 1);
            claims.expireClaim(stuck);
            assertEq(uint8(_status(stuck)), uint8(ClaimStatus.Expired));
            _assertBooks();
        }
    }
}
