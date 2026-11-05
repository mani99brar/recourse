// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";

import {DepositVault} from "../../src/hedera/DepositVault.sol";
import {RecourseClaims} from "../../src/hedera/RecourseClaims.sol";
import {RecourseAddresses} from "../../src/shared/RecourseAddresses.sol";
import {MockHTS} from "./mocks/MockHTS.sol";
import {MockHtsUsdc} from "./mocks/MockHtsUsdc.sol";
import {MockPRNG} from "./mocks/MockPRNG.sol";

/// @notice Deploys contracts from an external call, so a test can expect a constructor revert
///         without putting `expectRevert` in front of a bare `new`.
contract DeployHelper {
    function deployVault(address usdc, address pool, address owner) external returns (DepositVault) {
        return new DepositVault(usdc, pool, owner);
    }

    function deployClaims(address router, address link, address vault, uint64 arbSelector, address owner)
        external
        returns (RecourseClaims)
    {
        return new RecourseClaims(router, link, vault, arbSelector, owner);
    }
}

/// @notice Shared fixture: Hedera system-contract mocks at their real addresses, the mock USDC at
///         the testnet USDC facade address, and named actors.
abstract contract HederaBase is Test {
    address internal constant HTS_ADDR = RecourseAddresses.HEDERA_HTS;
    address internal constant PRNG_ADDR = RecourseAddresses.HEDERA_PRNG;
    /// @dev Long-zero EVM address of testnet USDC 0.0.429274.
    address internal constant USDC_ADDR = RecourseAddresses.HEDERA_USDC;

    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant USDC = 1e6;

    MockHTS internal hts;
    MockPRNG internal prng;
    MockHtsUsdc internal usdc;
    DeployHelper internal deployer;

    address internal owner = makeAddr("owner");
    address internal pool = makeAddr("pool");
    address internal platform = makeAddr("platform");
    address internal platform2 = makeAddr("platform2");
    address internal shop = makeAddr("shop");
    address internal shop2 = makeAddr("shop2");
    address internal stranger = makeAddr("stranger");

    function _setUpHedera() internal {
        vm.chainId(296);
        vm.warp(T0);
        vm.etch(HTS_ADDR, type(MockHTS).runtimeCode);
        vm.etch(PRNG_ADDR, type(MockPRNG).runtimeCode);
        vm.etch(USDC_ADDR, type(MockHtsUsdc).runtimeCode);
        hts = MockHTS(HTS_ADDR);
        prng = MockPRNG(PRNG_ADDR);
        usdc = MockHtsUsdc(USDC_ADDR);
        deployer = new DeployHelper();
    }

    /// @dev Associates `who` with mock USDC and mints `amount` to it.
    function _fund(address who, uint256 amount) internal {
        usdc.mockAssociate(who);
        if (amount > 0) usdc.mint(who, amount);
    }

    function _deployVault(address claims_) internal returns (DepositVault v) {
        v = new DepositVault(USDC_ADDR, pool, owner);
        if (claims_ != address(0)) {
            vm.prank(owner);
            v.bindClaims(claims_);
        }
        v.associateUsdc(false);
        usdc.mockAssociate(pool);
    }
}
