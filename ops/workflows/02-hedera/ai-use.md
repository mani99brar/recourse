# AI use: Hedera contracts

Everything in this area was written by Claude (Anthropic, Opus 5.5) running as a coding agent in
this repo, and committed through `ops/scripts/commit.sh`. No person has reviewed it line by line
yet. The table says how each file was made and what checks it.

| Files | How it was made | Checked by |
|---|---|---|
| `contracts/src/hedera/DepositVault.sol`, `RecourseClaims.sol`, `SettleMath.sol`, `interfaces/*.sol` | Written by the agent on top of the shared types and codec in `contracts/src/shared/` | `contracts/test/hedera/*.t.sol`: unit tests per module, fuzzed receive paths, the shared settle vectors, two invariant suites (vault alone, and the whole path through Claims and the local CCIP router), `forge build --sizes` |
| `contracts/test/hedera/mocks/*.sol` | Written by the agent. Test mocks for the HTS system contract, the PRNG and the USDC facade; never deployed to a live chain | used by every Hedera test; the two mock modes of the token (revert, return false) each have tests |
| `contracts/test/hedera/*.t.sol`, `handlers/*.sol` | Written by the agent | `Probe.t.sol` must fail (it does), so a green run is not a harness that passes everything; deliberate one-line mutations in the vectors test and the invariant handler were seen to fail them |
| `contracts/script/hedera/DeployLocal.s.sol`, `Proofs.s.sol` | Written by the agent; local anvil only | run on anvil: the stack deploys, both proof stages pass, and the vault's books equal its balance |
| `contracts/script/hedera/Deploy.s.sol`, `Wire.s.sol`, `Lock.s.sol`, `Check.s.sol`, `hedera.sh` | Written by the agent | `hedera.sh rehearse <port>` runs every step on anvil with throwaway keystores (made in a temp directory and deleted); `Deploy.s.sol` was also simulated against Hedera testnet with only the deployer's public address (no key, no broadcast) |
| `deployments/abi/RecourseClaims.json`, `DepositVault.json` | The `abi` arrays of the forge build output, copied with `jq` | compared with the build output after each contract change |

Keys: no real keystore was decrypted for this area. Local runs sign with anvil's unlocked accounts
or with throwaway keystores whose password is passed through the environment, never the command
line.
