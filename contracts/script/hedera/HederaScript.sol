// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {DepositVault} from "../../src/hedera/DepositVault.sol";
import {RecourseClaims} from "../../src/hedera/RecourseClaims.sol";
import {IRecourseClaims} from "../../src/hedera/interfaces/IRecourseClaims.sol";

/// @notice Shared pieces of the Hedera scripts: the parameter file, the two parameter stages, the
///         deployments file, read-backs and small JSON writers.
abstract contract HederaScript is Script {
    /// @dev Relative to the contracts project root, which is where forge runs scripts from.
    string internal constant PARAMS_FILE = "../packages/shared/vectors/params.json";
    string internal constant DEPLOYMENTS_DIR = "../deployments";

    uint256 internal constant HEDERA_MAINNET = 295;
    uint256 internal constant HEDERA_TESTNET = 296;

    struct VaultParams {
        uint64 topUpWindow;
        uint64 exitDelay;
        uint256 minDeposit;
    }

    // ------------------------------------------------------------ chain and deployments file

    /// @dev Hedera testnet, or a rehearsal (HEDERA_REHEARSAL=1) on a chain that is not Hedera.
    function _requireChain() internal view {
        if (vm.envOr("HEDERA_REHEARSAL", false)) {
            require(block.chainid != HEDERA_TESTNET && block.chainid != HEDERA_MAINNET, "rehearsal on a Hedera chain");
        } else {
            require(block.chainid == HEDERA_TESTNET, "chain is not Hedera testnet");
        }
    }

    /// @dev Reads `deployments/<HEDERA_FILE>` (default hedera.json) and checks it is for this chain.
    function _loadDeployed() internal view returns (RecourseClaims claims, DepositVault vault, string memory json) {
        string memory file = vm.envOr("HEDERA_FILE", string("hedera.json"));
        json = vm.readFile(string.concat(DEPLOYMENTS_DIR, "/", file));
        require(vm.parseJsonUint(json, ".chainId") == block.chainid, "deployments file is for another chain");
        claims = RecourseClaims(vm.parseJsonAddress(json, ".contracts.claims.address"));
        vault = DepositVault(vm.parseJsonAddress(json, ".contracts.vault.address"));
        require(address(claims).code.length != 0 && address(vault).code.length != 0, "no code at a recorded address");
    }

    /// @dev Prints what the wiring and lock steps are checked against.
    function _readBacks(RecourseClaims claims, DepositVault vault) internal view {
        console2.log("claims", address(claims));
        console2.log("vault", address(vault));
        console2.log("claims.vault", claims.vault());
        console2.log("vault.claims", vault.claims());
        console2.log("owner (claims, vault)", claims.owner(), vault.owner());
        console2.log("peer", claims.peer());
        console2.log("preCheckSigner", claims.preCheckSigner());
        console2.log("bridgeMode", uint8(claims.bridgeMode()));
        console2.log("rulingRelayer", claims.rulingRelayer());
        console2.log("feeToken", claims.feeToken());
        console2.logBytes(claims.extraArgs());
        console2.log("usdcAssociated", vault.usdcAssociated());
        console2.log("configLocked (claims, vault)", claims.configLocked(), vault.configLocked());
        IRecourseClaims.Params memory p = claims.params();
        console2.log("contestWindow, claimTimeout", p.contestWindow, p.claimTimeout);
        (uint64 topUpWindow, uint64 exitDelay, uint256 minDeposit) = vault.params();
        console2.log("topUpWindow, exitDelay, minDeposit", topUpWindow, exitDelay, minDeposit);
    }

    /// @dev A view call sent to the node itself rather than run in the script's fork. Token
    ///      facades on Hedera forward to the HTS system contract, which a fork cannot execute.
    function _nodeCallUint(address target, bytes memory data) internal returns (uint256) {
        bytes memory ret = vm.rpc(
            "eth_call", string.concat('[{"to":"', vm.toString(target), '","data":"', vm.toString(data), '"},"latest"]')
        );
        require(ret.length == 32, "node call: unexpected return");
        return abi.decode(ret, (uint256));
    }

    // ------------------------------------------------------------ parameters

    /// @param stage "preLock" or "locked".
    function _claimsParams(string memory stage) internal view returns (IRecourseClaims.Params memory p) {
        string memory json = vm.readFile(PARAMS_FILE);
        p.contestWindow = _u64(_num(json, stage, "contestWindow"));
        p.claimTimeout = _u64(_num(json, stage, "claimTimeout"));
        p.courtFeeUsdc = _num(json, stage, "courtFeeUsdc");
        p.handlingBase = _num(json, stage, "handlingBase");
        uint256 bps = _num(json, stage, "handlingBps");
        require(bps <= type(uint16).max, "params: handlingBps");
        p.handlingBps = uint16(bps);
        p.handlingCap = _num(json, stage, "handlingCap");
        p.resendGap = _u64(_num(json, stage, "resendGap"));
        uint256 sends = _num(json, stage, "maxSends");
        require(sends <= type(uint8).max, "params: maxSends");
        p.maxSends = uint8(sends);
    }

    function _vaultParams(string memory stage) internal view returns (VaultParams memory v) {
        string memory json = vm.readFile(PARAMS_FILE);
        v.topUpWindow = _u64(_num(json, stage, "topUpWindow"));
        v.exitDelay = _u64(_num(json, stage, "exitDelay"));
        v.minDeposit = _num(json, stage, "minDeposit");
    }

    function _gasClaimToCourt(string memory stage) internal view returns (uint256) {
        return _num(vm.readFile(PARAMS_FILE), stage, "gasClaimToCourt");
    }

    function _gasRulingBack(string memory stage) internal view returns (uint256) {
        return _num(vm.readFile(PARAMS_FILE), stage, "gasRulingBack");
    }

    function _num(string memory json, string memory stage, string memory key) private pure returns (uint256) {
        return vm.parseJsonUint(json, string.concat(".", stage, ".", key));
    }

    function _u64(uint256 x) private pure returns (uint64) {
        require(x <= type(uint64).max, "params: over uint64");
        return uint64(x);
    }

    // ------------------------------------------------------------ JSON

    /// @dev `"key":"value"` with the value quoted.
    function _qs(string memory key, string memory value) internal pure returns (string memory) {
        return string.concat('"', key, '":"', value, '"');
    }

    /// @dev `"key":"0x..."`.
    function _qa(string memory key, address value) internal pure returns (string memory) {
        return _qs(key, vm.toString(value));
    }

    /// @dev `"key":<raw>` for numbers, objects, arrays and null.
    function _qr(string memory key, string memory raw) internal pure returns (string memory) {
        return string.concat('"', key, '":', raw);
    }

    function _qn(string memory key, uint256 value) internal pure returns (string memory) {
        return _qr(key, vm.toString(value));
    }

    /// @dev Joins members with commas inside braces.
    function _obj(string[] memory members) internal pure returns (string memory out) {
        out = "{";
        for (uint256 i; i < members.length; ++i) {
            out = string.concat(out, i == 0 ? "" : ",", members[i]);
        }
        out = string.concat(out, "}");
    }

    function _paramsJson(string memory stage) internal view returns (string memory) {
        IRecourseClaims.Params memory p = _claimsParams(stage);
        VaultParams memory v = _vaultParams(stage);
        string[] memory m = new string[](13);
        m[0] = _qn("contestWindow", p.contestWindow);
        m[1] = _qn("claimTimeout", p.claimTimeout);
        m[2] = _qn("courtFeeUsdc", p.courtFeeUsdc);
        m[3] = _qn("handlingBase", p.handlingBase);
        m[4] = _qn("handlingBps", p.handlingBps);
        m[5] = _qn("handlingCap", p.handlingCap);
        m[6] = _qn("resendGap", p.resendGap);
        m[7] = _qn("maxSends", p.maxSends);
        m[8] = _qn("topUpWindow", v.topUpWindow);
        m[9] = _qn("exitDelay", v.exitDelay);
        m[10] = _qn("minDeposit", v.minDeposit);
        m[11] = _qn("gasClaimToCourt", _gasClaimToCourt(stage));
        m[12] = _qn("gasRulingBack", _num(vm.readFile(PARAMS_FILE), stage, "gasRulingBack"));
        return _obj(m);
    }
}
