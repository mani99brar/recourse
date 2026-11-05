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
  partyByAddress,
  partiesByRole,
  sideOf,
  type Answer,
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
import { TtlCache, type CaseParams, type ClaimsParams, type PartyViews, type Reader, type VaultParams } from './live.js';
import type { Store } from './store.js';
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
}

export class StatusService {
  private params$: TtlCache<LiveParamBundle>;
  private partyViews: TtlCache<PartyViews>;
  private facts$: TtlCache<Awaited<ReturnType<Reader['facts']>>>;
  private ext = new TtlCache<unknown>(10_000);
  private lastGood: LiveParamBundle | null = null;
  private hcsOrder: { size: number; map: Map<string, HcsRecord[]> } = { size: -1, map: new Map() };

  constructor(readonly d: ServiceDeps) {
    this.params$ = new TtlCache(d.cfg.viewCacheMs);
    this.partyViews = new TtlCache(d.cfg.viewCacheMs);
    this.facts$ = new TtlCache(d.cfg.viewCacheMs);
  }

  private nowBig(): bigint {
    return BigInt(this.d.nowS());
  }

  // ------------------------------------------------------------------ params and sources

  async liveParams(): Promise<LiveParamBundle> {
    const r = this.d.reader;
    if (r) {
      try {
        const b = await this.params$.get('p', async () => {
          const [claims, kase] = await Promise.all([r.claimsParams(), r.caseParams()]);
          const vault = await r.vaultParams().catch(() => null);
          return { claims, kase, vault, defaulted: false };
        });
        this.lastGood = b;
        return b;
      } catch {
        if (this.lastGood) return this.lastGood;
      }
    }
    const p = PARAMS.preLock;
    return {
      claims: {
        contestWindow: BigInt(p.contestWindow),
        claimTimeout: BigInt(p.claimTimeout),
        courtFeeUsdc: BigInt(p.courtFeeUsdc),
        handlingBase: BigInt(p.handlingBase),
        handlingBps: BigInt(p.handlingBps),
        handlingCap: BigInt(p.handlingCap),
        resendGap: BigInt(p.resendGap),
        maxSends: p.maxSends,
      },
      kase: { caseDeadline: BigInt(p.caseDeadline), maxOpenCases: p.maxOpenCases, resendGap: BigInt(p.resendGap), maxSends: p.maxSends },
      vault: null,
      defaulted: true,
    };
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
    if (this.lastGood === null && this.d.reader !== null && this.d.store.claimIds().length > 0) out.push('params');
    return out;
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
      };
    };
    return {
      rebuilding: this.d.store.rebuilding,
      sources: { hedera: src('hedera'), arbitrum: src('arbitrum'), hcs: src('hcs') },
      deployments: { files: this.d.deployments.files, local: this.d.deployments.local },
      parties: this.d.parties() !== null,
      reader: this.d.reader !== null,
      claims: this.d.store.claimIds().length,
    };
  }

  // ------------------------------------------------------------------ claims

  private foldOf(claimId: string): FoldedClaim | null {
    return foldClaim(this.d.store.eventsOf(claimId));
  }

  private nameOf(a: Address): string | null {
    const ps = this.d.parties();
    return ps ? (partyByAddress(ps, a)?.displayName ?? null) : null;
  }

  private statusOf(c: FoldedClaim, lp: LiveParamBundle) {
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
    );
    return { status, caseView, bridge };
  }

  private moneyFor(c: FoldedClaim, lp: LiveParamBundle): Money {
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
    const lp = await this.liveParams();
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
    const rows = await this.claimRows({ party: addr, ...(status ? { status } : {}) });
    const standing = await this.partyBlock(addr);
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

  async recordInfo(orderId: Hex, kind: number, ref?: { topicNum: bigint; seq: bigint; hash: Hex }): Promise<RecordInfo> {
    const key = RECORD_KEYS[kind] ?? 'unknown';
    const parties = this.d.parties();
    let msg: HcsRecord | undefined;
    if (ref && ref.seq > 0n) {
      msg = this.d.store.hcs.get(`${this.topicId(ref.topicNum)}:${ref.seq}`);
      if (msg && (msg.kind !== kind || msg.orderId !== orderId)) msg = undefined;
    }
    if (!msg && !(ref && ref.seq > 0n)) {
      const cand = (this.ordersIndex().get(orderId) ?? []).filter((r) => r.kind === kind);
      msg = cand.sort((a, b) => a.seq - b.seq)[0];
    }
    const refHash = ref?.hash ?? (ZERO32 as Hex);
    if (!msg) {
      return { kind, key, seq: Number(ref?.seq ?? 0n), payer: null, payerOk: false, hash: refHash === ZERO32 ? null : refHash, cid: null, held: false, hashOk: null, refsMatch: false, doc: null };
    }
    const payerOk = parties !== null && hcsWritersFor(parties, kind).has(msg.payer);
    let hashOk: boolean | null = null;
    let doc: unknown | null = null;
    if (payerOk) {
      const info = await this.d.docs.get(msg.cid);
      if (info) {
        hashOk = info.hash === msg.hash && info.canonical;
        doc = hashOk ? info.doc : null;
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
    };
  }

  async recordsOfOrder(orderId: string) {
    if (!HEX32.test(orderId)) throw new ApiError(400, 'bad_id');
    const id = orderId.toLowerCase() as Hex;
    const records = [];
    for (let k = 0; k < 6; k++) records.push(await this.recordInfo(id, k));
    const claimId = this.d.store.claimIds().find((cid) => this.foldOf(cid)?.orderId === id) ?? null;
    return { orderId: id, claimId, records };
  }

  // ------------------------------------------------------------------ detail

  private async external<T>(key: string, url: string): Promise<T | null> {
    try {
      return (await this.ext.get(key, () => getJson(this.d.fetch, url, this.d.cfg.sourceTimeoutMs))) as T;
    } catch (e) {
      // The docket answers 404 for a claim it has not seen: that is "none", not "unreachable".
      if (key.startsWith('dk:') && e instanceof HttpError && e.status === 404) return { writeStatus: 'none', store: null, entityKey: null } as T;
      return null;
    }
  }

  async claimDetail(claimId: string) {
    if (!HEX32.test(claimId)) throw new ApiError(400, 'bad_id');
    const id = claimId.toLowerCase();
    const c = this.foldOf(id);
    if (!c) throw new ApiError(404, 'unknown');
    const lp = await this.liveParams();
    const { status, caseView, bridge } = this.statusOf(c, lp);
    const money = this.moneyFor(c, lp);
    const events = this.d.store.eventsOf(id);
    const live = this.d.store.live.get(id);
    const records = [];
    for (let k = 0; k < 6; k++) {
      records.push(await this.recordInfo(c.orderId, k, { topicNum: c.refs.topicNum, seq: c.refs.seq[k] ?? 0n, hash: (c.refs.hashes[k] ?? ZERO32) as Hex }));
    }
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
    const precheckRes = c.preChecked ? await this.external<Record<string, unknown>>(`pc:${id}`, `${this.d.cfg.precheckUrl}/results/${id}`) : null;
    let packHashOk: boolean | null = null;
    const pcCid = precheckRes && typeof precheckRes.cid === 'string' ? precheckRes.cid : null;
    if (pcCid) {
      const info = await this.d.docs.get(pcCid);
      packHashOk = info ? info.hash === c.packHash : null;
    }
    const dock = await this.external<Record<string, unknown>>(`dk:${id}`, `${this.d.cfg.docketUrl}/write-status/${id}`);
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
      contest: { by: c.contestedBy, at: c.contestedAt, windowEndsAt: c.preChecked ? c.preCheckedAt + lp.claims.contestWindow : null },
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

  private async views(address: Address): Promise<PartyViews | null> {
    const r = this.d.reader;
    if (!r) return null;
    try {
      return await this.partyViews.get(address, () => r.party(address));
    } catch {
      return null;
    }
  }

  async partyBlock(address: Address) {
    const ps = this.d.parties();
    const known: Party | undefined = ps ? partyByAddress(ps, address) : undefined;
    const v = await this.views(address);
    const lp = await this.liveParams();
    let escrowOpen = 0n;
    let openClaims = 0;
    for (const id of this.d.store.claimIds()) {
      const c = this.foldOf(id);
      if (!c || (c.shop !== address && c.platform !== address)) continue;
      if (!isTerminal(c.status)) openClaims++;
      if (c.shop === address || c.platform === address) {
        const m = this.moneyFor(c, lp);
        if (m.escrow.fate === 'held') escrowOpen += m.escrow.amount;
      }
    }
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
    const lp = await this.liveParams();
    let facts = null;
    if (this.d.reader) {
      try {
        facts = await this.facts$.get('f', () => this.d.reader!.facts());
      } catch {
        facts = null;
      }
    }
    const ps = this.d.parties();
    const scheme = ps ? partiesByRole(ps, 'scheme')[0] : undefined;
    const docket = await this.external<Record<string, unknown>>('dk:health', `${this.d.cfg.docketUrl}/health`);
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
        usdc: addressBook.hedera.usdc.facade,
      },
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
      docket: docket ? { rateConfig: (docket as { rateConfig?: unknown }).rateConfig ?? null } : null,
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

const TERMINAL_KEYS: ReadonlySet<StatusKey> = new Set(['settled', 'closed_uncontested', 'closed_undrawn', 'expired']);
const STATUS_SET: ReadonlySet<string> = new Set([
  'filed', 'finding_made', 'no_finding', 'window_lapsed', 'closed_uncontested', 'contested', 'at_court', 'stuck',
  'refused_once', 'ruled', 'zero_twice_answer_applied', 'unresolved', 'settled', 'expired', 'closed_undrawn',
]);
