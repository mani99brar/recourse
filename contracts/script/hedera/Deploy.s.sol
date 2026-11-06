// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {console2} from "forge-std/console2.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

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
/// (Both, OutOnly or None), HEDERA_USDC_MODE (circle, the default: Circle's testnet USDC; or mock:
/// the MockUsdc at USDC_ADDRESS, from DeployMockUsdc.s.sol). A rehearsal on anvil sets
/// HEDERA_REHEARSAL=1 plus HEDERA_ROUTER and HEDERA_LINK (the local router and LINK); the chain id
/// then must not be a Hedera one.
contract Deploy is HederaScript {
    function run() external returns (DepositVault vault, RecourseClaims claims) {
        (address router, address link) = _endpoints();
        address pool = vm.envAddress("POOL_ADDRESS");
        address signer = vm.envAddress("PRECHECK_SIGNER_ADDRESS");
        address relayer = vm.envAddress("RULING_RELAYER_ADDRESS");
        BridgeMode mode = _mode(vm.envString("HEDERA_BRIDGE_MODE"));
        require(pool != address(0) && signer != address(0) && relayer != address(0), "Deploy: zero role address");
        string memory usdcMode = vm.envOr("HEDERA_USDC_MODE", string("circle"));
        address usdc = _usdc(usdcMode, vm.envOr("USDC_ADDRESS", address(0)));
        VaultParams memory vp = _vaultParams("preLock");

        vm.startBroadcast();
        (, address owner,) = vm.readCallers();
        vault = new DepositVault(usdc, pool, owner);
        claims = new RecourseClaims(router, link, address(vault), RecourseAddresses.ARBITRUM_SELECTOR, owner);
        vault.bindClaims(address(claims));
        vault.setParams(vp.topUpWindow, vp.exitDelay, vp.minDeposit);
        claims.setParams(_claimsParams("preLock"));
        claims.setPreCheckSigner(signer);
        claims.setBridgeMode(mode, relayer);
        claims.setExtraArgs(BridgeCodec.extraArgsFor(_gasClaimToCourt("preLock")));
        vm.stopBroadcast();

        console2.log("chainId", block.chainid);
        console2.log("usdcMode", usdcMode);
        console2.log("usdc", usdc);
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

    /// @dev The vault's token for HEDERA_USDC_MODE, and each mode refuses the other's token. `circle`
    ///      is Circle's testnet USDC, and USDC_ADDRESS, if set at all, may only repeat it. `mock` is
    ///      the token at USDC_ADDRESS, which must not be Circle's and must have code, 6 decimals and
    ///      the symbol mUSDC, as MockUsdc has.
    function _usdc(string memory mode, address given) internal view returns (address) {
        bytes32 h = keccak256(bytes(mode));
        if (h == keccak256("circle")) {
            require(
                given == address(0) || given == RecourseAddresses.HEDERA_USDC,
                "Deploy: USDC_ADDRESS is not Circle's USDC; set HEDERA_USDC_MODE=mock for a mock"
            );
            return RecourseAddresses.HEDERA_USDC;
        }
        require(h == keccak256("mock"), "Deploy: HEDERA_USDC_MODE must be circle or mock");
        require(given != address(0), "Deploy: mock mode needs USDC_ADDRESS");
        require(given != RecourseAddresses.HEDERA_USDC, "Deploy: USDC_ADDRESS is Circle's USDC, not a mock");
        require(given.code.length != 0, "Deploy: no code at USDC_ADDRESS");
        (bool ok, bytes memory ret) = given.staticcall(abi.encodeCall(IERC20Metadata.decimals, ()));
        require(
            ok && ret.length == 32 && abi.decode(ret, (uint256)) == 6, "Deploy: USDC_ADDRESS does not have 6 decimals"
        );
        (ok, ret) = given.staticcall(abi.encodeCall(IERC20Metadata.symbol, ()));
        require(
            ok && ret.length >= 64 && keccak256(bytes(abi.decode(ret, (string)))) == keccak256("mUSDC"),
            "Deploy: USDC_ADDRESS is not a mock USDC (symbol mUSDC)"
        );
        return given;
    }
}
