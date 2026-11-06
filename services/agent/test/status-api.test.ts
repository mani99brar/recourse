// The commands' side of the v1 API, against a stand-in status API on a local port and a fake RPC:
// typed errors, the check that every built transaction is exactly the intended call, signing and
// sending in order, the read-back, and the whole run as a command makes it. The signer is a fresh
// random key; every address is made up.

import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeFunctionData, erc20Abi, getAddress, keccak256, parseTransaction, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { RecordRefs } from '@recourse/shared';
import { loadAbi } from '../../shop/src/chain.js';
import type { FileClaimInput } from '../../shop/src/filing.js';
import { claimIdOf } from '@recourse/shared';
import { Refused, exitFor, fileClaimCalls, fileClaimRun, recordsIndexed, runAction, type HederaSide, type Printer } from '../src/act.js';
import {
  SendStopped,
  V1Failure,
  deploymentProblems,
  readBack,
  signAndSend,
  signingProblems,
  v1Client,
  type BuiltAction,
  type BuiltTx,
  type ChainRpc,
  type IntendedCall,
} from '../src/status-api.js';

const CLAIMS = getAddress('0x' + 'c1'.repeat(20));
const VAULT = getAddress('0x' + 'a2'.repeat(20));
const TOKEN = getAddress('0x' + '6d'.repeat(20));
const PLATFORM = getAddress('0x' + 'f8'.repeat(20));
const CLAIM_ID = ('0x' + '9c'.repeat(32)) as Hex;
const OTHER_CLAIM = ('0x' + '39'.repeat(32)) as Hex;
const NONCE = ('0x' + '4e'.repeat(32)) as Hex;
const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const CLAIMS_ABI = loadAbi('RecourseClaims');
const VAULT_ABI = loadAbi('DepositVault');
const signer = privateKeyToAccount(generatePrivateKey());
const NOW = Math.floor(Date.now() / 1000);

/** A value as the API writes it in `call.args`: integers as decimal strings. */
function shown(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(shown);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shown(x)]));
  return v;
}

function txOf(contract: string, to: Address, abi: Abi, fn: string, args: readonly unknown[], over: Partial<BuiltTx> = {}): BuiltTx {
  const f = abi.find((x) => x.type === 'function' && x.name === fn);
  const inputs = f && f.type === 'function' ? f.inputs : [];
  return {
    chainId: 296,
    to,
    data: encodeFunctionData({ abi, functionName: fn, args } as never),
    value: '0',
    gas: '120000',
    gasPrice: '1310000000000',
    description: `${contract}.${fn}`,
    call: { contract, function: fn, args: Object.fromEntries(inputs.map((p, i) => [p.name || String(i), shown(args[i])])) },
    simulated: true,
    ...over,
  };
}

function built(action: BuiltAction['action'], transactions: BuiltTx[], over: Partial<BuiltAction> = {}): BuiltAction {
  // The fee as the API works it out: every step's gas limit at its gas price.
  const fee = transactions.reduce((s, t) => s + BigInt(t.gas) * BigInt(t.gasPrice), 0n);
  return {
    action,
    chain: 'hedera',
    chainId: 296,
    from: signer.address,
    claimId: CLAIM_ID,
    transactions,
    preview: {
      summary: `Do ${action}.`,
      amounts: [{ name: 'courtFee', amount: '1000000', decimals: 6, symbol: 'mUSDC', display: '1.00 mUSDC', movement: 'info', account: null }],
      fee: { amount: fee.toString(), decimals: 18, symbol: 'HBAR', display: '0.1572 HBAR', gas: '120000', gasPrice: '1310000000000', basis: 'estimate' },
      changes: ['The claim is contested (status contested).'],
      statusAfter: 'contested',
      notes: [],
    },
    simulated: true,
    builtAt: String(NOW),
    notAfter: null,
    readBack: `/v1/claims/${CLAIM_ID}`,
    input: { claimId: CLAIM_ID },
    ...over,
  };
}

