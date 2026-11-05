# Hedera deploy runbook

These scripts deploy `DepositVault` and `RecourseClaims` on Hedera testnet (chain id 296, `0x128`),
wire them to the court contract on Arbitrum, and lock them. `hedera.sh` wraps every step; run it
from anywhere in the repo.

Every step is a dry run unless you add `--broadcast`. A dry run simulates or calls and sends
nothing.

## Before you start

Tools: Foundry (`forge`, `cast`), `jq`, `curl`, `python3`.

Keystores are Foundry v3 files with the password in a file next to each one. Nothing else is read,
and no key or password goes on the command line.

| Keystore | Signs |
|---|---|
| `$KEYSTORE_DIR/deployer.json` (+ `.pass`) | deploy, associate, wire, required, lock. The deployer owns both contracts |
| `$KEYSTORE_DIR/platform.json` (+ `.pass`) | deposit |

Env (role addresses are in `docs/keys.md`):

| Name | Used by | Value |
|---|---|---|
| `KEYSTORE_DIR` | every signing step | directory of the keystores above |
| `HEDERA_RPC_URL_1` | all | JSON-RPC relay; default `https://testnet.hashio.io/api` |
| `HEDERA_MIRROR_URL` | preflight, associate, record, check | default `https://testnet.mirrornode.hedera.com` |
| `POOL_ADDRESS` | preflight, deploy | the scheme wallet. It becomes the vault's fee pool and cannot be changed |
| `PRECHECK_SIGNER_ADDRESS` | preflight, deploy | the pre-check signer |
| `RULING_RELAYER_ADDRESS` | preflight, deploy | the ops-hedera address. It is set in every mode |
| `HEDERA_BRIDGE_MODE` | preflight, deploy | `Both`, `OutOnly` or `None` |
| `RECOURSE_CASE_ADDRESS` | wire | RecourseCase on Arbitrum Sepolia |
| `HEDERA_ASSOC_GAS` | associate | optional gas limit, default 1,000,000 |

Parameters (pre-lock and locked) come from `packages/shared/vectors/params.json`.

Funding:

- **Deployer: at least 30 HBAR.** The deploy simulates at about 8.65M gas. Hedera bills at least
  80% of each gas limit, so expect about 9-11 HBAR. Forge's own balance check wants about 23 HBAR,
  because it prices at twice the base fee.
- **Platform:** a little HBAR for two transactions, plus the deposit in USDC. The account must be
  associated with USDC `0.0.429274`.
- **RecourseClaims:** needs LINK before its first `sendToCourt`. LINK is sent by the ops step from
  ops-hedera, not by these scripts. In native-fee mode (`setFeeToken(0)`) it needs HBAR through
  `fundNative()` instead.

Units: `cast balance` returns weibars (10^18 per HBAR). Inside contracts, and in CCIP's native fee
quote, HBAR is tinybars (10^8 per HBAR). Multiply a contract-side amount by 10^10 for a JSON-RPC
`value`.

## Steps

### 1. `hedera.sh preflight`

Read-only. It checks:

- chain id 296;
- the deployer's HBAR is at least 30;
- USDC `0.0.429274` is on the mirror with 6 decimals;
- the CCIP router has code;
- the four deploy inputs are set.

It prints `preflight OK`, or stops.

### 2. `hedera.sh deploy --broadcast`

Deploys the vault, then Claims, and binds them. It then sets the pre-lock parameters on both, the
pre-check signer, the bridge mode with the relayer, and the send extra args.

- No USDC moves.
- It refuses to run if `deployments/hedera.json` already exists. Set `HEDERA_REDEPLOY=1` for a new
  pair.
- Read back: the script logs both addresses and the roles. The transactions are in
  `contracts/broadcast/Deploy.s.sol/296/run-latest.json`.

### 3. `hedera.sh associate --broadcast`

