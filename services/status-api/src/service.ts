// The read model behind the HTTP endpoints. Everything is computed from the store plus cached
// live reads; nothing here writes to a chain, a topic or a file.

import {
  ClaimStatus,
  PARAMS,
  RECORD_KEYS,
  addressBook,
  deriveStatus,
  externalIdUint,
  hcsWritersFor,
  orderWritersFor,
  partyByAddress,
  partiesByRole,
  sideOf,
  type Answer,
  type OrderParties,
  type Parties,
  type Party,
  type StatusKey,
} from '@recourse/shared';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import type { Config } from './config.js';
import type { Deployments } from './deployments.js';
import { getJson, HttpError, type FetchLike } from './http.js';
import type { DocFetcher } from './ipfs.js';
import {
  bridgeViewsOf,
  caseViewOf,
  foldClaim,
  isTerminal,
  liveParamsOf,
  moneyOf,
  type FoldedClaim,
  type Money,
} from './join.js';
import { ChainRevert, classify, type ClaimTerms } from './chain.js';
import { LastGood, within } from './lastgood.js';
import { TtlCache, type CaseParams, type ClaimsParams, type ConfigLocks, type ContractFacts, type PartyViews, type Reader, type VaultParams } from './live.js';
import type { LiveState, Store } from './store.js';
import type { HcsRecord, IndexedEvent, SourceName } from './types.js';

const ZERO32 = '0x' + '00'.repeat(32);
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const PERIODS = ['evidence', 'commit', 'vote', 'appeal', 'execution'] as const;
const CASE_STATES = ['none', 'received', 'opened', 'refile_pending', 'ruled', 'relayed', 'stale'] as const;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export interface ServiceDeps {
  store: Store;
  cfg: Config;
  deployments: Deployments;
  reader: Reader | null;
  parties: () => Parties | null;
  docs: DocFetcher;
  fetch: FetchLike;
  nowS: () => number;
}

interface LiveParamBundle {
  claims: ClaimsParams;
  kase: CaseParams;
  vault: VaultParams | null;
  defaulted: boolean;
}

export interface RecordInfo {
  kind: number;
  key: string;
  seq: number;
  payer: string | null;
  payerOk: boolean;
  hash: Hex | null;
  cid: string | null;
  /** True: verified. False: absent or failed a check. Null: could not be checked yet. */
  held: boolean | null;
  hashOk: boolean | null;
  /** The HCS hash equals the claim's recorded reference for this kind. */
  refsMatch: boolean;
  doc: unknown | null;
  /**
   * No message was found because the topic has not been read far enough yet (the referenced
   * sequence number is past the indexer's cursor, or the topic source never caught up or is
   * failing); `held` is then null, not false.
   */
  unread: boolean;
}

/** A live read served from its last good value: which one, the RPCs it reads, and how old the value is (null: none read yet). */
export interface StaleRead {
  read: 'params' | 'facts' | 'vault' | 'live';
  upstreams: ('hedera_rpc' | 'arbitrum_rpc')[];
  readAt: number | null;
  ageS: number | null;
}

export class StatusService {
  // Each live read keeps its last good value: a request waits on a read at most cfg.readWaitMs.
  /** The claims and vault parameters (Hedera). */
  private hederaParams: LastGood<{ claims: ClaimsParams; vault: VaultParams | null }>;
  /** The case parameters (Arbitrum). */
  private caseParams: LastGood<CaseParams>;
  /** The vault views by address: only known parties and the parties of indexed claims are read. */
  private partyViews: LastGood<PartyViews>;
  private facts$: LastGood<ContractFacts>;
  private ext = new TtlCache<unknown>(10_000);
  private locks: { flags: ConfigLocks | null; at: number; pending: Promise<void> | null } = { flags: null, at: -Infinity, pending: null };
  private hcsOrder: { size: number; map: Map<string, HcsRecord[]> } = { size: -1, map: new Map() };
  /** Claim terms by claim id: fixed at filing, so kept for good once read. */
  private terms = new Map<string, ClaimTerms>();
  private termsTried = new Map<string, number>();
  /** The claims contract reverted a `claimTermsOf`: it predates per-claim terms, so none is asked again. */
  private termsUnsupported = false;

  constructor(readonly d: ServiceDeps) {
    const o = { freshMs: d.cfg.viewCacheMs, waitMs: d.cfg.readWaitMs, nowS: d.nowS };
    this.hederaParams = new LastGood(o);
    this.caseParams = new LastGood(o);
    this.partyViews = new LastGood(o);
    this.facts$ = new LastGood(o);
  }

  private nowBig(): bigint {
    return BigInt(this.d.nowS());
  }

  // ------------------------------------------------------------------ params and sources

  private static hederaParamsOf(r: Reader) {
    return async () => {
      const [claims, vault] = await Promise.all([r.claimsParams(), r.vaultParams().catch(() => null)]);
      return { claims, vault };
    };
  }

