// Wallet connect and the four user actions, against the v1 contract in services/status-api/openapi.json.
// The API and the wallet are both mocked: the API by the contract's own examples, the wallet by a fake
// EIP-1193 provider (for walletOps) or fake WalletOps (for the signing runner).
import { readFileSync } from 'node:fs';
import { evidenceModuleAbi, vaultTokenOf } from '@recourse/shared';
import { renderToString } from 'react-dom/server';
import { encodeFunctionData, erc20Abi, toFunctionSelector, type Abi, type AbiFunction, type EIP1193Provider, type Hash } from 'viem';
import { describe, expect, it } from 'vitest';
import { Shell } from '../src/App.js';
import { ActionFlowView, type Phase } from '../src/actions/ActionFlow.js';
import { ClaimActions, EvidenceAction, FileClaimAction, WithdrawAction, contesterOf, evidenceBytes, evidenceProblem, fileRequest, rememberStep } from '../src/actions/forms.js';
import { ApiFailure, failureFrom } from '../src/lib/api.js';
import {
  ACTION_NAMES, ERROR_WORDS, amountText, errorWords, hasCredit, looksBuilt, postAction, readBackPath, readBackShows, sameCallGas, signingProblems,
  type ActionName, type ActionResponse, type ReadBody,
} from '../src/lib/actions.js';
import { ACTION_CALLS, CALL_ABIS, callProblem } from '../src/lib/calls.js';
import { CHAINS, txLink } from '../src/lib/chains.js';
import { readBack, signAll, type Step } from '../src/lib/flow.js';
import { NO_WALLET, WalletStop, stopWords, walletOps, type WalletOps, type WalletState } from '../src/lib/wallet.js';
import { CaseView, type CaseDetail } from '../src/pages/Case.js';

const root = new URL('../../../', import.meta.url);
const spec = JSON.parse(readFileSync(new URL('services/status-api/openapi.json', root), 'utf8')) as {
  paths: Record<string, { post?: { responses: Record<string, { content?: Record<string, { examples?: Record<string, { value: ActionResponse }> }> }> } }>;
  components: { schemas: { ActionName: { enum: string[] } } };
  'x-recourse-error-codes': { code: string; status: number }[];
};
const generated = (name: string) => JSON.parse(readFileSync(new URL(`deployments/abi/${name}.json`, root), 'utf8')) as Abi;

/** The contract's example answer for an action (a fresh copy each time). */
function example(name: ActionName): ActionResponse {
  const ex = spec.paths[`/v1/actions/${name}`]!.post!.responses['200']!.content!['application/json']!.examples;
  if (!ex) throw new Error(`no example for ${name}`);
  return structuredClone(Object.values(ex)[0]!.value);
}
const EXAMPLED: ActionName[] = ['fileClaim', 'contest', 'submitEvidence', 'withdrawCredit', 'closeUncontested', 'settle', 'relayRuling'];
const SHOP = '0x1111111111111111111111111111111111111111';
const OTHER = '0x9999999999999999999999999999999999999999';
const MOCK = vaultTokenOf({ usdc: { mode: 'mock', address: '0x' + '12'.repeat(20), decimals: 6, tokenId: null } });
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hash;
const asked = (r: ActionResponse) => ({ name: r.action, from: r.from, claimId: r.claimId });
/** Server-rendered HTML without React's `<!-- -->` text separators, so copy can be matched whole. */
const render = (node: Parameters<typeof renderToString>[0]) => renderToString(node).replaceAll('<!-- -->', '');

describe('the contract', () => {
  it('names the same twelve actions, each with the calls it may make', () => {
    expect([...ACTION_NAMES].sort()).toEqual([...spec.components.schemas.ActionName.enum].sort());
    for (const a of ACTION_NAMES) expect(ACTION_CALLS[a].length).toBeGreaterThan(0);
  });
  it('has words for every error code it lists', () => {
    for (const { code, status } of spec['x-recourse-error-codes']) {
      expect(ERROR_WORDS[code], code).toBeTypeOf('function');
      const text = errorWords(new ApiFailure(status, code));
      expect(text.length, code).toBeGreaterThan(10);
      expect(text, code).not.toMatch(/undefined|null|NaN/);
    }
  });
  it('every example answer has the shape the page relies on, and a malformed number does not', () => {
    for (const a of EXAMPLED) expect(looksBuilt(example(a)), a).toBe(true);
    const c = example('contest');
    expect(looksBuilt({ ...c, transactions: [{ ...c.transactions[0]!, value: '1.5' }] })).toBe(false);
    expect(looksBuilt({ ...c, preview: { ...c.preview, fee: { ...c.preview.fee, amount: 'lots' } } })).toBe(false);
    expect(looksBuilt({ ...c, preview: { ...c.preview, amounts: [{ ...c.preview.amounts[0]!, amount: '-1' }] } })).toBe(false);
    expect(looksBuilt({ ...c, notAfter: 'soon' })).toBe(false);
    expect(looksBuilt({ ...c, transactions: [] })).toBe(false);
  });
  it("every example answer passes the checks before signing", () => {
    for (const a of EXAMPLED) {
      const r = example(a);
      expect(signingProblems(r, asked(r), Number(r.builtAt)), a).toEqual([]);
    }
  });
});

