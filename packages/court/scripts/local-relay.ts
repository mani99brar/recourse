// LOCAL ONLY. Carries CCIP messages between two anvil nodes, one standing in for Arbitrum and one for Hedera.
//
// The chainlink-local router delivers only inside its own node, so a send to the other chain goes nowhere. This
// process watches both nodes, finds every successful `ccipSend` call into each node's local router (from a call
// trace of each transaction, so it works for any sender), and delivers the message on the other node through that
// node's local router `routeMessage`, with the source chain selector of the sending chain, the sending contract as
// sender, and the receive gas limit named in the message's extra args. It then sets the destination MockOffRamp's
// execution state for the message id: 2 when the receiver ran, 3 when it reverted. A dropped message stays 0.
//
//   tsx scripts/local-relay.ts [--once] [--drop 2,5] [--delay 30] [--delay-one 3:120]
//                              [--from-arb <block>] [--from-hedera <block>]
//
//   --once          process both nodes up to their current block, wait for any delayed message, then exit
//   --drop k,...    never deliver the k-th message seen (1-based, both directions counted together)
//   --delay s       deliver every message s seconds (wall clock) after it is seen
//   --delay-one k:s deliver only the k-th message s seconds late
//
// Reads deployments/arbitrum.local.json (`rpcUrl`, `mocks.router`, `outside.offRampArb`, `outside.offRampHedera`,
// `startBlock`) and deployments/hedera.local.json (`local.router`, `startBlock`).
// Env: DEPLOYMENTS_DIR, ARBITRUM_LOCAL_FILE, HEDERA_LOCAL_FILE, LOCAL_ARB_RPC_URL, LOCAL_HEDERA_RPC_URL
// (default http://127.0.0.1:8550). Transactions are sent from anvil's unlocked default account 7, which no deploy
// script uses, so no deployed address moves. One JSON line per message goes to stdout.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  http,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { PACKAGE_ROOT } from './fixtures.js';

const ARBITRUM_SELECTOR = 3478487238524512106n;
const HEDERA_SELECTOR = 222782988166878823n;
const RELAYER: Address = '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955'; // anvil default account 7
const GAS_FOR_CALL_EXACT_CHECK = 5000;
const DEFAULT_RECEIVE_GAS = 200_000n; // CCIP's default when a message names no gas limit
const POLL_MS = 1000;

const routerAbi = parseAbi([
  'struct EVMTokenAmount { address token; uint256 amount; }',
  'struct EVM2AnyMessage { bytes receiver; bytes data; EVMTokenAmount[] tokenAmounts; address feeToken; bytes extraArgs; }',
  'struct Any2EVMMessage { bytes32 messageId; uint64 sourceChainSelector; bytes sender; bytes data; EVMTokenAmount[] destTokenAmounts; }',
  'function ccipSend(uint64 destinationChainSelector, EVM2AnyMessage message) payable returns (bytes32)',
  'function routeMessage(Any2EVMMessage message, uint16 gasForCallExactCheck, uint256 gasLimit, address receiver) returns (bool success, bytes retData, uint256 gasUsed)',
  'event MsgExecuted(bool success, bytes retData, uint256 gasUsed)',
]);
const offRampAbi = parseAbi(['function setExecutionState(bytes32 messageId, uint8 state)']);

interface Side {
  name: 'arbitrum' | 'hedera';
  selector: bigint;
  rpc: string;
  router: Address;
  offRamp: Address | null; // MockOffRamp on this node, for messages arriving here
  pub: PublicClient;
  wallet: WalletClient;
  next: bigint; // next block to scan
}

interface Sent {
  k: number;
  from: Side;
  to: Side;
  messageId: Hex;
  sender: Address;
  receiver: Address;
  data: Hex;
  gasLimit: bigint;
  dueAt: number;
}

