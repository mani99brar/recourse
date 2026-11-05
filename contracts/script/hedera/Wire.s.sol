// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {console2} from "forge-std/console2.sol";

import {DepositVault} from "../../src/hedera/DepositVault.sol";
import {RecourseClaims} from "../../src/hedera/RecourseClaims.sol";
import {HederaScript} from "./HederaScript.sol";

/// @notice Points RecourseClaims at the court contract on Arbitrum (`setPeer`) and prints the
///         read-backs. Nothing else: LINK funding is a separate ops step. Owner (deployer) keystore.
///
///   RECOURSE_CASE_ADDRESS=0x… forge script script/hedera/Wire.s.sol --rpc-url "$HEDERA_RPC_URL_1" --slow \
///       --keystore "$KEYSTORE_DIR/deployer.json" --password-file "$KEYSTORE_DIR/deployer.json.pass"
///   (add --broadcast to send; `hedera.sh wire` wraps this)
contract Wire is HederaScript {
    function run() external {
        _requireChain();
        (RecourseClaims claims, DepositVault vault,) = _loadDeployed();
        address peer = vm.envAddress("RECOURSE_CASE_ADDRESS");
        require(peer != address(0), "Wire: RECOURSE_CASE_ADDRESS is zero");
        require(!claims.configLocked(), "Wire: claims config is locked");

        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        require(sender == claims.owner(), "Wire: signer is not the claims owner");
        if (claims.peer() != peer) claims.setPeer(peer);
        vm.stopBroadcast();

        require(claims.peer() == peer, "Wire: peer read-back");
        console2.log("Wire OK");
        _readBacks(claims, vault);
    }
}