describe('ABI fragments', () => {
  const fn = (abi: Abi, name: string) => abi.find((x): x is AbiFunction => x.type === 'function' && x.name === name);
  it('match the generated Recourse ABIs, the ERC-20 approve and the Kleros evidence module', () => {
    const against: Record<string, Abi> = {
      RecourseClaims: generated('RecourseClaims'), DepositVault: generated('DepositVault'), RecourseCase: generated('RecourseCase'),
      EvidenceModule: evidenceModuleAbi as unknown as Abi, VaultToken: erc20Abi as unknown as Abi,
    };
    for (const [contract, abi] of Object.entries(CALL_ABIS)) {
      for (const mine of (abi as Abi).filter((x): x is AbiFunction => x.type === 'function')) {
        const theirs = fn(against[contract]!, mine.name);
        expect(theirs, `${contract}.${mine.name}`).toBeDefined();
        expect(toFunctionSelector(mine), `${contract}.${mine.name}`).toBe(toFunctionSelector(theirs!));
        expect(mine.inputs.map((i) => i.name), `${contract}.${mine.name}`).toEqual(theirs!.inputs.map((i) => i.name));
        expect(mine.stateMutability, `${contract}.${mine.name}`).toBe(theirs!.stateMutability);
      }
    }
  });
});

describe('checks before signing', () => {
  it('refuses data that is not the call shown', () => {
    const r = example('contest');
    const tx = r.transactions[0]!;
    expect(callProblem(tx.data, tx.call)).toBeNull();
    const other = encodeFunctionData({ abi: CALL_ABIS.RecourseClaims, functionName: 'contest', args: [`0x${'ab'.repeat(32)}`] });
    expect(callProblem(other, tx.call)).toContain('different arguments');
    const settle = encodeFunctionData({ abi: CALL_ABIS.RecourseClaims, functionName: 'settle', args: [tx.call.args.claimId as Hash] });
    expect(callProblem(settle, tx.call)).toContain('calls settle, not contest');
    expect(callProblem('0xdeadbeef', tx.call)).toContain('not a RecourseClaims call');
    expect(callProblem(tx.data, { ...tx.call, contract: 'Unknown' })).toContain('does not sign for');
    r.transactions[0] = { ...tx, data: other };
    expect(signingProblems(r, asked(r), Number(r.builtAt)).join(' ')).toContain('does not match the call shown');
  });
  it('refuses another account, another action, another claim, another network or a passed deadline', () => {
    const r = example('contest');
    const t = Number(r.builtAt);
    expect(signingProblems(r, { ...asked(r), from: OTHER }, t).join(' ')).toContain('not your account');
    expect(signingProblems(r, { ...asked(r), name: 'settle' }, t).join(' ')).toContain('built contest, not settle');
    expect(signingProblems(r, { ...asked(r), claimId: `0x${'cd'.repeat(32)}` }, t).join(' ')).toContain('different claim');
    expect(signingProblems({ ...r, chainId: 1, transactions: r.transactions.map((x) => ({ ...x, chainId: 1 })) }, asked(r), t).join(' ')).toContain('signs only on Hedera testnet and Arbitrum Sepolia');
    expect(signingProblems(r, asked(r), Number(r.notAfter) + 1).join(' ')).toContain('deadline for this call passed');
  });
  it('refuses a call the action never needs, an approve above the court fee, and value the preview does not show', () => {
    const f = example('fileClaim');
    const big = encodeFunctionData({ abi: CALL_ABIS.VaultToken, functionName: 'approve', args: [f.transactions[0]!.call.args.spender as `0x${string}`, 2n ** 255n] });
    const approve = { ...f.transactions[0]!, data: big, call: { ...f.transactions[0]!.call, args: { ...f.transactions[0]!.call.args, amount: (2n ** 255n).toString() } } };
    expect(signingProblems({ ...f, transactions: [approve, f.transactions[1]!] }, asked(f), Number(f.builtAt)).join(' ')).toContain('approves a different amount');
    const c = example('contest');
    expect(signingProblems(c, { ...asked(c), name: 'withdrawCredit' }, Number(c.builtAt)).join(' ')).toContain('which withdrawCredit never needs');
    c.transactions[0]!.value = '5';
    expect(signingProblems(c, asked(c), Number(c.builtAt)).join(' ')).toContain('value the preview does not show');
    // relayRuling's value is shown as a `send` amount, so it passes.
    const rr = example('relayRuling');
    expect(rr.transactions[0]!.value).not.toBe('0');
    expect(signingProblems(rr, asked(rr), Number(rr.builtAt))).toEqual([]);
  });
});

