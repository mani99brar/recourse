// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {console2} from "forge-std/console2.sol";

import {DepositVault} from "../../src/hedera/DepositVault.sol";
import {RecourseClaims} from "../../src/hedera/RecourseClaims.sol";
import {IRecourseClaims} from "../../src/hedera/interfaces/IRecourseClaims.sol";
import {BridgeMode} from "../../src/shared/RecourseTypes.sol";
import {HederaWiring} from "./Wire.s.sol";

/// @notice Sets the locked parameters on RecourseClaims and DepositVault, then locks the
///         configuration of both, and prints the read-backs. Owner (deployer) keystore. This is
///         one-way: after it, only the always-available setters remain (extra args, fee token,
///         required deposits). So it first checks that the peer is the RecourseCase the Arbitrum
///         deployments file records (unless the mode is None), and that the pre-check signer and the
///         ruling relayer are the precheck-signer and ops-hedera addresses in deployments/parties.json
///         (in a rehearsal: PRECHECK_SIGNER_ADDRESS and RULING_RELAYER_ADDRESS).
///
///   forge script script/hedera/Lock.s.sol --rpc-url "$HEDERA_RPC_URL_1" --slow \
///       --keystore "$KEYSTORE_DIR/deployer.json" --password-file "$KEYSTORE_DIR/deployer.json.pass"
///   (add --broadcast to send; `hedera.sh lock` wraps this; ARBITRUM_FILE names the file, default arbitrum.json)
contract Lock is HederaWiring {
    function run() external {
        _requireChain();
        (RecourseClaims claims, DepositVault vault,) = _loadDeployed();
        require(!claims.configLocked() && !vault.configLocked(), "Lock: already locked");
        if (claims.bridgeMode() != BridgeMode.None) {
            require(claims.peer() != address(0), "Lock: peer not set");
            require(claims.peer() == _recordedCase(), "Lock: peer is not the RecourseCase on record");
        }
        // The mode is locked for good, so it must be the one intended, when that is named.
        string memory intended = vm.envOr("HEDERA_BRIDGE_MODE", string(""));
        require(
            bytes(intended).length == 0 || claims.bridgeMode() == _mode(intended),
            "Lock: mode is not HEDERA_BRIDGE_MODE"
        );
        require(claims.preCheckSigner() != address(0), "Lock: pre-check signer not set");
        require(
            claims.preCheckSigner() == _recordedRole("precheck-signer", "PRECHECK_SIGNER_ADDRESS"),
            "Lock: pre-check signer is not the precheck-signer on record"
        );
        require(
            claims.rulingRelayer() == _recordedRole("ops-hedera", "RULING_RELAYER_ADDRESS"),
            "Lock: ruling relayer is not the ops-hedera address on record"
        );
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
