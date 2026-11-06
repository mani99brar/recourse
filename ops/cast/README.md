# The demo cast

Three more shops and three more agent companies, beside the agent company Parcel Minds (ERC-8004 agent 149) and the shop Halden Supply (agent 150). They run on the same shop and agent code as those two, with configuration only: a key each, a party map entry, a catalogue file for a shop, spend limits for an agent company. There is no new service. Every name and brand is fictional, and every amount is testnet money: HBAR on Hedera testnet and mUSDC, the testnet mock token the vault holds.

| File | What it is |
|---|---|
| `cast.json` | The cast: each shop and agent company with its type, catalogue or limits, funding, and the planned orders. |
| `setup.ts` | Creates the keys, the Hedera accounts and the ERC-8004 identities, adds the party map entries, and funds the deposits. Dry run by default. |
| `orders.sh` | Places the planned orders through `live-order --local-shop`, or through the agent's `order` and the shop's `pack` commands, each with its own identities. Dry run by default. |

## The cast

| Id | Name | Role | Type (`kind`) | What it shows |
|---|---|---|---|---|
| 150 | Halden Supply | shop | Physical goods with sizes (`apparel-sizes`) | The existing shop. |
| `kestrel` | Kestrel Outfitters | shop | Physical goods with sizes (`apparel-sizes`) | A second clothing shop: resells Northwind outerwear in M and L. |
| `fernhill` | Fernhill Market | shop | Perishable, time-bound goods (`perishable-timed`) | Flowers and bread for one delivery day. |
| `quillon` | Quillon Data | shop | Digital or API service, pay per call (`api-pay-per-call`) | Batches of weather API calls. |
| 149 | Parcel Minds | agent company | Personal shopping agent (`personal-shopper`) | The existing agent company. |
| `wren` | Wren Errands | agent company | Personal shopping agent (`personal-shopper`) | Buys on its own mandate, under a 5 USDC spend limit. |
| `tallyhouse` | Tallyhouse Procurement | agent company | Procurement agent with buyer approval (`procurement-approval`) | Above its 1 USDC spend limit, the buyer must sign the order. |
| `lumen` | Lumen Metrics | agent company | Data agent buying API calls (`data-api-buyer`) | Pays for API calls with x402. |

Each new identity's ERC-8004 registration document is the one the repo writes for agents 149 and 150, with the cast's own description and one more object:

```json
"recourse": { "role": "shop", "kind": "perishable-timed", "label": "Perishable, time-bound goods", "summary": "..." }
```

The 149 and 150 documents have no such object yet. `cast.json` lists their kind, label and summary under `existing`. A page that finds no `recourse` object shows the party's role from the party map and its kind as unknown.

## What each type can and cannot express

The fault rule compares six attributes across the order's records: brand, size, colour, quantity, price and merchant. A shop type can use the rule only for what fits into those six attributes.

- **Physical goods with sizes** (Halden, Kestrel). These fit the rule directly. The size ordered, packed and received are compared, and so are the brand, the colour and the price. A wrong size is a claim the rule can answer.
- **Perishable, time-bound goods** (Fernhill). brand is the grower or bakery, size is the pack (`Bunch of 10`, `800 g`), and colour is the variety (`White`, `Red`, `Plain`). The rule can answer a wrong variety or a wrong pack. It cannot answer lateness. The delivery day is not one of the six attributes, and no record states when a parcel arrived. So a late delivery is handled as a refund that the shop gives, outside Recourse, and not as a rule answer. A claim about lateness would have no gap to find.
- **Digital or API service, pay per call** (Quillon). brand is the API product, size is the plan and the number of calls (`Standard plan, 100 calls`), colour is the data set (`Hourly forecast`), and quantity is the number of batches. The rule can answer a wrong plan or a wrong data set. The packed record states the plan the shop delivered. It cannot judge whether a call's answer was correct or arrived on time. A failed call is re-run by the shop, and no claim is made.
- **Agent companies.** Each type differs only in its spend limits (`AGENT_SPEND_LIMIT_USDC`, `AGENT_MAX_ORDER_USDC`, `AGENT_DAILY_CAP_USDC`, `AGENT_APPROVAL_TTL_SEC`; see `services/agent/src/limits.ts`). Under its spend limit, an agent approves an order on its own mandate. Above the limit, the buyer signs the order with `pnpm --filter @recourse/agent approve`. The rule treats both kinds of approval the same way. A data agent is the same agent code buying from an API shop.

## The planned orders

`ops/cast/orders.sh list` prints these orders. The court path is not part of the cast: the single Kleros case stays separate and stays last.

| Order | Agent company, shop, item | Outcome it shows |
|---|---|---|
| `wren-kestrel-payout` | Wren, Kestrel, `shell-navy-m`, `--fault ordered-size=S` | A claim nobody contests. The pre-check answers 1 (agent company) at step 3: the ordered record differs from what was shown, while asked and shown agree. After the contest window the claim closes, the shop is paid from Wren's deposit, and the shop withdraws its credit. |
| `wren-kestrel-neither` | Wren, Kestrel, `shell-navy-l` | The buyer asked for M. The screen showed L, flagged the change, and Wren approved it, so L is what was packed and received. The pre-check answers neither (step 11), and nothing is paid. |
| `tallyhouse-kestrel-approval` | Tallyhouse, Kestrel, `jacket-navy-m` (3 USDC) | The buyer asked for this jacket at up to 3.00, so the approval text shows no change. The order is above Tallyhouse's 1 USDC spend limit, so it waits for the buyer. Then `orders.sh approve tallyhouse-kestrel-approval --send` signs it and pays, and the shop packs. No claim. |
| `wren-fernhill-no-claim` | Wren, Fernhill, `tulips-white-10` | Paid and packed, with no claim. A late delivery is refunded by the shop. |
| `lumen-quillon-calls` | Lumen, Quillon, `forecast-100` | Paid with x402. The shop records the plan it delivered. No claim. |