describe('the API call', () => {
  function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}): typeof fetch {
    return (async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.init = init;
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
  }
  it('posts JSON to /api/v1/actions/<name> and returns the built answer', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const r = await postAction('contest', { from: SHOP, claimId: example('contest').claimId }, fakeFetch(200, example('contest'), seen));
    expect(r.action).toBe('contest');
    expect(seen.url).toBe('/api/v1/actions/contest');
    expect(seen.init?.method).toBe('POST');
    expect((seen.init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(Object.keys(JSON.parse(String(seen.init?.body)))).toEqual(['from', 'claimId']);
  });
  it('reads a v1 error, the older string form, a dead connection and a malformed answer', async () => {
    /** The ApiFailure a call is refused with; fails the test if it is not refused. */
    const refusal = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a refusal'); }, (e: unknown) => e as ApiFailure);
    const refused = await refusal(postAction('contest', { from: SHOP }, fakeFetch(403, { error: { code: 'not_contester', message: 'Only the platform may contest.', details: { contester: OTHER } } })));
    expect(refused).toBeInstanceOf(ApiFailure);
    expect(refused.code).toBe('not_contester');
    expect(errorWords(refused, { from: SHOP })).toContain('Only 0x9999');
    expect(errorWords(refused, { from: SHOP })).toContain('Switch to that account');
    expect((await refusal(postAction('contest', { from: SHOP }, fakeFetch(429, { error: 'rate_limited' })))).code).toBe('rate_limited');
    expect(errorWords(await refusal(postAction('contest', { from: SHOP }, fakeFetch(405, { error: 'read_only' }))))).toContain('does not build actions yet');
    const dead = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect((await refusal(postAction('contest', { from: SHOP }, dead))).code).toBe('unreachable');
    expect((await refusal(postAction('contest', { from: SHOP }, fakeFetch(200, { ok: true })))).code).toBe('bad_answer');
  });
  it('puts details into the words, and falls back to the API sentence, then the status', () => {
    expect(errorWords(failureFrom(409, { error: { code: 'window_closed', message: 'x', details: { closesAt: '1793995800' } } }))).toContain('2026-11-06');
    expect(errorWords(failureFrom(409, { error: { code: 'insufficient_balance', message: 'x', details: { balance: '500000', required: '1000000' } } }), { token: MOCK })).toBe('Your account holds 0.50 mUSDC (testnet mock) and the court fee is 1.00 mUSDC (testnet mock).');
    expect(errorWords(failureFrom(503, { error: { code: 'upstream_unavailable', message: 'x', details: { upstream: 'hedera_rpc' } } }))).toContain('(Hedera)');
    expect(errorWords(failureFrom(409, { error: { code: 'call_reverted', message: 'x', details: { revert: { contract: 'RecourseClaims', name: 'BadRefs', args: [] } } } }))).toContain('RecourseClaims BadRefs');
    expect(errorWords(failureFrom(409, { error: { code: 'some_new_code', message: 'A sentence from the API.' } }))).toBe('A sentence from the API.');
    expect(errorWords(failureFrom(409, { error: 'some_new_code' }))).toBe('The chain does not allow this right now.');
    expect(failureFrom(502, 'not json').code).toBe('unreachable');
  });
});

describe('the wallet, through viem', () => {
  type Call = { method: string; params?: unknown };
  function fakeProvider(opts: { chainId?: number; accounts?: string[]; fail?: Record<string, { code: number; message: string }>; switchTo?: boolean } = {}) {
    let chainId = opts.chainId ?? 296;
    const calls: Call[] = [];
    const provider = {
      async request({ method, params }: Call) {
        calls.push({ method, params });
        const f = opts.fail?.[method];
        if (f) {
          if (method === 'wallet_switchEthereumChain' && f.code === 4902) delete opts.fail![method];
          throw Object.assign(new Error(f.message), { code: f.code });
        }
        switch (method) {
          case 'eth_chainId':
            return `0x${chainId.toString(16)}`;
          case 'eth_accounts':
          case 'eth_requestAccounts':
            return opts.accounts ?? [SHOP];
          case 'wallet_switchEthereumChain':
          case 'wallet_addEthereumChain':
            if (opts.switchTo !== false) chainId = Number((params as [{ chainId: string }])[0].chainId);
            return null;
          case 'eth_sendTransaction':
            return hash(1);
          case 'eth_blockNumber':
            return '0x10';
          case 'eth_getTransactionReceipt':
            return {
              blockHash: hash(9), blockNumber: '0x10', contractAddress: null, cumulativeGasUsed: '0x1', effectiveGasPrice: '0x1', from: SHOP, gasUsed: '0x1',
              logs: [], logsBloom: `0x${'0'.repeat(512)}`, status: (params as [string])[0] === hash(2) ? '0x0' : '0x1', to: OTHER, transactionHash: (params as [string])[0], transactionIndex: '0x0', type: '0x0',
            };
          default:
            throw Object.assign(new Error(`unexpected ${method}`), { code: -32601 });
        }
      },
      on() {},
      removeListener() {},
    };
    return { provider: provider as unknown as EIP1193Provider, calls };
  }
  it('adds the chain when the wallet does not know it, with the Hedera testnet details', async () => {
    const { provider, calls } = fakeProvider({ chainId: 1, fail: { wallet_switchEthereumChain: { code: 4902, message: 'Unrecognized chain ID' } } });
    await walletOps(provider).ensureChain(296);
    const add = calls.find((c) => c.method === 'wallet_addEthereumChain')!;
    expect(add.params).toEqual([
      { chainId: '0x128', chainName: 'Hedera Testnet', nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 }, rpcUrls: ['https://testnet.hashio.io/api'], blockExplorerUrls: ['https://hashscan.io/testnet'] },
    ]);
  });
  it('switches to Arbitrum Sepolia, and does nothing when already there', async () => {
    const a = fakeProvider({ chainId: 296 });
    await walletOps(a.provider).ensureChain(421614);
    expect(a.calls.find((c) => c.method === 'wallet_switchEthereumChain')!.params).toEqual([{ chainId: '0x66eee' }]);
    const b = fakeProvider({ chainId: 421614 });
    await walletOps(b.provider).ensureChain(421614);
    expect(b.calls.map((c) => c.method)).toEqual(['eth_chainId']);
  });
  it('reports a refused switch as rejected, and a wallet that will not switch as the wrong chain', async () => {
    const no = fakeProvider({ chainId: 1, fail: { wallet_switchEthereumChain: { code: 4001, message: 'User rejected the request.' } } });
    expect(((await walletOps(no.provider).ensureChain(296).catch((e: unknown) => e)) as WalletStop).kind).toBe('rejected');
    const stuck = fakeProvider({ chainId: 1, switchTo: false });
    const e = (await walletOps(stuck.provider).ensureChain(296).catch((x: unknown) => x)) as WalletStop;
    expect(e.kind).toBe('wrong_chain');
    expect(stopWords(e)).toContain('Hedera testnet (chain 296)');
  });
  it('sends the built target, data, value and gas limit, and leaves the fee to the wallet', async () => {
    const { provider, calls } = fakeProvider();
    const tx = example('contest').transactions[0]!;
    expect(await walletOps(provider).send(tx, SHOP)).toBe(hash(1));
    const sent = (calls.find((c) => c.method === 'eth_sendTransaction')!.params as [Record<string, string>])[0];
    expect(sent).toMatchObject({ from: SHOP, to: tx.to, data: tx.data, value: '0x0', gas: `0x${BigInt(tx.gas).toString(16)}` });
    expect(sent.gasPrice).toBeUndefined();
    expect(sent.maxFeePerGas).toBeUndefined();
  });
  it('refuses to send on the wrong chain, and reports a refused signature as rejected', async () => {
    const wrong = fakeProvider({ chainId: 421614 });
    expect(((await walletOps(wrong.provider).send(example('contest').transactions[0]!, SHOP).catch((e: unknown) => e)) as WalletStop).kind).toBe('wrong_chain');
    expect(wrong.calls.some((c) => c.method === 'eth_sendTransaction')).toBe(false);
    const no = fakeProvider({ fail: { eth_sendTransaction: { code: 4001, message: 'User denied transaction signature.' } } });
    const e = (await walletOps(no.provider).send(example('contest').transactions[0]!, SHOP).catch((x: unknown) => x)) as WalletStop;
    expect(e.kind).toBe('rejected');
    expect(stopWords(e)).toContain('nothing was sent');
  });
  it('waits for the receipt through the wallet', async () => {
    const { provider } = fakeProvider();
    expect(await walletOps(provider, { pollMs: 5 }).wait(296, hash(1))).toEqual({ status: 'success', hash: hash(1) });
    expect((await walletOps(provider, { pollMs: 5 }).wait(296, hash(2))).status).toBe('reverted');
  });
});

