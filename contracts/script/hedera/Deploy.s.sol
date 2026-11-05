// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {console2} from "forge-std/console2.sol";

import {DepositVault} from "../../src/hedera/DepositVault.sol";
import {RecourseClaims} from "../../src/hedera/RecourseClaims.sol";
import {BridgeCodec} from "../../src/shared/BridgeCodec.sol";
import {RecourseAddresses} from "../../src/shared/RecourseAddresses.sol";
import {BridgeMode} from "../../src/shared/RecourseTypes.sol";
import {HederaScript} from "./HederaScript.sol";

/// @notice Deploys DepositVault and RecourseClaims on Hedera testnet, binds them and sets the
///         pre-lock configuration: parameters on both, the pre-check signer, the bridge mode with
///         the ruling relayer, and the send extra args. The broadcaster (the deployer keystore)
///         becomes the owner of both. Association, the deployments file, the peer and the lock
///         are separate steps (`hedera.sh associate`, `record`, `wire`, `lock`); no USDC moves here.
///
///   forge script script/hedera/Deploy.s.sol --rpc-url "$HEDERA_RPC_URL_1" --slow \
///       --keystore "$KEYSTORE_DIR/deployer.json" --password-file "$KEYSTORE_DIR/deployer.json.pass"
///   (add --broadcast to send; `hedera.sh deploy` wraps this)
///
/// Env: POOL_ADDRESS, PRECHECK_SIGNER_ADDRESS, RULING_RELAYER_ADDRESS, HEDERA_BRIDGE_MODE
/// (Both, OutOnly or None). A rehearsal on anvil sets HEDERA_REHEARSAL=1 plus HEDERA_ROUTER and
/// HEDERA_LINK (the local router and LINK); the chain id then must not be a Hedera one.
contract Deploy is HederaScript {
    function run() external returns (DepositVault vault, RecourseClaims claims) {
        (address router, address link) = _endpoints();
        address pool = vm.envAddress("POOL_ADDRESS");
        address signer = vm.envAddress("PRECHECK_SIGNER_ADDRESS");
        address relayer = vm.envAddress("RULING_RELAYER_ADDRESS");
        BridgeMode mode = _mode(vm.envString("HEDERA_BRIDGE_MODE"));
        require(pool != address(0) && signer != address(0) && relayer != address(0), "Deploy: zero role address");
        VaultParams memory vp = _vaultParams("preLock");

        vm.startBroadcast();
        (, address owner,) = vm.readCallers();
        vault = new DepositVault(RecourseAddresses.HEDERA_USDC, pool, owner);
        claims = new RecourseClaims(router, link, address(vault), RecourseAddresses.ARBITRUM_SELECTOR, owner);
        vault.bindClaims(address(claims));
        vault.setParams(vp.topUpWindow, vp.exitDelay, vp.minDeposit);
        claims.setParams(_claimsParams("preLock"));
        claims.setPreCheckSigner(signer);
        claims.setBridgeMode(mode, relayer);
        claims.setExtraArgs(BridgeCodec.extraArgsFor(_gasClaimToCourt("preLock")));
        vm.stopBroadcast();

        console2.log("chainId", block.chainid);
        console2.log("DepositVault", address(vault));
        console2.log("RecourseClaims", address(claims));
        console2.log("owner", owner);
        console2.log("pool", pool);
        console2.log("preCheckSigner", signer);
        console2.log("rulingRelayer", relayer);
        console2.log("mode", uint8(mode));
    }

    function _endpoints() internal view returns (address router, address link) {
        if (vm.envOr("HEDERA_REHEARSAL", false)) {
            require(block.chainid != HEDERA_TESTNET && block.chainid != HEDERA_MAINNET, "Deploy: rehearsal on Hedera");
            return (vm.envAddress("HEDERA_ROUTER"), vm.envAddress("HEDERA_LINK"));
        }
        require(block.chainid == HEDERA_TESTNET, "Deploy: chain is not Hedera testnet");
        return (RecourseAddresses.HEDERA_ROUTER, RecourseAddresses.HEDERA_LINK);
    }

    function _mode(string memory name) internal pure returns (BridgeMode) {
        bytes32 h = keccak256(bytes(name));
        if (h == keccak256("Both")) return BridgeMode.Both;
        if (h == keccak256("OutOnly")) return BridgeMode.OutOnly;
        if (h == keccak256("None")) return BridgeMode.None;
        revert("Deploy: HEDERA_BRIDGE_MODE must be Both, OutOnly or None");
    }
}
