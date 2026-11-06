// The keeper machine over the in-memory two-chain fake: every lifecycle row, its timeouts and
// retries, the one-leg modes, pause windows, operator control and restart from the journal.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeMode, CIRCLE_VAULT_TOKEN, CaseState, ClaimStatus, ExecutionState, externalIdUint, vaultTokenOf } from '@recourse/shared';
import { keccak256, toHex, type Hex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { Alerter } from '../src/alerts.js';
import { phaseOf } from '../src/claims.js';
import { emptyControl, writeControl, type Control } from '../src/control.js';
import type { EvidencePort } from '../src/evidence.js';
import type { CallResult } from '../src/types.js';
import { openJournal, type Journal } from '../src/journal.js';
import { Keeper, type KeeperOptions } from '../src/machine.js';
import { FakeChains, SHOP } from './fake-chains.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Rig {
  dir: string;
  fake: FakeChains;
  journal: Journal;
  alerter: Alerter;
  k: Keeper;
  built: { claimId: Hex; attempt: number; externalId: bigint }[];
}

function rig(opts: { fake?: FakeChains; dir?: string; keeper?: Partial<KeeperOptions>; evidence?: EvidencePort } = {}): Rig {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'keeper-machine-'));
  if (!opts.dir) dirs.push(dir);
  const fake = opts.fake ?? new FakeChains();
  const journal = openJournal(dir);
  const alerter = new Alerter({ service: 'keeper', append: (r) => journal.append(r), now: () => fake.t * 1000 });
  const built: Rig['built'] = [];
  const evidence: EvidencePort = opts.evidence ?? {
    async build(req) {
      built.push({ claimId: req.claimId, attempt: req.attempt, externalId: req.externalId });
      const text = JSON.stringify({ name: 'evidence', claimId: req.claimId, attempt: req.attempt });
      return { ok: true, text, sha256: keccak256(toHex(text)) };
    },
  };
  const k = new Keeper({ chains: fake, journal, alerter, stateDir: dir, evidence, now: () => fake.t, vaultToken: CIRCLE_VAULT_TOKEN, ...opts.keeper });
  k.start();
  return { dir, fake, journal, alerter, k, built };
}

/** Advances chain time in steps, ticking the keeper after each. */
async function run(r: Rig, seconds: number, step = 15): Promise<void> {
  for (let s = 0; s < seconds; s += step) {
    r.fake.t += Math.min(step, seconds - s);
    await r.k.tick();
  }
}

const fns = (r: Rig, claimId?: Hex) =>
  r.fake.calls.filter((c) => claimId === undefined || c.args[0] === claimId || c.claimId === claimId).map((c) => c.fn);
const kinds = (r: Rig) => r.alerter.pending().map((a) => a.kind);
const phase = (r: Rig, id: Hex) => phaseOf(r.k.book.claims.get(id)!);

/** Filed, pre-checked and contested; the keeper sends it to court. */
async function toCourt(r: Rig, n = 1): Promise<Hex> {
  const id = r.fake.file(n);
  await run(r, 30);
  r.fake.precheck(id);
  await run(r, 30);
  r.fake.contest(id);
  await run(r, 30);
  return id;
}

/** ...delivered, opened, evidence posted, jurors drawn. */
async function toWatching(r: Rig, n = 1): Promise<Hex> {
  const id = await toCourt(r, n);
  r.fake.deliver(id);
  await run(r, 60);
  r.fake.draw(id);
  await run(r, 30);
  return id;
}

function control(r: Rig, patch: Partial<Control>): void {
  writeControl(r.dir, { ...emptyControl(), ...patch });
}

describe('happy path, both legs over CCIP', () => {
  it('sends, opens, posts evidence within 5 minutes, relays the ruling and settles', async () => {
    const r = rig();
    const id = await toCourt(r);
    expect(fns(r, id)).toEqual(['sendToCourt']);
    expect(phase(r, id)).toBe('Sent');

    r.fake.deliver(id);
    await run(r, 15);
    expect(phase(r, id)).toBe('Delivered');
    await run(r, 15);
    expect(fns(r, id)).toContain('openCase');
    // CaseOpened is read on the next poll; evidence goes out in that same tick.
    await run(r, 15);
    expect(fns(r, id)).toContain('submitEvidence');
    const openedAt = r.k.book.claims.get(id)!.attempts[0]!.openedAt;
    // A mined evidence transaction moves the claim on at once.
    expect(phase(r, id)).toBe('Watching');

    await run(r, 60);
    const ev = r.fake.calls.find((c) => c.fn === 'submitEvidence')!;
    expect(ev).toBeDefined();
    expect(ev.args[0]).toBe(externalIdUint(r.fake.arbChainId, r.fake.caseAddress, id, 1));
    expect(r.built[0]).toMatchObject({ claimId: id, attempt: 1 });
    expect(phase(r, id)).toBe('Watching');
    expect(r.k.book.claims.get(id)!.attempts[0]!.evidenceAt! - openedAt).toBeLessThanOrEqual(300);

    r.fake.draw(id);
    await run(r, 1200);
    r.fake.rule(id, 1);
    await run(r, 30);
    expect(fns(r, id)).toContain('relayRuling');
    expect(phase(r, id)).toBe('Relayed');

    r.fake.arrive(id);
    await run(r, 30);
    expect(fns(r, id).at(-1)).toBe('settle');
    expect(phase(r, id)).toBe('Settled');
    expect(r.fake.claims.get(id)!.status).toBe(ClaimStatus.Settled);
    expect(fns(r, id).filter((f) => f !== 'passPeriod')).toEqual(['sendToCourt', 'openCase', 'submitEvidence', 'relayRuling', 'settle']);
    expect(kinds(r)).not.toContain('rpc_down');
  });

  it('alerts withdraw_due once after Settled when the shop has credit', async () => {
    const r = rig();
    const id = await toWatching(r);
    r.fake.rule(id, 1);
    await run(r, 30);
    r.fake.credit.set(SHOP.toLowerCase(), 5_000_000n);
    r.fake.arrive(id);
    await run(r, 60);
    expect(phase(r, id)).toBe('Settled');
    expect(kinds(r).filter((k) => k === 'withdraw_due')).toHaveLength(1);
    await run(r, 3600, 300);
    expect(kinds(r).filter((k) => k === 'withdraw_due')).toHaveLength(1);
    expect(r.alerter.pending().find((a) => a.kind === 'withdraw_due')?.hint).toContain('5000000 µUSDC of credit; run');
  });

  it('names the testnet mock in the withdraw_due alert when the vault runs on it', async () => {
    const vaultToken = vaultTokenOf({ usdc: { mode: 'mock', address: `0x${'11'.repeat(20)}`, decimals: 6, tokenId: null } });
    const r = rig({ keeper: { vaultToken } });
    const id = await toWatching(r);
    r.fake.rule(id, 1);
    await run(r, 30);
    r.fake.credit.set(SHOP.toLowerCase(), 5_000_000n);
    r.fake.arrive(id);
    await run(r, 60);
    expect(r.alerter.pending().find((a) => a.kind === 'withdraw_due')?.hint).toContain('5000000 µmUSDC of credit (testnet mock); run');
  });
});

