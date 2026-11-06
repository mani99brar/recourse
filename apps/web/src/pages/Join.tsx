import { useRef, useState, type ReactNode } from 'react';
import { HBAR_ASSET_ID, type VaultToken } from '@recourse/shared';
import type { EIP1193Provider, Hash } from 'viem';
import { LocalFlow, type LocalPlan } from '../actions/LocalFlow.js';
import { Banner, Card, ExtLink, Pill, Row } from '../components.js';
import { READS, usePoll, type Fresh } from '../lib/api.js';
import { HEDERA_CHAIN_ID, addressLink, txLink } from '../lib/chains.js';
import { short, usdc } from '../lib/format.js';
import { MAX_URI_BYTES, REGISTRY, buildRegister, dataUri, docFromUri, readBack as readRegistered, registrationDoc, uriSize, type RegistrationDoc, type Registered } from '../lib/identity.js';
import { useWallet } from '../lib/wallet.js';
import '../styles/join.css';

interface ParamsBody extends Fresh {
  /** `defaulted`: the chain has not been read yet, so these are the built-in defaults. */
  params: { claims: { courtFeeUsdc: string; contestWindow: string; claimTimeout: string }; defaulted?: boolean };
}
export type JoinParams = ParamsBody['params'];

/** Two real claims on testnet, one for each way a claim ends (the claim page reads both from the API). */
const PAYOUT_CLAIM = '0x8f78143ea47bd370edb87e91a720955110aa4978d79474a5d5fbbf0d1eec6f75';
const COURT_CLAIM = '0x392d6f13cdf5fe1ca93289d143e51b511f333de3d6d1769c72ddd0039c7f3c50';

/** The shop types the demo cast registers with; "another type" takes its own label and kind. */
export const SHOP_TYPES = [
  { kind: 'apparel-sizes', label: 'Physical goods with sizes' },
  { kind: 'perishable-timed', label: 'Perishable, time-bound goods' },
  { kind: 'api-pay-per-call', label: 'Digital or API service, pay per call' },
] as const;
export const OTHER_TYPE = 'other';

export interface JoinForm {
  name: string;
  /** One line on what it sells: the registration's summary, which the cast page shows under the name. */
  sells: string;
  /** A kind from SHOP_TYPES, or OTHER_TYPE. */
  type: string;
  label: string;
  kind: string;
  /** The x402 endpoint, optional; with it, the Hedera account it is paid to. */
  endpoint: string;
  account: string;
}
export type JoinField = 'name' | 'sells' | 'label' | 'kind' | 'endpoint' | 'account';

export const EMPTY_FORM: JoinForm = { name: '', sells: '', type: SHOP_TYPES[0].kind, label: '', kind: '', endpoint: '', account: '' };

/** What each field is called where the page lists what is left to fix. */
export const FIELD_WORDS: Record<JoinField, string> = {
  name: 'Shop name',
  sells: 'What it sells',
  label: 'Type name',
  kind: 'Type kind',
  endpoint: 'x402 endpoint',
  account: 'Hedera account to be paid',
};
const FIELD_ORDER: JoinField[] = ['name', 'sells', 'label', 'kind', 'endpoint', 'account'];
const fieldId = (f: JoinField) => `join-${f}`;

const LIMITS = { name: [2, 60], sells: [10, 160], label: [3, 60], kind: 40, endpoint: 200 } as const;
/** Short lowercase words joined by hyphens, as the cast's kinds are. */
const KIND_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A host name with a dot, ending in a label that starts with a letter: no bare IP or local name. */
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/i;
const ACCOUNT_RE = /^0\.0\.[1-9][0-9]{0,9}$/;

function lengthProblem(v: string, [min, max]: readonly [number, number], what: string, empty: string): string | null {
  const n = [...v].length;
  if (n === 0) return empty;
  if (n < min) return `Use at least ${min} characters for ${what}.`;
  if (n > max) return `Shorten ${what} to ${max} characters or fewer (it has ${n}).`;
  return null;
}

function endpointProblem(v: string): string | null {
  if (!v) return null;
  if (v.length > LIMITS.endpoint) return `Shorten the endpoint to ${LIMITS.endpoint} characters or fewer (it has ${v.length}).`;
  if (!/^https:\/\//i.test(v)) return 'The x402 endpoint must start with https://, for example https://shop.example/x402/.';
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return 'That is not a web address. Type one like https://shop.example/x402/.';
  }
  if (/\s/.test(v) || !HOST_RE.test(u.hostname)) return 'That is not a web address. Type one like https://shop.example/x402/.';
  if (u.username || u.password) return 'Take the user name and password out of the address: the registration is public.';
  return null;
}