  /**
   * The live parameters, each half (Hedera, Arbitrum) its last good read when a read fails or is
   * late; the defaults before any read (`defaulted`).
   */
  async liveParams(): Promise<LiveParamBundle> {
    const r = this.d.reader;
    const [h, k] = r
      ? await Promise.all([this.hederaParams.get('p', StatusService.hederaParamsOf(r)), this.caseParams.get('p', () => r.caseParams())])
      : [null, null];
    const p = PARAMS.preLock;
    return {
      claims: h?.value?.claims ?? {
        contestWindow: BigInt(p.contestWindow),
        claimTimeout: BigInt(p.claimTimeout),
        courtFeeUsdc: BigInt(p.courtFeeUsdc),
        handlingBase: BigInt(p.handlingBase),
        handlingBps: BigInt(p.handlingBps),
        handlingCap: BigInt(p.handlingCap),
        resendGap: BigInt(p.resendGap),
        maxSends: p.maxSends,
      },
      kase: k?.value ?? { caseDeadline: BigInt(p.caseDeadline), maxOpenCases: p.maxOpenCases, resendGap: BigInt(p.resendGap), maxSends: p.maxSends },
      vault: h?.value?.vault ?? null,
      defaulted: !h?.value || !k?.value,
    };
  }

  /**
   * Reads the live parameters once, in the background: started at boot, so a fresh start is not
   * reported degraded (`params`) until the first request happens to read them. A failed read leaves
   * it degraded, as it should be; the next read tries again.
   */
  warmParams(): Promise<void> {
    const r = this.d.reader;
    if (!r) return Promise.resolve();
    return Promise.all([this.hederaParams.refresh('p', StatusService.hederaParamsOf(r)), this.caseParams.refresh('p', () => r.caseParams())]).then(() => undefined);
  }

  /**
   * Reads, in the background, every live value a request may wait on: the parameters, the
   * contract facts, the config locks and the vault views of the known platforms and shops and of
   * the parties of indexed claims. Run at start-up and then on a timer (main.ts), so requests are
   * served from these reads rather than waiting on the relay. A read already running is not
   * started again; one that fails is tried at the next run.
   */
  warm(): Promise<void> {
    const r = this.d.reader;
    if (!r) return Promise.resolve();
    void this.configLock();
    const parties = new Set<Address>();
    for (const p of this.d.parties() ?? []) if (p.role === 'platform' || p.role === 'shop') parties.add(getAddress(p.evmAddress));
    for (const id of this.d.store.claimIds()) {
      const c = this.foldOf(id);
      if (c) parties.add(c.shop).add(c.platform);
    }
    return Promise.all([
      this.warmParams(),
      this.facts$.refresh('f', () => r.facts()),
      ...[...parties].map((a) => this.partyViews.refresh(a, () => r.party(a))),
    ]).then(() => undefined);
  }

  private sourceConfigured(name: SourceName): boolean {
    const dep = this.d.deployments;
    if (name === 'hedera') return Boolean(dep.claims || dep.vault);
    if (name === 'arbitrum') return Boolean(dep.caseAddress);
    return this.d.cfg.recordsTopic !== '';
  }

  /** Sources whose data is late or whose last poll failed. */
  degraded(): string[] {
    const out: string[] = [];
    const now = this.d.nowS();
    for (const name of ['hedera', 'arbitrum', 'hcs'] as const) {
      if (!this.sourceConfigured(name)) continue;
      const st = this.d.store.status[name];
      const lag = st.indexedThrough === null ? null : now - st.indexedThrough;
      if (st.failing || lag === null || lag > this.d.cfg.lagWarnS[name]) out.push(name);
    }
    if (this.d.reader !== null) {
      const unread = this.hederaParams.peek('p').value === null || this.caseParams.peek('p').value === null;
      if ((unread && this.d.store.claimIds().length > 0) || this.hederaParams.behind() || this.caseParams.behind()) out.push('params');
      if (this.facts$.behind()) out.push('facts');
      if (this.partyViews.behind()) out.push('vault');
    }
    const lr = this.d.store.liveReads;
    if (lr.hedera.failing || lr.arbitrum.failing) out.push('live');
    return out;
  }

  /**
   * The live reads behind `degraded` (params, facts, vault, live) whose last read failed or was
   * not waited for: each answer carries the value read before, and this says how old it is.
   */
  stale(): StaleRead[] {
    const now = this.d.nowS();
    const out: StaleRead[] = [];
    const add = (read: StaleRead['read'], parts: [StaleRead['upstreams'][number], { readAt: number | null } | null][]) => {
      const behind = parts.filter((p): p is [StaleRead['upstreams'][number], { readAt: number | null }] => p[1] !== null);
      if (behind.length === 0) return;
      const ats = behind.map((p) => p[1].readAt);
      const readAt = ats.includes(null) ? null : Math.min(...(ats as number[]));
      out.push({ read, upstreams: behind.map((p) => p[0]), readAt, ageS: readAt === null ? null : now - readAt });
    };
    add('params', [['hedera_rpc', this.hederaParams.behind()], ['arbitrum_rpc', this.caseParams.behind()]]);
    // The facts read both chains in one go: a failure is not told apart by chain.
    const f = this.facts$.behind();
    add('facts', [['hedera_rpc', f], ['arbitrum_rpc', f]]);
    add('vault', [['hedera_rpc', this.partyViews.behind()]]);
    const lr = this.d.store.liveReads;
    add('live', [['hedera_rpc', lr.hedera.failing ? { readAt: lr.hedera.okAt } : null], ['arbitrum_rpc', lr.arbitrum.failing ? { readAt: lr.arbitrum.okAt } : null]]);
    return out;
  }

