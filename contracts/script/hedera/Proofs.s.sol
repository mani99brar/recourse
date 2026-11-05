// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {CCIPLocalRouter} from "@chainlink/local/src/ccip/CCIPLocalRouter.sol";

import {DepositVault} from "../../src/hedera/DepositVault.sol";
import {IDepositVault} from "../../src/hedera/interfaces/IDepositVault.sol";
import {RecourseClaims} from "../../src/hedera/RecourseClaims.sol";
import {BridgeCodec} from "../../src/shared/BridgeCodec.sol";
import {BridgeMode, Claim, ClaimStatus, RecordRefs, RulingBack} from "../../src/shared/RecourseTypes.sol";
import {MockHtsUsdc} from "../../test/hedera/mocks/MockHtsUsdc.sol";
import {HederaScript} from "./HederaScript.sol";

/// @notice LOCAL ONLY. The money proofs against a `DeployLocal` stack, in two stages because the
///         contest window runs on the node's clock:
///
///   stage 1: a deposit in good standing; claim A filed (fee escrowed), pre-checked, contested,
///            sent to court, ruled against the platform (ruling 1) and settled; claim B filed and pre-checked
///            with an answer for the merchant, then left alone.
///   (wrapper: evm_increaseTime past the contest window, evm_mine)
///   stage 2: claim B closed uncontested (fee refunded to the shop), the shop withdraws its whole
///            credit, and the vault's books equal its USDC balance.
///
///   forge script script/hedera/Proofs.s.sol --sig "run(uint8,uint256)" 1 <tag> \
///       --rpc-url http://127.0.0.1:8550 --broadcast --unlocked --sender <an unlocked account>
///
/// `hedera.sh rehearse` runs both stages. Signing is by anvil's unlocked accounts as named in the
/// local deployments file.
contract Proofs is HederaScript {
    uint256 internal constant BASKET = 120e6;
    uint256 internal constant NET_LOSS = 100e6;
    uint256 internal constant ROUTE_TX_GAS = 800_000;

    struct Stack {
        RecourseClaims claims;
        DepositVault vault;
        MockHtsUsdc usdc;
        CCIPLocalRouter router;
        uint64 arbSelector;
        address peer;
        address relayer;
        address signer;
        address platform;
        address shop;
    }

    function run(uint8 stage, uint256 tag) external {
        require(block.chainid != HEDERA_TESTNET && block.chainid != HEDERA_MAINNET, "Proofs: anvil only");
        Stack memory s = _load();
        bytes32 idA = s.claims.claimIdFor(s.platform, s.shop, _nonce(tag, "A"));
        bytes32 idB = s.claims.claimIdFor(s.platform, s.shop, _nonce(tag, "B"));
        if (stage == 1) {
            _stage1(s, tag, idA, idB);
        } else if (stage == 2) {
            _stage2(s, idB);
        } else {
            revert("Proofs: stage must be 1 or 2");
        }
    }

    function _load() internal view returns (Stack memory s) {
        string memory file = vm.envOr("HEDERA_LOCAL_FILE", string("hedera.local.json"));
        string memory json = vm.readFile(string.concat(DEPLOYMENTS_DIR, "/", file));
        s.claims = RecourseClaims(vm.parseJsonAddress(json, ".contracts.claims.address"));
        s.vault = DepositVault(vm.parseJsonAddress(json, ".contracts.vault.address"));
        s.usdc = MockHtsUsdc(vm.parseJsonAddress(json, ".local.usdc"));
        s.router = CCIPLocalRouter(vm.parseJsonAddress(json, ".local.router"));
        s.arbSelector = uint64(vm.parseUint(vm.parseJsonString(json, ".local.arbSelector")));
        s.peer = vm.parseJsonAddress(json, ".local.casePeer");
        s.relayer = vm.parseJsonAddress(json, ".roles.rulingRelayer");
        s.signer = vm.parseJsonAddress(json, ".roles.preCheckSigner");
        s.platform = vm.parseJsonAddress(json, ".roles.platform");
        s.shop = vm.parseJsonAddress(json, ".roles.shop");
    }

    function _stage1(Stack memory s, uint256 tag, bytes32 idA, bytes32 idB) internal {
        require(s.vault.inGoodStanding(s.platform), "deposit proof: platform not in good standing");
        uint256 fee = s.claims.params().courtFeeUsdc;

        // Escrow proof: the shop approves the vault and files; the fee is escrowed.
        vm.startBroadcast(s.shop);
        s.usdc.approve(address(s.vault), 2 * fee);
        s.claims.fileClaim(_nonce(tag, "A"), s.platform, _refs(tag), BASKET, NET_LOSS);
        s.claims.fileClaim(_nonce(tag, "B"), s.platform, _refs(tag), BASKET, NET_LOSS);
        vm.stopBroadcast();
        require(s.vault.escrowOf(idA).state == IDepositVault.EscrowState.Open, "escrow proof: fee A not escrowed");
        require(s.vault.escrowOf(idB).state == IDepositVault.EscrowState.Open, "escrow proof: fee B not escrowed");

        vm.startBroadcast(s.signer);
        s.claims.recordPreCheck(idA, 1, 1, keccak256(abi.encode("pack", idA)));
        s.claims.recordPreCheck(idB, 3, 2, keccak256(abi.encode("pack", idB)));
        vm.stopBroadcast();

        // Claim A: the answer favours the shop, so the platform contests.
        vm.broadcast(s.platform);
        s.claims.contest(idA);
        vm.broadcast(s.relayer); // permissionless call; any funded account works
        s.claims.sendToCourt(idA);
        _deliverRuling(s, idA, 1, 1);
        require(s.claims.getClaim(idA).status == ClaimStatus.Ruled, "claim A not ruled");

        (uint256 toShop,,) = s.claims.previewSettle(idA);
        uint256 creditBefore = s.vault.creditOf(s.shop);
        vm.broadcast(s.relayer); // permissionless call; any funded account works
        s.claims.settle(idA);
        require(s.vault.creditOf(s.shop) == creditBefore + toShop, "settle: shop credit");
        require(s.claims.getClaim(idA).status == ClaimStatus.Settled, "claim A not settled");
        require(s.claims.getClaim(idB).status == ClaimStatus.PreChecked, "claim B not pre-checked");
        _checkBooks(s);
    }

    function _stage2(Stack memory s, bytes32 idB) internal {
        Claim memory b = s.claims.getClaim(idB);
        require(b.status == ClaimStatus.PreChecked, "claim B not pre-checked");
        require(block.timestamp > uint256(b.preCheckedAt) + s.claims.params().contestWindow, "window still open");

        uint256 fee = s.vault.escrowOf(idB).amount;
        uint256 creditBefore = s.vault.creditOf(s.shop);
        vm.broadcast(s.relayer); // permissionless call; any funded account works
        s.claims.closeUncontested(idB);
        require(s.vault.creditOf(s.shop) == creditBefore + fee, "U2: fee not refunded");

        // Withdrawal proof: the shop withdraws its whole credit.
        uint256 credit = s.vault.creditOf(s.shop);
        uint256 balanceBefore = s.usdc.balanceOf(s.shop);
        vm.broadcast(s.shop);
        s.vault.withdrawCredit();
        require(s.usdc.balanceOf(s.shop) == balanceBefore + credit, "withdrawal proof: balance");
        require(s.vault.creditOf(s.shop) == 0, "withdrawal proof: credit left");
        _checkBooks(s);
    }

    /// @dev Both: a message from the court peer through the local router's `routeMessage`.
    ///      OutOnly and None: the ruling relayer's `recordRuling`.
    function _deliverRuling(Stack memory s, bytes32 id, uint8 ruling, uint8 attempts) internal {
        if (s.claims.bridgeMode() == BridgeMode.Both) {
            Client.Any2EVMMessage memory m;
            m.messageId = keccak256(abi.encode("local ruling", id, attempts));
            m.sourceChainSelector = s.arbSelector;
            m.sender = abi.encode(s.peer);
            m.data = BridgeCodec.encodeRulingBack(
                RulingBack({version: 1, claimId: id, disputeId: 1, ruling: ruling, attempts: attempts})
            );
            m.destTokenAmounts = new Client.EVMTokenAmount[](0);
            vm.broadcast(s.relayer);
            // The router forwards exactly 400k gas and checks it has that much left, so an
            // estimated gas limit is too low: the transaction's limit is fixed here.
            (bool ok,,) = s.router.routeMessage{gas: ROUTE_TX_GAS}(m, 5_000, 400_000, address(s.claims));
            require(ok, "ruling delivery reverted");
        } else {
            vm.broadcast(s.relayer);
            s.claims.recordRuling(id, 1, ruling, attempts);
        }
    }

    function _checkBooks(Stack memory s) internal view {
        (uint256 deposits, uint256 escrow, uint256 credits) = s.vault.totals();
        require(deposits + escrow + credits == s.usdc.balanceOf(address(s.vault)), "books != vault balance");
        require(s.usdc.balanceOf(address(s.claims)) == 0, "claims holds USDC");
    }

    function _nonce(uint256 tag, string memory which) internal pure returns (bytes32) {
        return keccak256(abi.encode("local proofs", tag, which));
    }

    function _refs(uint256 tag) internal pure returns (RecordRefs memory r) {
        r.topicNum = 4_242_424;
        for (uint256 i; i < 6; ++i) {
            r.seq[i] = uint64(100 + i);
            r.hashes[i] = keccak256(abi.encode("local record", tag, i));
        }
    }
}
