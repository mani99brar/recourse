import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ATTRIBUTES, canonicalBytes, ruleSlotFromDoc, sha256, utf8ToBytes, type CanonicalValue } from '@recourse/shared';
import { ABSENT, MAX_VALUE_CHARS, RENDERER_VERSION, clean, departs, formatUnits, priceText, render, type RenderInput } from '../src/index.js';
import { FIXTURES } from './fixtures.js';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const expected = JSON.parse(readFileSync(here('./golden/expected.json'), 'utf8')) as {
  rendererVersion: string;
  fixtures: Record<string, { textHash: string; changeSlot: string; changes: string[] }>;
};

const base: RenderInput = FIXTURES['no-change']!;

describe('golden text', () => {
  it('matches the stored text and hashes for this renderer version', () => {
    // A wording change must bump RENDERER_VERSION and regenerate the golden files.
    expect(RENDERER_VERSION).toBe(expected.rendererVersion);
    for (const [name, input] of Object.entries(FIXTURES)) {
      const r = render(input);
      expect(r.text, name).toBe(readFileSync(here(`./golden/${name}.txt`), 'utf8'));
      expect(r.textHash, name).toBe(expected.fixtures[name]!.textHash);
      expect(r.changeSlot, name).toBe(expected.fixtures[name]!.changeSlot);
      expect(r.changes, name).toEqual(expected.fixtures[name]!.changes);
      expect(r.rendererVersion).toBe(RENDERER_VERSION);
    }
  });

  it('hashes the UTF-8 bytes of the text', () => {
    for (const input of Object.values(FIXTURES)) {
      const r = render(input);
      expect(r.textHash).toBe(sha256(utf8ToBytes(r.text)));
      expect(r.text.normalize('NFC')).toBe(r.text);
      expect(r.text).not.toContain('\r');
      expect(r.text.endsWith('\n')).toBe(true);
    }
  });
});

describe('determinism', () => {
  it('gives the same hash for the same input 1,000 times, with fresh copies of the input', () => {
    for (const [name, input] of Object.entries(FIXTURES)) {
      const first = render(input).textHash;
      for (let i = 0; i < 1000; i++) {
        expect(render(structuredClone(input)).textHash, name).toBe(first);
      }
    }
  });

  it('gives the same hashes in a separate process', () => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', here('./render-child.ts')], {
      cwd: here('..'),
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', LANG: 'tr_TR.UTF-8', TZ: 'Pacific/Chatham' },
    });
    const child = JSON.parse(out) as Record<string, string>;
    for (const name of Object.keys(FIXTURES)) expect(child[name], name).toBe(expected.fixtures[name]!.textHash);
  });

  it('does not depend on the key order of the input objects', () => {
    const reversed = (o: object) => Object.fromEntries(Object.entries(o).reverse());
    for (const input of Object.values(FIXTURES)) {
      const shuffled = { ...input, asked: reversed(input.asked), offer: reversed(input.offer) } as RenderInput;
      expect(render(shuffled).textHash).toBe(render(input).textHash);
    }
  });
});

describe('layout', () => {
  it('lists the six attributes in fixed order in both sections', () => {
    const lines = render(base).text.split('\n');
    const labels = ['Brand', 'Size', 'Colour', 'Quantity', 'Price', 'Merchant'];
    const asked = lines.slice(lines.indexOf('You asked for:') + 1, lines.indexOf('You asked for:') + 7);
    const order = lines.slice(lines.indexOf('This order:') + 1, lines.indexOf('This order:') + 7);
    expect(asked.map((l) => l.trim().split(/[ :]/)[0])).toEqual(labels);
    expect(order.map((l) => l.trim().split(/[ :]/)[0])).toEqual(labels);
    expect(ATTRIBUTES).toEqual(['brand', 'size', 'colour', 'quantity', 'price', 'merchant']);
  });

  it('shows the absent marker for every missing value, never dropping a line', () => {
    const r = render({ ...base, asked: {}, offer: {} });
    expect(r.text.split('\n').filter((l) => l.endsWith(`: ${ABSENT}`))).toHaveLength(11);
    expect(r.changeSlot).toBe('empty');
  });

  it('takes the price from the payment request, never from the offer', () => {
    const r = render({ ...base, offer: { ...base.offer, price: '1.00' } as RenderInput['offer'] });
    expect(r.shownAttrs.price).toBe('42.00 USDC');
    expect(r.text).toContain('Price: "42.00 USDC"');
    expect(r.text).not.toContain('"1.00"');
  });

  it('keeps hostile values on one line and visibly marked', () => {
    const r = render(FIXTURES.hostile!);
    expect(r.text.split('\n')).toHaveLength(render(base).text.split('\n').length + 2);
    expect(r.text).not.toMatch(/[‪-‮​\u0000-\u0009\u000b-\u001f]/u);
    expect(clean('a\r\nb\tc')).toBe('a b c');
    expect(Array.from(clean('x'.repeat(500)))).toHaveLength(MAX_VALUE_CHARS);
    expect(clean('Café')).toBe('Café');
  });
});

