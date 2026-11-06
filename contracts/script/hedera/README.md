# Hedera deploy runbook

These scripts deploy `DepositVault` and `RecourseClaims` on Hedera testnet (chain id 296, `0x128`),
wire them to the court contract on Arbitrum, and lock them. `hedera.sh` wraps every step; run it
from anywhere in the repo.

Every step is a dry run unless you add `--broadcast`. A dry run simulates or calls and sends
nothing.

## USDC mode: Circle or mock

The vault holds one token for its whole life. `HEDERA_USDC_MODE` picks it:

| Mode | Token | Association | Who can mint |
|---|---|---|---|
| `circle` (default) | Circle's testnet USDC, HTS token `0.0.429274`, through its facade `0x…068cDa` | HTS system contract, checked on the mirror | Circle's faucet only |
| `mock` | `MockUsdc` (`src/testnet/MockUsdc.sol`): name "Mock USD Coin (testnet)", symbol `mUSDC`, 6 decimals | `associateUsdc(true)`, checked by `usdcAssociated()` | the deployer, its owner |

`MockUsdc` is a testnet stand-in for when Circle's faucet does not deliver. It is not Circle's
token and is worth nothing. It is a plain ERC-20, not an HTS token, so no account needs an
association to hold it.

The two are never mixed in one deployment:

- Unset, the mode is the `usdc.mode` recorded in `deployments/hedera.json`. A file without a `usdc`
  object is from before the switch and counts as `circle`. With no file the mode is `circle`.
- `Deploy.s.sol` takes Circle's address in `circle` mode and refuses any other `USDC_ADDRESS`. In
  `mock` mode it refuses Circle's address and any token without code, 6 decimals and the symbol
  `mUSDC`.
- `associate`, `record`, `deposit` and `check` read the vault's own `usdc()` (it is immutable) and
  stop if it is not the mode's token.
- Steps on the recorded deployment (`wire`, `deposit`, `required`, `lock`, `check`) refuse a mode
  other than the recorded one.
- `deploy` refuses to run with the mode unset while a mock is kept from `mock-usdc`. Set the mode
  explicitly.

## Before you start

Tools: Foundry (`forge`, `cast`), `jq`, `curl`, `python3`.

Keystores are Foundry v3 files with the password in a file next to each one. Nothing else is read,
and no key or password goes on the command line.

| Keystore | Signs |
|---|---|
| `$KEYSTORE_DIR/deployer.json` (+ `.pass`) | mock-usdc, deploy, associate, wire, mint, required, lock. The deployer owns both contracts and the mock |
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
| `HEDERA_ASSOC_GAS` | associate | optional gas limit, default 1,000,000 (mock: 150,000) |
| `HEDERA_USDC_MODE` | all | `circle` or `mock`; see above |
| `USDC_ADDRESS` | preflight, deploy, mint (mock) | optional: the mock to use. Default: the one `mock-usdc` kept, else the recorded one. Once a mock deployment is recorded, `mint` takes only its vault's token |
| `ETH_GAS_PRICE` | mock-usdc, deploy (mock) | optional; set to `eth_gasPrice` + 3% when unset, so forge sends at one fixed price |
| `HEDERA_DEPLOYER_ADDRESS` | mock-usdc | a dry run without `KEYSTORE_DIR` simulates from it. Default: the recorded owner |

Parameters (pre-lock and locked) come from `packages/shared/vectors/params.json`.

Funding:

- **Deployer: at least 30 HBAR.** The deploy simulates at about 8.65M gas. Hedera bills at least
  80% of each gas limit, so expect about 9-11 HBAR. Forge's own balance check wants about 23 HBAR,
  because it prices at twice the base fee.
- **Mock mode.** The mock deploy has a 720,015 gas limit, billed at about 0.72-0.96 HBAR. With
  `ETH_GAS_PRICE` set, forge's estimate for the pair is about 11.7 HBAR (8.73M gas at 1,339 gwei),
  not about 23; the bill is still about 8.35 HBAR. `associateUsdc(true)` at a 150,000 gas limit
  bills about 0.15 HBAR (Hedera bills at least 80% of the limit; `forge test` measures the call
  at about 34k gas of execution, so `HEDERA_ASSOC_GAS` can go lower). Each `mint` is one small call.
- **Platform:** a little HBAR for two transactions, plus the deposit in USDC. In circle mode the
  account must be associated with USDC `0.0.429274`. In mock mode the deployer mints `mUSDC` to it
  instead.
