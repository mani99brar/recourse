# Deploy and wiring order

The exact order for both chains. Nothing here has been run on a testnet. Every script is a dry run unless it gets `--send` (the Hedera and Arbitrum deploy scripts use `--broadcast`), and each one signs only from a role keystore with its password file; no key, password or keyed URL is ever passed on a command line.

Set up the shell once (this reads the env file; it prints nothing secret):

```
cd ~/dev/recourse
set -a; . ~/.config/recourse/recourse.env; set +a
export PATH="$HOME/.local/bin:$PATH"
```

Rules that apply to every step:

- Dry-run first, read the output, then repeat with the send flag.
- A step stops on the first read-back that does not match. Do not carry on past a failure.
- The wiring scripts write `deployments/wiring.json` (one row per transaction: id, chain, call, role, tx, time, result, who). A dry run writes nothing.
- After a send, commit the changed `deployments/` files through `ops/scripts/commit.sh`.
- Hedera testnet has a scheduled upgrade on Fri 6 Nov, 18:00-18:40 UTC. Send nothing to Hedera in that window.

## Before any deploy

| # | Command | Expect |
|---|---|---|
| 0.1 | `bash ops/fund/balances.sh` | each address is faucet-funded directly (at most 10 HBAR per address, so there is no pooled balance). HBAR floors: deployer 12 before the Hedera deploy (the deploy costs about 8.4 HBAR) and at least 2 after it for wiring, `setParams`, `setRequired` and the lock; ops-hedera 10; precheck-signer 3; shop 3; agent 2, or 8 with `PRICE_ASSET=hbar` (it then pays orders in HBAR); platform 1; scheme 1; buyer and facilitator 0. The deployer also holds some Arbitrum Sepolia ETH; ops-hedera and ops-arb hold LINK; platform holds USDC (20 per faucet claim, 18 of it deposited) |
| 0.2 | `(cd contracts && forge test --jobs 1)` under the suite lock | green on the commit being deployed |
| 0.3 | `bash ops/wire/rehearse.sh` under the suite lock | `rehearsal complete` (local anvils only) |

## 1. Hedera deploy (`contracts/script/hedera/hedera.sh`, deployer)

| Step | Command | Read-back |
|---|---|---|
| 1.1 | `contracts/script/hedera/hedera.sh preflight` | `preflight OK` (chain 296, deployer at least 12 HBAR, USDC token on the mirror, router code, inputs set) |
| 1.2 | `hedera.sh deploy`, then `hedera.sh deploy --broadcast` | vault and claims addresses logged; transactions in `contracts/broadcast/Deploy.s.sol/296/run-latest.json` |
| 1.3 | `hedera.sh associate --broadcast` | prints `USDC steps may proceed` after the mirror lists the vault's USDC row. **No USDC moves before this.** |
| 1.4 | `hedera.sh record` | writes `deployments/hedera.json` (contract ids come from the mirror; rerun if it says not indexed) |

Commit `deployments/hedera.json` and `contracts/broadcast/Deploy.s.sol/296` together.

## 2. Arbitrum deploy (`contracts/script/arbitrum/deploy.sh`, deployer)

| Step | Command | Read-back |
|---|---|---|
| 2.1 | `contracts/script/arbitrum/deploy.sh` | dry run on a fork: prints the deploy keys, live arbitration cost |
| 2.2 | `contracts/script/arbitrum/deploy.sh --broadcast` | `RecourseCase <address>, tx, block` recorded in `deployments/arbitrum.json` |

Commit `deployments/arbitrum.json`.

The two deploys are independent, so they may run in either order or in parallel. Both must be done before step 3.

## 3. Wiring (`ops/wire/`)

Each script is run as `ops/wire/NN-name.sh` first without a flag, then with `--send`.

