// Funding alerts: the ops keys and the claims contract's CCIP fee balance are checked against
// floors that are always set (the documented ones unless the environment says otherwise).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CIRCLE_VAULT_TOKEN } from '@recourse/shared';
import { parseUnits, zeroAddress, type Address } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveChains } from '../src/adapter.js';
import { Alerter } from '../src/alerts.js';
import { FLOOR_DEFAULTS, loadKeeperConfig } from '../src/config.js';
import { openJournal } from '../src/journal.js';
import { DEFAULT_FLOORS, Keeper, type FundingFloors } from '../src/machine.js';
import { FakeChains } from './fake-chains.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const hbar = (s: string) => parseUnits(s, 18);
const LINK_TOKEN = '0x00000000000000000000000000000000000f1a2b' as Address;

function rig(fake: FakeChains, floors?: FundingFloors) {
  const d = mkdtempSync(join(tmpdir(), 'keeper-levels-'));
  dirs.push(d);
  const journal = openJournal(d);
  const alerter = new Alerter({ service: 'keeper', append: (r) => journal.append(r), now: () => fake.t * 1000 });
  const k = new Keeper({
    chains: fake,
    journal,
    alerter,
    stateDir: d,
    evidence: { build: async () => ({ ok: false, kind: 'transient', message: 'not in this test' }) },
    now: () => fake.t,
    vaultToken: CIRCLE_VAULT_TOKEN,
    ...(floors ? { floors } : {}),
  });
  k.start();
  return { k, alerter };
}

async function check(fake: FakeChains, floors?: FundingFloors) {
  const r = rig(fake, floors);
  fake.t += 15;
  await r.k.tick();
  return r.alerter.pending();
}

describe('funding floors', () => {
  it('alerts gas_low for ops-hedera under the documented 10 HBAR even when no floors are passed', async () => {
    const fake = new FakeChains();
    fake.levelsV = { ...fake.levelsV, opsHederaWeibar: hbar('1.50955754'), opsArbWei: hbar('0.004') };
    const out = await check(fake);
    const gas = out.filter((a) => a.kind === 'gas_low');
    expect(gas.map((a) => a.subject).sort()).toEqual(['ops-arb', 'ops-hedera']);
    const h = gas.find((a) => a.subject === 'ops-hedera')!;
    expect(h.hint).toContain('1.50955754 HBAR');
    expect(h.hint).toContain('floor of 10 HBAR');
    expect(gas.find((a) => a.subject === 'ops-arb')!.hint).toContain('floor of 0.01 ETH');
  });

  it('stays quiet when every balance is above its floor', async () => {
    const fake = new FakeChains();
    const out = await check(fake);
    expect(out.filter((a) => a.kind === 'gas_low' || a.kind === 'link_low')).toEqual([]);
  });

  it('uses the floors it is given', async () => {
    const fake = new FakeChains();
    fake.levelsV = { ...fake.levelsV, opsHederaWeibar: hbar('5') };
    const quiet = await check(fake, { ...DEFAULT_FLOORS, opsHederaWeibar: hbar('2') });
    expect(quiet.some((a) => a.kind === 'gas_low')).toBe(false);
  });

  it('alerts link_low for the claims contract paying CCIP fees in HBAR under 3 sends', async () => {
    const fake = new FakeChains();
    fake.levelsV = { ...fake.levelsV, claimsFeeToken: zeroAddress, claimsNativeWeibar: hbar('3') };
    // No claim to quote: the static floor (3 x 2.2 HBAR) applies.
    let out = await check(fake);
    let low = out.find((a) => a.kind === 'link_low' && a.subject === 'claims')!;
    expect(low.hint).toContain('holds 3 HBAR');
    expect(low.hint).toContain('floor of 6.6 HBAR');
    expect(low.hint).toContain('fundNative()');

    // A claim to quote: the floor follows the live quote.
    const fake2 = new FakeChains();
    fake2.levelsV = { ...fake2.levelsV, claimsFeeToken: zeroAddress, claimsNativeWeibar: hbar('7') };
    fake2.sendQuote = hbar('3');
    fake2.file(1);
    const r = rig(fake2);
    for (let i = 0; i < 2; i++) {
      fake2.t += 15;
      await r.k.tick();
    }
    low = r.alerter.pending().find((a) => a.kind === 'link_low' && a.subject === 'claims')!;
    expect(low.hint).toContain('floor of 9 HBAR');
    expect(low.hint).toContain('one send costs 3 HBAR');

    const fake3 = new FakeChains();
    fake3.levelsV = { ...fake3.levelsV, claimsFeeToken: zeroAddress, claimsNativeWeibar: hbar('7') };
    out = await check(fake3);
    expect(out.some((a) => a.kind === 'link_low')).toBe(false);
  });

  it('checks the claims contract LINK when it pays CCIP fees in LINK', async () => {
    const fake = new FakeChains();
    fake.levelsV = { ...fake.levelsV, claimsFeeToken: LINK_TOKEN, claimsLink: parseUnits('0.013', 18), claimsNativeWeibar: 0n };
    fake.sendQuote = parseUnits('0.013', 18);
    const out = await check(fake);
    const low = out.find((a) => a.kind === 'link_low' && a.subject === 'claims')!;
    expect(low.hint).toContain('holds 0.013 LINK');
    expect(low.hint).toContain('floor of 0.04 LINK');
    const fake2 = new FakeChains();
    fake2.levelsV = { ...fake2.levelsV, claimsFeeToken: LINK_TOKEN, claimsLink: parseUnits('1', 18), claimsNativeWeibar: 0n };
    expect((await check(fake2)).some((a) => a.kind === 'link_low')).toBe(false);
  });
});