- **RecourseClaims:** needs LINK before its first `sendToCourt`. LINK is sent by the ops step from
  ops-hedera, not by these scripts. In native-fee mode (`setFeeToken(0)`) it needs HBAR through
  `fundNative()` instead.

Units: `cast balance` returns weibars (10^18 per HBAR). Inside contracts, and in CCIP's native fee
quote, HBAR is tinybars (10^8 per HBAR). Multiply a contract-side amount by 10^10 for a JSON-RPC
`value`.

## Steps

### 0. Mock mode only: `HEDERA_USDC_MODE=mock hedera.sh mock-usdc --broadcast`

Deploys `MockUsdc` through `DeployMockUsdc.s.sol`, owned by the deployer.

- It reads the token back by `eth_call`: code, 6 decimals, symbol `mUSDC`, owner the deployer.
- It keeps the address in `~/.local/state/recourse/hedera-296/mock-usdc.address`, where `deploy`
  finds it, and `mint` until a mock deployment is recorded. The evidence is
  `contracts/broadcast/DeployMockUsdc.s.sol/296/`.
- It refuses to deploy a second mock unless you pass `--again`.
- Without `KEYSTORE_DIR` the dry run simulates from `HEDERA_DEPLOYER_ADDRESS`, or the recorded
  owner.

`hedera.json` is not touched here. The mock enters it at `record`, with the deployment that uses it.

### 1. `hedera.sh preflight`

Read-only. It checks:

- chain id 296;
- the deployer's HBAR is at least 12. Mock mode: at least (8.8M + `HEDERA_ASSOC_GAS`) gas at
  `ETH_GAS_PRICE`, about 12 HBAR at 1,339 gwei. That is forge's own balance check for the pair plus
  the association; the mock is already paid for;
- circle: USDC `0.0.429274` is on the mirror with 6 decimals. Mock: the mock has code, 6 decimals
  and the symbol `mUSDC`, by `eth_call`;
- the CCIP router has code;
- the four deploy inputs are set.

It prints `preflight OK`, or stops.

### 2. `hedera.sh deploy --broadcast`

Deploys the vault, then Claims, and binds them. It then sets the pre-lock parameters on both, the
pre-check signer, the bridge mode with the relayer, and the send extra args.

- No USDC moves.
- It refuses to run if `deployments/hedera.json` already exists. Pass `--again` (or set
  `HEDERA_REDEPLOY=1`) for a new pair.
- If the broadcast stops part way (the relay refuses a transaction, the price moves past
  `ETH_GAS_PRICE`, a timeout), run `hedera.sh deploy --broadcast --resume`. It finishes the same
  run from `contracts/broadcast/Deploy.s.sol/296/run-latest.json`: only the transactions not yet
  mined are sent, so it deploys no second pair and needs no `--again`. `wire`, `lock` and
  `mock-usdc` take `--resume` the same way.
- Mock mode: it checks that the deployer owns the mock, passes it as `USDC_ADDRESS` and sets
  `ETH_GAS_PRICE` if unset. The script logs `usdcMode` and `usdc`.
- After a broadcast it deletes the kept association tx
  (`~/.local/state/recourse/hedera-296/association.tx`), which belongs to the previous vault.
- Read back: the script logs both addresses and the roles. The transactions are in
  `contracts/broadcast/Deploy.s.sol/296/run-latest.json`.

### 3. `hedera.sh associate --broadcast`

