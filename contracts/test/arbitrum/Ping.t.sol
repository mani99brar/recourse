// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test, Vm} from "forge-std/Test.sol";
import {CCIPLocalSimulator} from "@chainlink/local/src/ccip/CCIPLocalSimulator.sol";
import {CCIPLocalRouter} from "@chainlink/local/src/ccip/CCIPLocalRouter.sol";
import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RecoursePing} from "../../src/ping/RecoursePing.sol";

/// @dev Unit tests on the chainlink-local simulator. Both pings share one local router, which stamps every message
/// with the simulator's own chain selector, so each ping names the other as its peer on that selector.
contract PingTest is Test {
    CCIPLocalSimulator internal sim;
    CCIPLocalRouter internal router;
    IERC20 internal link;
    uint64 internal sel;

    RecoursePing internal a;
    RecoursePing internal b;
    address internal owner = makeAddr("owner");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant GAS = 400_000;

    function setUp() public {
        sim = new CCIPLocalSimulator();
        (uint64 chainSelector, address source,,, address linkToken,,) = _rawConfig();
        sel = chainSelector;
        router = CCIPLocalRouter(source);
        link = IERC20(linkToken);

        a = new RecoursePing(address(router), address(link), owner);
        b = new RecoursePing(address(router), address(link), owner);
        vm.startPrank(owner);
        a.setPeer(sel, address(b));
        b.setPeer(sel, address(a));
        vm.stopPrank();
        sim.requestLinkFromFaucet(address(a), 10 ether);
    }

    /// @dev `configuration()` returns contract types from several OZ copies; decode it as plain addresses.
    function _rawConfig() internal view returns (uint64, address, address, address, address, address, address) {
        (bool ok, bytes memory ret) = address(sim).staticcall(abi.encodeCall(CCIPLocalSimulator.configuration, ()));
        require(ok, "config");
        return abi.decode(ret, (uint64, address, address, address, address, address, address));
    }

    function _payload(uint256 nonce) internal view returns (bytes memory) {
        return abi.encode(uint8(1), keccak256("recourse.ping"), block.timestamp, nonce, uint8(2));
    }

    function _msg(bytes32 id, uint64 source, bytes memory sender, bytes memory data)
        internal
        pure
        returns (Client.Any2EVMMessage memory)
    {
        return Client.Any2EVMMessage({
            messageId: id,
            sourceChainSelector: source,
            sender: sender,
            data: data,
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });
    }

    // ------------------------------------------------------------------ send and receive

    function test_send_paysExactLinkFee_andPeerStoresWords() public {
        router.setFee(0.25 ether);
        bytes memory data = _payload(7);
        uint256 before = link.balanceOf(address(a));

        vm.recordLogs();
        vm.prank(owner);
        bytes32 id = a.send(sel, data, GAS);

        assertEq(before - link.balanceOf(address(a)), 0.25 ether, "fee taken exactly");
        assertEq(link.allowance(address(a), address(router)), 0, "no allowance left over");

        RecoursePing.Received memory r = b.receivedOf(id);
        assertEq(r.sourceSelector, sel);
        assertEq(r.sender, address(a));
        assertEq(r.dataHash, keccak256(data));
        assertEq(r.dataLength, 160);
        assertEq(r.receivedAt, block.timestamp);
        for (uint256 i = 0; i < 5; ++i) {
            bytes32 w;
            assembly {
                w := mload(add(add(data, 32), mul(i, 32)))
            }
            assertEq(r.words[i], w);
        }
        assertEq(b.receivedCount(), 1);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sent;
        bool got;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == RecoursePing.PingSent.selector && logs[i].emitter == address(a)) sent = true;
            if (logs[i].topics[0] == RecoursePing.PingReceived.selector && logs[i].emitter == address(b)) got = true;
        }
        assertTrue(sent && got, "both events");
    }

    function test_send_quoteMatchesCharge() public {
        router.setFee(0.1 ether);
        bytes memory data = _payload(1);
        assertEq(a.quote(sel, data, GAS), 0.1 ether);
        assertEq(a.quoteNative(sel, data, GAS), 0.1 ether);
    }

    function test_send_revertsWithoutEnoughLink() public {
        router.setFee(11 ether);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(RecoursePing.InsufficientLink.selector, 10 ether, 11 ether));
        a.send(sel, _payload(1), GAS);
    }

    function test_send_revertsWithoutPeer() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(RecoursePing.PeerNotSet.selector, uint64(42)));
        a.send(42, _payload(1), GAS);
    }

    function test_send_revertsOnZeroGas() public {
        vm.prank(owner);
        vm.expectRevert(RecoursePing.ZeroGasLimit.selector);
        a.send(sel, _payload(1), 0);
    }

    function test_send_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        a.send(sel, _payload(1), GAS);
    }

    function test_sendNative_refundsSurplus_andHoldsNothing() public {
        router.setFee(0.01 ether);
        vm.deal(owner, 1 ether);
        vm.prank(owner);
        bytes32 id = a.sendNative{value: 0.3 ether}(sel, _payload(3), GAS);
        assertEq(owner.balance, 0.99 ether, "only the fee left the caller");
        assertEq(address(a).balance, 0, "contract keeps no native currency");
        assertEq(b.receivedOf(id).sender, address(a));
    }

    function test_sendNative_revertsBelowFee() public {
        router.setFee(0.01 ether);
        vm.deal(owner, 1 ether);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(RecoursePing.InsufficientValue.selector, 0.009 ether, 0.01 ether));
        a.sendNative{value: 0.009 ether}(sel, _payload(3), GAS);
    }

    function test_sendNative_onlyOwner() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        a.sendNative{value: 0.1 ether}(sel, _payload(3), GAS);
    }

    function test_plainNativeTransferReverts() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(a).call{value: 1}("");
        assertFalse(ok);
    }

    // ------------------------------------------------------------------ receive checks

    function test_receive_unknownSource_rejectedNotReverted() public {
        Client.Any2EVMMessage memory m = _msg(bytes32(uint256(1)), sel + 1, abi.encode(address(a)), _payload(1));
        vm.expectEmit(true, true, false, true, address(b));
        emit RecoursePing.PingRejected(bytes32(uint256(1)), sel + 1, 1);
        (bool ok,,) = router.routeMessage(m, 5_000, GAS, address(b));
        assertTrue(ok);
        assertEq(b.receivedOf(bytes32(uint256(1))).sender, address(0));
        assertEq(b.receivedCount(), 0);
    }

    function test_receive_wrongSender_rejectedNotReverted() public {
        Client.Any2EVMMessage memory m = _msg(bytes32(uint256(2)), sel, abi.encode(stranger), _payload(1));
        vm.expectEmit(true, true, false, true, address(b));
        emit RecoursePing.PingRejected(bytes32(uint256(2)), sel, 2);
        (bool ok,,) = router.routeMessage(m, 5_000, GAS, address(b));
        assertTrue(ok);
        assertEq(b.receivedCount(), 0);
    }

    function test_receive_malformedSenderBytes_rejected() public {
        bytes[] memory senders = new bytes[](4);
        senders[0] = hex"";
        senders[1] = abi.encodePacked(address(a)); // 20 bytes
        senders[2] = abi.encode(address(a), uint256(1)); // 64 bytes
        senders[3] = abi.encode(uint256(uint160(address(a))) | (uint256(1) << 200)); // dirty high bits
        for (uint256 i = 0; i < senders.length; ++i) {
            Client.Any2EVMMessage memory m = _msg(bytes32(i + 10), sel, senders[i], _payload(1));
            (bool ok,,) = router.routeMessage(m, 5_000, GAS, address(b));
            assertTrue(ok, "no revert");
        }
        assertEq(b.receivedCount(), 0);
    }

    function test_receive_shortPayload_storesWholeWordsOnly() public {
        bytes memory data = abi.encodePacked(bytes32(uint256(5)), bytes7(0x01020304050607));
        Client.Any2EVMMessage memory m = _msg(bytes32(uint256(3)), sel, abi.encode(address(a)), data);
        (bool ok,,) = router.routeMessage(m, 5_000, GAS, address(b));
        assertTrue(ok);
        RecoursePing.Received memory r = b.receivedOf(bytes32(uint256(3)));
        assertEq(r.dataLength, 39);
        assertEq(r.words[0], bytes32(uint256(5)));
        assertEq(r.words[1], bytes32(0));
    }

    function test_receive_onlyRouter() public {
        Client.Any2EVMMessage memory m = _msg(bytes32(uint256(4)), sel, abi.encode(address(a)), _payload(1));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CCIPReceiver.InvalidRouter.selector, stranger));
        b.ccipReceive(m);
    }

    function test_receive_gasForFiveWordPayload() public {
        Client.Any2EVMMessage memory m = _msg(keccak256("gas"), sel, abi.encode(address(a)), _payload(9));
        (bool ok,, uint256 gasUsed) = router.routeMessage(m, 5_000, GAS, address(b));
        assertTrue(ok);
        emit log_named_uint("ping ccipReceive gas, 5-word payload", gasUsed);
        assertLt(gasUsed, 300_000);
        assertGt(gasUsed, 100_000, "storage writes are real");
    }

    function testFuzz_receive_neverReverts(bytes32 id, uint64 source, bytes calldata sender, bytes calldata data)
        public
    {
        vm.assume(data.length < 4_096 && sender.length < 256);
        Client.Any2EVMMessage memory m = _msg(id, source, sender, data);
        (bool ok,,) = router.routeMessage(m, 5_000, 1_000_000, address(b));
        assertTrue(ok);
    }

    // ------------------------------------------------------------------ admin

    function test_setPeer_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        a.setPeer(sel, stranger);
    }

    function test_withdrawLink() public {
        vm.prank(owner);
        a.withdrawLink(owner, 4 ether);
        assertEq(link.balanceOf(owner), 4 ether);
        assertEq(link.balanceOf(address(a)), 6 ether);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        a.withdrawLink(stranger, 1);
    }

    function test_constructor_rejectsZeroLink() public {
        PingDeployer d = new PingDeployer();
        vm.expectRevert(RecoursePing.ZeroAddress.selector);
        d.deploy(address(router), address(0), owner);
    }
}

/// @dev External deploy helper so a constructor revert can be caught by `expectRevert`.
contract PingDeployer {
    function deploy(address router, address link, address owner) external returns (RecoursePing) {
        return new RecoursePing(router, link, owner);
    }
}
