# Recourse interfaces

The contract between the parts of this repo: names, types, ids, byte layouts, codes, rules and
tables that more than one package or contract depends on. Code in `packages/shared` and
`contracts/src/shared` implements this file; where they disagree, this file is right and the code
is a bug.

| | |
|---|---|
| Version | 1.9 |
| Install commit | `b3bf133` (`core: install`); the change log below dates every later version |
| Edits | Operator only from here. Ask for a change; do not edit in place. |

**Change log**

| Version | Date | Change |
|---|---|---|
| 1 | 2026-11-05 | First version. |
| 1.1 | 2026-11-05 | `minDeposit` start value 10 USDC; `RecourseCase` additions (payable `relayRuling`, relay quotes, extra views and errors, `openCase`/`refile` return the disputeId, indexed topics). |
| 1.2 | 2026-11-05 | Court evidence format and policy record; env names `PRECHECK_QUIET_S` and `SEND_PAUSE_WINDOWS` with `parseSendPauseWindows` and `isSendPaused`; Kleros and OffRamp ABI fragments. |
| 1.3 | 2026-11-05 | Env name `COURT_URL_TEMPLATE`; the `GET /claims` response shape `{rows, standing?, groups?}`. |
| 1.4 | 2026-11-05 | Docket and intake endpoints and bodies as built; deployment file shapes. |
| 1.5 | 2026-11-05 | `RecourseCase` error `TemplateNotSet()` (openCase and refile revert until template text and policy URI are set); refused relay refunds go to the fee pool. |
| 1.6 | 2026-11-05 | CCIP receive gas limits 150,000 both ways, from measurements. |
| 1.7 | 2026-11-05 | Claim expiry: Filed from `filedAt`, Contested and AtCourt from `preCheckedAt`, PreChecked never; pre-lock `claimTimeout` 64,800; `claimExpiresAfter`, `canExpireClaim`, optional `CaseView.expiresAt`; vault `ExitDue()`; `RecourseCase.markStale`, `expiresAt`, `claimTimeout`, `NotExpired`, constructor `claimTimeout_`; the expiry gap between the chains. |
| 1.8 | 2026-11-05 | Testnet demo USDC values: `courtFeeUsdc` 1,000,000, `handlingBase` 1,000,000, `handlingCap` 4,000,000, `minDeposit` 5,000,000 (pre-lock and locked). |
| 1.9 | 2026-11-05 | Roles without a Hedera account: `hederaAccountId` optional for every role and `HEDERA_ACCOUNT_IDS` may leave roles out; `hederaAccountIdOf`, `accountIdOf` and `HederaAccountIds` name the missing role where it is read. |

---

## 1. Packages and files

| Import | Path | Holds |
|---|---|---|
| `@recourse/shared` | `packages/shared/src/index.ts` | Browser-safe barrel: everything below except the Node entry. No `node:*` imports, no `Buffer`; its only dependency is `viem`. |
| `@recourse/shared/node` | `packages/shared/src/node/index.ts` | `loadSigner`, `loadKeyBytes`, `readParties`. Node only; never imported by the barrel. |
| `@recourse/shared/vectors/*` | `packages/shared/vectors/*.json` | Golden vectors and `params.json`. Forge reads them through `fs_permissions`. |

| Module (`packages/shared/src/`) | Exports |
|---|---|
| `records.ts` | `RecordKind`, `RECORD_KEYS`, `RECORD_LETTERS`, `RECORD_WRITERS`, `ATTRIBUTES`, `Attribute`, `RecordRefs`, `ZERO_HASH`, `emptyRecordRefs`, `ApprovalValue`, `ApprovalBasis` |
| `codes.ts` | `Gap`, `Answer`, `Ruling`, `Side`, `sideOf`, `ClaimStatus`, `CaseState`, `ExecutionState`, `BridgeMode`, `DecodeStatus`, `RulingIgnoredReason`, `ClaimRejectedReason` |
| `claim.ts` | `Claim` |
| `ids.ts` | `orderIdOf`, `claimIdOf`, `externalIdOf`, `externalIdUint`, `newOrderNonce`, `ORDER_ID_TAG` |
| `hashing.ts` | `canonicalJson`, `canonicalBytes`, `parseCanonical`, `isCanonical`, `recordHash`, `packHash`, `saltedField`, `hex32`, `isHex32` |
| `bytes.ts` | `sha256`, `utf8ToBytes`, `bytesToHex`, `hexToBytes` |
| `recordMsg.ts` | `encodeRecordMsg`, `decodeRecordMsg`, `RecordMsgFields`, `RECORD_MSG_MAX_BYTES` |
| `codec.ts` | `ClaimToCourt`, `RulingBack`, `encodeClaimToCourt`, `encodeRulingBack`, `tryDecodeClaimToCourt`, `tryDecodeRulingBack`, `payloadHash`, `extraArgsFor`, `CODEC_VERSION`, `CLAIM_TO_COURT_LEN`, `RULING_BACK_LEN`, `CLAIM_TO_COURT_WORDS`, `RULING_BACK_WORDS` |
| `faultRule.ts` | `runFaultRule`, `RuleInput`, `PrecheckResult`, `ReasonKey`, `REASON_KEYS`, `RuleStep`, `RULE_VERSION`, `ruleSlotFromDoc`, `withSlot`, `parsePrice`, `compareDecimal`, `normalise` |
| `settle.ts` | `settleOutcome`, `drawFromDeposit`, `SettleInput`, `SettleResult`, `SettleRow` |
| `status.ts` | `deriveStatus`, `claimExpiresAfter`, `canExpireClaim`, `StatusKey`, `STATUS_KEYS`, `StatusView`, `NextActor`, `NextCall`, `CaseView`, `BridgeView`, `LiveParams` |
| `params.ts` | `PARAMS` (`preLock`, `locked`), `ParamSet`, `handlingOf` |
| `addresses.ts` | `addressBook`, `chainSelectorOf`, `HEDERA_TESTNET_CHAIN_ID`, `ARBITRUM_SEPOLIA_CHAIN_ID` |
| `parties.ts` | `Party`, `Parties`, `PartyRole`, `PARTY_ROLES`, `HEDERA_ROLES`, `parseParties`, `partyByRole`, `partiesByRole`, `partyByAddress`, `hcsWritersFor`, `hederaAccountIdOf`, `HederaAccountIds`, `parseHederaAccountIds`, `accountIdOf` |
| `env.ts` | `ENV_NAMES`, `EnvName`, `VITE_ENV_NAMES`, `ENV_DEFAULTS`, `readEnv`, `parseSendPauseWindows`, `isSendPaused`, `SendPauseWindow`, `PauseChain` |
| `abi/erc8004.ts` | `erc8004IdentityAbi`, `erc8004ReputationAbi` |
| `abi/kleros.ts` | `klerosCoreAbi` (`arbitrationCost` both forms, `currentRuling`, `disputes`, `getNumberOfRounds`, `getRoundInfo`, `appealPeriod`, `appealCost`, `getTimesPerPeriod`, `passPeriod`, `draw`, `executeRuling`; events `DisputeCreation`, `NewPeriod`, `Draw`, `AppealPossible`, `AppealDecision`, `Ruling`), `sortitionModuleAbi` (`phase`, `passPhase`, `lastPhaseChange`, `minStakingTime`, `maxDrawingTime`, `disputesWithoutJurors`; `NewPhase`), `evidenceModuleAbi` (`submitEvidence`; `Evidence`), `disputeKitClassicAbi` (events `Contribution`, `ChoiceFunded`, `VoteCast`); items equal the `@kleros/kleros-v2-contracts` 0.12.0 Arbitrum Sepolia deployment ABIs |
| `abi/ccip.ts` | `ccipOffRampAbi` (`getExecutionState(bytes32 messageId)`, `typeAndVersion`; `ExecutionStateChanged`); items equal `@chainlink/contracts-ccip` 2.0.0 `abi/v2_0_0/offramp.json` |

| Solidity (`contracts/src/shared/`) | Holds |
|---|---|
| `RecourseTypes.sol` | `RecordRefs`, `Claim`, `ClaimToCourt`, `RulingBack` structs; `ClaimStatus`, `CaseState`, `BridgeMode`, `DecodeStatus` enums; `Codes` library (gap, answer, ruling, kind constants, `isGap`, `isAnswer`) |
| `RecourseIds.sol` | `RecourseIds.orderIdOf`, `claimIdOf`, `externalIdOf` |
| `BridgeCodec.sol` | `BridgeCodec.encodeClaimToCourt`, `encodeRulingBack`, `tryDecodeClaimToCourt`, `tryDecodeRulingBack`, `payloadHash`, `extraArgsFor`, `VERSION`, `CLAIM_TO_COURT_LEN`, `RULING_BACK_LEN` |
| `RecourseAddresses.sol` | Third-party address and selector constants (section 13) |