describe('contest window', () => {
  it('closes an uncontested claim only after the window, never at the boundary second', async () => {
    const r = rig();
    const id = r.fake.file(1);
    await r.k.tick();
    r.fake.precheck(id);
    const at = r.fake.t;
    await r.k.tick();
    r.fake.t = at + r.fake.claimsParamsV.contestWindow;
    await r.k.tick();
    expect(fns(r, id)).toEqual([]);
    r.fake.t += 1;
    await r.k.tick();
    expect(fns(r, id)).toEqual(['closeUncontested']);
    await r.k.tick();
    expect(phase(r, id)).toBe('Closed');
  });

  it('holds timed actions while params() is unreadable', async () => {
    const r = rig();
    const id = r.fake.file(1);
    await r.k.tick();
    r.fake.precheck(id);
    await r.k.tick();
    r.fake.paramsFail = true;
    await run(r, 1200, 60);
    expect(fns(r, id)).toEqual([]);
    expect(kinds(r)).toContain('params_unreadable');
    r.fake.paramsFail = false;
    await r.k.tick();
    expect(fns(r, id)).toEqual(['closeUncontested']);
  });
});

describe('outbound bridge', () => {
  it('resends an Untouched message after 60 min, up to maxSends, then alerts sends_exhausted', async () => {
    const r = rig();
    const id = await toCourt(r);
    await run(r, 3500, 60);
    expect(fns(r, id)).toEqual(['sendToCourt']);
    await run(r, 300, 60);
    expect(fns(r, id)).toEqual(['sendToCourt', 'resend']);
    await run(r, 3700, 60);
    expect(fns(r, id)).toEqual(['sendToCourt', 'resend', 'resend']);
    await run(r, 3700, 60);
    expect(fns(r, id)).toEqual(['sendToCourt', 'resend', 'resend']);
    expect(kinds(r)).toContain('sends_exhausted');
    expect(kinds(r)).toContain('outbound_slow');
  });

  it('never resends while a copy is InProgress', async () => {
    const r = rig();
    const id = await toCourt(r);
    r.fake.exec.set(`arbitrum:${r.fake.claims.get(id)!.lastMessageId}`, ExecutionState.InProgress);
    await run(r, 7200, 120);
    expect(fns(r, id)).toEqual(['sendToCourt']);
  });

  it('alerts exec_failure on a Failure state and does not resend', async () => {
    const r = rig();
    const id = await toCourt(r);
    r.fake.exec.set(`arbitrum:${r.fake.claims.get(id)!.lastMessageId}`, ExecutionState.Failure);
    await run(r, 4000, 120);
    expect(kinds(r)).toContain('exec_failure');
    expect(fns(r, id)).toEqual(['sendToCourt']);
  });

  it('needs both proofs: Success with no ClaimReceived alerts delivered_not_recorded and is not resent', async () => {
    const r = rig();
    const id = await toCourt(r);
    r.fake.deliver(id, { record: false });
    await run(r, 240);
    expect(kinds(r)).not.toContain('delivered_not_recorded');
    await run(r, 120);
    expect(kinds(r)).toContain('delivered_not_recorded');
    await run(r, 4000, 120);
    expect(fns(r, id)).toEqual(['sendToCourt']);
    expect(phase(r, id)).toBe('Sent');
  });

  it('a ClaimReceived without OffRamp Success is not yet Delivered', async () => {
    const r = rig();
    const id = await toCourt(r);
    r.fake.deliver(id);
    r.fake.exec.set(`arbitrum:${r.fake.claims.get(id)!.lastMessageId}`, ExecutionState.InProgress);
    await run(r, 120);
    expect(phase(r, id)).toBe('Sent');
    expect(fns(r, id)).not.toContain('openCase');
    r.fake.exec.set(`arbitrum:${r.fake.claims.get(id)!.lastMessageId}`, ExecutionState.Success);
    await run(r, 60);
    expect(fns(r, id)).toContain('openCase');
  });
});

describe('opening the case', () => {
  it('waits and alerts fee_pool_low when the pool is below the arbitration cost', async () => {
    const r = rig();
    const id = await toCourt(r);
    r.fake.feePoolV = 1n;
    r.fake.deliver(id);
    await run(r, 300);
    expect(fns(r, id)).not.toContain('openCase');
    expect(kinds(r)).toContain('fee_pool_low');
    r.fake.feePoolV = 10n ** 18n;
    await run(r, 30);
    expect(fns(r, id)).toContain('openCase');
  });

  it('alerts once and opens the case without evidence when the evidence can never be built', async () => {
    let builds = 0;
    const r = rig({
      evidence: {
        build: async () => {
          builds++;
          return { ok: false, kind: 'too_large', message: 'evidence is 17000 bytes' };
        },
      },
    });
    const id = await toCourt(r);
    r.fake.deliver(id);
    await run(r, 300);
    expect(kinds(r)).toContain('evidence_too_large');
    expect(fns(r, id)).toContain('openCase');
    expect(r.k.book.claims.get(id)!.autoHold).toBeUndefined();
    r.fake.draw(id);
    await run(r, 600, 60);
    expect(fns(r, id)).not.toContain('submitEvidence');
    expect(builds).toBe(1);
    expect(kinds(r).filter((k) => k === 'evidence_too_large')).toHaveLength(1);
  });

  it('refiles without evidence when the second attempt\'s evidence can never be built', async () => {
    const r = rig({
      evidence: {
        build: async (req) =>
          req.attempt === 1
            ? { ok: true, text: 'evidence one', sha256: keccak256(toHex('evidence one')) }
            : { ok: false, kind: 'input', message: 'pre-check slot 2 is held without cid and hash' },
      },
    });
    const id = await toWatching(r);
    r.fake.rule(id, 0);
    await run(r, 30);
    expect(phase(r, id)).toBe('RefilePending');
    await run(r, 900, 60);
    expect(fns(r, id)).toContain('refile');
    expect(kinds(r)).toContain('evidence_failed');
    expect(r.k.book.claims.get(id)!.autoHold).toBeUndefined();
  });

  it('opens without evidence when the case deadline is close and evidence is still transient', async () => {
    const r = rig({ evidence: { build: async () => ({ ok: false, kind: 'transient', message: 'gateway down' }) } });
    const id = await toCourt(r);
    r.fake.deliver(id);
    await run(r, 2600, 60);
    expect(fns(r, id)).not.toContain('openCase');
    await run(r, 200, 60);
    expect(fns(r, id)).toContain('openCase');
    expect(kinds(r)).toContain('evidence_failed');
  });
});

