// The shop's sign-up page (#/join): the form's checks and the registration document it builds, the
// terms and costs from a mocked GET /v1/params, the register panel before and after the wallet signs
// (a fake EIP-1193 provider), and the operator's steps. Names and figures here are test values.
import { erc8004IdentityAbi, type VaultToken } from '@recourse/shared';
import type { ReactNode } from 'react';
import { prerender } from 'react-dom/static';
import { renderToString } from 'react-dom/server';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, type EIP1193Provider, type Hash } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Shell } from '../src/App.js';
import { LocalFlowView, estimatePlan, localProblems, type LocalPhase } from '../src/actions/LocalFlow.js';
import { READS, getRead } from '../src/lib/api.js';
import { REGISTRY, dataUri, docFromUri, readBack, uriSize } from '../src/lib/identity.js';
import { NO_WALLET, type WalletState } from '../src/lib/wallet.js';
import {
  Agreement, Costs, EMPTY_FORM, JoinView, OTHER_TYPE, RecordView, RegisteredView, joinDoc, joinPlan, joinProblems, spanWords, type JoinForm, type JoinParams,
} from '../src/pages/Join.js';

const OWNER = '0x1111111111111111111111111111111111111111';
const mock: VaultToken = { mode: 'mock', address: `0x${'6d'.repeat(20)}`, decimals: 6, symbol: 'mUSDC', label: 'mUSDC (testnet mock)', tokenId: null };
/** GET /v1/params as the status API answers it (the fields this page reads), before the page unwraps it. */
const PARAMS_BODY = {
  params: {
    vaultToken: mock,
    params: { claims: { contestWindow: '600', claimTimeout: '64800', courtFeeUsdc: '1000000', handlingBase: '0', handlingBps: '0', handlingCap: '0', resendGap: '0', maxSends: 1 }, defaulted: false },
  },
  meta: { vaultToken: mock },
};
const filled: JoinForm = { ...EMPTY_FORM, name: 'Harbour Linen', sells: 'Sells shirts and tees in sizes S to XL.' };
const text = (node: ReactNode) => renderToString(<>{node}</>).replaceAll('<!-- -->', '');

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The params as the page reads them, through the API client with fetch mocked. */
async function readParams(): Promise<{ params: JoinParams; vaultToken?: VaultToken }> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(PARAMS_BODY), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  const body = await getRead<{ params: JoinParams; vaultToken?: VaultToken }>(READS.params());
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/params', expect.anything());
  return body;
}

