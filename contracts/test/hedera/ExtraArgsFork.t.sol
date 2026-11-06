// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";

import {BridgeCodec} from "../../src/shared/BridgeCodec.sol";
import {RecourseAddresses as A} from "../../src/shared/RecourseAddresses.sol";

/// @notice Read-only fork of Hedera testnet: the live router quotes a ClaimToCourt send with the extra args the
/// deployment stores and with the lowest and highest gas limit `setExtraArgs` accepts (3,000,000, the shared
/// `gasCap`, at or below the lane's own cap), and refuses a gas limit the lane caps. The chainlink-local router used
/// by the unit suite has no lane config, so only this test sees the lane's caps.
///
///   forge test --match-path 'test/hedera/ExtraArgsFork.t.sol' --fork-url "$HEDERA_RPC_URL_1" -vv
///
/// Skipped without a fork. Nothing is sent.
contract ExtraArgsForkTest is Test {
    string internal constant DEPLOYMENT = "../deployments/hedera.json";
    /// @dev The bounds RecourseClaims.setExtraArgs enforces.
    uint256 internal constant MIN_GAS = 100_000;
    uint256 internal constant MAX_GAS = 3_000_000;

    function test_fork_laneQuotesEveryArgSetExtraArgsAllows() public {
        if (block.chainid != A.HEDERA_CHAIN_ID) {
            vm.skip(true, "needs --fork-url on Hedera testnet");
        }
        IRouterClient router = IRouterClient(A.HEDERA_ROUTER);
        assertTrue(router.isChainSupported(A.ARBITRUM_SELECTOR), "no Arbitrum lane");

        bytes memory stored = vm.parseJsonBytes(vm.readFile(DEPLOYMENT), ".extraArgs");
        assertGt(router.getFee(A.ARBITRUM_SELECTOR, _message(stored)), 0, "stored extra args");
        assertGt(router.getFee(A.ARBITRUM_SELECTOR, _message(BridgeCodec.extraArgsFor(MIN_GAS))), 0, "lowest gas");
        assertGt(router.getFee(A.ARBITRUM_SELECTOR, _message(BridgeCodec.extraArgsFor(MAX_GAS))), 0, "highest gas");

        // Past the lane's cap the quote reverts, so every send would: the reason setExtraArgs has an upper bound.
        vm.expectRevert();
        router.getFee(A.ARBITRUM_SELECTOR, _message(BridgeCodec.extraArgsFor(30_000_000)));
    }

    /// @dev A ClaimToCourt-sized message to some receiver, paid in LINK.
    function _message(bytes memory extraArgs) internal pure returns (Client.EVM2AnyMessage memory) {
        return Client.EVM2AnyMessage({
            receiver: abi.encode(address(0xCA5E)),
            data: new bytes(BridgeCodec.CLAIM_TO_COURT_LEN),
            tokenAmounts: new Client.EVMTokenAmount[](0),
            feeToken: A.HEDERA_LINK,
            extraArgs: extraArgs
        });
    }
}
