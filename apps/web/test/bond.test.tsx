// I run a shopping agent (#/bond): the deposit calculator against the contract parameters, the
// bonded mark in each state, the operator's steps, and the registration and deposit the page builds
// for the person's wallet. The API is stood in for by props shaped like GET /v1/params, /v1/cast and
// /v1/parties; the wallet by a fake EIP-1193 provider. Nothing here signs or sends.
import { readFileSync } from 'node:fs';
import type { VaultToken } from '@recourse/shared';
import { renderToString } from 'react-dom/server';
import { prerender } from 'react-dom/static';
import { decodeFunctionData, encodeFunctionResult, erc20Abi, type Abi, type AbiFunction, type EIP1193Provider, type Hash, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { Shell } from '../src/App.js';
import { LocalFlowView, estimatePlan, localProblems } from '../src/actions/LocalFlow.js';
import { ApiFailure } from '../src/lib/api.js';
import { POST_DEPOSIT_BUDGET, depositProblems } from '../src/lib/deposit.js';
import { REGISTRY, docFromUri } from '../src/lib/identity.js';
import { NO_WALLET, type WalletState } from '../src/lib/wallet.js';
import {
  BondView, DepositedView, EXAMPLE_NUMBERS, NumbersCard, OPERATOR_STEPS, RegisteredView, SeenCard, VAULT_READS,
  afterRegister, depositPlan, duration, estimate, handlingFor, percentBps, registerPlan, vaultNow,
  type BondParams,
} from '../src/pages/Bond.js';
import type { CastBody, CastMember } from '../src/pages/Cast.js';
import type { Standing } from '../src/pages/Party.js';

const MUSDC_ADDR = '0x6D6fb82e82E525B9c30619189EA8aF17117C3c73';
const VAULT = '0xA22fB188b49eddecc4f9DE22607e70E1d07Aea2e';
const FROM = '0x5555555555555555555555555555555555555555';
const OTHER = '0x4444444444444444444444444444444444444444';
const mock: VaultToken = { mode: 'mock', address: MUSDC_ADDR, decimals: 6, symbol: 'mUSDC', label: 'mUSDC (testnet mock)', tokenId: null };

/** Fallback figures in the shape GET /v1/params returns (the values the testnet contracts held on 6 Nov). */
const PARAMS: BondParams = {
  addresses: { vault: VAULT, usdc: MUSDC_ADDR },
  vaultToken: mock,
  params: {
    claims: { contestWindow: '600', courtFeeUsdc: '1000000', handlingBase: '1000000', handlingBps: '500', handlingCap: '4000000' },
    vault: { topUpWindow: '604800', exitDelay: '600', minDeposit: '5000000' },
    defaulted: false,
  },
};

function company(name: string, n: number): CastMember {
  const address = '0x' + n.toString(16).padStart(2, '0').repeat(20);
  return {
    agentId: String(170 + n), role: 'platform', displayName: name, address, owner: address, ownerIsParty: true, agentURI: 'data:application/json;base64,e30=',
    registration: null, readAt: 1_794_000_000, current: true, explorer: null, ownerExplorer: null, orders: 0, claims: [],
  };
}
const CAST: CastBody = {
  registry: { chainId: 296, address: REGISTRY, accountId: '0.0.7919997', explorer: null },
  vaultToken: mock,
  members: [company('Example Errands (sample)', 1), { ...company('Example Shop (sample)', 2), role: 'shop' }, company('Example Buying Desk (sample)', 3)],
};

function standing(over: Partial<Standing>): Standing {
  return { role: 'platform', displayName: 'Example Errands (sample)', balance: '10000000', required: '10000000', inGoodStanding: true, topUpDeadline: '0', credit: '0', escrowOpen: '0', openClaims: 0, exitRequestedAt: null, ...over };
}

/** Server-rendered HTML without React's `<!-- -->` text separators, so copy can be matched whole. */
const render = (node: Parameters<typeof renderToString>[0]) => renderToString(node).replaceAll('<!-- -->', '');
/** Text as React writes it into HTML (apostrophes escaped). */
const html = (s: string) => s.replaceAll("'", '&#x27;');

async function full(hash: string): Promise<string> {
  const { prelude } = await prerender(<Shell hash={hash} />);
  return (await new Response(prelude).text()).replaceAll('<!-- -->', '');
}

/** A wallet on Hedera testnet holding `held` mUSDC, answering the reads and estimates the page makes. */
function wallet(held: bigint, vault: Partial<Record<string, bigint | boolean>> = {}): EIP1193Provider {
  return {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_chainId') return '0x128';
      if (method === 'eth_gasPrice') return '0x' + (500_000_000_000n).toString(16);
      if (method === 'eth_estimateGas') {
        const { to } = (params as [{ to: string }])[0];
        // postDeposit cannot be run before its approve has mined
        if (to.toLowerCase() === VAULT.toLowerCase()) throw Object.assign(new Error('execution reverted'), { code: 3 });
        return '0x' + (100_000n).toString(16);
      }
      if (method === 'eth_call') {
        const { to, data } = (params as [{ to: string; data: Hex }])[0];
        if (to.toLowerCase() === MUSDC_ADDR.toLowerCase()) return encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: held });
        const fn = decodeFunctionData({ abi: VAULT_READS, data });
        return encodeFunctionResult({ abi: VAULT_READS, functionName: fn.functionName, result: vault[fn.functionName] ?? 0n } as never);
      }
      throw new Error(`unexpected ${method}`);
    },
    on: () => undefined,
    removeListener: () => undefined,
  } as unknown as EIP1193Provider;
}

