// Kleros dispute template for a Recourse claim.
//
// A template is four fixed text parts around three generated slots, in this order:
//   part0 + FACTS + part1 + POLICY_URI + part2 + ALIASES + part3
// FACTS and ALIASES are generated from the ClaimToCourt payload only, so both court attempts of one
// claim register the same bytes. The contract builds the same string in `previewTemplate`; any
// change to the slot formats below must be made in both places (a golden-file test pins them).
// There are no mustache tags and no data mappings: the template is final as registered.

import { tryDecodeClaimToCourt, DecodeStatus, type ClaimToCourt } from '@recourse/shared';
import type { Hex } from 'viem';
import { VARIANT_TEXTS, type VariantText } from './variants.js';

/** Template tag passed to the DisputeTemplateRegistry. */
export const TEMPLATE_TAG = 'recourse-v1';
/** Kleros arbitrator on Arbitrum Sepolia (KlerosCore proxy), lowercase as written into templates. */
export const ARBITRATOR_ADDRESS = '0xe8442307d36e9bf6ab27f1a009f95ce8e11c3479';
export const ARBITRATOR_CHAIN_ID = '421614';
export const TEMPLATE_VERSION = '1.0';
export const TEMPLATE_SPECIFICATION = 'recourse-v1';

/** The two-character JSON escape for a newline, as it appears inside a JSON string. */
const NL = '\\n';

export type TemplateParts = readonly [string, string, string, string];

export interface TemplateVariant {
  id: number;
  name: string;
  parts: TemplateParts;
}

/** Template slot values, already formatted. */
export interface TemplateFields {
  facts: string;
  aliases: string;
}

function json(s: string): string {
  return JSON.stringify(s);
}

/** The four parts of a variant. Parts are JSON fragments; a slot sits between each pair. */
export function partsOf(v: VariantText): TemplateParts {
  const answers = v.answers.map((a, i) => ({ id: `0x${i + 1}`, title: a.title, description: a.description }));
  const intro = json(v.intro);
  const after = json(v.after);
  const part0 = `{"title":${json(v.title)},"description":${intro.slice(0, -1)}`;
  const part1 = `${after.slice(1)},"question":${json(v.question)},"answers":${JSON.stringify(answers)},"policyURI":"`;
  const part2 =
    `","arbitratorChainID":"${ARBITRATOR_CHAIN_ID}","arbitratorAddress":"${ARBITRATOR_ADDRESS}",` +
    `"category":${json(v.category)},"lang":"en_US","specification":"${TEMPLATE_SPECIFICATION}","aliases":{`;
  const part3 = `},"version":"${TEMPLATE_VERSION}"}`;
  return [part0, part1, part2, part3];
}

export const TEMPLATE_VARIANTS: readonly TemplateVariant[] = VARIANT_TEXTS.map((v) => ({
  id: v.id,
  name: v.name,
  parts: partsOf(v),
}));

/** The four parts for a variant id (1 or 2). Throws for an unknown id. */
export function templateParts(variantId: number): TemplateParts {
  const v = TEMPLATE_VARIANTS.find((x) => x.id === variantId);
  if (v === undefined) throw new RangeError(`templateParts: unknown variant ${variantId}`);
  return v.parts;
}

function addr(a: string): string {
  return a.toLowerCase();
}

function h32(h: Hex): string {
  return h.toLowerCase();
}

const KIND_LABELS = ['asked (I)', 'shown (S)', 'approval (A)', 'ordered (O)', 'packed (D)', 'arrived (R)'] as const;

/**
 * FACTS slot: Markdown list lines joined by JSON-escaped newlines. Addresses and hashes are lowercase
 * 0x hex, integers are plain decimal. The contract writes exactly these bytes.
 */
export function factsOf(c: ClaimToCourt): string {
  const lines = [
    `- Claim id: ${h32(c.claimId)}`,
    `- Agent company (platform): ${addr(c.platform)}`,
    `- Shop: ${addr(c.shop)}`,
    `- Pre-check gap code: ${c.gap}`,
    `- Pre-check answer code: ${c.answer}`,
    `- Basket paid: ${c.basketUsdc} micro-USDC`,
    `- Net loss claimed: ${c.netLossUsdc} micro-USDC`,
    `- Filed at: ${c.filedAt} (unix seconds)`,
    `- Pre-check document SHA-256: ${h32(c.packHash)}`,
    `- Record topic: HCS 0.0.${c.refs.topicNum}`,
    `- Records (kind: HCS sequence number, SHA-256):`,
  ];
  for (let k = 0; k < 6; k++) {
    lines.push(`  - ${KIND_LABELS[k]}: ${c.refs.seq[k]}, ${h32(c.refs.hashes[k]!)}`);
  }
  return lines.join(NL);
}

/** ALIASES slot: the members of the `aliases` object. */
export function aliasesOf(c: ClaimToCourt): string {
  return `"Agent company":"${addr(c.platform)}","Shop":"${addr(c.shop)}"`;
}

export function fieldsOf(c: ClaimToCourt): TemplateFields {
  return { facts: factsOf(c), aliases: aliasesOf(c) };
}

/** Joins parts and slots. `policyURI` must be `/ipfs/<cid>`. */
export function buildTemplate(fields: TemplateFields, parts: TemplateParts, policyURI: string): string {
  return parts[0] + fields.facts + parts[1] + policyURI + parts[2] + fields.aliases + parts[3];
}

/** Decodes a ClaimToCourt payload and builds its template, as the contract's `previewTemplate` does. */
export function buildTemplateFromPayload(payload: Hex, parts: TemplateParts, policyURI: string): string {
  const d = tryDecodeClaimToCourt(payload);
  if (d.status !== DecodeStatus.Ok) throw new Error(`buildTemplateFromPayload: payload does not decode (status ${d.status})`);
  return buildTemplate(fieldsOf(d.value), parts, policyURI);
}
