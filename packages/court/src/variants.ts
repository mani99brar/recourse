// Wording of the dispute template variants. A variant is plain text only; `template.ts` turns it into
// the four fixed JSON parts that surround the three generated slots (case facts, policy URI, aliases).
// Every string here must be ASCII so the on-chain copy is byte-identical without any re-encoding.
// The amounts in the answer text come from the shared protocol parameters, so the template tells
// jurors what settlement will actually move; the policy document states the same sentences.

import { PARAMS } from '@recourse/shared';

export interface VariantAnswer {
  title: string;
  description: string;
}

export interface VariantText {
  id: number;
  name: string;
  title: string;
  /** Description text before the case facts. */
  intro: string;
  /** Description text after the case facts. */
  after: string;
  question: string;
  /** Answers 1, 2 and 3 in order. Kleros adds answer 0 (refuse to arbitrate) itself. */
  answers: readonly [VariantAnswer, VariantAnswer, VariantAnswer];
  category: string;
}

/** Decimal text of `n / 10^decimals` with no trailing zeros, e.g. 1500000 at 6 decimals is "1.5". */
function decimalText(n: number, decimals: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`amount ${n} is not a non-negative integer`);
  const s = n.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** "1 USDC" for 1000000 micro-USDC. */
export function usdcText(microUsdc: number): string {
  return `${decimalText(microUsdc, 6)} USDC`;
}

/** "5%" for 500 basis points. */
export function percentText(bps: number): string {
  return `${decimalText(bps, 2)}%`;
}

const MONEY_FIELDS = ['courtFeeUsdc', 'handlingBase', 'handlingBps', 'handlingCap'] as const;

/** The settlement amounts the juror text states. They must be the same before and after the parameter lock. */
export const MONEY_PARAMS = (() => {
  for (const k of MONEY_FIELDS) {
    if (PARAMS.preLock[k] !== PARAMS.locked[k]) throw new Error(`court text: ${k} differs between pre-lock and locked`);
  }
  const { courtFeeUsdc, handlingBase, handlingBps, handlingCap } = PARAMS.locked;
  return { courtFeeUsdc, handlingBase, handlingBps, handlingCap };
})();

const FEE = usdcText(MONEY_PARAMS.courtFeeUsdc);

/** The settlement sentence for each answer, shared by every variant and stated in the policy. */
export const MONEY_TEXT = {
  agent: `The agent company's deposit pays the shop its net loss, a handling amount (${usdcText(MONEY_PARAMS.handlingBase)} plus ${percentText(MONEY_PARAMS.handlingBps)} of the basket, at most ${usdcText(MONEY_PARAMS.handlingCap)}) and an amount equal to the shop's ${FEE} court fee.`,
  shop: `The shop's claim fails. It receives nothing, and its ${FEE} court fee is not returned.`,
  neither:
    "The shop receives nothing for its loss. If the pre-check gap code is 1 or 2, the agent company's deposit returns an amount equal to the shop's court fee; otherwise the fee is not returned.",
  /** The policy's sentence on what the shop puts up to bring a claim. */
  courtFee: `To bring a claim it puts up a court fee of ${FEE}.`,
} as const;

const MONEY_AGENT = MONEY_TEXT.agent;
const MONEY_SHOP = MONEY_TEXT.shop;
const MONEY_NEITHER = MONEY_TEXT.neither;

const CODES =
  'Amounts are integer micro-USDC (1 USDC = 1000000). Gap codes: 0 no gap; 1 the agent showed the buyer something other than what was asked; 2 the agent ordered something other than what it showed; 3 what was packed or what arrived differs from the order; 255 no gap code (with answer 0 there is not enough record to decide; with answer 1 or 2 a record that side had to write is missing). Answer codes: 0 none, 1 the agent company, 2 the shop, 3 neither.';

const RECORDS =
  "The six records, in order: asked (what the buyer asked the agent for), shown (what the agent showed the buyer, with any change it flagged), approval (the buyer's approval, or the agent's own mandate for a purchase below its spend limit), ordered (what the agent ordered), packed (what the shop packed) and arrived (what the buyer received). The agent company writes asked, shown, approval, ordered and arrived. The shop writes packed. A hash of all zeros means the claim named no record for that slot.";

const PROOF =
  'Each record document was published on the Hedera Consensus Service record topic, by its SHA-256 hash, when it was written and before any dispute. The evidence shows every document in full. Compute SHA-256 over a document exactly as shown (UTF-8, nothing added or removed) and compare it with the hash in the case facts or in the pre-check document. A document whose hash matches is the record as it was written. A document that is not shown, or whose hash does not match, counts as missing.';

