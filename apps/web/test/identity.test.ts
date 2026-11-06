// The ERC-8004 registration the Join and Bond pages build in the browser: the document, its data:
// URI, the unsigned register call and the read-back, against a fake EIP-1193 provider.
import { erc8004IdentityAbi } from '@recourse/shared';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, type EIP1193Provider, type Hash } from 'viem';
import { describe, expect, it } from 'vitest';
import { MAX_URI_BYTES, REGISTRATION_TYPE, REGISTRY, REGISTRY_LABEL, buildRegister, dataUri, docFromUri, readBack, registrationDoc, uriSize } from '../src/lib/identity.js';
import { callProblem } from '../src/lib/calls.js';

const OWNER = '0x1111111111111111111111111111111111111111';
const shop = registrationDoc({ role: 'shop', name: ' Harbour Linen ', kind: 'apparel', label: 'Clothing shop', summary: 'Sells shirts and tees in sizes S to XL.' });

describe('registration document', () => {
  it('has the shape the cast page and the agent read', () => {
    expect(shop).toEqual({
      type: REGISTRATION_TYPE,
      name: 'Harbour Linen',
      description: 'Shop that sells over x402 on Hedera and records each order on the Recourse HCS topic.',
      services: [],
      x402Support: true,
      active: true,
      recourse: { role: 'shop', kind: 'apparel', label: 'Clothing shop', summary: 'Sells shirts and tees in sizes S to XL.' },
    });
    const agent = registrationDoc({ role: 'platform', name: 'Pell Errands', kind: 'errands', label: 'Errand agent', summary: 'Buys small household items.', description: 'Our own words.' });
    expect(agent.description).toBe('Our own words.');
    expect(agent.recourse?.role).toBe('platform');
    const paid = registrationDoc({ role: 'shop', name: 'S', kind: 'k', label: 'l', summary: 's', x402: { baseUrl: 'https://shop.example/x402', network: 'hedera-testnet', payTo: OWNER, asset: '0.0.1' } });
    expect(paid.services).toEqual([{ name: 'x402', endpoint: 'https://shop.example/x402/', network: 'hedera-testnet', payTo: OWNER, asset: '0.0.1' }]);
  });

  it('round-trips through an inline data: URI, UTF-8 included, and says its size', () => {
    const doc = registrationDoc({ role: 'platform', name: 'Café Ölund', kind: 'k', label: 'l', summary: 'Kauft für dich ein.' });
    const uri = dataUri(doc);
    expect(uri.startsWith('data:application/json;base64,')).toBe(true);
    expect(docFromUri(uri)).toEqual(doc);
    expect(docFromUri('https://example.com/a.json')).toBeNull();
    expect(docFromUri('data:application/json;base64,!!')).toBeNull();
    expect(uriSize(uri)).toEqual({ bytes: uri.length, problem: null });
    const big = dataUri({ ...doc, description: 'x'.repeat(MAX_URI_BYTES) });
    expect(uriSize(big).problem).toContain(`${uriSize(big).bytes.toLocaleString('en-US')} bytes`);
    expect(() => buildRegister(big)).toThrow(RangeError);
  });
});

describe('register call', () => {
  it('is an unsigned register(agentURI) to the registry on Hedera testnet, its data the call it shows', () => {
    const uri = dataUri(shop);
    const tx = buildRegister(uri);
    expect(tx).toMatchObject({ chainId: 296, to: REGISTRY, value: '0', gas: '0', simulated: false, call: { contract: REGISTRY_LABEL, function: 'register', args: { agentURI: uri } } });
    expect(REGISTRY).toBe('0x8004A818BFB912233c491871b3d84c89A494BD9e');
    const d = decodeFunctionData({ abi: erc8004IdentityAbi, data: tx.data });
    expect(d.functionName).toBe('register');
    expect(d.args).toEqual([uri]);
    expect(callProblem(tx.data, tx.call, erc8004IdentityAbi)).toBeNull();
    expect(callProblem(tx.data, { ...tx.call, args: { agentURI: 'data:other' } }, erc8004IdentityAbi)).toContain('different arguments');
  });
});

describe('read-back', () => {
  const hash = `0x${'ab'.repeat(32)}` as Hash;
  const uri = dataUri(shop);
  function provider(opts: { owner?: string; logAddress?: string } = {}): EIP1193Provider {
    const topics = encodeEventTopics({ abi: erc8004IdentityAbi, eventName: 'Registered', args: { agentId: 181n, owner: OWNER } });
    const log = { address: opts.logAddress ?? REGISTRY, topics, data: encodeAbiParameters([{ type: 'string' }], [uri]), blockNumber: '0x1', blockHash: `0x${'cd'.repeat(32)}`, transactionHash: hash, transactionIndex: '0x0', logIndex: '0x0', removed: false };
    const receipt = { transactionHash: hash, blockHash: `0x${'cd'.repeat(32)}`, blockNumber: '0x1', status: '0x1', logs: [log], from: OWNER, to: REGISTRY, gasUsed: '0x1', cumulativeGasUsed: '0x1', effectiveGasPrice: '0x1', contractAddress: null, logsBloom: `0x${'00'.repeat(256)}`, transactionIndex: '0x0', type: '0x2' };
    return {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === 'eth_chainId') return '0x128';
        if (method === 'eth_getTransactionReceipt') return receipt;
        if (method === 'eth_call') {
          const { data } = (params as [{ data: `0x${string}` }])[0];
          const fn = decodeFunctionData({ abi: erc8004IdentityAbi, data });
          if (fn.functionName === 'ownerOf') return encodeFunctionResult({ abi: erc8004IdentityAbi, functionName: 'ownerOf', result: (opts.owner ?? OWNER) as `0x${string}` });
          if (fn.functionName === 'tokenURI') return encodeFunctionResult({ abi: erc8004IdentityAbi, functionName: 'tokenURI', result: uri });
        }
        throw new Error(`unexpected ${method}`);
      },
      on: () => undefined,
      removeListener: () => undefined,
    } as unknown as EIP1193Provider;
  }

  it('takes the agent id from the Registered event, then the owner and URI from the registry', async () => {
    expect(await readBack(provider(), hash)).toEqual({ agentId: '181', owner: OWNER, agentURI: uri, matches: true });
    expect((await readBack(provider({ owner: '0x2222222222222222222222222222222222222222' }), hash))?.matches).toBe(false);
  });

  it('is null when the receipt has no Registered event from the registry', async () => {
    expect(await readBack(provider({ logAddress: '0x3333333333333333333333333333333333333333' }), hash)).toBeNull();
  });
});