interface CallFrame {
  from: string;
  to?: string;
  input: string;
  output?: string;
  error?: string;
  calls?: CallFrame[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
}

/** Receive gas named by CCIP extra args: EVMExtraArgsV1, GenericExtraArgsV2 or GenericExtraArgsV3. */
function gasLimitOf(extraArgs: Hex): bigint {
  if (extraArgs.length < 10) return DEFAULT_RECEIVE_GAS;
  const tag = extraArgs.slice(0, 10).toLowerCase();
  const body = `0x${extraArgs.slice(10)}` as Hex;
  if (tag === '0x97a657c9' || tag === '0x181dcf10') {
    return BigInt(`0x${body.slice(2, 66) || '0'}`);
  }
  if (tag === '0xa69dd4aa') return BigInt(`0x${body.slice(2, 10) || '0'}`);
  return DEFAULT_RECEIVE_GAS;
}

function sendFrames(frame: CallFrame, router: string, out: CallFrame[]): void {
  if (!frame.error && frame.to?.toLowerCase() === router && frame.input.length >= 10) out.push(frame);
  for (const c of frame.calls ?? []) sendFrames(c, router, out);
}

function makeSide(name: Side['name'], selector: bigint, rpc: string, router: Address, offRamp: Address | null, next: bigint): Side {
  const transport = http(rpc);
  return {
    name,
    selector,
    rpc,
    router,
    offRamp,
    pub: createPublicClient({ transport }) as PublicClient,
    wallet: createWalletClient({ transport, account: RELAYER }),
    next,
  };
}

async function scan(side: Side, sides: Side[], seen: { k: number }, queue: Sent[], opts: Opts): Promise<void> {
  const head = await side.pub.getBlockNumber();
  for (; side.next <= head; side.next++) {
    const block = await side.pub.getBlock({ blockNumber: side.next });
    for (const hash of block.transactions) {
      const trace = (await side.pub.request({
        method: 'debug_traceTransaction' as any,
        params: [hash, { tracer: 'callTracer' }] as any,
      })) as CallFrame;
      const frames: CallFrame[] = [];
      sendFrames(trace, side.router.toLowerCase(), frames);
      for (const f of frames) {
        let decoded;
        try {
          decoded = decodeFunctionData({ abi: routerAbi, data: f.input as Hex });
        } catch {
          continue;
        }
        if (decoded.functionName !== 'ccipSend') continue;
        const [dest, message] = decoded.args;
        const to = sides.find((s) => s.selector === dest && s !== side);
        seen.k += 1;
        const k = seen.k;
        const messageId = (f.output ?? '0x') as Hex;
        if (!to) {
          log({ k, action: 'skipped', reason: `no node for destination selector ${dest}`, from: side.name, messageId });
          continue;
        }
        const [receiver] = decodeAbiParameters([{ type: 'address' }], message.receiver);
        const item: Sent = {
          k,
          from: side,
          to,
          messageId,
          sender: f.from as Address,
          receiver,
          data: message.data,
          gasLimit: gasLimitOf(message.extraArgs),
          dueAt: Date.now() + 1000 * (opts.delayOne.get(k) ?? opts.delay),
        };
        if (opts.drop.has(k)) {
          log({ ...summary(item), action: 'dropped' });
          continue;
        }
        if (item.dueAt > Date.now()) log({ ...summary(item), action: 'delayed', seconds: (item.dueAt - Date.now()) / 1000 });
        queue.push(item);
      }
    }
  }
}

async function deliver(item: Sent): Promise<void> {
  const to = item.to;
  const message = {
    messageId: item.messageId,
    sourceChainSelector: item.from.selector,
    sender: encodeAbiParameters([{ type: 'address' }], [item.sender]),
    data: item.data,
    destTokenAmounts: [],
  };
  const hash = await to.wallet.writeContract({
    chain: null,
    account: RELAYER,
    address: to.router,
    abi: routerAbi,
    functionName: 'routeMessage',
    args: [message, GAS_FOR_CALL_EXACT_CHECK, item.gasLimit, item.receiver],
  });
  const receipt = await to.pub.waitForTransactionReceipt({ hash });
  const [executed] = parseEventLogs({ abi: routerAbi, eventName: 'MsgExecuted', logs: receipt.logs });
  // The local router skips the call (and emits nothing) when the receiver has no code; count that as delivered,
  // as CCIP would for a message with no receiver logic.
  const success = executed ? executed.args.success : true;
  if (to.offRamp) {
    const h = await to.wallet.writeContract({
      chain: null,
      account: RELAYER,
      address: to.offRamp,
      abi: offRampAbi,
      functionName: 'setExecutionState',
      args: [item.messageId, success ? 2 : 3],
    });
    await to.pub.waitForTransactionReceipt({ hash: h });
  }
  log({
    ...summary(item),
    action: success ? 'delivered' : 'failed',
    gasUsed: executed ? executed.args.gasUsed.toString() : null,
    tx: hash,
  });
}

function summary(item: Sent) {
  return {
    k: item.k,
    from: item.from.name,
    to: item.to.name,
    messageId: item.messageId,
    sender: item.sender,
    receiver: item.receiver,
    gasLimit: item.gasLimit.toString(),
  };
}

function log(o: Record<string, unknown>): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));
}

