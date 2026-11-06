// An agent company's deposit built in the browser (approve, then postDeposit), the bonded mark from
// the party read, and the local signing panel's checks and gas estimate against a fake provider.
import { decodeFunctionData, erc20Abi, type EIP1193Provider } from 'viem';
import { describe, expect, it } from 'vitest';
import { estimatePlan, localProblems } from '../src/actions/LocalFlow.js';
import { CALL_ABIS } from '../src/lib/calls.js';
import { POST_DEPOSIT_BUDGET, bondedMark, buildApprove, buildPostDeposit, depositProblems, type PartyDeposit } from '../src/lib/deposit.js';
import { buildRegister, dataUri, registrationDoc } from '../src/lib/identity.js';

const MUSDC_ADDR = '0x6D6fb82e82E525B9c30619189EA8aF17117C3c73';
const VAULT = '0xA22fB188b49eddecc4f9DE22607e70E1d07Aea2e';
const PLATFORM = '0x4444444444444444444444444444444444444444';
const FROM = '0x5555555555555555555555555555555555555555';
const MOCK = { label: 'mUSDC (testnet mock)' } as const;

describe('deposit calls', () => {
  it('approve lets the vault take the amount, on the token, and decodes back to it', () => {
    const tx = buildApprove(MUSDC_ADDR, VAULT, 5_000_000n);
    expect(tx).toMatchObject({ chainId: 296, to: MUSDC_ADDR, value: '0', simulated: false, call: { contract: 'VaultToken', function: 'approve', args: { spender: VAULT, amount: '5000000' } } });
    const d = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(d.functionName).toBe('approve');
    expect(d.args).toEqual([VAULT, 5_000_000n]);
  });

  it('postDeposit names the platform and amount, carries its gas budget, and decodes back to it', () => {
    const tx = buildPostDeposit(VAULT, PLATFORM, 5_000_000n);
    expect(tx).toMatchObject({ chainId: 296, to: VAULT, value: '0', gas: POST_DEPOSIT_BUDGET, simulated: false, call: { contract: 'DepositVault', function: 'postDeposit', args: { platform: PLATFORM, amount: '5000000' } } });
    const d = decodeFunctionData({ abi: CALL_ABIS.DepositVault, data: tx.data });
    expect(d.functionName).toBe('postDeposit');
    expect(d.args).toEqual([PLATFORM, 5_000_000n]);
  });

  it('refuses an approve for another spender or amount than the deposit', () => {
    const post = buildPostDeposit(VAULT, PLATFORM, 5_000_000n);
    expect(depositProblems([buildApprove(MUSDC_ADDR, VAULT, 5_000_000n), post])).toEqual([]);
    expect(depositProblems([buildApprove(MUSDC_ADDR, VAULT, 6_000_000n), post])).toEqual(['The approve is for a different amount from the deposit.']);
    expect(depositProblems([buildApprove(MUSDC_ADDR, PLATFORM, 5_000_000n), post])).toEqual(['The approve is for another contract than the deposit vault.']);
  });
});

