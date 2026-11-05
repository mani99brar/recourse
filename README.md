# Recourse

Recourse lets a shop recover money when an AI shopping agent buys the wrong thing.

An agent pays a shop over x402 on Hedera and commits what it was asked, what it showed, the approval and the order to a Hedera Consensus Service topic. The shop commits what it packed. When something arrives wrong, the shop files a claim on Hedera and escrows a court fee. A rule-based pre-check names the gap and the side at fault, and the losing side may contest. A contest crosses Chainlink CCIP to Arbitrum Sepolia, where a Kleros court rules. The ruling crosses back, and a USDC deposit posted by the agent company pays the shop. A docket on Arkiv publishes fault rates per agent company.

Built at ETHGlobal Mumbai, 5-7 Nov 2026. Work in progress; testnets only.

## Layout

| Path | What |
|---|---|
| `packages/shared` | Types, ids, hashing, codecs, the fault rule, status keys, address book |
| `contracts/` | Foundry project: Hedera `RecourseClaims` and `DepositVault`, Arbitrum `RecourseCase`, CCIP ping contracts |
| `packages/court` | Kleros dispute template, policy and evidence builder |
| `packages/records`, `packages/renderer` | HCS record commits and reads, IPFS pinning, the approval screen renderer |
| `services/` | `shop` (x402 seller), `agent` (x402 buyer), `precheck`, `keeper`, `docket`, `intake`, `status-api` |
| `apps/web` | Case status, docket and filing pages |
| `deployments/` | Addresses and ABIs per chain |
| `docs/` | Interfaces, decisions, checks, AI use |