const contestCall: IntendedCall = { contract: 'RecourseClaims', to: CLAIMS, abi: CLAIMS_ABI, functionName: 'contest', args: [CLAIM_ID] };
const asked = { action: 'contest' as const, from: signer.address, chainId: 296, claimId: CLAIM_ID, calls: [contestCall] };
const contestTx = () => txOf('RecourseClaims', CLAIMS, CLAIMS_ABI, 'contest', [CLAIM_ID]);

// ------------------------------------------------------------------ stand-in API and RPC

interface StandIn {
  url: string;
  posts: { name: string; body: unknown }[];
  gets: string[];
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function standIn(handlers: {
  post?: (name: string, body: unknown, n: number) => [number, unknown];
  get?: (path: string, n: number) => [number, unknown];
}): Promise<StandIn> {
  const st: StandIn = { url: '', posts: [], gets: [] };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = req.url ?? '/';
      let answer: [number, unknown];
      if (req.method === 'POST' && path.startsWith('/v1/actions/')) {
        const name = path.slice('/v1/actions/'.length);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        st.posts.push({ name, body });
        answer = handlers.post?.(name, body, st.posts.length) ?? [404, { error: { code: 'not_found', message: 'No such route.', details: { resource: 'route' } } }];
      } else {
        st.gets.push(path);
        answer = handlers.get?.(path, st.gets.length) ?? [404, { error: { code: 'not_found', message: 'No such claim.', details: { resource: 'claim' } } }];
      }
      res.writeHead(answer[0], { 'content-type': 'application/json' }).end(JSON.stringify(answer[1]));
    });
  });
  servers.push(server);
  st.url = await new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
  return st;
}

interface FakeRpc extends ChainRpc {
  events: string[];
  raws: Hex[];
}

function fakeRpc(opts: { chainId?: number; gasPrice?: bigint | null; status?: (i: number) => 'success' | 'reverted'; refuse?: boolean } = {}): FakeRpc {
  let nonce = 7;
  const rpc: FakeRpc = {
    events: [],
    raws: [],
    chainId: async () => opts.chainId ?? 296,
    gasPrice: async () => {
      if (opts.gasPrice === null) throw new Error('eth_gasPrice failed');
      return opts.gasPrice ?? 1_250_000_000_000n;
    },
    nonce: async () => nonce,
    sendRaw: async (raw) => {
      if (opts.refuse) throw new Error('INSUFFICIENT_TX_FEE\nmore text');
      rpc.raws.push(raw);
      rpc.events.push(`send ${keccak256(raw)}`);
      nonce++;
    },
    receipt: async (hash) => {
      const i = rpc.raws.findIndex((r) => keccak256(r) === hash);
      rpc.events.push(`receipt ${hash}`);
      return { status: opts.status?.(i) ?? 'success', blockNumber: 100n + BigInt(i) };
    },
  };
  return rpc;
}

function capture(): Printer & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l) };
}

// ------------------------------------------------------------------ tests