describe('court', () => {
  it('refiles once on ruling 0 with the journaled payload bytes, then relays the second ruling', async () => {
    const r = rig();
    const id = await toWatching(r);
    r.fake.rule(id, 0);
    await run(r, 30);
    expect(phase(r, id)).toBe('RefilePending');
    await run(r, 540);
    expect(fns(r, id)).not.toContain('refile');
    await run(r, 90);
    const refiles = r.fake.calls.filter((c) => c.fn === 'refile');
    expect(refiles).toHaveLength(1);
    expect(refiles[0]!.args[0]).toBe(r.k.book.claims.get(id)!.received!.payload);
    expect(refiles[0]!.args[0]).toBe(r.fake.payloadOf(id));

    await run(r, 60);
    expect(phase(r, id)).toBe('Watching');
    const ev2 = r.fake.calls.filter((c) => c.fn === 'submitEvidence');
    expect(ev2).toHaveLength(2);
    expect(ev2[1]!.args[0]).toBe(externalIdUint(r.fake.arbChainId, r.fake.caseAddress, id, 2));

    r.fake.rule(id, 0); // a second refusal is final
    await run(r, 60);
    expect(fns(r, id).filter((f) => f === 'refile')).toHaveLength(1);
    expect(fns(r, id)).toContain('relayRuling');
  });

  it('alerts ruling_zero_early once on an untied 0, not on the opening tie', async () => {
    const r = rig();
    const id = await toWatching(r);
    await run(r, 1800, 60);
    expect(kinds(r)).not.toContain('ruling_zero_early');
    const d = r.fake.disputeOf(id).toString();
    r.fake.rulings.set(d, { ruling: 0n, tied: false, overridden: false });
    await run(r, 600, 60);
    expect(kinds(r).filter((k) => k === 'ruling_zero_early')).toHaveLength(1);
  });

  it('nudges an overdue period with passPeriod, once per period change', async () => {
    const r = rig();
    const id = await toWatching(r);
    await run(r, 900 + 600 + 60, 60);
    expect(fns(r).filter((f) => f === 'passPeriod')).toHaveLength(1);
    expect(kinds(r)).toContain('kleros_nudged');
    await run(r, 600, 60);
    expect(fns(r).filter((f) => f === 'passPeriod')).toHaveLength(1);
    expect(phase(r, id)).toBe('Watching');
  });

  it('skips nudges when the arbitrator has no dispute views', async () => {
    const r = rig();
    r.fake.disputeViews = false;
    await toWatching(r);
    await run(r, 3600, 120);
    expect(fns(r).filter((f) => ['passPeriod', 'draw', 'passPhase', 'executeRuling'].includes(f))).toEqual([]);
    expect(kinds(r)).not.toContain('rpc_down');
  });

  it('alerts appeal_contribution with the time left and never funds an appeal', async () => {
    const r = rig();
    const id = await toWatching(r);
    const d = r.fake.disputeOf(id);
    r.fake.disputes.set(d.toString(), { courtId: 8n, period: 3, ruled: false, lastPeriodChange: r.fake.t, timesPerPeriod: [900, 2700, 1800, 2700] });
    r.fake.emitA('kit', 'Contribution', { _coreDisputeID: d, _coreRoundID: 0n, _choice: 2n, _contributor: '0x00000000000000000000000000000000000000c1', _amount: 10n ** 15n });
    await run(r, 15);
    const a = r.alerter.pending().find((x) => x.kind === 'appeal_contribution')!;
    expect(a).toBeDefined();
    expect(a.claimId).toBe(id);
    expect(a.detail).toMatchObject({ choice: '2', timeLeft: '2685 s' });
    expect(fns(r).some((f) => /fund|appeal/i.test(f))).toBe(false);
  });

  it('keeps reading and nudging after a missed evidence period', async () => {
    const r = rig();
    const id = await toCourt(r);
    r.fake.overrides.set('submitEvidence', () => ({ kind: 'reverted', error: 'Unknown' }));
    r.fake.deliver(id);
    await run(r, 1000, 30);
    expect(kinds(r)).toContain('evidence_missed');
    await run(r, 900, 60);
    expect(fns(r).filter((f) => f === 'passPeriod')).toHaveLength(1);
  });
});

describe('ruling back to Hedera', () => {
  it('pays in ETH from the ops key when the case contract is short of LINK', async () => {
    const r = rig();
    const id = await toWatching(r);
    r.fake.linkShort = true;
    r.fake.rule(id, 2);
    await run(r, 30);
    const relays = r.fake.calls.filter((c) => c.fn === 'relayRuling');
    expect(relays.map((c) => c.value ?? 0n)).toEqual([0n, (10n ** 15n * 11n) / 10n]);
    expect(kinds(r)).toContain('link_low');
    expect(phase(r, id)).toBe('Relayed');
  });

  it('relays again when the ruling message stays Untouched for 60 min', async () => {
    const r = rig();
    const id = await toWatching(r);
    r.fake.rule(id, 1);
    await run(r, 30);
    await run(r, 3500, 60);
    expect(fns(r, id).filter((f) => f === 'relayRuling')).toHaveLength(1);
    expect(kinds(r)).toContain('return_slow');
    await run(r, 300, 60);
    expect(fns(r, id).filter((f) => f === 'relayRuling')).toHaveLength(2);
  });

  it('retries settle every 5 min, 6 times, then holds and alerts settle_failed', async () => {
    const r = rig();
    const id = await toWatching(r);
    r.fake.rule(id, 1);
    await run(r, 30);
    r.fake.overrides.set('settle', () => ({ kind: 'reverted', error: 'TransferFailed' }));
    r.fake.arrive(id);
    await run(r, 3 * 3600, 60);
    expect(fns(r, id).filter((f) => f === 'settle')).toHaveLength(6);
    expect(kinds(r)).toContain('settle_failed');
    expect(r.k.book.claims.get(id)!.autoHold).toBeDefined();

    r.fake.overrides.delete('settle');
    control(r, { releases: { [id]: Date.now() + 1000 } });
    await run(r, 30);
    expect(phase(r, id)).toBe('Settled');
  });
});