| Step | Script | Signs as | What it does | Read-back |
|---|---|---|---|---|
| 3.0 | `00-readback.sh` with `EXPECT_PEERS=0` | none | checks the roles, owners, binding, association | all `ok` |
| 3.1 | `01-peer-hedera.sh` | deployer (owner) | `Claims.setPeer(RecourseCase)` | `Claims.peer()` equals the case address |
| 3.2 | `02-peer-arbitrum.sh` | deployer (owner) | `RecourseCase.setPeer(Claims)` | `RecourseCase.peer()` equals the claims address |
| 3.3 | `03-fund-claims.sh` | ops-hedera | LINK to Claims (or `fundNative()` if `feeToken()` is zero), up to `CLAIMS_LINK_TARGET` (1 LINK before the lock) | balance at or above the target |
| 3.4 | `04-fund-case-link.sh` | ops-arb | LINK to RecourseCase up to `CASE_LINK_TARGET` (1 LINK before the lock) | balance at or above the target |
| 3.5 | `05-fund-fee-pool.sh` | ops-arb | `fundFeePool()` up to `FEE_POOL_TARGET_ETH` (0.01 ETH before the lock) | `feePool()` at or above the target; contract balance covers it |
| 3.6 | `06-set-extra-args.sh` | deployer | only if the deploy did not set the intended `extraArgs` (`EXTRA_ARGS_HEDERA`, `EXTRA_ARGS_ARBITRUM`) | `extraArgs()` equals the intended bytes on both |
| 3.7 | `00-readback.sh --record` | none | full check, then records contracts, peers, extra args, LINK, fee pool and the association in `wiring.json` | `read-back OK` |

Optional, only if the trusted-relay path is taken: `11-trusted-relay.sh` (deployer, before the lock).

Commit `deployments/wiring.json`, then pull it where the services run and start them (`ops/units/README.md`).

## 4. Platform deposit and standing (Hedera, after the vault is associated)

| Step | Script | Signs as | What it does | Read-back |
|---|---|---|---|---|
| 4.1 | `07-deposit.sh <micro-usdc>` | platform | `hedera.sh deposit`: USDC `approve`, then `postDeposit` | `depositOf(platform)` rose by the amount |
| 4.2 | `08-set-required.sh <micro-usdc>` | deployer (owner) | `hedera.sh required`: `setRequired(platform, amount)`, amounts set from the USDC that actually arrived | `inGoodStanding(platform)` is true |

No order may be taken before 4.2 reads true.

## 5. Smoke claims and Sourcify

- The shop's `file-claim` and `withdraw-credit` commands (`services/shop`) prove a filed claim, an uncontested close and a withdrawal; record the hashes as in `contracts/script/hedera/README.md` step 8.
- Sourcify verification for Claims, the vault (Hedera 296) and RecourseCase (421614) runs from the deployer's checkout, then `wiring.json`'s `sourcify` entry is filled in by hand with status and URL.
- One case through to a Kleros ruling is the check that the whole chain works. Do not lock before it.

## 6. Lock (one way)

Top the balances to the lock targets first, then lock, then read back. Run these in this order:

| Step | Script | Signs as | What it does | Read-back |
|---|---|---|---|---|
| 6.1 | `CLAIMS_LINK_TARGET=5 03-fund-claims.sh` | ops-hedera | LINK to 5 per contract | at target |
| 6.2 | `CASE_LINK_TARGET=5 04-fund-case-link.sh` | ops-arb | | at target |
| 6.3 | `FEE_POOL_TARGET_ETH=0.02 05-fund-fee-pool.sh` | ops-arb | | at target |
| 6.4 | `09-lock-hedera.sh` | deployer | `hedera.sh lock`: locked parameters, then `lockConfig` on Claims and the vault | both `configLocked()` true |
| 6.5 | `10-lock-arbitrum.sh` | deployer | `setParams` if they differ, then `RecourseCase.lockConfig()` | `locked()` true, `params()` as intended |
| 6.6 | `EXPECT_LOCKED=1 00-readback.sh --record` | none | final check and record | `read-back OK`, all three locked |

After the lock, `sweepLink` and the pre-lock setters are gone. `setExtraArgs`, `setFeeToken`, `setRequired`, `setPolicyURI`, `setTemplateText` and `withdrawFeePool` remain (see the README).

## Replacing a deployment

Before redeploying, empty the old contracts (`sweepLink` and `withdrawFeePool` are available only on an unlocked case; settle or expire every open claim), then record the old addresses in `deployments/retired.json` and run this whole order again. The vault's deposit has no exit in the first vault, so a replacement needs a fresh platform deposit.

## Local rehearsal

`bash ops/wire/rehearse.sh` runs the same order on two throwaway anvil nodes (ports 8610 and 8611) with throwaway keystores and the files `deployments/{hedera,arbitrum,wiring}.wire-rehearsal.local.json`, which it deletes on exit. Set `WIRE_LOCAL=1` and the three file-name variables (`HEDERA_FILE`, `ARBITRUM_FILE`, `WIRING_FILE`, each its own `*.local.json` name) to run any single step against local nodes; the scripts refuse local names against a testnet and the reverse.