  /**
   * Whether the owner can still change the rules. Read at most once a minute, in the background
   * after the first read (a slow RPC never holds a response), and never again once all three
   * contracts are locked: `lockConfig` cannot be undone.
   */
  async configLock(): Promise<ConfigLockView> {
    const l = this.locks;
    const r = this.d.reader;
    if (!(l.flags && l.flags.claims && l.flags.vault && l.flags.case) && r && this.d.nowS() - l.at >= 60 && l.pending === null) {
      const at = this.d.nowS();
      l.pending = r
        .locks()
        .then((f) => {
          l.flags = f;
        })
        .catch(() => undefined)
        .finally(() => {
          l.at = at;
          l.pending = null;
        });
    }
    // Before the first read lands, a request waits on it a bounded time; then the "not read" notice stands.
    if (l.flags === null && l.pending) await within(l.pending, this.d.cfg.readWaitMs, undefined);
    return configLockView(l.flags);
  }

  asOf(): { hedera: number | null; arbitrum: number | null; hcs: number | null } {
    const s = this.d.store.status;
    return { hedera: s.hedera.indexedThrough, arbitrum: s.arbitrum.indexedThrough, hcs: s.hcs.indexedThrough };
  }

  health() {
    const now = this.d.nowS();
    const src = (name: SourceName) => {
      const st = this.d.store.status[name];
      return {
        configured: this.sourceConfigured(name),
        cursor: st.cursor,
        lagS: st.indexedThrough === null ? null : now - st.indexedThrough,
        headDistance: st.headDistance,
        lastError: st.lastError,
        lastErrorAt: st.lastErrorAt,
        decodeFailures: st.decodeFailures,
        ...(name === 'hcs' ? { foreignDropped: st.foreignDropped } : {}),
      };
    };
    return {
      rebuilding: this.d.store.rebuilding,
      sources: { hedera: src('hedera'), arbitrum: src('arbitrum'), hcs: src('hcs') },
      deployments: { files: this.d.deployments.files, local: this.d.deployments.local },
      parties: this.d.parties() !== null,
      reader: this.d.reader !== null,
      claims: this.d.store.claimIds().length,
      documents: this.d.docs.describe(),
    };
  }

  // ------------------------------------------------------------------ claims

  private foldOf(claimId: string): FoldedClaim | null {
    const c = foldClaim(this.d.store.eventsOf(claimId));
    // The contract's own preCheckedAt when read: the contest window and the timeout count from it.
    const chainAt = this.d.store.live.get(claimId)?.preCheckedAt;
    if (c && c.preChecked && chainAt !== undefined && chainAt > 0n) c.preCheckedAt = chainAt;
    return c;
  }

  private nameOf(a: Address): string | null {
    const ps = this.d.parties();
    return ps ? (partyByAddress(ps, a)?.displayName ?? null) : null;
  }

  /**
   * Reads each claim's own terms (contest window, timeout, handling; fixed at filing) once, at most
   * 20 a call and waiting at most `waitMs`; slower reads finish in the background. A failed read is
   * tried again after a minute; until a claim's terms are known, the current parameters stand in.
   */
  async loadTerms(ids: readonly string[], waitMs = 2_000): Promise<void> {
    const r = this.d.reader;
    if (!r || this.termsUnsupported) return;
    const now = this.d.nowS();
    const todo = ids.filter((id) => !this.terms.has(id) && now - (this.termsTried.get(id) ?? -Infinity) >= 60).slice(0, 20);
    if (todo.length === 0) return;
    for (const id of todo) this.termsTried.set(id, now);
    const all = Promise.all(
      todo.map(async (id) => {
        try {
          const t = await r.claimTerms(id as Hex);
          if (t.contestWindow > 0n && t.claimTimeout > 0n) this.terms.set(id, t);
        } catch (e) {
          // A revert: a claims contract from before per-claim terms, which checks every claim against
          // its current parameters, so those are exact. Anything else: read again later.
          if (classify(e, 'hedera') instanceof ChainRevert) this.termsUnsupported = true;
        }
      }),
    );
    await within(all, waitMs, undefined);
  }

  /** The parameters one claim runs under: its own contest window, timeout and handling once read. */
  private paramsFor(lp: LiveParamBundle, claimId: string): LiveParamBundle {
    const t = this.terms.get(claimId);
    if (!t) return lp;
    // A fixed handling H: handlingOf(basket) = min(H + 0, H) = H.
    return { ...lp, claims: { ...lp.claims, contestWindow: t.contestWindow, claimTimeout: t.claimTimeout, handlingBase: t.handling, handlingBps: 0n, handlingCap: t.handling } };
  }

  /**
   * True when the claim's Arbitrum case is not known to be current: Arbitrum is configured, no
   * `caseOf` read has succeeded within the Arbitrum lag limit, and the case events are failing,
   * not read through yet or late. A fresh store serves before Arbitrum has caught up, so "no case"
   * can then just mean "not read".
   */
  private caseLate(live: LiveState | undefined): boolean {
    if (!this.sourceConfigured('arbitrum')) return false;
    const now = this.d.nowS();
    const limit = this.d.cfg.lagWarnS.arbitrum;
    if (live?.caseReadAt !== undefined && now - live.caseReadAt <= limit) return false;
    const st = this.d.store.status.arbitrum;
    return st.failing || st.indexedThrough === null || now - st.indexedThrough > limit;
  }

  private statusOf(c: FoldedClaim, bundle: LiveParamBundle) {
    const lp = this.paramsFor(bundle, c.claimId);
    const events = this.d.store.eventsOf(c.claimId);
    const live = this.d.store.live.get(c.claimId);
    const caseView = caseViewOf(c, events, live);
    const bridge = bridgeViewsOf(c, live);
    const params = liveParamsOf(lp.claims, lp.kase, BigInt(PARAMS.locked.stuckAfter));
    const status = deriveStatus(
      { status: c.status, answer: c.answer, ruling: c.ruling, filedAt: c.filedAt, preCheckedAt: c.preCheckedAt, undrawn: false },
      caseView,
      bridge,
      params,
      this.nowBig(),
      { caseLate: this.caseLate(live) },
    );
    return { status, caseView, bridge };
  }