/** A wallet on Hedera testnet that estimates gas and, after the register mined, answers the read-back. */
function wallet(uri: string, opts: { owner?: string; logAddress?: string } = {}): EIP1193Provider {
  const hash = `0x${'ab'.repeat(32)}`;
  const topics = encodeEventTopics({ abi: erc8004IdentityAbi, eventName: 'Registered', args: { agentId: 181n, owner: OWNER } });
  const log = { address: opts.logAddress ?? REGISTRY, topics, data: encodeAbiParameters([{ type: 'string' }], [uri]), blockNumber: '0x1', blockHash: `0x${'cd'.repeat(32)}`, transactionHash: hash, transactionIndex: '0x0', logIndex: '0x0', removed: false };
  const receipt = { transactionHash: hash, blockHash: `0x${'cd'.repeat(32)}`, blockNumber: '0x1', status: '0x1', logs: [log], from: OWNER, to: REGISTRY, gasUsed: '0x1', cumulativeGasUsed: '0x1', effectiveGasPrice: '0x1', contractAddress: null, logsBloom: `0x${'00'.repeat(256)}`, transactionIndex: '0x0', type: '0x2' };
  return {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_chainId') return '0x128';
      if (method === 'eth_gasPrice') return '0x' + (710_000_000_000n).toString(16);
      if (method === 'eth_estimateGas') return '0x' + (200_000n).toString(16);
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

const connected: WalletState = { available: true, account: OWNER, chainId: 296, connecting: false, error: null };

/** The whole page body with the register panel held in one phase, as LocalFlow would show it. */
function page(form: JoinForm, phase: LocalPhase, w: WalletState = connected, params?: JoinParams, token?: VaultToken) {
  return text(
    <JoinView
      params={params}
      token={token}
      form={form}
      set={() => undefined}
      touched={new Set()}
      touch={() => undefined}
      owner={w.account}
      flow={(fields) => (
        <LocalFlowView title="Register your shop" wallet={w} phase={phase} plan={joinPlan(form, () => undefined)}>
          {fields}
        </LocalFlowView>
      )}
    />,
  );
}

describe('the join form', () => {
  it('says what to fix in every field, and nothing once it is filled in', () => {
    const empty = joinProblems(EMPTY_FORM);
    expect(Object.keys(empty).sort()).toEqual(['name', 'sells']);
    expect(empty.name).toContain('Name the shop');
    expect(joinProblems(filled)).toEqual({});
    expect(joinProblems({ ...filled, name: 'H' }).name).toBe('Use at least 2 characters for the name.');
    expect(joinProblems({ ...filled, name: 'x'.repeat(61) }).name).toBe('Shorten the name to 60 characters or fewer (it has 61).');
    expect(joinProblems({ ...filled, sells: 'x'.repeat(161) }).sells).toContain('160 characters or fewer (it has 161)');
  });

  it('takes only an https x402 endpoint, and the endpoint and the account it pays only together', () => {
    const paid = { ...filled, endpoint: 'https://shop.example/x402/', account: '0.0.1234567' };
    expect(joinProblems(paid)).toEqual({});
    expect(joinProblems({ ...paid, endpoint: 'http://shop.example/x402/' }).endpoint).toContain('must start with https://');
    expect(joinProblems({ ...paid, endpoint: 'https://localhost:8731/x402/' }).endpoint).toContain('not a web address');
    expect(joinProblems({ ...paid, endpoint: 'https://a:b@shop.example/' }).endpoint).toContain('user name and password');
    expect(joinProblems({ ...paid, account: '' }).account).toBe('Add the Hedera account the x402 payments go to, or clear the endpoint.');
    expect(joinProblems({ ...paid, endpoint: '' }).endpoint).toContain('add the endpoint, or clear the account');
    expect(joinProblems({ ...paid, account: '0x1234' }).account).toContain('the form 0.0.1234567');
  });

  it('asks for a type name and a kind in lowercase words when the type is not one of the listed ones', () => {
    const other = { ...filled, type: OTHER_TYPE };
    expect(Object.keys(joinProblems(other)).sort()).toEqual(['kind', 'label']);
    expect(joinProblems({ ...other, label: 'Books and prints', kind: 'Books Prints' }).kind).toContain('lowercase letters and digits');
    expect(joinProblems({ ...other, label: 'Books and prints', kind: 'books-prints' })).toEqual({});
  });
});

describe('the registration document', () => {
  it('is a shop registration in the shape the cast page and the agent read, x402 paid in HBAR on Hedera testnet', () => {
    const doc = joinDoc({ ...filled, name: ' Harbour Linen ', endpoint: 'https://shop.example/x402', account: '0.0.1234567' });
    expect(doc.name).toBe('Harbour Linen');
    expect(doc.recourse).toEqual({ role: 'shop', kind: 'apparel-sizes', label: 'Physical goods with sizes', summary: 'Sells shirts and tees in sizes S to XL.' });
    expect(doc.services).toEqual([{ name: 'x402', endpoint: 'https://shop.example/x402/', network: 'hedera:testnet', payTo: '0.0.1234567', asset: '0.0.0' }]);
    expect(joinDoc(filled).services).toEqual([]);
    expect(joinDoc({ ...filled, type: OTHER_TYPE, label: 'Books and prints', kind: 'books-prints' }).recourse?.kind).toBe('books-prints');
    expect(docFromUri(dataUri(doc))).toEqual(doc);
  });

  it('builds the register call only once nothing is left to fix, for the URI the page showed', () => {
    expect(joinPlan(EMPTY_FORM, () => undefined)).toBeNull();
    const sent: string[] = [];
    const plan = joinPlan(filled, (uri) => sent.push(uri));
    expect(plan).not.toBeNull();
    const built = plan!(OWNER);
    const uri = dataUri(joinDoc(filled));
    expect(sent).toEqual([uri]);
    expect(built.transactions).toHaveLength(1);
    expect(built.transactions[0]).toMatchObject({ chainId: 296, to: REGISTRY, value: '0', call: { function: 'register', args: { agentURI: uri } } });
    expect(localProblems(built.transactions)).toEqual([]);
    expect(built.summary).toContain('Harbour Linen');
    expect(built.notes?.join(' ')).toContain('not in the party map until the operator adds it');
    // a document over the cap is never handed to the builder (which would throw), and the record says why
    const tee = '\u{1F455}';
    const big: JoinForm = { ...filled, name: tee.repeat(60), sells: tee.repeat(160), type: OTHER_TYPE, label: tee.repeat(60), kind: 'k'.repeat(40), endpoint: `https://shop.example/${'x'.repeat(170)}`, account: '0.0.1234567' };
    expect(joinProblems(big)).toEqual({});
    expect(uriSize(dataUri(joinDoc(big))).problem).toContain('Shorten the summary or the description');
    expect(joinPlan(big, () => undefined)).toBeNull();
    expect(text(<RecordView doc={joinDoc(big)} />)).toContain('so this page keeps it to 2,048. Shorten the name, the line on what it sells, the type name or the endpoint.');
  });
});

describe('what a shop agrees to and what joining costs', () => {
  it('reads the court fee, the contest window and the claim timeout from GET /v1/params', async () => {
    const body = await readParams();
    expect(spanWords(body.params.claims.contestWindow)).toBe('10 minutes');
    expect(spanWords(body.params.claims.claimTimeout)).toBe('18 hours');
    expect(spanWords(604800)).toBe('7 days');
    const agree = text(<Agreement params={body.params} token={body.vaultToken} />);
    expect(agree).toContain('What you agree to');
    expect(agree).toContain('Packed record');
    expect(agree).toContain('The fault rule decides from the records.');
    expect(agree).toContain('The claim timeout is 18 hours.');
    expect(agree).toContain('holds a court fee of 1.00 mUSDC (testnet mock).');
    expect(agree).toContain('within the contest window (10 minutes)');
    expect(agree).toContain('href="#/claim/0x8f78143ea47bd370edb87e91a720955110aa4978d79474a5d5fbbf0d1eec6f75"');
    expect(agree).toContain('href="#/claim/0x392d6f13cdf5fe1ca93289d143e51b511f333de3d6d1769c72ddd0039c7f3c50"');
    const costs = text(<Costs params={body.params} token={body.vaultToken} />);
    expect(costs).toContain('in HBAR');
    expect(costs).toContain('estimates the fee through your wallet before you sign, and your wallet shows its own figure');
    expect(costs).toContain('The court fee, 1.00 mUSDC (testnet mock), held while the claim is open');
    expect(costs).toContain('there is no joining, listing or monthly fee');
    expect(costs).toContain("HashScan, Hedera's public block explorer".replace("'", '&#x27;'));
    expect(agree).toContain('the court-fee pool, the scheme&#x27;s account that keeps court fees');
  });

  it('shows no figure before the API answers, and marks defaults that were not read from the chain', async () => {
    const unread = text(<Costs />) + text(<Agreement />);
    expect(unread).toContain('not read yet');
    expect(unread).not.toMatch(/\d\.\d\d mUSDC/);
    expect(unread).not.toContain('18 hours');
    const body = await readParams();
    const defaulted = text(<Agreement params={{ ...body.params, defaulted: true }} token={body.vaultToken} />);
    expect(defaulted).toContain('18 hours (default, not read from the chain yet)');
  });
});

describe('the register panel', () => {
  it('shows the document it will put on chain and its size before anything is signed, and claims nothing signed', () => {
    const html = page(filled, { kind: 'form' });
    const uri = dataUri(joinDoc(filled));
    expect(html).toContain('The registration this puts on chain');
    expect(html).toContain(`${uriSize(uri).bytes.toLocaleString('en-US')} bytes`);
    expect(html).toContain('&quot;apparel-sizes&quot;');
    expect(html).toContain('Show what this will do');
    expect(html).toContain('Nothing is signed yet');
    for (const claim of ['Registered:', 'Mined', 'Transaction 0x', 'waiting for your signature', 'ERC-8004 agent id']) expect(html).not.toContain(claim);
    // the listing has no id until the registration is mined
    expect(html).toContain('given when the registration is mined');
  });

  it('lists what is left to fix and keeps the button off while it is', () => {
    const html = page({ ...filled, sells: '' }, { kind: 'form' });
    expect(html).toContain('Before the preview, fix:');
    expect(html).toContain('What it sells');
    expect(html).toMatch(/<button type="button" disabled="">Show what this will do<\/button>/);
  });

  it('with no wallet in the browser says how to sign, and still shows the form and the record', () => {
    const html = page(filled, { kind: 'form' }, NO_WALLET);
    expect(html).toContain('open the page in a browser with a wallet');
    expect(html).toContain('The registration this puts on chain');
    expect(html).not.toContain('Connect wallet');
  });

  it('previews the register call with the fee estimated through the wallet, still unsigned', async () => {
    const uri = dataUri(joinDoc(filled));
    const plan = joinPlan(filled, () => undefined)!(OWNER);
    const built = await estimatePlan(wallet(uri), OWNER, plan, 1_793_990_000);
    expect(built.transactions[0]?.simulated).toBe(true);
    expect(built.preview.fee.symbol).toBe('HBAR');
    const html = page(filled, { kind: 'preview', built, problems: [] });
    expect(html).toContain('Before you sign');
    expect(html).toContain('No money moves.');
    expect(html).toContain('Hedera testnet (chain 296)');
    expect(html).toContain('HBAR');
    expect(html).toContain('Confirm and sign in your wallet');
    for (const claim of ['Registered:', 'Mined', 'Transaction 0x']) expect(html).not.toContain(claim);
  });

  it('after the wallet signed and it mined, reads back the agent id, owner and registration, with HashScan links', async () => {
    const uri = dataUri(joinDoc(filled));
    const hash = `0x${'ab'.repeat(32)}` as Hash;
    const reg = await readBack(wallet(uri), hash);
    const plan = joinPlan(filled, () => undefined)!(OWNER);
    const built = await estimatePlan(wallet(uri), OWNER, plan, 1_793_990_000);
    const after = <RegisteredView hash={hash} reg={reg} sent={uri} />;
    const html = page(filled, { kind: 'done', built, steps: [{ state: 'mined', hash }], after });
    expect(html).toContain('Registered: ERC-8004 agent 181');
    expect(html).toContain(OWNER);
    expect(html).toContain('the same document this page showed before you signed');
    expect(html).toContain(`https://hashscan.io/testnet/transaction/${hash}`);
    expect(html).toContain(`https://hashscan.io/testnet/contract/${REGISTRY}`);
    expect(html).toContain(`https://hashscan.io/testnet/account/${OWNER}`);
    expect(html).toContain('The registration as read from the registry');
    expect(html).toContain('&quot;Harbour Linen&quot;');
    expect(html).toContain('ask the operator to add agent 181 to the party map');
  });

  it('says plainly when the read-back finds no identity, another one, or cannot run', async () => {
    const uri = dataUri(joinDoc(filled));
    const hash = `0x${'ab'.repeat(32)}` as Hash;
    expect(text(<RegisteredView hash={hash} reg={await readBack(wallet(uri, { logAddress: OWNER }), hash)} sent={uri} />)).toContain('no Registered event from the ERC-8004 identity registry');
    const other = text(<RegisteredView hash={hash} reg={await readBack(wallet(uri, { owner: '0x2222222222222222222222222222222222222222' }), hash)} sent={uri} />);
    expect(other).toContain('another owner or registration than the Registered event named');
    expect(text(<RegisteredView hash={hash} reg={await readBack(wallet(uri), hash)} sent={dataUri(joinDoc({ ...filled, name: 'Other' }))} />)).toContain('not the document this page showed');
    expect(text(<RegisteredView hash={hash} reg={null} sent={uri} failed="HTTP request failed" />)).toContain('could not be read back just now (HTTP request failed)');
  });
});

describe('the page as a whole', () => {
  it('has every section, in heading order, and states each operator step in one line', async () => {
    const { prelude } = await prerender(<Shell hash="#/join" />);
    const html = (await new Response(prelude).text()).replaceAll('<!-- -->', '');
    expect(html).toContain('<h1>I run a shop</h1>');
    const h2 = [...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1]);
    expect(h2).toEqual(['What you agree to', 'What joining costs', 'Register your shop', 'What agent companies see', 'Next step']);
    expect(html).toContain('the operator adds the shop to the party map. The <a href="#/cast">cast page</a> lists shops from that map');
    expect(html).toContain('the operator adds your new identity to the party map (deployments/parties.json). Until then the shop service, the agent and the cast page do not know it.');
    expect(html).toContain('only the operator, as the mock&#x27;s owner, can mint it');
    expect(html).toContain('only the operator sets how much each agent company must hold in the vault (setRequired)');
    expect(html).toContain('Nothing is signed yet');
    expect(html).not.toContain('Connect wallet');
    // plain words only: none of the claims the demo never makes
    const body = html.slice(html.indexOf('class="join-page"'), html.indexOf('</main>'));
    expect(body.length).toBeGreaterThan(1000);
    for (const word of [/production/i, /mainnet/i, /audited/i, /\blocked\b/i, /\blive\b/i, /USDC settlement/i, /anyone can re-run/i, /AI court/i]) expect(body).not.toMatch(word);
  });
});