describe('the v1 client', () => {
  it('turns a typed error into its code and message, refused for a 4xx', async () => {
    const api = await standIn({ post: () => [409, { error: { code: 'window_closed', message: 'The contest window closed at 2026-11-06T14:10:00Z.', details: { closesAt: '1793995800' } } }] });
    const e = await v1Client(api.url).post('contest', { from: signer.address, claimId: CLAIM_ID }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(V1Failure);
    expect(e).toMatchObject({ status: 409, code: 'window_closed', said: 'The contest window closed at 2026-11-06T14:10:00Z.', details: { closesAt: '1793995800' }, refused: true });
    expect((e as Error).message).toBe('window_closed: The contest window closed at 2026-11-06T14:10:00Z.');
  });

  it('is not refused for a source that is down, and says so when it cannot reach the API', async () => {
    const api = await standIn({ post: () => [503, { error: { code: 'upstream_unavailable', message: 'Hedera did not answer.', details: { upstream: 'hedera_rpc' } } }] });
    expect(await v1Client(api.url).post('contest', {}).catch((x: unknown) => x)).toMatchObject({ code: 'upstream_unavailable', refused: false });
    expect(await v1Client('http://127.0.0.1:1').get('/v1/params').catch((x: unknown) => x)).toMatchObject({ code: 'unreachable', status: 0 });
  });

  it('will not hand on an answer in a shape it does not know', async () => {
    const api = await standIn({ post: () => [200, { action: 'contest', transactions: [] }] });
    expect(await v1Client(api.url).post('contest', {}).catch((x: unknown) => x)).toMatchObject({ code: 'bad_answer' });
  });
});

describe('the check before signing', () => {
  it('passes exactly the intended call', () => {
    expect(signingProblems(built('contest', [contestTx()]), asked, NOW)).toEqual([]);
  });

  it('refuses another target, function, argument, chain, signer, claim or value', () => {
    const cases: [string, BuiltAction][] = [
      ['goes to', built('contest', [{ ...contestTx(), to: VAULT }])],
      ['its data calls closeUncontested', built('contest', [{ ...txOf('RecourseClaims', CLAIMS, CLAIMS_ABI, 'closeUncontested', [CLAIM_ID]), call: contestTx().call }])],
      ['other arguments (claimId)', built('contest', [{ ...txOf('RecourseClaims', CLAIMS, CLAIMS_ABI, 'contest', [OTHER_CLAIM]), call: contestTx().call }])],
      ['the arguments it shows differ', built('contest', [{ ...contestTx(), call: { ...contestTx().call, args: { claimId: OTHER_CLAIM } } }])],
      ['is on chain 421614', built('contest', [{ ...contestTx(), chainId: 421614 }])],
      ['it is for chain 1', built('contest', [contestTx()], { chainId: 1 })],
      ['not the signer', built('contest', [contestTx()], { from: PLATFORM })],
      ['built for claim', built('contest', [contestTx()], { claimId: OTHER_CLAIM })],
      ['sends a value of 5', built('contest', [{ ...contestTx(), value: '5' }])],
      ['the API built closeUncontested', built('closeUncontested', [contestTx()])],
      ['2 transaction(s), not 1', built('contest', [contestTx(), contestTx()])],
      ['deadline for this call passed', built('contest', [contestTx()], { notAfter: String(NOW - 10) })],
      ['above the 1000 the preview shows', (() => {
        const b = built('contest', [contestTx()]);
        return { ...b, preview: { ...b.preview, fee: { ...b.preview.fee, amount: '1000' } } };
      })()],
    ];
    for (const [why, resp] of cases) {
      const problems = signingProblems(resp, asked, NOW);
      expect(problems.join(' | '), why).toContain(why);
    }
  });

  it('takes a fileClaim only with exactly the shop input, and an approve only of the court fee to the vault', () => {
    const input: FileClaimInput = {
      orderNonce: NONCE,
      platform: PLATFORM,
      refs: { topicNum: 11335218n, seq: [1n, 2n, 3n, 4n, 5n, 0n], hashes: [H(1), H(2), H(3), H(4), H(5), H(0)] },
      basketUsdc: 2_000_000n,
      netLossUsdc: 1_500_000n,
    };
    const h = { deployment: { claims: CLAIMS, vault: VAULT, usdc: TOKEN, chainId: 296 } as never, claimsAbi: CLAIMS_ABI };
    const file = (refs: RecordRefs = input.refs, basket = input.basketUsdc) => txOf('RecourseClaims', CLAIMS, CLAIMS_ABI, 'fileClaim', [NONCE, PLATFORM, refs, basket, input.netLossUsdc], { simulated: false, gas: '800000' });
    const approve = (amount: bigint, spender: Address = VAULT) => txOf('VaultToken', TOKEN, erc20Abi as Abi, 'approve', [spender, amount]);
    const ask = (resp: BuiltAction) => ({ action: 'fileClaim' as const, from: signer.address, chainId: 296, claimId: CLAIM_ID, calls: fileClaimCalls(h, input, 1_000_000n, resp.transactions.length) });
    const check = (txs: BuiltTx[]) => {
      const resp = built('fileClaim', txs);
      return signingProblems(resp, ask(resp), NOW).join(' | ');
    };
    expect(check([approve(1_000_000n), file()])).toBe('');
    expect(check([file()])).toBe('');
    expect(check([approve(2n ** 255n), file()])).toContain('other arguments (amount)');
    expect(check([approve(1_000_000n, PLATFORM), file()])).toContain('other arguments (spender)');
    expect(check([file({ ...input.refs, seq: [9n, 2n, 3n, 4n, 5n, 0n] })])).toContain('other arguments (refs)');
    expect(check([file(input.refs, 3_000_000n)])).toContain('other arguments (basketUsdc)');
  });

  it('says when the API serves other contracts than the deployment file', () => {
    const params = { addresses: { claims: CLAIMS, vault: VAULT }, chains: { hedera: 296 } };
    expect(deploymentProblems(params, { chain: 'hedera', chainId: 296, claims: CLAIMS, vault: VAULT })).toEqual([]);
    expect(deploymentProblems(params, { chain: 'hedera', chainId: 296, claims: PLATFORM, vault: VAULT }).join()).toContain(`the status API serves claims ${CLAIMS}, the deployment file names ${PLATFORM}`);
    expect(deploymentProblems(params, { chain: 'hedera', chainId: 31337, claims: CLAIMS }).join()).toContain('chain 296, the deployment file is for chain 31337');
  });
});

describe('signing and sending', () => {
  it('signs exactly what was built, in order, each after the one before it has mined', async () => {
    const rpc = fakeRpc();
    const a = txOf('VaultToken', TOKEN, erc20Abi as Abi, 'approve', [VAULT, 1_000_000n], { gas: '60000' });
    const b = txOf('RecourseClaims', CLAIMS, CLAIMS_ABI, 'contest', [CLAIM_ID]);
    const hashes = await signAndSend(built('fileClaim', [a, b]), { account: signer, rpc, nowS: () => NOW });
    expect(hashes).toHaveLength(2);
    expect(rpc.events).toEqual([`send ${hashes[0]}`, `receipt ${hashes[0]}`, `send ${hashes[1]}`, `receipt ${hashes[1]}`]);
    const sent = rpc.raws.map((r) => parseTransaction(r));
    expect(sent[0]).toMatchObject({ type: 'legacy', chainId: 296, to: a.to.toLowerCase(), data: a.data, gas: 60000n, gasPrice: 1310000000000n, nonce: 7 });
    expect(sent[1]).toMatchObject({ chainId: 296, to: b.to.toLowerCase(), data: b.data, gas: 120000n, nonce: 8 });
  });

  it('stops at a reverted step, with the hash, and sends nothing after it', async () => {
    const rpc = fakeRpc({ status: (i) => (i === 0 ? 'reverted' : 'success') });
    const e = await signAndSend(built('contest', [contestTx(), contestTx()]), { account: signer, rpc, nowS: () => NOW }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SendStopped);
    expect(e).toMatchObject({ reason: 'reverted' });
    expect((e as SendStopped).hashes).toHaveLength(1);
    expect(rpc.raws).toHaveLength(1);
  });

  it('refuses another chain, another signer, a passed deadline or an old preview before signing', async () => {
    const reason = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e as SendStopped).reason);
    const rpc = fakeRpc({ chainId: 1 });
    expect(await reason(signAndSend(built('contest', [contestTx()]), { account: signer, rpc, nowS: () => NOW }))).toBe('wrong_chain');
    expect(await reason(signAndSend(built('contest', [contestTx()], { from: PLATFORM }), { account: signer, rpc: fakeRpc(), nowS: () => NOW }))).toBe('wrong_signer');
    expect(await reason(signAndSend(built('contest', [contestTx()], { notAfter: String(NOW - 1) }), { account: signer, rpc: fakeRpc(), nowS: () => NOW }))).toBe('too_late');
    expect(await reason(signAndSend(built('contest', [contestTx()], { builtAt: String(NOW - 301) }), { account: signer, rpc: fakeRpc(), nowS: () => NOW }))).toBe('stale');
    expect(rpc.raws).toHaveLength(0);
  });

  it('signs no gas price over twice what the RPC asks, nor one it cannot check', async () => {
    // the built price is 1.31e12 weibar a gas: at most twice the RPC's 0.655e12 passes, above it stops
    const atTwice = fakeRpc({ gasPrice: 655_000_000_000n });
    await signAndSend(built('contest', [contestTx()]), { account: signer, rpc: atTwice, nowS: () => NOW });
    expect(atTwice.raws).toHaveLength(1);
    const cheap = fakeRpc({ gasPrice: 654_999_999_999n });
    const e = await signAndSend(built('fileClaim', [contestTx(), contestTx()]), { account: signer, rpc: cheap, nowS: () => NOW }).catch((x: unknown) => x);
    expect(e).toMatchObject({ reason: 'gas_price' });
    expect((e as Error).message).toContain('step 1 is priced at 1310000000000 a gas, over 2 times the 654999999999 the RPC asks now');
    const unread = fakeRpc({ gasPrice: null });
    expect(await signAndSend(built('contest', [contestTx()]), { account: signer, rpc: unread, nowS: () => NOW }).catch((x: unknown) => x)).toMatchObject({ reason: 'gas_price' });
    expect(cheap.raws).toHaveLength(0);
    expect(unread.raws).toHaveLength(0);
  });

  it('takes the estimate for a step built on a budget once the step before has mined, and stops above the budget', async () => {
    const budgeted = () => built('fileClaim', [contestTx(), { ...contestTx(), gas: '800000', simulated: false }]);
    const rpc = fakeRpc();
    await signAndSend(budgeted(), { account: signer, rpc, nowS: () => NOW, regas: async () => '610000' });
    expect(parseTransaction(rpc.raws[1]!).gas).toBe(610000n);
    const over = fakeRpc();
    const e = await signAndSend(budgeted(), { account: signer, rpc: over, nowS: () => NOW, regas: async () => '900000' }).catch((x: unknown) => x);
    expect(e).toMatchObject({ reason: 'fee_changed' });
    expect(over.raws).toHaveLength(1);
  });

  it('reports a transaction the node refuses with its first line', async () => {
    const e = await signAndSend(built('contest', [contestTx()]), { account: signer, rpc: fakeRpc({ refuse: true }), nowS: () => NOW }).catch((x: unknown) => x);
    expect(e).toMatchObject({ reason: 'send_failed' });
    expect((e as Error).message).toContain('was refused: INSUFFICIENT_TX_FEE');
    expect((e as Error).message).not.toContain('more text');
  });
});