  private moneyFor(c: FoldedClaim, bundle: LiveParamBundle): Money {
    const lp = this.paramsFor(bundle, c.claimId);
    return moneyOf(
      c,
      {
        handlingBase: lp.claims.handlingBase,
        handlingBps: lp.claims.handlingBps,
        handlingCap: lp.claims.handlingCap,
        courtFeeUsdc: lp.claims.courtFeeUsdc,
        contestWindow: lp.claims.contestWindow,
      },
      this.nowBig(),
    );
  }

  private row(c: FoldedClaim, lp: LiveParamBundle) {
    const { status } = this.statusOf(c, lp);
    const m = this.moneyFor(c, lp);
    return {
      claimId: c.claimId,
      orderId: c.orderId,
      shop: c.shop,
      shopName: this.nameOf(c.shop),
      platform: c.platform,
      platformName: this.nameOf(c.platform),
      filedAt: c.filedAt,
      gap: c.preChecked ? c.gap : null,
      answer: c.preChecked ? c.answer : null,
      statusKey: status.statusKey,
      nextActor: status.nextActor,
      nextCall: status.nextCall,
      deadline: status.deadline,
      findingSide: c.preChecked ? sideOf(c.answer as Answer) : null,
      basketUsdc: c.basketUsdc,
      netLossUsdc: c.netLossUsdc,
      owed: m.owed,
      paid: m.paid,
      credited: m.credited,
      notCovered: m.notCovered,
      escrow: m.escrow,
      updatedAt: c.updatedAt,
    };
  }

  async claimRows(filter: { party?: Address; status?: string } = {}) {
    const [lp] = await Promise.all([this.liveParams(), this.loadTerms(this.d.store.claimIds())]);
    const rows = [];
    for (const id of this.d.store.claimIds()) {
      const c = this.foldOf(id);
      if (!c) continue;
      if (filter.party && c.shop !== filter.party && c.platform !== filter.party) continue;
      const r = this.row(c, lp);
      if (filter.status && r.statusKey !== filter.status) continue;
      rows.push(r);
    }
    rows.sort((a, b) => (a.updatedAt === b.updatedAt ? (a.claimId < b.claimId ? -1 : 1) : a.updatedAt > b.updatedAt ? -1 : 1));
    return rows;
  }

  async claimsResponse(party?: string, status?: string) {
    if (status !== undefined && !(STATUS_SET as ReadonlySet<string>).has(status)) throw new ApiError(400, 'bad_id');
    if (party === undefined) return { rows: await this.claimRows(status ? { status } : {}) };
    if (!isAddress(party, { strict: false })) throw new ApiError(400, 'bad_id');
    const addr = getAddress(party);
    const [rows, standing] = await Promise.all([this.claimRows({ party: addr, ...(status ? { status } : {}) }), this.partyBlock(addr)]);
    const groups = {
      waitingOnYou: [] as string[],
      waitingOnOther: [] as string[],
      openToAnyone: [] as string[],
      owedToYou: [] as string[],
      finished: [] as string[],
    };
    const credit = standing.credit ?? 0n;
    for (const r of rows) {
      const role = r.shop === addr ? 'shop' : 'platform';
      const terminal = TERMINAL_KEYS.has(r.statusKey) || (r.statusKey === 'unresolved' && r.nextActor === 'none');
      if (terminal) {
        if (role === 'shop' && credit > 0n && r.nextCall === 'withdrawCredit') groups.waitingOnYou.push(r.claimId);
        else groups.finished.push(r.claimId);
        continue;
      }
      if (r.nextActor === role) groups.waitingOnYou.push(r.claimId);
      else if (r.nextActor === 'anyone') {
        groups.openToAnyone.push(r.claimId);
        if (role === 'shop' && r.owed !== null && r.owed > 0n) groups.owedToYou.push(r.claimId);
      } else groups.waitingOnOther.push(r.claimId);
    }
    return { standing, groups, rows };
  }

  // ------------------------------------------------------------------ records

  private ordersIndex(): Map<string, HcsRecord[]> {
    const h = this.d.store.hcs;
    if (this.hcsOrder.size !== h.size) {
      const map = new Map<string, HcsRecord[]>();
      for (const r of h.values()) {
        const list = map.get(r.orderId);
        if (list) list.push(r);
        else map.set(r.orderId, [r]);
      }
      this.hcsOrder = { size: h.size, map };
    }
    return this.hcsOrder.map;
  }

  private topicId(num: bigint): string {
    const prefix = this.d.cfg.recordsTopic.split('.').slice(0, 2).join('.') || '0.0';
    return `${prefix}.${num}`;
  }

