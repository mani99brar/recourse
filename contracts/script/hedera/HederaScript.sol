// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";

import {IRecourseClaims} from "../../src/hedera/interfaces/IRecourseClaims.sol";

/// @notice Shared pieces of the Hedera scripts: the parameter file, the two parameter stages and
///         small JSON writers for the deployment files.
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