describe('expiry', () => {
  it('expires a claim that was never pre-checked, strictly after filedAt + claimTimeout', async () => {
    const r = rig();
    const id = r.fake.file(1);
    const filed = r.fake.t;
    await r.k.tick();
    r.fake.t = filed + r.fake.claimsParamsV.claimTimeout;
    await r.k.tick();
    expect(fns(r, id)).toEqual([]);
    expect(kinds(r)).toContain('precheck_late');
    r.fake.t += 1;
    await r.k.tick();
    expect(fns(r, id)).toEqual(['expireClaim']);
    await r.k.tick();
    expect(phase(r, id)).toBe('Expired');
  });

  it('expires a contested claim whose sends keep failing, after holding it at 5 tries', async () => {
    const r = rig();
    r.fake.overrides.set('sendToCourt', () => ({ kind: 'reverted', error: 'LinkShort' }));
    const id = await toCourt(r);
    await run(r, 600, 30);
    expect(fns(r, id).filter((f) => f === 'sendToCourt')).toHaveLength(5);
    expect(kinds(r)).toContain('link_low');
    expect(kinds(r)).toContain('send_late');
    expect(r.k.book.claims.get(id)!.autoHold).toBeDefined();
    await run(r, r.fake.claimsParamsV.claimTimeout, 300);
    expect(fns(r, id)).toContain('expireClaim');
    expect(r.fake.claims.get(id)!.status).toBe(ClaimStatus.Expired);
  });

  it('waits on expiry while a ruling message is in flight (expiry_race), then settles', async () => {
    const fake = new FakeChains();
    fake.claimsParamsV.claimTimeout = 2 * 3600;
    const r = rig({ fake });
    const id = await toWatching(r);
    r.fake.rule(id, 1);
    await run(r, 30);
    expect(phase(r, id)).toBe('Relayed');
    await run(r, 2 * 3600, 120);
    expect(kinds(r)).toContain('expiry_race');
    expect(fns(r, id)).not.toContain('expireClaim');
    r.fake.arrive(id);
    await run(r, 60);
    expect(phase(r, id)).toBe('Settled');
  });

  it('alerts expire_failed and holds when expireClaim reverts', async () => {
    const r = rig();
    r.fake.overrides.set('expireClaim', () => ({ kind: 'reverted', error: 'WrongStatus' }));
    const id = r.fake.file(1);
    await run(r, r.fake.claimsParamsV.claimTimeout + 120, 300);
    expect(kinds(r)).toContain('expire_failed');
    const n = fns(r, id).filter((f) => f === 'expireClaim').length;
    await run(r, 1800, 300);
    expect(fns(r, id).filter((f) => f === 'expireClaim')).toHaveLength(n);
  });

  it('expires a stale case on Hedera once allowed', async () => {
    const fake = new FakeChains();
    fake.claimsParamsV.claimTimeout = 2 * 3600;
    const r = rig({ fake });
    const id = await toCourt(r);
    r.fake.deliver(id);
    r.fake.overrides.set('openCase', () => ({ kind: 'reverted', error: 'TemplateNotSet' }));
    await run(r, 3600, 120);
    r.fake.stale(id);
    await run(r, 60);
    expect(phase(r, id)).toBe('Stale');
    expect(kinds(r)).toContain('claim_stale');
    await run(r, 2 * 3600, 300);
    expect(r.fake.claims.get(id)!.status).toBe(ClaimStatus.Expired);
  });

  /** Ticks once at chain time `t` and returns how many expireClaim calls the claim has had. */
  async function expiresAt(r: Rig, id: Hex, t: number): Promise<number> {
    r.fake.t = t;
    await r.k.tick();
    return fns(r, id).filter((f) => f === 'expireClaim').length;
  }

  it('a contested claim counts from preCheckedAt: not at filedAt + T + 1, not at preCheckedAt + T, at the second after', async () => {
    const r = rig();
    r.fake.overrides.set('sendToCourt', () => ({ kind: 'reverted', error: 'LinkShort' }));
    const id = r.fake.file(1);
    await run(r, 30);
    await run(r, 1200, 300); // a late pre-check
    r.fake.precheck(id);
    r.fake.contest(id);
    await run(r, 30);
    const c = r.fake.claims.get(id)!;
    expect(c.status).toBe(ClaimStatus.Contested);
    const T = r.fake.claimsParamsV.claimTimeout;
    expect(await expiresAt(r, id, Number(c.filedAt) + T + 1)).toBe(0);
    expect(await expiresAt(r, id, Number(c.preCheckedAt) + T)).toBe(0);
    expect(await expiresAt(r, id, Number(c.preCheckedAt) + T + 1)).toBe(1);
    await r.k.tick();
    expect(phase(r, id)).toBe('Expired');
  });

  it('an at-court claim counts from preCheckedAt too', async () => {
    const r = rig();
    const id = r.fake.file(1);
    await run(r, 900, 300);
    r.fake.precheck(id);
    r.fake.contest(id);
    await run(r, 30);
    const c = r.fake.claims.get(id)!;
    expect(c.status).toBe(ClaimStatus.AtCourt);
    const T = r.fake.claimsParamsV.claimTimeout;
    expect(await expiresAt(r, id, Number(c.filedAt) + T + 1)).toBe(0);
    expect(await expiresAt(r, id, Number(c.preCheckedAt) + T)).toBe(0);
    expect(await expiresAt(r, id, Number(c.preCheckedAt) + T + 1)).toBe(1);
  });

  it('a pre-checked claim never expires; it waits for closeUncontested', async () => {
    const r = rig();
    r.fake.overrides.set('closeUncontested', () => ({ kind: 'reverted', error: 'TransferFailed' }));
    const id = r.fake.file(1);
    await run(r, 30);
    r.fake.precheck(id);
    const c = r.fake.claims.get(id)!;
    const T = r.fake.claimsParamsV.claimTimeout;
    expect(await expiresAt(r, id, Number(c.filedAt) + T + 1)).toBe(0);
    expect(await expiresAt(r, id, Number(c.preCheckedAt) + T + 1)).toBe(0);
    expect(await expiresAt(r, id, Number(c.preCheckedAt) + 3 * T)).toBe(0);
    expect(fns(r, id)).toContain('closeUncontested');
    expect(r.fake.claims.get(id)!.status).toBe(ClaimStatus.PreChecked);
  });

  it('NotExpired from expireClaim is a clock race: no hold, tried again', async () => {
    const r = rig();
    const id = r.fake.file(1);
    await r.k.tick();
    let first = true;
    r.fake.overrides.set('expireClaim', (): CallResult | undefined => {
      if (!first) return undefined;
      first = false;
      return { kind: 'reverted', error: 'NotExpired' };
    });
    const T = r.fake.claimsParamsV.claimTimeout;
    expect(await expiresAt(r, id, Number(r.fake.claims.get(id)!.filedAt) + T + 1)).toBe(1);
    expect(r.k.book.claims.get(id)!.autoHold).toBeUndefined();
    expect(kinds(r)).not.toContain('expire_failed');
    await run(r, 150, 30);
    expect(fns(r, id).filter((f) => f === 'expireClaim')).toHaveLength(2);
    expect(r.fake.claims.get(id)!.status).toBe(ClaimStatus.Expired);
  });
});

