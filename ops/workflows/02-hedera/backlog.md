# Backlog: Hedera contracts

Open items, each small and self-contained.

- **Testnet deploy.** Nothing is deployed yet. Once the deployer holds HBAR: `hedera.sh preflight`,
  `deploy --broadcast`, `associate --broadcast`, `record`, then commit `deployments/hedera.json`
  together with `contracts/broadcast/*/296/`.
- **Association codes.** The vault accepts 22 (SUCCESS) and 194 (ALREADY_ASSOCIATED) from HTS. Both
  codes, and the 1,000,000 gas limit `associate` uses, are unconfirmed on the live chain. If both
  association paths fail, the fallback is a HAPI `ContractCreate` with automatic token
  associations, which is not scripted.
- **Forge simulation and HTS.** A forge script cannot run HTS calls in its fork, so association
  and every USDC move go through `cast send`, and `Check.s.sol` reads token balances with a raw
  node `eth_call`. Keep any new USDC step out of forge scripts.
- **Gas limits.** The send default is 150,000. `packages/shared/vectors/params.json` still says
  300,000 (`gasClaimToCourt`) and 400,000 (`gasRulingBack`) until it is updated; the scripts read
  it.
- **Native CCIP fees.** The HBAR fee path (`feeToken` 0, `fundNative`) is tested with the local
  router only, including the 8-decimal arithmetic. It has not been run against the live router.
- **Exit.** `requestExit` and `exit` are covered by the suite only; no testnet run.
- **Source verification.** Neither contract is verified on Sourcify yet.
- **Batch draws.** Not built. `batchOf` and `getBatch` are pure views that return zeros.