describe('the bond page', () => {
  it('opens with its sections and the operator steps, and claims nothing was signed', async () => {
    const page = await full('#/bond');
    expect(page).toContain('<h1>I run a shopping agent</h1>');
    for (const h of ['Your numbers', 'What you agree to', 'What a shop sees', 'Steps only the operator can take', 'Register your agent company', 'Your deposit']) expect(page).toContain(`>${h}</h2>`);
    for (const line of Object.values(OPERATOR_STEPS)) expect(page).toContain(html(line));
    expect(page).toContain('Nothing is signed yet');
    for (const claim of ['Mined', 'Registered:', 'Posted.', 'Confirm and sign']) expect(page).not.toContain(claim);
  });

  it('reads every figure from the parameters, and labels the suggestion as an estimate', () => {
    const page = render(<BondView p={PARAMS} pError={null} cast={CAST} castError={null} />);
    // 200 orders × 2% × (1.50 + 1.075 handling) = 10.30 a month; × 3 months = 30.90, rounded up to 31.00
    expect(page).toContain('4 (200 orders × 2%)');
    expect(page).toContain("2.575 mUSDC (1.50 for the order, the most its loss can be, plus 1.075 handling by the contract&#x27;s rule)");
    expect(page).toContain('10.30 mUSDC');
    expect(page).toContain('30.90 mUSDC');
    expect(page).toMatch(/Suggested deposit<small>An estimate, not the required amount<\/small><\/span><b>31\.00<small> mUSDC<\/small>/);
    expect(page).toContain('Months of payouts the deposit covers (an assumption of this page, not a rule)');
    expect(page).toContain('the operator cannot set a required deposit below 5.00 mUSDC');
    expect(page).toContain('Top-up window: 7 days');
    expect(page).toContain('1.00 plus 5% of the order, at most 4.00');
    expect(page).toContain('within 10 minutes of the pre-check');
    expect(page).toContain('court fee of 1.00 mUSDC');
    // the two claims the demo ran to the end are linked, not retold in figures
    expect(page).toContain('href="#/claim/0x8f78143ea47bd370edb87e91a720955110aa4978d79474a5d5fbbf0d1eec6f75"');
    expect(page).toContain('href="#/claim/0x392d6f13cdf5fe1ca93289d143e51b511f333de3d6d1769c72ddd0039c7f3c50"');
    // only the agent companies of the party map, each reading its own deposit
    expect(page).toContain('Example Errands (sample)');
    expect(page).toContain('Example Buying Desk (sample)');
    expect(page).not.toContain('Example Shop (sample)');
    expect(page).toContain('Loading its deposit');
    expect(page).toContain('Use the floor, 5.00 mUSDC');
    expect(page).toContain('Use your estimate, 31.00 mUSDC');
    for (const word of ['production', 'mainnet', 'audited', 'locked', 'USDC settlement', 'anyone can re-run', 'AI court']) expect(page.toLowerCase()).not.toContain(word.toLowerCase());
  });

  it('says what it is waiting for while the parameters are not read', () => {
    const page = render(<BondView p={null} pError={null} cast={null} castError={null} />);
    expect(page).toContain('Reading the claims contract&#x27;s handling rule');
    expect(page).toContain('The vault&#x27;s floor for a required deposit is not read yet.');
    expect(page).toContain('Top-up window: not read yet.');
    expect(page).toContain('Loading the agent companies');
    expect(page).toContain('no figure yet');
    expect(render(<BondView p={null} pError={new ApiFailure(0, 'unreachable')} cast={null} castError={null} />)).toContain('could not be read just now; type a handling figure');
  });
});

