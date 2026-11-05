// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {console2} from "forge-std/console2.sol";
import {CCIPLocalSimulator} from "@chainlink/local/src/ccip/CCIPLocalSimulator.sol";

import {RecourseAddresses} from "../../src/shared/RecourseAddresses.sol";
import {RecourseCase} from "../../src/arbitrum/RecourseCase.sol";
import {MockArbitrator} from "../../test/arbitrum/mocks/MockArbitrator.sol";
import {MockEvidenceModule} from "../../test/arbitrum/mocks/MockEvidenceModule.sol";
import {MockOffRamp} from "../../test/arbitrum/mocks/MockOffRamp.sol";
import {MockTemplateRegistry} from "../../test/arbitrum/mocks/MockTemplateRegistry.sol";
import {CaseScript} from "./CaseScript.sol";

/// @notice LOCAL ONLY. Stands up the Arbitrum side on an anvil node with test mocks: the chainlink-local CCIP router
/// and LINK, a MockArbitrator in place of KlerosCore (`giveRuling(disputeId, ruling)` delivers a ruling), a mock
/// template registry and evidence module, and a MockOffRamp on this node and on the Hedera node (fixed addresses,
/// placed with `anvil_setCode`). Then RecourseCase with the start parameters, template text and policy, a funded
/// fee pool and LINK. Nothing is locked. Writes `deployments/arbitrum.local.json` (gitignored), never
/// `arbitrum.json`.
///
///   anvil --port 8560 &
///   forge script script/arbitrum/DeployLocal.s.sol --rpc-url http://127.0.0.1:8560 --broadcast \
///       --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
///
/// Signing uses anvil's unlocked default account 0 (owner and deployer); no key is read. On a fresh node the case
/// lands at the same address every time (printed and written), so the Hedera side can name it as its peer.
///
/// Env (all optional):
///   LOCAL_CLAIMS_PEER       Hedera claims address to accept claims from; default the claims address in
///                           deployments/hedera.local.json, else none (set it later with `setPeer`)
///   LOCAL_HEDERA_RPC_URL    Hedera anvil that gets the second MockOffRamp (default http://127.0.0.1:8550;
///                           "none" skips it)
///   LOCAL_TEMPLATE_VARIANT  1 (default) or 2
///   LOCAL_ARBITRATION_COST  mock court cost in wei (default 810000000000000, the court 8 testnet cost)
///   LOCAL_FIRST_DISPUTE_ID  first mock dispute id (default 1)
///   LOCAL_FEE_POOL          wei put in the fee pool (default 0.05 ether)
///   LOCAL_TRUSTED_RELAY     address allowed to call relayClaim (default none)
///   LOCAL_ARB_RPC_URL       URL of this node, recorded as `rpcUrl` (default http://127.0.0.1:8560)
///   ARBITRUM_LOCAL_FILE     output file name inside deployments/, must end in .local.json
///
/// Messages between the two nodes are carried by packages/court's local relay, which reads each send on one node
/// and delivers it on the other through that node's local router, then sets the MockOffRamp state there.
contract DeployLocal is CaseScript {
    /// @dev Fixed addresses for the two MockOffRamps: the one on this node answers for Hedera -> Arbitrum messages,
    /// the one on the Hedera node for Arbitrum -> Hedera messages.
    address internal constant OFFRAMP_ARB = address(uint160(uint256(keccak256("recourse.local.offramp.arbitrum"))));
    address internal constant OFFRAMP_HEDERA = address(uint160(uint256(keccak256("recourse.local.offramp.hedera"))));

    uint256 internal constant LINK_FUNDING = 10 ether;

    struct Mocks {
        address simulator;
        address router;
        address link;
        address arbitrator;
        address registry;
        address evidence;
        bool hederaOffRampPlaced;
    }

    function run() external {
        require(
            block.chainid != RecourseAddresses.ARBITRUM_CHAIN_ID && block.chainid != 42161,
            "DeployLocal: refusing to run on an Arbitrum network"
        );
        string memory file = vm.envOr("ARBITRUM_LOCAL_FILE", string("arbitrum.local.json"));
        _checkLocalName(file);
        uint256 variant = vm.envOr("LOCAL_TEMPLATE_VARIANT", uint256(1));
        address claimsPeer = _claimsPeer();
        address relay = vm.envOr("LOCAL_TRUSTED_RELAY", address(0));
        uint256 startBlock = block.number;

        // Fails here, before anything is sent, on a node that is not anvil.
        _place(OFFRAMP_ARB);
        bool hederaPlaced = _placeOnHedera();

        (, address sender,) = vm.readCallers();
        Mocks memory m;
        CaseDeploy memory d;
        d.hederaSelector = RecourseAddresses.HEDERA_SELECTOR;
        d.owner = sender;
        d.params = _sharedParams();
        d.relayGas = _relayGas();
        d.claimTimeout = _claimTimeout();
        d.variant = variant;
        d.parts = _parts(variant);
        d.policyURI = _policyURI();

        vm.startBroadcast();
        CCIPLocalSimulator sim = new CCIPLocalSimulator();
        (m.router, m.link) = _routerAndLink(sim);
        m.simulator = address(sim);
        m.arbitrator = address(
            new MockArbitrator(
                vm.envOr("LOCAL_ARBITRATION_COST", uint256(810_000_000_000_000)),
                vm.envOr("LOCAL_FIRST_DISPUTE_ID", uint256(1))
            )
        );
        m.registry = address(new MockTemplateRegistry());
        m.evidence = address(new MockEvidenceModule());
        d.router = m.router;
        d.link = m.link;
        d.arbitrator = m.arbitrator;
        d.registry = m.registry;

        RecourseCase rc = _deployCase(d);
        if (claimsPeer != address(0)) rc.setPeer(claimsPeer);
        if (relay != address(0)) rc.setTrustedRelay(relay);
        rc.fundFeePool{value: vm.envOr("LOCAL_FEE_POOL", uint256(0.05 ether))}();
        sim.requestLinkFromFaucet(address(rc), LINK_FUNDING);
        vm.stopBroadcast();

        m.hederaOffRampPlaced = hederaPlaced;
        string memory json = _localJson(d, m, startBlock);
        string memory path = string.concat(vm.projectRoot(), "/../deployments/", file);
        vm.writeFile(path, json);

        console2.log("RecourseCase (local)", address(rc));
        console2.log("claims peer", claimsPeer);
        console2.log("wrote", path);
    }

    function _claimsPeer() internal view returns (address) {
        address fromEnv = vm.envOr("LOCAL_CLAIMS_PEER", address(0));
        if (fromEnv != address(0)) return fromEnv;
        string memory hederaFile = string.concat(vm.projectRoot(), "/../deployments/hedera.local.json");
        if (!vm.exists(hederaFile)) return address(0);
        string memory j = vm.readFile(hederaFile);
        if (!vm.keyExistsJson(j, ".contracts.claims.address")) return address(0);
        return vm.parseJsonAddress(j, ".contracts.claims.address");
    }

    /// @dev `configuration()` returns contract types from several OZ copies; read it as plain addresses.
    function _routerAndLink(CCIPLocalSimulator sim) internal view returns (address router, address link) {
        (bool ok, bytes memory ret) = address(sim).staticcall(abi.encodeCall(CCIPLocalSimulator.configuration, ()));
        require(ok, "DeployLocal: simulator configuration");
        (, router,,, link,,) = abi.decode(ret, (uint64, address, address, address, address, address, address));
    }

    /// @dev MockOffRamp keeps no constructor state, so its runtime code alone is enough.
    function _place(address target) internal {
        bytes memory code = type(MockOffRamp).runtimeCode;
        vm.etch(target, code);
        vm.rpc("anvil_setCode", _setCodeParams(target, code));
    }

    function _placeOnHedera() internal returns (bool) {
        string memory url = vm.envOr("LOCAL_HEDERA_RPC_URL", string("http://127.0.0.1:8550"));
        if (keccak256(bytes(url)) == keccak256("none")) return false;
        try vm.rpc(url, "anvil_setCode", _setCodeParams(OFFRAMP_HEDERA, type(MockOffRamp).runtimeCode)) {
            return true;
        } catch {
            console2.log("Hedera anvil not reachable; the Hedera MockOffRamp was not placed:", url);
            return false;
        }
    }

    function _setCodeParams(address target, bytes memory code) internal pure returns (string memory) {
        return string.concat('["', vm.toString(target), '","', vm.toString(code), '"]');
    }

    function _localJson(CaseDeploy memory d, Mocks memory m, uint256 startBlock) internal view returns (string memory) {
        string memory mocks = string.concat(
            _str("arbitrator", vm.toString(m.arbitrator)),
            ",",
            _str("templateRegistry", vm.toString(m.registry)),
            ",",
            _str("evidenceModule", vm.toString(m.evidence)),
            ",",
            _str("router", vm.toString(m.router)),
            ",",
            _str("link", vm.toString(m.link)),
            ",",
            _str("offRamp", vm.toString(OFFRAMP_ARB))
        );
        string memory outside = string.concat(
            m.hederaOffRampPlaced ? _str("offRampHedera", vm.toString(OFFRAMP_HEDERA)) : _raw("offRampHedera", "null"),
            ",",
            _str("offRampArb", vm.toString(OFFRAMP_ARB)),
            ",",
            _str("klerosCore", vm.toString(m.arbitrator)),
            ",",
            _str("evidenceModule", vm.toString(m.evidence))
        );
        return string.concat(
            "{",
            _deployKeys(d, vm.toString(startBlock), "null"),
            ",",
            _str("rpcUrl", vm.envOr("LOCAL_ARB_RPC_URL", string("http://127.0.0.1:8560"))),
            ",",
            _raw("mocks", string.concat("{", mocks, "}")),
            ",",
            _raw("outside", string.concat("{", outside, "}")),
            ",",
            _raw("mocksOnly", "true"),
            "}\n"
        );
    }
}
