// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {DepositVault} from "../../src/hedera/DepositVault.sol";
import {IDepositVault} from "../../src/hedera/interfaces/IDepositVault.sol";
import {IRecourseClaims} from "../../src/hedera/interfaces/IRecourseClaims.sol";
import {Claim, ClaimStatus, RulingBack} from "../../src/shared/RecourseTypes.sol";
import {ClaimsBase} from "./ClaimsBase.sol";

/// @notice Runs every case of the shared settle vectors through the real contracts: the claim
///         is filed, taken to the case's end state and closed, settled or expired, and the
///         preview, the events and the vault credits must equal the vector. The deposit-draw
///         vectors run against the vault directly.
contract SettleVectorsTest is ClaimsBase {
    string internal constant FILE = "../packages/shared/vectors/settle.json";
    string internal json;

    struct Case {
        string name;
        string outcome;
        string row;
        uint256 basket;
        uint256 netLoss;
        uint256 fee;
        uint8 gap;
        uint8 answer;
        uint8 ruling;
        uint8 attempts;
        uint256 toShop;
        uint256 refund;
        uint256 toPool;
        bool settles; // ends in Settled, with `settledOutcome`
        uint8 settledOutcome;
    }

    function setUp() public {
        _setUpClaims();
        json = vm.readFile(FILE);
    }

    // ------------------------------------------------------------ settle cases

    function test_settleVectors_everyCase() public {
        uint256 ran;
        uint256 batchRows;
        for (uint256 i; vm.keyExistsJson(json, _at(i)); ++i) {
            Case memory c = _case(i);
            if (_eq(c.outcome, "undrawn")) {
                ++batchRows; // batch draw is not built; no claim can reach this row
                continue;
            }
            uint256 snap = vm.snapshotState();
            _run(c);
            vm.revertToState(snap);
            ++ran;
        }
        assertGe(ran, 20, "fewer settle vectors than expected");
        assertEq(batchRows, 1, "batch rows");
    }

    function _run(Case memory c) internal {
        _useParams(c.fee);
        bytes32 id = _file(shop, platform, c.basket, c.netLoss);
        assertEq(vault.escrowOf(id).amount, c.fee, c.name);

        if (_eq(c.outcome, "expired")) {
            vm.warp(uint256(claims.getClaim(id).filedAt) + claims.params().claimTimeout + 1);
            _expectCredits(c, id, this._expire);
        } else if (_eq(c.outcome, "uncontested")) {
            _precheck(id, c.gap, c.answer);
            _expectPreview(c, id);
            vm.warp(uint256(claims.getClaim(id).preCheckedAt) + claims.params().contestWindow + 1);
            _expectCredits(c, id, this._close);
        } else if (_eq(c.outcome, "ruled")) {
            _precheck(id, c.gap, c.answer);
            _contest(id);
            claims.sendToCourt(id);
            _deliverRaw(id, c.ruling, c.attempts);
            if (_eq(c.row, "not_settleable")) {
                assertEq(uint8(_status(id)), uint8(ClaimStatus.AtCourt), c.name);
                _expectPreview(c, id); // all zero
                return;
            }
            assertEq(uint8(_status(id)), uint8(ClaimStatus.Ruled), c.name);
            assertTrue(c.settles, string.concat(c.name, ": ruled row without a settled outcome"));
            _expectPreview(c, id);
            _expectCredits(c, id, this._settle);
        } else {
            revert(string.concat("unknown outcome in vector: ", c.outcome));
        }
        _assertBooks();
    }

    function _expire(bytes32 id) external {
        claims.expireClaim(id);
    }

    function _close(bytes32 id) external {
        claims.closeUncontested(id);
    }

    function _settle(bytes32 id) external {
        claims.settle(id);
    }

    function _expectPreview(Case memory c, bytes32 id) internal view {
        (uint256 s, uint256 r, uint256 p) = claims.previewSettle(id);
        assertEq(s, c.toShop, string.concat(c.name, ": preview toShop"));
        assertEq(r, c.refund, string.concat(c.name, ": preview refund"));
        assertEq(p, c.toPool, string.concat(c.name, ": preview toPool"));
    }

    function _expectCredits(Case memory c, bytes32 id, function(bytes32) external action) internal {
        uint256 shopCredit = vault.creditOf(shop);
        uint256 poolCredit = vault.creditOf(pool);
        uint256 held = vault.depositOf(platform);
        if (c.settles) {
            vm.expectEmit(address(claims));
            emit IRecourseClaims.Settled(id, c.settledOutcome, c.toShop, c.toPool);
        }
        action(id);
        assertEq(vault.creditOf(shop), shopCredit + c.toShop + c.refund, string.concat(c.name, ": shop credit"));
        assertEq(vault.creditOf(pool), poolCredit + c.toPool, string.concat(c.name, ": pool credit"));
        assertEq(vault.depositOf(platform), held - c.toShop, string.concat(c.name, ": deposit"));
        assertEq(uint8(vault.escrowOf(id).state), uint8(IDepositVault.EscrowState.Closed), c.name);
    }

    /// @dev Delivers the ruling bytes as the court would send them, including out-of-range values
    ///      the encoder refuses to build.
    function _deliverRaw(bytes32 id, uint8 ruling, uint8 attempts) internal {
        bytes memory data =
            abi.encode(RulingBack({version: 1, claimId: id, disputeId: 9, ruling: ruling, attempts: attempts}));
        (bool ok,) = _route(_rulingMsg(data, casePeer, ARB_SEL));
        assertTrue(ok, "receive reverted");
    }

    function _useParams(uint256 fee) internal {
        IRecourseClaims.Params memory p = _params();
        p.courtFeeUsdc = fee;
        p.handlingBase = _str(".params.handlingBase");
        p.handlingBps = uint16(_str(".params.handlingBps"));
        p.handlingCap = _str(".params.handlingCap");
        vm.prank(owner);
        claims.setParams(p);
    }

    // ------------------------------------------------------------ deposit draws

    function test_settleVectors_drawFromDeposit() public {
        uint256 n;
        for (uint256 i; vm.keyExistsJson(json, string.concat(".drawFromDeposit[", vm.toString(i), "]")); ++i) {
            string memory p = string.concat(".drawFromDeposit[", vm.toString(i), "]");
            uint256 owed = _str(string.concat(p, ".owed"));
            uint256 held = _str(string.concat(p, ".held"));
            uint256 paid = _str(string.concat(p, ".paid"));
            uint256 notCovered = _str(string.concat(p, ".notCovered"));

            // A vault whose claims contract is this test, so outcomes can be applied directly.
            DepositVault v = _deployVault(address(this));
            v.associateUsdc(false);
            address payer = makeAddr(string.concat("platform", vm.toString(i)));
            usdc.mockAssociate(payer);
            if (held != 0) {
                usdc.mint(payer, held);
                vm.startPrank(payer);
                usdc.approve(address(v), held);
                v.postDeposit(payer, held);
                vm.stopPrank();
            }
            vm.prank(shop);
            usdc.approve(address(v), FEE);
            bytes32 id = keccak256(abi.encode("draw", i));
            v.escrowFee(shop, payer, FEE, id);

            if (notCovered != 0) {
                vm.expectEmit(address(v));
                emit IDepositVault.Shortfall(id, payer, notCovered);
            }
            uint256 got = v.applyOutcome(id, payer, shop, owed, 0);
            assertEq(got, paid, "paid");
            assertEq(v.depositOf(payer), held - paid, "deposit left");
            assertEq(v.creditOf(shop), paid, "shop credit");
            ++n;
        }
        assertGe(n, 4, "fewer draw vectors than expected");
    }

    // ------------------------------------------------------------ parsing

    function _case(uint256 i) internal view returns (Case memory c) {
        string memory p = _at(i);
        c.name = vm.parseJsonString(json, string.concat(p, ".name"));
        c.outcome = vm.parseJsonString(json, string.concat(p, ".input.outcome"));
        c.row = vm.parseJsonString(json, string.concat(p, ".expect.row"));
        c.basket = _str(string.concat(p, ".input.basketUsdc"));
        c.netLoss = _str(string.concat(p, ".input.netLossUsdc"));
        c.fee = _str(string.concat(p, ".input.feeUsdc"));
        c.gap = uint8(vm.parseJsonUint(json, string.concat(p, ".input.gap")));
        c.answer = uint8(vm.parseJsonUint(json, string.concat(p, ".input.answer")));
        if (vm.keyExistsJson(json, string.concat(p, ".input.ruling"))) {
            c.ruling = uint8(vm.parseJsonUint(json, string.concat(p, ".input.ruling")));
            c.attempts = uint8(vm.parseJsonUint(json, string.concat(p, ".input.attempts")));
        }
        c.toShop = _str(string.concat(p, ".expect.toShop"));
        c.refund = _str(string.concat(p, ".expect.refundToShop"));
        c.toPool = _str(string.concat(p, ".expect.toPool"));
        string memory so = string.concat(p, ".expect.settledOutcome");
        if (_eq(c.outcome, "ruled") && !_eq(c.row, "not_settleable")) {
            c.settles = true;
            c.settledOutcome = uint8(vm.parseJsonUint(json, so));
        }
    }

    function _at(uint256 i) internal pure returns (string memory) {
        return string.concat(".cases[", vm.toString(i), "]");
    }

    /// @dev Money amounts are decimal strings in the vectors.
    function _str(string memory key) internal view returns (uint256) {
        return vm.parseUint(vm.parseJsonString(json, key));
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