describe('your numbers', () => {
  it('takes the handling from the contract rule, capped, and accepts a typed figure instead', () => {
    const c = PARAMS.params.claims;
    expect(handlingFor(1_500_000n, c)).toBe(1_075_000n);
    expect(handlingFor(20_000_000n, c)).toBe(2_000_000n);
    expect(handlingFor(100_000_000n, c)).toBe(4_000_000n);
    const typed = estimate({ ...EXAMPLE_NUMBERS, handling: '0.5' }, PARAMS.params).est!;
    expect([typed.handling, typed.handlingFromRule, typed.each]).toEqual([500_000n, false, 2_000_000n]);
  });

  it('raises a small figure to the vault floor and says so', () => {
    const r = estimate({ ...EXAMPLE_NUMBERS, orders: '10' }, PARAMS.params).est!;
    // 10 × 2% × 2.575 = 0.515 a month; × 3 = 1.545, rounded up to 2.00, under the 5.00 floor
    expect([r.month, r.cover, r.suggested, r.floorApplies]).toEqual([515_000n, 1_545_000n, 5_000_000n, true]);
    const page = render(<NumbersCard input={{ ...EXAMPLE_NUMBERS, orders: '10' }} onChange={() => undefined} p={PARAMS} token={mock} />);
    expect(page).toContain('These numbers come to less (2.00 mUSDC), so the floor is shown.');
    expect(estimate(EXAMPLE_NUMBERS, PARAMS.params).est?.floorApplies).toBe(false);
  });

  it('names each number it cannot read, and holds no figure until they are fixed', () => {
    const bad = estimate({ orders: '0', order: 'abc', share: '120', handling: 'x', months: 3 }, PARAMS.params);
    expect(bad.est).toBeNull();
    expect(Object.keys(bad.problems).sort()).toEqual(['handling', 'order', 'orders', 'share']);
    expect(percentBps('2.5')).toBe(250);
    expect(percentBps('100')).toBe(10_000);
    expect(percentBps('100.01')).toBeNull();
    const page = render(<NumbersCard input={{ ...EXAMPLE_NUMBERS, share: 'lots' }} onChange={() => undefined} p={PARAMS} token={mock} />);
    expect(page).toContain('aria-invalid="true"');
    expect(page).toContain('aria-describedby="bn-share-h bn-share-e"');
    expect(page).toContain('Enter a percent from 0 to 100');
    expect(page).toContain('Fix the numbers marked in the form');
    // without the parameters, an empty handling waits for them rather than guessing
    expect(estimate(EXAMPLE_NUMBERS, null)).toMatchObject({ est: null, waiting: true });
  });

  it('writes parameter times in words', () => {
    expect([duration('600'), duration('604800'), duration('64800'), duration(7200), duration(90)]).toEqual(['10 minutes', '7 days', '18 hours', '2 hours', '90 seconds']);
  });
});