describe('signing in order', () => {
  function fakeOps(over: Partial<WalletOps> & { account?: string; receipts?: Record<string, 'success' | 'reverted'> } = {}) {
    const log: string[] = [];
    let n = 0;
    const ops: WalletOps = {
      accounts: async () => [(over.account ?? SHOP) as `0x${string}`],
      connect: async () => [SHOP],
      chainId: async () => 296,
      ensureChain: over.ensureChain ?? (async (id) => void log.push(`chain ${id}`)),
      send:
        over.send ??
        (async (tx) => {
          log.push(`send ${tx.call.function}`);
          return hash(++n);
        }),
      wait: over.wait ?? (async (_id, h) => (log.push(`wait ${h.slice(-1)}`), { status: over.receipts?.[h] ?? 'success', hash: h })),
    };
    return { ops, log };
  }
  const track = () => {
    const seen: Step[][] = [];
    let steps: Step[] = [];
    return { seen, on: (i: number, s: Step) => ((steps = [...steps]), (steps[i] = s), seen.push(steps)) };
  };
  it('signs approve, waits for it to mine, then signs fileClaim', async () => {
    const f = example('fileClaim');
    const { ops, log } = fakeOps();
    const t = track();
    const hashes = await signAll(f, ops, t.on, () => Number(f.builtAt));
    expect(hashes).toEqual([hash(1), hash(2)]);
    expect(log).toEqual(['chain 296', 'send approve', 'wait 1', 'chain 296', 'send fileClaim', 'wait 2']);
    expect(t.seen.at(-1)!.map((s) => s.state)).toEqual(['mined', 'mined']);
  });
  it('stops before signing when the wallet is on another account', async () => {
    const f = example('contest');
    const { ops, log } = fakeOps({ account: OTHER });
    const e = (await signAll(f, ops, () => {}, () => Number(f.builtAt)).catch((x: unknown) => x)) as WalletStop;
    expect(e.kind).toBe('wrong_account');
    expect(stopWords(e)).toContain(`built for ${f.from}`);
    expect(log.some((l) => l.startsWith('send'))).toBe(false);
  });
  it('keeps the first step when the second is rejected', async () => {
    const f = example('fileClaim');
    let n = 0;
    const { ops } = fakeOps({
      send: async () => {
        if (++n === 2) throw new WalletStop('rejected');
        return hash(n);
      },
    });
    const t = track();
    const e = (await signAll(f, ops, t.on, () => Number(f.builtAt)).catch((x: unknown) => x)) as WalletStop;
    expect(e.kind).toBe('rejected');
    expect(t.seen.at(-1)!.map((s) => s.state)).toEqual(['mined', 'failed']);
    expect(t.seen.at(-1)![0]!.hash).toBe(hash(1));
  });
  it('stops at a reverted transaction and keeps its hash', async () => {
    const f = example('fileClaim');
    const { ops, log } = fakeOps({ receipts: { [hash(1)]: 'reverted' } });
    const t = track();
    const e = (await signAll(f, ops, t.on, () => Number(f.builtAt)).catch((x: unknown) => x)) as WalletStop;
    expect(e.kind).toBe('reverted');
    expect(e.facts.hash).toBe(hash(1));
    expect(log).not.toContain('send fileClaim');
    expect(t.seen.at(-1)![0]).toEqual({ state: 'failed', hash: hash(1) });
  });
  it('follows a sped-up replacement to its hash', async () => {
    const c = example('contest');
    const { ops } = fakeOps({ wait: async (_id, _h, onHash) => (onHash?.(hash(7)), { status: 'success', hash: hash(7) }) });
    expect(await signAll(c, ops, () => {}, () => Number(c.builtAt))).toEqual([hash(7)]);
  });
  describe('a step built with a gas budget, estimated again once the step before it has mined', () => {
    const sentGas = () => {
      const gas: string[] = [];
      let n = 0;
      return { gas, send: async (tx: ActionResponse['transactions'][number]) => (gas.push(tx.gas), hash(++n)) };
    };
    it('signs fileClaim with the lower estimate, asked for only after approve has mined', async () => {
      const f = example('fileClaim');
      const budget = f.transactions[1]!.gas;
      expect(f.transactions[1]!.simulated).toBe(false);
      const order: string[] = [];
      const s = sentGas();
      const { ops } = fakeOps({ send: async (tx) => (order.push(`send ${tx.call.function}`), s.send(tx)), wait: async (_id, h) => (order.push('mined'), { status: 'success', hash: h }) });
      const t = track();
      const regas = async (tx: ActionResponse['transactions'][number]) => (order.push(`estimate ${tx.call.function}`), '731000');
      await signAll(f, ops, t.on, () => Number(f.builtAt), regas);
      expect(order).toEqual(['send approve', 'mined', 'estimate fileClaim', 'send fileClaim', 'mined']);
      expect(s.gas).toEqual([f.transactions[0]!.gas, '731000']);
      expect(BigInt('731000')).toBeLessThan(BigInt(budget));
      expect(t.seen.some((steps) => steps[1]?.state === 'estimating')).toBe(true);
    });
    it('keeps the budget when the API has no estimate, cannot be reached or answers nonsense', async () => {
      for (const regas of [async () => null, async () => Promise.reject(new ApiFailure(0, 'unreachable')), async () => '0x10', async () => '0']) {
        const f = example('fileClaim');
        const s = sentGas();
        const { ops } = fakeOps({ send: s.send });
        await signAll(f, ops, () => {}, () => Number(f.builtAt), regas);
        expect(s.gas[1]).toBe(f.transactions[1]!.gas);
      }
    });
    it('stops before the second signature when the estimate is above the budget the preview showed', async () => {
      const f = example('fileClaim');
      const s = sentGas();
      const { ops } = fakeOps({ send: s.send });
      const t = track();
      const above = (BigInt(f.transactions[1]!.gas) + 1n).toString();
      const e = (await signAll(f, ops, t.on, () => Number(f.builtAt), async () => above).catch((x: unknown) => x)) as WalletStop;
      expect(e.kind).toBe('fee_changed');
      expect(stopWords(e)).toContain('Build it again to see the new fee');
      expect(s.gas).toHaveLength(1);
      expect(t.seen.at(-1)!.map((x) => x.state)).toEqual(['mined', 'failed']);
      expect(t.seen.at(-1)![0]!.hash).toBe(hash(1));
    });
    it('never asks again for a step the API already simulated', async () => {
      const c = example('contest');
      let asked = 0;
      const { ops } = fakeOps();
      await signAll(c, ops, () => {}, () => Number(c.builtAt), async () => (asked++, '1'));
      expect(asked).toBe(0);
    });
    it('takes the estimate only for the same call, simulated, built for the same action and account', () => {
      const f = example('fileClaim');
      const file = f.transactions[1]!;
      const again = (over: Partial<typeof file> = {}, top: Partial<ActionResponse> = {}): ActionResponse => ({ ...f, ...top, transactions: [{ ...file, simulated: true, gas: '731000', ...over }] });
      expect(sameCallGas(f, again(), file)).toBe('731000');
      expect(sameCallGas(f, again({ to: file.to.toLowerCase() as typeof file.to, data: file.data.toUpperCase().replace('0X', '0x') as typeof file.data }), file)).toBe('731000');
      expect(sameCallGas(f, again({ simulated: false }), file)).toBeNull();
      expect(sameCallGas(f, again({ data: (file.data.slice(0, -1) + (file.data.endsWith('0') ? '1' : '0')) as typeof file.data }), file)).toBeNull();
      expect(sameCallGas(f, again({ value: '1' }), file)).toBeNull();
      expect(sameCallGas(f, again({ to: OTHER as typeof file.to }), file)).toBeNull();
      expect(sameCallGas(f, again({ chainId: 421614 }), file)).toBeNull();
      expect(sameCallGas(f, again({}, { from: OTHER as ActionResponse['from'] }), file)).toBeNull();
      expect(sameCallGas(f, again({}, { action: 'contest' }), file)).toBeNull();
    });
  });
  it('will not sign past the deadline or an old preview', async () => {
    const c = example('contest');
    const { ops, log } = fakeOps();
    expect(((await signAll(c, ops, () => {}, () => Number(c.notAfter) + 1).catch((x: unknown) => x)) as WalletStop).kind).toBe('too_late');
    expect(((await signAll(c, ops, () => {}, () => Number(c.builtAt) + 301).catch((x: unknown) => x)) as WalletStop).kind).toBe('stale');
    expect(log).toEqual([]);
  });
});

