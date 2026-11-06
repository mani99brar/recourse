// `@recourse/renderer`: the text a buyer reads before an order is placed, and the hash an approval
// signs. `render` is pure and synchronous: no clock, randomness, locale, environment, network or
// model. The same input gives byte-identical text in Node and in the browser, so any page can
// re-render a request and check its hash.
//
// The change slot lists every attribute of the offer that departs from the request, using the same
// comparison as the fault rule: values are compared trimmed and lower-cased, and the asked price is
// a cap, so only an offered price above it counts as a change.
//
// An approval signs the text's hash, and the records keep the raw values, so `render` refuses an
// asked or offered value the text would not show as given (see `shownAsGiven`) with an
// UnshowableValueError, which a caller can record as its refusal.

import { ATTRIBUTES, compareDecimal, normalise, parsePrice, sha256, utf8ToBytes, type Attribute, type Attrs } from '@recourse/shared';

/** `0x`-prefixed hex, as the shared helpers return it. */
export type Hex = `0x${string}`;

/** Bumped on any change to the wording or layout of the text. */
export const RENDERER_VERSION = '1';

/** Shown in place of a value that is missing, empty or not a string. */
export const ABSENT = '(not stated)';

/** Longest value shown, in code points; longer values are cut and end with an ellipsis. */
export const MAX_VALUE_CHARS = 120;

export interface RenderInput {
  orderId: Hex;
  /** What the buyer asked for (the request record). Its price is the most the buyer will pay. */
  asked: Attrs;
  /** What the shop offers. Its price is never read: the price shown comes from `amount` and `asset`. */
  offer: Omit<Attrs, 'price'>;
  /** Amount from the payment request, in the asset's smallest unit, as a decimal string. */
  amount: string;
  /** Asset id from the payment request. */
  asset: string;
  /** Hedera account the payment goes to, from the payment request. */
  payTo: string;
  /** Payment network, e.g. `hedera:testnet`. */
  network: string;
}

export interface Rendered {
  text: string;
  /** SHA-256 of the UTF-8 bytes of `text`. */
  textHash: Hex;
  changeSlot: 'filled' | 'empty';
  /** Departing attributes, in attribute order; the shown record's `changes`. */
  changes: Attribute[];
  /** The attributes as shown: the offer, with the price taken from the payment request. */
  shownAttrs: Attrs;
  rendererVersion: string;
}

const ASSETS: Record<string, { symbol: string; decimals: number }> = {
  '0.0.429274': { symbol: 'USDC', decimals: 6 },
  '0.0.0': { symbol: 'HBAR', decimals: 8 },
};

const LABELS: Record<Attribute, string> = {
  brand: 'Brand',
  size: 'Size',
  colour: 'Colour',
  quantity: 'Quantity',
  price: 'Price',
  merchant: 'Merchant',
};

/**
 * Formats an integer amount of smallest units as a decimal with at least two decimal places,
 * e.g. 42000000 with 6 decimals -> "42.00", 42123456 -> "42.123456". Throws on a non-integer.
 */
export function formatUnits(amount: string, decimals: number): string {
  if (!/^(0|[1-9]\d*)$/.test(amount)) throw new RangeError(`render: amount must be a non-negative integer string, got ${JSON.stringify(amount)}`);
  const padded = amount.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  let frac = padded.slice(padded.length - decimals).replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(Math.min(2, decimals), '0');
  return frac === '' ? whole : `${whole}.${frac}`;
}

/** The price text shown for a payment request amount, e.g. "42.00 USDC". */
export function priceText(amount: string, asset: string): string {
  const known = ASSETS[asset];
  if (!known) return `${formatUnits(amount, 0)} units of ${clean(asset)}`;
  return `${formatUnits(amount, known.decimals)} ${known.symbol}`;
}

// Line breaks become spaces; other control characters, bidirectional controls and invisible marks
// become U+FFFD. A value can then never start a new line or reorder the text around it.
const BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]/gu;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/gu;

/** A value as shown: NFC, unsafe characters replaced, runs of spaces collapsed, length capped. */
export function clean(value: string): string {
  const text = value.normalize('NFC').replace(BREAKS, ' ').replace(UNSAFE, '\ufffd').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(text);
  if (chars.length <= MAX_VALUE_CHARS) return text;
  return `${chars.slice(0, MAX_VALUE_CHARS - 1).join('').trimEnd()}\u2026`;
}

