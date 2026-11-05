// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {RecourseCase} from "../../src/arbitrum/RecourseCase.sol";

/// @notice Shared pieces of the RecourseCase deploy scripts: start parameters from the shared parameter set, template text from the court package's
/// golden file, the deploy and configure step, and the JSON of the deploy keys.
abstract contract CaseScript is Script {
    string internal constant GOLDEN = "../packages/court/template/golden.json";
    string internal constant ABI_PATH = "deployments/abi/RecourseCase.json";

    /// @dev The shared parameter set; RecourseCase's start parameters and the RulingBack receive gas come from it.
    string internal constant PARAMS = "../packages/shared/vectors/params.json";

    struct CaseDeploy {
        address router;
        address link;
        address arbitrator;
        address registry;
        uint64 hederaSelector;
        address owner;
        RecourseCase.Params params;
        uint256 relayGas;
        uint256 variant;
        string[4] parts;
        string policyURI;
        address deployed;
        uint256 deployedAtTs;
    }

    /// @dev Start parameters from the shared set. RecourseCase cannot change them after `lockConfig`, so the pre-lock
    /// and locked values must agree.
    function _sharedParams() internal view returns (RecourseCase.Params memory p) {
        string memory j = vm.readFile(PARAMS);
        p.caseDeadline = uint64(_param(j, "caseDeadline"));
        p.maxOpenCases = uint16(_param(j, "maxOpenCases"));
        p.resendGap = uint64(_param(j, "resendGap"));
        p.maxSends = uint8(_param(j, "maxSends"));
    }

    /// @dev Receive gas for `RulingBack` on Hedera, from the shared set.
    function _relayGas() internal view returns (uint256) {
        return _param(vm.readFile(PARAMS), "gasRulingBack");
    }

    function _param(string memory j, string memory name) internal pure returns (uint256 v) {
        v = vm.parseJsonUint(j, string.concat(".preLock.", name));
        require(v == vm.parseJsonUint(j, string.concat(".locked.", name)), string.concat("CaseScript: ", name));
        require(v > 0, string.concat("CaseScript: zero ", name));
    }

    /// @dev Template parts of variant `variant` (1-based, as numbered in the golden file).
    function _parts(uint256 variant) internal view returns (string[4] memory parts) {
        string memory golden = vm.readFile(GOLDEN);
        string memory v = string.concat(".variants[", vm.toString(variant - 1), "]");
        require(vm.keyExistsJson(golden, v), "CaseScript: unknown template variant");
        require(
            vm.parseJsonUint(golden, string.concat(v, ".id")) == variant, "CaseScript: variant order in golden file"
        );
        for (uint256 k = 0; k < 4; k++) {
            parts[k] = string(vm.parseJsonBytes(golden, string.concat(v, ".parts[", vm.toString(k), "]")));
        }
    }

    function _policyURI() internal view returns (string memory) {
        return vm.parseJsonString(vm.readFile(GOLDEN), ".policyURI");
    }

    /// @dev Inside a broadcast: deploys the case (owner = the broadcaster) and sets template text and policy.
    function _deployCase(CaseDeploy memory d) internal returns (RecourseCase rc) {
        rc = new RecourseCase(
            d.router, d.link, d.arbitrator, d.registry, d.hederaSelector, d.owner, d.params, d.relayGas
        );
        rc.setTemplateText(d.parts);
        rc.setPolicyURI(d.policyURI);
        d.deployed = address(rc);
        d.deployedAtTs = block.timestamp;
    }

    // ------------------------------------------------------------------ JSON

    /// @dev The deploy keys as JSON members (no braces), in a fixed order. `startBlock` and `deployTx` are passed
    /// as raw JSON (a number or null, a quoted hash or null).
    function _deployKeys(CaseDeploy memory d, string memory startBlockJson, string memory deployTxJson)
        internal
        view
        returns (string memory)
    {
        RecourseCase rc = RecourseCase(d.deployed);
        string memory head = string.concat(
            _num("chainId", block.chainid),
            ",",
            _raw("contracts", string.concat('{"case":{', _str("address", vm.toString(d.deployed)), "}}")),
            ",",
            _raw("startBlock", startBlockJson),
            ",",
            _raw("deployTx", deployTxJson)
        );
        string memory when =
            string.concat(_str("deployedAt", _iso(d.deployedAtTs)), ",", _str("deployer", vm.toString(d.owner)));
        return string.concat(
            head,
            ",",
            when,
            ",",
            _raw("constructorArgs", _constructorArgs(d)),
            ",",
            _raw("config", _config(d, rc)),
            ",",
            _str("abi", ABI_PATH)
        );
    }

    function _constructorArgs(CaseDeploy memory d) internal pure returns (string memory) {
        string memory addrs = string.concat(
            _str("router", vm.toString(d.router)),
            ",",
            _str("link", vm.toString(d.link)),
            ",",
            _str("arbitrator", vm.toString(d.arbitrator)),
            ",",
            _str("templateRegistry", vm.toString(d.registry)),
            ",",
            _str("owner", vm.toString(d.owner))
        );
        string memory params = string.concat(
            _num("caseDeadline", d.params.caseDeadline),
            ",",
            _num("maxOpenCases", d.params.maxOpenCases),
            ",",
            _num("resendGap", d.params.resendGap),
            ",",
            _num("maxSends", d.params.maxSends)
        );
        return string.concat(
            "{",
            addrs,
            ",",
            _str("hederaSelector", vm.toString(uint256(d.hederaSelector))),
            ",",
            _raw("params", string.concat("{", params, "}")),
            ",",
            _num("relayGasLimit", d.relayGas),
            "}"
        );
    }

    function _config(CaseDeploy memory d, RecourseCase rc) internal view returns (string memory) {
        string memory a = string.concat(
            _str("templateTag", rc.TEMPLATE_TAG()),
            ",",
            _num("templateVariant", d.variant),
            ",",
            _str("templateTextHash", vm.toString(keccak256(abi.encode(rc.templateParts())))),
            ",",
            _str("policyURI", rc.policyURI())
        );
        string memory b = string.concat(
            _str("extraArgs", vm.toString(rc.extraArgs())),
            ",",
            _str("extraData", vm.toString(rc.EXTRA_DATA())),
            ",",
            _num("numberOfChoices", rc.NUMBER_OF_CHOICES())
        );
        return string.concat("{", a, ",", b, "}");
    }

    function _str(string memory k, string memory v) internal pure returns (string memory) {
        return string.concat('"', k, '":"', v, '"');
    }

    function _num(string memory k, uint256 v) internal pure returns (string memory) {
        return string.concat('"', k, '":', vm.toString(v));
    }

    function _raw(string memory k, string memory json) internal pure returns (string memory) {
        return string.concat('"', k, '":', json);
    }

    /// @dev Unix seconds to "YYYY-MM-DDTHH:MM:SSZ" (UTC), by the days-to-civil-date conversion.
    function _iso(uint256 ts) internal pure returns (string memory) {
        uint256 z = ts / 86400 + 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097;
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        uint256 day = doy - (153 * mp + 2) / 5 + 1;
        uint256 month = mp < 10 ? mp + 3 : mp - 9;
        uint256 year = yoe + era * 400 + (month <= 2 ? 1 : 0);
        uint256 s = ts % 86400;
        string memory date = string.concat(vm.toString(year), "-", _two(month), "-", _two(day));
        return string.concat(date, "T", _two(s / 3600), ":", _two((s / 60) % 60), ":", _two(s % 60), "Z");
    }

    function _two(uint256 n) internal pure returns (string memory) {
        return n < 10 ? string.concat("0", vm.toString(n)) : vm.toString(n);
    }

    /// @dev Output names are bare file names inside deployments/ that end in `.local.json` (gitignored).
    function _checkLocalName(string memory name) internal pure {
        bytes memory f = bytes(name);
        bytes memory tail = bytes(".local.json");
        require(f.length > tail.length, "CaseScript: output name");
        for (uint256 i; i < f.length; ++i) {
            require(f[i] != "/" && f[i] != "\\", "CaseScript: output must be a bare file name");
        }
        for (uint256 i; i < tail.length; ++i) {
            require(f[f.length - tail.length + i] == tail[i], "CaseScript: output must end in .local.json");
        }
    }
}
