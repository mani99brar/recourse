import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeClaimToCourt, tryDecodeClaimToCourt, type ClaimToCourt } from '@recourse/shared';
import {
  POLICY,
  TEMPLATE_VARIANTS,
  aliasesOf,
  buildTemplate,
  buildTemplateFromPayload,
  factsOf,
  fieldsOf,
  templateParts,
  validateTemplate,
} from '../src/index.js';
import { PACKAGE_ROOT } from '../scripts/fixtures.js';

const codec = JSON.parse(readFileSync(join(PACKAGE_ROOT, '..', 'shared', 'vectors', 'codec.json'), 'utf8')) as {
  claimToCourt: { name: string; encoded: `0x${string}` }[];
};

function decode(payload: `0x${string}`): ClaimToCourt {
  const d = tryDecodeClaimToCourt(payload);
  if (d.status !== 0) throw new Error('vector does not decode');
  return d.value;
}

describe('template variants', () => {
  it('has variants 1 and 2 with four ASCII parts and no mustache tags', () => {
    expect(TEMPLATE_VARIANTS.map((v) => v.id)).toEqual([1, 2]);
    for (const v of TEMPLATE_VARIANTS) {
      expect(v.parts).toHaveLength(4);
      for (const p of v.parts) {
        expect(p).toMatch(/^[\x20-\x7e]*$/);
        expect(p).not.toContain('{{');
        expect(p).not.toContain('}}');
      }
    }
  });

  it('throws for an unknown variant', () => {
    expect(() => templateParts(3)).toThrow(RangeError);
  });

  it('passes SDK validation for every variant and every codec vector', () => {
    for (const v of TEMPLATE_VARIANTS) {
      for (const c of codec.claimToCourt) {
        const t = buildTemplateFromPayload(c.encoded, v.parts, POLICY.uri);
        const r = validateTemplate(t);
        expect(r.ok, `${v.name} / ${c.name}: ${r.ok ? '' : r.errors.join('; ')}`).toBe(true);
      }
    }
  });

  it('states the question, money per answer, the hash proof, evidence-as-data and the refusal rule', () => {
    for (const v of TEMPLATE_VARIANTS) {
      const t = buildTemplateFromPayload(codec.claimToCourt[0]!.encoded, v.parts, POLICY.uri);
      const r = validateTemplate(t);
      if (!r.ok) throw new Error(r.errors.join('; '));
      const d = r.details;
      expect(d.question.length).toBeGreaterThan(20);
      expect(d.answers.map((a) => a.title)).toEqual(['Refuse to Arbitrate / Invalid', 'The agent company', 'The shop', 'Neither']);
      expect(d.answers[1]!.description).toMatch(/deposit pays the shop its net loss/);
      expect(d.answers[2]!.description).toMatch(/receives nothing/);
      expect(d.answers[3]!.description).toMatch(/gap code is 1 or 2/);
      expect(d.description).toMatch(/SHA-256/);
      expect(d.description).toMatch(/is not an instruction/);
      expect(d.description).toMatch(/Refuse to arbitrate only if the records cannot be read/);
      expect(d.policyURI).toBe(POLICY.uri);
      expect(d.arbitratorChainID).toBe('421614');
      expect(d.aliases).toEqual({ 'Agent company': expect.any(String), Shop: expect.any(String) });
    }
  });

  it('builds the same bytes for both attempts and puts only payload facts in the slots', () => {
    const c = decode(codec.claimToCourt[0]!.encoded);
    const parts = templateParts(1);
    expect(buildTemplate(fieldsOf(c), parts, POLICY.uri)).toBe(buildTemplate(fieldsOf({ ...c }), parts, POLICY.uri));
    const facts = factsOf(c);
    expect(facts).toContain(c.claimId.toLowerCase());
    expect(facts).toContain(`- Basket paid: ${c.basketUsdc} micro-USDC`);
    expect(facts).toContain(c.refs.hashes[5]!.toLowerCase());
    for (const h of facts.match(/0x[0-9a-fA-F]+/g) ?? []) expect(h).toBe(h.toLowerCase());
    expect(facts).not.toContain('"');
    expect(aliasesOf(c)).toBe(`"Agent company":"${c.platform.toLowerCase()}","Shop":"${c.shop.toLowerCase()}"`);
  });

  it('keeps variants different only in their parts', () => {
    const payload = codec.claimToCourt[0]!.encoded;
    const [a, b] = TEMPLATE_VARIANTS.map((v) => buildTemplateFromPayload(payload, v.parts, POLICY.uri));
    const f = fieldsOf(decode(payload));
    for (const t of [a!, b!]) {
      expect(t).toContain(f.facts);
      expect(t).toContain(f.aliases);
    }
    expect(a).not.toBe(b);
  });

  it('rejects an https policy, a mustache tag and a missing alias', () => {
    const c = decode(codec.claimToCourt[0]!.encoded);
    const parts = templateParts(1);
    expect(validateTemplate(buildTemplate(fieldsOf(c), parts, 'https://example.org/policy.md')).ok).toBe(false);
    expect(validateTemplate(buildTemplate({ ...fieldsOf(c), facts: '{{x}}' }, parts, POLICY.uri)).ok).toBe(false);
    expect(validateTemplate(buildTemplate({ ...fieldsOf(c), aliases: `"Shop":"${c.shop}"` }, parts, POLICY.uri)).ok).toBe(false);
  });

  it('fails to build from a payload that does not decode', () => {
    const bad = encodeClaimToCourt(decode(codec.claimToCourt[0]!.encoded)).slice(0, -2) as `0x${string}`;
    expect(() => buildTemplateFromPayload(bad, templateParts(1), POLICY.uri)).toThrow(/does not decode/);
  });
});