/**
 * Every reason the form cannot be registered yet, by field, in words that say what to fix. The x402
 * endpoint and the account it pays go together: the shopping agent needs both to pay the shop.
 */
export function joinProblems(f: JoinForm): Partial<Record<JoinField, string>> {
  const out: Partial<Record<JoinField, string>> = {};
  const name = lengthProblem(f.name.trim(), LIMITS.name, 'the name', 'Name the shop: agent companies and the cast page show this name.');
  if (name) out.name = name;
  const sells = lengthProblem(f.sells.trim(), LIMITS.sells, 'the line on what it sells', 'Say in one line what the shop sells, for example "Sells tees and caps in sizes S to XL."');
  if (sells) out.sells = sells;
  if (f.type === OTHER_TYPE) {
    const label = lengthProblem(f.label.trim(), LIMITS.label, 'the type name', 'Name the type, for example "Physical goods with sizes".');
    if (label) out.label = label;
    const kind = f.kind.trim();
    if (!kind) out.kind = 'Give the kind as short lowercase words joined by hyphens, for example apparel-sizes.';
    else if (kind.length > LIMITS.kind) out.kind = `Shorten the kind to ${LIMITS.kind} characters or fewer (it has ${kind.length}).`;
    else if (!KIND_RE.test(kind)) out.kind = 'Use lowercase letters and digits, words joined by single hyphens, for example apparel-sizes.';
  }
  const endpoint = f.endpoint.trim();
  const account = f.account.trim();
  const ep = endpointProblem(endpoint);
  if (ep) out.endpoint = ep;
  if (account && !ACCOUNT_RE.test(account)) out.account = 'A Hedera account id has the form 0.0.1234567. Type the account that should be paid.';
  if (endpoint && !account && !ep) out.account = 'Add the Hedera account the x402 payments go to, or clear the endpoint.';
  if (account && !endpoint && !out.account) out.endpoint = 'The account is paid through the x402 endpoint: add the endpoint, or clear the account.';
  return out;
}

/** The registration document the form describes, as it stands (the x402 entry once an endpoint is typed). */
export function joinDoc(f: JoinForm): RegistrationDoc {
  const preset = SHOP_TYPES.find((t) => t.kind === f.type);
  const endpoint = f.endpoint.trim();
  return registrationDoc({
    role: 'shop',
    name: f.name,
    kind: preset ? preset.kind : f.kind.trim(),
    label: preset ? preset.label : f.label.trim(),
    summary: f.sells.trim(),
    ...(endpoint ? { x402: { baseUrl: endpoint, network: 'hedera:testnet', payTo: f.account.trim(), asset: HBAR_ASSET_ID } } : {}),
  });
}

/** "10 minutes", "18 hours", "7 days": a contract's duration in seconds, in the largest whole unit. */
export function spanWords(seconds: string | number): string {
  const s = Number(seconds);
  const unit = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;
  if (s > 0 && s % 86400 === 0) return unit(s / 86400, 'day');
  if (s > 0 && s % 3600 === 0) return unit(s / 3600, 'hour');
  if (s > 0 && s % 60 === 0) return unit(s / 60, 'minute');
  return unit(s, 'second');
}

/** Defaults stand in when the chain has never been read: say so rather than show them as read. */
const chainNote = (p: JoinParams | undefined) => (p?.defaulted === true ? ' (default, not read from the chain yet)' : '');

/** The parameters a sentence names, or what stands in until the API answers. */
function paramWords(p: JoinParams | undefined, token: VaultToken | undefined) {
  const note = chainNote(p);
  return {
    fee: p ? `${usdc(p.claims.courtFeeUsdc, token)}${note}` : 'the court fee (not read yet)',
    window: p ? `${spanWords(p.claims.contestWindow)}${note}` : 'not read yet',
    timeout: p ? `${spanWords(p.claims.claimTimeout)}${note}` : 'not read yet',
  };
}