describe('LiveChains fee reads', () => {
  function chains(feeToken: Address, quote: bigint, scale?: bigint) {
    const at = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
    const balances: Record<string, bigint> = { [at(1).toLowerCase()]: hbar('3') };
    const client = {
      async readContract(q: { functionName: string }) {
        if (q.functionName === 'feeToken') return feeToken;
        if (q.functionName === 'quoteSend') return quote;
        if (q.functionName === 'link') return at(20);
        if (q.functionName === 'balanceOf') return 5n;
        throw new Error(`unexpected ${q.functionName}`);
      },
      async getBalance(q: { address: Address }) {
        return balances[q.address.toLowerCase()] ?? 1n;
      },
    };
    return new LiveChains({
      hedera: { client: client as never, claims: at(1), vault: at(2), offRamp: at(3), events: {} as never, sender: { address: at(9) } as never, ...(scale ? { weibarPerNativeUnit: scale } : {}) },
      arbitrum: { client: client as never, chainId: 421614, case: at(4), klerosCore: at(5), evidenceModule: at(6), offRamp: at(8), reader: {} as never, sender: { address: at(10) } as never },
    });
  }

  it('turns a native quote from tinybars into weibar, and leaves a LINK quote as it is', async () => {
    expect(await chains(zeroAddress, 220_000_000n).quoteSend('0x01')).toEqual({ native: true, amount: hbar('2.2') });
    expect(await chains(zeroAddress, 7n, 1n).quoteSend('0x01')).toEqual({ native: true, amount: 7n });
    expect(await chains(LINK_TOKEN, 13n * 10n ** 15n).quoteSend('0x01')).toEqual({ native: false, amount: 13n * 10n ** 15n });
  });

  it('reads the fee token and the claims contract HBAR balance with the other levels', async () => {
    const lv = await chains(zeroAddress, 1n).levels();
    expect(lv.claimsFeeToken).toBe(zeroAddress);
    expect(lv.claimsNativeWeibar).toBe(hbar('3'));
  });
});

describe('floor config', () => {
  const base = {
    KEEPER_STATE_DIR: '/tmp/keeper-config-test',
    KEEPER_PORT: '8787',
    SEND_PAUSE_WINDOWS: '',
    HEDERA_MIRROR_URL: 'https://mirror.example.test',
    HEDERA_RPC_URL_1: 'https://hedera.example.test',
    ARB_RPC_URL: 'https://arb.example.test',
    DEPLOYMENTS_DIR: '/tmp/deployments',
    COURT_URL_TEMPLATE: 'https://court.example.test/cases/{id}',
  };

  it('defaults to the documented floors, which are DEFAULT_FLOORS', () => {
    expect(FLOOR_DEFAULTS.KEEPER_FLOOR_OPS_HEDERA_HBAR).toBe('10');
    expect(loadKeeperConfig(base).floors).toEqual(DEFAULT_FLOORS);
  });

  it('reads each floor from the environment in whole units', () => {
    const cfg = loadKeeperConfig({
      ...base,
      KEEPER_FLOOR_OPS_HEDERA_HBAR: '12.5',
      KEEPER_FLOOR_OPS_ARB_ETH: '0.02',
      KEEPER_FLOOR_CLAIMS_FEE_HBAR: '9',
      KEEPER_FLOOR_CLAIMS_FEE_LINK: '0.1',
    });
    expect(cfg.floors).toEqual({ opsHederaWeibar: hbar('12.5'), opsArbWei: hbar('0.02'), claimsFeeWeibar: hbar('9'), claimsFeeLink: hbar('0.1') });
  });

  it('refuses a floor that is not a plain amount', () => {
    expect(() => loadKeeperConfig({ ...base, KEEPER_FLOOR_OPS_HEDERA_HBAR: '-1' })).toThrow(/KEEPER_FLOOR_OPS_HEDERA_HBAR/);
    expect(() => loadKeeperConfig({ ...base, KEEPER_FLOOR_OPS_ARB_ETH: '1e18' })).toThrow(/KEEPER_FLOOR_OPS_ARB_ETH/);
  });
});
