import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256 } from 'viem';
import { POLICY, carOf, rawCidOf, validateTemplate } from '../src/index.js';
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
});

describe('content ids', () => {
  it('computes a raw-block CIDv1 (checked against multiformats for the policy file)', () => {
    expect(POLICY.cid).toBe('bafkreiczyufqa6mwis3riitqeiz6cozbk6zpgyx5xy3rpm4usqedje45im');
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
