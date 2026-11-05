// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title RecoursePing
/// @notice Contract-to-contract CCIP probe. The same source is deployed on both chains of a lane. Each copy sends to
/// its peer on the other chain and records what it receives, so a lane, its fee and the receive gas ceiling can be
/// proved before the real endpoints exist.
/// @dev The receive path writes several fresh storage slots per message, so the gas a real receiver needs for a
/// five-word message is exercised. It never reverts on message content: a message from an unknown chain or sender
/// is recorded as rejected and dropped. The contract holds LINK for fees and never keeps native currency.
contract RecoursePing is CCIPReceiver, Ownable {
    using SafeERC20 for IERC20;

    /// @notice Number of payload words copied into storage per received message.
    uint256 public constant STORED_WORDS = 5;

    /// @notice Rejection reasons carried by `PingRejected`.
    uint8 public constant REASON_UNKNOWN_SOURCE = 1;
    uint8 public constant REASON_WRONG_SENDER = 2;

    struct Received {
        uint64 sourceSelector;
        address sender;
        uint32 receivedAt;
        uint32 dataLength;
        bytes32 dataHash;
        bytes32[STORED_WORDS] words;
    }

    /// @notice LINK token used to pay fees on this chain.
    IERC20 public immutable LINK;

    /// @notice Peer contract per remote chain selector. Zero means the chain is not accepted.
    mapping(uint64 selector => address peer) public peerOf;

    /// @notice Messages received from a known peer, by CCIP message id.
    mapping(bytes32 messageId => Received) internal received;

    /// @notice Count of accepted messages.
    uint256 public receivedCount;

    event PeerSet(uint64 indexed selector, address peer);
    event PingSent(
        bytes32 indexed messageId,
        uint64 indexed destSelector,
        address peer,
        uint256 gasLimit,
        address feeToken,
        uint256 fee,
        bytes32 dataHash
    );
    event PingReceived(bytes32 indexed messageId, uint64 indexed sourceSelector, address sender, bytes32 dataHash);
    event PingRejected(bytes32 indexed messageId, uint64 indexed sourceSelector, uint8 reason);
    event LinkWithdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error PeerNotSet(uint64 selector);
    error ZeroGasLimit();
    error InsufficientLink(uint256 have, uint256 need);
    error InsufficientValue(uint256 have, uint256 need);
    error RefundFailed();

    constructor(address router, address link, address owner_) CCIPReceiver(router) Ownable(owner_) {
        if (link == address(0)) revert ZeroAddress();
        LINK = IERC20(link);
    }

    // ------------------------------------------------------------------ config

    /// @notice Accept messages from `peer` on chain `selector`, and send there. Zero `peer` removes the chain.
    function setPeer(uint64 selector, address peer) external onlyOwner {
        peerOf[selector] = peer;
        emit PeerSet(selector, peer);
    }

    /// @notice Return LINK held for fees.
    function withdrawLink(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        LINK.safeTransfer(to, amount);
        emit LinkWithdrawn(to, amount);
    }

    // ------------------------------------------------------------------ send

    /// @notice Fee in LINK for sending `data` to the peer on `destSelector` with `gasLimit` receive gas.
    function quote(uint64 destSelector, bytes calldata data, uint256 gasLimit) external view returns (uint256) {
        return IRouterClient(getRouter()).getFee(destSelector, _message(destSelector, data, gasLimit, address(LINK)));
    }

    /// @notice Fee in native currency for the same message.
    function quoteNative(uint64 destSelector, bytes calldata data, uint256 gasLimit) external view returns (uint256) {
        return IRouterClient(getRouter()).getFee(destSelector, _message(destSelector, data, gasLimit, address(0)));
    }

    /// @notice Send `data` to the peer on `destSelector`, paying the quoted fee in LINK held by this contract.
    function send(uint64 destSelector, bytes calldata data, uint256 gasLimit)
        external
        onlyOwner
        returns (bytes32 messageId)
    {
        Client.EVM2AnyMessage memory message = _message(destSelector, data, gasLimit, address(LINK));
        IRouterClient router = IRouterClient(getRouter());
        uint256 fee = router.getFee(destSelector, message);
        uint256 have = LINK.balanceOf(address(this));
        if (have < fee) revert InsufficientLink(have, fee);
        LINK.forceApprove(address(router), fee);
        messageId = router.ccipSend(destSelector, message);
        emit PingSent(messageId, destSelector, peerOf[destSelector], gasLimit, address(LINK), fee, keccak256(data));
    }

    /// @notice Send `data` paying the fee in native currency from `msg.value`. Any surplus goes back to the caller in
    /// the same transaction, so the contract never keeps native currency.
    function sendNative(uint64 destSelector, bytes calldata data, uint256 gasLimit)
        external
        payable
        onlyOwner
        returns (bytes32 messageId)
    {
        Client.EVM2AnyMessage memory message = _message(destSelector, data, gasLimit, address(0));
        IRouterClient router = IRouterClient(getRouter());
        uint256 fee = router.getFee(destSelector, message);
        if (msg.value < fee) revert InsufficientValue(msg.value, fee);
        messageId = router.ccipSend{value: fee}(destSelector, message);
        emit PingSent(messageId, destSelector, peerOf[destSelector], gasLimit, address(0), fee, keccak256(data));
        uint256 surplus = msg.value - fee;
        if (surplus != 0) {
            (bool ok,) = msg.sender.call{value: surplus}("");
            if (!ok) revert RefundFailed();
        }
    }

    function _message(uint64 destSelector, bytes calldata data, uint256 gasLimit, address feeToken)
        internal
        view
        returns (Client.EVM2AnyMessage memory)
    {
        address peer = peerOf[destSelector];
        if (peer == address(0)) revert PeerNotSet(destSelector);
        if (gasLimit == 0) revert ZeroGasLimit();
        return Client.EVM2AnyMessage({
            receiver: abi.encode(peer),
            data: data,
            tokenAmounts: new Client.EVMTokenAmount[](0),
            feeToken: feeToken,
            extraArgs: Client._argsToBytes(Client.GenericExtraArgsV2({gasLimit: gasLimit, allowOutOfOrderExecution: true}))
        });
    }

    // ------------------------------------------------------------------ receive

    /// @inheritdoc CCIPReceiver
    function _ccipReceive(Client.Any2EVMMessage memory message) internal override {
        address peer = peerOf[message.sourceChainSelector];
        if (peer == address(0)) {
            emit PingRejected(message.messageId, message.sourceChainSelector, REASON_UNKNOWN_SOURCE);
            return;
        }
        if (_senderOf(message.sender) != peer) {
            emit PingRejected(message.messageId, message.sourceChainSelector, REASON_WRONG_SENDER);
            return;
        }

        bytes memory data = message.data;
        bytes32 dataHash = keccak256(data);
        Received storage r = received[message.messageId];
        r.sourceSelector = message.sourceChainSelector;
        r.sender = peer;
        r.receivedAt = uint32(block.timestamp);
        r.dataLength = uint32(data.length);
        r.dataHash = dataHash;
        uint256 n = data.length / 32;
        if (n > STORED_WORDS) n = STORED_WORDS;
        for (uint256 i = 0; i < n; ++i) {
            bytes32 w;
            assembly ("memory-safe") {
                w := mload(add(add(data, 32), mul(i, 32)))
            }
            r.words[i] = w;
        }
        unchecked {
            ++receivedCount;
        }
        emit PingReceived(message.messageId, message.sourceChainSelector, peer, dataHash);
    }

    /// @dev Decodes an EVM sender without reverting. Anything that is not one clean 32-byte address word maps to
    /// address(0), which never equals a set peer.
    function _senderOf(bytes memory sender) internal pure returns (address a) {
        if (sender.length != 32) return address(0);
        uint256 word;
        assembly ("memory-safe") {
            word := mload(add(sender, 32))
        }
        if (word > type(uint160).max) return address(0);
        a = address(uint160(word));
    }

    // ------------------------------------------------------------------ views

    /// @notice What was stored for an accepted message. All zero for an unknown or rejected id.
    function receivedOf(bytes32 messageId) external view returns (Received memory) {
        return received[messageId];
    }
}