**Workspace.** pnpm workspace (`packages/*`, `services/*`, `apps/*`); every package is
`@recourse/<dir>`, `type: module`, with `exports["."] = "./src/index.ts"` (the library surface; a
service's entry point is `src/main.ts`, started with `tsx src/main.ts`). TypeScript sources are
used directly (no build step); each package's `tsconfig.json` extends `../../tsconfig.base.json`
(`moduleResolution: bundler`). Imports between source files use the `.js` extension. Tests:
`pnpm --filter <pkg> test --maxWorkers=2` (vitest; arguments go straight through, no `--`).
Dependency changes are one install at a time through the core owner.

**Foundry.** Project root `contracts/`. solc `0.8.37`, EVM `cancun`, optimizer 200 runs. Libraries
come from `node_modules` through `contracts/remappings.txt` (no git submodules; `contracts/lib/` is
unused): `@chainlink/contracts-ccip/` 2.0.0, `@chainlink/contracts/` 1.5.0, `@chainlink/local/`
0.3.1, `@kleros/kleros-v2-contracts/` 0.12.0, `@openzeppelin/contracts/` 5.6.1 (plus the
`@openzeppelin/contracts@5.3.0/` and `@openzeppelin/contracts@4.8.3/` prefixes the Chainlink
sources import), `forge-std/` v1.17.0. A clean clone needs only `pnpm install --frozen-lockfile`.
`fs_permissions`: read `../packages/shared/vectors`, read `../packages/court/template`, read-write
`../deployments`.

---

## 2. Records

Six records per order, one HCS message each on the one records topic. Kind = slot index in `RecordRefs`.

| Kind | Letter | Key | HCS message paid by | Written |
|---|---|---|---|---|
| 0 | I | `asked` | platform's agent | at checkout |
| 1 | S | `shown` | platform's agent | at checkout |
| 2 | A | `approval` | platform's agent | at checkout |
| 3 | O | `ordered` | platform's agent | at checkout; carries the x402 settlement tx id |
| 4 | D | `packed` | shop | at fulfilment |
| 5 | R | `arrived` | platform's agent (buyer-signed) | with the complaint |

**Compared attributes**, in this order: `brand`, `size`, `colour`, `quantity`, `price`, `merchant`.
The asked price is a cap.

**Core record document fields** (the only fields the fault rule reads; each record document may
carry more):

| Field | Records | Shape |
|---|---|---|
| `v` | all | `"1"` |
| `kind` | all | the record key, e.g. `"asked"` |
| `orderId` | all | `hex32` |
| `attrs` | all but approval | object; keys from the six attributes (others ignored), string values; may be absent (= empty) |
| `changes` | shown | array of attribute keys; `[]` when the screen showed no change. The rule reads only empty or non-empty |
| `approval` | approval | `"approved"` or `"not_approved"` |
| `approvalBasis` | approval | `"buyer"` (a human approved) or `"mandate"` (below the spend limit; the agent's mandate counts as approved). Ignored by the rule |
| `x402TxId` | ordered | non-empty string |

`ruleSlotFromDoc(kind, bytes, orderId)` maps a record document to its rule slot over these fields
only. It returns `{ok: false}` for non-canonical bytes, a `kind` field that is not that kind's key,
an `orderId` other than the expected one (so an old document cannot be re-wrapped for a new order),
or a core field of the wrong shape. It never fetches.

**HCS record message.** Exactly five string fields, canonical (section 7), at most 1,024 bytes:

```
{"cid":"<CID>","hash":"0x<64 hex>","kind":"<0-5>","orderId":"0x<64 hex>","v":"1"}
```

`hash` = `recordHash` of the document bytes pinned at `cid`. `kind` is a decimal string. Build and
read it only with `encodeRecordMsg(fields)` and `decodeRecordMsg(bytes)`; `decodeRecordMsg` rejects
non-canonical bytes, missing or extra fields, a `kind` outside "0"-"5", a `v` other than "1",
non-`hex32` hashes or ids, and bodies over 1,024 bytes. A record counts only when the message payer
(mirror node `payer_account_id`) is in the writer set: `hcsWritersFor(parties, kind)` = the
`hcsWriters` of the `shop` parties for kind 4, of the `platform` parties for every other kind.

---

## 3. Codes and enums

Ordinals are fixed in TypeScript and Solidity.

| Name | Values |
|---|---|
| `Gap` | 0 none, 1 asked vs shown, 2 shown vs ordered, 3 ordered vs packed or arrived, 255 no gap code |
| `Answer` | 0 unknown, 1 platform, 2 merchant (shop), 3 neither |
| `Ruling` | 0 refused, 1 platform, 2 merchant, 3 neither |
| `Side` (TS) | answer 1 `platform`, 2 `shop`, 3 `neither`, 0 `none` |
| `ClaimStatus` | None 0, Filed 1, PreChecked 2, Contested 3, AtCourt 4, Ruled 5, Settled 6, Closed 7, Expired 8 |
| `CaseState` | None 0, Received 1, Opened 2, RefilePending 3, Ruled 4, Relayed 5, Stale 6 |
| `ExecutionState` | Untouched 0, InProgress 1, Success 2, Failure 3 (CCIP OffRamp `getExecutionState`) |
| `BridgeMode` | Both 0, OutOnly 1, None 2 |
| `DecodeStatus` | Ok 0, BadLength 1, BadVersion 2, DirtyWord 3, BadCode 4 |

Gap 255 with answer 0 means not enough record. Gap 255 with answer 1 or 2 means a record is
missing and counts against that side. (255, 3) never occurs.

---

## 4. Structures

**`RecordRefs`** — `{ uint64 topicNum; uint64[6] seq; bytes32[6] hashes }`, indexed by kind.
`topicNum` is N of the topic id 0.0.N. A zero hash marks a missing record (its seq is 0). TS:
`topicNum: bigint`, `seq: bigint[6]`, `hashes: Hex[6]`.

**`Claim`** (`getClaim`, storage order):

| # | Field | Solidity | TS |
|---|---|---|---|
| 1 | `orderId` | bytes32 | Hex |
| 2 | `shop` | address | Address |
| 3 | `platform` | address | Address |
| 4 | `refs` | RecordRefs | RecordRefs |
| 5 | `basketUsdc` | uint256 (µUSDC) | bigint |
| 6 | `netLossUsdc` | uint256 (µUSDC, ≤ basket) | bigint |
| 7 | `filedAt` | uint64 (s) | bigint |
| 8 | `preCheckedAt` | uint64 (s; 0 before) | bigint |
| 9 | `gap` | uint8 | Gap |
| 10 | `answer` | uint8 | Answer |
| 11 | `packHash` | bytes32 | Hex |
| 12 | `contestedBy` | address (0 until contested) | Address |
| 13 | `sendCount` | uint8 | number |
| 14 | `lastSendAt` | uint64 | bigint |
| 15 | `lastMessageId` | bytes32 | Hex |
| 16 | `disputeId` | uint256 | bigint |
| 17 | `ruling` | uint8 | Ruling |
| 18 | `attempts` | uint8 (1 or 2 with a ruling) | number |
| 19 | `status` | ClaimStatus | ClaimStatus |

**`CaseView`** (`RecourseCase.caseOf(claimId)`): `CaseState state; bytes32 payloadHash; uint64
receivedAt; uint8 attempts; uint256[2] disputeIds; uint256[2] templateIds; uint8 ruling; uint64
ruledAt; uint8 sendCount; uint64 lastSendAt; bytes32 lastMessageId`. The TS `CaseView` adds
`expiresAt?` (from `RecourseCase.expiresAt(claimId)`; 0 or absent when unknown) and the KlerosCore
reads for the current dispute: `period?`, `currentRuling?`, `tied?`, `overridden?`.

**`BridgeView`** (TS) — one per known CCIP message of a claim: `{messageId, direction: 'toArbitrum'
| 'toHedera', sendNo (1 = first send), executionState: ExecutionState, sentAt}`. The latest message
on a leg is the one with the highest `sendNo` in that direction.

**`LiveParams`** (TS) — `{contestWindow, claimTimeout, resendGap, maxSends}` from Claims `params()`,
`{caseDeadline, maxOpenCases}` from Case `params()`, and `stuckAfter` from section 12. Callers read
the contract values live (they change when config is locked).

**`PrecheckResult`** (TS) — `{gap, answer, side, reasonKey, step, flaggedCells: {record,
attribute}[], notCompared: Attribute[], unreadPrice: record key[]}`. `RULE_VERSION` = `"1"`.

**Parties.** `deployments/parties.json` (path in `PARTIES_FILE`, absolute) is a JSON array, one
object per party:

| Field | Type | Rule |
|---|---|---|
| `role` | string | one of `deployer`, `ops-hedera`, `ops-arb`, `precheck-signer`, `platform`, `agent`, `shop`, `scheme`, `buyer`, `facilitator` |
| `evmAddress` | string | EVM address; normalised to EIP-55; unique across the file |
| `hederaAccountId` | string | `shard.realm.num`; omitted while the role has no Hedera account (`ops-arb` never has one). Read it with `hederaAccountIdOf(party)`, which throws `parties: <role> has no hederaAccountId` |
| `hcsWriters` | string[] | `shard.realm.num` accounts whose HCS messages count as this party's records; may be empty. The `platform` party lists the `agent` role's account |
| `agentId` | string or integer | ERC-8004 agent id (decimal); omitted when none; normalised to a decimal string |
| `displayName` | string | fictional display name, non-empty |

No other fields. A role may appear more than once (several shops); `partyByRole` requires exactly
one. Services read the file only through `readParties()` (Node) or `parseParties(json)`.

`HEDERA_ACCOUNT_IDS` is comma-separated `<role>=0.0.N` pairs, at most one for each of `deployer`,
`ops-hedera`, `precheck-signer`, `platform`, `agent`, `shop`, `scheme`, `buyer`, `facilitator`;
a role with no account yet is left out. Parsed by `parseHederaAccountIds` into
`HederaAccountIds` (a partial map); an unknown role, a malformed id or a repeated role is an
error. `accountIdOf(ids, role)` throws `HEDERA_ACCOUNT_IDS: no account id for <role>` for an
absent role, so a service fails when it needs that account, not at parse time.

**Key loading** (`@recourse/shared/node`). `loadSigner(envName)` returns a viem account;
`loadKeyBytes(envName)` returns the 32 decrypted secp256k1 bytes (for Hedera-native signing via
`PrivateKey.fromBytesECDSA`). The env var holds the absolute path of a Foundry v3 keystore
(scrypt or pbkdf2, aes-128-ctr); the password is read from `<path>.pass` with trailing whitespace
removed. Errors name the env var only. Nothing is ever logged.

---

## 5. Ids and the hash boundary

Ids use keccak256 over `abi.encode` (never packed). Documents use SHA-256 over exact bytes. Never mix.

| Id | Formula (ABI types) |
|---|---|
| `orderNonce` | 32 random bytes from the platform CSPRNG, chosen at checkout (`newOrderNonce()`) |
| `orderId` | `keccak256(abi.encode(string "recourse.order.v1", address platform, address shop, bytes32 orderNonce))` |
| `claimId` | `keccak256(abi.encode(uint256 chainId, address claims, bytes32 orderId))`; the claims contract passes `block.chainid` (296) and `address(this)`. One claim per order |
| `externalId` | `keccak256(abi.encode(uint256 chainId, address recourseCase, bytes32 claimId, uint8 attempt))`, attempt 1 or 2; the EvidenceModule takes it as `uint256` (`externalIdUint`) |
| `recordHash` | SHA-256 of the exact document bytes pinned to IPFS. Readers hash the fetched bytes, never a re-serialisation |
| `saltedField(value, salt)` | SHA-256(32 salt bytes ‖ UTF-8 value bytes); one salt per buyer field per order, held by the platform |
| `packHash` | `recordHash` of the canonical `precheck-result` document |
| `payloadHash` | keccak256 of a bridge payload |

Every 32-byte value in JSON is `hex32`: `0x` + 64 lowercase hex. The same 32 bytes go in
`RecordRefs.hashes[kind]` and in the HCS message `hash`.

---

## 6. (reserved)

---

## 7. Canonical form

Record documents, HCS message bodies and the `precheck-result` document are canonical JSON: RFC
8785 restricted to objects, arrays, strings and booleans. UTF-8, no BOM, no insignificant
whitespace, object keys sorted by UTF-16 code units, strings escaped as RFC 8785 (as ECMAScript
`JSON.stringify`), no trailing newline. JSON numbers and `null` are rejected; integers and amounts
are decimal strings; absent fields are omitted. Strings with lone surrogates are rejected.
`isCanonical(bytes)` is true only when re-serialising the parsed bytes gives the same bytes; a
non-canonical document counts as not held.

---

## 8. Bridge messages

Both messages are `abi.encode` of all-static fields in this order, so each field is one 32-byte
word. Version 1. Receivers decode only with `tryDecode*` (never reverts, never throws) and map a
non-Ok status to their ignore event; `encode*` reverts or throws on an out-of-range code.

**`ClaimToCourt`** (Hedera → Arbitrum), 23 words = 736 bytes. Gas limit 300,000 until measured.

| Word | Byte offset | Field | Type |
|---|---|---|---|
| 0 | 0 | `version` | uint8 |
| 1 | 32 | `claimId` | bytes32 |
| 2 | 64 | `platform` | address |
| 3 | 96 | `shop` | address |
| 4 | 128 | `gap` | uint8 |
| 5 | 160 | `answer` | uint8 |
| 6 | 192 | `refs.topicNum` | uint64 |
| 7-12 | 224-384 | `refs.seq[0..5]` | uint64 |
| 13-18 | 416-576 | `refs.hashes[0..5]` | bytes32 |
| 19 | 608 | `packHash` | bytes32 |
| 20 | 640 | `basketUsdc` | uint256 |
| 21 | 672 | `netLossUsdc` | uint256 |
| 22 | 704 | `filedAt` | uint64 |

**`RulingBack`** (Arbitrum → Hedera), 5 words = 160 bytes. Gas limit 400,000 until measured.

| Word | Byte offset | Field | Type |
|---|---|---|---|
| 0 | 0 | `version` | uint8 |
| 1 | 32 | `claimId` | bytes32 |
| 2 | 64 | `disputeId` | uint256 |
| 3 | 96 | `ruling` | uint8 |
| 4 | 128 | `attempts` | uint8 |

**Decode checks, in order:** `BadLength` unless the length is exactly 736 / 160; `DirtyWord` if any
uint8, uint64 or address word has bits set above its width; `BadVersion` unless version is 1;
`BadCode` if gap ∉ {0, 1, 2, 3, 255}, answer > 3, ruling > 3 or attempts ∉ {1, 2}; else `Ok`.

**Extra args.** `extraArgsFor(gasLimit)` = `0x181dcf10` ‖ `abi.encode(uint256 gasLimit, bool
true)`, the bytes of `Client._argsToBytes(GenericExtraArgsV2{gasLimit, allowOutOfOrderExecution:
true})`. Full finality (no finality override). Generic gas cap 3,000,000. Chain selectors are read
only through `chainSelectorOf(chainId)` / `RecourseAddresses`.

---

## 9. Fault rule

`runFaultRule(input: RuleInput): PrecheckResult`. Pure and deterministic. `RuleInput` has one
optional slot per record: `asked`, `ordered`, `packed`, `arrived` as `{attrs}`; `shown` as `{attrs,
changes}`; `approval` as `{approval, approvalBasis?}`. A record that is missing or failed
verification (zero hash, hash mismatch, non-canonical, wrong HCS payer) is left out; the caller
decides that, the rule never fetches.

**Held.** An attribute is filled when non-empty after trim. asked, ordered, packed and arrived are
held when at least one attribute is filled; shown is held when an attribute or its change slot is
filled. **Approved** only when shown is held, approval is present and its value is `approved`.

**Normalise:** trim, lower-case. **Price parses** when, after dropping commas, the text has no `-`
and exactly one run of `[0-9.]` containing a digit, matching `\d+(\.\d+)?`; other words are
ignored; prices compare as exact decimals. *Departs* (steps 2a, 2b; X against asked): for a price
that parses on both sides, X departs when it is above asked (a cap); otherwise when the texts
differ. *Differs* (steps 3-6): parsed prices unequal, otherwise texts differ. An attribute is
compared only where both records hold it.

**Decision table** (first match wins):

| Step | Condition | Reason key | Gap / answer | Cells flagged |
|---|---|---|---|---|
| 1 | ordered not held | `not_enough_record` | 255 / 0 | none |
| 2a | asked held; *off* = attributes asked and ordered both hold, where ordered departs from asked and shown holds no value for it that keeps to asked. If off is non-empty: | | | |
| 2a-i | …shown not held | `missing_record_platform` | 255 / 1 | asked, ordered (off attributes) |
| 2a-ii | …for some off attribute: change slot empty, or shown lacks it, or shown differs from ordered on it | `gap1_asked_vs_shown` | 1 / 1 | asked, shown, ordered (those attributes) |
| 2a-iii | …all off attributes shown, approval not approved | `gap1_asked_vs_shown` | 1 / 1 | asked, ordered (off attributes) |
| 2a-iv | …shown and approved: mark cleared, continue | | | |
| 2b | asked held; some attribute asked, shown and ordered all hold where shown departs from asked and ordered does not; skipped when the change slot is filled and approved | `gap1_asked_vs_shown` | 1 / 1 | asked, shown |
| 3 | shown held and differs from ordered | `gap2_shown_vs_ordered` | 2 / 1 | shown, ordered |
| 4 | packed held and ordered differs from packed | `gap3_ordered_vs_packed` | 3 / 2 | ordered, packed |
| 5 | packed and arrived held, packed differs from arrived | `gap3_packed_vs_arrived` | 3 / 2 | packed, arrived |
| 6 | arrived held, packed not held, ordered differs from arrived | `gap3_no_pack_record` | 3 / 2 | ordered, arrived |
| 7 | (asked or shown not held, or not approved) and packed not held | `not_enough_record` | 255 / 0 | none |
| 8 | asked or shown not held | `missing_record_platform` | 255 / 1 | none |
| 9 | not approved | `missing_record_platform` | 255 / 1 | none |
| 10 | packed not held | `missing_record_shop` | 255 / 2 | none |
| 11 | cleared at 2a-iv | `no_gap_approved_change` | 0 / 3 | none |
| 12 | otherwise | `no_gap_all_agree` | 0 / 3 | none |

A break always ranks above an absence. Mixed fault: the first break decides (gaps 1 and 2 rank
above 3, so the platform pays). An approval clears only the change it covers.

**Post-processing.** `notCompared`: an attribute held by some record is compared only if ordered
holds it and so does asked, shown or packed (or arrived, when packed is not held); every other held
attribute is not compared. A step 11 or 12 result with a non-empty `notCompared`, and a step 12
result with arrived not held, takes the key `no_gap_in_compared` (same gap and answer). On a gap
result the gap stands and `notCompared` is still returned. `unreadPrice`: every record holding a
price that does not parse. `side` follows the answer. `step` is the row id (`"2a-ii"`).
`flaggedCells` are `(record, attribute)` pairs in attribute order, then record order.

**Reason keys:** `not_enough_record`, `missing_record_platform`, `missing_record_shop`,
`gap1_asked_vs_shown`, `gap2_shown_vs_ordered`, `gap3_ordered_vs_packed`, `gap3_packed_vs_arrived`,
`gap3_no_pack_record`, `no_gap_approved_change`, `no_gap_all_agree`, `no_gap_in_compared`.
Reason sentences and display titles are written by the services that show them.

The acceptance fixtures are `packages/shared/vectors/fault-rule.json`.

---

## 10. Settle

`settleOutcome(input): SettleResult`, pure integer µUSDC, floor division. F = the fee escrowed for
this claim (`FeeEscrowed.amount`), never the current `courtFeeUsdc`. N = `netLossUsdc`. H =
`handlingOf(basket)` = min(`handlingBase` + floor(basket × `handlingBps` / 10,000), `handlingCap`).
`toShop` (owed from the platform's deposit, before any cap) and `refundToShop` are exactly the
`applyOutcome` arguments; `toPool` = F − `refundToShop`. "gap 1/2" = the stored pre-check gap is 1
or 2; gap 255 is "other".

| Row | Path and condition | toShop | refundToShop | toPool | feeOn | Settled.outcome |
|---|---|---|---|---|---|---|
| `uncontested_platform` | closed uncontested, answer 1 | N + H | F | 0 | none | – |
| `uncontested_other` | closed uncontested, answer 0, 2, 3 | 0 | F | 0 | none | – |
| `ruled_platform` | ruling 1 | N + H + F | 0 | F | platform | 1 |
| `ruled_shop` | ruling 2 | 0 | 0 | F | shop | 2 |
| `ruled_neither_flagged` | ruling 3, gap 1/2 | F | 0 | F | platform | 3 |
| `ruled_neither_other` | ruling 3, other gap | 0 | 0 | F | shop | 3 |
| `zero_twice_answer` | ruling 0, attempts 2, answer 1-3 | as the row for a ruling equal to the answer | 0 | F | as that row | the answer |
| `zero_twice_unresolved` | ruling 0, attempts 2, answer 0 | floor(F / 2) | 0 | F | split | 0 (unresolved) |
| `expired` | `expireClaim` from Filed, Contested or AtCourt | 0 | F | 0 | none | – |
| `undrawn` | batched claim not drawn | 0 | F | 0 | none | – |
| `not_settleable` | ruling 0 with attempts 1, or ruling > 3 | no call | | | | |

`drawFromDeposit(owed, held)` = `{paid: min(owed, held), notCovered: owed − paid}`; the mirror
never caps by deposit itself. `Settled.toShop` is the amount owed; `OutcomeApplied.paid` is the
amount paid.

---

## 11. Status

`deriveStatus(claim, caseView, bridgeViews, liveParams, now): StatusView`, pure; first match wins.
`claim` is the `getClaim` fields plus `undrawn: boolean` (true when a batch draw left the claim out;
false when unbatched). `caseView` is null until the case exists on Arbitrum. `StatusView =
{statusKey, nextActor, nextCall, deadline}`.

**Expiry on Hedera** (`claimExpiresAfter(claim, claimTimeout)`, `canExpireClaim(claim,
claimTimeout, now)`): `expireClaim` succeeds once now > the base + `claimTimeout`, strictly after.
The base is `filedAt` for a Filed claim and `preCheckedAt` for a Contested or AtCourt claim. A
PreChecked claim never expires; it closes uncontested after its window.

**Stuck**: the latest message on either leg is `Failure`, or is `Untouched` and now > `sentAt` +
`stuckAfter`; or the case is `Stale`; or the case is `Received` at or after `receivedAt` +
`caseDeadline`, or `RefilePending` at or after `ruledAt` + `caseDeadline`, or either of them at or
after `CaseView.expiresAt` when known (it can no longer open); or the claim can expire on Hedera.

| Order | Condition | statusKey | nextActor → nextCall | deadline |
|---|---|---|---|---|
| 1 | Expired | `expired` | none | – |
| 2 | Ruled or Settled, ruling 0, answer 0 | `unresolved` | anyone → `settle` (if Ruled) | – |
| 3 | Ruled, ruling 0, answer ≠ 0 | `zero_twice_answer_applied` | anyone → `settle` | – |
| 4 | Ruled | `ruled` | anyone → `settle` | – |
| 5 | Settled | `settled` | shop → `withdrawCredit` | – |
| 5a | Closed and undrawn | `closed_undrawn` | shop → `withdrawCredit` (refund) | – |
| 6 | Closed | `closed_uncontested` | shop → `withdrawCredit` | – |
| 7 | AtCourt and stuck | `stuck` | anyone → `expireClaim` (past the timeout or case dead; it succeeds only after the deadline), else `relayRuling` / `manualExecute` (return leg), else `resend` / `manualExecute` (outbound leg) | `preCheckedAt` + `claimTimeout` |
| 8 | AtCourt and (case RefilePending or case attempts = 2) | `refused_once` | anyone → `refile` (RefilePending; deadline `ruledAt` + `caseDeadline`), else court | – |
| 9 | AtCourt | `at_court` | none (case not yet received); keeper → `openCase` (Received); court (Opened); keeper → `relayRuling` (case Ruled); none (Relayed) | when Received, `receivedAt` + `caseDeadline` or `expiresAt` if earlier (row 8's refile deadline likewise) |
| 10 | Contested | `contested` | anyone → `sendToCourt`; once it can expire, anyone → `expireClaim` | `preCheckedAt` + `claimTimeout` (before expiry) |
| 11 | PreChecked and now > `preCheckedAt` + `contestWindow` | `window_lapsed` | anyone → `closeUncontested` | – |
| 12 | PreChecked, answer 0 | `no_finding` | shop → `contest` | `preCheckedAt` + `contestWindow` |
| 13 | PreChecked | `finding_made` | platform (answer 1), else shop → `contest` | `preCheckedAt` + `contestWindow` |
| 14 | Filed | `filed` | `preCheckSigner` → `recordPreCheck`; once it can expire, anyone → `expireClaim` | `filedAt` + `claimTimeout` (before expiry) |

Deadlines are inclusive (the action is still open at that second), except `caseDeadline` ones,
which are exclusive. A Settled claim after ruling 0 twice with an answer shows `settled`.

`StatusKey` (15): `filed`, `finding_made`, `no_finding`, `window_lapsed`, `closed_uncontested`,
`contested`, `at_court`, `stuck`, `refused_once`, `ruled`, `zero_twice_answer_applied`,
`unresolved`, `settled`, `expired`, `closed_undrawn`. Display words are chosen by the pages.

---

## 12. Parameters

Seconds; µUSDC (6 decimals). Deploy scripts read `packages/shared/vectors/params.json` (`preLock`
for the first deploy, `locked` at config lock). Running services read live values from the
contracts' `params()` views, never from this table.

The USDC values are sized for the testnet demo, where the faucet gives 20 USDC per address. The
platform deposits 18 USDC, the shop escrows 1 USDC per claim, and baskets are 2 to 3 USDC. The
largest uncontested platform-fault payout is net loss 3 + handling min(1 + 5% × 3, 4) = 4.15 USDC,
so the deposit covers four. A ruling against the platform also pays an amount equal to the fee: 5.15
USDC.

| Name | Pre-lock | Locked | Units |
|---|---|---|---|
| `contestWindow` | 600 | 1,800 | s |
| `courtFeeUsdc` | 1,000,000 | 1,000,000 | µUSDC |
| `handlingBase` / `handlingBps` / `handlingCap` | 1,000,000 / 500 / 4,000,000 | same | µUSDC / bps / µUSDC |
| `minDeposit` | 5,000,000 | same | µUSDC |
| `topUpWindow` / `exitDelay` | 604,800 / 600 | 604,800 / 10,368,000 | s |
| `resendGap` / `maxSends` | 1,800 / 5 | same | s / count |
| `caseDeadline` / `maxOpenCases` | 7,200 / 10 | same | s / count |
| `claimTimeout` (Filed from `filedAt`; Contested, AtCourt from `preCheckedAt`) | 64,800 | 64,800 | s |
| `stuckAfter` | 3,600 | same | s |
| `publishThreshold` | 20 | same | ruled cases |
| `batchSize` / `pBps` | 8 / 2,500 | same | count / bps |
| `gasClaimToCourt` / `gasRulingBack` / `gasCap` | 150,000 / 150,000 / 3,000,000 | same (measured: receive 95k and 37k worst case) | gas |
| `feePoolAlertMultiple` | 3 | same | × `arbitrationCost` |

Arbitrum court constants: court 8, 3 jurors, dispute kit 1, `extraData` = `abi.encode(uint256 8,
uint256 3, uint256 1)` (96 bytes), 3 choices.

---

## 13. Address book

`addressBook.hedera` / `addressBook.arbitrum` in TS, `RecourseAddresses` in Solidity
(`vectors/addresses.json` proves they match). Contracts deployed by this repo are not here; read
`$DEPLOYMENTS_DIR/*.json`. Local runs may pass a `*.local.json` whose `outside` key
(`offRampHedera`, `offRampArb`, `klerosCore`, `evidenceModule`) replaces those addresses for that run.

**Hedera testnet** — chain id 296, CCIP selector `222782988166878823`, mirror node
`https://testnet.mirrornode.hedera.com` (REST under `/api/v1`).

| Name | Address |
|---|---|
| CCIP Router | `0x802C5F84eAD128Ff36fD6a3f8a418e339f467Ce4` |
| OnRamp (to Arbitrum Sepolia) | `0x023B31f937cFb8ce59A264C73D3D4CB345Fb3Aef` |
| OffRamp (from Arbitrum Sepolia) | `0x7752798D2fD9e28b7020135A619dDD162d705f20` |
| LINK (18 decimals) | `0x90a386d59b9A6a4795a011e8f032Fc21ED6FEFb6` |
| USDC, HTS token `0.0.429274`, 6 decimals, ERC-20 facade | `0x0000000000000000000000000000000000068cDa` |
| HTS system contract | `0x0000000000000000000000000000000000000167` |
| PRNG system contract | `0x0000000000000000000000000000000000000169` |
| ERC-8004 IdentityRegistry (`0.0.7919997`) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ERC-8004 ReputationRegistry (`0.0.7919998`) | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

**Arbitrum Sepolia** — chain id 421614, CCIP selector `3478487238524512106`.

| Name | Address |
|---|---|
| CCIP Router | `0x2a9C5afB0d0e4BAb2BCdaE109EC4b0c4Be15a165` |
| OnRamp (to Hedera) | `0x6B9a7cF69F90Ae2659bfe3069fba5Aa308A48cC4` |
| OffRamp (from Hedera) | `0xC93218EB7B778bC0c13E5296140C8E4Fa1C440DA` |
| LINK | `0xb1D4538B4571d411F07960EF2838Ce337FE1E80E` |
| KlerosCore | `0xE8442307d36e9bf6aB27F1A009F95CE8E11C3479` |
| DisputeTemplateRegistry | `0xe763d31Cb096B4bc7294012B78FC7F148324ebcb` |
| EvidenceModule | `0xA88A9a25cE7f1d8b3941dA3b322Ba91D009E1397` |
| DisputeResolver (template test cases) | `0xed31bEE8b1F7cE89E93033C0d3B2ccF4cEb27652` |
| DisputeKitClassic (kit 1) | `0x0c38f115D001d3b5bBec5e8D44f78C7B61A27D94` |
| SortitionModule | `0xbAA5068F0bD1417046250A3eDe2B1F27e31383BD` |
| PNK | `0x34B944D42cAcfC8266955D07A80181D2054aa225` |
| PNK faucet | `0x9f6ffc13B685A68ae359fCA128dfE776458Df464` |

ERC-8004 ABI fragments (`erc8004IdentityAbi`: `register(string agentURI) returns (uint256
agentId)`, event `Registered(uint256 indexed agentId, string agentURI, address indexed owner)`,
`tokenURI`, `ownerOf`, `setAgentURI`, `isAuthorizedOrOwner`, `getVersion`, ERC-721 `Transfer`;
`erc8004ReputationAbi`: `giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string
tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)`, `getSummary`,
`getClients`, `getLastIndex`, `readFeedback`, event `NewFeedback`) were matched selector by selector
against the deployed implementations. `giveFeedback` reverts when the caller owns or operates the
agent, and for an unknown agent id.

---

## 14. Environment variables

Values never in git; `.env.example` lists every name. Key variables hold absolute keystore paths.
`readEnv(names, {defaults?, env?})` reads only names in `ENV_NAMES`; a missing name with no default
fails naming the variable, never echoing a value. `VITE_*` names are public build-time values for
`apps/web` and are never read by `readEnv`. New names are added to `ENV_NAMES` and `.env.example`
by the core owner.

| Group | Names |
|---|---|
| Chains and sources | `HEDERA_RPC_URL_1`, `HEDERA_RPC_URL_2`, `HEDERA_MIRROR_URL` (base URL), `ARB_RPC_URL`, `ARKIV_RPC_URL`, `ARKIV_ACCESS_KEY`, `X402_FACILITATOR_URLS`, `IPFS_PIN_API_URL`, `IPFS_PIN_API_KEY`, `IPFS_PIN_API_SECRET`, `IPFS_PIN_BUCKET`, `IPFS_GATEWAY_URL`, `LLM_API_KEY`, `LLM_MODEL`, `HCS_RECORDS_TOPIC_ID`, `ALERT_URL`, `SOURCIFY_VERIFIER_URL` |
| Keys | `KEYSTORE_DIR`, `DEPLOYER_KEY_FILE`, `OPS_HEDERA_KEY_FILE`, `OPS_ARB_KEY_FILE`, `PRECHECK_SIGNER_KEY_FILE`, `PLATFORM_KEY_FILE`, `AGENT_KEY_FILE`, `SHOP_KEY_FILE`, `SCHEME_KEY_FILE`, `BUYER_KEY_FILE`, `FACILITATOR_KEY_FILE` |
| Parties, deployments, tooling | `HEDERA_ACCOUNT_IDS`, `DEPLOYMENTS_DIR` (absolute), `PARTIES_FILE` (absolute), `SUITE_LOCK_FILE` |
| Contract deploy inputs | `RULING_RELAYER_ADDRESS`, `PRECHECK_SIGNER_ADDRESS`, `POOL_ADDRESS`, `ANVIL_PORT_HEDERA` |
| Agent and shop | `AGENT_SPEND_LIMIT_USDC` (µUSDC), `AGENT_MAX_ORDER_USDC`, `AGENT_DAILY_CAP_USDC`, `AGENT_APPROVAL_TTL_SEC`, `PRICE_ASSET`, `SHOP_PUBLIC_URL`, `SHOP_BASE_URL`, `SHOP_PORT`, `AGENT_PORT`, `SHOP_STANDING_CHECK` |
| Precheck and keeper | `PRECHECK_STATE_DIR`, `PRECHECK_PORT`, `KEEPER_STATE_DIR`, `KEEPER_PORT`, `KEEPER_REFILE_HOLD_MIN`, `KEEPER_ARB_CONFIRMATIONS`, `KEEPER_POLL_MS`, `KEEPER_AUTO_MANUAL_EXEC`, `PRECHECK_QUIET_S`, `SEND_PAUSE_WINDOWS` |
| Docket and intake | `DOCKET_PORT`, `DOCKET_STATE_DIR`, `DOCKET_STORE`, `DOCKET_PUBLISH_THRESHOLD`, `DOCKET_SAMPLE_MODE`, `DOCKET_Z`, `DOCKET_POLL_SECONDS`, `DOCKET_RETRY_SECONDS`, `DOCKET_RETRY_MAX`, `ARKIV_LIFETIME_DAYS`, `ARKIV_PAGE_SIZE`, `ARKIV_MIN_TGLM`, `SCHEME_MIN_HBAR`, `REVIEWS_ENABLED`, `REVIEW_VALUE_FAULT`, `REVIEW_VALUE_CLEAR`, `REVIEW_TAG1`, `INTAKE_PORT`, `INTAKE_CORS_ORIGIN`, `INTAKE_MAX_BYTES`, `INTAKE_RATE_PER_MIN`, `INTAKE_LLM_TIMEOUT_MS`, `INTAKE_LLM_PAUSE_MIN` |
| Status API | `STATUS_API_PORT`, `STATUS_API_STATE_DIR`, `POLL_MS`, `ARB_CONFIRMATIONS`, `ARB_LOG_CHUNK`, `SOURCE_TIMEOUT_MS`, `VIEW_CACHE_MS`, `LAG_WARN_S_HEDERA`, `LAG_WARN_S_ARB`, `LAG_WARN_S_HCS`, `IPFS_RATE_PER_MIN`, `DOCKET_URL`, `INTAKE_URL`, `AGENT_URL`, `PRECHECK_URL`, `WEB_ORIGIN`, `COURT_URL_TEMPLATE` |
| Web (public, build time) | `VITE_STATUS_API_URL`, `VITE_ARKIV_PUBLIC_RPC_URL`, `VITE_POLL_MS` |

Defaults in `ENV_DEFAULTS`: `HEDERA_MIRROR_URL` `https://testnet.mirrornode.hedera.com`,
`SUITE_LOCK_FILE` `/home/agentops/.local/state/recourse/suite.lock`, `PRECHECK_QUIET_S` `120`,
`SEND_PAUSE_WINDOWS` empty, `COURT_URL_TEMPLATE`
`https://v2-testnet.kleros.builders/#/cases/{id}/overview`.

- `PRECHECK_QUIET_S`: seconds a record topic must stay quiet before a missing record counts as
  final.
- `SEND_PAUSE_WINDOWS`: comma list of `<chain>@<fromISO>/<toISO>`, chain `hedera` or `arbitrum`,
  times UTC with `Z` (for example `hedera@2026-11-06T17:45:00Z/2026-11-06T18:55:00Z`). No
  transaction is sent to that chain while `from` ≤ now < `to`. `parseSendPauseWindows(text)`
  returns `{chain, from, to}` in unix seconds (empty text gives no windows) and throws
  `SEND_PAUSE_WINDOWS: ...` on any bad item; `isSendPaused(windows, chain, nowSec)` checks one
  instant. Precheck and keeper read both names.
- `COURT_URL_TEMPLATE`: link to a dispute's court page, with `{id}` replaced by the dispute id. The
  status API reads it.

Local anvil port ranges, per area: shared core 8540-8549, Hedera contracts 8550-8559, Arbitrum
case 8560-8569, agent and shop 8570-8579, precheck and keeper 8580-8589, docket and intake
8590-8599, web and status API 8600-8609.

---

## 15. Events, consumers and endpoints

**Contract events and fields.**

| Contract | Event (fields) |
|---|---|
| `RecourseClaims` | `ClaimFiled(claimId, orderId, shop, platform, refs, basketUsdc, netLossUsdc, filedAt)`, `PreCheckRecorded(claimId, gap, answer, packHash)`, `Contested(claimId, by)`, `ClosedUncontested(claimId, answer, toShop)`, `SentToCourt(claimId, messageId)`, `RulingReceived(claimId, disputeId, ruling, attempts, messageId)`, `RulingIgnored(claimIdOrZero, reason, messageId)`, `Settled(claimId, outcome, toShop, toPool)`, `ClaimExpired(claimId)`, `BatchOpened(batchId, pBps, k, claimIds)`, `BatchDrawn(batchId, seed)`, `ClosedUndrawn(claimId, batchId)`, `PeerSet(peer)`, `ParamsSet(...)`, `BridgeModeSet(mode, relayer)`, `ExtraArgsSet(bytes)`, `ConfigLocked()`, `PreCheckSignerSet(signer)`, `FeeTokenSet(token)`, `NativeFunded(from, amount)`, `NativeSwept(to, amount)`, `LinkSwept(to, amount)` |
| `DepositVault` | `ClaimsBound(claims)`, `UsdcAssociated(responseCode)`, `DepositPosted(platform, from, amount, balance)`, `RequiredSet(platform, amount)`, `FeeEscrowed(claimId, shop, amount)`, `OutcomeApplied(claimId, platform, shop, paid, refund, toPool)`, `Shortfall(claimId, platform, amount)`, `CreditWithdrawn(account, amount)`, `TopUpClockStarted(platform, deadline)`, `TopUpCleared(platform)`, `ExitRequested(platform, availableAt)`, `Exited(platform, amount)` |
| `RecourseCase` | `ClaimReceived(claimId, messageId, payload)` (messageId 0 from `relayClaim`), `ClaimDuplicate(claimId, messageId)`, `ClaimRejected(messageId, reason)`, `ClaimStale(claimId)`, `CaseOpened(claimId, disputeId, attempt)`, `DisputeRequest(arbitrator, disputeId, externalId, templateId, templateUri)`, `Ruling(arbitrator, disputeId, ruling)`, `RefileNeeded(claimId)`, `RulingFinal(claimId, disputeId, ruling, attempts)`, `RuleIgnored(disputeId, ruling)`, `RulingRelayed(claimId, disputeId, ruling, messageId)`, `FeePoolFunded(from, amount)`, `FeePoolWithdrawn(to, amount)`, `LinkSwept(to, amount)`, `TrustedRelaySet(relay)`, `PeerSet(peer)`, `ParamsSet(caseDeadline, maxOpenCases, resendGap, maxSends)`, `ConfigLocked`, `TemplateTextSet(textHash)`, `PolicyURISet(uri)`, `ExtraArgsSet(bytes)` |

**Who consumes what.**

| Consumer | Hedera (`RecourseClaims`, `DepositVault`) | Arbitrum and other reads |
|---|---|---|
| precheck | `ClaimFiled` | HCS records topic, IPFS documents |
| keeper | `ClaimFiled`, `PreCheckRecorded`, `Contested`, `ClosedUncontested`, `SentToCourt`, `RulingReceived`, `RulingIgnored`, `Settled`, `BatchOpened`, `BatchDrawn`, `ClosedUndrawn`, `ClaimExpired`, `BridgeModeSet`; vault `creditOf` | `ClaimReceived`, `ClaimDuplicate`, `ClaimRejected`, `ClaimStale`, `CaseOpened`, `DisputeRequest`, `Ruling`, `RefileNeeded`, `RulingFinal`, `RulingRelayed`, `FeePoolFunded`; `currentRuling`; KlerosCore `Draw`, the EvidenceModule evidence event for our external ids, appeal contributions (alert only); both OffRamps `getExecutionState` |
| docket | `ClaimFiled`, `PreCheckRecorded`, `ClosedUncontested`, `RulingReceived`, `Settled`, `BatchOpened`, `BatchDrawn`, `ClosedUndrawn`, `ClaimExpired`, `OutcomeApplied`, `Shortfall` | `CaseOpened` (dispute ids) |
| shop | `ClaimFiled` and `PreCheckRecorded` for its claims; vault `inGoodStanding` before checkout | none |
| status-api | every event of both contracts | every `RecourseCase` event, OffRamp state, KlerosCore period, Arkiv, docket write status |

Batch names (`openBatch`, `drawBatch`, `BatchOpened`, `BatchDrawn`, `ClosedUndrawn`, `batchOf`,
`getBatch`) are coded against only once the Hedera contracts confirm batch draws are built.

**Service HTTP endpoints** (JSON).

| Service | Endpoint | Returns |
|---|---|---|
| status-api | `GET /health` | per-chain cursor, lag, last error |
| status-api | `GET /params` | live params, addresses, `preCheckSigner`, owner, lock state, disclosed owner powers |
| status-api | `GET /claims?party=&status=` | `{rows, standing?, groups?}`; `standing` and `groups` only when `party` is given: `standing` is the `GET /parties/:address` body, `groups {waitingOnYou, waitingOnOther, openToAnyone, owedToYou, finished}` are claimId lists. `rows`: `claimId`, `orderId`, `shop`, `platform`, `filedAt`, `gap` and `answer` (null before the pre-check), `statusKey`, `nextActor`, `nextCall`, `deadline`, `findingSide`, `owed`, `paid`, `credited`, `notCovered`, `escrow {amount, fate}`, `updatedAt` |
| status-api | `GET /claims/:claimId` | claim fields, `statusKey`, records (kind, seq, hash, cid, held), pre-check result, contest, court (attempts, disputeIds, period, currentRuling), bridge (messageId, direction, sendNo, executionState), money (as the rows, incl. `escrow {amount, fate}`), docket (writeStatus, entityKey), events (name, chain, tx, time) |
| status-api | `GET /parties/:address` | role, balance, required, inGoodStanding, topUpDeadline, credit, escrowOpen, openClaims, exitRequestedAt |
| status-api | `GET /search?q=` | matches on claim, order, dispute, message, tx, hash, HCS seq |
| docket (port 8707) | `GET /write-status/:claimId` | `{claimId, writeStatus: none\|pending\|written\|failed, store: arkiv\|local, entityKey (0x…, local:0x… or null), attempts, lastError, errorKind: auth\|quota\|gas\|rpc\|null, updatedAt (unix s), settlementPending, reviews {platform, shop: {status: cut\|none\|pending\|sent\|failed\|skipped, tx?}}}`; 404 `{error: "unknown claim"}`, 400 on a bad id |
| docket | `GET /docket/cases`, `GET /docket/counts`, `GET /rates?platform=\|shop=`, `GET /health` | docket rows, monthly counts, Wilson 95% fault rates (uncontested and unresolved counted beside), health |
| intake (port 8716) | `POST /intake` | `ruleResult` (the shared fault rule), `llmTag` (null when off), `llmStatus` (`disabled` without a key), `packHash`, `packCid` (null without a pin key); 413 over the size cap, 429 per-IP limit |
| intake | `GET /intake/stats`, `GET /health` | counters, health |
| shop | x402 route (path set by the shop) | 402 with price and `payTo`; the agent reads both from the 402 |

---

## 16. Contract interfaces

### Hedera: `RecourseClaims`, `DepositVault`

`IRecourseClaims.sol` and `IDepositVault.sol` in `contracts/src/hedera/` are the code form of this
list.

- Claim state machine: none → Filed (`fileClaim`) → PreChecked (`recordPreCheck`) → Contested
  (`contest`, inside the window) or Closed (`closeUncontested`, after it) → AtCourt (`sendToCourt`)
  → Ruled (`_ccipReceive` or `recordRuling`) → Settled (`settle`). `expireClaim` moves a claim to
  Expired and refunds the fee in full: a Filed claim once now > `filedAt` + `claimTimeout`, a
  Contested or AtCourt claim once now > `preCheckedAt` + `claimTimeout` (otherwise
  `NotExpired(expiresAfter)`). PreChecked claims never expire. Settled, Closed and Expired are
  terminal.
- `fileClaim(orderNonce, platform, refs, basketUsdc, netLossUsdc) returns (claimId)`: shop =
  `msg.sender`; `orderId` is computed on chain; `netLoss ≤ basket`; ordered hash non-zero; reverts
  `BasketTooLarge` above 2^128 − 1 (fee and handling bounds in `setParams` likewise).
- `recordPreCheck(claimId, gap, answer, packHash)` by `preCheckSigner`; rejects (255, 3).
- `contest(claimId)`: platform when answer 1; shop when answer 0, 2 or 3.
- `RulingIgnored(claimIdOrZero, reason, messageId)` reasons: 1 wrong source selector, 2 sender ≠
  peer, 3 undecodable (`tryDecodeRulingBack` ≠ Ok, covers ruling > 3 and attempts ∉ {1, 2}), 4
  mode ≠ Both, 5 unknown claim, 6 status ≠ AtCourt (duplicates, resend copies, late after expiry),
  8 ruling 0 with attempts ≠ 2 (claim stays AtCourt). 7 is unused. `messageId` is 0 from
  `recordRuling`. `_ccipReceive` never reverts on data.
- `recordRuling(claimId, disputeId, ruling, attempts)`: `rulingRelayer` only, in modes OutOnly and
  None.
- Views: `getClaim`, `params()` → `{contestWindow, claimTimeout, courtFeeUsdc, handlingBase,
  handlingBps, handlingCap, resendGap, maxSends}`, `previewSettle(claimId) → (toShop, refund,
  toPool)`, `handlingOf(basket)`, `quoteSend(claimId)` (fee in the current fee token's units),
  `batchOf`, `getBatch`, `peer`, `preCheckSigner`, `configLocked`, `extraArgs`, `bridgeMode`,
  `rulingRelayer`, `feeToken()`. Unknown ids return zeros.
- CCIP fees in LINK or native HBAR: `feeToken()` (LINK by default; `address(0)` = native),
  owner-only `setFeeToken(address)` (LINK or 0 only, always callable, `FeeTokenSet(token)`),
  payable `fundNative()` (`NativeFunded(from, amount)`), `sweepNative(to)` before lock
  (`NativeSwept`); errors `NativeShort(have, need)`, `LinkShort(have, need)`. In native mode the
  Router's fee is in 8-decimal tinybars inside the EVM; RPC callers scale by 10^10.
- Owner, before lock: `setPeer`, `setParams`, `setPreCheckSigner`, `setBridgeMode(mode, relayer)`,
  `sweepLink`, `bindClaims`, `lockConfig`. Always (disclosed): `setExtraArgs`, `setRequired`,
  `setFeeToken`.
- Vault: constructor `(usdc, pool, owner)` plus one-time `bindClaims`; `escrowFee(shop, platform,
  amount, claimId)`; `associateUsdc`; `setParams`; `lockConfig`; `requestExit` / `exit` (`exit`
  reads `exitDelay` at exit time). Once a platform's exit is due (`exitRequestedAt` ≠ 0 and now ≥
  `exitRequestedAt` + `exitDelay`), `escrowFee`, and so `fileClaim`, revert `ExitDue()`. Claims
  already open run out, and claims are accepted again after `exit`. Views `depositOf`, `requiredOf`, `creditOf`, `escrowOf(claimId)`,
  `shopEscrowOf(shop)`, `totals()` (deposits, escrow, credits), `topUpDeadline(platform)` (0 when
  clear), `openClaimsOf(platform)`, `exitRequestedAt`, `usdcAssociated`, `inGoodStanding`. The
  top-up clock starts only when a payout takes the deposit from at least `required` to below it.
  The vault is non-payable. Credits leave only through `withdrawCredit` to `msg.sender`.
- `deployments/hedera.json` top-level keys: `contracts {claims, vault}` (each `{address, id}`),
  `deployOrder`, `startTimestamp`, `associationTx`, `mode`, `params {preLock, locked}`,
  `extraArgs`, `sizes`, `gas`, `dpTx`, `sourcify`. ABIs in `deployments/abi/RecourseClaims.json`
  and `deployments/abi/DepositVault.json`.

### Arbitrum: `RecourseCase`

`IRecourseCase.sol` in `contracts/src/arbitrum/` (as of `87f6c83`) is the code form of this list.

- `CaseState` and `CaseView` as in sections 3 and 4; `caseOf(bytes32 claimId) returns (CaseView)`.
- Transitions: None → Received (`_ccipReceive` or `relayClaim`, valid); Received → Opened
  (`openCase` before `receivedAt` + `caseDeadline` and before `expiresAt`, attempt 1) or Stale
  (`openCase` at or after either, or `markStale`); Opened → RefilePending (`rule`, attempt 1,
  ruling 0) or Ruled (`rule`, attempt 1 ruling 1-3 or attempt 2 ruling 0-3) or Stale (`markStale`);
  RefilePending → Opened (`refile` before `ruledAt` + `caseDeadline` and before `expiresAt`,
  attempt 2) or Stale (`refile` at or after either, or `markStale`); Ruled → Relayed (first
  `relayRuling`). A Stale `openCase` or `refile` spends nothing and returns 0.
- Expiry: `expiresAt = filedAt + claimTimeout`, set when the claim is received. `claimTimeout` is
  Hedera's locked value, fixed at deploy (constructor's 9th argument `claimTimeout_`, non-zero).
  `markStale(bytes32 claimId)` is permissionless once `block.timestamp ≥ expiresAt(claimId)`. It
  moves Received, Opened or RefilePending to Stale, frees the open-case slot (Opened,
  RefilePending), spends nothing and emits `ClaimStale`. It reverts `NotExpired(uint64 expiresAt)`
  before then and `WrongState` from any other state. A ruling for a Stale case is ignored.
- Known gap: Arbitrum's expiry counts from `filedAt`, while Hedera's court-stage expiry counts from
  `preCheckedAt`, which is later by the pre-check's delay (minutes). A ruling that arrives in that
  gap, about 18 h after filing, is ignored on Arbitrum once the case is Stale. The claim then
  expires on Hedera and the fee is refunded.
- Views: `expiresAt(bytes32 claimId) returns (uint64)` (0 when unknown), `claimTimeout() returns
  (uint64)`, `claimOfDispute(uint256 disputeId) returns (bytes32 claimId, uint8 attempt)`,
  `openCases()`, `feePool()`, `costNow()`, `EXTRA_DATA`, `NUMBER_OF_CHOICES`, `trustedRelay()`,
  `locked()`, `peer()`, `params() returns (uint64 caseDeadline, uint16 maxOpenCases, uint64
  resendGap, uint8 maxSends)`, `extraArgs()`, `policyURI()`, `externalIdOf(bytes32 claimId, uint8
  attempt) returns (uint256)`, `quoteRelay`, `quoteRelayNative`, `hederaSelector()`,
  `templateParts()`, `arbitrator()`, `templateRegistry()`, `link()`, `TEMPLATE_TAG()`.
- Functions: `openCase(bytes payload)` and `refile(bytes payload)` (the payload from
  `ClaimReceived`) return the disputeId (0 when the claim went Stale); `relayRuling(bytes32
  claimId)` is payable: with no value it pays the CCIP fee in LINK held by the contract, with value
  it pays from `msg.value` and refunds the surplus to the caller (the fee pool is never touched);
  `markStale(bytes32 claimId)`, `relayClaim(bytes payload)`, `setTrustedRelay(address)`, `setPeer(address)`, `setParams(uint64
  caseDeadline, uint16 maxOpenCases, uint64 resendGap, uint8 maxSends)` before lock (event
  `ParamsSet(caseDeadline, maxOpenCases, resendGap, maxSends)`), `setTemplateText(string[4] parts)`.
- Indexed topics: `claimId` on `ClaimReceived`, `ClaimDuplicate`, `ClaimStale`, `CaseOpened`,
  `RefileNeeded`, `RulingFinal` and `RulingRelayed`; `messageId` on `ClaimReceived` and
  `ClaimRejected`.
- `ClaimRejected(messageId, reason)` reasons: 1 wrong source selector, 2 wrong sender, 3
  undecodable (`BadLength`, `DirtyWord` or `BadCode`), 4 unknown version (`BadVersion`).
- Errors: `NotArbitrator`, `UnknownDispute`, `WrongState(bytes32 claimId, CaseState state)`,
  `HashMismatch`, `CapReached`, `FeePoolLow(uint256 have, uint256 need)`, `SendTooSoon(uint64
  nextAt)`, `MaxSendsReached`, `PeerNotSet`, `InsufficientLink(uint256 have, uint256 need)`,
  `ConfigIsLocked`, `NotTrustedRelay`, `RelayDisabled`, `ZeroAddress`, `WithdrawTooLarge`,
  `EthSendFailed`, `ZeroGasLimit`, `InsufficientValue(uint256 have, uint256 need)`, `BadParams`,
  `BadPayload`, `TemplateNotSet`, `NotExpired(uint64 expiresAt)`.
- `deployments/arbitrum.json` keys written separately: `testCases`, `gas`, then the deploy keys.
  ABI in `deployments/abi/RecourseCase.json`.

### Court: evidence and policy (`packages/court`)

`packages/court/src/evidence.ts` and `policy.ts` (as of `7ea0bc8`) are the code form of this list.

- `buildEvidence(input) returns EvidenceBundle` is pure: same input, same bytes. Input: the
  decoded `ClaimToCourt`, `attempt` (1 or 2), `externalId` (`externalIdUint`), the documents for
  the held slots (`{kind, bytes, cid?, hcsSeq?}`), the `precheck-result` document (`{bytes, cid?}`),
  optional `notice` and optional `fileURI`.
- `EvidenceBundle {version "1", claimId, attempt, externalId, evidence, byteLength, sha256,
  slots}`. `evidence` is the exact string posted to `EvidenceModule.submitEvidence(externalId,
  evidence)`; `byteLength` and `sha256` are over its UTF-8 bytes.
- `evidence` is inline JSON `{name, description, fileURI?}` (`fileURI` is an optional
  `/ipfs/<cid>` of a pinned copy). `description` is Markdown and holds, in order: a header line,
  the pre-check finding, one section per record kind in order (a held record shows its SHA-256,
  HCS sequence and CID, then the document byte for byte in a fenced block; an absent or rejected
  one is a line), and the `precheck-result` document byte for byte with its SHA-256.
- Cap: 16 KB = 16,384 UTF-8 bytes (`EVIDENCE_MAX_BYTES`); larger throws `EvidenceTooLarge`.
- Checks, in order: SHA-256 of the `precheck-result` document equals the payload `packHash`; each
  held document's SHA-256 equals that slot's `hcsHash` in the pre-check document. A mismatch, or a
  held slot with no document, throws `EvidenceHashMismatch(kind)`. A held slot whose
  `refs.hashes[k]` is zero or differs is marked `fromIndex`.
- Fields read from the `precheck-result` document (anything else is ignored; a bad shape throws
  `EvidenceInputError`): `records`, exactly 6 entries in record-kind order, each `{outcome:
  "held" | "absent" | "rejected", hcsHash (32-byte hex, required when held), cid?, seq? (decimal
  string), reason?}`; `gap`, `answer`, `reasonKey` (strings; `result.gap`, `result.answer`,
  `result.reasonKey` are read when the top-level field is absent); `result.step` and
  `result.flaggedCells[] {record, attribute}`.
- Policy: `packages/court/policy/policy-v1.md`, 5,769 bytes, SHA-256
  `0x59c50b00799644b71422702233e13b2157b2f362fdbe3717b394940834939d43`, stored as one raw IPFS
  block, so its CIDv1 is the same wherever it is pinned:
  `bafkreiczyufqa6mwis3riitqeiz6cozbk6zpgyx5xy3rpm4usqedje45im`. `POLICY.uri`, the template's
  `policyURI`, is `/ipfs/` + that CID.

---

## 17. Deployment files

`deployments/` holds one JSON file per chain. Testnet files are committed. `*.local.json` files are written by the `DeployLocal` scripts and are gitignored. Addresses are 0x hex. Block numbers, gas and small integers are JSON numbers. Wei amounts, dispute ids, external ids and CCIP selectors are decimal strings. Writers only add keys; they never rename or move them.

**`arbitrum.json`** (Arbitrum Sepolia)
- `chainId`: 421614.
- `contracts.case.address`.
- `startBlock`: the L2 block from the deploy receipt.
- `deployTx`, `deployedAt` (ISO UTC), `deployer`.
- `constructorArgs`:
  - `router`, `link`, `arbitrator`, `templateRegistry`, `owner`;
  - `hederaSelector`;
  - `params {caseDeadline, maxOpenCases, resendGap, maxSends}`;
  - `relayGasLimit`;
  - `claimTimeout` (Hedera's locked value, from `params.json` `locked.claimTimeout`).
- `config`: `templateTag`, `templateVariant`, `templateTextHash`, `policyURI`, `extraArgs`, `extraData`, `numberOfChoices`.
- `abi`.
- `gas.<op> {used, limit}`.
- `testCases[]`: DisputeResolver trial disputes.

`arbitrum.local.json` adds `rpcUrl`, `mocks {...}`, `outside {offRampHedera, offRampArb, klerosCore, evidenceModule}` and `mocksOnly`. Read `peer()`, `locked()`, `feePool()`, `trustedRelay()` and the case states live from the contract.

**`hedera.json`** (Hedera testnet): shape defined by the Hedera deploy scripts (see `contracts/script/hedera/`). `hedera.local.json` adds:
- `chainId` 31337;
- `startBlock`, `startTimestamp`;
- `local {router, link, usdc, hts, prng, simulator, arbSelector, casePeer, feeToken, ccipFee}`;
- `roles {owner, rulingRelayer, preCheckSigner, platform, shop, pool}`;
- `mode` (0 Both, 1 OutOnly, 2 None).

**`abi/`**: `RecourseClaims.json`, `DepositVault.json`, `RecourseCase.json`. Each holds the ABI array only.

**`parties.json`**: see §14 and `parseParties`.

