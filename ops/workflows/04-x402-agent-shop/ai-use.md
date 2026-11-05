# AI use: x402 shop and agent, renderer, records client, claim filing

Everything in this area was written by Claude (Anthropic, Opus 5.5) running as one coding agent in
this repo, and committed through `ops/scripts/commit.sh`. No person has reviewed it line by line
yet. The table says how each part was made and what checks it.

| Files | How it was made | Checked by |
|---|---|---|
| `packages/renderer/src/index.ts` | Written by the agent: the approval text, change slot and absent marker, as a pure function | `packages/renderer/test/renderer.test.ts` against golden text files and their hashes, plus a child process that renders the same input again and must get the same hash |
| `packages/records/src/records-client.ts`, `hcs.ts`, `topic.ts`, `mirror.ts`, `journal.ts`, `open.ts` | Written by the agent on top of the shared codec, ids and party map | `packages/records/test/records-client.test.ts` and `topic.test.ts` against the in-memory ledger, including 100 random crash and fault sequences in which no record may land twice |
| `packages/records/src/car.ts`, `ipfs.ts` | Written by the agent: one-block CARs, Filebase pinning, the local content store (`IPFS_PIN_API_URL=file://...`) and `openPinClient` | `car-ipfs.test.ts` (the published court policy CID and hash pin the CID derivation) and `local-store.test.ts` (same CIDs as a remote pin, atomic writes, damaged copies, no path from a caller's string, provider selection) |
| `packages/records/src/h0-ids.ts`, `lock.ts`, `accounts.ts`, `registration.ts`, `preflight.ts`, `log.ts` | Written by the agent | `h0-ids.test.ts` (env file and party map writes, dry run writes nothing) and `lock.test.ts` (busy, released on error, taken over from a dead process) |
| `packages/records/src/testing.ts` | Written by the agent. In-memory HCS ledger, mirror REST and IPFS stand-ins for tests and local runs only; they report `simulated: true` | used by every records, agent and shop test, and by the local demo |
| `services/shop/src/*.ts` | Written by the agent: x402 order and check routes, facilitator ladder, self-hosted facilitator, order book, standing check, packed record, claim input and claim filing | `services/shop/test/*.test.ts` (routes, refusals before payment, payer check before settlement, ladder failover) and `filing.anvil.test.ts` on the repo's contracts deployed to a local anvil (exact fee approval, one filing, resend of the journaled bytes after a crash) |
| `services/shop/src/local-facilitator.ts`, `local-chain.ts` | Written by the agent. The simulated facilitator moves no money and its settlement ids start with `fake-settlement:`; the local chain uses anvil's public development accounts | tests and local runs only |
| `services/agent/src/*.ts` | Written by the agent: the buy flow, spend limits, EIP-712 approvals and arrived reports, record documents, x402 payment with a single-payment guarantee, the approvals API and the command helpers | `buy.test.ts`, `after-delivery.test.ts`, `x402-pay.test.ts`, and `invariants.test.ts` (100 random crash sequences, two orders each: every paid order settled once, each of its records on the topic once) |
| `services/agent/scripts/local-demo.ts` | Written by the agent: one whole order on this machine, from checkout to `fileClaim` on a local anvil | `local-demo.anvil.test.ts`, and run by hand with and without `--serve` |
| `services/agent/scripts/{order,approve,complain,h0-setup,pay-once,live-order}.ts`, `services/shop/scripts/{pack,file-claim}.ts` | Written by the agent. Every command is a dry run unless given `--send`, `--broadcast` or `--yes` | typechecked; `pack` and `file-claim` run against a served local demo (dry run and an idempotent `--send`); `order` dry-run against the local demo shop; `h0-setup` dry-run against the host env (stops at the unfunded accounts). None has run against Hedera testnet yet |
| `services/agent/scripts/{contest,withdraw-credit}.ts`, `services/shop/src/{claim-actions,reverts}.ts` | Written by the agent: contesting a pre-check as the losing side, withdrawing vault credit, and readable names for every revert either Hedera contract raises (`ExitDue` included). Dry run unless given `--send`; signing goes through the role keystore | `contest-withdraw.anvil.test.ts` runs both commands as child processes against the contracts on a local anvil, signing from throwaway keystores: wrong side, wrong key, a full contest, a closed window, a withdrawal with the credit before and after, and filing refused with `exit_due`. Not run against Hedera testnet yet |

How to run the checks: `pnpm test` and `pnpm run typecheck` in `packages/records`,
`packages/renderer`, `services/shop` and `services/agent`; `pnpm test:anvil` in `services/shop`
and `services/agent` (under the suite lock; they deploy the contracts to a local anvil).

Keys: no key was printed, logged or passed on a command line. Local runs and tests use generated
keys and anvil's public development accounts. One dry run of `order` decrypted the agent's real
keystore inside the process, to build its payer, and sent nothing. Nothing in this area has been
broadcast to a public network.