interface Opts {
  once: boolean;
  drop: Set<number>;
  delay: number;
  delayOne: Map<number, number>;
}

async function main(): Promise<void> {
  const dir = process.env.DEPLOYMENTS_DIR ?? join(PACKAGE_ROOT, '..', '..', 'deployments');
  const arbFile = readJson(join(dir, process.env.ARBITRUM_LOCAL_FILE ?? 'arbitrum.local.json'));
  const hedFile = readJson(join(dir, process.env.HEDERA_LOCAL_FILE ?? 'hedera.local.json'));
  if (arbFile.mocksOnly !== true) throw new Error('the Arbitrum file is not a local mock deployment');

  const opts: Opts = {
    once: process.argv.includes('--once'),
    drop: new Set((arg('--drop') ?? '').split(',').filter(Boolean).map(Number)),
    delay: Number(arg('--delay') ?? 0),
    delayOne: new Map(
      (arg('--delay-one') ? [arg('--delay-one')!] : []).map((s) => {
        const [k, sec] = s.split(':').map(Number);
        return [k!, sec!] as [number, number];
      }),
    ),
  };

  const arb = makeSide(
    'arbitrum',
    ARBITRUM_SELECTOR,
    process.env.LOCAL_ARB_RPC_URL ?? arbFile.rpcUrl ?? 'http://127.0.0.1:8560',
    arbFile.mocks.router,
    arbFile.outside.offRampArb ?? null,
    BigInt(arg('--from-arb') ?? arbFile.startBlock ?? 0),
  );
  const hed = makeSide(
    'hedera',
    HEDERA_SELECTOR,
    process.env.LOCAL_HEDERA_RPC_URL ?? 'http://127.0.0.1:8550',
    hedFile.local.router,
    arbFile.outside.offRampHedera ?? null,
    BigInt(arg('--from-hedera') ?? hedFile.startBlock ?? 0),
  );
  for (const s of [arb, hed]) {
    const code = await s.pub.getCode({ address: s.router });
    if (!code || code === '0x') throw new Error(`${s.name}: no router code at ${s.router} on ${s.rpc}`);
  }
  log({ action: 'start', arbitrum: arb.rpc, hedera: hed.rpc, fromArb: arb.next.toString(), fromHedera: hed.next.toString() });

  const sides = [arb, hed];
  const seen = { k: 0 };
  const queue: Sent[] = [];
  for (;;) {
    for (const s of sides) await scan(s, sides, seen, queue, opts);
    queue.sort((a, b) => a.dueAt - b.dueAt);
    while (queue.length > 0 && queue[0]!.dueAt <= Date.now()) await deliver(queue.shift()!);
    if (opts.once && queue.length === 0) return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exit(1);
});
