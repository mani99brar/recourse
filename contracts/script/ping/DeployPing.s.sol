// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {RecoursePing} from "../../src/ping/RecoursePing.sol";

/// @notice Deploys one RecoursePing on the chain behind `--rpc-url`. The broadcaster becomes the owner unless
/// `PING_OWNER` is set. Router and LINK come from the chain id; on a local chain set `PING_ROUTER` and `PING_LINK`.
///
/// Dry run (no funds needed):  forge script script/ping/DeployPing.s.sol --rpc-url "$ARB_RPC_URL" \
///     --keystore "$KEYSTORE_DIR/ops-arb.json" --password-file "$KEYSTORE_DIR/ops-arb.json.pass"
/// Add `--broadcast` to send. `script/ping/ping.sh deploy <chain>` wraps this and records the result.
contract DeployPing is Script {
    uint256 internal constant HEDERA_TESTNET = 296;
    uint256 internal constant ARBITRUM_SEPOLIA = 421614;

    function run() external returns (RecoursePing ping) {
        (address router, address link) = _endpoints();
        vm.startBroadcast();
        (, address broadcaster,) = vm.readCallers();
        address owner = vm.envOr("PING_OWNER", broadcaster);
        ping = new RecoursePing(router, link, owner);
        vm.stopBroadcast();

        console2.log("chainId", block.chainid);
        console2.log("RecoursePing", address(ping));
        console2.log("owner", owner);
        console2.log("router", router);
        console2.log("link", link);
    }

    function _endpoints() internal view returns (address router, address link) {
        if (block.chainid == HEDERA_TESTNET) {
            return (0x802C5F84eAD128Ff36fD6a3f8a418e339f467Ce4, 0x90a386d59b9A6a4795a011e8f032Fc21ED6FEFb6);
        }
        if (block.chainid == ARBITRUM_SEPOLIA) {
            return (0x2a9C5afB0d0e4BAb2BCdaE109EC4b0c4Be15a165, 0xb1D4538B4571d411F07960EF2838Ce337FE1E80E);
        }
        return (vm.envAddress("PING_ROUTER"), vm.envAddress("PING_LINK"));
    }
}
