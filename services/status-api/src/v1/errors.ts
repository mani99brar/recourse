// The /v1 error shape: { error: { code, message, details? } }, one fixed code list with its HTTP
// status (the same list as `x-recourse-error-codes` in openapi.json; a test keeps them equal).
// Messages are one plain sentence and never carry a URL, a key or anything from inside the server.

export const ERROR_STATUS = {
  bad_json: 400,
  missing_field: 400,
  invalid_field: 400,
  unknown_field: 400,
  not_contester: 403,
  not_found: 404,
  method_not_allowed: 405,
  payload_too_large: 413,
  same_party: 422,
  order_id_mismatch: 422,
  order_nonce_unknown: 422,
  not_paid: 422,
  no_ordered_record: 422,
  ordered_unreadable: 422,
  ordered_tx_mismatch: 422,
  no_packed_record: 422,
  zero_basket: 422,
  basket_too_large: 422,
  basket_mismatch: 422,
  net_loss_above_basket: 422,
  evidence_too_large: 422,
  claim_exists: 409,
  wrong_status: 409,
  window_closed: 409,
  window_open: 409,
  not_expired: 409,
  exit_due: 409,
  insufficient_balance: 409,
  no_credit: 409,
  not_associated: 409,
  vault_not_ready: 409,
  resend_too_soon: 409,
  max_sends_reached: 409,
  bridge_unavailable: 409,
  contract_underfunded: 409,
  insufficient_value: 409,
  case_wrong_state: 409,
  cap_reached: 409,
  no_dispute: 409,
  call_reverted: 409,
  rate_limited: 429,
  internal: 500,
  upstream_unavailable: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export type Upstream = 'index' | 'hedera_rpc' | 'arbitrum_rpc' | 'mirror' | 'ipfs' | 'shop' | 'precheck' | 'docket' | 'status_api';

export interface Revert {
  contract: string;
  name: string;
  args: string[];
}

/** Facts about an error; integers are written as decimal strings by the JSON replacer. */
export type ErrorDetails = Record<string, unknown>;

export class V1Error extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetails,
  ) {
    super(message);
    this.status = ERROR_STATUS[code];
  }
}

export function body(e: V1Error): { error: { code: ErrorCode; message: string; details?: ErrorDetails } } {
  return { error: { code: e.code, message: e.message, ...(e.details && Object.keys(e.details).length > 0 ? { details: e.details } : {}) } };
}

export const UPSTREAM_TEXT: Record<Upstream, string> = {
  index: 'The index has not read far enough yet',
  hedera_rpc: 'The Hedera JSON-RPC relay did not answer',
  arbitrum_rpc: 'The Arbitrum RPC did not answer',
  mirror: 'The Hedera mirror node did not answer',
  ipfs: 'A record document could not be fetched',
  shop: 'The shop service did not answer',
  precheck: 'The pre-check service did not answer',
  docket: 'The docket did not answer',
  status_api: 'The status API did not answer',
};

export function upstream(which: Upstream, extra: ErrorDetails = {}): V1Error {
  return new V1Error('upstream_unavailable', `${UPSTREAM_TEXT[which]}; try again shortly.`, { upstream: which, ...extra });
}

export function notFound(resource: 'route' | 'claim' | 'order' | 'party' | 'case', id?: string): V1Error {
  const what = resource === 'route' ? 'No such route' : `No such ${resource}`;
  return new V1Error('not_found', `${what}${resource === 'claim' ? ' (a claim filed moments ago appears once the index reaches it)' : ''}.`, { resource, ...(id !== undefined ? { id } : {}) });
}

export function invalid(field: string, reason: string): V1Error {
  return new V1Error('invalid_field', `${field}: ${reason}.`, { field, reason });
}

export function missing(field: string): V1Error {
  return new V1Error('missing_field', `${field} is required.`, { field });
}

/** The legacy service errors as /v1 errors. */
export function fromLegacy(status: number, code: string, field?: string): V1Error {
  if (code === 'bad_id') return invalid(field ?? 'id', 'not a valid id');
  if (code === 'unknown') return notFound('claim');
  if (code === 'rebuilding') return upstream('index', { rebuilding: true });
  if (status === 405) return new V1Error('method_not_allowed', 'This path does not take that method.');
  return new V1Error('internal', 'An unexpected failure in the API.');
}
