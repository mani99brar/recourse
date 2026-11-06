// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {console2} from "forge-std/console2.sol";

import {DepositVault} from "../../src/hedera/DepositVault.sol";
import {RecourseClaims} from "../../src/hedera/RecourseClaims.sol";
import {IRecourseClaims} from "../../src/hedera/interfaces/IRecourseClaims.sol";
import {BridgeMode} from "../../src/shared/RecourseTypes.sol";
import {HederaScript} from "./HederaScript.sol";

/// @notice Sets the locked parameters on RecourseClaims and DepositVault, then locks the
///         configuration of both, and prints the read-backs. Owner (deployer) keystore. This is
///         one-way: after it, only the always-available setters remain (extra args, fee token,
///         required deposits).
///
///   forge script script/hedera/Lock.s.sol --rpc-url "$HEDERA_RPC_URL_1" --slow \
///       --keystore "$KEYSTORE_DIR/deployer.json" --password-file "$KEYSTORE_DIR/deployer.json.pass"
///   (add --broadcast to send; `hedera.sh lock` wraps this)
contract Lock is HederaScript {
    function run() external {
        _requireChain();
        (RecourseClaims claims, DepositVault vault,) = _loadDeployed();
        require(!claims.configLocked() && !vault.configLocked(), "Lock: already locked");
        require(claims.bridgeMode() == BridgeMode.None || claims.peer() != address(0), "Lock: peer not set");
        // The mode is locked for good, so it must be the one intended, when that is named.
        string memory intended = vm.envOr("HEDERA_BRIDGE_MODE", string(""));
        require(
            bytes(intended).length == 0 || claims.bridgeMode() == _mode(intended), "Lock: mode is not HEDERA_BRIDGE_MODE"
        );
        require(claims.preCheckSigner() != address(0), "Lock: pre-check signer not set");
        require(vault.claims() == address(claims) && claims.vault() == address(vault), "Lock: not bound");
        require(vault.usdcAssociated(), "Lock: vault not associated");

        IRecourseClaims.Params memory p = _claimsParams("locked");
        VaultParams memory vp = _vaultParams("locked");

        vm.startBroadcast();
        claims.setParams(p);
        vault.setParams(vp.topUpWindow, vp.exitDelay, vp.minDeposit);
        claims.lockConfig();
        vault.lockConfig();
        vm.stopBroadcast();

        require(claims.configLocked() && vault.configLocked(), "Lock: lock read-back");
        IRecourseClaims.Params memory got = claims.params();
        require(keccak256(abi.encode(got)) == keccak256(abi.encode(p)), "Lock: claims params read-back");
        (uint64 topUpWindow, uint64 exitDelay, uint256 minDeposit) = vault.params();
        require(
            topUpWindow == vp.topUpWindow && exitDelay == vp.exitDelay && minDeposit == vp.minDeposit,
            "Lock: vault params read-back"
        );
        console2.log("Lock OK");
        _readBacks(claims, vault);
    }
}
