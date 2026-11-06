// ViemActionReads against a JSON-RPC relay in memory that answers as Hedera's relay does: a call to a
// function the contract does not have is `{ code: 3, message: "execution reverted: ...", data: "0x" }`.
import { createServer, type Server } from 'node:http';
import { encodeFunctionResult, getAddress, toFunctionSelector, type AbiFunction, type Hex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAIMS_ABI, VAULT_ABI } from '../src/abi/deployed.js';
import { ChainRevert, ChainUnavailable, ViemActionReads } from '../src/chain.js';

const CLAIMS = getAddress('0x' + 'c1'.repeat(20));
const VAULT = getAddress('0x' + 'c2'.repeat(20));
const ID = ('0x' + '39'.repeat(32)) as Hex;

const selectorOf = (abi: readonly unknown[], name: string) => toFunctionSelector((abi as AbiFunction[]).find((f) => f.type === 'function' && f.name === name)!);
const TERMS = selectorOf(CLAIMS_ABI, 'claimTermsOf');
const RESERVED = selectorOf(VAULT_ABI, 'reservedOf');

/** How the relay answers: the contracts from before terms and reservations, the current ones, or not at all. */
type Mode = 'old' | 'new' | 'down';

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function relay(): Promise<{ url: string; set: (m: Mode) => void; calls: string[] }> {
  let mode: Mode = 'old';
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const msg = JSON.parse(raw) as { id: number; method: string; params: [{ data?: Hex; input?: Hex }] };
      const data = (msg.params[0]?.data ?? msg.params[0]?.input ?? '0x') as Hex;
      const sel = data.slice(0, 10);
      calls.push(sel);
      if (mode === 'down') {
        res.writeHead(400).end('relay unavailable');
        return;
      }
      const reply = (body: object) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body }));
      if (mode === 'old') {
        reply({ error: { code: 3, message: '[Request ID: sample] execution reverted: CONTRACT_REVERT_EXECUTED', data: '0x' } });
        return;
      }
      if (sel === TERMS) reply({ result: encodeFunctionResult({ abi: CLAIMS_ABI, functionName: 'claimTermsOf', result: { contestWindow: 1800n, claimTimeout: 64_800n, handling: 2_250_000n } } as never) });
      else if (sel === RESERVED) reply({ result: encodeFunctionResult({ abi: VAULT_ABI, functionName: 'reservedOf', result: 0n } as never) });
      else reply({ error: { code: -32601, message: 'not in this relay' } });
    });
  });
  servers.push(server);
  const url = await new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
  return { url, set: (m) => (mode = m), calls };
}

const readsOn = (url: string) =>
  new ViemActionReads({ hederaRpcUrls: [url], arbRpcUrl: '', timeoutMs: 2_000, claims: CLAIMS, vault: VAULT, caseAddress: null, klerosCore: getAddress('0x' + 'c3'.repeat(20)) });

describe('ViemActionReads on contracts from before per-claim terms and reservations', () => {
  it('a reverted claimTermsOf is a ChainRevert, and is not asked again', async () => {
    const r = await relay();
    const reads = readsOn(r.url);
    await expect(reads.claimTerms(ID)).rejects.toBeInstanceOf(ChainRevert);
    await expect(reads.claimTerms(ID)).rejects.toBeInstanceOf(ChainRevert);
    expect(r.calls.filter((s) => s === TERMS)).toHaveLength(1);
  });

  it('a vault without reservedOf does not reserve; the answer is kept', async () => {
    const r = await relay();
    const reads = readsOn(r.url);
    expect(await reads.vaultReserves()).toBe(false);
    expect(await reads.vaultReserves()).toBe(false);
    expect(r.calls.filter((s) => s === RESERVED)).toHaveLength(1);
  });

  it('a relay that does not answer is ChainUnavailable and decides nothing; the current contracts then read as they are', async () => {
    const r = await relay();
    r.set('down');
    const reads = readsOn(r.url);
    await expect(reads.claimTerms(ID)).rejects.toBeInstanceOf(ChainUnavailable);
    await expect(reads.vaultReserves()).rejects.toBeInstanceOf(ChainUnavailable);
    r.set('new');
    expect(await reads.claimTerms(ID)).toEqual({ contestWindow: 1800n, claimTimeout: 64_800n, handling: 2_250_000n });
    expect(await reads.vaultReserves()).toBe(true);
    expect(await reads.vaultReserves()).toBe(true);
    expect(r.calls.filter((s) => s === RESERVED)).toHaveLength(2);
  });
});