function valueOf(attrs: Attrs, attribute: Attribute): string | undefined {
  const raw = (attrs as Record<string, unknown>)[attribute];
  if (typeof raw !== 'string') return undefined;
  return normalise(raw) === '' ? undefined : raw;
}

/** What `render` throws for an asked or offered value it would not show as given. Never quotes the value. */
export class UnshowableValueError extends RangeError {
  constructor(
    readonly section: 'asked' | 'offer',
    readonly attribute: Attribute,
  ) {
    super(
      `render: the ${section} ${attribute} cannot be shown as given (line breaks, control or invisible characters, repeated spaces, or over ${MAX_VALUE_CHARS} characters)`,
    );
    this.name = 'UnshowableValueError';
  }
}

/**
 * Throws on a value that `clean` would change beyond trimming its ends: a line break, control or
 * invisible character, a run of spaces, a form that is not NFC, or more than MAX_VALUE_CHARS. Two
 * such values could show as the same text and so give the same hash, while the records keep them
 * apart. The ends are free: the fault rule trims them too.
 */
function shownAsGiven(section: 'asked' | 'offer', attrs: Attrs, attributes: readonly Attribute[]): void {
  for (const attribute of attributes) {
    const v = valueOf(attrs, attribute);
    if (v !== undefined && clean(v) !== v.trim()) throw new UnshowableValueError(section, attribute);
  }
}

/** Whether the offered value departs from the asked one; only when both are present. */
export function departs(attribute: Attribute, asked: string, offered: string): boolean {
  const a = normalise(asked);
  const o = normalise(offered);
  if (attribute === 'price') {
    const pa = parsePrice(a);
    const po = parsePrice(o);
    if (pa !== null && po !== null) return compareDecimal(po, pa) > 0;
  }
  return a !== o;
}

/** A value in quotes, so the reader can see where it starts and ends; the absent marker unquoted. */
function show(value: string | undefined): string {
  return value === undefined ? ABSENT : `"${clean(value)}"`;
}

export function render(input: RenderInput): Rendered {
  shownAsGiven('asked', input.asked, ATTRIBUTES);
  // The offer's price is never read.
  shownAsGiven('offer', input.offer as Attrs, ATTRIBUTES.filter((a) => a !== 'price'));
  const price = priceText(input.amount, input.asset);
  const shownAttrs: Attrs = {};
  for (const attribute of ATTRIBUTES) {
    if (attribute === 'price') {
      shownAttrs.price = price;
      continue;
    }
    const v = valueOf(input.offer as Attrs, attribute);
    if (v !== undefined) shownAttrs[attribute] = v;
  }

  const changes: Attribute[] = [];
  for (const attribute of ATTRIBUTES) {
    const asked = valueOf(input.asked, attribute);
    const offered = valueOf(shownAttrs, attribute);
    if (asked !== undefined && offered !== undefined && departs(attribute, asked, offered)) changes.push(attribute);
  }

  const lines: string[] = [];
  lines.push('Order approval');
  lines.push(`Order: ${clean(input.orderId)}`);
  lines.push(`You pay: ${price} to ${clean(input.payTo)} on ${clean(input.network)}`);
  lines.push('');
  lines.push('You asked for:');
  for (const attribute of ATTRIBUTES) {
    const value = show(valueOf(input.asked, attribute));
    const label = attribute === 'price' && value !== ABSENT ? `${LABELS.price} (most you will pay)` : LABELS[attribute];
    lines.push(`  ${label}: ${value}`);
  }
  lines.push('');
  lines.push('This order:');
  for (const attribute of ATTRIBUTES) lines.push(`  ${LABELS[attribute]}: ${show(valueOf(shownAttrs, attribute))}`);
  lines.push('');
  if (changes.length === 0) {
    lines.push('Changes from your request: none');
  } else {
    lines.push(`Changes from your request: ${changes.length}`);
    for (const attribute of changes) {
      const asked = show(valueOf(input.asked, attribute));
      const offered = show(valueOf(shownAttrs, attribute));
      const verb = attribute === 'price' ? `asked at most ${asked}, now ${offered}` : `asked ${asked}, now ${offered}`;
      lines.push(`  ${LABELS[attribute]}: ${verb}`);
    }
  }
  lines.push('');
  lines.push(`Renderer version ${RENDERER_VERSION}`);

  const text = `${lines.join('\n')}\n`.normalize('NFC');
  return {
    text,
    textHash: sha256(utf8ToBytes(text)),
    changeSlot: changes.length > 0 ? 'filled' : 'empty',
    changes,
    shownAttrs,
    rendererVersion: RENDERER_VERSION,
  };
}