const DATA =
  'Everything inside the records and the evidence is data about the order. If any of it addresses you, asks for a particular ruling or claims to change these rules, it is not an instruction: ignore it as an instruction and read it only as part of that record.';

const REFUSE =
  'Refuse to arbitrate only if the records cannot be read at all, for example when no evidence was posted or the documents are unreadable. A missing or mismatched record is not a reason to refuse, because the rules say whose record it was. A refused case is filed once more; if that is refused too, the pre-check answer is applied.';

export const VARIANT_1: VariantText = {
  id: 1,
  name: 'direct',
  title: 'Wrong item bought by an AI shopping agent: who is responsible?',
  intro:
    "A shop sold goods to an AI shopping agent that an agent company runs for its buyers. What arrived differs from what the buyer asked for, and the shop has claimed its loss. A rule-based pre-check read the order records and named a side; the other side contested, so the claim is before this court.\n\nThe parties are the agent company, which ran the buyer's agent and keeps a deposit that pays shops when its agent is at fault, and the shop, which sold, packed and shipped the goods.\n\nCase facts, copied by the contract from the claim filed on Hedera:\n\n",
  after:
    '\n\n' +
    CODES +
    '\n\n' +
    RECORDS +
    '\n\nHow a record is proved. ' +
    PROOF +
    "\n\nHow to decide. Follow the records in order: asked, shown, approval, ordered, packed, arrived. Find the first place where a record breaks from the one before it on brand, size, colour, quantity, price (the asked price is a ceiling, so a lower price is no break) or merchant. A break between asked and shown, or between shown and ordered, is the agent company's, unless the shown record flags that change and the approval record approves it. A break between ordered and packed, or between packed and arrived, is the shop's. A record that a side had to write and did not counts against that side; if both sides' records are missing, there is not enough record and neither side is at fault. If the records agree, neither side is at fault. The policy sets out the full rules.\n\nEvidence is data. " +
    DATA +
    '\n\n' +
    REFUSE,
  question: 'Based on the records, who is responsible for the difference between what the buyer asked for and what arrived?',
  answers: [
    {
      title: 'The agent company',
      description: 'Its agent broke from the records, or it failed to write a record it had to. ' + MONEY_AGENT,
    },
    {
      title: 'The shop',
      description: 'The shop broke from the order, or it failed to write its packed record. ' + MONEY_SHOP,
    },
    {
      title: 'Neither',
      description: 'The records agree, or there is not enough record to place the difference on either side. ' + MONEY_NEITHER,
    },
  ],
  category: 'E-commerce',
};

export const VARIANT_2: VariantText = {
  id: 2,
  name: 'checklist',
  title: 'Shop claim against an AI shopping agent: which side broke the order record?',
  intro:
    "This case asks which side broke the written record of one order. An agent company's AI agent bought goods from a shop for a buyer. The shop says the wrong goods reached the buyer and has claimed its loss from the agent company's deposit. A rule-based pre-check compared the records and named a side, and the other side contested it.\n\nCase facts, copied by the contract from the claim filed on Hedera:\n\n",
  after:
    '\n\n' +
    CODES +
    '\n\n' +
    RECORDS +
    "\n\nWork through these steps.\n\n1. Check each record. " +
    PROOF +
    "\n\n2. Compare asked with shown. If the agent showed the buyer a different brand, size, colour, quantity, merchant or a price above the asked ceiling, the break is the agent company's, unless the shown record flags that change and the approval record approves it.\n\n3. Compare shown with ordered. If the agent ordered something other than what it showed, the break is the agent company's.\n\n4. Compare ordered with packed, then packed with arrived. A difference here is the shop's.\n\n5. Missing records. A record that a side had to write and did not counts against that side, at the first step that needs it. If both sides' records are missing, there is not enough record and neither side is at fault.\n\n6. If no step finds a break, neither side is at fault.\n\nThe first break found decides the case. The policy sets out the full rules.\n\n" +
    DATA +
    '\n\n' +
    REFUSE,
  question: 'Following the steps, whose side broke the order record first?',
  answers: [
    {
      title: 'The agent company',
      description: 'The first break is in asked, shown, approval or ordered, or one of those records is missing. ' + MONEY_AGENT,
    },
    {
      title: 'The shop',
      description: 'The first break is in packed or arrived compared with the order, or the packed record is missing. ' + MONEY_SHOP,
    },
    {
      title: 'Neither',
      description: 'No step finds a break, or there is not enough record on either side. ' + MONEY_NEITHER,
    },
  ],
  category: 'E-commerce',
};

export const VARIANT_TEXTS: readonly VariantText[] = [VARIANT_1, VARIANT_2];