describe('expiry never beats a court ruling (Both mode)', () => {
  /** A Watching claim with a 3 h Hedera claim timeout; returns the second expiry becomes possible. */
  async function watchingNearTimeout(opts: { keeper?: Partial<KeeperOptions> } = {}): Promise<{ r: Rig; id: Hex; expiresAfter: number }> {
    const fake = new FakeChains();
    fake.claimsParamsV.claimTimeout = 3 * 3600;
    const r = rig({ fake, ...opts });
    const id = await toWatching(r);
    return { r, id, expiresAfter: Number(r.fake.claims.get(id)!.preCheckedAt) + r.fake.claimsParamsV.claimTimeout + 1 };
  }

  it('keeper down across the ruling and the claim timeout: relays the ruling, never expires', async () => {
    const { r, id, expiresAfter } = await watchingNearTimeout();
    expect(r.fake.mode).toBe(BridgeMode.Both);
    r.fake.t = expiresAfter - 60;
    r.fake.rule(id, 1); // no tick: the keeper is down
    r.fake.t = expiresAfter + 5;
    await r.k.tick();
    expect(fns(r, id)).toContain('relayRuling');
    expect(fns(r, id)).not.toContain('expireClaim');
    expect(kinds(r)).toContain('expiry_race');
    await run(r, 30);
    r.fake.arrive(id);
    await run(r, 60);
    expect(phase(r, id)).toBe('Settled');
    expect(fns(r, id)).not.toContain('expireClaim');
  });

  it('reads the case on Arbitrum: a Ruled case whose RulingFinal is not read yet still holds expiry back', async () => {
    const { r, id, expiresAfter } = await watchingNearTimeout();
    const cv = r.fake.cases.get(id)!;
    cv.state = CaseState.Ruled; // the reader trails the chain: no RulingFinal event yet
    cv.ruling = 1;
    r.fake.t = expiresAfter + 5;
    await run(r, 600, 60);
    expect(phase(r, id)).toBe('Watching');
    expect(fns(r, id)).not.toContain('expireClaim');
    expect(r.alerter.pending().find((a) => a.kind === 'expiry_race')?.hint).toContain('Ruled');
    r.fake.emitA('case', 'RulingFinal', { claimId: id, disputeId: r.fake.disputeOf(id), ruling: 1, attempts: 1 });
    await run(r, 60);
    expect(fns(r, id)).toContain('relayRuling');
    expect(fns(r, id)).not.toContain('expireClaim');
  });

  it('a relay held after 5 failures keeps expiry back until keeper-ctl expire', async () => {
    const { r, id, expiresAfter } = await watchingNearTimeout();
    r.fake.overrides.set('relayRuling', () => ({ kind: 'reverted', error: 'InsufficientValue' }));
    r.fake.rule(id, 1);
    await run(r, 600, 60);
    expect(fns(r, id).filter((f) => f === 'relayRuling')).toHaveLength(5);
    expect(r.k.book.claims.get(id)!.autoHold?.reason).toMatch(/relayRuling failed 5 times/);
    r.fake.t = expiresAfter + 1;
    await run(r, 1800, 60);
    expect(fns(r, id)).not.toContain('expireClaim');
    const hint = r.alerter.pending().find((a) => a.kind === 'expiry_race')?.hint ?? '';
    expect(hint).toContain(`keeper-ctl expire ${id}`);
    expect(hint).toContain('held');
    control(r, { expire: { [id]: Date.now() } });
    await run(r, 60);
    expect(fns(r, id)).toContain('expireClaim');
    expect(r.fake.claims.get(id)!.status).toBe(ClaimStatus.Expired);
  });

  it('a ruling inside the relay lead of a Hedera window waits for the window, and expiry does not go first', async () => {
    const fake = new FakeChains();
    fake.claimsParamsV.claimTimeout = 3 * 3600;
    const preCheckedAt = fake.t + 30; // toWatching pre-checks 30 s in
    const expiresAfter = preCheckedAt + fake.claimsParamsV.claimTimeout + 1;
    const from = expiresAfter + 600;
    const r = rig({ fake, keeper: { windows: [{ chain: 'hedera', from, to: from + 2400 }] } });
    const id = await toWatching(r);
    expect(Number(r.fake.claims.get(id)!.preCheckedAt)).toBe(preCheckedAt);
    r.fake.t = expiresAfter - 120;
    r.fake.rule(id, 1);
    await run(r, 300, 30);
    expect(fns(r, id)).not.toContain('relayRuling'); // inside the 30-min lead
    expect(fns(r, id)).not.toContain('expireClaim');
    r.fake.t = from + 2400;
    await r.k.tick();
    expect(fns(r, id)).toContain('relayRuling');
    r.fake.arrive(id);
    await run(r, 60);
    expect(phase(r, id)).toBe('Settled');
    expect(fns(r, id)).not.toContain('expireClaim');
  });

  it('a Kleros dispute in its execution period gets executeRuling, not expireClaim or markStale', async () => {
    const r = rig();
    const id = await toWatching(r);
    const d = r.fake.disputeOf(id).toString();
    r.fake.t = Number(r.fake.claims.get(id)!.preCheckedAt) + r.fake.claimsParamsV.claimTimeout + 5;
    expect(r.fake.t).toBeGreaterThan(Number(r.fake.cases.get(id)!.expiresAt)); // the case has expired too
    r.fake.disputes.set(d, { ...r.fake.disputes.get(d)!, period: 4, lastPeriodChange: r.fake.t - 700 });
    await run(r, 60);
    expect(fns(r, id)).toContain('executeRuling');
    expect(fns(r, id)).not.toContain('expireClaim');
    expect(fns(r, id)).not.toContain('markStale');
    expect(kinds(r)).toContain('expiry_race');
  });

  it('a ruling message that failed on the Hedera OffRamp holds expiry back for the operator', async () => {
    const { r, id, expiresAfter } = await watchingNearTimeout();
    r.fake.rule(id, 1);
    await run(r, 30);
    expect(phase(r, id)).toBe('Relayed');
    r.fake.exec.set(`hedera:${r.fake.cases.get(id)!.lastMessageId.toLowerCase()}`, ExecutionState.Failure);
    r.fake.t = expiresAfter + 1;
    await run(r, 600, 60);
    expect(fns(r, id)).not.toContain('expireClaim');
    expect(r.alerter.pending().find((a) => a.kind === 'expiry_race')?.hint).toContain('failed on the Hedera OffRamp');
  });
});