Circle mode: calls `associateUsdc(false)` (the HTS system contract). If that fails it calls
`associateUsdc(true)` (the token's own `associate()`). It then polls the mirror for up to
2 minutes for the vault's USDC row.

Mock mode: calls `associateUsdc(true)` only, with a 150,000 gas limit. The HTS path cannot
associate a token that is not an HTS token, so it is not tried. The read-back is the vault's
`usdcAssociated()`; no mirror row exists for the mock. If the vault already reads associated and
the kept association tx is a successful call to this vault, it sends nothing. If the vault reads
associated but no such tx is kept, it sends one, so that `record` has this vault's tx.

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

It records the kept association tx as `associationTx` and `dpTx.dp1` only if its receipt succeeded
and is a call to this vault. Otherwise it stops; run `associate --broadcast`.

It writes a `usdc` object next to `contracts`, from the vault's own `usdc()`:

- circle: `{"mode": "circle", "address": "0x0000000000000000000000000000000000068cDa", "decimals": 6, "tokenId": "0.0.429274"}`;
- mock: `{"mode": "mock", "address": "<MockUsdc>", "decimals": 6, "tokenId": null}`.

Every other key is written as before.

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

Mock mode first: `hedera.sh mint <role|0xaddr> <micro-usdc> --broadcast` mints `mUSDC`, signed by
the deployer. A role name is looked up in `deployments/parties.json`. Once a mock deployment is
recorded, it mints only the recorded vault's token. In circle mode it refuses to run.

- `deposit` signs as the platform: `approve(vault, amount)` on the recorded deployment's token, then
  `postDeposit`. It records the deposit tx as `dpTx.dp2`. Its dry run simulates the approve only:
  `postDeposit` pulls through the allowance, which a simulated approve does not leave, so it is
  simulated only when the platform has already approved at least the amount.
- `required` signs as the deployer, calls `setRequired`, and prints `inGoodStanding(platform)`.
  That must read `true` before any claim is filed.

### 7. `hedera.sh check`

Read-only. It prints one `OK` or `FAIL` line per check, then the mirror's association row. In mock
mode it checks instead that the vault's token is the recorded mock and reads back as `mUSDC` with
6 decimals. It checks:

- code at both addresses, and the binding in both directions;
- one owner for both;
- association;
- signer and relayer set, and the peer (unless the mode is None);
- the mode against `HEDERA_BRIDGE_MODE`. Unset, against the recorded mode: `record` refuses to
  write a mode other than `HEDERA_BRIDGE_MODE`, and `lock` refuses to lock one;
- the extra args against `EXTRA_ARGS_HEDERA`, else against the last value `ops/wire` step 06
  wrote to `deployments/wiring.json` for these contracts, else against the args `deploy` set
  (`gasClaimToCourt`). They must also be ones the lane takes: GenericExtraArgsV2, a gas limit from
  100,000 to 3,000,000, out-of-order execution on;
- the parameters for the current lock state;
- the vault's USDC balance covers `totals()`. USDC sent to the vault directly is reported, not
  failed;
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

## Replacing the deployment with one on the mock

Run each step as a dry run first, then again with `--broadcast`. Keep `HEDERA_USDC_MODE=mock` set
for every step. The `deposit` dry run checks the approve only (see step 6).

```
export HEDERA_USDC_MODE=mock
hedera.sh mock-usdc --broadcast
hedera.sh preflight
hedera.sh deploy --broadcast --again      # hedera.json still names the old pair
hedera.sh associate --broadcast
hedera.sh record                          # hedera.json now names the new pair and usdc.mode "mock"
```

Then rewire:

1. `hedera.sh wire --broadcast` points the new Claims at RecourseCase.
2. Follow `ops/wire/order.md` for the rest, including RecourseCase's peer on Arbitrum, which must
   name the new Claims.
3. Mint, then deposit and require:

```
hedera.sh mint platform 20000000 --broadcast
hedera.sh mint shop 20000000 --broadcast
hedera.sh deposit 5000000 --broadcast
hedera.sh required <platform> 5000000 --broadcast
hedera.sh check
```

The new deploy overwrites `contracts/broadcast/Deploy.s.sol/296/run-latest.json`. The old pair's
evidence stays in git and in the timestamped `run-*.json` next to it. Commit `hedera.json` with
both broadcast folders, `Deploy.s.sol/296` and `DeployMockUsdc.s.sol/296`.

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
and the USDC facade, the chainlink-local router, and throwaway keystores. By default it runs in
circle mode, on the facade test double. With `HEDERA_USDC_MODE=mock` it runs the mock steps as the
replacement does: `mock-usdc` (and checks a second one is refused), `deploy` on it, `associate`
with `associateUsdc(true)`, the mock `record` (`usdc.mode` `mock`, `tokenId` null) and `check`,
then `mint` to the platform and the shop. The keystores are made in
a temp directory and deleted on exit. The claim proofs run through `Proofs.s.sol`. It writes only
`deployments/*.local.json`, never `hedera.json`.

`DeployLocal.s.sol` stands up the same contracts on anvil for other services; its header lists the
roles and options. Name its output with `HEDERA_LOCAL_FILE=<name>.local.json`. A loader that
prefers `hedera.local.json` would otherwise read a local file in place of the testnet one.
