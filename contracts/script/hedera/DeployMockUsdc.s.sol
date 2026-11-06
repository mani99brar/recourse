// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {console2} from "forge-std/console2.sol";

import {MockUsdc} from "../../src/testnet/MockUsdc.sol";
import {HederaScript} from "./HederaScript.sol";

/// @notice Deploys MockUsdc, the testnet stand-in for USDC, for a deployment in mock mode
///         (`HEDERA_USDC_MODE=mock`). The broadcaster (the deployer keystore) becomes its owner, the
///         only account that can mint it. Nothing else is deployed or set; `Deploy.s.sol` then takes
///         the token as USDC_ADDRESS.
///
///   forge script script/hedera/DeployMockUsdc.s.sol --rpc-url "$HEDERA_RPC_URL_1" --slow \
///       --keystore "$KEYSTORE_DIR/deployer.json" --password-file "$KEYSTORE_DIR/deployer.json.pass"
///   (add --broadcast to send; `hedera.sh mock-usdc` wraps this)
contract DeployMockUsdc is HederaScript {
    function run() external returns (MockUsdc token) {
        _requireChain();

        vm.startBroadcast();
        (, address owner,) = vm.readCallers();
        token = new MockUsdc(owner);
        vm.stopBroadcast();

        console2.log("chainId", block.chainid);
        console2.log("MockUsdc", address(token));
        console2.log("owner", token.owner());
        console2.log("name", token.name());
        console2.log("symbol", token.symbol());
        console2.log("decimals", token.decimals());
    }
}