describe('reading the new state back', () => {
  const claim = (over: Partial<Extract<ReadBody, { claim: unknown }>['claim']> = {}): ReadBody => ({
    claim: { claimId: example('contest').claimId!, statusKey: 'finding_made', events: [], court: { evidence: [] }, ...over },
    meta: { vaultToken: MOCK },
  });
  const quick = { intervalMs: 1, timeoutMs: 50, sleep: async () => {} };
  it('waits through a 404 until the new claim shows the filing transaction', async () => {
    const f = example('fileClaim');
    let n = 0;
    const get = async () => {
      if (++n < 3) throw new ApiFailure(404, 'not_found');
      return claim({ statusKey: 'filed', events: [{ name: 'ClaimFiled', tx: hash(2).toUpperCase().replace('0X', '0x'), chain: 'hedera', explorer: null }] });
    };
    const r = await readBack(f, [hash(1), hash(2)], { ...quick, get });
    expect(r.shows).toBe(true);
    expect(n).toBe(3);
  });
  it('sees a contest by its status, evidence by its transaction, and a withdrawal by the credit', () => {
    expect(readBackShows(example('contest'), claim({ statusKey: 'contested' }), [hash(1)])).toBe(true);
    expect(readBackShows(example('contest'), claim(), [hash(1)])).toBe(false);
    expect(readBackShows(example('submitEvidence'), claim({ statusKey: 'at_court', court: { evidence: [{ tx: hash(3), attempt: 1, time: '1', explorer: null }] } }), [hash(3)])).toBe(true);
    const w = example('withdrawCredit');
    expect(readBackShows(w, { party: { address: SHOP, credit: '0' } }, [hash(1)])).toBe(true);
    expect(readBackShows(w, { party: { address: SHOP, credit: w.input.credit as string } }, [hash(1)])).toBe(false);
    expect(readBackShows(w, { party: { address: SHOP, credit: null } }, [hash(1)])).toBe(false);
  });
  it('gives up with the last read, and reads only the API own /v1 paths', async () => {
    const r = await readBack(example('contest'), [hash(1)], { ...quick, get: async () => claim() });
    expect(r).toMatchObject({ shows: false, body: { claim: { statusKey: 'finding_made' } } });
    let called = false;
    const elsewhere = await readBack({ ...example('contest'), readBack: 'https://example.invalid/v1/claims/0x12' }, [hash(1)], { ...quick, get: async () => ((called = true), claim()) });
    expect(elsewhere).toEqual({ body: null, shows: false });
    expect(called).toBe(false);
    expect(readBackPath('/v1/parties/0x1111111111111111111111111111111111111111')).not.toBeNull();
    expect(readBackPath('/v1/claims/0x12/../../admin')).toBeNull();
  });
});

