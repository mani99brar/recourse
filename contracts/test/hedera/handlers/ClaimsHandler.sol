// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {CCIPLocalRouter} from "@chainlink/local/src/ccip/CCIPLocalRouter.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

import {DepositVault} from "../../../src/hedera/DepositVault.sol";
import {RecourseClaims} from "../../../src/hedera/RecourseClaims.sol";
import {Claim, ClaimStatus, RecordRefs, RulingBack} from "../../../src/shared/RecourseTypes.sol";

/// @notice Drives the whole Hedera money path through RecourseClaims: filing, pre-checks,
///         contests, closes, sends, resends, rulings (valid and malformed) through the router,
///         settles, expiries, top-ups and withdrawals. Every call is made only when its
///         preconditions hold, so any revert is a finding. It records each claim's last status
///         and flags any move outside the state table.
contract ClaimsHandler is CommonBase, StdCheats, StdUtils {
    RecourseClaims public immutable claims;
    DepositVault public immutable vault;
    CCIPLocalRouter public immutable router;
    address public immutable signer;
    address public immutable peer;
    uint64 public immutable arbSelector;

    address[] public shops;
    address[] public platforms;
    address[] public accounts; // every account that can hold credit

    bytes32[] public claimIds;
    mapping(bytes32 => ClaimStatus) public lastStatus;

    mapping(ClaimStatus => uint256) public reached; // claims that entered each status

    bool public illegalTransition;
    bool public receiveReverted;
    uint256 public currentTime;
    uint256 internal nonce;
    uint256 internal messageNonce;

    constructor(
        RecourseClaims claims_,
        DepositVault vault_,
        CCIPLocalRouter router_,
        address signer_,
        address peer_,
        uint64 arbSelector_,
        address[] memory shops_,
        address[] memory platforms_,
        address pool_
    ) {
        claims = claims_;
        vault = vault_;
        router = router_;
        signer = signer_;
        peer = peer_;
        arbSelector = arbSelector_;
        for (uint256 i; i < shops_.length; ++i) {
            shops.push(shops_[i]);
            accounts.push(shops_[i]);
        }
        for (uint256 i; i < platforms_.length; ++i) {
            platforms.push(platforms_[i]);
            accounts.push(platforms_[i]);
        }
        accounts.push(pool_);
        currentTime = block.timestamp;
    }

    modifier atTime() {
        vm.warp(currentTime);
        _;
    }

    function claimCount() external view returns (uint256) {
        return claimIds.length;
    }

    function platformCount() external view returns (uint256) {
        return platforms.length;
    }

    function accountCount() external view returns (uint256) {
        return accounts.length;
    }

    // ------------------------------------------------------------ actions

    function file(uint256 shopSeed, uint256 platformSeed, uint256 basket, uint256 lossBps) external atTime {
        address s = shops[shopSeed % shops.length];
        address p = platforms[platformSeed % platforms.length];
        basket = bound(basket, 1, 2_000e6);
        uint256 netLoss = basket * bound(lossBps, 0, 10_000) / 10_000;
        RecordRefs memory refs;
        refs.topicNum = 7;
        refs.hashes[3] = keccak256(abi.encode("ordered", nonce));
        vm.prank(s);
        bytes32 id = claims.fileClaim(keccak256(abi.encode("nonce", ++nonce)), p, refs, basket, netLoss);
        claimIds.push(id);
        _moved(id, ClaimStatus.None);
    }

    function precheck(uint256 idSeed, uint256 gapSeed, uint256 answerSeed) external atTime {
        (bytes32 id, Claim memory c, bool ok) = _pickIn(idSeed, _bit(ClaimStatus.Filed));
        if (!ok || c.status != ClaimStatus.Filed) return;
        uint8[5] memory gaps = [uint8(0), 1, 2, 3, 255];
        uint8 gap = gaps[gapSeed % 5];
        uint8 answer = uint8(answerSeed % 4);
        if (gap == 255 && answer == 3) answer = 0;
        vm.prank(signer);
        claims.recordPreCheck(id, gap, answer, keccak256(abi.encode("pack", id)));
        _moved(id, c.status);
    }

    function contest(uint256 idSeed) external atTime {
        (bytes32 id, Claim memory c, bool ok) = _pickOpenWindow(idSeed);
        if (!ok) return;
        vm.prank(c.answer == 1 ? c.platform : c.shop);
        claims.contest(id);
        _moved(id, c.status);
    }

    function close(uint256 idSeed) external atTime {
        (bytes32 id, Claim memory c, bool ok) = _pickIn(idSeed, _bit(ClaimStatus.PreChecked));
        if (!ok || c.status != ClaimStatus.PreChecked) return;
        if (block.timestamp <= uint256(c.preCheckedAt) + claims.params().contestWindow) return;
        claims.closeUncontested(id);
        _moved(id, c.status);
    }

    function send(uint256 idSeed) external atTime {
        (bytes32 id, Claim memory c, bool ok) = _pickIn(idSeed, _bit(ClaimStatus.Contested));
        if (!ok || c.status != ClaimStatus.Contested) return;
        claims.sendToCourt(id);
        _moved(id, c.status);
    }

    function resend(uint256 idSeed) external atTime {
        (bytes32 id, Claim memory c, bool ok) = _pickIn(idSeed, _bit(ClaimStatus.AtCourt));
        if (!ok || c.status != ClaimStatus.AtCourt) return;
        if (block.timestamp < uint256(c.lastSendAt) + claims.params().resendGap) return;
        if (c.sendCount >= claims.params().maxSends) return;
        claims.resend(id);
        _moved(id, c.status);
    }

    /// @dev Any status may receive a message; malformed ones (bad ruling, bad attempts, wrong
    ///      sender) must be ignored without reverting and without moving the claim.
    function deliver(uint256 idSeed, uint8 ruling, uint8 attempts, uint8 senderSeed) external atTime {
        (bytes32 id, Claim memory c, bool ok) = _pickIn(idSeed, idSeed % 4 == 0 ? ANY : _bit(ClaimStatus.AtCourt));
        if (!ok) return;
        Client.Any2EVMMessage memory m;
        m.messageId = keccak256(abi.encode("message", ++messageNonce));
        m.sourceChainSelector = arbSelector;
        m.sender = abi.encode(senderSeed % 8 == 0 ? address(0xBAD) : peer); // mostly the real peer
        // Mostly well-formed rulings; one call in four carries any value up to the first invalid one.
        bool raw = senderSeed % 4 == 1;
        uint8 r = raw ? ruling % 5 : ruling % 4;
        uint8 a = raw ? attempts % 4 : 1 + attempts % 2;
        m.data = abi.encode(RulingBack({version: 1, claimId: id, disputeId: messageNonce, ruling: r, attempts: a}));
        m.destTokenAmounts = new Client.EVMTokenAmount[](0);
        (bool success,,) = router.routeMessage(m, 5_000, 150_000, address(claims));
        if (!success) receiveReverted = true;
        _moved(id, c.status);
    }

    function settle(uint256 idSeed) external atTime {
        (bytes32 id, Claim memory c, bool ok) = _pickIn(idSeed, _bit(ClaimStatus.Ruled));
        if (!ok || c.status != ClaimStatus.Ruled) return;
        claims.settle(id);
        _moved(id, c.status);
    }

    function expire(uint256 idSeed) external atTime {
        (bytes32 id, Claim memory c, bool ok) =
            _pickIn(idSeed, _bit(ClaimStatus.Filed) | _bit(ClaimStatus.Contested) | _bit(ClaimStatus.AtCourt));
        if (!ok) return;
        ClaimStatus s = c.status;
        if (s != ClaimStatus.Filed && s != ClaimStatus.Contested && s != ClaimStatus.AtCourt) return;
        if (block.timestamp <= uint256(c.filedAt) + claims.params().claimTimeout) return;
        claims.expireClaim(id);
        _moved(id, s);
    }

    function topUp(uint256 platformSeed, uint256 amount) external atTime {
        address p = platforms[platformSeed % platforms.length];
        amount = bound(amount, 1, 1_000e6);
        vm.prank(p);
        vault.postDeposit(p, amount);
    }

    function withdraw(uint256 accountSeed) external atTime {
        address a = accounts[accountSeed % accounts.length];
        if (vault.creditOf(a) == 0) return;
        vm.prank(a);
        vault.withdrawCredit();
    }

    function warp(uint256 secs) external {
        // Mostly short steps, so contest windows can be met; now and then a long one, so claims expire.
        currentTime += secs % 8 == 0 ? bound(secs, 1 hours, 5 hours) : bound(secs, 1, 20 minutes);
        vm.warp(currentTime);
    }

    // ------------------------------------------------------------ bookkeeping

    uint256 internal constant ANY = type(uint256).max;

    function _bit(ClaimStatus s) internal pure returns (uint256) {
        return 1 << uint8(s);
    }

    /// @dev The first pre-checked claim from a seeded start whose contest window is still open.
    function _pickOpenWindow(uint256 seed) internal view returns (bytes32 id, Claim memory c, bool ok) {
        uint256 n = claimIds.length;
        uint256 start = n == 0 ? 0 : seed % n;
        uint256 window = claims.params().contestWindow;
        for (uint256 k; k < n; ++k) {
            id = claimIds[(start + k) % n];
            c = claims.getClaim(id);
            if (c.status == ClaimStatus.PreChecked && block.timestamp <= uint256(c.preCheckedAt) + window) {
                return (id, c, true);
            }
        }
    }

    /// @dev The first claim from a seeded start whose status is in `mask`, so actions mostly hit
    ///      claims they can move.
    function _pickIn(uint256 seed, uint256 mask) internal view returns (bytes32 id, Claim memory c, bool ok) {
        uint256 n = claimIds.length;
        uint256 start = n == 0 ? 0 : seed % n;
        for (uint256 k; k < n; ++k) {
            id = claimIds[(start + k) % n];
            c = claims.getClaim(id);
            if (mask & _bit(c.status) != 0) return (id, c, true);
        }
    }

    /// @dev Records the claim's new status and flags any move the state table does not allow.
    function _moved(bytes32 id, ClaimStatus from) internal {
        ClaimStatus to = claims.getClaim(id).status;
        if (from != lastStatus[id] || (to != from && !_allowed(from, to))) illegalTransition = true;
        if (to != from) ++reached[to];
        lastStatus[id] = to;
    }

    function _allowed(ClaimStatus from, ClaimStatus to) internal pure returns (bool) {
        if (from == ClaimStatus.None) return to == ClaimStatus.Filed;
        if (from == ClaimStatus.Filed) return to == ClaimStatus.PreChecked || to == ClaimStatus.Expired;
        if (from == ClaimStatus.PreChecked) return to == ClaimStatus.Contested || to == ClaimStatus.Closed;
        if (from == ClaimStatus.Contested) return to == ClaimStatus.AtCourt || to == ClaimStatus.Expired;
        if (from == ClaimStatus.AtCourt) return to == ClaimStatus.Ruled || to == ClaimStatus.Expired;
        if (from == ClaimStatus.Ruled) return to == ClaimStatus.Settled;
        return false; // Settled, Closed and Expired are final
    }
}
