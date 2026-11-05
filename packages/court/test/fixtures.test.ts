import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256 } from 'viem';
import { PARAMS } from '@recourse/shared';
import {
  MONEY_PARAMS,
  MONEY_TEXT,
  POLICY,
  VARIANT_TEXTS,
  carOf,
  percentText,
  rawCidOf,
  usdcText,
  validateTemplate,
} from '../src/index.js';
import { TRIAL_CASES, buildTrialCase, trialEvidence } from '../src/trial.js';
import { PACKAGE_ROOT, staleFixtures } from '../scripts/fixtures.js';

describe('policy', () => {
  it('matches the POLICY record byte for byte', () => {
    const bytes = new Uint8Array(readFileSync(join(PACKAGE_ROOT, POLICY.path)));
    expect(bytes.length).toBe(POLICY.size);
    expect(sha256(bytes)).toBe(POLICY.sha256);
    expect(rawCidOf(bytes)).toBe(POLICY.cid);
    expect(POLICY.uri).toBe(`/ipfs/${POLICY.cid}`);
    expect(new TextDecoder().decode(bytes)).toMatch(/^[\x09\x0a\x20-\x7e]*$/);
  });

  it('states the settlement amounts in the same sentences as the template, and no other amount', () => {
    const text = readFileSync(join(PACKAGE_ROOT, POLICY.path), 'utf8');
    const row = text.split('\n').find((l) => l.startsWith('| 1, the agent company |'));
    expect(row).toBe(`| 1, the agent company | ${MONEY_TEXT.agent} |`);
    expect(text).toContain(MONEY_TEXT.courtFee);
    // Once the derived sentences and the unit definition are taken out, no USDC amount is left.
    const rest = text
      .replace(MONEY_TEXT.agent, '')
      .replace(MONEY_TEXT.courtFee, '')
      .replace('1 USDC is 1000000', '');
    expect(rest.match(/\d[\d.,]*\s*USDC/g) ?? []).toEqual([]);
  });
});

describe('money text', () => {
  it('reads the amounts from the shared parameters', () => {
    expect(MONEY_PARAMS).toEqual({
      courtFeeUsdc: PARAMS.locked.courtFeeUsdc,
      handlingBase: PARAMS.locked.handlingBase,
      handlingBps: PARAMS.locked.handlingBps,
      handlingCap: PARAMS.locked.handlingCap,
    });
    const fee = usdcText(PARAMS.locked.courtFeeUsdc);
    expect(MONEY_TEXT.agent).toContain(
      `(${usdcText(PARAMS.locked.handlingBase)} plus ${percentText(PARAMS.locked.handlingBps)} of the basket, at most ${usdcText(PARAMS.locked.handlingCap)})`,
    );
    expect(MONEY_TEXT.agent).toContain(`the shop's ${fee} court fee.`);
    expect(MONEY_TEXT.shop).toContain(`its ${fee} court fee`);
    for (const v of VARIANT_TEXTS) {
      const answers = v.answers.map((a) => a.description);
      expect(answers[0]!.endsWith(MONEY_TEXT.agent)).toBe(true);
      expect(answers[1]!.endsWith(MONEY_TEXT.shop)).toBe(true);
      expect(answers[2]!.endsWith(MONEY_TEXT.neither)).toBe(true);
    }
  });

  it('formats micro-USDC and basis points as short decimals', () => {
    expect(usdcText(1_000_000)).toBe('1 USDC');
    expect(usdcText(4_000_000)).toBe('4 USDC');
    expect(usdcText(1_500_000)).toBe('1.5 USDC');
    expect(usdcText(250_000)).toBe('0.25 USDC');
    expect(usdcText(40_000_000)).toBe('40 USDC');
    expect(usdcText(1)).toBe('0.000001 USDC');
    expect(usdcText(0)).toBe('0 USDC');
    expect(percentText(500)).toBe('5%');
    expect(percentText(250)).toBe('2.5%');
    expect(percentText(1)).toBe('0.01%');
    expect(() => usdcText(1.5)).toThrow();
    expect(() => usdcText(-1)).toThrow();
  });
});

describe('content ids', () => {
  it('computes a raw-block CIDv1 (checked against multiformats for the policy file)', () => {
    expect(POLICY.cid).toBe('bafkreic67vs35ez3kfgiuqzneqhf4w53pi23ydqsaccj265lakinfeug5y');
    expect(rawCidOf(new TextEncoder().encode('hello'))).toBe('bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq');
  });

  it('writes a one-block CAR whose block is the document', () => {
    const bytes = new TextEncoder().encode('hello');
    const car = carOf(bytes);
    expect(Buffer.from(car.subarray(car.length - bytes.length)).toString()).toBe('hello');
    // header length varint, then the DAG-CBOR map {roots, version}
    expect(car[0]).toBe(car.length - bytes.length - 36 - 2);
    expect(car[1]).toBe(0xa2);
  });
});

describe('trial cases', () => {
  it('fixture files on disk are current', () => {
    expect(staleFixtures()).toEqual([]);
  });

  it('each case yields the ruling it is written to test and a valid template', () => {
    for (const def of TRIAL_CASES) {
      const b = buildTrialCase(def, POLICY.uri);
      const expected = def.expectRuling;
      expect(b.precheck.result.answer, def.id).toBe(expected);
      const r = validateTemplate(b.template);
      expect(r.ok, def.id).toBe(true);
      const ev = trialEvidence(b, 42n);
      expect(ev.slots.every((s) => s.state === 'held')).toBe(true);
      expect(ev.byteLength).toBeLessThan(16 * 1024);
    }
  });

  it('includes one red-team case whose record asks the juror for a ruling', () => {
    const red = TRIAL_CASES.find((c) => c.id === 't3')!;
    expect(red.records.packed.note).toMatch(/NOTICE TO THE JUROR/);
    expect(red.expectRuling).toBe(3);
  });
});