describe('what the person sees', () => {
  const connected: WalletState = { available: true, account: SHOP as `0x${string}`, chainId: 296, connecting: false, error: null };
  const view = (phase: Phase, wallet: WalletState = connected, extra: Partial<Parameters<typeof ActionFlowView>[0]> = {}) =>
    render(<ActionFlowView name={phase.kind === 'form' ? 'contest' : 'fileClaim'} request={{ claimId: '0x12' }} wallet={wallet} phase={phase} token={MOCK} {...extra} />);

  it('works with no wallet: the action says how to sign, and nothing can be built', () => {
    const html = view({ kind: 'form' }, NO_WALLET);
    expect(html).toContain('open the page in a browser with a wallet');
    expect(html).toContain('works without one');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Show what this will do/);
  });
  it('says which account must sign when the wallet is on another', () => {
    const html = view({ kind: 'form' }, { ...connected, account: OTHER as `0x${string}` }, { signer: { address: SHOP, who: 'the shop' } });
    expect(html).toContain('This must be signed by the shop');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Show what this will do/);
  });
  it('previews amounts with units (the mock labelled), the network, the fee and each transaction', () => {
    const f = example('fileClaim');
    const html = view({ kind: 'preview', resp: f, problems: [] }, connected, { names: { [(f.input.platform as string).toLowerCase()]: 'the agent company' } });
    for (const t of ['Hedera testnet (chain 296)', '25.00 mUSDC (testnet mock)', '2.25 mUSDC (testnet mock)', '1.00 mUSDC (testnet mock)', '28.25 mUSDC (testnet mock)']) expect(html).toContain(t);
    expect(html).not.toMatch(/\d mUSDC(?! \(testnet mock\))/);
    expect(html).toContain('Leaves your wallet into the claim&#x27;s escrow');
    expect(html).toContain('Held from the agent company&#x27;s deposit in the vault');
    expect(html).toContain('At most 0.60918 HBAR');
    expect(html).toContain('Hedera charges for the gas the call uses');
    expect(html).not.toContain('80%');
    expect(html).toContain('fixed budget');
    expect(html).toContain('2 transactions, signed in this order');
    expect(html).toContain('VaultToken.approve');
    expect(html).toContain('RecourseClaims.fileClaim');
    expect(html).toContain('Send fileClaim only after approve has mined');
    expect(html).toContain('Claim status after');
    expect(html).toContain('Confirm and sign 2 transactions');
  });
  it('previews evidence on Arbitrum with no money moving and the fee in ETH', () => {
    const html = view({ kind: 'preview', resp: example('submitEvidence'), problems: [] });
    expect(html).toContain('Arbitrum Sepolia (chain 421614)');
    expect(html).toContain('No money moves.');
    expect(html).toContain('0.0000096 ETH');
    expect(html).not.toContain('Hedera charges');
  });
  it('will not offer to sign an answer that failed a check', () => {
    const html = view({ kind: 'preview', resp: example('contest'), problems: ['The transaction does not match the call shown.'] });
    expect(html).toContain('will not ask your wallet to sign this');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Confirm and sign/);
  });
  it('shows each hash with its explorer link, then the state read back', () => {
    const f = example('fileClaim');
    const steps: Step[] = [{ state: 'mined', hash: hash(1) }, { state: 'mining', hash: hash(2) }];
    const html = view({ kind: 'signing', resp: f, steps });
    expect(html).toContain(hash(1));
    expect(html).toContain(`https://hashscan.io/testnet/transaction/${hash(2)}`);
    expect(html).toContain('on HashScan');
    const ev = example('submitEvidence');
    expect(view({ kind: 'reading', resp: ev, steps: [{ state: 'mined', hash: hash(3) }] })).toContain(`https://sepolia.arbiscan.io/tx/${hash(3)}`);
    const done = view({ kind: 'done', resp: f, steps: [{ state: 'mined', hash: hash(1) }, { state: 'mined', hash: hash(2) }], after: { claim: { claimId: f.claimId!, statusKey: 'filed', escrow: { amount: '1000000', fate: 'held' } }, meta: { vaultToken: MOCK } }, shows: true });
    expect(done).toContain('Read back from the chain');
    expect(done).toContain('Claim status now');
    expect(done).toContain('Filed');
    expect(done).toContain('1.00 mUSDC (testnet mock)');
    expect(done).toContain(`#/claim/${f.claimId}`);
    const credit = view({ kind: 'done', resp: example('withdrawCredit'), steps: [{ state: 'mined', hash: hash(4) }], after: { party: { address: SHOP, credit: '0' }, meta: { vaultToken: MOCK } }, shows: true });
    expect(credit).toContain('Credit now');
    expect(credit).toContain('0.00 mUSDC (testnet mock)');
    const late = view({ kind: 'done', resp: example('contest'), steps: [{ state: 'mined', hash: hash(5) }], after: null, shows: false });
    expect(late).toContain('has not answered with the new state yet');
  });
  it('a panel that is no longer due keeps a started flow on screen, and shows nothing otherwise', () => {
    const c = example('contest');
    const done: Phase = { kind: 'done', resp: c, steps: [{ state: 'mined', hash: hash(6) }], after: { claim: { claimId: c.claimId!, statusKey: 'at_court' } }, shows: true };
    const kept = view(done, connected, { offered: false });
    expect(kept).toContain(hash(6));
    expect(kept).toContain('Read back from the chain');
    expect(kept).toContain('At court');
    expect(view({ kind: 'signing', resp: c, steps: [{ state: 'mining', hash: hash(6) }] }, connected, { offered: false })).toContain(hash(6));
    expect(view({ kind: 'form' }, connected, { offered: false })).toBe('');
    expect(view({ kind: 'refused', problem: { text: 'x' } }, connected, { offered: false })).toBe('');
    expect(view({ kind: 'form' }, connected)).toContain('Show what this will do');
  });
  it('remembers each next step offered, once, in order', () => {
    let seen = rememberStep([], 'sendToCourt');
    seen = rememberStep(seen, 'sendToCourt');
    seen = rememberStep(seen, null);
    seen = rememberStep(seen, 'openCase');
    expect(seen).toEqual(['sendToCourt', 'openCase']);
  });
  it('explains a refusal by its code, and a stop in the wallet', () => {
    const exists = view({ kind: 'refused', problem: { text: errorWords(failureFrom(409, { error: { code: 'claim_exists', message: 'x', details: { claimId: '0x' + '77'.repeat(32) } } })), code: 'claim_exists', claimId: '0x' + '77'.repeat(32) } });
    expect(exists).toContain('already filed');
    expect(exists).toContain(`#/claim/0x${'77'.repeat(32)}`);
    const f = example('fileClaim');
    const stopped = view({ kind: 'stopped', resp: f, steps: [{ state: 'mined', hash: hash(1) }, { state: 'failed', hash: null }], problem: { text: stopWords(new WalletStop('rejected')), code: 'rejected' } });
    expect(stopped).toContain('You declined in your wallet');
    expect(stopped).toContain('Building again picks up from there');
    expect(stopped).toContain('Build it again');
  });
});