describe('change slot', () => {
  const offerWith = (patch: Partial<RenderInput['offer']>) => ({ ...base, offer: { ...base.offer, ...patch } });

  it('is filled iff an attribute departs from the request, and names each one', () => {
    expect(render(base).changeSlot).toBe('empty');
    expect(render(offerWith({ colour: 'Red' })).changes).toEqual(['colour']);
    expect(render(offerWith({ quantity: '2', brand: 'Southwind' })).changes).toEqual(['brand', 'quantity']);
    expect(render(offerWith({ size: '  M ' })).changeSlot).toBe('empty');
    // An attribute missing on either side is not compared.
    expect(render({ ...base, offer: { brand: 'Northwind' } }).changeSlot).toBe('empty');
    expect(render({ ...base, asked: { brand: 'Northwind' }, offer: { ...base.offer, size: 'XL' } }).changeSlot).toBe('empty');
  });

  it('counts the price only above the asked cap', () => {
    const at = (amount: string, cap = '42.00') => render({ ...base, amount, asked: { ...base.asked, price: cap } });
    expect(at('42000000').changeSlot).toBe('empty');
    expect(at('41990000').changeSlot).toBe('empty');
    expect(at('42000001').changes).toEqual(['price']);
    expect(at('42010000', '42.01 usdc').changeSlot).toBe('empty');
    expect(at('1200000000', '1,200').changeSlot).toBe('empty');
    // An asked price that does not parse is compared as text.
    expect(at('42000000', 'cheap').changes).toEqual(['price']);
    expect(departs('price', '40', '40.000 USDC')).toBe(false);
    expect(departs('size', 'M', 'm')).toBe(false);
  });

  it('gives a shown record the fault rule accepts', () => {
    for (const input of Object.values(FIXTURES)) {
      const r = render(input);
      const doc = canonicalBytes({
        v: '1',
        kind: 'shown',
        orderId: input.orderId,
        attrs: r.shownAttrs as Record<string, CanonicalValue>,
        changes: r.changes,
      });
      const slot = ruleSlotFromDoc(1, doc, input.orderId);
      expect(slot.ok).toBe(true);
      if (slot.ok && slot.key === 'shown') expect(slot.slot.changes).toEqual(r.changes);
    }
  });
});

describe('amounts', () => {
  it('formats smallest units exactly', () => {
    expect(formatUnits('0', 6)).toBe('0.00');
    expect(formatUnits('5', 6)).toBe('0.000005');
    expect(formatUnits('42000000', 6)).toBe('42.00');
    expect(formatUnits('42123456', 6)).toBe('42.123456');
    expect(formatUnits('123456789012345678901234567890', 6)).toBe('123456789012345678901234.56789');
    expect(formatUnits('7', 0)).toBe('7');
    expect(() => formatUnits('-1', 6)).toThrow();
    expect(() => formatUnits('1.5', 6)).toThrow();
    expect(() => formatUnits('01', 6)).toThrow();
    expect(priceText('10000000', '0.0.0')).toBe('0.10 HBAR');
    expect(priceText('3', '0.0.777')).toBe('3 units of 0.0.777');
  });
});
