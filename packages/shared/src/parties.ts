// Party map: who is who on both chains. The file is `deployments/parties.json`, a JSON array with
// one object per party; services find it through the PARTIES_FILE env var and read it only through
// `readParties()` (Node) or `parseParties()` (anywhere).

import { getAddress, isAddress, type Address } from 'viem';

export const PARTY_ROLES = [
  'deployer',
  'ops-hedera',
  'ops-arb',
  'precheck-signer',
  'platform',
  'agent',
  'shop',
  'scheme',
  'buyer',
  'facilitator',
] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];

/** Roles that hold a Hedera account (every role except the Arbitrum-only ops key). */
export const HEDERA_ROLES = [
  'deployer',
  'ops-hedera',
  'precheck-signer',
  'platform',
  'agent',
  'shop',
  'scheme',
  'buyer',
  'facilitator',
] as const satisfies readonly PartyRole[];
export type HederaRole = (typeof HEDERA_ROLES)[number];

export interface Party {
  role: PartyRole;
  /** EIP-55 checksummed. */
  evmAddress: Address;
  /**
   * `shard.realm.num`, e.g. `0.0.12345`. Absent while the role has no Hedera account (ops-arb never
   * has one). Read it with `hederaAccountIdOf`, which names the role when it is missing.
   */
  hederaAccountId?: string;
  /** Hedera accounts whose HCS messages count as this party's records. May be empty. */
  hcsWriters: string[];
  /** ERC-8004 agent id as a decimal string; omitted when the party has none. */
  agentId?: string;
  /** Fictional name shown on pages. */
  displayName: string;
}

export type Parties = Party[];

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const ACCOUNT_ID = /^\d+\.\d+\.\d+$/;
const DECIMAL = /^(0|[1-9]\d*)$/;

export function isHederaAccountId(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNT_ID.test(value);
}

function isRole(value: unknown): value is PartyRole {
  return typeof value === 'string' && (PARTY_ROLES as readonly string[]).includes(value);
}

const PARTY_KEYS = new Set(['role', 'evmAddress', 'hederaAccountId', 'hcsWriters', 'agentId', 'displayName']);

/**
 * Validates the parsed contents of parties.json. Pure: takes the JSON value (not text) and
 * returns either the normalised party list or the first problem found. A Hedera account may be an
 * HCS writer of one party only: a shared writer would let one party's messages count as another's
 * records.
 */
export function parseParties(json: unknown): ParseResult<Parties> {
  if (!Array.isArray(json)) return { ok: false, error: 'parties: expected a JSON array' };
  const out: Parties = [];
  const seenAddress = new Set<string>();
  const writerOf = new Map<string, number>();
  for (let i = 0; i < json.length; i++) {
    const entry: unknown = json[i];
    const at = `parties[${i}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, error: `${at}: expected an object` };
    }
    const e = entry as Record<string, unknown>;
    for (const key of Object.keys(e)) {
      if (!PARTY_KEYS.has(key)) return { ok: false, error: `${at}: unknown field ${key}` };
    }
    if (!isRole(e.role)) return { ok: false, error: `${at}.role: not a known role` };
    if (typeof e.evmAddress !== 'string' || !isAddress(e.evmAddress, { strict: false })) {
      return { ok: false, error: `${at}.evmAddress: not an EVM address` };
    }
    const evmAddress = getAddress(e.evmAddress);
    if (seenAddress.has(evmAddress)) return { ok: false, error: `${at}.evmAddress: duplicate address` };
    seenAddress.add(evmAddress);

    let hederaAccountId: string | undefined;
    if (e.hederaAccountId !== undefined) {
      if (!isHederaAccountId(e.hederaAccountId)) {
        return { ok: false, error: `${at}.hederaAccountId: expected shard.realm.num` };
      }
      hederaAccountId = e.hederaAccountId;
    }

    if (!Array.isArray(e.hcsWriters) || !e.hcsWriters.every(isHederaAccountId)) {
      return { ok: false, error: `${at}.hcsWriters: expected a list of shard.realm.num ids` };
    }
    for (const w of e.hcsWriters as string[]) {
      const other = writerOf.get(w);
      if (other !== undefined && other !== i) {
        return { ok: false, error: `${at}.hcsWriters: ${w} is already a writer of parties[${other}]` };
      }
      writerOf.set(w, i);
    }

    let agentId: string | undefined;
    if (e.agentId !== undefined) {
      if (typeof e.agentId === 'number' && Number.isSafeInteger(e.agentId) && e.agentId >= 0) {
        agentId = String(e.agentId);
      } else if (typeof e.agentId === 'string' && DECIMAL.test(e.agentId)) {
        agentId = e.agentId;
      } else {
        return { ok: false, error: `${at}.agentId: expected a non-negative integer` };
      }
    }

    if (typeof e.displayName !== 'string' || e.displayName.trim() === '') {
      return { ok: false, error: `${at}.displayName: expected a non-empty string` };
    }

    const party: Party = { role: e.role, evmAddress, hcsWriters: [...e.hcsWriters], displayName: e.displayName };
    if (hederaAccountId !== undefined) party.hederaAccountId = hederaAccountId;
    if (agentId !== undefined) party.agentId = agentId;
    out.push(party);
  }
  return { ok: true, value: out };
}

export function partiesByRole(parties: Parties, role: PartyRole): Party[] {
  return parties.filter((p) => p.role === role);
}

/**
 * The env var that names a process's own party when several parties share its role, as the demo
 * cast's shops and agent companies (platform plus agent) do beside the first ones.
 */
export const PARTY_SELECTORS = {
  shop: 'RECOURSE_SHOP_ADDRESS',
  platform: 'RECOURSE_PLATFORM_ADDRESS',
  agent: 'RECOURSE_AGENT_ADDRESS',
} as const satisfies Partial<Record<PartyRole, string>>;

/**
 * The party with this role. When `env` sets the role's selector (PARTY_SELECTORS), the party of
 * that role at that address, or an error naming the variable; otherwise the single party with the
 * role, and an error when there is none or more than one. With one party of the role and no
 * selector set, nothing changes.
 */
export function partyByRole(parties: Parties, role: PartyRole, env: Record<string, string | undefined> = {}): Party {
  const selector = (PARTY_SELECTORS as Partial<Record<PartyRole, string>>)[role];
  const wanted = selector === undefined ? undefined : env[selector]?.trim();
  if (wanted) {
    if (!isAddress(wanted, { strict: false })) throw new Error(`${selector}: not an EVM address`);
    const p = partyWithRole(parties, role, wanted);
    if (!p) throw new Error(`${selector}: no ${role} at ${getAddress(wanted)} in the party map`);
    return p;
  }
  const found = partiesByRole(parties, role);
  if (found.length > 1 && selector !== undefined) {
    throw new Error(`parties: ${found.length} parties are ${role}; set ${selector} to this one's address`);
  }
  if (found.length !== 1) throw new Error(`parties: expected exactly one ${role}, found ${found.length}`);
  return found[0]!;
}

