// Read-only Hedera mirror node client: accounts, token relationships, transactions and topics.
// Every method returns null for a 404 and throws a MirrorError for anything else that is not 2xx.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class MirrorError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'MirrorError';
  }
}

export interface MirrorAccount {
  accountId: string;
  /** Null for a hollow account (created from an EVM address, no key yet). */
  keyType: string | null;
  evmAddress: string | null;
  balanceTinybar: bigint;
  deleted: boolean;
}

export interface MirrorTokenRelationship {
  associated: boolean;
  balance: bigint;
}

export interface MirrorTransfer {
  account: string;
  amount: bigint;
}

export interface MirrorTransaction {
  transactionId: string;
  result: string;
  consensusTimestamp: string;
  name: string;
  payer: string;
  tokenTransfers: (MirrorTransfer & { tokenId: string })[];
  transfers: MirrorTransfer[];
}

export interface MirrorTopic {
  topicId: string;
  memo: string;
  hasAdminKey: boolean;
  hasSubmitKey: boolean;
  deleted: boolean;
}

export interface MirrorTopicMessageRaw {
  sequenceNumber: number;
  consensusTimestamp: string;
  payerAccountId: string | null;
  /** Base64 message body as the mirror node returns it. */
  message: string;
  /** Present when the message was split into chunks; Recourse messages are never chunked. */
  chunkInfo: { number: number; total: number } | null;
}

const ACCOUNT_ID = /^\d+\.\d+\.\d+$/;
const TX_ID = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/;

/** `0.0.5@1700000000.000000001` -> `0.0.5-1700000000-000000001`, the form the mirror node takes in paths. */
export function mirrorTransactionId(txId: string): string {
  const m = TX_ID.exec(txId.trim());
  if (!m) {
    if (/^\d+\.\d+\.\d+-\d+-\d+$/.test(txId.trim())) return txId.trim();
    throw new Error(`mirror: not a transaction id: ${txId}`);
  }
  return `${m[1]}-${m[2]}-${m[3]!.padStart(9, '0')}`;
}

/** Seconds since the epoch of a transaction id's valid start. */
export function validStartSeconds(txId: string): number {
  const m = TX_ID.exec(txId.trim()) ?? /^(\d+\.\d+\.\d+)-(\d+)-(\d+)$/.exec(txId.trim());
  if (!m) throw new Error(`mirror: not a transaction id: ${txId}`);
  return Number(m[2]);
}

/** Normalises a configured mirror URL to the `.../api/v1` base. */
export function mirrorBase(url: string): string {
  let base = url.trim().replace(/\/+$/, '');
  if (!base.endsWith('/api/v1')) base = `${base}/api/v1`;
  return base;
}

function big(value: unknown): bigint {
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  return 0n;
}

export class MirrorClient {
  readonly base: string;

  constructor(
    url: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly timeoutMs = 15_000,
  ) {
    this.base = mirrorBase(url);
  }