describe('reading back', () => {
  it('waits through a 404 until the claim shows a sent transaction', async () => {
    const hash = H(0xabc);
    const api = await standIn({
      get: (_p, n) => (n < 3 ? [404, { error: { code: 'not_found', message: 'No such claim yet.' } }] : [200, { claim: { claimId: CLAIM_ID, statusKey: 'filed', events: [{ name: 'ClaimFiled', tx: hash, chain: 'hedera' }] } }]),
    });
    const r = await readBack(v1Client(api.url), built('fileClaim', [contestTx()], { preview: { ...built('contest', []).preview, statusAfter: 'filed' } }), [hash], { intervalMs: 1, timeoutMs: 50, sleep: async () => {} });
    expect(r.shows).toBe(true);
    expect(api.gets).toEqual([`/v1/claims/${CLAIM_ID}`, `/v1/claims/${CLAIM_ID}`, `/v1/claims/${CLAIM_ID}`]);
  });

  it('reads only the API\'s own claim and party paths', async () => {
    const api = await standIn({});
    const r = await readBack(v1Client(api.url), built('contest', [contestTx()], { readBack: 'https://elsewhere.example/v1/claims/0x1' }), [], { intervalMs: 1, timeoutMs: 5, sleep: async () => {} });
    expect(r).toEqual({ body: null, shows: false });
    expect(api.gets).toEqual([]);
  });
});