/** The party's Hedera account id; throws, naming the role, when the role has none yet. */
export function hederaAccountIdOf(party: Party): string {
  if (party.hederaAccountId === undefined) throw new Error(`parties: ${party.role} has no hederaAccountId`);
  return party.hederaAccountId;
}

export function partyByAddress(parties: Parties, address: string): Party | undefined {
  if (!isAddress(address, { strict: false })) return undefined;
  const a = getAddress(address);
  return parties.find((p) => p.evmAddress === a);
}

/**
 * Hedera accounts allowed to pay for the HCS message of a record kind (0-5) for some order: the
 * writers of every party with the role. The packed record (kind 4) belongs to shops; every other
 * kind belongs to platforms (their agent pays). To judge one order's records, use
 * `orderWritersFor`, which takes only that order's own shop or platform.
 */
export function hcsWritersFor(parties: Parties, kind: number): Set<string> {
  const role: PartyRole = kind === 4 ? 'shop' : 'platform';
  const set = new Set<string>();
  for (const p of partiesByRole(parties, role)) for (const w of p.hcsWriters) set.add(w);
  return set;
}

/** The two parties an order or claim names, by EVM address (as ClaimFiled carries them). */
export interface OrderParties {
  platform: string;
  shop: string;
}

/**
 * The party at `address` when it has `role`, else undefined (unknown address, or a party with
 * another role).
 */
export function partyWithRole(parties: Parties, role: PartyRole, address: string): Party | undefined {
  const p = partyByAddress(parties, address);
  return p !== undefined && p.role === role ? p : undefined;
}

/**
 * Hedera accounts allowed to pay for one order's record of a kind: the hcsWriters of the order's
 * own shop for packed (kind 4), of its own platform for every other kind. Another platform's or
 * shop's writer never counts. Empty when the named address is not a party of that role.
 */
export function orderWritersFor(parties: Parties, kind: number, order: OrderParties): Set<string> {
  const p = kind === 4 ? partyWithRole(parties, 'shop', order.shop) : partyWithRole(parties, 'platform', order.platform);
  return new Set(p?.hcsWriters ?? []);
}

/** Hedera account ids by role; a role without an account is absent. */
export type HederaAccountIds = Partial<Record<HederaRole, string>>;

/**
 * Parses HEDERA_ACCOUNT_IDS: comma-separated `<role>=0.0.N` pairs. Each Hedera role appears at most
 * once; a role that has no account yet is left out. Unknown roles and malformed ids are errors.
 */
export function parseHederaAccountIds(text: string): ParseResult<HederaAccountIds> {
  const out: HederaAccountIds = {};
  for (const raw of text.split(',')) {
    const pair = raw.trim();
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    if (eq < 0) return { ok: false, error: 'HEDERA_ACCOUNT_IDS: expected role=0.0.N pairs' };
    const role = pair.slice(0, eq).trim();
    const id = pair.slice(eq + 1).trim();
    if (!(HEDERA_ROLES as readonly string[]).includes(role)) {
      return { ok: false, error: `HEDERA_ACCOUNT_IDS: unknown role ${role}` };
    }
    if (!isHederaAccountId(id)) return { ok: false, error: `HEDERA_ACCOUNT_IDS: bad account id for ${role}` };
    if (out[role as HederaRole] !== undefined) return { ok: false, error: `HEDERA_ACCOUNT_IDS: ${role} twice` };
    out[role as HederaRole] = id;
  }
  return { ok: true, value: out };
}

/** The account id of `role`; throws, naming the role, when HEDERA_ACCOUNT_IDS has none for it. */
export function accountIdOf(ids: HederaAccountIds, role: HederaRole): string {
  const id = ids[role];
  if (id === undefined) throw new Error(`HEDERA_ACCOUNT_IDS: no account id for ${role}`);
  return id;
}