describe('stale cases on Arbitrum', () => {
  /** A case timeout that fits one court round (8100 s) plus the slack (3600 s), well short of the Hedera claim's. */
  const CASE_TIMEOUT = 14_400;
  /** A Watching claim whose case expires (filedAt + the case's timeout) long before the Hedera claim can. */
  async function watchingWithCaseTimeout(caseTimeout: number): Promise<{ r: Rig; id: Hex; exp: number }> {
    const fake = new FakeChains();
    fake.caseParamsV.claimTimeout = caseTimeout;
    const r = rig({ fake });
    const id = await toWatching(r);
    return { r, id, exp: Number(r.fake.cases.get(id)!.expiresAt) };
  }

  it('marks an expired case stale at expiresAt, not a second before, and frees its slot', async () => {
    const { r, id, exp } = await watchingWithCaseTimeout(CASE_TIMEOUT);
    expect(exp).toBe(Number(r.fake.claims.get(id)!.filedAt) + CASE_TIMEOUT);
    expect(await r.fake.openCases()).toBe(1);
    r.fake.t = exp - 1;
    await r.k.tick();
    expect(fns(r, id)).not.toContain('markStale');
    r.fake.t = exp;
    await r.k.tick();
    expect(fns(r, id).filter((f) => f === 'markStale')).toHaveLength(1);
    await run(r, 30);
    expect(phase(r, id)).toBe('Stale');
    expect(await r.fake.openCases()).toBe(0);
    expect(fns(r, id).filter((f) => f === 'markStale')).toHaveLength(1);
    expect(r.k.book.claims.get(id)!.autoHold).toBeUndefined();
  });

  it('frees the slot of a refused case waiting on its refile', async () => {
    const { r, id, exp } = await watchingWithCaseTimeout(CASE_TIMEOUT);
    // Attempt 1 is refused; an operator hold keeps the refile back past the case deadline.
    r.fake.rule(id, 0);
    await run(r, 30);
    expect(phase(r, id)).toBe('RefilePending');
    control(r, { holds: { [id]: Date.now() } });
    await run(r, 600, 60);
    expect(fns(r, id)).not.toContain('refile');
    control(r, {});
    r.fake.t = exp;
    await r.k.tick();
    expect(fns(r, id)).toContain('markStale');
    expect(fns(r, id)).not.toContain('refile');
    await run(r, 30);
    expect(phase(r, id)).toBe('Stale');
    expect(await r.fake.openCases()).toBe(0);
  });

  it('WrongState from markStale is a race: not counted, never sent again', async () => {
    const { r, id, exp } = await watchingWithCaseTimeout(CASE_TIMEOUT);
    r.fake.overrides.set('markStale', () => ({ kind: 'reverted', error: 'WrongState' }));
    r.fake.t = exp;
    await run(r, 1800, 60);
    expect(fns(r, id).filter((f) => f === 'markStale')).toHaveLength(1);
    const c = r.k.book.claims.get(id)!;
    expect(c.autoHold).toBeUndefined();
    expect(c.tries.markStale!.count).toBe(0);
    expect(kinds(r)).not.toContain('call_failed');
  });

  it('NotExpired from markStale waits for the expiresAt the contract names, then goes through', async () => {
    const { r, id, exp } = await watchingWithCaseTimeout(CASE_TIMEOUT);
    const later = exp + 1800;
    r.fake.overrides.set('markStale', () => ({ kind: 'reverted', error: 'NotExpired', args: [BigInt(later)] }));
    r.fake.t = exp;
    await r.k.tick();
    r.fake.overrides.delete('markStale');
    r.fake.cases.get(id)!.expiresAt = BigInt(later);
    await run(r, 1800 - 60, 60);
    expect(fns(r, id).filter((f) => f === 'markStale')).toHaveLength(1);
    const c = r.k.book.claims.get(id)!;
    expect(c.caseExpiresAt).toBe(later);
    expect(c.tries.markStale!.count).toBe(0);
    expect(c.autoHold).toBeUndefined();
    await run(r, 120, 60);
    expect(fns(r, id).filter((f) => f === 'markStale')).toHaveLength(2);
    await run(r, 30);
    expect(phase(r, id)).toBe('Stale');
  });

  it('an openCase that lands at expiresAt goes Stale, spends nothing and is not a failure', async () => {
    const fake = new FakeChains();
    fake.caseParamsV.claimTimeout = 3000;
    // A one-second court and no slack, so the round check lets the open through to the race.
    fake.courtRoundV = 1;
    // The keeper's clock trails the chain by a second: it still sees an open window.
    const r = rig({ fake, keeper: { now: () => fake.t - 1, timing: { courtSlackS: 0 } } });
    const id = await toCourt(r);
    r.fake.feePoolV = 1n; // openCase waits on the fee pool
    r.fake.deliver(id);
    const exp = Number(r.fake.cases.get(id)!.expiresAt);
    await run(r, exp - r.fake.t - 30, 60);
    expect(fns(r, id)).not.toContain('openCase');
    r.fake.feePoolV = 10n ** 17n;
    r.fake.t = exp;
    await r.k.tick();
    expect(fns(r, id).filter((f) => f === 'openCase')).toHaveLength(1);
    expect(r.fake.cases.get(id)!.state).toBe(CaseState.Stale);
    expect(r.fake.feePoolV).toBe(10n ** 17n);
    await run(r, 30);
    const c = r.k.book.claims.get(id)!;
    expect(phase(r, id)).toBe('Stale');
    expect(c.tries.openCase!.count).toBe(0);
    expect(c.autoHold).toBeUndefined();
    expect(kinds(r)).not.toContain('call_failed');
    expect(fns(r, id)).not.toContain('markStale');
    // Hedera then expires the claim from its own clock.
    r.fake.t = Number(r.fake.claims.get(id)!.preCheckedAt) + r.fake.claimsParamsV.claimTimeout + 2;
    await run(r, 60);
    expect(r.fake.claims.get(id)!.status).toBe(ClaimStatus.Expired);
  });

  it('does not open a case that cannot finish one court round before it expires, and says so once', async () => {
    const fake = new FakeChains();
    fake.caseParamsV.claimTimeout = 3 * 3600; // under 8100 s + 3600 s once delivered
    const r = rig({ fake });
    const id = await toCourt(r);
    r.fake.deliver(id);
    const pool = r.fake.feePoolV;
    await run(r, 600, 60);
    expect(fns(r, id)).not.toContain('openCase');
    const stale = r.alerter.pending().filter((a) => a.kind === 'claim_stale' && a.claimId === id);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.hint).toContain('openCase skipped');
    expect(stale[0]!.hint).toContain('8100 s');
    // It goes stale at expiresAt without spending the fee pool.
    r.fake.t = Number(r.fake.cases.get(id)!.expiresAt);
    await run(r, 60);
    expect(fns(r, id)).toContain('markStale');
    expect(fns(r, id)).not.toContain('openCase');
    expect(r.fake.feePoolV).toBe(pool);
  });

  it("takes the round from the court's own periods: a short court opens what the fallback would skip", async () => {
    const fake = new FakeChains();
    fake.caseParamsV.claimTimeout = 3 * 3600;
    fake.courtRoundV = 3600;
    const r = rig({ fake });
    const id = await toCourt(r);
    r.fake.deliver(id);
    await run(r, 120, 60);
    expect(fns(r, id)).toContain('openCase');
  });

  it('falls back to 8100 s when the court cannot be read', async () => {
    const fake = new FakeChains();
    fake.caseParamsV.claimTimeout = 3 * 3600;
    fake.courtRoundV = undefined; // the read fails
    const r = rig({ fake });
    const id = await toCourt(r);
    r.fake.deliver(id);
    await run(r, 120, 60);
    expect(fns(r, id)).not.toContain('openCase');
    expect(r.alerter.pending().find((a) => a.kind === 'claim_stale')!.hint).toContain('8100 s');
  });

  it('does not refile when the second round cannot finish before the case expires', async () => {
    const { r, id, exp } = await watchingWithCaseTimeout(CASE_TIMEOUT);
    r.fake.t = exp - 11_000;
    r.fake.rule(id, 0);
    await run(r, 30);
    expect(phase(r, id)).toBe('RefilePending');
    await run(r, 900, 60);
    expect(fns(r, id)).not.toContain('refile');
    expect(r.alerter.pending().find((a) => a.kind === 'claim_stale')!.hint).toContain('refile skipped');
  });

  it('after a downtime past both deadlines: expires on Hedera first, then frees the case from the expired claim', async () => {
    const r = rig();
    const id = await toWatching(r);
    expect(await r.fake.openCases()).toBe(1);
    r.fake.t = Number(r.fake.claims.get(id)!.preCheckedAt) + r.fake.claimsParamsV.claimTimeout + 10;
    await run(r, 90, 30);
    const order = fns(r, id).filter((f) => f === 'expireClaim' || f === 'markStale');
    expect(order).toEqual(['expireClaim', 'markStale']);
    expect(phase(r, id)).toBe('Expired');
    expect(r.fake.cases.get(id)!.state).toBe(CaseState.Stale);
    expect(await r.fake.openCases()).toBe(0);
    await run(r, 600, 60);
    expect(fns(r, id).filter((f) => f === 'markStale')).toHaveLength(1);
  });
});

