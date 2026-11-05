// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {CCIPLocalRouter} from "@chainlink/local/src/ccip/CCIPLocalRouter.sol";
import {CCIPLocalSimulator} from "@chainlink/local/src/ccip/CCIPLocalSimulator.sol";
import {LinkToken} from "@chainlink/local/src/shared/LinkToken.sol";

import {DepositVault} from "../../src/hedera/DepositVault.sol";
import {RecourseClaims} from "../../src/hedera/RecourseClaims.sol";
import {IRecourseClaims} from "../../src/hedera/interfaces/IRecourseClaims.sol";
import {BridgeCodec} from "../../src/shared/BridgeCodec.sol";
import {RecourseAddresses} from "../../src/shared/RecourseAddresses.sol";
import {BridgeMode, Claim, ClaimStatus, RecordRefs, RulingBack} from "../../src/shared/RecourseTypes.sol";
import {HederaBase} from "./HederaBase.sol";

/// @notice Full Hedera stack for claim tests: mocks, the chainlink-local router and LINK, a bound
///         vault and claims contract, a funded platform in good standing and two funded shops.
///         The court-side peer is a plain address, so the local router accepts sends without
///         calling anything; rulings are delivered by routing a message from the router.
abstract contract ClaimsBase is HederaBase {
    uint64 internal constant ARB_SEL = RecourseAddresses.ARBITRUM_SELECTOR;
    uint256 internal constant FEE = 3_000_000;
    uint256 internal constant RECEIVE_GAS = 400_000;
    uint256 internal constant DEPOSIT = 5_000 * USDC;
    uint256 internal constant BASKET = 120 * USDC;
    uint256 internal constant NET_LOSS = 100 * USDC;

    CCIPLocalSimulator internal sim;
    CCIPLocalRouter internal router;
    LinkToken internal linkToken;
    DepositVault internal vault;
    RecourseClaims internal claims;

    address internal signer = makeAddr("precheckSigner");
    address internal relayer = makeAddr("rulingRelayer");
    address internal casePeer = makeAddr("recourseCase");
    uint256 internal nonceCounter;
    uint256 internal messageCounter;

    function _setUpClaims() internal {
        _setUpHedera();
        sim = new CCIPLocalSimulator();
        (, IRouterClient r,,, LinkToken l,,) = sim.configuration();
        router = CCIPLocalRouter(address(r));
        linkToken = l;

        vault = new DepositVault(USDC_ADDR, pool, owner);
        claims = new RecourseClaims(address(r), address(l), address(vault), ARB_SEL, owner);
        vm.startPrank(owner);
        vault.bindClaims(address(claims));
        claims.setPreCheckSigner(signer);
        claims.setBridgeMode(BridgeMode.Both, relayer);
        claims.setPeer(casePeer);
        vm.stopPrank();
        vault.associateUsdc(false);
        usdc.mockAssociate(pool);
        sim.requestLinkFromFaucet(address(claims), 10 ether);

        _fund(shop, 1_000 * USDC);
        _fund(shop2, 1_000 * USDC);
        _fund(platform, 10_000 * USDC);
        usdc.mockAssociate(platform2);
        vm.prank(shop);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(shop2);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(platform);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(platform);
        vault.postDeposit(platform, DEPOSIT);
        vm.prank(owner);
        vault.setRequired(platform, DEPOSIT);
    }

    // ------------------------------------------------------------ builders

    function _refs() internal pure returns (RecordRefs memory r) {
        r.topicNum = 4_242_424;
        for (uint256 i; i < 6; ++i) {
            r.seq[i] = uint64(100 + i);
            r.hashes[i] = keccak256(abi.encode("record", i));
        }
    }

    function _nextNonce() internal returns (bytes32) {
        return keccak256(abi.encode("nonce", ++nonceCounter));
    }

    function _file(address s, address p, uint256 basket, uint256 netLoss) internal returns (bytes32 id) {
        bytes32 nonce = _nextNonce();
        vm.prank(s);
        id = claims.fileClaim(nonce, p, _refs(), basket, netLoss);
    }

    function _file() internal returns (bytes32) {
        return _file(shop, platform, BASKET, NET_LOSS);
    }

    function _precheck(bytes32 id, uint8 gap, uint8 answer) internal {
        vm.prank(signer);
        claims.recordPreCheck(id, gap, answer, keccak256(abi.encode("pack", id)));
    }

    function _contest(bytes32 id) internal {
        Claim memory c = claims.getClaim(id);
        vm.prank(c.answer == 1 ? c.platform : c.shop);
        claims.contest(id);
    }

    function _atCourt(uint8 gap, uint8 answer) internal returns (bytes32 id) {
        id = _file();
        _precheck(id, gap, answer);
        _contest(id);
        claims.sendToCourt(id);
    }

    function _rulingMsg(bytes memory data, address sender, uint64 source)
        internal
        returns (Client.Any2EVMMessage memory m)
    {
        m.messageId = keccak256(abi.encode("message", ++messageCounter));
        m.sourceChainSelector = source;
        m.sender = abi.encode(sender);
        m.data = data;
        m.destTokenAmounts = new Client.EVMTokenAmount[](0);
    }

    function _rulingData(bytes32 id, uint256 disputeId, uint8 ruling, uint8 attempts)
        internal
        pure
        returns (bytes memory)
    {
        return BridgeCodec.encodeRulingBack(
            RulingBack({version: 1, claimId: id, disputeId: disputeId, ruling: ruling, attempts: attempts})
        );
    }

    /// @dev Delivers a message the way the OffRamp does: a call from the router with a gas limit.
    function _route(Client.Any2EVMMessage memory m) internal returns (bool ok, uint256 gasUsed) {
        (ok,, gasUsed) = router.routeMessage(m, 5_000, RECEIVE_GAS, address(claims));
    }

    function _deliver(bytes32 id, uint256 disputeId, uint8 ruling, uint8 attempts)
        internal
        returns (Client.Any2EVMMessage memory m)
    {
        m = _rulingMsg(_rulingData(id, disputeId, ruling, attempts), casePeer, ARB_SEL);
        (bool ok,) = _route(m);
        assertTrue(ok, "receive reverted");
    }

    function _ruled(uint8 gap, uint8 answer, uint8 ruling, uint8 attempts) internal returns (bytes32 id) {
        id = _atCourt(gap, answer);
        _deliver(id, 77, ruling, attempts);
        assertEq(uint8(_status(id)), uint8(ClaimStatus.Ruled), "not ruled");
    }

    function _status(bytes32 id) internal view returns (ClaimStatus) {
        return claims.getClaim(id).status;
    }

    function _params() internal view returns (IRecourseClaims.Params memory) {
        return claims.params();
    }

    function _assertBooks() internal view {
        (uint256 d, uint256 e, uint256 c) = vault.totals();
        assertEq(usdc.balanceOf(address(vault)), d + e + c, "balance == deposits + escrow + credits");
        assertEq(usdc.balanceOf(address(claims)), 0, "claims holds no USDC");
    }
}
