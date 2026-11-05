// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IArbitratorV2} from "@kleros/kleros-v2-contracts/arbitration/interfaces/IArbitratorV2.sol";
import {
    IDisputeTemplateRegistry
} from "@kleros/kleros-v2-contracts/arbitration/interfaces/IDisputeTemplateRegistry.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {BridgeCodec} from "../shared/BridgeCodec.sol";
import {RecourseIds} from "../shared/RecourseIds.sol";
import {CaseState, ClaimToCourt, DecodeStatus, RulingBack} from "../shared/RecourseTypes.sol";
import {CaseTemplate, TextStore} from "./CaseTemplate.sol";
import {CaseView, IRecourseCase} from "./IRecourseCase.sol";

/// @title RecourseCase
/// @notice Arbitrum end of a Recourse claim: receives contested claims from Hedera over CCIP, opens one Kleros
/// court 8 dispute per court attempt paid from a team-funded ETH pool, stores the ruling, refiles once after a
/// refusal and relays the final ruling back to Hedera over CCIP. See `IRecourseCase` for the state machine.
/// @dev Money paths, complete: ETH leaves only through `openCase` and `refile` (exactly the live arbitration cost)
/// and `withdrawFeePool` (owner); value attached to `relayRuling` passes to the router (exactly the quoted fee), and
/// the surplus goes back to the caller after every state change, or joins the fee pool if the caller refuses it.
/// LINK leaves only through `relayRuling` (exactly the quoted fee) and `sweepLink` (before lock). `rule` and the
/// CCIP receive path never move money, never call out and never revert on data.
contract RecourseCase is IRecourseCase, CCIPReceiver, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- constants

    uint256 public constant NUMBER_OF_CHOICES = 3;
    /// @dev abi.encode(uint256 8, uint256 3, uint256 1): court 8, 3 jurors, dispute kit 1. Exactly 96 bytes.
    bytes public constant EXTRA_DATA =
        hex"000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000001";
    string public constant TEMPLATE_TAG = "recourse-v1";

    uint8 internal constant REJECT_SELECTOR = 1;
    uint8 internal constant REJECT_SENDER = 2;
    uint8 internal constant REJECT_UNDECODABLE = 3;
    uint8 internal constant REJECT_VERSION = 4;

    bytes4 internal constant EVM_EXTRA_ARGS_V1_TAG = 0x97a657c9;
    bytes4 internal constant GENERIC_EXTRA_ARGS_V2_TAG = 0x181dcf10;
    bytes4 internal constant GENERIC_EXTRA_ARGS_V3_TAG = 0xa69dd4aa;

    // ---------------------------------------------------------------- immutables

    IArbitratorV2 internal immutable ARBITRATOR;
    IDisputeTemplateRegistry internal immutable TEMPLATE_REGISTRY;
    IERC20 internal immutable LINK;
    uint64 internal immutable HEDERA_SELECTOR;
    uint64 internal immutable CLAIM_TIMEOUT;

    // ---------------------------------------------------------------- storage

    /// @dev Times are unix seconds in uint40 (good past the year 30000) so all of them share the first slot.
    struct Case {
        CaseState state;
        uint8 attempts;
        uint8 ruling;
        uint8 sendCount;
        uint40 receivedAt;
        uint40 ruledAt;
        uint40 lastSendAt;
        uint40 expiresAt;
        bytes32 payloadHash;
        bytes32 lastMessageId;
        uint256[2] disputeIds;
        uint256[2] templateIds;
    }

    struct DisputeRef {
        bytes32 claimId;
        uint8 attempt;
    }

    struct Params {
        uint64 caseDeadline;
        uint16 maxOpenCases;
        uint64 resendGap;
        uint8 maxSends;
    }

    mapping(bytes32 claimId => Case) internal cases;
    mapping(uint256 disputeId => DisputeRef) internal disputes;

    Params internal p;
    /// @inheritdoc IRecourseCase
    uint16 public openCases;
    /// @inheritdoc IRecourseCase
    uint256 public feePool;
    /// @inheritdoc IRecourseCase
    address public peer;
    /// @inheritdoc IRecourseCase
    address public trustedRelay;
    /// @inheritdoc IRecourseCase
    bool public locked;
    bytes internal extraArgs_;
    string internal policyURI_;
    /// @dev Code-stored abi.encode(string[4]) of the template parts; zero until set.
    address internal templatePointer;

    // ---------------------------------------------------------------- setup

    /// @param router CCIP router on this chain.
    /// @param link_ LINK token used for relay fees.
    /// @param arbitrator_ KlerosCore.
    /// @param registry DisputeTemplateRegistry.
    /// @param hederaSelector_ CCIP chain selector of Hedera; the only source accepted and the only destination used.
    /// @param owner_ Owner of the configuration and the fee pool.
    /// @param init Start parameters (see `setParams`).
    /// @param relayGasLimit Receive gas for `RulingBack` on Hedera; becomes `GenericExtraArgsV2` extra args.
    /// @param claimTimeout_ Hedera's claim timeout after lock: a claim filed at `filedAt` can no longer use a ruling
    /// from `filedAt + claimTimeout_` on (see `expiresAt`).
    constructor(
        address router,
        address link_,
        address arbitrator_,
        address registry,
        uint64 hederaSelector_,
        address owner_,
        Params memory init,
        uint256 relayGasLimit,
        uint64 claimTimeout_
    ) CCIPReceiver(router) Ownable(owner_) {
        if (link_ == address(0) || arbitrator_ == address(0) || registry == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        if (hederaSelector_ == 0 || claimTimeout_ == 0) revert BadParams();
        if (relayGasLimit == 0) revert ZeroGasLimit();
        LINK = IERC20(link_);
        ARBITRATOR = IArbitratorV2(arbitrator_);
        TEMPLATE_REGISTRY = IDisputeTemplateRegistry(registry);
        HEDERA_SELECTOR = hederaSelector_;
        CLAIM_TIMEOUT = claimTimeout_;
        _setParams(init.caseDeadline, init.maxOpenCases, init.resendGap, init.maxSends);
        extraArgs_ = BridgeCodec.extraArgsFor(relayGasLimit);
        emit ExtraArgsSet(extraArgs_);
    }

    modifier beforeLock() {
        if (locked) revert ConfigIsLocked();
        _;
    }

    // ---------------------------------------------------------------- ingress

    /// @dev Router only (base `onlyRouter`). Records or ignores; never reverts on message content.
    function _ccipReceive(Client.Any2EVMMessage memory message) internal override {
        if (message.sourceChainSelector != HEDERA_SELECTOR) {
            emit ClaimRejected(message.messageId, REJECT_SELECTOR);
            return;
        }
        address p_ = peer;
        if (p_ == address(0) || _senderOf(message.sender) != p_) {
            emit ClaimRejected(message.messageId, REJECT_SENDER);
            return;
        }
        _ingest(message.data, message.messageId);
    }

    /// @inheritdoc IRecourseCase
    function relayClaim(bytes calldata payload) external {
        address relay = trustedRelay;
        if (relay == address(0)) revert RelayDisabled();
        if (msg.sender != relay) revert NotTrustedRelay();
        _ingest(payload, bytes32(0));
    }

    function _ingest(bytes memory payload, bytes32 messageId) internal {
        (DecodeStatus status, ClaimToCourt memory c) = BridgeCodec.tryDecodeClaimToCourt(payload);
        if (status != DecodeStatus.Ok) {
            emit ClaimRejected(messageId, status == DecodeStatus.BadVersion ? REJECT_VERSION : REJECT_UNDECODABLE);
            return;
        }
        if (c.claimId == bytes32(0)) {
            emit ClaimRejected(messageId, REJECT_UNDECODABLE);
            return;
        }
        Case storage k = cases[c.claimId];
        if (k.state != CaseState.None) {
            emit ClaimDuplicate(c.claimId, messageId);
            return;
        }
        k.state = CaseState.Received;
        k.receivedAt = uint40(block.timestamp);
        uint256 expiry = uint256(c.filedAt) + CLAIM_TIMEOUT;
        k.expiresAt = expiry > type(uint40).max ? type(uint40).max : uint40(expiry);
        k.payloadHash = keccak256(payload);
        emit ClaimReceived(c.claimId, messageId, payload);
    }

    /// @dev An EVM sender as one clean address word; anything else maps to address(0), which never equals a peer.
    function _senderOf(bytes memory sender) internal pure returns (address a) {
        if (sender.length != 32) return address(0);
        uint256 word;
        assembly ("memory-safe") {
            word := mload(add(sender, 32))
        }
        if (word > type(uint160).max) return address(0);
        a = address(uint160(word));
    }

    // ---------------------------------------------------------------- court

    /// @inheritdoc IRecourseCase
    function openCase(bytes calldata payload) external nonReentrant returns (uint256 disputeId) {
        (bytes32 claimId, Case storage k) = _caseOfPayload(payload);
        if (k.state != CaseState.Received) revert WrongState(claimId, k.state);
        if (keccak256(payload) != k.payloadHash) revert HashMismatch();
        if (block.timestamp >= uint256(k.receivedAt) + p.caseDeadline || block.timestamp >= k.expiresAt) {
            k.state = CaseState.Stale;
            emit ClaimStale(claimId);
            return 0;
        }
        if (openCases >= p.maxOpenCases) revert CapReached();
        openCases += 1;
        disputeId = _open(claimId, k, payload, 1);
    }

    /// @inheritdoc IRecourseCase
    function refile(bytes calldata payload) external nonReentrant returns (uint256 disputeId) {
        (bytes32 claimId, Case storage k) = _caseOfPayload(payload);
        if (k.state != CaseState.RefilePending || k.attempts != 1) revert WrongState(claimId, k.state);
        if (keccak256(payload) != k.payloadHash) revert HashMismatch();
        if (block.timestamp >= uint256(k.ruledAt) + p.caseDeadline || block.timestamp >= k.expiresAt) {
            k.state = CaseState.Stale;
            _releaseCap();
            emit ClaimStale(claimId);
            return 0;
        }
        disputeId = _open(claimId, k, payload, 2);
    }

    /// @inheritdoc IRecourseCase
    function markStale(bytes32 claimId) external {
        Case storage k = cases[claimId];
        CaseState s = k.state;
        if (s != CaseState.Received && s != CaseState.Opened && s != CaseState.RefilePending) {
            revert WrongState(claimId, s);
        }
        if (block.timestamp < k.expiresAt) revert NotExpired(uint64(k.expiresAt));
        k.state = CaseState.Stale;
        if (s != CaseState.Received) _releaseCap();
        emit ClaimStale(claimId);
    }

    /// @dev Pays exactly the live cost, registers the template and creates the dispute, then records it. The case
    /// state is already checked; `nonReentrant` on both callers covers the external calls.
    function _open(bytes32 claimId, Case storage k, bytes calldata payload, uint8 attempt)
        internal
        returns (uint256 disputeId)
    {
        string memory template = _template(payload);
        uint256 cost = ARBITRATOR.arbitrationCost(EXTRA_DATA);
        uint256 pool = feePool;
        if (pool < cost) revert FeePoolLow(pool, cost);
        feePool = pool - cost;

        uint256 templateId = TEMPLATE_REGISTRY.setDisputeTemplate(TEMPLATE_TAG, template, "");
        disputeId = ARBITRATOR.createDispute{value: cost}(NUMBER_OF_CHOICES, EXTRA_DATA);

        k.state = CaseState.Opened;
        k.attempts = attempt;
        k.disputeIds[attempt - 1] = disputeId;
        k.templateIds[attempt - 1] = templateId;
        disputes[disputeId] = DisputeRef({claimId: claimId, attempt: attempt});

        emit DisputeRequest(ARBITRATOR, disputeId, externalIdOf(claimId, attempt), templateId, "");
        emit CaseOpened(claimId, disputeId, attempt);
    }

    /// @notice Called by KlerosCore with the ruling. Never reverts for one of our disputes, whatever the ruling.
    function rule(uint256 disputeID, uint256 ruling) external override {
        if (msg.sender != address(ARBITRATOR)) revert NotArbitrator();
        DisputeRef memory d = disputes[disputeID];
        if (d.claimId == bytes32(0)) revert UnknownDispute();
        Case storage k = cases[d.claimId];
        if (ruling > NUMBER_OF_CHOICES || k.state != CaseState.Opened || k.attempts != d.attempt) {
            emit RuleIgnored(disputeID, ruling);
            return;
        }
        k.ruling = uint8(ruling);
        k.ruledAt = uint40(block.timestamp);
        emit Ruling(ARBITRATOR, disputeID, ruling);
        if (ruling == 0 && d.attempt == 1) {
            k.state = CaseState.RefilePending;
            emit RefileNeeded(d.claimId);
        } else {
            k.state = CaseState.Ruled;
            _releaseCap();
            emit RulingFinal(d.claimId, disputeID, uint8(ruling), d.attempt);
        }
    }

    function _releaseCap() internal {
        // Every Opened or RefilePending case is counted, so this never underflows; the guard keeps `rule` from
        // ever reverting even if that were broken.
        if (openCases > 0) openCases -= 1;
    }

    // ---------------------------------------------------------------- relay

    /// @inheritdoc IRecourseCase
    function relayRuling(bytes32 claimId) external payable nonReentrant returns (bytes32 messageId) {
        Case storage k = cases[claimId];
        if (k.state != CaseState.Ruled && k.state != CaseState.Relayed) revert WrongState(claimId, k.state);
        if (peer == address(0)) revert PeerNotSet();
        if (k.sendCount >= p.maxSends) revert MaxSendsReached();
        if (k.sendCount > 0) {
            uint64 nextAt = uint64(k.lastSendAt) + p.resendGap;
            if (block.timestamp < nextAt) revert SendTooSoon(nextAt);
        }

        bool native = msg.value > 0;
        Client.EVM2AnyMessage memory message = _rulingMessage(claimId, k, native ? address(0) : address(LINK));
        IRouterClient router = IRouterClient(getRouter());
        uint256 fee = router.getFee(HEDERA_SELECTOR, message);

        k.state = CaseState.Relayed;
        k.sendCount += 1;
        k.lastSendAt = uint40(block.timestamp);

        if (native) {
            if (msg.value < fee) revert InsufficientValue(msg.value, fee);
            messageId = router.ccipSend{value: fee}(HEDERA_SELECTOR, message);
        } else {
            uint256 have = LINK.balanceOf(address(this));
            if (have < fee) revert InsufficientLink(have, fee);
            LINK.forceApprove(address(router), fee);
            messageId = router.ccipSend(HEDERA_SELECTOR, message);
        }
        k.lastMessageId = messageId;
        emit RulingRelayed(claimId, k.disputeIds[k.attempts - 1], k.ruling, messageId);

        // Surplus goes back last. A caller that cannot take it back must not block the relay: the surplus then
        // joins the fee pool, which only the owner can withdraw.
        if (native && msg.value > fee) {
            uint256 surplus = msg.value - fee;
            (bool ok,) = msg.sender.call{value: surplus}("");
            if (!ok) {
                feePool += surplus;
                emit FeePoolFunded(msg.sender, surplus);
            }
        }
    }

    function _rulingMessage(bytes32 claimId, Case storage k, address feeToken)
        internal
        view
        returns (Client.EVM2AnyMessage memory)
    {
        uint8 attempts = k.attempts;
        bytes memory data = BridgeCodec.encodeRulingBack(
            RulingBack({
                version: BridgeCodec.VERSION,
                claimId: claimId,
                disputeId: k.disputeIds[attempts - 1],
                ruling: k.ruling,
                attempts: attempts
            })
        );
        return Client.EVM2AnyMessage({
            receiver: abi.encode(peer),
            data: data,
            tokenAmounts: new Client.EVMTokenAmount[](0),
            feeToken: feeToken,
            extraArgs: extraArgs_
        });
    }

    // ---------------------------------------------------------------- fee pool

    /// @inheritdoc IRecourseCase
    function fundFeePool() external payable {
        feePool += msg.value;
        emit FeePoolFunded(msg.sender, msg.value);
    }

    /// @inheritdoc IRecourseCase
    function withdrawFeePool(uint256 amount) external onlyOwner nonReentrant {
        if (amount > feePool) revert WithdrawTooLarge();
        feePool -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert EthSendFailed();
        emit FeePoolWithdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------- config

    /// @inheritdoc IRecourseCase
    function setPeer(address peer_) external onlyOwner beforeLock {
        if (peer_ == address(0)) revert ZeroAddress();
        peer = peer_;
        emit PeerSet(peer_);
    }

    /// @inheritdoc IRecourseCase
    function setParams(uint64 caseDeadline, uint16 maxOpenCases, uint64 resendGap, uint8 maxSends)
        external
        onlyOwner
        beforeLock
    {
        _setParams(caseDeadline, maxOpenCases, resendGap, maxSends);
    }

    function _setParams(uint64 caseDeadline, uint16 maxOpenCases, uint64 resendGap, uint8 maxSends) internal {
        if (caseDeadline == 0 || maxOpenCases == 0 || maxSends == 0) revert BadParams();
        p = Params({caseDeadline: caseDeadline, maxOpenCases: maxOpenCases, resendGap: resendGap, maxSends: maxSends});
        emit ParamsSet(caseDeadline, maxOpenCases, resendGap, maxSends);
    }

    /// @inheritdoc IRecourseCase
    function setTrustedRelay(address relay) external onlyOwner beforeLock {
        trustedRelay = relay;
        emit TrustedRelaySet(relay);
    }

    /// @inheritdoc IRecourseCase
    function sweepLink(address to) external onlyOwner beforeLock {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = LINK.balanceOf(address(this));
        LINK.safeTransfer(to, amount);
        emit LinkSwept(to, amount);
    }

    /// @inheritdoc IRecourseCase
    function lockConfig() external onlyOwner beforeLock {
        locked = true;
        emit ConfigLocked();
    }

    /// @inheritdoc IRecourseCase
    function setExtraArgs(bytes calldata newExtraArgs) external onlyOwner {
        if (_gasLimitOf(newExtraArgs) == 0) revert ZeroGasLimit();
        extraArgs_ = newExtraArgs;
        emit ExtraArgsSet(newExtraArgs);
    }

    /// @dev Receive gas named by CCIP extra args (V1, GenericV2 or GenericV3); 0 for anything unreadable.
    function _gasLimitOf(bytes calldata args) internal pure returns (uint256) {
        if (args.length < 4) return 0;
        bytes4 tag = bytes4(args[:4]);
        if (tag == GENERIC_EXTRA_ARGS_V2_TAG || tag == EVM_EXTRA_ARGS_V1_TAG) {
            if (args.length < 36) return 0;
            return uint256(bytes32(args[4:36]));
        }
        if (tag == GENERIC_EXTRA_ARGS_V3_TAG) {
            if (args.length < 8) return 0;
            return uint256(uint32(bytes4(args[4:8])));
        }
        return 0;
    }

    /// @inheritdoc IRecourseCase
    function setPolicyURI(string calldata uri) external onlyOwner {
        bytes calldata b = bytes(uri);
        if (b.length <= 6 || bytes6(b[:6]) != bytes6("/ipfs/")) revert BadParams();
        policyURI_ = uri;
        emit PolicyURISet(uri);
    }

    /// @inheritdoc IRecourseCase
    function setTemplateText(string[4] calldata parts) external onlyOwner {
        bytes memory encoded = abi.encode(parts);
        templatePointer = TextStore.write(encoded);
        emit TemplateTextSet(keccak256(encoded));
    }

    // ---------------------------------------------------------------- views

    /// @inheritdoc IRecourseCase
    function caseOf(bytes32 claimId) external view returns (CaseView memory v) {
        Case storage k = cases[claimId];
        v.state = k.state;
        v.payloadHash = k.payloadHash;
        v.receivedAt = k.receivedAt;
        v.attempts = k.attempts;
        v.disputeIds = k.disputeIds;
        v.templateIds = k.templateIds;
        v.ruling = k.ruling;
        v.ruledAt = k.ruledAt;
        v.sendCount = k.sendCount;
        v.lastSendAt = k.lastSendAt;
        v.lastMessageId = k.lastMessageId;
    }

    /// @inheritdoc IRecourseCase
    function expiresAt(bytes32 claimId) external view returns (uint64) {
        return cases[claimId].expiresAt;
    }

    /// @inheritdoc IRecourseCase
    function claimTimeout() external view returns (uint64) {
        return CLAIM_TIMEOUT;
    }

    /// @inheritdoc IRecourseCase
    function claimOfDispute(uint256 disputeId) external view returns (bytes32 claimId, uint8 attempt) {
        DisputeRef memory d = disputes[disputeId];
        return (d.claimId, d.attempt);
    }

    /// @inheritdoc IRecourseCase
    function costNow() external view returns (uint256) {
        return ARBITRATOR.arbitrationCost(EXTRA_DATA);
    }

    /// @inheritdoc IRecourseCase
    function hederaSelector() external view returns (uint64) {
        return HEDERA_SELECTOR;
    }

    /// @inheritdoc IRecourseCase
    function params()
        external
        view
        returns (uint64 caseDeadline, uint16 maxOpenCases, uint64 resendGap, uint8 maxSends)
    {
        return (p.caseDeadline, p.maxOpenCases, p.resendGap, p.maxSends);
    }

    /// @inheritdoc IRecourseCase
    function extraArgs() external view returns (bytes memory) {
        return extraArgs_;
    }

    /// @inheritdoc IRecourseCase
    function policyURI() external view returns (string memory) {
        return policyURI_;
    }

    /// @inheritdoc IRecourseCase
    function templateParts() public view returns (string[4] memory parts) {
        address ptr = templatePointer;
        if (ptr == address(0)) return parts;
        parts = abi.decode(TextStore.read(ptr), (string[4]));
    }

    /// @inheritdoc IRecourseCase
    function previewTemplate(bytes calldata payload) external view returns (string memory) {
        (DecodeStatus status, ClaimToCourt memory c) = BridgeCodec.tryDecodeClaimToCourt(payload);
        if (status != DecodeStatus.Ok) revert BadPayload();
        return CaseTemplate.build(templateParts(), c, policyURI_);
    }

    /// @inheritdoc IRecourseCase
    function externalIdOf(bytes32 claimId, uint8 attempt) public view returns (uint256) {
        return uint256(RecourseIds.externalIdOf(block.chainid, address(this), claimId, attempt));
    }

    /// @inheritdoc IRecourseCase
    function quoteRelay(bytes32 claimId) external view returns (uint256) {
        return _quote(claimId, address(LINK));
    }

    /// @inheritdoc IRecourseCase
    function quoteRelayNative(bytes32 claimId) external view returns (uint256) {
        return _quote(claimId, address(0));
    }

    function _quote(bytes32 claimId, address feeToken) internal view returns (uint256) {
        if (peer == address(0)) revert PeerNotSet();
        Case storage k = cases[claimId];
        if (k.state != CaseState.Ruled && k.state != CaseState.Relayed) revert WrongState(claimId, k.state);
        return IRouterClient(getRouter()).getFee(HEDERA_SELECTOR, _rulingMessage(claimId, k, feeToken));
    }

    /// @inheritdoc IRecourseCase
    function arbitrator() external view returns (address) {
        return address(ARBITRATOR);
    }

    /// @inheritdoc IRecourseCase
    function templateRegistry() external view returns (address) {
        return address(TEMPLATE_REGISTRY);
    }

    /// @inheritdoc IRecourseCase
    function link() external view returns (address) {
        return address(LINK);
    }

    // ---------------------------------------------------------------- internal

    /// @dev Claim id from word 1 of a payload; the stored payload hash is checked by the caller before use.
    function _caseOfPayload(bytes calldata payload) internal view returns (bytes32 claimId, Case storage k) {
        if (payload.length != BridgeCodec.CLAIM_TO_COURT_LEN) revert BadPayload();
        claimId = bytes32(payload[32:64]);
        k = cases[claimId];
    }

    /// @dev The template to register now: current parts and policy, payload facts.
    function _template(bytes calldata payload) internal view returns (string memory) {
        if (templatePointer == address(0) || bytes(policyURI_).length == 0) revert TemplateNotSet();
        (, ClaimToCourt memory c) = BridgeCodec.tryDecodeClaimToCourt(payload);
        return CaseTemplate.build(templateParts(), c, policyURI_);
    }
}