/** What a shop takes on by joining, with the contract's own figures. */
export function Agreement({ params, token }: { params?: JoinParams | undefined; token?: VaultToken | undefined }) {
  const w = paramWords(params, token);
  return (
    <Card title="What you agree to" id="join-agree">
      <ul className="join-list">
        <li>
          <b>You record what you pack.</b> When a shopping agent's order ships, your shop writes a Packed record (the brand, size, colour, quantity and price of what went in the box) to the records topic, a Hedera Consensus Service topic each
          party writes its own records to. A missing Packed record counts against you.
        </li>
        <li>
          <b>The fault rule decides from the records.</b> The pre-check, a signed check of an order's records against the fault rule, compares what the buyer asked for, what the agent showed and ordered, what you packed and what arrived. The first
          difference points to the side at fault. <a href="#/story">How it works</a> walks through it.
        </li>
        <li>
          <b>The agent company pays from its deposit when it is at fault.</b> An agent company, the business that runs a shopping agent, keeps a deposit in the vault. A claim it loses pays your net loss and a handling amount from that deposit, up
          to what it holds.
        </li>
        <li>
          <b>Each claim has a time limit.</b> The claim timeout is {w.timeout}. A filed claim not pre-checked within it, or a contested claim not ruled on within it, can be ended, and your court fee comes back in full.
        </li>
        <li>
          <b>Each claim you file holds a court fee of {w.fee}.</b> It comes back when nobody contests the pre-check within the contest window ({w.window}) and the claim closes, when the claim expires, or when the court (Kleros jurors, on
          Arbitrum Sepolia) finds the agent company at fault. It goes to the fee pool when the court finds you at fault, or finds neither side at fault and the pre-check had not flagged the agent company's part of the order.
        </li>
      </ul>
      <p className="muted small">
        Two claims on testnet show both ends: <a href={`#/claim/${PAYOUT_CLAIM}`}>one closed by itself</a>, paid from the agent company's deposit, and <a href={`#/claim/${COURT_CLAIM}`}>one the court ruled on</a>.
      </p>
    </Card>
  );
}

/** Every cost of joining and of each claim: no figure is shown before it is read or estimated. */
export function Costs({ params, token }: { params?: JoinParams | undefined; token?: VaultToken | undefined }) {
  const w = paramWords(params, token);
  return (
    <Card title="What joining costs" id="join-costs">
      <dl>
        <Row label="Registering">
          One transaction on Hedera testnet. You pay its network fee (gas) in HBAR, Hedera's own coin. This page estimates the fee through your wallet before you sign, and your wallet shows its own figure.
        </Row>
        <Row label="Each claim you file">The court fee, {w.fee}, held while the claim is open, and the gas of filing, in HBAR.</Row>
        <Row label="Anything else">Nothing: there is no joining, listing or monthly fee.</Row>
      </dl>
      <p className="muted small">The court fee is paid in mUSDC, which only the operator can mint. See the operator steps below.</p>
    </Card>
  );
}

/** The registration document as it goes on chain: pretty JSON and the size of the data: URI that carries it. */
export function RecordView({ doc }: { doc: RegistrationDoc }) {
  const json = JSON.stringify(doc, null, 2);
  const size = uriSize(dataUri(doc));
  return (
    <div className="join-record">
      <h3>The registration this puts on chain</h3>
      <p className="muted small">
        Stored inline in the registry as a data: URI (the document itself, encoded in the link, so no web server is needed):{' '}
        <b className="num">{`${size.bytes.toLocaleString('en-US')} bytes`}</b> of the {MAX_URI_BYTES.toLocaleString('en-US')} this page allows. It is public once registered.
      </p>
      <pre className="join-json">{json}</pre>
      {size.problem && (
        <p className="error" role="alert">
          {`The registration is ${size.bytes.toLocaleString('en-US')} bytes; it is stored on chain, so this page keeps it to ${MAX_URI_BYTES.toLocaleString('en-US')}. Shorten the name, the line on what it sells, the type name or the endpoint.`}
        </p>
      )}
    </div>
  );
}

/** A form field: its label, input, hint and the error that says what to fix, tied together for screen readers. */
function Field(p: { f: JoinField; label: string; value: string; error: string | null; hint?: ReactNode; placeholder?: string; auto?: string; words?: boolean; onChange: (v: string) => void; onBlur: () => void }) {
  const id = fieldId(p.f);
  const described = [p.hint ? `${id}-h` : null, p.error ? `${id}-e` : null].filter(Boolean).join(' ');
  return (
    <div className="join-field">
      <label htmlFor={id}>{p.label}</label>
      <input
        id={id}
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
        onBlur={p.onBlur}
        placeholder={p.placeholder}
        autoComplete={p.auto ?? 'off'}
        spellCheck={p.words === true}
        aria-invalid={p.error ? true : undefined}
        aria-describedby={described || undefined}
      />
      {p.hint && (
        <p className="hint" id={`${id}-h`}>
          {p.hint}
        </p>
      )}
      {p.error && (
        <p className="error join-err" id={`${id}-e`}>
          {p.error}
        </p>
      )}
    </div>
  );
}

