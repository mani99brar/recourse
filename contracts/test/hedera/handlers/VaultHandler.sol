// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

import {DepositVault} from "../../../src/hedera/DepositVault.sol";
import {IDepositVault} from "../../../src/hedera/interfaces/IDepositVault.sol";
import {MockHtsUsdc} from "../mocks/MockHtsUsdc.sol";

/// @notice Drives DepositVault directly, acting as its bound claims contract, and keeps ghost
///         books the invariant test compares against the vault's own.
contract VaultHandler is CommonBase, StdCheats, StdUtils {
    DepositVault public immutable vault;
    MockHtsUsdc public immutable usdc;
    address public immutable owner;
    address public immutable pool;

    address[] public platforms;
    address[] public shops;
    address[] public accounts; // every account that can hold credit

    bytes32[] public claimIds;
    mapping(bytes32 => address) public claimPlatform;
    mapping(bytes32 => address) public claimShop;
    mapping(bytes32 => bool) public ghostOpen;
    mapping(bytes32 => uint256) public appliedCount;
    mapping(address => uint256) public ghostOpenClaims;
    mapping(bytes32 => uint256) public ghostMax; // the stated maximum payout
    mapping(bytes32 => uint256) public ghostOwn; // the reservation made at filing

    bool public creditFellOutsideWithdraw;
    uint256 public calls;
    uint256 public currentTime;

    constructor(DepositVault vault_, MockHtsUsdc usdc_, address owner_, address pool_) {
        vault = vault_;
        usdc = usdc_;
        owner = owner_;
        pool = pool_;
        for (uint256 i; i < 3; ++i) {
            address p = address(uint160(0x10000 + i));
            address s = address(uint160(0x20000 + i));
            platforms.push(p);
            shops.push(s);
            accounts.push(p);
            accounts.push(s);
            usdc.mockAssociate(p);
            usdc.mockAssociate(s);
            usdc.mint(p, 1e15);
            usdc.mint(s, 1e15);
            vm.prank(p);
            usdc.approve(address(vault_), type(uint256).max);
            vm.prank(s);
            usdc.approve(address(vault_), type(uint256).max);
        }
        accounts.push(pool_);
        currentTime = block.timestamp;
    }

    function accountCount() external view returns (uint256) {
        return accounts.length;
    }

    function platformCount() external view returns (uint256) {
        return platforms.length;
    }

    function shopCount() external view returns (uint256) {
        return shops.length;
    }

    function claimCount() external view returns (uint256) {
        return claimIds.length;
    }

    // ------------------------------------------------------------ actions

    function deposit(uint256 pSeed, uint256 fromSeed, uint256 amount) external creditsOnlyRise {
        address p = platforms[pSeed % platforms.length];
        address from = fromSeed % 2 == 0 ? p : shops[fromSeed % shops.length];
        amount = bound(amount, 1, 5_000e6);
        vm.prank(from);
        vault.postDeposit(p, amount);
    }

    function setRequired(uint256 pSeed, uint256 amount) external creditsOnlyRise {
        address p = platforms[pSeed % platforms.length];
        amount = amount % 4 == 0 ? 0 : bound(amount, 1, 10_000e6);
        vm.prank(owner);
        vault.setRequired(p, amount);
    }

    /// @dev Every third escrow reserves nothing (`escrowFee`); the others reserve a fuzzed maximum payout.
    function escrow(uint256 sSeed, uint256 pSeed, uint256 amount, uint256 maxPayout) external creditsOnlyRise {
        address s = shops[sSeed % shops.length];
        address p = platforms[pSeed % platforms.length];
        uint256 exitAt = vault.exitRequestedAt(p);
        (, uint64 delay,) = vault.params();
        if (exitAt != 0 && block.timestamp >= exitAt + delay) return; // refused once the exit is due
        amount = bound(amount, 1, 10e6);
        bytes32 id = keccak256(abi.encode("claim", claimIds.length));
        if (maxPayout % 3 == 0) {
            vault.escrowFee(s, p, amount, id);
            maxPayout = 0;
        } else {
            maxPayout = bound(maxPayout, 0, 20_000e6);
            _reserve(s, p, amount, id, maxPayout);
        }
        ghostMax[id] = maxPayout;
        claimIds.push(id);
        claimPlatform[id] = p;
        claimShop[id] = s;
        ghostOpen[id] = true;
        ghostOpenClaims[p] += 1;
    }

    function _reserve(address s, address p, uint256 amount, bytes32 id, uint256 maxPayout) internal {
        uint256 dep = vault.depositOf(p);
        uint256 exposure = vault.exposureOf(p);
        uint256 free = dep > exposure ? dep - exposure : 0;
        uint256 got = vault.escrowAndReserve(s, p, amount, id, maxPayout);
        require(got == (maxPayout < free ? maxPayout : free), "reserved more or less than the uncommitted deposit");
        ghostOwn[id] = got;
    }

    function apply_(uint256 idSeed, uint256 toShop, uint256 refund) external creditsOnlyRise {
        if (claimIds.length == 0) return;
        bytes32 id = claimIds[idSeed % claimIds.length];
        address p = claimPlatform[id];
        address s = claimShop[id];
        if (!ghostOpen[id]) {
            // A closed escrow can never be applied again.
            vm.expectRevert(abi.encodeWithSelector(IDepositVault.UnknownEscrow.selector, id));
            vault.applyOutcome(id, p, s, toShop % 1e9, 0);
            return;
        }
        uint256 fee = vault.escrowOf(id).amount;
        // Half the payouts stay within the claim's stated maximum, as RecourseClaims' always do.
        toShop = toShop % 2 == 0 ? bound(toShop, 0, ghostMax[id]) : bound(toShop, 0, 20_000e6);
        refund = bound(refund, 0, fee);
        uint256 cap = _ghostAvailable(id, p);
        require(vault.availableTo(id) == cap, "availableTo");
        bytes32 oldest = _ghostOldest(p);
        if (toShop > cap && oldest != id) {
            // Short while an earlier claim is open: it waits, and nothing changes.
            vm.expectRevert(abi.encodeWithSelector(IDepositVault.EarlierClaimOpen.selector, oldest));
            vault.applyOutcome(id, p, s, toShop, refund);
            return;
        }
        uint256 paid = vault.applyOutcome(id, p, s, toShop, refund);
        require(paid == (toShop < cap ? toShop : cap), "paid past what the claim may draw");
        ghostOpen[id] = false;
        appliedCount[id] += 1;
        ghostOpenClaims[p] -= 1;
    }

    function withdraw(uint256 aSeed) external {
        address a = accounts[aSeed % accounts.length];
        if (vault.creditOf(a) == 0) return;
        vm.prank(a);
        vault.withdrawCredit();
    }

    function requestExit(uint256 pSeed) external creditsOnlyRise {
        address p = platforms[pSeed % platforms.length];
        if (vault.depositOf(p) == 0 || vault.exitRequestedAt(p) != 0) return;
        vm.prank(p);
        vault.requestExit();
    }

    function exit(uint256 pSeed) external creditsOnlyRise {
        address p = platforms[pSeed % platforms.length];
        uint256 at = vault.exitRequestedAt(p);
        if (at == 0 || vault.openClaimsOf(p) != 0) return;
        (, uint64 delay,) = vault.params();
        if (block.timestamp < at + delay) return;
        vm.prank(p);
        vault.exit();
    }

    function warp(uint256 dt) external {
        currentTime += bound(dt, 1, 3 days);
        vm.warp(currentTime);
    }

    // ------------------------------------------------------------ ghost checks

    /// @dev The first claim escrowed against `p` that is still open.
    function _ghostOldest(address p) internal view returns (bytes32) {
        for (uint256 i; i < claimIds.length; ++i) {
            bytes32 id = claimIds[i];
            if (ghostOpen[id] && claimPlatform[id] == p) return id;
        }
        return bytes32(0);
    }

    /// @dev What the claim may draw, from the ghost books: its reservation, plus all of the unreserved deposit if it
    ///      is the oldest open claim, else only the unreserved deposit past what every other open claim may still
    ///      be owed beyond its own reservation.
    function _ghostAvailable(bytes32 id, address p) internal view returns (uint256) {
        uint256 reserved;
        uint256 othersUncovered;
        for (uint256 i; i < claimIds.length; ++i) {
            bytes32 k = claimIds[i];
            if (!ghostOpen[k] || claimPlatform[k] != p) continue;
            reserved += ghostOwn[k];
            if (k != id) othersUncovered += ghostMax[k] - ghostOwn[k];
        }
        uint256 unreserved = vault.depositOf(p) - reserved;
        if (_ghostOldest(p) == id) return ghostOwn[id] + unreserved;
        return ghostOwn[id] + (unreserved > othersUncovered ? unreserved - othersUncovered : 0);
    }

    function ghostExposure(address p) external view returns (uint256 sum) {
        for (uint256 i; i < claimIds.length; ++i) {
            bytes32 k = claimIds[i];
            if (ghostOpen[k] && claimPlatform[k] == p) sum += ghostMax[k];
        }
    }

    function ghostOldest(address p) external view returns (bytes32) {
        return _ghostOldest(p);
    }

    modifier creditsOnlyRise() {
        uint256 n = accounts.length;
        uint256[] memory before = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            before[i] = vault.creditOf(accounts[i]);
        }
        _;
        for (uint256 i; i < n; ++i) {
            if (vault.creditOf(accounts[i]) < before[i]) creditFellOutsideWithdraw = true;
        }
        calls += 1;
    }
}