describe('bonded mark', () => {
  const base: PartyDeposit = { balance: '10000000', required: '5000000', inGoodStanding: true, topUpDeadline: '0', exitRequestedAt: null };
  it('is bonded when the vault holds the required deposit', () => {
    expect(bondedMark(base, MOCK)).toEqual({ state: 'bonded', words: 'Bonded: it holds 10.00 mUSDC (testnet mock) of 5.00 mUSDC (testnet mock) required.' });
    // the raw { party, meta } read gives the same
    expect(bondedMark({ party: base }, MOCK).state).toBe('bonded');
  });
  it('is top-up while below the required deposit with the top-up clock running', () => {
    const m = bondedMark({ ...base, balance: '2000000', topUpDeadline: '1700000000' }, MOCK);
    expect(m.state).toBe('top-up');
    expect(m.words).toContain('until 2023-11-14 22:13 UTC');
  });
  it('is not bonded past the clock, with no required deposit set, or once it asked to leave', () => {
    expect(bondedMark({ ...base, balance: '2000000', inGoodStanding: false, topUpDeadline: '1700000000' }).words).toContain('top-up time ran out');
    const unset = bondedMark({ ...base, required: '0', inGoodStanding: false });
    expect(unset.state).toBe('not-bonded');
    expect(unset.words).toContain('operator');
    expect(bondedMark({ ...base, exitRequestedAt: '1700000000' }).state).toBe('not-bonded');
    expect(bondedMark({ ...base, balance: '0', inGoodStanding: false }).words).toBe('Not bonded: it holds 0.00 USDC of 5.00 USDC required.');
  });
  it('is unknown when the vault fields were not read (an address not in the party map)', () => {
    const m = bondedMark({ ...base, balance: null, required: null, inGoodStanding: null });
    expect(m.state).toBe('unknown');
    expect(m.words).toContain('party map');
    expect(bondedMark(null).state).toBe('unknown');
  });
});

describe('local signing panel', () => {
  const approve = buildApprove(MUSDC_ADDR, VAULT, 5_000_000n);
  const post = buildPostDeposit(VAULT, PLATFORM, 5_000_000n);

  it('passes the calls this page builds and refuses anything else', () => {
    expect(localProblems([approve, post, buildRegister(dataUri(registrationDoc({ role: 'shop', name: 'S', kind: 'k', label: 'l', summary: 's' })))])).toEqual([]);
    expect(localProblems([])).toEqual(['There is nothing to sign.']);
    expect(localProblems([{ ...approve, chainId: 1 }])[0]).toContain('network 1');
    expect(localProblems([{ ...approve, value: '1' }])[0]).toContain('sends a value');
    expect(localProblems([{ ...approve, call: { ...approve.call, args: { ...approve.call.args, amount: '1' } } }])[0]).toContain('different arguments');
    expect(localProblems([{ ...post, call: { ...post.call, function: 'withdrawCredit', args: {} } }]).join(' ')).toContain('never builds');
  });

  function provider(failPost: boolean): EIP1193Provider {
    return {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === 'eth_chainId') return '0x128';
        if (method === 'eth_gasPrice') return '0x' + (500_000_000_000n).toString(16);
        if (method === 'eth_estimateGas') {
          const { to } = (params as [{ to: string }])[0];
          if (to.toLowerCase() === VAULT.toLowerCase() && failPost) throw Object.assign(new Error('execution reverted'), { code: 3 });
          return '0x' + (100_000n).toString(16);
        }
        throw new Error(`unexpected ${method}`);
      },
      on: () => undefined,
      removeListener: () => undefined,
    } as unknown as EIP1193Provider;
  }

  it('estimates each step through the wallet with the x1.3 margin, keeping the budget for a step that needs the one before it', async () => {
    const built = await estimatePlan(provider(true), FROM, { transactions: [approve, post], summary: 'Post a deposit' }, 1_700_000_000);
    expect(built.transactions.map((t) => [t.gas, t.simulated])).toEqual([
      ['130000', true],
      [POST_DEPOSIT_BUDGET, false],
    ]);
    expect(built.preview.fee).toMatchObject({ basis: 'budget', gas: String(130_000 + Number(POST_DEPOSIT_BUDGET)), symbol: 'HBAR', decimals: 18 });
    expect(built).toMatchObject({ chainId: 296, from: FROM, builtAt: '1700000000', notAfter: null });
    const both = await estimatePlan(provider(false), FROM, { transactions: [approve, post], summary: 'Post a deposit' });
    expect(both.preview.fee.basis).toBe('estimate');
  });

  it('refuses a first step the network would refuse', async () => {
    await expect(estimatePlan(provider(true), FROM, { transactions: [post], summary: 'x' })).rejects.toThrow('The network would refuse postDeposit');
  });
});