/** The form's fields and the record beside them; the flow around them signs nothing until confirmed. */
export function JoinFields({ form, set, touched, touch }: { form: JoinForm; set: (f: JoinForm) => void; touched: ReadonlySet<JoinField>; touch: (f: JoinField) => void }) {
  const problems = joinProblems(form);
  const err = (f: JoinField) => (touched.has(f) ? (problems[f] ?? null) : null);
  const field = (f: JoinField, label: string, more: { hint?: ReactNode; placeholder?: string; auto?: string; words?: boolean } = {}) => (
    <Field f={f} label={label} value={form[f]} error={err(f)} onChange={(v) => set({ ...form, [f]: v })} onBlur={() => touch(f)} {...more} />
  );
  const left = FIELD_ORDER.filter((f) => problems[f]);
  return (
    <>
      <div className="join-form">
        <div className="join-fields">
          <fieldset>
            <legend className="vh">Your shop</legend>
            {field('name', 'Shop name', { placeholder: 'For example, Harbour Linen', auto: 'organization', words: true })}
            {field('sells', 'What it sells, in one line', { placeholder: 'For example, Sells shirts and tees in sizes S to XL.', hint: 'The cast page shows this line under the name.', words: true })}
          </fieldset>
          <fieldset className="join-types">
            <legend>What type of shop</legend>
            {SHOP_TYPES.map((t) => (
              <label key={t.kind} className="check-row">
                <input type="radio" name="join-type" value={t.kind} checked={form.type === t.kind} onChange={() => set({ ...form, type: t.kind })} />
                <span>
                  {t.label} <span className="mono muted">{t.kind}</span>
                </span>
              </label>
            ))}
            <label className="check-row">
              <input type="radio" name="join-type" value={OTHER_TYPE} checked={form.type === OTHER_TYPE} onChange={() => set({ ...form, type: OTHER_TYPE })} />
              <span>Another type, named below</span>
            </label>
            {form.type === OTHER_TYPE && (
              <div className="fields join-other">
                {field('label', 'Type name', { placeholder: 'For example, Books and prints', words: true })}
                {field('kind', 'Kind (lowercase, hyphens)', { placeholder: 'For example, books-prints' })}
              </div>
            )}
          </fieldset>
          <fieldset>
            <legend>Where shopping agents pay you (optional)</legend>
            <p className="muted small join-x402">
              x402 is a way to charge for a web request: your server answers with a price, and the agent pays and asks again. Payments in this demo are in HBAR, so the entry names HBAR on Hedera testnet.
            </p>
            {field('endpoint', 'x402 endpoint', { placeholder: 'https://shop.example/x402/', hint: 'Must start with https://. The shop service usually serves its paid routes under /x402/.' })}
            {field('account', 'Hedera account to be paid', { placeholder: '0.0.1234567', hint: 'The account id the x402 payments go to.' })}
          </fieldset>
        </div>
        <RecordView doc={joinDoc(form)} />
      </div>
      {left.length > 0 && (
        <p className="small join-todo">
          Before the preview, fix:{' '}
          {left.map((f, i) => (
            <span key={f}>
              {i > 0 && ', '}
              <button
                type="button"
                className="linkish"
                onClick={() => {
                  touch(f);
                  document.getElementById(fieldId(f))?.focus();
                }}
              >
                {FIELD_WORDS[f]}
              </button>
            </span>
          ))}
          .
        </p>
      )}
    </>
  );
}

/** A HashScan contract page (chains.ts links accounts and transactions). */
const contractLink = (address: string) => `https://hashscan.io/testnet/contract/${address}`;

/**
 * A registration as the cast page (#/cast) shows a shop: name, type, summary, its id, owner and
 * where its registration is kept, with no orders or claims yet. Before registering, the id is not known.
 */