describe('one-leg modes', () => {
  it('OutOnly: records the final ruling on Hedera instead of relaying it', async () => {
    const fake = new FakeChains();
    fake.mode = BridgeMode.OutOnly;
    const r = rig({ fake });
    const id = await toWatching(r);
    r.fake.rule(id, 3);
    await run(r, 30);
    const rec = r.fake.calls.find((c) => c.fn === 'recordRuling')!;
    expect(rec.chain).toBe('hedera');
    expect(rec.args).toEqual([id, r.fake.disputeOf(id), 3, 1]);
    expect(fns(r, id)).not.toContain('relayRuling');
    await run(r, 30);
    expect(phase(r, id)).toBe('Settled');
  });

  it('None: relays the claim from getClaim bytes, opens on the zero-id receive, records the ruling', async () => {
    const fake = new FakeChains();
    fake.mode = BridgeMode.None;
    const r = rig({ fake });
    const id = await toCourt(r);
    const relay = r.fake.calls.find((c) => c.fn === 'relayClaim')!;
    expect(relay.chain).toBe('arbitrum');
    expect(relay.args[0]).toBe(r.fake.payloadOf(id));
    await run(r, 60);
    expect(fns(r, id)).toContain('openCase');
    expect(r.fake.cases.get(id)!.state).toBe(CaseState.Opened);
    await run(r, 60);
    r.fake.rule(id, 1);
    await run(r, 60);
    expect(fns(r, id)).toContain('recordRuling');
    expect(fns(r, id)).not.toContain('resend');
    expect(phase(r, id)).toBe('Settled');
  });

  it('OutOnly: a final ruling past the claim timeout goes to recordRuling, not expiry', async () => {
    const fake = new FakeChains();
    fake.mode = BridgeMode.OutOnly;
    fake.claimsParamsV.claimTimeout = 3600;
    const r = rig({ fake });
    const id = await toWatching(r);
    r.fake.t = Number(r.fake.claims.get(id)!.preCheckedAt) + 3601;
    r.fake.rule(id, 1);
    await run(r, 60);
    expect(fns(r, id)).toContain('recordRuling');
    expect(fns(r, id)).not.toContain('expireClaim');
  });
});

describe('pause windows and operator control', () => {
  it('stops relayRuling from 30 min before a Hedera window while Arbitrum-bound calls go on', async () => {
    const fake = new FakeChains();
    const from = fake.t + 2000;
    const r = rig({ fake, keeper: { windows: [{ chain: 'hedera', from, to: from + 2400 }] } });
    const id = await toWatching(r, 1);
    const other = await toCourt(r, 2);
    expect(fns(r, other)).toEqual(['sendToCourt']);
    r.fake.rule(id, 1);
    await run(r, 60);
    expect(r.fake.t).toBeGreaterThanOrEqual(from - 1800);
    expect(fns(r, id)).not.toContain('relayRuling');

    r.fake.t = from + 60; // inside the window
    r.fake.deliver(other);
    await run(r, 60);
    expect(fns(r, other)).toContain('openCase');
    expect(fns(r, id)).not.toContain('relayRuling');

    r.fake.t = from + 2400;
    await r.k.tick();
    expect(fns(r, id)).toContain('relayRuling');
  });

  it('pauses Hedera sends inside the window and resumes them after it', async () => {
    const fake = new FakeChains();
    const from = fake.t + 60;
    const r = rig({ fake, keeper: { windows: [{ chain: 'hedera', from, to: from + 2400 }] } });
    const id = r.fake.file(1);
    await run(r, 90);
    r.fake.precheck(id);
    await run(r, 30);
    r.fake.contest(id);
    await run(r, 600, 60);
    expect(fns(r, id)).toEqual([]);
    r.fake.t = from + 2400;
    await r.k.tick();
    expect(fns(r, id)).toEqual(['sendToCourt']);
  });

  it('keeper-ctl pause stops every send; resume restarts them', async () => {
    const r = rig();
    const id = r.fake.file(1);
    await r.k.tick();
    r.fake.precheck(id);
    control(r, { paused: true });
    await run(r, 900, 60);
    expect(fns(r, id)).toEqual([]);
    control(r, { paused: false });
    await r.k.tick();
    expect(fns(r, id)).toEqual(['closeUncontested']);
  });

  it('a held claim gets no calls; the others go on', async () => {
    const r = rig();
    const a = r.fake.file(1);
    const b = r.fake.file(2);
    await r.k.tick();
    r.fake.precheck(a);
    r.fake.precheck(b);
    control(r, { holds: { [a]: Date.now() } });
    await run(r, 900, 60);
    expect(fns(r, a)).toEqual([]);
    expect(fns(r, b)).toEqual(['closeUncontested']);
  });

  it('a window added through the control file pauses sends', async () => {
    const r = rig();
    const id = r.fake.file(1);
    await r.k.tick();
    r.fake.precheck(id);
    const from = new Date((r.fake.t + 300) * 1000).toISOString();
    const to = new Date((r.fake.t + 3600) * 1000).toISOString();
    control(r, { windows: [`hedera@${from}/${to}`] });
    await run(r, 1200, 60);
    expect(fns(r, id)).toEqual([]);
    expect(r.k.health.windowsActive).toHaveLength(1);
  });
});

