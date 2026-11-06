# Keys, roles and addresses

Ten roles, each with its own key. Keys exist only as Foundry v3 keystores outside the repository. This file lists names, public addresses and file paths. It never holds a key, a password or a keyed URL.

## Where keys live

| Item | Path |
|---|---|
| Keystore directory (mode 0700) | `/home/agentops/.config/recourse/keys` (`$KEYSTORE_DIR`) |
| Keystore for a role | `$KEYSTORE_DIR/<role>.json` |
| Password file for a role (mode 0600) | `$KEYSTORE_DIR/<role>.json.pass` |
| Public addresses | `/home/agentops/.config/recourse/addresses.txt` |
| Service env files (keyed RPC URLs and API keys, mode 0600) | `~/.config/recourse/recourse.env`, `~/.config/recourse/<service>.env`, `~/.config/recourse/cli.env` |

Everything runs on this one host, so every role's key is here. A command signs with `--keystore "$KEYSTORE_DIR/<role>.json" --password-file "$KEYSTORE_DIR/<role>.json.pass"`. Never pass `--private-key`, `--unsafe-password` or `--account`, and never print a key, a password or a keyed URL. TypeScript services read the same files through `loadSigner` and `loadKeyBytes` in `@recourse/shared/node`.

## Roles

| Role | Signs | Env variable | Address | Hedera account |
|---|---|---|---|---|
| deployer | Contract deploys on both chains, owner calls (`setPeer`, `setExtraArgs`, `setRequired`, `lockConfig`), ping contract deploys and sends, optional HBAR top-ups | `DEPLOYER_KEY_FILE` | `0x4A63342B48741dA2A84e7681eE8aCF4D56B4D964` | 0.0.11329546 |
| ops-hedera | Keeper sends on Hedera (`resend`, `settle`), LINK and USDC top-ups, HCS topic creation, manual CCIP execution on Hedera. It is the ruling relayer address in `RecourseClaims` | `OPS_HEDERA_KEY_FILE` | `0xB5077EA5A97Ec3Ee8Ce9DeF73064aE82c4b7058d` | 0.0.11329551 |
| ops-arb | Keeper sends on Arbitrum Sepolia (`openCase`, evidence, `refile`, `relayRuling`), `fundFeePool`, test cases through the public DisputeResolver. It is the trusted relay address of `RecourseCase` if that mode is used | `OPS_ARB_KEY_FILE` | `0xb9Ad51ffcA49AD8aC40DFaCd679Cf71965F4588B` | none (Arbitrum only) |
| precheck-signer | `recordPreCheck` on `RecourseClaims` (the one trusted step; anyone can re-run the check) | `PRECHECK_SIGNER_KEY_FILE` | `0x1036Ba3820ab816e142eB1D7D84fbaAF8351Cc8D` | to be created |
| platform | The agent company's deposit (`approve` plus `postDeposit`), HCS identity registration | `PLATFORM_KEY_FILE` | `0xff845c7d57eb58f30dEEE83a96010FeE055FdaF6` | 0.0.11329672 |
| agent | x402 payments, HCS records I, S, A, O, R, ERC-8004 identity | `AGENT_KEY_FILE` | `0xC9d6E94A0Ada9293ACbf871c4bC15c580355b623` | 0.0.11329682 |
| shop | x402 `payTo`, HCS record D, `fileClaim`, `approve` of the vault for the court fee, `withdrawCredit` | `SHOP_KEY_FILE` | `0x0d87ED2F5D792561B53043Ff028956125c820287` | 0.0.11329680 |
| scheme | Arkiv writer wallet, ERC-8004 reviews, the vault's pool address | `SCHEME_KEY_FILE` | `0x54E4545AFcf8960884A750320e70aFE16b2b3CaE` | to be created |
| buyer | The disclosed demo buyer who approves purchases above the spend limit (testnet only) | `BUYER_KEY_FILE` | `0x8A6f54dD8b639C2748cf3B3EFBb9fA7d54Fd4792` | to be created |
| facilitator | Fee payer of the self-hosted x402 facilitator, if the public ones are not used | `FACILITATOR_KEY_FILE` | `0xa16eC81150F648aC59f39d11aaB2dAdB1db84e32` | to be created |

The Hedera account ids are written to `HEDERA_ACCOUNT_IDS` and `deployments/parties.json` by `ops/fund/05-write-ids.sh` once the accounts exist.

## Funding

Hedera testnet funding is per address: the faucet pays at most 10 HBAR to one address, so every role is funded directly and nothing is pooled through the deployer. Measured costs (gas price 1310 gwei, at least 80% of the gas limit billed): the Hedera deploy about 8.35 HBAR, `associateUsdc` about 0.92 HBAR, creating an account by an EVM value transfer 0.76 HBAR on top of the value, completing a hollow account 0.026 HBAR. 1 HBAR is about $0.068 on the testnet rate.

| Role | HBAR floor | Notes |
|---|---|---|
| deployer | 12 before the Hedera deploy, 2 after | wiring, `setParams`, `setRequired`, lock; also holds Arbitrum Sepolia ETH |
| ops-hedera | 10 | keeper sends, HCS topic, CCIP fees if paid natively |
| precheck-signer | 3 | `recordPreCheck` sends |
| shop | 3 | filing and credit withdrawal |
| agent | 2, or 8 with `PRICE_ASSET=hbar` | record fees; with `PRICE_ASSET=hbar` it also pays the x402 orders in HBAR (1 to 6 HBAR each) |
| platform | 1 | |
| scheme | 1 | |
| buyer, facilitator | 0 | not needed; the public facilitators are tried first |

USDC: the vault's deposit and court fee are in the token `deployments/hedera.json` records (`usdc.mode`). While it is `mock`, as now, that is `mUSDC`, which only the deployer (the mock's owner) mints, with `hedera.sh mint <role> <micro-usdc>`: the platform needs its deposit, the shop about 1 per claim (the court fee); no account needs an association for it. Circle's Hedera faucet (it takes only existing `0.0.N` ids and gives 20 USDC per address) did not deliver; it matters again only for a `circle`-mode deployment, where the platform deposits 18 of its 20 and the shop needs about 1 per claim, and for x402 orders paid in USDC (`PRICE_ASSET=usdc`). The agent's daily cap is 15 USDC with orders of 1 to 6 USDC; when orders are paid in HBAR (`PRICE_ASSET=hbar`) the agent needs no USDC, and an HBAR order counts against the cap at 1 USDC per HBAR. New accounts have `max_automatic_token_associations = -1`, so no association step is needed for Circle's USDC; `ops/fund/04-associate-usdc.sh` is only a fallback, and in mock mode it says that none is needed.

Accounts so far: deployer 0.0.11329546, ops-hedera 0.0.11329551, platform 0.0.11329672, shop 0.0.11329680 and agent 0.0.11329682 exist and are complete. precheck-signer, scheme, buyer and facilitator have no account yet. Run `ops/fund/balances.sh` for the current picture.

## Rules

- A key or password is never written to git, a log, a prompt, a commit message, `docs/checks.md` or a command line.
- No keyed URL appears in any committed file; those live only in the env files above.
- Testnet only. These keys must never hold mainnet funds.
- If a key is ever pushed or shown, treat it as burned: create a new keystore and update this file.
