// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {RecourseAddresses} from "../../src/shared/RecourseAddresses.sol";
import {MockUsdc} from "../../src/testnet/MockUsdc.sol";
import {Deploy} from "../../script/hedera/Deploy.s.sol";
import {MockHtsUsdc} from "./mocks/MockHtsUsdc.sol";

/// @dev Exposes the deploy script's token choice, which `run()` feeds from HEDERA_USDC_MODE and
///      USDC_ADDRESS. Taking them as arguments keeps the tests off the process environment.
contract DeployHarness is Deploy {
    function usdcFor(string memory mode, address given) external view returns (address) {
        return _usdc(mode, given);
    }
}

/// @dev Right symbol, wrong decimals.
contract EighteenDecimalMock is ERC20 {
    constructor() ERC20("Mock USD Coin (testnet)", "mUSDC") {}
}

/// @notice The deploy script takes Circle's USDC in circle mode and a MockUsdc in mock mode, and
///         neither mode accepts the other's token.
contract DeployUsdcModeTest is Test {
    address internal constant CIRCLE = RecourseAddresses.HEDERA_USDC;

    DeployHarness internal harness;
    MockUsdc internal mock;

    function setUp() public {
        harness = new DeployHarness();
        mock = new MockUsdc(makeAddr("owner"));
    }

    function test_circle_isCirclesUsdc() public view {
        assertEq(harness.usdcFor("circle", address(0)), CIRCLE);
        assertEq(harness.usdcFor("circle", CIRCLE), CIRCLE);
    }

    function test_circle_refusesAnyOtherAddress() public {
        vm.expectRevert(bytes("Deploy: USDC_ADDRESS is not Circle's USDC; set HEDERA_USDC_MODE=mock for a mock"));
        harness.usdcFor("circle", address(mock));
    }

    function test_mock_takesTheMock() public view {
        assertEq(harness.usdcFor("mock", address(mock)), address(mock));
    }

    function test_mock_refusesCirclesUsdc() public {
        // Even with token code at the facade address, as a fork or a local stack has it.
        vm.etch(CIRCLE, type(MockHtsUsdc).runtimeCode);
        vm.expectRevert(bytes("Deploy: USDC_ADDRESS is Circle's USDC, not a mock"));
        harness.usdcFor("mock", CIRCLE);
    }

    function test_mock_refusesAnythingThatIsNotAMock() public {
        vm.expectRevert(bytes("Deploy: mock mode needs USDC_ADDRESS"));
        harness.usdcFor("mock", address(0));

        vm.expectRevert(bytes("Deploy: no code at USDC_ADDRESS"));
        harness.usdcFor("mock", makeAddr("eoa"));

        address noDecimals = address(new DeployHarness());
        vm.expectRevert(bytes("Deploy: USDC_ADDRESS does not have 6 decimals"));
        harness.usdcFor("mock", noDecimals);

        address eighteen = address(new EighteenDecimalMock());
        vm.expectRevert(bytes("Deploy: USDC_ADDRESS does not have 6 decimals"));
        harness.usdcFor("mock", eighteen);

        // Six decimals and the symbol USDC: the HTS USDC test double at an ordinary address.
        address usdcLike = address(new MockHtsUsdc());
        vm.expectRevert(bytes("Deploy: USDC_ADDRESS is not a mock USDC (symbol mUSDC)"));
        harness.usdcFor("mock", usdcLike);
    }

    function test_unknownModeReverts() public {
        vm.expectRevert(bytes("Deploy: HEDERA_USDC_MODE must be circle or mock"));
        harness.usdcFor("Circle", address(0));
        vm.expectRevert(bytes("Deploy: HEDERA_USDC_MODE must be circle or mock"));
        harness.usdcFor("", address(mock));
    }
}