describe('an action as a command runs it', () => {
  const base = { tool: 'contest', action: 'contest' as const, body: { from: signer.address, claimId: CLAIM_ID }, account: signer, chainId: 296, claimId: CLAIM_ID, calls: () => [contestCall] };

  it('dry run: prints the preview and opens no RPC', async () => {
    const api = await standIn({ post: () => [200, built('contest', [contestTx()])] });
    const p = capture();
    let opened = false;
    const r = await runAction({ ...base, client: v1Client(api.url), send: false, print: p, rpc: async () => ((opened = true), fakeRpc()) });
    expect(r.code).toBe(0);
    expect(opened).toBe(false);
    expect(api.posts).toEqual([{ name: 'contest', body: { from: signer.address, claimId: CLAIM_ID } }]);
    const text = p.lines.join('\n');
    for (const t of [`contest on Hedera testnet (296), signed by ${signer.address}`, 'courtFee: 1.00 mUSDC (1000000 base units)', 'network fee: at most 0.1572 HBAR for 120000 gas', `step 1 of 1: RecourseClaims.contest at ${CLAIMS}`, 'claim status after: contested', 'dry run']) expect(text).toContain(t);
  });

  it('sends, prints the hashes and reads the new state back', async () => {
    const rpc = fakeRpc();
    let sent: Hex | null = null;
    const api = await standIn({
      post: () => [200, built('contest', [contestTx()])],
      get: () => [200, { claim: { claimId: CLAIM_ID, statusKey: sent ? 'contested' : 'finding_made', nextActor: 'anyone', nextAction: { action: 'sendToCourt', actor: 'anyone', deadline: null }, events: sent ? [{ name: 'Contested', tx: sent, chain: 'hedera' }] : [] } }],
    });
    const p = capture();
    const r = await runAction({ ...base, client: v1Client(api.url), send: true, print: p, rpc: async () => rpc, onMined: (_i, m) => (sent = m.hash) });
    expect(r.code, p.errors.join('\n')).toBe(0);
    expect(r.hashes).toEqual([keccak256(rpc.raws[0]!)]);
    const text = p.lines.join('\n');
    expect(text).toContain(`sent ${r.hashes[0]} https://hashscan.io/testnet/transaction/${r.hashes[0]}`);
    expect(text).toContain(`claim ${CLAIM_ID}: status contested`);
    expect(text).toContain('next: sendToCourt by anyone');
    expect(text).toContain(`event Contested in ${r.hashes[0]}`);
  });

  it('shows a typed error as code and message, exits 2, and signs nothing', async () => {
    const api = await standIn({ post: () => [403, { error: { code: 'not_contester', message: 'Only the platform may contest this finding.', details: { contester: PLATFORM } } }] });
    const p = capture();
    const rpc = fakeRpc();
    const r = await runAction({ ...base, client: v1Client(api.url), send: true, print: p, rpc: async () => rpc });
    expect(r.code).toBe(2);
    expect(p.errors).toEqual(['contest: not_contester: Only the platform may contest this finding.', `contest:   (contester ${PLATFORM})`]);
    expect(rpc.raws).toHaveLength(0);
  });

  it('refuses an answer that is not the intended call, exits 2, and signs nothing', async () => {
    const api = await standIn({ post: () => [200, built('contest', [{ ...contestTx(), to: VAULT }])] });
    const p = capture();
    const rpc = fakeRpc();
    const r = await runAction({ ...base, client: v1Client(api.url), send: true, print: p, rpc: async () => rpc });
    expect(r.code).toBe(2);
    expect(p.errors[0]).toContain('refused: the API\'s answer is not the call this command makes');
    expect(p.errors.join('\n')).toContain(`goes to ${VAULT}, not RecourseClaims at ${CLAIMS}`);
    expect(rpc.raws).toHaveLength(0);
  });

  it('builds again for the estimate of a budgeted step after the step before it mined', async () => {
    const approve = txOf('VaultToken', TOKEN, erc20Abi as Abi, 'approve', [VAULT, 1_000_000n]);
    const file = txOf('RecourseClaims', CLAIMS, CLAIMS_ABI, 'contest', [CLAIM_ID], { gas: '800000', simulated: false });
    const api = await standIn({ post: (_n, _b, n) => [200, n === 1 ? built('contest', [approve, file]) : built('contest', [{ ...file, gas: '612000', simulated: true }])] });
    const rpc = fakeRpc();
    const approveCall: IntendedCall = { contract: 'VaultToken', to: TOKEN, abi: erc20Abi as Abi, functionName: 'approve', args: [VAULT, 1_000_000n] };
    const r = await runAction({ ...base, calls: () => [approveCall, contestCall], client: v1Client(api.url), send: true, print: capture(), rpc: async () => rpc, readBackTimeoutMs: 0 });
    expect(r.code).toBe(0);
    expect(api.posts).toHaveLength(2);
    expect(parseTransaction(rpc.raws[1]!).gas).toBe(612000n);
  });

  it('dry run: says which step the API could not simulate yet', async () => {
    const approve = txOf('VaultToken', TOKEN, erc20Abi as Abi, 'approve', [VAULT, 1_000_000n]);
    const file = txOf('RecourseClaims', CLAIMS, CLAIMS_ABI, 'contest', [CLAIM_ID], { gas: '800000', simulated: false });
    const api = await standIn({ post: () => [200, built('contest', [approve, file], { simulated: false })] });
    const approveCall: IntendedCall = { contract: 'VaultToken', to: TOKEN, abi: erc20Abi as Abi, functionName: 'approve', args: [VAULT, 1_000_000n] };
    const p = capture();
    const r = await runAction({ ...base, calls: () => [approveCall, contestCall], client: v1Client(api.url), send: false, print: p, rpc: async () => fakeRpc() });
    expect(r.code, p.errors.join('\n')).toBe(0);
    const last = p.lines.at(-1)!;
    expect(last).toContain('the API simulated step 1; step 2 is on a fixed gas budget');
    expect(last).not.toContain('simulated it against the latest block');
  });

  it('prints a refusal raised before the action as it is', () => {
    const p = capture();
    expect(exitFor('file-claim', new Refused(['no_packed_record: the topic has no packed record']), p)).toBe(2);
    expect(p.errors).toEqual(['file-claim: no_packed_record: the topic has no packed record']);
    expect(exitFor('file-claim', new V1Failure(503, 'upstream_unavailable', 'Hedera did not answer.'), p)).toBe(1);
  });
});