describe('the forms', () => {
  it('contest is for the side the pre-check went against', () => {
    const d = { shop: SHOP, platform: OTHER };
    expect(contesterOf({ ...d, answer: 1 }).address).toBe(OTHER);
    for (const answer of [0, 2, 3, null]) expect(contesterOf({ ...d, answer }).address).toBe(SHOP);
  });
  it('evidence is measured as the API builds it', () => {
    const ev = example('submitEvidence');
    const doc = JSON.parse(ev.input.evidence as string) as { name: string; description: string; fileURI: string };
    expect(evidenceBytes(doc.name, doc.description, doc.fileURI)).toBe(ev.input.byteLength);
    expect(evidenceProblem('Photo', 'x'.repeat(49152), '')).toContain('the most is 49,152');
    expect(evidenceProblem('Photo', 'ok', 'ftp://x')).toContain('/ipfs/ or https://');
    expect(evidenceProblem('Photo', 'ok', '/ipfs/bafysample')).toBeNull();
    expect(evidenceProblem('x'.repeat(201), 'ok', '')).toContain('200 characters');
  });
  it('fileClaim sends the order id, the nonce and agent company together when given, and never the basket', () => {
    const orderId = '0x' + '22'.repeat(32);
    const base = { orderId, netLoss: '', nonce: '', platform: '', unpacked: false, withNonce: false };
    expect(fileRequest(base)).toEqual({ problem: null, request: { orderId } });
    expect(fileRequest({ ...base, netLoss: '12.5', unpacked: true }).request).toEqual({ orderId, netLossUsdc: '12500000', allowUnpacked: true });
    expect(fileRequest({ ...base, withNonce: true, nonce: '0x' + '3c'.repeat(32), platform: OTHER }).request).toEqual({ orderId, platform: OTHER, orderNonce: '0x' + '3c'.repeat(32) });
    expect(fileRequest({ ...base, withNonce: true, nonce: '0x12', platform: OTHER }).problem).toContain('64 hex');
    expect(fileRequest({ ...base, withNonce: true, nonce: '0x' + '3c'.repeat(32), platform: '' }).problem).toContain('agent company address');
    expect(fileRequest({ ...base, netLoss: 'lots' }).problem).toContain('50.00');
    for (const r of [fileRequest(base), fileRequest({ ...base, netLoss: '5' })]) expect(r.request).not.toHaveProperty('basketUsdc');
  });
  it('credit is withdrawable only when read and above zero', () => {
    expect(hasCredit('1')).toBe(true);
    expect(hasCredit('0')).toBe(false);
    expect(hasCredit(null)).toBe(false);
  });
  it('amounts in other units are exact', () => {
    expect(amountText({ amount: '41000000000000', decimals: 18, symbol: 'ETH' })).toBe('0.000041 ETH');
    expect(amountText({ amount: '1000000', decimals: 6, symbol: 'USDC' })).toBe('1.00 USDC');
  });
});