  /**
   * One record of an order. With `order` (the platform and shop the claim names), only that
   * platform's or shop's own hcsWriters count as payers, as in the pre-check; without it (an order
   * with no claim yet), a writer of any party of the role does.
   */
  async recordInfo(orderId: Hex, kind: number, ref?: { topicNum: bigint; seq: bigint; hash: Hex }, order?: OrderParties): Promise<RecordInfo> {
    const key = RECORD_KEYS[kind] ?? 'unknown';
    const parties = this.d.parties();
    const writers = parties === null ? null : order ? orderWritersFor(parties, kind, order) : hcsWritersFor(parties, kind);
    const store = this.d.store;
    let msg: HcsRecord | undefined;
    // True when the topic has not been read far enough to say whether the message exists.
    let unread = false;
    if (ref && ref.seq > 0n) {
      const topic = this.topicId(ref.topicNum);
      msg = store.hcs.get(`${topic}:${ref.seq}`);
      if (msg && (msg.kind !== kind || msg.orderId !== orderId)) msg = undefined;
      if (!msg && topic === this.d.cfg.recordsTopic && ref.seq > BigInt(store.cursors.hcs.seq)) unread = true;
    }
    if (!msg && !(ref && ref.seq > 0n)) {
      // The topic has no submit key: anyone can post a well-formed record for any order. The
      // earliest message from a writer of this kind (the order's own platform or shop when the
      // claim names them) counts; anyone else's is shown only when no writer's exists.
      const cand = (this.ordersIndex().get(orderId) ?? []).filter((r) => r.kind === kind).sort((a, b) => a.seq - b.seq);
      msg = (writers ? cand.find((r) => writers.has(r.payer)) : undefined) ?? cand[0];
      const st = store.status.hcs;
      if (!msg && this.d.cfg.recordsTopic !== '' && (st.indexedThrough === null || st.failing)) unread = true;
    }
    const refHash = ref?.hash ?? (ZERO32 as Hex);
    if (!msg) {
      return { kind, key, seq: Number(ref?.seq ?? 0n), payer: null, payerOk: false, hash: refHash === ZERO32 ? null : refHash, cid: null, held: unread ? null : false, hashOk: null, refsMatch: false, doc: null, unread };
    }
    const payerOk = writers !== null && writers.has(msg.payer);
    let hashOk: boolean | null = null;
    let doc: unknown | null = null;
    if (payerOk) {
      // Checked against the message's hash: a document that is not canonical counts as failed. One
      // not fetched within the wait is unchecked for now (the fetch goes on and is kept).
      const info = await within(this.d.docs.get(msg.cid, msg.hash), this.d.cfg.readWaitMs, null);
      if (info) {
        hashOk = info.ok && info.canonical;
        doc = info.ok && hashOk ? info.doc : null;
      }
    }
    const held = !payerOk ? false : hashOk;
    return {
      kind,
      key,
      seq: msg.seq,
      payer: msg.payer,
      payerOk,
      hash: msg.hash,
      cid: msg.cid,
      held,
      hashOk,
      refsMatch: refHash !== ZERO32 && msg.hash === refHash,
      doc,
      unread: false,
    };
  }

  async recordsOfOrder(orderId: string) {
    if (!HEX32.test(orderId)) throw new ApiError(400, 'bad_id');
    const id = orderId.toLowerCase() as Hex;
    let claimId: string | null = null;
    let order: OrderParties | undefined;
    for (const cid of this.d.store.claimIds()) {
      const c = this.foldOf(cid);
      if (c?.orderId === id) {
        claimId = cid;
        order = { platform: c.platform, shop: c.shop };
        break;
      }
    }
    const records = await Promise.all([0, 1, 2, 3, 4, 5].map((k) => this.recordInfo(id, k, undefined, order)));
    return { orderId: id, claimId, records };
  }

  // ------------------------------------------------------------------ detail

  /** A local service's answer, waited on a bounded time; null when it fails or is late. */
  private external<T>(key: string, url: string): Promise<T | null> {
    const p = this.ext.get(key, () => getJson(this.d.fetch, url, this.d.cfg.sourceTimeoutMs)).then(
      (v) => v as T,
      (e) => {
        // The docket answers 404 for a claim it has not seen: that is "none", not "unreachable".
        if (key.startsWith('dk:') && e instanceof HttpError && e.status === 404) return { writeStatus: 'none', store: null, entityKey: null } as T;
        return null;
      },
    );
    return within(p, this.d.cfg.readWaitMs, null);
  }