describe('filing after the API has read the records', () => {
  const ORDER_ID = ('0x' + '1b'.repeat(32)) as Hex;
  const KEYS = ['asked', 'shown', 'approval', 'ordered', 'packed', 'arrived'];
  const SEQ: RecordRefs['seq'] = [11n, 12n, 13n, 14n, 15n, 16n];
  const recordsAnswer = (seq: readonly number[]): [number, unknown] => [200, { order: { orderId: ORDER_ID, claimId: null, records: seq.map((s, kind) => ({ kind, key: KEYS[kind], seq: s })) }, meta: {} }];
  const noSleep = { intervalMs: 1, sleep: async () => {} };

  it('reads the records until the API holds every one the refs name', async () => {
    const api = await standIn({ get: (_p, n) => (n === 1 ? [503, { error: { code: 'upstream_unavailable', message: 'Rebuilding.' } }] : recordsAnswer(n === 2 ? [11, 12, 13, 14, 15, 0] : [11, 12, 13, 14, 15, 16])) });
    const p = capture();
    expect(await recordsIndexed(v1Client(api.url), { orderId: ORDER_ID, platform: PLATFORM, shop: signer.address, seq: SEQ }, { ...noSleep, timeoutMs: 50, print: p })).toBe(true);
    expect(api.gets).toEqual(Array(3).fill(`/v1/orders/${ORDER_ID}/records?platform=${PLATFORM}&shop=${signer.address}`));
    expect(p.lines).toEqual(["the status API's index has not read arrived (seq 16) yet; waiting up to 0 s"]);
  });

  it('stops waiting on a refusal or when the time is up, and does not wait on a record the shop has not read', async () => {
    const refused = await standIn({ get: () => [400, { error: { code: 'invalid_field', message: 'Bad orderId.' } }] });
    expect(await recordsIndexed(v1Client(refused.url), { orderId: ORDER_ID, platform: PLATFORM, shop: signer.address, seq: SEQ }, { ...noSleep, timeoutMs: 50, print: capture() })).toBe(false);
    expect(refused.gets).toHaveLength(1);
    const behind = await standIn({ get: () => recordsAnswer([11, 12, 13, 14, 0, 0]) });
    expect(await recordsIndexed(v1Client(behind.url), { orderId: ORDER_ID, platform: PLATFORM, shop: signer.address, seq: SEQ }, { ...noSleep, timeoutMs: 3, print: capture() })).toBe(false);
    expect(behind.gets).toHaveLength(4);
    // the API holding an arrived record the shop did not read is no lag to wait out: the build shows it
    const ahead = await standIn({ get: () => recordsAnswer([11, 12, 13, 14, 15, 16]) });
    expect(await recordsIndexed(v1Client(ahead.url), { orderId: ORDER_ID, platform: PLATFORM, shop: signer.address, seq: [11n, 12n, 13n, 14n, 15n, 0n] }, { ...noSleep, print: capture() })).toBe(true);
  });

  it('builds the fileClaim once, after the wait', async () => {
    const input = {
      orderId: ORDER_ID,
      orderNonce: NONCE,
      platform: PLATFORM,
      refs: { topicNum: 11335218n, seq: SEQ, hashes: [H(1), H(2), H(3), H(4), H(5), H(6)] } as RecordRefs,
      basketUsdc: 2_000_000n,
      netLossUsdc: 2_000_000n,
    };
    const claimId = claimIdOf(296n, CLAIMS, ORDER_ID);
    const file = txOf('RecourseClaims', CLAIMS, CLAIMS_ABI, 'fileClaim', [NONCE, PLATFORM, input.refs, input.basketUsdc, input.netLossUsdc]);
    const order: string[] = [];
    const api = await standIn({
      get: (_p, n) => (order.push('get'), recordsAnswer(n < 3 ? [11, 12, 13, 14, 15, 0] : [11, 12, 13, 14, 15, 16])),
      post: () => (order.push('post'), [200, built('fileClaim', [file], { claimId })]),
    });
    const h = {
      deployment: { claims: CLAIMS, vault: VAULT, usdc: TOKEN, chainId: 296 },
      account: signer,
      client: v1Client(api.url),
      params: { params: { claims: { courtFeeUsdc: '1000000' } } },
      claimsAbi: CLAIMS_ABI,
      vaultAbi: VAULT_ABI,
      rpc: async () => fakeRpc(),
    } as unknown as HederaSide;
    const p = capture();
    const r = await fileClaimRun(h, input, { send: false, journal: { append: () => undefined } as never, print: p, records: noSleep });
    expect(r.code, p.errors.join('\n')).toBe(0);
    expect(order).toEqual(['get', 'get', 'get', 'post']);
    expect(api.posts).toHaveLength(1);
  });
});