describe('what a shop sees', () => {
  const m = { address: '0x0101010101010101010101010101010101010101', displayName: 'Example Errands (sample)' };
  const seen = (read: Standing | null, failed = false) => render(<SeenCard m={m} read={read} failed={failed} token={mock} />);

  it('shows a bonded company with the vault figures', () => {
    const page = seen(standing({}));
    expect(page).toContain('pill-ok">Bonded</span>');
    expect(page).toContain('Bonded: it holds 10.00 mUSDC (testnet mock) of 10.00 mUSDC (testnet mock) required.');
    expect(page).toContain('<dt>Shops accept its orders</dt><dd>yes</dd>');
    expect(page).toContain('aria-label="Bonded mark for Example Errands (sample): 10.00 mUSDC deposit"');
    expect(page).toContain('href="#/party/0x0101010101010101010101010101010101010101"');
  });

  it('shows a company inside its top-up window with the date it must top up by', () => {
    const page = seen(standing({ balance: '6900000', topUpDeadline: '1794605806' }));
    expect(page).toContain('Needs a top-up by 2026-11-13</span>');
    expect(page).toContain('<dt>Top-up by</dt><dd>2026-11-13 21:36 UTC</dd>');
    expect(page).toContain('<dt>Shops accept its orders</dt><dd>yes</dd>');
    expect(page).toContain('Top-up due mark for Example Errands (sample)');
  });

  it('shows a company with no required deposit, or past its top-up time, as not bonded', () => {
    const unset = seen(standing({ required: '0', inGoodStanding: false, balance: '5000000' }));
    expect(unset).toContain('pill-bad">Not bonded</span>');
    expect(unset).toContain('only the vault&#x27;s owner, the operator, can set one');
    expect(unset).toContain('<dt>Shops accept its orders</dt><dd>no</dd>');
    expect(seen(standing({ balance: '1000000', inGoodStanding: false, topUpDeadline: '1700000000' }))).toContain('its top-up time ran out');
  });

  it('says when the deposit is not read, still loading, or not returned', () => {
    expect(seen(standing({ balance: null, required: null, inGoodStanding: null }))).toContain('Its deposit could not be read from the vault just now.');
    expect(seen(null)).toContain('Loading its deposit');
    expect(seen(null, true)).toContain('The status service did not return its deposit just now.');
  });
});

describe('register', () => {
  it('waits for a name and a summary, then builds one register call the panel accepts', () => {
    expect(registerPlan({ name: '', kind: 'personal-shopper', summary: 's' })).toMatchObject({ plan: null, missing: 'Name the agent company to continue.' });
    const r = registerPlan({ name: ' Example Errands (sample) ', kind: 'procurement-approval', summary: 'Buys office supplies after the buyer approves.' });
    expect(r.problem).toBeNull();
    const plan = r.plan!(FROM);
    expect(plan.transactions).toHaveLength(1);
    const tx = plan.transactions[0]!;
    expect(tx).toMatchObject({ chainId: 296, to: REGISTRY, value: '0', simulated: false, call: { function: 'register' } });
    expect(localProblems(plan.transactions)).toEqual([]);
    expect(docFromUri(String(tx.call.args.agentURI))?.recourse).toEqual({ role: 'platform', kind: 'procurement-approval', label: 'Procurement agent with buyer approval', summary: 'Buys office supplies after the buyer approves.' });
    expect(plan.notes).toEqual([OPERATOR_STEPS.partyMap]);
    expect(plan.summary).toContain('Register Example Errands (sample) as an agent company');
  });

  it('refuses a registration over the size the page stores on chain', () => {
    const r = registerPlan({ name: 'Example', kind: 'personal-shopper', summary: 'x'.repeat(2000) });
    expect(r.plan).toBeNull();
    expect(r.problem).toContain('bytes');
  });

  it('reads the new id back, or says it could not, with the party-map step either way', async () => {
    const r = { agentId: '181', owner: FROM, agentURI: 'data:application/json;base64,e30=', matches: true } as const;
    const ok = render(<RegisteredView r={r} hash={null} />);
    expect(ok).toContain('Registered: ERC-8004 id 181.');
    expect(ok).toContain(html(OPERATOR_STEPS.partyMap));
    const failing = { request: async () => Promise.reject(new Error('down')), on: () => undefined, removeListener: () => undefined } as unknown as EIP1193Provider;
    const hash = `0x${'ab'.repeat(32)}` as Hash;
    const after = render(<>{await afterRegister([hash], failing)}</>);
    expect(after).toContain('could not be read back');
    expect(after).toContain(`https://hashscan.io/testnet/transaction/${hash}`);
  });
});

