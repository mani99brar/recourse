// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {console2} from "forge-std/console2.sol";

import {DepositVault} from "../../src/hedera/DepositVault.sol";
import {RecourseClaims} from "../../src/hedera/RecourseClaims.sol";
import {HederaScript} from "./HederaScript.sol";

/// @notice What the peer and role addresses that the lock makes permanent are checked against: the RecourseCase
///         the Arbitrum deployments file records, and the role addresses in `deployments/parties.json`.
abstract contract HederaWiring is HederaScript {
    uint256 internal constant ARBITRUM_ONE = 42161;
    uint256 internal constant ARBITRUM_SEPOLIA = 421614;

    /// @dev The RecourseCase in `deployments/<ARBITRUM_FILE>` (default arbitrum.json), a file for Arbitrum Sepolia.
    ///      A rehearsal's file must be for another chain; a rehearsal that names no ARBITRUM_FILE has no case on
    ///      record and takes RECOURSE_CASE_ADDRESS as given (zero when unset).
    function _recordedCase() internal view returns (address) {
        bool rehearsal = vm.envOr("HEDERA_REHEARSAL", false);
        string memory file = vm.envOr("ARBITRUM_FILE", string(""));
        if (bytes(file).length == 0) {
            if (rehearsal) return vm.envOr("RECOURSE_CASE_ADDRESS", address(0));
            file = "arbitrum.json";
        }
        string memory json = vm.readFile(string.concat(DEPLOYMENTS_DIR, "/", file));
        if (rehearsal) {
            if (vm.keyExistsJson(json, ".chainId")) {
                uint256 chainId = vm.parseJsonUint(json, ".chainId");
                require(
                    chainId != ARBITRUM_SEPOLIA && chainId != ARBITRUM_ONE, "rehearsal: ARBITRUM_FILE is a live file"
                );
            }
        } else {
            require(vm.parseJsonUint(json, ".chainId") == ARBITRUM_SEPOLIA, "ARBITRUM_FILE is not for Arbitrum Sepolia");
        }
        return vm.parseJsonAddress(json, ".contracts.case.address");
    }

    /// @dev `role`'s evmAddress in deployments/parties.json. A rehearsal's throwaway keys are not there, so it takes
    ///      `envName`, the address its deploy was given (zero when unset).
    function _recordedRole(string memory role, string memory envName) internal view returns (address) {
        if (vm.envOr("HEDERA_REHEARSAL", false)) return vm.envOr(envName, address(0));
        string memory json = vm.readFile(string.concat(DEPLOYMENTS_DIR, "/parties.json"));
        for (uint256 i; vm.keyExistsJson(json, string.concat("$[", vm.toString(i), "]")); ++i) {
            string memory entry = string.concat("$[", vm.toString(i), "]");
            if (keccak256(bytes(vm.parseJsonString(json, string.concat(entry, ".role")))) == keccak256(bytes(role))) {
                return vm.parseJsonAddress(json, string.concat(entry, ".evmAddress"));
            }
        }
        revert(string.concat("parties.json has no role ", role));
    }
}

/// @notice Points RecourseClaims at the court contract on Arbitrum (`setPeer`) and prints the
///         read-backs. Nothing else: LINK funding is a separate ops step. Owner (deployer) keystore.
///         RECOURSE_CASE_ADDRESS must be the RecourseCase the Arbitrum deployments file records, since the
///         lock makes the peer permanent.
///
///   RECOURSE_CASE_ADDRESS=0x… forge script script/hedera/Wire.s.sol --rpc-url "$HEDERA_RPC_URL_1" --slow \
///       --keystore "$KEYSTORE_DIR/deployer.json" --password-file "$KEYSTORE_DIR/deployer.json.pass"
///   (add --broadcast to send; `hedera.sh wire` wraps this; ARBITRUM_FILE names the file, default arbitrum.json)
contract Wire is HederaWiring {
    function run() external {
        _requireChain();
        (RecourseClaims claims, DepositVault vault,) = _loadDeployed();
        address peer = vm.envAddress("RECOURSE_CASE_ADDRESS");
        require(peer != address(0), "Wire: RECOURSE_CASE_ADDRESS is zero");
        require(peer == _recordedCase(), "Wire: RECOURSE_CASE_ADDRESS is not the RecourseCase on record");
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