  async claimDetail(claimId: string) {
    if (!HEX32.test(claimId)) throw new ApiError(400, 'bad_id');
    const id = claimId.toLowerCase();
    const c = this.foldOf(id);
    if (!c) throw new ApiError(404, 'unknown');
    // The reads that wait on the chain, a document or a local service run side by side.
    const precheckP = c.preChecked ? this.external<Record<string, unknown>>(`pc:${id}`, `${this.d.cfg.precheckUrl}/results/${id}`) : Promise.resolve(null);
    const dockP = this.external<Record<string, unknown>>(`dk:${id}`, `${this.d.cfg.docketUrl}/write-status/${id}`);
    const recordsP = Promise.all(
      [0, 1, 2, 3, 4, 5].map((k) =>
        this.recordInfo(c.orderId, k, { topicNum: c.refs.topicNum, seq: c.refs.seq[k] ?? 0n, hash: (c.refs.hashes[k] ?? ZERO32) as Hex }, { platform: c.platform, shop: c.shop }),
      ),
    );
    const [lp] = await Promise.all([this.liveParams(), this.loadTerms([id])]);
    const { status, caseView, bridge } = this.statusOf(c, lp);
    const money = this.moneyFor(c, lp);
    const events = this.d.store.eventsOf(id);
    const live = this.d.store.live.get(id);
    const records = await recordsP;
    const dep = this.d.deployments;
    const attemptsOpened = events.filter((e) => e.name === 'CaseOpened');
    const evidence = [];
    if (dep.caseAddress) {
      for (const attempt of [1, 2] as const) {
        const ext = externalIdUint(dep.arbitrumChainId, dep.caseAddress, c.claimId, attempt).toString();
        for (const it of this.d.store.evidence.values()) {
          if (it.externalId === ext) {
            evidence.push({ attempt, externalId: ext, uri: it.uri, party: it.party, tx: it.tx, time: it.time, explorer: this.explorer('arbitrum', it.tx) });
          }
        }
      }
    }
    const disputeIds = caseView ? caseView.disputeIds.filter((d) => d !== 0n) : c.disputeIds;
    const current = caseView ? (caseView.attempts >= 2 ? caseView.disputeIds[1] : caseView.disputeIds[0]) : (c.disputeIds[c.disputeIds.length - 1] ?? 0n);
    const kl = live?.kleros[current.toString()];
    const tpl = this.d.cfg.courtUrlTemplate;
    const precheckRes = await precheckP;
    let packHashOk: boolean | null = null;
    const pcCid = precheckRes && typeof precheckRes.cid === 'string' ? precheckRes.cid : null;
    if (pcCid && HEX32.test(c.packHash) && c.packHash !== ZERO32) {
      const info = await within(this.d.docs.get(pcCid, c.packHash.toLowerCase() as Hex), this.d.cfg.readWaitMs, null);
      packHashOk = info ? info.ok : null;
    }
    const dock = await dockP;
    const docketStatus = dock ? String(dock.writeStatus ?? 'none') : 'unreachable';
    return {
      ...this.row(c, lp),
      refs: { topicNum: c.refs.topicNum, seq: c.refs.seq, hashes: c.refs.hashes },
      packHash: c.packHash,
      statusKey: status.statusKey,
      records,
      precheck: c.preChecked
        ? { gap: c.gap, answer: c.answer, side: sideOf(c.answer as Answer), packHash: c.packHash, preCheckedAt: c.preCheckedAt, result: precheckRes, packHashOk }
        : null,
      contest: { by: c.contestedBy, at: c.contestedAt, windowEndsAt: c.preChecked ? c.preCheckedAt + this.paramsFor(lp, id).claims.contestWindow : null },
      court: {
        state: caseView ? CASE_STATES[caseView.state] ?? 'unknown' : 'none',
        attempts: caseView?.attempts ?? attemptsOpened.length,
        disputeIds,
        period: kl ? kl.period : null,
        periodName: kl && kl.period !== null ? (PERIODS[kl.period] ?? null) : null,
        currentRuling: kl ? kl.currentRuling : null,
        tied: kl ? kl.tied : null,
        overridden: kl ? kl.overridden : null,
        ruling: c.status === ClaimStatus.Ruled || c.status === ClaimStatus.Settled ? c.ruling : null,
        evidence,
        courtLinks: tpl ? disputeIds.map((d) => ({ disputeId: d, url: tpl.replace('{id}', d.toString()) })) : [],
      },
      bridge: bridge.map((b) => ({ ...b, ccipExplorer: `https://ccip.chain.link/msg/${b.messageId}` })),
      // Every known message, with its delivery state when it has been read (null otherwise).
      messages: [
        ...c.toCourt.filter((m) => m.messageId !== ZERO32).map((m) => ({ direction: 'toArbitrum' as const, ...m })),
        ...c.relayed.filter((m) => m.messageId !== ZERO32).map((m) => ({ direction: 'toHedera' as const, ...m })),
      ].map((m) => ({
        messageId: m.messageId,
        direction: m.direction,
        sendNo: m.sendNo,
        sentAt: m.time,
        executionState: live?.exec[m.messageId] ?? null,
        ccipExplorer: `https://ccip.chain.link/msg/${m.messageId}`,
      })),
      money,
      docket: { writeStatus: docketStatus, entityKey: dock && typeof dock.entityKey === 'string' ? dock.entityKey : null, store: dock && typeof dock.store === 'string' ? dock.store : null, reviews: dock?.reviews ?? null, lastError: dock && typeof dock.errorKind === 'string' ? dock.errorKind : null },
      events: events.map((e) => this.eventOut(e)),
    };
  }

  private explorer(chain: 'hedera' | 'arbitrum', tx: Hex): string | null {
    if (this.d.deployments.local) return null;
    return chain === 'hedera' ? `https://hashscan.io/testnet/transaction/${tx}` : `https://sepolia.arbiscan.io/tx/${tx}`;
  }