export function ListingCard({ doc, agentId = null, owner = null }: { doc: RegistrationDoc; agentId?: string | null; owner?: string | null }) {
  const type = doc.recourse ?? null;
  const x402 = doc.services.find((s) => s.name === 'x402');
  return (
    <div className="member">
      <div className="member-head">
        <h3>{doc.name || 'Your shop name'}</h3>
        <p className="member-tags">{type?.label ? <Pill tone="plain">{type.label}</Pill> : <Pill tone="wait">Type not stated</Pill>}</p>
      </div>
      <p className="muted member-sum">{type?.summary || doc.description}</p>
      <dl>
        <Row label="ERC-8004 id">{agentId ?? <span className="muted">given when the registration is mined</span>}</Row>
        <Row label="Owner">{owner ? <ExtLink href={addressLink(HEDERA_CHAIN_ID, owner)}>{short(owner)}</ExtLink> : <span className="muted">the account your wallet signs with</span>}</Row>
        <Row label="Registration">
          inline in the registry
          {type?.kind && <span className="mono"> {type.kind}</span>}
        </Row>
        <Row label="Orders recorded">0</Row>
        <Row label="Claims">none</Row>
      </dl>
      <p className="muted small member-pay">
        {x402 ? (
          <>
            Shopping agents also read the x402 entry: <span className="mono">{x402.endpoint}</span>, paid to {typeof x402.payTo === 'string' && x402.payTo ? <span className="mono">{x402.payTo}</span> : 'no account yet'} in HBAR.
          </>
        ) : (
          'No x402 entry: shopping agents find no endpoint to buy from in this registration.'
        )}
      </p>
    </div>
  );
}

/** What the operator does after a shop registers; each is the operator's alone in this demo. */
export function OperatorSteps() {
  return (
    <ul className="join-list">
      <li>
        <b>Party map:</b> the operator adds your new identity to the party map (deployments/parties.json). Until then the shop service, the agent and the cast page do not know it.
      </li>
      <li>
        <b>mUSDC:</b> only the operator, as the mock's owner, can mint it. Ask the operator for the court fee before you file a claim.
      </li>
      <li>
        <b>Required deposits:</b> only the operator sets how much each agent company must hold in the vault (setRequired).
      </li>
    </ul>
  );
}

/**
 * The identity the mined register made, read back from the registry: its id from the Registered
 * event, then ownerOf and tokenURI. `failed` is the reason the read did not finish.
 */
export function RegisteredView({ hash, reg, sent, failed }: { hash: Hash; reg: Registered | null; sent: string | null; failed?: string | undefined }) {
  const onScan = <ExtLink href={txLink(HEDERA_CHAIN_ID, hash)}>the transaction on HashScan</ExtLink>;
  if (failed !== undefined) {
    return (
      <p className="error" role="alert">
        Mined, but the registry could not be read back just now ({failed}). See {onScan}; the Registered event there names the new agent id.
      </p>
    );
  }
  if (reg === null) {
    return (
      <p className="error" role="alert">
        Mined, but the receipt has no Registered event from the ERC-8004 identity registry, so this page cannot name a new identity. See {onScan}.
      </p>
    );
  }
  const doc = docFromUri(reg.agentURI);
  const same = sent !== null && reg.agentURI === sent;
  return (
    <div className="join-done">
      <h3>Registered: ERC-8004 agent {reg.agentId}</h3>
      <dl>
        <Row label="ERC-8004 agent id">{reg.agentId}</Row>
        <Row label="Owner">
          <ExtLink href={addressLink(HEDERA_CHAIN_ID, reg.owner)}>
            <span className="mono">{reg.owner}</span>
          </ExtLink>
        </Row>
        <Row label="Registration">{same ? 'inline in the registry, the same document this page showed before you signed' : 'inline in the registry, but not the document this page showed before you signed'}</Row>
        <Row label="Transaction">
          <ExtLink href={txLink(HEDERA_CHAIN_ID, hash)}>{`${short(hash)} on HashScan`}</ExtLink>
        </Row>
        <Row label="Registry">
          <ExtLink href={contractLink(REGISTRY)}>{`${short(REGISTRY)} on HashScan`}</ExtLink>
        </Row>
      </dl>
      {!reg.matches && (
        <p className="error" role="alert">
          The registry now gives another owner or registration than the Registered event named. Read it again on HashScan before you rely on it.
        </p>
      )}
      <h3>The registration as read from the registry</h3>
      {doc ? (
        <pre className="join-json">{JSON.stringify(doc, null, 2)}</pre>
      ) : (
        <p className="muted">
          The registry's URI is not an inline registration this page reads: <span className="mono">{short(reg.agentURI, 24)}</span>
        </p>
      )}
      {doc && <ListingCard doc={doc} agentId={reg.agentId} owner={reg.owner} />}
      <p className="next">
        <strong>Next:</strong> ask the operator to add agent {reg.agentId} to the party map. The cast page lists your shop from then on.
      </p>
    </div>
  );
}