describe('the pages, with no wallet', () => {
  function detail(statusKey: CaseDetail['statusKey'], over: Partial<CaseDetail> = {}): CaseDetail {
    return {
      claimId: '0x' + '11'.repeat(32), orderId: '0x' + '22'.repeat(32), shop: SHOP, shopName: 'Example Shop (sample)', platform: OTHER, platformName: 'Example Agent Co (sample)',
      filedAt: '1700000000', statusKey, nextActor: 'platform', nextCall: 'contest', deadline: null, findingSide: 'platform', gap: 1, answer: 1, basketUsdc: '60000000', netLossUsdc: '50000000',
      refs: { hashes: [] }, records: [], precheck: { gap: 1, answer: 1, side: 'platform', packHash: '0x' + '55'.repeat(32), packHashOk: true },
      contest: { by: null, at: null, windowEndsAt: '1700000600' },
      court: { state: 'none', attempts: 0, disputeIds: [], period: null, periodName: null, currentRuling: null, tied: null, overridden: null, ruling: null, evidence: [], courtLinks: [] },
      messages: [], money: { owed: null, paid: null, credited: null, notCovered: null, escrow: { amount: '1000000', fate: 'held' }, projected: false },
      docket: { writeStatus: 'none', entityKey: null, store: null }, events: [], vaultToken: MOCK, ...over,
    };
  }
  it('a claim open to contest offers it, naming who signs', () => {
    const html = render(<CaseView d={detail('finding_made')} />);
    expect(html).toContain('Contest the finding');
    expect(html).toContain('Only the agent company can contest');
    expect(html).toContain('It can be done below with a browser wallet');
    expect(html).not.toContain('Connect wallet');
  });
  it('a claim at court takes evidence; a settled one offers nothing', () => {
    const court = { ...detail('at_court').court, state: 'opened', attempts: 1, disputeIds: ['1234'], periodName: 'vote' };
    const html = render(<CaseView d={detail('at_court', { nextActor: 'court', nextCall: null, court })} />);
    expect(html).toContain('Add evidence to the court case');
    expect(html).toContain('Jurors voting');
    expect(html).not.toContain('Contest the finding');
    const done = render(<CaseView d={detail('settled', { nextActor: 'none', nextCall: null })} />);
    expect(done).not.toContain('Show what this will do');
    expect(render(<ClaimActions d={detail('settled', { nextActor: 'none', nextCall: null })} />)).toBe('');
  });
  it('the step anyone may take is offered with the keeper named', () => {
    const html = render(<CaseView d={detail('ruled', { nextActor: 'anyone', nextCall: 'settle' })} />);
    expect(html).toContain('Settle the claim');
    expect(html).toContain('The Recourse keeper takes it on its own');
  });
  it('file and withdraw render, and every route renders with no wallet control', () => {
    expect(render(<FileClaimAction orderId={'0x' + '22'.repeat(32)} packedHeld={false} platform="" netLoss="" token={MOCK} />)).toContain('File without a packing record');
    expect(render(<FileClaimAction orderId={'0x' + '22'.repeat(32)} packedHeld platform="" netLoss="" token={MOCK} />)).not.toContain('File without a packing record');
    expect(render(<WithdrawAction address={SHOP} credit="28250000" token={MOCK} />)).toContain("this account's credit in the deposit vault (28.25 mUSDC (testnet mock))".replace("'", '&#x27;'));
    expect(render(<WithdrawAction address={SHOP} credit="0" token={MOCK} />)).toBe('');
    expect(render(<WithdrawAction address={SHOP} credit={null} token={MOCK} />)).toBe('');
    expect(render(<EvidenceAction d={detail('at_court', { court: { ...detail('at_court').court, disputeIds: ['1', '2'] } })} />)).toContain('Second case (dispute #2)');
    for (const h of ['#/', '#/docket', '#/file', '#/claim/0x12', '#/party/0x12']) {
      const html = render(<Shell hash={h} />);
      expect(html).not.toContain('Connect wallet');
      expect(html).toContain('never holds a key');
    }
  });
  it('explorer links and chain details are the test networks', () => {
    expect(txLink(296, hash(1))).toBe(`https://hashscan.io/testnet/transaction/${hash(1)}`);
    expect(txLink(421614, hash(1))).toBe(`https://sepolia.arbiscan.io/tx/${hash(1)}`);
    expect(txLink(1, hash(1))).toBeNull();
    expect(CHAINS[296]!.rpcUrls.default.http).toEqual(['https://testnet.hashio.io/api']);
    expect(CHAINS[296]!.nativeCurrency).toEqual({ name: 'HBAR', symbol: 'HBAR', decimals: 18 });
    expect(CHAINS[421614]!.testnet).toBe(true);
    expect(Object.keys(CHAINS).sort()).toEqual(['296', '421614']);
  });
});