Calls `associateUsdc(false)` (the HTS system contract). If that fails it calls
`associateUsdc(true)` (the token's own `associate()`). It then polls the mirror for up to
2 minutes for the vault's USDC row.

**Do not move USDC until it prints `USDC steps may proceed`.** If both paths fail, stop.

Read back:

```
curl -s "$HEDERA_MIRROR_URL/api/v1/accounts/<vault>/tokens?token.id=0.0.429274"
```

This must return one row.

### 4. `hedera.sh record`

Writes `deployments/hedera.json` from three sources:

- the broadcast;
- chain read-backs;
- the mirror (contract ids `0.0.N` and the start consensus timestamp).

If the mirror has not indexed the contracts yet, it says so; run it again.

On a re-record it keeps `gas`, `dpTx` and `sourcify`. Commit the file together with the broadcast
logs (deploy evidence; they hold no secrets):

```
ops/scripts/commit.sh "deploy(hedera): vault and claims on testnet" deployments/hedera.json contracts/broadcast/Deploy.s.sol/296
```

### 5. `hedera.sh wire --broadcast`

`setPeer(RECOURSE_CASE_ADDRESS)` only. It prints these read-backs:

- `claims.vault` and `vault.claims`;
- the owner;
- the peer;
- `preCheckSigner`, `bridgeMode` and `rulingRelayer`;
- `feeToken`;
- the extra args;
- `usdcAssociated`;
- the lock state and the parameters.

Then the ops step sends LINK to Claims.

### 6. `hedera.sh deposit <micro-usdc> --broadcast`, then `hedera.sh required <platform> <micro-usdc> --broadcast`

- `deposit` signs as the platform: USDC `approve(vault, amount)`, then `postDeposit`. It records
  the deposit tx as `dpTx.dp2`.
- `required` signs as the deployer, calls `setRequired`, and prints `inGoodStanding(platform)`.
  That must read `true` before any claim is filed.

### 7. `hedera.sh check`

Read-only. It prints one `OK` or `FAIL` line per check, then the mirror's association row. It
checks:

- code at both addresses, and the binding in both directions;
- one owner for both;
- association;
- signer, relayer, mode, peer and extra args as recorded;
- the parameters for the current lock state;
- `totals()` equals the vault's USDC balance;
- Claims holds no USDC.

It also prints the LINK balance of Claims.

### 8. Smoke claims

Run the shop's `file-claim` and `withdraw-credit` commands (`services/shop`):

1. Shop `approve(vault, fee)`, then a claim showing `FeeEscrowed`.
2. A second claim left uncontested. It closes after the 10-minute pre-lock window with the fee
   refunded.
3. A withdrawal showing `CreditWithdrawn`.

Record the two tx hashes, then commit:

```
jq --arg a 0x<file tx> --arg b 0x<withdraw tx> '.dpTx.dp3 = $a | .dpTx.dp4 = $b' deployments/hedera.json > deployments/.hedera.new \
  && mv deployments/.hedera.new deployments/hedera.json
```

### 9. `hedera.sh lock --broadcast`

Sets the locked parameters on both contracts, then calls `lockConfig` on both. **This is one-way.**
Afterwards only `setExtraArgs`, `setFeeToken` and `setRequired` remain.

Then run `CHECK_EXPECT_LOCKED=1 hedera.sh check`.

## Reading back by hand

```
R=$HEDERA_RPC_URL_1; C=$(jq -r .contracts.claims.address deployments/hedera.json); V=$(jq -r .contracts.vault.address deployments/hedera.json)
cast call $C 'peer()(address)' --rpc-url $R
cast call $C 'bridgeMode()(uint8)' --rpc-url $R            # 0 Both, 1 OutOnly, 2 None
cast call $C 'preCheckSigner()(address)' --rpc-url $R
cast call $C 'rulingRelayer()(address)' --rpc-url $R
cast call $C 'feeToken()(address)' --rpc-url $R            # 0x0 = native HBAR
cast call $C 'extraArgs()(bytes)' --rpc-url $R
cast call $C 'configLocked()(bool)' --rpc-url $R
cast call $V 'usdcAssociated()(bool)' --rpc-url $R
cast call $V 'totals()(uint256,uint256,uint256)' --rpc-url $R   # deposits, escrow, credits (micro-USDC)
cast call $V 'depositOf(address)(uint256)' <platform> --rpc-url $R
cast call $V 'inGoodStanding(address)(bool)' <platform> --rpc-url $R
cast call 0x90a386d59b9A6a4795a011e8f032Fc21ED6FEFb6 'balanceOf(address)(uint256)' $C --rpc-url $R   # LINK on Claims
```

## Rehearsal and local stack

`hedera.sh rehearse <port>` runs steps 2-9 on a running anvil, using test mocks for HTS, the PRNG
and the USDC facade, the chainlink-local router, and throwaway keystores. The keystores are made in
a temp directory and deleted on exit. The claim proofs run through `Proofs.s.sol`. It writes only
`deployments/*.local.json`, never `hedera.json`.

`DeployLocal.s.sol` stands up the same contracts on anvil for other services; its header lists the
roles and options. Name its output with `HEDERA_LOCAL_FILE=<name>.local.json`. A loader that
prefers `hedera.local.json` would otherwise read a local file in place of the testnet one.
