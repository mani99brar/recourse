// Template validation with the Kleros SDK. The court UI renders a template with the SDK's
// `populateTemplate` (mustache, then the DisputeDetails schema), so a template that passes here is one
// the court can display. Node only when called: the SDK's CommonJS modules are loaded on first use, so
// importing this package in a browser bundle stays safe.

import { ARBITRATOR_ADDRESS, ARBITRATOR_CHAIN_ID } from './template.js';

interface SafeParse {
  safeParse(v: unknown): { success: true; data: unknown } | { success: false; error: { message: string } };
}

interface Sdk {
  populateTemplate: (template: string, data: Record<string, unknown>) => DisputeDetails;
  schema: SafeParse;
}

let sdk: Sdk | undefined;

function loadSdk(): Sdk {
  if (sdk !== undefined) return sdk;
  const nodeModule = globalThis.process?.getBuiltinModule?.('node:module') as typeof import('node:module') | undefined;
  if (nodeModule === undefined) throw new Error('validateTemplate: needs Node (22.3 or later)');
  const require = nodeModule.createRequire(import.meta.url);
  const { populateTemplate } = require('@kleros/kleros-sdk/lib/src/dataMappings/utils/populateTemplate.js') as Pick<
    Sdk,
    'populateTemplate'
  >;
  const schema = (require('@kleros/kleros-sdk/lib/src/dataMappings/utils/disputeDetailsSchema.js') as { default: SafeParse })
    .default;
  sdk = { populateTemplate, schema };
  return sdk;
}

export interface DisputeDetails {
  title: string;
  description: string;
  question: string;
  answers: { id: string; title: string; description: string; reserved?: boolean }[];
  policyURI: string;
  arbitratorChainID: string;
  arbitratorAddress: string;
  aliases?: Record<string, string>;
  version: string;
  [k: string]: unknown;
}

export type ValidationResult = { ok: true; details: DisputeDetails } | { ok: false; errors: string[] };

const POLICY_URI = /^\/ipfs\/[a-z2-7]{50,}$|^\/ipfs\/Qm[1-9A-HJ-NP-Za-km-z]{44}$/;

/**
 * Checks template bytes as the court would read them, plus the rules this project adds: no mustache
 * tags, ASCII only, `/ipfs/` policy, the Arbitrum Sepolia arbitrator, exactly answers 1-3 (the SDK adds
 * answer 0), and both parties named in `aliases`.
 */
export function validateTemplate(template: string): ValidationResult {
  const { populateTemplate, schema: DisputeDetailsSchema } = loadSdk();
  const errors: string[] = [];
  if (template.includes('{{') || template.includes('}}')) errors.push('template holds a mustache tag');
  if (!/^[\x20-\x7e]*$/.test(template)) errors.push('template is not printable ASCII');

  let raw: unknown;
  try {
    raw = JSON.parse(template);
  } catch (e) {
    return { ok: false, errors: [...errors, `not JSON: ${(e as Error).message}`] };
  }
  const schema = DisputeDetailsSchema.safeParse(raw);
  if (!schema.success) errors.push(`schema: ${schema.error.message}`);

  let details: DisputeDetails | undefined;
  try {
    details = populateTemplate(template, {});
  } catch (e) {
    errors.push(`populateTemplate: ${(e as Error).message}`);
  }
  if (details !== undefined) {
    if (!POLICY_URI.test(details.policyURI)) errors.push('policyURI is not /ipfs/<cid>');
    if (details.arbitratorChainID !== ARBITRATOR_CHAIN_ID) errors.push('arbitratorChainID is not "421614"');
    if (details.arbitratorAddress.toLowerCase() !== ARBITRATOR_ADDRESS) errors.push('arbitratorAddress is not KlerosCore');
    const ids = details.answers.map((a) => a.id);
    if (ids.join(',') !== '0x0,0x1,0x2,0x3') errors.push(`answers are ${ids.join(',')}, expected 0x0 (added),0x1,0x2,0x3`);
    const aliases = details.aliases ?? {};
    if (Object.keys(aliases).length !== 2) errors.push('aliases must name exactly the two parties');
  }
  return errors.length === 0 && details !== undefined ? { ok: true, details } : { ok: false, errors };
}