describe('your deposit', () => {
  const args = { vault: VAULT, token: MUSDC_ADDR, amount: 5_000_000n, platform: null, vaultToken: mock } as const;

  it('builds approve then postDeposit for the signer, which both checks pass', async () => {
    const plan = await depositPlan(args, wallet(12_000_000n))(FROM);
    expect(plan.transactions.map((t) => `${t.call.contract}.${t.call.function}`)).toEqual(['VaultToken.approve', 'DepositVault.postDeposit']);
    expect(plan.transactions[0]).toMatchObject({ to: MUSDC_ADDR, call: { args: { spender: VAULT, amount: '5000000' } } });
    expect(plan.transactions[1]).toMatchObject({ to: VAULT, gas: POST_DEPOSIT_BUDGET, call: { args: { platform: FROM, amount: '5000000' } } });
    expect(localProblems(plan.transactions)).toEqual([]);
    expect(depositProblems(plan.transactions)).toEqual([]);
    expect(plan.amounts).toEqual([{ name: 'Deposit', amount: '5000000', decimals: 6, symbol: 'mUSDC', display: '', movement: 'deposit', account: FROM }]);
    expect(plan.notes).toEqual([OPERATOR_STEPS.required]);
    expect(plan.summary).toBe('Post 5.00 mUSDC (testnet mock) from your wallet into the deposit vault, as the deposit of your account.');
  });

  it("says a deposit for another company becomes that company's", async () => {
    const plan = await depositPlan({ ...args, platform: OTHER, names: { [OTHER]: 'Example Buying Desk (sample)' } }, wallet(12_000_000n))(FROM);
    expect(plan.transactions[1]?.call.args.platform).toBe(OTHER);
    expect(plan.changes?.join(' ')).toContain("The deposit is Example Buying Desk (sample)'s from then on: only that company can take it out, by exiting.");
  });

  it('stops before building when the wallet holds less than the deposit, and names the operator', async () => {
    await expect(depositPlan(args, wallet(1_000_000n))(FROM)).rejects.toThrow(`Your wallet holds 1.00 mUSDC (testnet mock), less than the 5.00 mUSDC (testnet mock) deposit, so the vault could not take it. ${OPERATOR_STEPS.mint}`);
  });

  it('previews the pair as checked by this page before anything is signed', async () => {
    const provider = wallet(12_000_000n);
    const plan = await depositPlan(args, provider)(FROM);
    const built = await estimatePlan(provider, FROM, plan, 1_794_000_000);
    const w: WalletState = { ...NO_WALLET, available: true, account: FROM, chainId: 296 };
    const view = (phase: Parameters<typeof LocalFlowView>[0]['phase']) =>
      render(<LocalFlowView title="Your deposit" wallet={w} phase={phase} plan={() => plan} problems={depositProblems} />);
    const form = view({ kind: 'form' });
    expect(form).toContain('Nothing is signed yet');
    expect(form).toContain('Show what this will do');
    const preview = view({ kind: 'preview', built, problems: [...localProblems(built.transactions), ...depositProblems(built.transactions)] });
    expect(preview).toContain('Before you sign');
    expect(preview).toContain('Leaves your wallet into your deposit in the vault');
    expect(preview).toContain('checked by this page but not simulated');
    expect(preview).toContain('Confirm and sign 2 transactions');
    expect(preview).not.toContain('will not ask your wallet to sign');
    for (const claim of ['Mined', 'Posted.', 'Registered:']) {
      expect(form).not.toContain(claim);
      expect(preview).not.toContain(claim);
    }
  });

  it('reads the vault straight after it mined, with fragments that match the vault ABI', async () => {
    const abi = JSON.parse(readFileSync(new URL('../../../deployments/abi/DepositVault.json', import.meta.url), 'utf8')) as Abi;
    for (const f of VAULT_READS as readonly AbiFunction[]) {
      const g = abi.find((x): x is AbiFunction => x.type === 'function' && x.name === f.name);
      expect(g, f.name).toBeDefined();
      expect([g!.inputs.map((i) => i.type), g!.outputs.map((o) => o.type), g!.stateMutability], f.name).toEqual([f.inputs.map((i) => i.type), f.outputs.map((o) => o.type), 'view']);
    }
    const read = await vaultNow(wallet(0n, { depositOf: 5_000_000n, requiredOf: 0n, inGoodStanding: false, topUpDeadline: 0n, exitRequestedAt: 0n }), VAULT, FROM);
    expect(read).toEqual({ balance: '5000000', required: '0', inGoodStanding: false, topUpDeadline: '0', exitRequestedAt: null });
    const after = render(<DepositedView read={read} who="your account" token={mock} />);
    expect(after).toContain('<strong>Posted.</strong> As the vault reads it now, for your account: Not bonded: no required deposit is set for it yet');
    expect(after).toContain(html(OPERATOR_STEPS.required));
  });
});
