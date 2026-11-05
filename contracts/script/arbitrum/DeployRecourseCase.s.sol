// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {console2} from "forge-std/console2.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {IArbitratorV2} from "@kleros/kleros-v2-contracts/arbitration/interfaces/IArbitratorV2.sol";

import {RecourseAddresses as A} from "../../src/shared/RecourseAddresses.sol";
import {RecourseCase} from "../../src/arbitrum/RecourseCase.sol";
import {CaseScript} from "./CaseScript.sol";

/// @notice Deploys RecourseCase on Arbitrum Sepolia against the live KlerosCore, DisputeTemplateRegistry, CCIP
/// Router and LINK, then sets the template text of the chosen variant and the court policy URI. The broadcaster
/// is the owner. Peer, LINK, fee pool and lock are separate owner steps, not done here.
///
/// Run it through `script/arbitrum/deploy.sh`, which signs from the deployer keystore, and after a broadcast fills
/// `deployTx` and `startBlock` from the receipt and merges the deploy keys into deployments/arbitrum.json. This
/// script writes the deploy keys to deployments/arbitrum.deploy.local.json (gitignored) with those two as null.
///
/// Env (optional): CASE_TEMPLATE_VARIANT (1 default, or 2).
contract DeployRecourseCase is CaseScript {
    string internal constant FRAGMENT = "arbitrum.deploy.local.json";

    function run() external returns (RecourseCase rc) {
        require(block.chainid == A.ARBITRUM_CHAIN_ID, "DeployRecourseCase: not Arbitrum Sepolia");
        _preflight();

        (, address sender,) = vm.readCallers();
        CaseDeploy memory d;
        d.router = A.ARBITRUM_ROUTER;
        d.link = A.ARBITRUM_LINK;
        d.arbitrator = A.KLEROS_CORE;
        d.registry = A.DISPUTE_TEMPLATE_REGISTRY;
        d.hederaSelector = A.HEDERA_SELECTOR;
        d.owner = sender;
        d.params = _defaultParams();
        d.relayGas = RELAY_GAS;
        d.variant = vm.envOr("CASE_TEMPLATE_VARIANT", uint256(1));
        d.parts = _parts(d.variant);
        d.policyURI = _policyURI();

        vm.startBroadcast();
        rc = _deployCase(d);
        vm.stopBroadcast();

        _check(rc, d);
        string memory path = string.concat(vm.projectRoot(), "/../deployments/", FRAGMENT);
        vm.writeFile(path, string.concat("{", _deployKeys(d, "null", "null"), "}\n"));
        console2.log("RecourseCase", address(rc));
        console2.log("owner", sender);
        console2.log("live arbitration cost (wei)", rc.costNow());
        console2.log("deploy keys written to", path);
    }

    /// @dev Read-only checks on the live contracts the case depends on.
    function _preflight() internal view {
        require(A.KLEROS_CORE.code.length > 0, "DeployRecourseCase: no KlerosCore code");
        require(A.DISPUTE_TEMPLATE_REGISTRY.code.length > 0, "DeployRecourseCase: no template registry code");
        require(A.ARBITRUM_ROUTER.code.length > 0, "DeployRecourseCase: no CCIP router code");
        require(A.ARBITRUM_LINK.code.length > 0, "DeployRecourseCase: no LINK code");
        require(
            IRouterClient(A.ARBITRUM_ROUTER).isChainSupported(A.HEDERA_SELECTOR),
            "DeployRecourseCase: router has no Hedera lane"
        );
        bytes memory extraData = abi.encode(uint256(8), uint256(3), uint256(1));
        uint256 cost = IArbitratorV2(A.KLEROS_CORE).arbitrationCost(extraData);
        require(cost > 0, "DeployRecourseCase: court 8 cost is zero");
    }

    /// @dev The deployed contract reads back exactly what was configured.
    function _check(RecourseCase rc, CaseDeploy memory d) internal view {
        require(rc.owner() == d.owner, "DeployRecourseCase: owner");
        require(rc.arbitrator() == d.arbitrator && rc.templateRegistry() == d.registry, "DeployRecourseCase: court");
        require(rc.link() == d.link && rc.hederaSelector() == d.hederaSelector, "DeployRecourseCase: ccip");
        require(keccak256(abi.encode(rc.templateParts())) == keccak256(abi.encode(d.parts)), "DeployRecourseCase: text");
        require(keccak256(bytes(rc.policyURI())) == keccak256(bytes(d.policyURI)), "DeployRecourseCase: policy");
        require(rc.peer() == address(0) && !rc.locked() && rc.feePool() == 0, "DeployRecourseCase: fresh state");
        require(rc.costNow() > 0, "DeployRecourseCase: cost");
    }
}