  private eventOut(e: IndexedEvent) {
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e.args)) {
      if (typeof v === 'string' && v.length > 70) continue;
      args[k] = v;
    }
    const final = e.chain === 'arbitrum' && e.block !== undefined && this.d.store.arbFinalized !== null ? e.block <= this.d.store.arbFinalized : undefined;
    return { name: e.name, contract: e.contract, chain: e.chain, tx: e.tx, logIndex: e.logIndex, time: e.time, explorer: this.explorer(e.chain, e.tx), ...(final === undefined ? {} : { final }), args };
  }

  // ------------------------------------------------------------------ parties

  /** The vault views of `address`: the last good read when this one fails or is late, null before any. */
  private async views(address: Address): Promise<PartyViews | null> {
    const r = this.d.reader;
    if (!r) return null;
    return (await this.partyViews.get(address, () => r.party(address))).value;
  }

  /**
   * The vault credit of an account a claim names, for the claim's next action: a live read (the
   * last one read when it fails, null before any) that never rejects. Each answer is kept, also one
   * that lands after its caller stopped waiting, so a slow relay still leaves a value for the next
   * read (`knownCredit`).
   */
  readCredit(address: Address): Promise<bigint | null> {
    return this.views(address).then((v) => (v ? v.credit : null));
  }

  /** The last vault credit read for `address`, null before any. */
  knownCredit(address: Address): bigint | null {
    return this.partyViews.peek(address).value?.credit ?? null;
  }

  async partyBlock(address: Address) {
    const ps = this.d.parties();
    const known: Party | undefined = ps ? partyByAddress(ps, address) : undefined;
    const claims: FoldedClaim[] = [];
    for (const id of this.d.store.claimIds()) {
      const c = this.foldOf(id);
      if (c && (c.shop === address || c.platform === address)) claims.push(c);
    }
    // The vault is read only for a known party or an address seen in an indexed claim: these
    // routes are public, and each new address would otherwise cost eight eth_calls on the Hedera
    // relay the keeper also uses. Any other address gets the standing fields as null (not read).
    const [lp, v] = await Promise.all([this.liveParams(), known || claims.length > 0 ? this.views(address) : null]);
    // The vault holds each court fee under the claim's shop: its own figure when read, else the fees
    // the index shows held for claims where this address is the shop (never a platform's shops' fees).
    let escrowOpen = 0n;
    let openClaims = 0;
    for (const c of claims) {
      if (!isTerminal(c.status)) openClaims++;
      if (c.shop !== address) continue;
      const m = this.moneyFor(c, lp);
      if (m.escrow.fate === 'held') escrowOpen += m.escrow.amount;
    }
    if (v) escrowOpen = v.shopEscrow;
    return {
      address,
      role: known?.role ?? 'unknown',
      displayName: known?.displayName ?? null,
      hederaAccountId: known?.hederaAccountId ?? null,
      balance: v ? v.deposit : null,
      required: v ? v.required : null,
      inGoodStanding: v ? v.inGoodStanding : null,
      topUpDeadline: v ? v.topUpDeadline : null,
      credit: v ? v.credit : null,
      escrowOpen,
      openClaims,
      openClaimsOnChain: v ? v.openClaims : null,
      exitRequestedAt: v && v.exitRequestedAt !== 0n ? v.exitRequestedAt : null,
    };
  }

  async party(address: string) {
    if (!isAddress(address, { strict: false })) throw new ApiError(400, 'bad_id');
    return this.partyBlock(getAddress(address));
  }

  // ------------------------------------------------------------------ search

  async search(q: string) {
    const term = q.trim();
    if (term === '') throw new ApiError(400, 'bad_id');
    const hits: { type: string; id: string; claimId: string | null }[] = [];
    const store = this.d.store;
    const add = (type: string, id: string, claimId: string | null) => {
      if (!hits.some((h) => h.type === type && h.id === id && h.claimId === claimId)) hits.push({ type, id, claimId });
    };
    const lower = term.toLowerCase();
    if (HEX32.test(term)) {
      for (const id of store.claimIds()) {
        const c = this.foldOf(id);
        if (!c) continue;
        if (c.claimId === lower) add('claim', id, id);
        if (c.orderId === lower) add('order', lower, id);
        if (c.packHash === lower) add('packHash', lower, id);
        if (c.toCourt.some((m) => m.messageId === lower) || c.relayed.some((m) => m.messageId === lower)) add('message', lower, id);
        if (c.refs.hashes.some((h) => h === lower)) add('recordHash', lower, id);
        for (const e of store.eventsOf(id)) {
          if (e.tx.toLowerCase() === lower) add('tx', lower, id);
          if (e.name === 'ClaimReceived' && String(e.args.messageId) === lower) add('message', lower, id);
        }
      }
      for (const r of store.hcs.values()) {
        if (r.hash === lower) {
          const owner = store.claimIds().find((cid) => this.foldOf(cid)?.orderId === r.orderId) ?? null;
          add('recordHash', lower, owner);
        }
      }
    } else if (/^\d+$/.test(term)) {
      for (const id of store.claimIds()) {
        const c = this.foldOf(id);
        if (c?.disputeIds.some((d) => d.toString() === term) || (c && c.disputeId.toString() === term && c.disputeId !== 0n)) add('dispute', term, id);
      }
    } else if (/^\d+\.\d+\.\d+:\d+$/.test(term) || /^\d+:\d+$/.test(term)) {
      const [t = '', s = ''] = term.split(':');
      const topic = t.includes('.') ? t : `${this.d.cfg.recordsTopic.split('.').slice(0, 2).join('.') || '0.0'}.${t}`;
      const r = store.hcs.get(`${topic}:${s}`);
      if (r) add('hcsMessage', `${topic}:${s}`, store.claimIds().find((cid) => this.foldOf(cid)?.orderId === r.orderId) ?? null);
    } else if (/^\d+\.\d+\.\d+$/.test(term)) {
      if (term === this.d.cfg.recordsTopic) add('topic', term, null);
      for (const p of this.d.parties() ?? []) {
        if (p.hederaAccountId === term || p.hcsWriters.includes(term)) add('party', p.evmAddress, null);
      }
    } else if (isAddress(term, { strict: false })) {
      const a = getAddress(term);
      const known = this.d.parties() ? partyByAddress(this.d.parties()!, a) : undefined;
      const involved = store.claimIds().some((cid) => {
        const c = this.foldOf(cid);
        return c !== null && (c.shop === a || c.platform === a);
      });
      if (known || involved) add('party', a, null);
    }
    return { q: term, hits };
  }

  // ------------------------------------------------------------------ params

  async paramsResponse() {
    const dep = this.d.deployments;
    const r = this.d.reader;
    const [lp, facts, docket] = await Promise.all([
      this.liveParams(),
      r ? this.facts$.get('f', () => r.facts()).then((h) => h.value) : null,
      this.external<Record<string, unknown>>('dk:health', `${this.d.cfg.docketUrl}/health`),
    ]);
    const ps = this.d.parties();
    const scheme = ps ? partiesByRole(ps, 'scheme')[0] : undefined;
    return {
      addresses: {
        claims: dep.claims ?? null,
        vault: dep.vault ?? null,
        recourseCase: dep.caseAddress ?? null,
        offRampHedera: dep.outside.offRampHedera,
        offRampArbitrum: dep.outside.offRampArb,
        klerosCore: dep.outside.klerosCore,
        evidenceModule: dep.outside.evidenceModule,
        routerHedera: addressBook.hedera.router,
        routerArbitrum: addressBook.arbitrum.router,
        usdc: dep.token.address,
      },
      vaultToken: dep.token,
      chains: { hedera: dep.hederaChainId, arbitrum: dep.arbitrumChainId },
      recordsTopic: this.d.cfg.recordsTopic || null,
      params: {
        claims: lp.claims,
        case: lp.kase,
        vault: lp.vault,
        stuckAfter: BigInt(PARAMS.locked.stuckAfter),
        defaulted: lp.defaulted,
      },
      preCheckSigner: facts?.claims.preCheckSigner ?? null,
      owners: { claims: facts?.claims.owner ?? null, vault: facts?.vault.owner ?? null, case: facts?.case.owner ?? null },
      lock: { claims: facts?.claims.configLocked ?? null, vault: facts?.vault.configLocked ?? null, case: facts?.case.locked ?? null },
      bridge: facts ? { mode: facts.claims.bridgeMode, claimsPeer: facts.claims.peer, casePeer: facts.case.peer, trustedRelay: facts.case.trustedRelay, rulingRelayer: facts.claims.rulingRelayer } : null,
      totals: facts?.vault.totals ?? null,
      feePool: facts?.case.feePool ?? null,
      policyURI: facts?.case.policyURI ?? null,
      schemeWallet: scheme?.evmAddress ?? null,
      // `store` says where the docket writes ('arkiv', or 'local' on its own host, when the public
      // docket page, which reads Arkiv, has nothing to show).
      docket: docket ? { rateConfig: (docket as { rateConfig?: unknown }).rateConfig ?? null, store: typeof (docket as { store?: unknown }).store === 'string' ? (docket as { store: string }).store : null } : null,
      disclosedPowers: DISCLOSED_POWERS,
    };
  }
}