  private async get(path: string): Promise<unknown | null> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new MirrorError(res.status, path, `mirror: ${res.status} for ${path}`);
    return res.json();
  }

  async account(idOrEvmAddress: string): Promise<MirrorAccount | null> {
    const body = (await this.get(`/accounts/${encodeURIComponent(idOrEvmAddress)}`)) as Record<string, unknown> | null;
    if (!body) return null;
    const key = body.key as { _type?: string } | null | undefined;
    const balance = body.balance as { balance?: unknown } | undefined;
    return {
      accountId: String(body.account),
      keyType: key && typeof key._type === 'string' ? key._type : null,
      evmAddress: typeof body.evm_address === 'string' ? body.evm_address : null,
      balanceTinybar: big(balance?.balance),
      deleted: body.deleted === true,
    };
  }

  async tokenRelationship(accountId: string, tokenId: string): Promise<MirrorTokenRelationship> {
    if (!ACCOUNT_ID.test(accountId)) throw new Error(`mirror: bad account id ${accountId}`);
    const body = (await this.get(
      `/accounts/${accountId}/tokens?token.id=${encodeURIComponent(tokenId)}&limit=1`,
    )) as { tokens?: { token_id?: string; balance?: unknown }[] } | null;
    const row = body?.tokens?.find((t) => t.token_id === tokenId);
    return row ? { associated: true, balance: big(row.balance) } : { associated: false, balance: 0n };
  }

  /** The top-level transaction with this id, or null when the mirror node has none. */
  async transaction(txId: string): Promise<MirrorTransaction | null> {
    const body = (await this.get(`/transactions/${mirrorTransactionId(txId)}`)) as {
      transactions?: Record<string, unknown>[];
    } | null;
    const rows = body?.transactions ?? [];
    const top = rows.find((t) => (t.nonce ?? 0) === 0 && (t.scheduled ?? false) === false) ?? rows[0];
    return top ? parseTransaction(top) : null;
  }

  /**
   * Successful transactions paid for or touching `accountId` at or after `sinceSeconds`, oldest
   * first, up to `limit` rows.
   */
  async transactionsOf(accountId: string, sinceSeconds: number, limit = 100): Promise<MirrorTransaction[]> {
    if (!ACCOUNT_ID.test(accountId)) throw new Error(`mirror: bad account id ${accountId}`);
    const body = (await this.get(
      `/transactions?account.id=${accountId}&timestamp=gte:${Math.floor(sinceSeconds)}&order=asc&limit=${limit}&result=success`,
    )) as { transactions?: Record<string, unknown>[] } | null;
    return (body?.transactions ?? []).map(parseTransaction);
  }

  async topic(topicId: string): Promise<MirrorTopic | null> {
    const body = (await this.get(`/topics/${encodeURIComponent(topicId)}`)) as Record<string, unknown> | null;
    if (!body) return null;
    return {
      topicId: String(body.topic_id),
      memo: typeof body.memo === 'string' ? body.memo : '',
      hasAdminKey: body.admin_key != null,
      hasSubmitKey: body.submit_key != null,
      deleted: body.deleted === true,
    };
  }

  /** One page of topic messages from `fromSeq` (inclusive), in sequence order. */
  async topicMessages(topicId: string, fromSeq: number, limit = 100): Promise<MirrorTopicMessageRaw[]> {
    const body = (await this.get(
      `/topics/${encodeURIComponent(topicId)}/messages?sequencenumber=gte:${Math.max(1, Math.floor(fromSeq))}&limit=${limit}&order=asc`,
    )) as { messages?: Record<string, unknown>[] } | null;
    return (body?.messages ?? []).map((m) => {
      const chunk = m.chunk_info as { number?: number; total?: number } | null | undefined;
      return {
        sequenceNumber: Number(m.sequence_number),
        consensusTimestamp: String(m.consensus_timestamp),
        payerAccountId: typeof m.payer_account_id === 'string' ? m.payer_account_id : null,
        message: typeof m.message === 'string' ? m.message : '',
        chunkInfo:
          chunk && typeof chunk.total === 'number' ? { number: Number(chunk.number ?? 1), total: chunk.total } : null,
      };
    });
  }
}

function parseTransaction(t: Record<string, unknown>): MirrorTransaction {
  const tokenTransfers = Array.isArray(t.token_transfers) ? (t.token_transfers as Record<string, unknown>[]) : [];
  const transfers = Array.isArray(t.transfers) ? (t.transfers as Record<string, unknown>[]) : [];
  const transactionId = String(t.transaction_id ?? '');
  return {
    transactionId,
    result: String(t.result ?? ''),
    consensusTimestamp: String(t.consensus_timestamp ?? ''),
    name: String(t.name ?? ''),
    payer: transactionId.split('-')[0] ?? '',
    tokenTransfers: tokenTransfers.map((x) => ({
      tokenId: String(x.token_id),
      account: String(x.account),
      amount: big(x.amount),
    })),
    transfers: transfers.map((x) => ({ account: String(x.account), amount: big(x.amount) })),
  };
}