Each shop gets at least one paid order, and the orders go through two paths:

- **The Kestrel claim orders** go through `live-order --local-shop`, which runs the shop inside the same process and carries the order on to the claim. `live-order` writes fixed values for what the buyer asked for (Northwind, M, Navy, up to 2.00) and for what arrived (Northwind, Navy, the staged size, else L). These values are correct for these two orders.
- **The other three orders** (`"via": "order"` in `cast.json`) go through the agent's `order` command, with the buyer's asked values from `cast.json`, so their records state what that buyer asked for. Once an order is paid, the shop's `pack` command writes the packed record: the catalogue item and the price charged. For these orders the shop runs as its own process (the shop service's code with that shop's settings) on its registered port (8731 to 8733), for as long as each command runs. The approval order needs this: the agent pays to the shop URL it saved at the first 402, and the payment comes on a later run. The agent finds the shop through its ERC-8004 registration. While the registry cannot be read, it uses `SHOP_BASE_URL`, which `orders.sh` sets to the same port, and it still pays the shop's own account from the party map.

## Running it

The build session runs these steps after the redeploy has rewritten `deployments/*.json`.

1. Add the three party selectors to `recourse.env`, so that the running services keep their own party once the party map holds several of each role. The addresses are those of Halden Supply, Parcel Minds and the Parcel Minds agent:
   `RECOURSE_SHOP_ADDRESS=0x0d87ED2F5D792561B53043Ff028956125c820287`,
   `RECOURSE_PLATFORM_ADDRESS=0xff845c7d57eb58f30dEEE83a96010FeE055FdaF6`,
   `RECOURSE_AGENT_ADDRESS=0xC9d6E94A0Ada9293ACbf871c4bC15c580355b623`.
   `setup.ts --send` refuses to start while these are unset. Restart the shop unit once these lines are in place, before the party map changes. Otherwise a restart after the change finds several shops and no selector, and stops. The agent has no unit: its commands read `recourse.env` on each run, so they pick up the selectors on their next run.
2. Run `set -a; . ~/.config/recourse/recourse.env; set +a; node --import tsx ops/cast/setup.ts` from the repo root. This prints the plan and its cost. Then run it again with `--send`. A rerun skips what exists, but it reads each agent company's deposit from the vault and tops it up to its target, for example after a claim was paid from it, or after a redeploy, which brings a new vault and token. While `HEDERA_RPC_URL_1` answers, the dry run reads the same balances and deposits and prices that top-up; while it does not, the plan comes from the journal alone. A register tx is journaled with its hash before it is sent, so a rerun after a lost answer or receipt reads that tx's agent id back instead of registering the identity a second time. If the registry already holds an identity of that key that no journaled tx names, `--send` stops rather than register again. Its journal is in `~/.local/state/recourse/cast/journal.jsonl`. If `ops/fund/05-write-ids.sh` rewrites the party map, it drops the cast entries. A rerun of `setup.ts --send` adds them again from the journal.
3. Restart the pre-check and docket services so they read the new party map. The status API reads it again every 30 s. Do not run `h0-setup --broadcast` once the cast is in the party map: it sets agent ids by role, so it would write 149 on every platform and 150 on every shop.
4. Run `ops/cast/orders.sh`, which is a dry run, then `ops/cast/orders.sh --send`. For the approval order, run `ops/cast/orders.sh approve tallyhouse-kestrel-approval --send`. The approval can be given once only. If the order stops after it, for example at the pack, rerun `ops/cast/orders.sh --send tallyhouse-kestrel-approval`, which resumes the paid order and packs it. After the contest window, rerun `ops/cast/orders.sh --send wren-kestrel-payout` if the claim step needs to carry on. Then the shop withdraws its credit with `ops/cast/orders.sh withdraw wren-kestrel-payout --send`, which runs `withdraw-credit --as shop` with Kestrel's key.

## Cost

These amounts come from `setup.ts`'s own summary with `PRICE_ASSET=hbar`. Run the dry run for the current figures.

- **HBAR from the deployer.** 33.5 HBAR in initial balances: 3 per shop, 2 per platform, and 3 per agent plus the price of its planned orders. On top of that, about 9 HBAR in fees: about 0.8 per account, plus the mints and the requirement settings.
- **HBAR paid by each identity.** Its ERC-8004 registration costs about 0.8 HBAR, measured on agent 149's, and an agent company's approve and deposit about 0.6 HBAR. Both come out of the identity's initial balance.
- **mUSDC minted by the deployer.** 10 per agent company, deposited and set as that company's required amount (the vault's minimum is 5), and 1 to 3 per shop for court fees. 35 mUSDC in all.

## Keys

Each identity has its own key in the existing keystore folder. Shops use `$KEYSTORE_DIR/cast-<shop>.json`. Agent companies use `cast-<company>-platform.json` for the platform and `cast-<company>-agent.json` for the agent. All are Foundry v3 keystores made by `cast wallet new`, mode 0600, with a password file `<file>.pass` beside each, as `docs/keys.md` describes for the other roles. The keys are read only through `loadSigner`, and nothing prints them.