/** The page's whole body, given the parameters read; the register flow keeps its own state. */
export function JoinView({ params, token, form, set, touched, touch, owner, flow }: {
  params?: JoinParams | undefined;
  token?: VaultToken | undefined;
  form: JoinForm;
  set: (f: JoinForm) => void;
  touched: ReadonlySet<JoinField>;
  touch: (f: JoinField) => void;
  owner: string | null;
  /** The register panel: LocalFlow on the page, a fixed phase in tests. */
  flow: (fields: ReactNode) => ReactNode;
}) {
  return (
    <>
      <div className="grid join-terms">
        <Agreement params={params} token={token} />
        <Costs params={params} token={token} />
      </div>
      {flow(<JoinFields form={form} set={set} touched={touched} touch={touch} />)}
      <div className="grid join-after">
        <Card title="What agent companies see" id="join-see">
          <p className="muted small">The cast page (Shops and agents) shows each registered shop like this, once the operator has added it to the party map. This is your registration as the form stands.</p>
          <ListingCard doc={joinDoc(form)} owner={owner} />
        </Card>
        <Card title="Next step" id="join-next">
          <p>
            To take orders and claims in this demo, the operator adds the shop to the party map. The <a href="#/cast">cast page</a> lists shops from that map, so yours appears there once it is added.
          </p>
          <h3>Operator steps</h3>
          <OperatorSteps />
        </Card>
      </div>
    </>
  );
}

/** The register call for the form, or null while anything is left to fix (the button stays off). */
export function joinPlan(form: JoinForm, onSent: (uri: string) => void): ((from: string) => LocalPlan) | null {
  if (Object.keys(joinProblems(form)).length > 0) return null;
  const doc = joinDoc(form);
  const uri = dataUri(doc);
  const size = uriSize(uri);
  if (size.problem) return null;
  return (from) => {
    onSent(uri);
    return {
      transactions: [buildRegister(uri)],
      summary: `Register ${doc.name} as a shop in the ERC-8004 identity registry on Hedera testnet. The new identity is owned by your account (${short(from)}).`,
      changes: [`A new ERC-8004 identity with the next free agent id, owned by your account. Its registration is the ${size.bytes.toLocaleString('en-US')}-byte document shown before, stored inline.`],
      notes: ['No money moves: the only cost is the network fee, in HBAR. The new identity is not in the party map until the operator adds it.'],
    };
  };
}

/** A shop registers an ERC-8004 identity from its own wallet. */
export function JoinPage() {
  const params = usePoll<ParamsBody>(READS.params(), 30000);
  const wallet = useWallet();
  const [form, setForm] = useState<JoinForm>(EMPTY_FORM);
  const [touched, setTouched] = useState<ReadonlySet<JoinField>>(new Set());
  // The URI the last preview was built from, so the read-back can say whether the registry holds the same one.
  const sent = useRef<string | null>(null);
  const token = params.data?.vaultToken;
  const plan = joinPlan(form, (uri) => {
    sent.current = uri;
  });

  async function after(hashes: Hash[], provider: EIP1193Provider): Promise<ReactNode> {
    const hash = hashes[0]!;
    try {
      return <RegisteredView hash={hash} reg={await readRegistered(provider, hash)} sent={sent.current} />;
    } catch (e) {
      return <RegisteredView hash={hash} reg={null} sent={sent.current} failed={e instanceof Error ? e.message.split('\n')[0] : 'no reason given'} />;
    }
  }

  return (
    <div className="join-page">
      <div className="page-head">
        <p className="eyebrow">Join as a shop</p>
        <h1>I run a shop</h1>
        <p className="lead">
          Register your shop in the ERC-8004 identity registry on Hedera testnet, from your own wallet. ERC-8004 is a standard registry of identities for agents and the businesses behind them: each entry has a number, the account that owns
          it, and a registration document that says what it is. Shopping agents and the cast page read it from there.
        </p>
      </div>
      <Banner fresh={params.data ?? undefined} error={params.error} token={token} />
      <JoinView
        params={params.data?.params}
        token={token}
        form={form}
        set={setForm}
        touched={touched}
        touch={(f) => setTouched((t) => (t.has(f) ? t : new Set([...t, f])))}
        owner={wallet.account}
        flow={(fields) => (
          <LocalFlow
            title="Register your shop"
            intro="Fill in the form; the registration document follows what you type. Your wallet signs one transaction, register on the ERC-8004 identity registry, and this page then reads the new identity back from the chain."
            plan={plan}
            after={after}
          >
            {fields}
          </LocalFlow>
        )}
      />
    </div>
  );
}