export const DISCLOSED_POWERS = [
  { name: 'setExtraArgs', contract: 'claims and case', effect: 'Changes the CCIP gas settings for later sends. It cannot change a message already sent.' },
  { name: 'setRequired', contract: 'vault', effect: 'Sets the deposit a platform must keep. Always callable by the owner, including after the config lock.' },
  { name: 'setFeeToken', contract: 'claims', effect: 'Chooses whether CCIP fees are paid in LINK or in HBAR.' },
  { name: 'setPolicyURI', contract: 'case', effect: 'Changes the court policy used for cases opened afterwards.' },
  { name: 'setTemplateText', contract: 'case', effect: 'Changes the dispute template used for cases opened afterwards.' },
  { name: 'withdrawFeePool', contract: 'case', effect: 'Returns unused fee-pool money (team money) to the owner. It never touches shop or platform funds.' },
] as const;

export interface ConfigLockView {
  claims: boolean | null;
  vault: boolean | null;
  case: boolean | null;
  /** True once all three are locked; null while not read. */
  allLocked: boolean | null;
  /** What the owner can still do, in plain words; null once every contract is locked. */
  notice: string | null;
}

/** What each contract's owner can change until that contract's config is locked. */
const OWNER_POWERS = {
  claims:
    'on the claims contract, change the contest window, the claim timeout, the court fee and the handling fee, replace the pre-check signer, and choose where rulings come from (the bridge peer, the bridge mode and the account that records rulings), which lets the owner decide rulings',
  vault: 'on the vault, change the top-up window, the exit delay and the minimum deposit, and choose which claims contract can move deposits',
  case: 'on the court-case contract, change the case deadline, the open-case limit and the resend rules, and replace the bridge peer and the trusted relay',
} as const;

export function configLockView(f: ConfigLocks | null): ConfigLockView {
  if (f === null) {
    return {
      claims: null,
      vault: null,
      case: null,
      allLocked: null,
      notice: 'Whether the contracts are locked could not be read. Until it is, assume the owner can still change the claim rules and decide rulings.',
    };
  }
  const open = (['claims', 'vault', 'case'] as const).filter((k) => !f[k]);
  return {
    claims: f.claims,
    vault: f.vault,
    case: f.case,
    allLocked: open.length === 0,
    notice:
      open.length === 0
        ? null
        : `Not every contract is locked yet. Until it is, the owner can ${open.map((k) => OWNER_POWERS[k]).join('; and ')}. Once all three are locked, none of this can change.`,
  };
}

const TERMINAL_KEYS: ReadonlySet<StatusKey> = new Set(['settled', 'closed_uncontested', 'closed_undrawn', 'expired']);
const STATUS_SET: ReadonlySet<string> = new Set([
  'filed', 'finding_made', 'no_finding', 'window_lapsed', 'closed_uncontested', 'contested', 'at_court', 'stuck',
  'refused_once', 'ruled', 'zero_twice_answer_applied', 'unresolved', 'settled', 'expired', 'closed_undrawn',
]);
