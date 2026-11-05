// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DepositVault} from "../../src/hedera/DepositVault.sol";
import {RecourseClaims} from "../../src/hedera/RecourseClaims.sol";
import {IRecourseClaims} from "../../src/hedera/interfaces/IRecourseClaims.sol";
import {BridgeMode} from "../../src/shared/RecourseTypes.sol";
import {HederaScript} from "./HederaScript.sol";

/// @notice Read-only check of the recorded deployment. Prints one OK or FAIL line per check and
///         reverts if any check fails. Never broadcasts; needs no key.
///
///   forge script script/hedera/Check.s.sol --rpc-url "$HEDERA_RPC_URL_1"
///
/// The mirror node's association row is checked by `hedera.sh check`, next to this.
/// CHECK_EXPECT_LOCKED=1 also requires both contracts locked with the locked parameters.
contract Check is HederaScript {
    uint256 internal failures;

    function run() external {
        _requireChain();
        (RecourseClaims claims, DepositVault vault, string memory json) = _loadDeployed();
        _readBacks(claims, vault);

        _check("code at both addresses", address(claims).code.length != 0 && address(vault).code.length != 0);
        _check("vault.claims is claims", vault.claims() == address(claims));
        _check("claims.vault is vault", claims.vault() == address(vault));
        _check("one owner for both", claims.owner() == vault.owner());
        _check("vault associated with USDC", vault.usdcAssociated());
        _check("pre-check signer set", claims.preCheckSigner() != address(0));
        _check("ruling relayer set", claims.rulingRelayer() != address(0));
        _check("mode as recorded", uint256(claims.bridgeMode()) == vm.parseJsonUint(json, ".mode"));
        _check("peer set (or mode None)", claims.bridgeMode() == BridgeMode.None || claims.peer() != address(0));
        _check(
            "extra args as recorded", keccak256(claims.extraArgs()) == keccak256(vm.parseJsonBytes(json, ".extraArgs"))
        );

        bool locked = claims.configLocked() && vault.configLocked();
        _check("lock state agrees", claims.configLocked() == vault.configLocked());
        string memory stage = locked ? "locked" : "preLock";
        _check(string.concat("claims params are ", stage), _sameClaimsParams(claims.params(), _claimsParams(stage)));
        _check(string.concat("vault params are ", stage), _sameVaultParams(vault, _vaultParams(stage)));
        if (vm.envOr("CHECK_EXPECT_LOCKED", false)) _check("both locked", locked);

        (uint256 deposits, uint256 escrow, uint256 credits) = vault.totals();
        uint256 held = _nodeCallUint(vault.usdc(), abi.encodeCall(IERC20.balanceOf, (address(vault))));
        console2.log("totals (deposits, escrow, credits)", deposits, escrow, credits);
        console2.log("vault USDC balance", held);
        _check("totals equal the vault's USDC balance", deposits + escrow + credits == held);
        _check(
            "claims holds no USDC",
            _nodeCallUint(vault.usdc(), abi.encodeCall(IERC20.balanceOf, (address(claims)))) == 0
        );

        uint256 linkHeld = _nodeCallUint(claims.link(), abi.encodeCall(IERC20.balanceOf, (address(claims))));
        console2.log("claims LINK balance", linkHeld);

        if (failures != 0) revert(string.concat("Check: ", vm.toString(failures), " check(s) failed"));
        console2.log("Check: all OK");
    }

    function _check(string memory name, bool ok) internal {
        console2.log(ok ? "OK  " : "FAIL", name);
        if (!ok) ++failures;
    }

    function _sameClaimsParams(IRecourseClaims.Params memory a, IRecourseClaims.Params memory b)
        internal
        pure
        returns (bool)
    {
        return keccak256(abi.encode(a)) == keccak256(abi.encode(b));
    }

    function _sameVaultParams(DepositVault vault, VaultParams memory want) internal view returns (bool) {
        (uint64 topUpWindow, uint64 exitDelay, uint256 minDeposit) = vault.params();
        return topUpWindow == want.topUpWindow && exitDelay == want.exitDelay && minDeposit == want.minDeposit;
    }
}