describe('open transactions', () => {
  it('alerts gas_low with the age when a transaction the node refuses for lack of funds blocks the key', async () => {
    const r = rig();
    const id = await toCourt(r);
    r.fake.intentStatusV = [
      { chain: 'hedera', call: 'resend', claimId: id, hash: `0x${'ee'.repeat(32)}`, nonce: 9, ageS: 200, rejections: 12, reason: 'funds', lastError: 'insufficient funds' },
    ];
    await r.k.tick();
    expect(kinds(r)).not.toContain('gas_low');
    r.fake.intentStatusV[0]!.ageS = 400;
    await r.k.tick();
    const a = r.alerter.pending().find((x) => x.kind === 'gas_low')!;
    expect(a.claimId).toBe(id);
    expect(a.detail).toMatchObject({ chain: 'hedera', call: 'resend', nonce: '9', ageS: '400' });
    expect(a.hint).toContain('insufficient funds');
  });

  it('asks the senders not to rebroadcast while paused or inside a window, and to go on otherwise', async () => {
    const fake = new FakeChains();
    const from = fake.t + 600;
    const r = rig({ fake, keeper: { windows: [{ chain: 'hedera', from, to: from + 600 }] } });
    const id = await toCourt(r);
    r.fake.open.add(`hedera:resend:${id}`);
    r.fake.open.add(`arbitrum:openCase:${id}`);
    await r.k.tick();
    expect(r.fake.rebroadcastAsked.get('hedera:resend')).toBe(true);
    control(r, { paused: true });
    await r.k.tick();
    expect(r.fake.rebroadcastAsked.get('hedera:resend')).toBe(false);
    expect(r.fake.rebroadcastAsked.get('arbitrum:openCase')).toBe(false);
    control(r, {});
    r.fake.t = from + 60;
    await r.k.tick();
    expect(r.fake.rebroadcastAsked.get('hedera:resend')).toBe(false);
    expect(r.fake.rebroadcastAsked.get('arbitrum:openCase')).toBe(true);
  });

  it('a submitEvidence that came back pending and then mined is not sent again', async () => {
    const r = rig();
    const id = await toCourt(r);
    let first = true;
    r.fake.overrides.set('submitEvidence', (): CallResult | undefined => {
      if (!first) return undefined;
      first = false;
      return { kind: 'pending', hash: `0x${'ab'.repeat(32)}` };
    });
    r.fake.deliver(id);
    await run(r, 60);
    expect(fns(r, id).filter((f) => f === 'submitEvidence')).toHaveLength(1);
    expect(phase(r, id)).toBe('Opened');
    // The transaction mines; its Evidence log is read only later (20 blocks behind).
    r.fake.settleNext = [{ chain: 'arbitrum', call: 'submitEvidence', claimId: id, hash: `0x${'ab'.repeat(32)}`, outcome: 'success' }];
    await run(r, 120);
    expect(fns(r, id).filter((f) => f === 'submitEvidence')).toHaveLength(1);
    expect(phase(r, id)).toBe('Watching');
    expect(r.k.book.claims.get(id)!.attempts[0]!.evidenceTx).toBe(`0x${'ab'.repeat(32)}`);
  });
});

describe('restart', () => {
  it('resumes from the journal: no repeated call, clocks from chain milestones', async () => {
    const fake = new FakeChains();
    const r1 = rig({ fake });
    const done = await toWatching(r1, 1);
    r1.fake.rule(done, 1);
    await run(r1, 30);
    r1.fake.arrive(done);
    await run(r1, 30);
    expect(phase(r1, done)).toBe('Settled');
    const live = await toWatching(r1, 2);
    const waiting = r1.fake.file(3);
    await r1.k.tick();
    r1.fake.precheck(waiting);
    await r1.k.tick();
    r1.journal.close();
    const before = fake.calls.length;

    // Down for 20 minutes: the contest window of claim 3 passes meanwhile.
    fake.t += 1200;
    const r2 = rig({ fake, dir: r1.dir });
    expect(fake.loaded).toEqual([]); // the senders get only intents with no result, and there are none
    expect(phase(r2, done)).toBe('Settled');
    expect(phase(r2, live)).toBe('Watching');
    expect(r2.k.book.evidenceText(live, 1)).toBeDefined();
    await r2.k.tick();
    const after = fake.calls.slice(before);
    expect(after.map((c) => c.fn)).toEqual(['closeUncontested']);
    expect(after[0]!.args[0]).toBe(waiting);
    expect(kinds(r2).filter((k) => k === 'withdraw_due')).toHaveLength(0);
  });

  it('ignores an event replayed by the source after a restart', async () => {
    const fake = new FakeChains();
    const r1 = rig({ fake });
    const id = await toCourt(r1);
    const sent = r1.k.book.claims.get(id)!.outbound.length;
    r1.journal.close();
    const r2 = rig({ fake, dir: r1.dir });
    const e = r2.k.book.claims.get(id)!;
    expect(e.outbound).toHaveLength(sent);
    await r2.k.tick();
    expect(r2.k.book.claims.get(id)!.outbound).toHaveLength(sent);
  });
});

describe('view and health', () => {
  it('reports the phase, links and last alert for a claim', async () => {
    const r = rig();
    const id = await toCourt(r);
    await run(r, 700, 60);
    const v = r.k.view(id)!;
    expect(v.phase).toBe('Sent');
    expect((v.outbound as { link: string }[])[0]!.link).toMatch(/^https:\/\/ccip\.chain\.link\/msg\/0x/);
    expect(v.lastAlert).toMatchObject({ kind: 'outbound_slow' });
    expect(r.k.health.claimsByPhase).toEqual({ Sent: 1 });
    expect(r.k.health.levels?.feePool).toBeDefined();
  });
});
