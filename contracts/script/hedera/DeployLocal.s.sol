// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {CCIPLocalRouter} from "@chainlink/local/src/ccip/CCIPLocalRouter.sol";
import {CCIPLocalSimulator} from "@chainlink/local/src/ccip/CCIPLocalSimulator.sol";
import {LinkToken} from "@chainlink/local/src/shared/LinkToken.sol";

import {DepositVault} from "../../src/hedera/DepositVault.sol";
import {RecourseClaims} from "../../src/hedera/RecourseClaims.sol";
import {BridgeCodec} from "../../src/shared/BridgeCodec.sol";
import {RecourseAddresses} from "../../src/shared/RecourseAddresses.sol";
import {BridgeMode} from "../../src/shared/RecourseTypes.sol";
import {MockHTS} from "../../test/hedera/mocks/MockHTS.sol";
import {MockHtsUsdc} from "../../test/hedera/mocks/MockHtsUsdc.sol";
import {MockPRNG} from "../../test/hedera/mocks/MockPRNG.sol";
import {HederaScript} from "./HederaScript.sol";

/// @notice LOCAL ONLY. Stands up the whole Hedera side on an anvil node: test mocks for the HTS
///         system contract (0x167), the PRNG (0x169) and the USDC facade (same address as on
///         testnet), the chainlink-local CCIP router and LINK, then a bound, associated and wired
///         DepositVault and RecourseClaims with the pre-lock parameters, a platform in good
///         standing and a funded shop. Nothing is locked, so the 10-minute contest window applies
///         (`evm_increaseTime` moves it). Writes `deployments/hedera.local.json` (gitignored).
///
///   anvil --port 8550 &
///   forge script script/hedera/DeployLocal.s.sol --rpc-url http://127.0.0.1:8550 --broadcast \
///       --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
///
/// Signing uses anvil's own unlocked default accounts; no key is read. Roles (anvil index):
/// owner 0, ruling relayer 1, pre-check signer 2, platform 3, shop 4, pool 5, court peer 9.
///
/// Env (all optional):
///   LOCAL_BRIDGE_MODE  Both (default), OutOnly or None
///   LOCAL_CASE_PEER    court-side peer address; default anvil account 9, a plain address the local
///                      router accepts sends to without calling it
///   LOCAL_FEE_TOKEN    link (default) or native
///   LOCAL_CCIP_FEE     fee the local router charges per send, in the fee token's units (default 0)
///   LOCAL_ARB_SELECTOR source selector the claims contract accepts rulings from (default Arbitrum
///                      Sepolia's)
///   HEDERA_LOCAL_FILE  output file name inside deployments/, must end in .local.json
///
/// A ruling is delivered locally by calling the router's permissionless
/// `routeMessage(Any2EVMMessage{messageId, sourceChainSelector: arbSelector, sender: abi.encode(peer),
/// data: BridgeCodec.encodeRulingBack(...), destTokenAmounts: []}, 5000, 400000, claims)`.
/// Sends from claims are recorded by the local router (`SentToCourt` carries the message id) but
/// delivered nowhere while the peer has no code.
contract DeployLocal is HederaScript {
    address internal constant ANVIL_0 = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address internal constant ANVIL_1 = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address internal constant ANVIL_2 = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    address internal constant ANVIL_3 = 0x90F79bf6EB2c4f870365E785982E1f101E93b906;
    address internal constant ANVIL_4 = 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65;
    address internal constant ANVIL_5 = 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc;
    address internal constant ANVIL_9 = 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720;

    uint256 internal constant USDC_UNIT = 1e6;
    uint256 internal constant PLATFORM_MINT = 10_000 * USDC_UNIT;
    uint256 internal constant SHOP_MINT = 1_000 * USDC_UNIT;
    uint256 internal constant DEPOSIT = 5_000 * USDC_UNIT;
    uint256 internal constant CLAIMS_LINK = 10 ether;
    uint256 internal constant CLAIMS_NATIVE = 10 ether;

    address internal constant HTS = RecourseAddresses.HEDERA_HTS;
    address internal constant PRNG = RecourseAddresses.HEDERA_PRNG;
    address internal constant USDC = RecourseAddresses.HEDERA_USDC;

    struct Roles {
        address owner;
        address relayer;
        address signer;
        address platform;
        address shop;
        address pool;
        address peer;
    }

    struct Setup {
        BridgeMode mode;
        bool native;
        uint256 ccipFee;
        uint64 arbSelector;
        string file;
    }

    struct Deployed {
        CCIPLocalSimulator sim;
        address router;
        address link;
        DepositVault vault;
        RecourseClaims claims;
        uint256 startBlock;
        uint256 startTime;
    }

    function run() external returns (address claims, address vault) {
        require(block.chainid != HEDERA_TESTNET && block.chainid != HEDERA_MAINNET, "DeployLocal: Hedera chain");
        Roles memory r = Roles({
            owner: ANVIL_0,
            relayer: ANVIL_1,
            signer: ANVIL_2,
            platform: ANVIL_3,
            shop: ANVIL_4,
            pool: ANVIL_5,
            peer: vm.envOr("LOCAL_CASE_PEER", ANVIL_9)
        });
        Setup memory s = _setup();

        _placeMocks();
        Deployed memory d = _deploy(r, s);
        _fundParties(r, d);
        _writeJson(r, s, d);
        return (address(d.claims), address(d.vault));
    }

    function _setup() internal view returns (Setup memory s) {
        bytes32 mode = keccak256(bytes(vm.envOr("LOCAL_BRIDGE_MODE", string("Both"))));
        if (mode == keccak256("Both")) s.mode = BridgeMode.Both;
        else if (mode == keccak256("OutOnly")) s.mode = BridgeMode.OutOnly;
        else if (mode == keccak256("None")) s.mode = BridgeMode.None;
        else revert("DeployLocal: LOCAL_BRIDGE_MODE must be Both, OutOnly or None");

        bytes32 token = keccak256(bytes(vm.envOr("LOCAL_FEE_TOKEN", string("link"))));
        require(token == keccak256("link") || token == keccak256("native"), "DeployLocal: LOCAL_FEE_TOKEN");
        s.native = token == keccak256("native");
        s.ccipFee = vm.envOr("LOCAL_CCIP_FEE", uint256(0));
        s.arbSelector = uint64(vm.envOr("LOCAL_ARB_SELECTOR", uint256(RecourseAddresses.ARBITRUM_SELECTOR)));

        s.file = vm.envOr("HEDERA_LOCAL_FILE", string("hedera.local.json"));
        bytes memory f = bytes(s.file);
        bytes memory tail = bytes(".local.json");
        require(f.length > tail.length, "DeployLocal: HEDERA_LOCAL_FILE");
        for (uint256 i; i < f.length; ++i) {
            require(f[i] != "/" && f[i] != "\\", "DeployLocal: HEDERA_LOCAL_FILE must be a bare name");
        }
        for (uint256 i; i < tail.length; ++i) {
            require(f[f.length - tail.length + i] == tail[i], "DeployLocal: HEDERA_LOCAL_FILE must end in .local.json");
        }
    }

    /// @dev Etches the mocks into the script's fork and sets the same runtime code on the node.
    ///      The mocks keep no constructor state, so runtime code alone is enough. `anvil_setCode`
    ///      fails on any node that is not anvil, before anything is broadcast.
    function _placeMocks() internal {
        _place(HTS, address(new MockHTS()).code);
        _place(PRNG, address(new MockPRNG()).code);
        _place(USDC, address(new MockHtsUsdc()).code);
    }

    function _place(address target, bytes memory code) internal {
        vm.etch(target, code);
        vm.rpc("anvil_setCode", string.concat('["', vm.toString(target), '","', vm.toString(code), '"]'));
    }

    function _deploy(Roles memory r, Setup memory s) internal returns (Deployed memory d) {
        d.startBlock = block.number;
        d.startTime = block.timestamp;
        VaultParams memory vp = _vaultParams("preLock");

        vm.startBroadcast(r.owner);
        d.sim = new CCIPLocalSimulator();
        (, IRouterClient router,,, LinkToken link,,) = d.sim.configuration();
        d.router = address(router);
        d.link = address(link);

        d.vault = new DepositVault(USDC, r.pool, r.owner);
        d.claims = new RecourseClaims(d.router, d.link, address(d.vault), s.arbSelector, r.owner);
        d.vault.bindClaims(address(d.claims));
        d.vault.associateUsdc(false);
        d.vault.setParams(vp.topUpWindow, vp.exitDelay, vp.minDeposit);

        d.claims.setParams(_claimsParams("preLock"));
        d.claims.setPreCheckSigner(r.signer);
        d.claims.setBridgeMode(s.mode, r.relayer);
        if (r.peer != address(0)) d.claims.setPeer(r.peer);
        d.claims.setExtraArgs(BridgeCodec.extraArgsFor(_gasClaimToCourt("preLock")));

        if (s.ccipFee != 0) CCIPLocalRouter(d.router).setFee(s.ccipFee);
        if (s.native) {
            d.claims.setFeeToken(address(0));
            d.claims.fundNative{value: CLAIMS_NATIVE}();
        }
        d.sim.requestLinkFromFaucet(address(d.claims), CLAIMS_LINK);
        vm.stopBroadcast();
    }

    function _fundParties(Roles memory r, Deployed memory d) internal {
        address[3] memory holders = [r.platform, r.shop, r.pool];
        for (uint256 i; i < holders.length; ++i) {
            vm.broadcast(holders[i]);
            MockHtsUsdc(USDC).associate();
        }

        vm.startBroadcast(r.owner);
        MockHtsUsdc(USDC).mint(r.platform, PLATFORM_MINT);
        MockHtsUsdc(USDC).mint(r.shop, SHOP_MINT);
        vm.stopBroadcast();

        vm.startBroadcast(r.platform);
        MockHtsUsdc(USDC).approve(address(d.vault), DEPOSIT);
        d.vault.postDeposit(r.platform, DEPOSIT);
        vm.stopBroadcast();

        vm.broadcast(r.owner);
        d.vault.setRequired(r.platform, DEPOSIT);

        require(d.vault.inGoodStanding(r.platform), "DeployLocal: platform not in good standing");
        require(d.vault.claims() == address(d.claims), "DeployLocal: vault not bound");
    }

    // ------------------------------------------------------------ deployments file

    function _writeJson(Roles memory r, Setup memory s, Deployed memory d) internal {
        string[] memory top = new string[](16);
        top[0] = _qn("chainId", block.chainid);
        top[1] = _qr("contracts", _contractsJson(d));
        top[2] = _qr("deployOrder", '["DepositVault","RecourseClaims"]');
        top[3] = _qs("startTimestamp", string.concat(vm.toString(d.startTime), ".000000000"));
        top[4] = _qn("startBlock", d.startBlock);
        top[5] = _qr("associationTx", "null");
        top[6] = _qn("mode", uint8(s.mode));
        top[7] = _qr(
            "params", string.concat('{"preLock":', _paramsJson("preLock"), ',"locked":', _paramsJson("locked"), "}")
        );
        top[8] = _qs("extraArgs", vm.toString(d.claims.extraArgs()));
        top[9] = _qr(
            "sizes",
            string.concat(
                '{"RecourseClaims":',
                vm.toString(address(d.claims).code.length),
                ',"DepositVault":',
                vm.toString(address(d.vault).code.length),
                "}"
            )
        );
        top[10] = _qr("gas", "{}");
        top[11] = _qr("dpTx", "{}");
        top[12] = _qr("sourcify", "null");
        top[13] = _qr("local", _localJson(s, d, r));
        top[14] = _qr("roles", _rolesJson(r));
        top[15] = _qs("note", "local anvil run with test mocks; never a testnet deployment");

        string memory path = string.concat(DEPLOYMENTS_DIR, "/", s.file);
        require(vm.isDir(DEPLOYMENTS_DIR), "DeployLocal: create the repo's deployments/ directory first");
        vm.writeJson(_obj(top), path);
    }

    function _contractsJson(Deployed memory d) internal pure returns (string memory) {
        return string.concat(
            '{"claims":{"address":"',
            vm.toString(address(d.claims)),
            '","id":null},"vault":{"address":"',
            vm.toString(address(d.vault)),
            '","id":null}}'
        );
    }

    function _localJson(Setup memory s, Deployed memory d, Roles memory r) internal pure returns (string memory) {
        string[] memory m = new string[](10);
        m[0] = _qa("router", d.router);
        m[1] = _qa("link", d.link);
        m[2] = _qa("usdc", USDC);
        m[3] = _qa("hts", HTS);
        m[4] = _qa("prng", PRNG);
        m[5] = _qa("simulator", address(d.sim));
        m[6] = _qs("arbSelector", vm.toString(uint256(s.arbSelector)));
        m[7] = _qa("casePeer", r.peer);
        m[8] = _qs("feeToken", s.native ? "native" : "link");
        m[9] = _qn("ccipFee", s.ccipFee);
        return _obj(m);
    }

    function _rolesJson(Roles memory r) internal pure returns (string memory) {
        string[] memory m = new string[](6);
        m[0] = _qa("owner", r.owner);
        m[1] = _qa("rulingRelayer", r.relayer);
        m[2] = _qa("preCheckSigner", r.signer);
        m[3] = _qa("platform", r.platform);
        m[4] = _qa("shop", r.shop);
        m[5] = _qa("pool", r.pool);
        return _obj(m);
    }
}
