// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {BridgeCodec} from "../shared/BridgeCodec.sol";
import {RecourseIds} from "../shared/RecourseIds.sol";
import {
    BridgeMode,
    Claim,
    ClaimStatus,
    ClaimToCourt,
    Codes,
    DecodeStatus,
    RecordRefs,
    RulingBack
} from "../shared/RecourseTypes.sol";
import {IDepositVault} from "./interfaces/IDepositVault.sol";
import {IRecourseClaims, IgnoreReason} from "./interfaces/IRecourseClaims.sol";
import {SettleMath} from "./SettleMath.sol";

/// @title RecourseClaims
/// @notice A shop files a claim against a platform for one order and escrows the court fee. A
///         pre-check signer records which record gap it found and which side it points at. The
///         side the finding goes against may contest within the window; otherwise anyone closes
///         the claim. A contested claim goes to court on Arbitrum over CCIP, and the ruling comes
///         back the same way (or, in the one-leg modes, through a disclosed relayer). Anyone then
///         settles it. Every USDC movement goes through the vault, as credit.
/// @dev The owner can configure the bridge and parameters until `lockConfig`, and can always change
///      the CCIP extra args and fee token. The owner can never move USDC, settle a claim or set a
///      ruling. `_ccipReceive` never reverts: every rejected message emits `RulingIgnored`.
contract RecourseClaims is IRecourseClaims, CCIPReceiver, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Amount ceiling for baskets and amount parameters, so settle sums can never overflow.
    uint256 internal constant MAX_AMOUNT = type(uint128).max;
    uint256 internal constant DEFAULT_GAS_LIMIT = 150_000;

    address public immutable link;
    address public immutable vault;
    uint64 public immutable arbSelector;

    address public peer;
    address public preCheckSigner;
    address public rulingRelayer;
    address public feeToken;
    BridgeMode public bridgeMode;
    bool public configLocked;
    bytes internal _extraArgs;
    Params internal _params;

    mapping(bytes32 claimId => Claim) internal _claims;

    modifier notLocked() {
        if (configLocked) revert ConfigIsLocked();
        _;
    }

    /// @param router CCIP router on this chain.
    /// @param link_ LINK token on this chain (an ERC-20; it needs no association).
    /// @param vault_ The DepositVault this contract will be bound to.
    /// @param arbSelector_ CCIP chain selector of the court chain.
    /// @param owner_ Configuration owner.
    constructor(address router, address link_, address vault_, uint64 arbSelector_, address owner_)
        CCIPReceiver(router)
        Ownable(owner_)
    {
        if (link_ == address(0) || vault_ == address(0) || arbSelector_ == 0) revert ZeroAddress();
        link = link_;
        vault = vault_;
        arbSelector = arbSelector_;
        feeToken = link_;
        _extraArgs = BridgeCodec.extraArgsFor(DEFAULT_GAS_LIMIT);
        _params = Params({
            contestWindow: 10 minutes,
            claimTimeout: 18 hours,
            courtFeeUsdc: 3_000_000,
            handlingBase: 15_000_000,
            handlingBps: 500,
            handlingCap: 40_000_000,
            resendGap: 30 minutes,
            maxSends: 5
        });
    }

    // =================================================================== claim lifecycle

    /// @notice Files a claim for the caller's order. The order id is derived from the caller, so
    ///         nobody but the order's shop can file (or block) its claim.
    function fileClaim(
        bytes32 orderNonce,
        address platform,
        RecordRefs calldata refs,
        uint256 basketUsdc,
        uint256 netLossUsdc
    ) external nonReentrant returns (bytes32 claimId) {
        if (platform == address(0)) revert ZeroAddress();
        if (platform == msg.sender) revert SameParty();
        if (basketUsdc == 0) revert ZeroBasket();
        if (basketUsdc > MAX_AMOUNT) revert BasketTooLarge();
        if (netLossUsdc > basketUsdc) revert NetLossAboveBasket();
        if (refs.topicNum == 0) revert BadRefs();
        if (refs.hashes[Codes.KIND_ORDERED] == bytes32(0)) revert MissingOrdered();

        bytes32 orderId = RecourseIds.orderIdOf(platform, msg.sender, orderNonce);
        claimId = RecourseIds.claimIdOf(block.chainid, address(this), orderId);
        Claim storage c = _claims[claimId];
        if (c.status != ClaimStatus.None) revert ClaimExists(claimId);

        c.orderId = orderId;
        c.shop = msg.sender;
        c.platform = platform;
        c.refs = refs;
        c.basketUsdc = basketUsdc;
        c.netLossUsdc = netLossUsdc;
        c.filedAt = uint64(block.timestamp);
        c.status = ClaimStatus.Filed;
        emit ClaimFiled(claimId, orderId, msg.sender, platform, refs, basketUsdc, netLossUsdc, uint64(block.timestamp));

        IDepositVault(vault).escrowFee(msg.sender, platform, _params.courtFeeUsdc, claimId);
    }

    /// @notice Records the pre-check finding. Gap 255 with answer 0 means "not enough record";
    ///         with answer 1 or 2 it is a missing record held against that side.
    function recordPreCheck(bytes32 claimId, uint8 gap, uint8 answer, bytes32 packHash) external {
        if (msg.sender != preCheckSigner) revert NotPreCheckSigner();
        Claim storage c = _claims[claimId];
        if (c.status != ClaimStatus.Filed) revert WrongStatus(c.status);
        if (!Codes.isGap(gap) || !Codes.isAnswer(answer)) revert BadCode();
        if (gap == Codes.GAP_NO_CODE && answer == Codes.ANSWER_NEITHER) revert BadCode();
        if (packHash == bytes32(0)) revert ZeroPackHash();

        c.gap = gap;
        c.answer = answer;
        c.packHash = packHash;
        c.preCheckedAt = uint64(block.timestamp);
        c.status = ClaimStatus.PreChecked;
        emit PreCheckRecorded(claimId, gap, answer, packHash);
    }

    /// @notice The side the finding goes against contests: the platform when the answer is 1,
    ///         otherwise the shop. Open until the end of the contest window, inclusive.
    function contest(bytes32 claimId) external {
        Claim storage c = _claims[claimId];
        if (c.status != ClaimStatus.PreChecked) revert WrongStatus(c.status);
        uint256 closesAt = uint256(c.preCheckedAt) + _params.contestWindow;
        if (block.timestamp > closesAt) revert WindowClosed(closesAt);
        address contester = c.answer == Codes.ANSWER_PLATFORM ? c.platform : c.shop;
        if (msg.sender != contester) revert NotContester();

        c.contestedBy = msg.sender;
        c.status = ClaimStatus.Contested;
        emit Contested(claimId, msg.sender);
    }

    /// @notice After the window, closes an uncontested claim: the fee is refunded, and if the
    ///         finding was against the platform the shop is paid net loss plus handling.
    function closeUncontested(bytes32 claimId) external nonReentrant {
        Claim storage c = _claims[claimId];
        if (c.status != ClaimStatus.PreChecked) revert WrongStatus(c.status);
        uint256 closesAt = uint256(c.preCheckedAt) + _params.contestWindow;
        if (block.timestamp <= closesAt) revert WindowOpen(closesAt);

        uint256 fee = _escrowed(claimId);
        uint256 toShop = SettleMath.uncontested(c.answer, c.netLossUsdc, _handling(c.basketUsdc));
        c.status = ClaimStatus.Closed;
        emit ClosedUncontested(claimId, c.answer, toShop);

        IDepositVault(vault).applyOutcome(claimId, c.platform, c.shop, toShop, fee);
    }

    /// @notice Sends a contested claim to court. Anyone may call; the CCIP fee comes from this
    ///         contract's balance. In mode None nothing is sent and the message id is 0.
    function sendToCourt(bytes32 claimId) external nonReentrant returns (bytes32 messageId) {
        Claim storage c = _claims[claimId];
        if (c.status != ClaimStatus.Contested) revert WrongStatus(c.status);
        c.status = ClaimStatus.AtCourt;
        c.lastSendAt = uint64(block.timestamp);
        if (bridgeMode != BridgeMode.None) {
            c.sendCount = 1;
            messageId = _send(claimId, c);
            c.lastMessageId = messageId;
        }
        emit SentToCourt(claimId, messageId);
    }

    /// @notice Sends the same payload again, at most `maxSends` times in all and no sooner than
    ///         `resendGap` after the last send. Whichever copy lands first is applied.
    function resend(bytes32 claimId) external nonReentrant returns (bytes32 messageId) {
        Claim storage c = _claims[claimId];
        if (c.status != ClaimStatus.AtCourt) revert WrongStatus(c.status);
        if (bridgeMode == BridgeMode.None) revert WrongMode(BridgeMode.None);
        uint256 availableAt = uint256(c.lastSendAt) + _params.resendGap;
        if (block.timestamp < availableAt) revert ResendTooSoon(availableAt);
        if (c.sendCount >= _params.maxSends) revert MaxSendsReached();

        c.sendCount += 1;
        c.lastSendAt = uint64(block.timestamp);
        messageId = _send(claimId, c);
        c.lastMessageId = messageId;
        emit SentToCourt(claimId, messageId);
    }

    /// @notice Frees a claim that never reached a ruling, refunding the fee in full. A Filed claim
    ///         expires once `claimTimeout` has passed since filing; a Contested or AtCourt claim once
    ///         `claimTimeout` has passed since its pre-check, so a late pre-check or contest never
    ///         shortens the court's time. PreChecked claims do not expire: they close uncontested.
    function expireClaim(bytes32 claimId) external nonReentrant {
        Claim storage c = _claims[claimId];
        ClaimStatus s = c.status;
        if (s != ClaimStatus.Filed && s != ClaimStatus.Contested && s != ClaimStatus.AtCourt) revert WrongStatus(s);
        uint256 from = s == ClaimStatus.Filed ? c.filedAt : c.preCheckedAt;
        uint256 expiresAfter = from + _params.claimTimeout;
        if (block.timestamp <= expiresAfter) revert NotExpired(expiresAfter);

        uint256 fee = _escrowed(claimId);
        c.status = ClaimStatus.Expired;
        emit ClaimExpired(claimId);

        IDepositVault(vault).applyOutcome(claimId, c.platform, c.shop, 0, fee);
    }

    /// @notice One-leg modes only: the ruling relayer records the court's final ruling. Invalid
    ///         values and claims that are not at court are ignored with an event, never reverted.
    function recordRuling(bytes32 claimId, uint256 disputeId, uint8 ruling, uint8 attempts) external {
        if (msg.sender != rulingRelayer) revert NotRelayer();
        if (bridgeMode == BridgeMode.Both) revert WrongMode(BridgeMode.Both);
        if (ruling > Codes.RULING_NEITHER || (attempts != 1 && attempts != 2)) {
            emit RulingIgnored(claimId, IgnoreReason.BAD_PAYLOAD, bytes32(0));
            return;
        }
        _applyRuling(claimId, disputeId, ruling, attempts, bytes32(0));
    }

    /// @notice Applies a ruled claim's outcome. Anyone may call.
    function settle(bytes32 claimId) external nonReentrant {
        Claim storage c = _claims[claimId];
        if (c.status != ClaimStatus.Ruled) revert WrongStatus(c.status);
        uint256 fee = _escrowed(claimId);
        (uint8 outcome, uint256 toShop) =
            SettleMath.ruled(c.ruling, c.gap, c.answer, c.netLossUsdc, _handling(c.basketUsdc), fee);
        c.status = ClaimStatus.Settled;
        emit Settled(claimId, outcome, toShop, fee);

        IDepositVault(vault).applyOutcome(claimId, c.platform, c.shop, toShop, 0);
    }

    /// @notice Adds HBAR for CCIP fees paid in the native token. Anyone may fund.
    function fundNative() external payable {
        if (msg.value == 0) revert AmountZero();
        emit NativeFunded(msg.sender, msg.value);
    }

    // =================================================================== CCIP receive

    /// @dev Never reverts on any message the router delivers. Checks, in order: source chain,
    ///      sender, payload, bridge mode, then the claim itself. Duplicates and resend copies find
    ///      the claim no longer at court and are ignored; messages are never deduplicated by id.
    function _ccipReceive(Client.Any2EVMMessage memory message) internal override {
        bytes32 messageId = message.messageId;
        if (message.sourceChainSelector != arbSelector) {
            emit RulingIgnored(bytes32(0), IgnoreReason.WRONG_SOURCE, messageId);
            return;
        }
        address peer_ = peer;
        if (
            peer_ == address(0) || message.sender.length != 32
                || keccak256(message.sender) != keccak256(abi.encode(peer_))
        ) {
            emit RulingIgnored(bytes32(0), IgnoreReason.WRONG_SENDER, messageId);
            return;
        }
        (DecodeStatus status, RulingBack memory rb) = BridgeCodec.tryDecodeRulingBack(message.data);
        if (status != DecodeStatus.Ok) {
            emit RulingIgnored(rb.claimId, IgnoreReason.BAD_PAYLOAD, messageId);
            return;
        }
        if (bridgeMode != BridgeMode.Both) {
            emit RulingIgnored(rb.claimId, IgnoreReason.WRONG_MODE, messageId);
            return;
        }
        _applyRuling(rb.claimId, rb.disputeId, rb.ruling, rb.attempts, messageId);
    }

    function _applyRuling(bytes32 claimId, uint256 disputeId, uint8 ruling, uint8 attempts, bytes32 messageId) private {
        Claim storage c = _claims[claimId];
        ClaimStatus s = c.status;
        if (s == ClaimStatus.None) {
            emit RulingIgnored(claimId, IgnoreReason.UNKNOWN_CLAIM, messageId);
            return;
        }
        if (s != ClaimStatus.AtCourt) {
            emit RulingIgnored(claimId, IgnoreReason.NOT_AT_COURT, messageId);
            return;
        }
        if (ruling == Codes.RULING_REFUSED && attempts != 2) {
            emit RulingIgnored(claimId, IgnoreReason.REFUSED_FIRST_ATTEMPT, messageId);
            return;
        }
        c.ruling = ruling;
        c.disputeId = disputeId;
        c.attempts = attempts;
        c.status = ClaimStatus.Ruled;
        emit RulingReceived(claimId, disputeId, ruling, attempts, messageId);
    }

    // =================================================================== owner

    function setPeer(address peer_) external onlyOwner notLocked {
        if (peer_ == address(0)) revert ZeroAddress();
        peer = peer_;
        emit PeerSet(peer_);
    }

    function setParams(Params calldata p) external onlyOwner notLocked {
        if (
            p.contestWindow == 0 || p.claimTimeout <= p.contestWindow || p.handlingBps > SettleMath.BPS
                || p.maxSends == 0 || p.courtFeeUsdc == 0 || p.courtFeeUsdc > MAX_AMOUNT || p.handlingBase > MAX_AMOUNT
                || p.handlingCap > MAX_AMOUNT
        ) revert BadParams();
        _params = p;
        emit ParamsSet(p);
    }

    function setPreCheckSigner(address signer) external onlyOwner notLocked {
        if (signer == address(0)) revert ZeroAddress();
        preCheckSigner = signer;
        emit PreCheckSignerSet(signer);
    }

    /// @notice Both: rulings arrive over CCIP. OutOnly: claims go out over CCIP and the relayer
    ///         records rulings. None: no CCIP at all; the relayer records rulings.
    function setBridgeMode(BridgeMode mode, address relayer) external onlyOwner notLocked {
        if (relayer == address(0)) revert ZeroAddress();
        bridgeMode = mode;
        rulingRelayer = relayer;
        emit BridgeModeSet(mode, relayer);
    }

    /// @notice Moves this contract's LINK out. Only before the lock, and only LINK.
    function sweepLink(address to) external onlyOwner notLocked {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = IERC20(link).balanceOf(address(this));
        IERC20(link).safeTransfer(to, amount);
        emit LinkSwept(to, amount);
    }

    /// @notice Moves this contract's HBAR out. Only before the lock.
    function sweepNative(address payable to) external onlyOwner notLocked {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = address(this).balance;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit NativeSwept(to, amount);
    }

    /// @notice Freezes the peer, parameters, signer and bridge mode for good.
    function lockConfig() external onlyOwner notLocked {
        if (bridgeMode != BridgeMode.None && peer == address(0)) revert NotReadyToLock();
        if (preCheckSigner == address(0)) revert NotReadyToLock();
        if (IDepositVault(vault).claims() != address(this)) revert NotReadyToLock();
        configLocked = true;
        emit ConfigLocked();
    }

    /// @notice CCIP extra args for later sends (gas limit, ordering, finality). Always available,
    ///         so a wrong gas limit can be corrected after the lock.
    function setExtraArgs(bytes calldata extraArgs_) external onlyOwner {
        if (extraArgs_.length < 4) revert BadParams();
        _extraArgs = extraArgs_;
        emit ExtraArgsSet(extraArgs_);
    }

    /// @notice Pays later CCIP fees in LINK, or in HBAR with `address(0)`. Always available.
    function setFeeToken(address token) external onlyOwner {
        if (token != link && token != address(0)) revert BadParams();
        feeToken = token;
        emit FeeTokenSet(token);
    }

    // =================================================================== views

    function getClaim(bytes32 claimId) external view returns (Claim memory) {
        return _claims[claimId];
    }

    function params() external view returns (Params memory) {
        return _params;
    }

    /// @notice What `settle` (for a Ruled claim) or `closeUncontested` (for a PreChecked one) would
    ///         apply now. Zeros for any other status.
    function previewSettle(bytes32 claimId) external view returns (uint256 toShop, uint256 refund, uint256 toPool) {
        Claim storage c = _claims[claimId];
        if (c.status == ClaimStatus.Ruled) {
            uint256 fee = _escrowed(claimId);
            (, toShop) = SettleMath.ruled(c.ruling, c.gap, c.answer, c.netLossUsdc, _handling(c.basketUsdc), fee);
            return (toShop, 0, fee);
        }
        if (c.status == ClaimStatus.PreChecked) {
            uint256 fee = _escrowed(claimId);
            toShop = SettleMath.uncontested(c.answer, c.netLossUsdc, _handling(c.basketUsdc));
            return (toShop, fee, 0);
        }
    }

    function handlingOf(uint256 basketUsdc) external view returns (uint256) {
        return _handling(basketUsdc);
    }

    /// @notice The fee for sending this claim now, in the current fee token's units. 0 for an
    ///         unknown claim, with no peer, or in mode None.
    function quoteSend(bytes32 claimId) external view returns (uint256 fee) {
        Claim storage c = _claims[claimId];
        address peer_ = peer;
        if (c.status == ClaimStatus.None || peer_ == address(0) || bridgeMode == BridgeMode.None) return 0;
        return IRouterClient(getRouter()).getFee(arbSelector, _message(claimId, c, peer_));
    }

    function claimIdFor(address platform, address shop, bytes32 orderNonce) external view returns (bytes32) {
        return RecourseIds.claimIdOf(block.chainid, address(this), RecourseIds.orderIdOf(platform, shop, orderNonce));
    }

    /// @notice Batch draw is not part of this version: no claim is ever batched.
    function batchOf(bytes32) external pure returns (uint256) {
        return 0;
    }

    function getBatch(uint256) external pure returns (Batch memory b) {
        return b;
    }

    function extraArgs() external view returns (bytes memory) {
        return _extraArgs;
    }

    // =================================================================== internal

    function _handling(uint256 basketUsdc) internal view returns (uint256) {
        Params storage p = _params;
        return SettleMath.handling(basketUsdc, p.handlingBase, p.handlingBps, p.handlingCap);
    }

    function _escrowed(bytes32 claimId) internal view returns (uint256) {
        return IDepositVault(vault).escrowOf(claimId).amount;
    }

    /// @dev The payload is built only from fields fixed at filing and pre-check, so every send of a
    ///      claim carries the same bytes.
    function _message(bytes32 claimId, Claim storage c, address peer_)
        internal
        view
        returns (Client.EVM2AnyMessage memory)
    {
        bytes memory data = BridgeCodec.encodeClaimToCourt(
            ClaimToCourt({
                version: BridgeCodec.VERSION,
                claimId: claimId,
                platform: c.platform,
                shop: c.shop,
                gap: c.gap,
                answer: c.answer,
                refs: c.refs,
                packHash: c.packHash,
                basketUsdc: c.basketUsdc,
                netLossUsdc: c.netLossUsdc,
                filedAt: c.filedAt
            })
        );
        return Client.EVM2AnyMessage({
            receiver: abi.encode(peer_),
            data: data,
            tokenAmounts: new Client.EVMTokenAmount[](0),
            feeToken: feeToken,
            extraArgs: _extraArgs
        });
    }

    /// @dev Quotes, checks the balance of the fee token, approves exactly the fee (LINK) or attaches
    ///      it as value (HBAR, in tinybars inside the EVM), and sends.
    function _send(bytes32 claimId, Claim storage c) internal returns (bytes32) {
        address peer_ = peer;
        if (peer_ == address(0)) revert PeerNotSet();
        Client.EVM2AnyMessage memory m = _message(claimId, c, peer_);
        IRouterClient router = IRouterClient(getRouter());
        uint256 fee = router.getFee(arbSelector, m);
        if (m.feeToken == address(0)) {
            uint256 haveNative = address(this).balance;
            if (haveNative < fee) revert NativeShort(haveNative, fee);
            return router.ccipSend{value: fee}(arbSelector, m);
        }
        uint256 haveLink = IERC20(link).balanceOf(address(this));
        if (haveLink < fee) revert LinkShort(haveLink, fee);
        IERC20(link).forceApprove(address(router), fee);
        return router.ccipSend(arbSelector, m);
    }
}
