# Chain and service checks (read-only)

Every value below was read by `ops/checks/readonly.sh` on 2026-11-05 between 17:21 and 17:29 UTC from the build host. No transaction was sent and no role holds funds. Re-run with `bash ops/checks/readonly.sh` (about 2 minutes); endpoints come from `HEDERA_RPC_URL_1`, `HEDERA_RPC_URL_2`, `HEDERA_MIRROR_URL`, `ARB_RPC_URL`, `ARB_RPC_URL_2`, `SEPOLIA_RPC_URL` when set, otherwise the public ones named in the table (host names only are printed, so a keyed URL never reaches this file).

No keyed RPC endpoint exists yet; everything here ran on free public endpoints.

## Items that fail or need attention

| # | Finding | Effect |
|---|---|---|
| 1 | status.hedera.com lists "Testnet Upgrade to v0.79", Fri 2026-11-06 18:00 to 18:40 UTC, "some disruption to network services". That is inside the build window (about 26.5 hours after start). Whether testnet state survives is not stated | Plan no Hedera sends, CCIP messages or demo claims across that window; read the status page again before it |
| 2 | CCIP lane is structurally live both ways but idle: last message on each direction was 2026-10-04, 31 days ago, both SUCCESS (Hedera to Arbitrum 41 s; Arbitrum to Hedera 15 m 16 s). Nothing newer exists to show it still delivers | A timed ping both ways is still needed before relying on it |
| 3 | Hedera JSON-RPC: only `testnet.hashio.io` passes every request shape. `296.rpc.thirdweb.com` answers `eth_chainId` but returns HTTP 429 on follow-up calls within seconds | Effectively one free Hedera relay; a second needs a key |
| 4 | Arbitrum Sepolia `eth_call` at the `finalized` block fails on `arbitrum-sepolia-rpc.publicnode.com` (historical state not available) | Do not use that endpoint for finalized reads |
| 5 | Arbitrum Sepolia `eth_getLogs` over 2,000 blocks fails on `arbitrum-sepolia.drpc.org` (HTTP 400, free-plan range message) though `eth_call` passes there | Do not use that endpoint for log scans |
| 6 | `sepolia-rollup.arbitrum.io` served state only up to a few thousand blocks back (the 7,000-block read failed). Finalized lag today is about 4,200 blocks (about 17 minutes), inside that window; on slow days the lag is larger and the finalized read would fail there. `arbitrum-sepolia.gateway.tenderly.co` and `arbitrum-sepolia-testnet.api.pocket.network` served the 7,000-block read | Prefer tenderly plus the Arbitrum foundation endpoint; keep reads at `latest` where possible; a keyed archive endpoint is safer |
| 7 | Free endpoints are intermittent: a second run showed a transient `eth_getLogs` error on `ethereum-sepolia-rpc.publicnode.com` that passed on first run and on three retries | Retry once before treating a free endpoint as down |
| 8 | Not read (see end of file): `ccip-cli` fee quotes, signing options and timed pings; per-role USDC association and LINK balances (no Hedera accounts exist yet); Arkiv, LLM, IPFS pin, public host, alert path | Still open |

## Results

| Check | What was read | Value | Result | Time UTC |
|---|---|---|---|---|
| RPC-H1 | Hedera JSON-RPC testnet.hashio.io: chain id | 296 in 376 ms | PASS | 17:27:24 |
| RPC-H1 | testnet.hashio.io: gas price (weibar per gas) | 1320000000000 | PASS | 17:27:24 |
| RPC-H1 | testnet.hashio.io: eth_getLogs 2,000 blocks on LINK | answered, 0 log(s) in range | PASS | 17:27:25 |
| RPC-H1 | testnet.hashio.io: eth_call at latest (LINK symbol) | "LINK"  | PASS | 17:27:26 |
| RPC-H1 | testnet.hashio.io: eth_sendRawTransaction with a malformed tx | JSON-RPC error, code -32000 | PASS | 17:27:27 |
| RPC-H2 | Hedera JSON-RPC 296.rpc.thirdweb.com: chain id | 296 in 370 ms | PASS | 17:27:27 |
| RPC-H2 | 296.rpc.thirdweb.com: gas price | Error: Max retries exceeded HTTP error 429 with body: You are using a public RPC  | FAIL (rate limited or refused) | 17:27:34 |
| RPC-H2 | 296.rpc.thirdweb.com: eth_blockNumber | Error: Max retries exceeded HTTP error 4  | FAIL | 17:27:41 |
| RPC-H2 | 296.rpc.thirdweb.com: eth_sendRawTransaction with a malformed tx | You are using a public RPC with rate limits, to lift those limits you can obtain an api key at https | FAIL (no JSON-RPC error) | 17:27:41 |
| MIRROR-1 | mirror testnet.mirrornode.hedera.com: latest block | 42705314 in 425 ms | PASS | 17:27:41 |
| MIRROR-2 | mirror: contract results/logs page (LINK 0.0.4640464) | fields: {"topics":3,"data_len":66,"has_address":true,"has_block":true} | PASS | 17:27:42 |
| MIRROR-3 | mirror: topic messages page (topic 0.0.4469620, sequencenumber=gte:1) | fields: chunk_info,consensus_timestamp,message,payer_account_id,running_hash,running_hash_version,sequence_number,topic_id | PASS | 17:27:42 |
| USDC-1 | mirror: token 0.0.429274 | {"symbol":"USDC","decimals":"6","type":"FUNGIBLE_COMMON","deleted":false,"pause_status":"NOT_APPLICABLE","freeze_default":false} | PASS | 17:27:43 |
| USDC-2 | USDC EVM facade 0x...068cda: symbol, decimals | "USDC", 6 | PASS | 17:27:46 |
| HEDERA-STATUS | status.hedera.com: overall, testnet components, scheduled testnet maintenance | overall: Minor Service Outage; testnet components not operational: none; scheduled: Testnet Upgrade to v0.79 2026-11-06T18:00:00.000Z to 2026-11-06T18:40:00.000Z | WORRY (testnet maintenance inside the build window) | 17:27:46 |
| RPC-A:sepolia-rollup.arbitrum.io | sepolia-rollup.arbitrum.io: block finalized vs latest | finalized 326361451, latest 326365148, lag 3697 blocks, 313 ms | PASS | 17:27:47 |
| RPC-A:sepolia-rollup.arbitrum.io | sepolia-rollup.arbitrum.io: eth_getLogs 2,000 blocks on KlerosCore | answered in 325 ms, 0 log(s) | PASS | 17:27:47 |
| RPC-A:sepolia-rollup.arbitrum.io | sepolia-rollup.arbitrum.io: eth_call at finalized block 326361451 (paused()) | false  | PASS | 17:27:49 |
| RPC-A:sepolia-rollup.arbitrum.io | sepolia-rollup.arbitrum.io: eth_call 7,000 blocks behind latest (state depth) | Error: server returned an error response: error code -32000: historical state ba4682db1c4931132abdc1e786d6a88d | INFO (state pruned) | 17:27:50 |
| RPC-A:arbitrum-sepolia.gateway.tenderly.co | arbitrum-sepolia.gateway.tenderly.co: block finalized vs latest | finalized 326361451, latest 326365166, lag 3715 blocks, 377 ms | PASS | 17:27:51 |
| RPC-A:arbitrum-sepolia.gateway.tenderly.co | arbitrum-sepolia.gateway.tenderly.co: eth_getLogs 2,000 blocks on KlerosCore | answered in 439 ms, 0 log(s) | PASS | 17:27:51 |
| RPC-A:arbitrum-sepolia.gateway.tenderly.co | arbitrum-sepolia.gateway.tenderly.co: eth_call at finalized block 326361451 (paused()) | false  | PASS | 17:27:53 |
| RPC-A:arbitrum-sepolia.gateway.tenderly.co | arbitrum-sepolia.gateway.tenderly.co: eth_call 7,000 blocks behind latest (state depth) | false  | PASS | 17:27:55 |
| RPC-A:arbitrum-sepolia-testnet.api.pocket.network | arbitrum-sepolia-testnet.api.pocket.network: block finalized vs latest | finalized 326361451, latest 326365182, lag 3731 blocks, 473 ms | PASS | 17:27:56 |
| RPC-A:arbitrum-sepolia-testnet.api.pocket.network | arbitrum-sepolia-testnet.api.pocket.network: eth_getLogs 2,000 blocks on KlerosCore | answered in 491 ms, 0 log(s) | PASS | 17:27:56 |
| RPC-A:arbitrum-sepolia-testnet.api.pocket.network | arbitrum-sepolia-testnet.api.pocket.network: eth_call at finalized block 326361451 (paused()) | false  | PASS | 17:27:58 |
| RPC-A:arbitrum-sepolia-testnet.api.pocket.network | arbitrum-sepolia-testnet.api.pocket.network: eth_call 7,000 blocks behind latest (state depth) | false  | PASS | 17:27:59 |
| RPC-A:arbitrum-sepolia-rpc.publicnode.com | arbitrum-sepolia-rpc.publicnode.com: block finalized vs latest | finalized 326361451, latest 326365196, lag 3745 blocks, 260 ms | PASS | 17:28:00 |
| RPC-A:arbitrum-sepolia-rpc.publicnode.com | arbitrum-sepolia-rpc.publicnode.com: eth_getLogs 2,000 blocks on KlerosCore | answered in 422 ms, 0 log(s) | PASS | 17:28:00 |
| RPC-A:arbitrum-sepolia-rpc.publicnode.com | arbitrum-sepolia-rpc.publicnode.com: eth_call at finalized block 326361451 (paused()) | Error: server returned an error response: error code -32000: historical state f64c0857164e37435323752851530e9b | FAIL | 17:28:01 |
| RPC-A:arbitrum-sepolia-rpc.publicnode.com | arbitrum-sepolia-rpc.publicnode.com: eth_call 7,000 blocks behind latest (state depth) | Error: server returned an error response: error code -32000: historical state 3977d7fcf5ce6f4e3cdcff4d003d2d05 | INFO (state pruned) | 17:28:03 |
| RPC-A:arbitrum-sepolia.drpc.org | arbitrum-sepolia.drpc.org: block finalized vs latest | finalized 326361451, latest 326365211, lag 3760 blocks, 588 ms | PASS | 17:28:04 |
| RPC-A:arbitrum-sepolia.drpc.org | arbitrum-sepolia.drpc.org: eth_getLogs 2,000 blocks on KlerosCore | Error: HTTP error 400 with body: {"id":0,"jsonrpc":"2.0","error":{"message":"ranges over 10000 blocks are not  | FAIL | 17:28:04 |
| RPC-A:arbitrum-sepolia.drpc.org | arbitrum-sepolia.drpc.org: eth_call at finalized block 326361451 (paused()) | false  | PASS | 17:28:05 |
| RPC-A:arbitrum-sepolia.drpc.org | arbitrum-sepolia.drpc.org: eth_call 7,000 blocks behind latest (state depth) | Error: server returned an error response: error code -32000: historical state 596a443a861d0a2b31a6b66c522c6df9 | INFO (state pruned) | 17:28:07 |
| RPC-S:ethereum-sepolia-rpc.publicnode.com | ethereum-sepolia-rpc.publicnode.com: chain tip, getLogs 2,000 blocks (LINK), eth_call at finalized | finalized 12070882, lag 79; logs: ok; call: "LINK"  | PASS | 17:28:09 |
| RPC-S:sepolia.gateway.tenderly.co | sepolia.gateway.tenderly.co: chain tip, getLogs 2,000 blocks (LINK), eth_call at finalized | finalized 12070882, lag 79; logs: ok; call: "LINK"  | PASS | 17:28:12 |
| RPC-S:eth-sepolia-testnet.api.pocket.network | eth-sepolia-testnet.api.pocket.network: chain tip, getLogs 2,000 blocks (LINK), eth_call at finalized | finalized 12070882, lag 80; logs: ok; call: "LINK"  | PASS | 17:28:16 |
| RPC-S:0xrpc.io | 0xrpc.io: chain tip, getLogs 2,000 blocks (LINK), eth_call at finalized | finalized 12070882, lag 79; logs: ok; call: "LINK"  | PASS | 17:28:19 |
| CCIP-hedera | hedera Router typeAndVersion (code present) | "Router 1.2.0" | PASS | 17:28:21 |
| CCIP-hedera | hedera Router isChainSupported(remote selector 3478487238524512106) | true | PASS | 17:28:23 |
| CCIP-hedera | hedera Router getOnRamp(remote) | 0x023B31f937cFb8ce59A264C73D3D4CB345Fb3Aef | PASS (matches expected) | 17:28:24 |
| CCIP-hedera | hedera Router getOffRamps lists (remote selector, expected OffRamp 0x7752798D2fD9e28b7020135A619dDD162d705f20) | 14 entries on the Router | PASS (pair listed) | 17:28:26 |
| CCIP-hedera | hedera OnRamp 0x023B31f937cFb8ce59A264C73D3D4CB345Fb3Aef typeAndVersion | "OnRamp 2.0.0" | PASS | 17:28:27 |
| CCIP-hedera | hedera OffRamp 0x7752798D2fD9e28b7020135A619dDD162d705f20 typeAndVersion | "OffRamp 2.0.0" | PASS | 17:28:29 |
| CCIP-arbitrum | arbitrum Router typeAndVersion (code present) | "Router 1.2.0" | PASS | 17:28:30 |
| CCIP-arbitrum | arbitrum Router isChainSupported(remote selector 222782988166878823) | true | PASS | 17:28:32 |
| CCIP-arbitrum | arbitrum Router getOnRamp(remote) | 0x6B9a7cF69F90Ae2659bfe3069fba5Aa308A48cC4 | PASS (matches expected) | 17:28:33 |
| CCIP-arbitrum | arbitrum Router getOffRamps lists (remote selector, expected OffRamp 0xC93218EB7B778bC0c13E5296140C8E4Fa1C440DA) | 68 entries on the Router | PASS (pair listed) | 17:28:35 |
| CCIP-arbitrum | arbitrum OnRamp 0x6B9a7cF69F90Ae2659bfe3069fba5Aa308A48cC4 typeAndVersion | "OnRamp 2.0.0" | PASS | 17:28:36 |
| CCIP-arbitrum | arbitrum OffRamp 0xC93218EB7B778bC0c13E5296140C8E4Fa1C440DA typeAndVersion | "OffRamp 2.0.0" | PASS | 17:28:37 |
| CCIP-SEL | chain selectors (from the Router lane tables above) | Hedera 222782988166878823, Arbitrum Sepolia 3478487238524512106 | PASS (both accepted by the other chain's Router) | 17:28:37 |
| CCIP-TRAFFIC | last message hedera-to-arbitrum (CCIP API) | 0x80c2d1957fef31d68a83e0a2ac54d3b3824e8c26d166f35c954c3fd2b730c3fe SUCCESS sent 2026-10-04T21:06:24.000Z received 2026-10-04T21:07:05.000Z; 31 days ago | PASS (last message SUCCESS; lane idle 31 days) | 17:28:38 |
| CCIP-EXEC | Arbitrum OffRamp getExecutionState(messageId of that message) | 2  | PASS (2 = SUCCESS; messageId is the lookup key) | 17:28:40 |
| CCIP-TRAFFIC | last message arbitrum-to-hedera (CCIP API) | 0x6323cf02d9b7729e05c2763f69c107fa5b38e978d095af08d47a0b70820812a4 SUCCESS sent 2026-10-04T21:32:26.000Z received 2026-10-04T21:47:42.000Z; 31 days ago | PASS (last message SUCCESS; lane idle 31 days) | 17:28:41 |
| CCIP-EXEC | Hedera OffRamp getExecutionState(messageId of that message) | 2  | PASS (2 = SUCCESS; messageId is the lookup key) | 17:28:42 |
| LINK | hedera LINK 0x90a386d59b9A6a4795a011e8f032Fc21ED6FEFb6 symbol, decimals | "LINK", 18 | PASS | 17:28:45 |
| LINK | arbitrum LINK 0xb1D4538B4571d411F07960EF2838Ce337FE1E80E symbol, decimals | "LINK", 18 | PASS | 17:28:48 |
| KLEROS | KlerosCore arbitrationCost(8,3,1 extraData) | 810000000000000 wei | PASS | 17:28:50 |
| KLEROS | court 8 getTimesPerPeriod (evidence, commit, vote, appeal; s) | [900, 2700, 1800, 2700] | PASS | 17:28:51 |
| KLEROS | KlerosCore paused() | false | PASS | 17:28:52 |
| KLEROS | court 8 supports dispute kit 1: isSupported(8,1) | true | PASS | 17:28:54 |
| KLEROS | court 8 courts(8): parent, hiddenVotes, minStake, alpha, feeForJuror, jurorsForCourtJump | 7, true, 11000000000000000000000, 170, 270000000000000, 7 | PASS (parent 7, hidden votes, minStake 11,000 PNK, fee/juror 0.00027 ETH) | 17:28:55 |
| KLEROS-IMPL | KlerosCore 0xE8442307d36e9bf6aB27F1A009F95CE8E11C3479: EIP-1967 implementation slot | 0x02f607722749cecd32db07aa0b0755281fe9d13c | PASS (matches expected) | 17:28:56 |
| KLEROS-IMPL | DisputeTemplateRegistry 0xe763d31Cb096B4bc7294012B78FC7F148324ebcb: EIP-1967 implementation slot | 0xf97791da66e0a8ff8ee4908872cfcacc641829ec | PASS (matches expected) | 17:28:56 |
| KLEROS-IMPL | EvidenceModule 0xA88A9a25cE7f1d8b3941dA3b322Ba91D009E1397: EIP-1967 implementation slot | 0xc4e64e6e949936a18269937fc1e18cb11e3db14d | PASS (matches expected) | 17:28:57 |
| KLEROS-IMPL | DisputeKitClassic 0x0c38f115D001d3b5bBec5e8D44f78C7B61A27D94: EIP-1967 implementation slot | 0xa122856b3b4c5fbca129088af3ceb204509805f0 | PASS (matches expected) | 17:28:57 |
| KLEROS | DisputeResolver 0xed31...7652 (test cases): code length | 7193 hex chars; arbitrator() = 0xE8442307d36e9bf6aB27F1A009F95CE8E11C3479  | PASS (contract) | 17:28:59 |
| KLEROS | PNK 0x34B944D42cAcfC8266955D07A80181D2054aa225 code present | 1523 hex chars | PASS | 17:28:59 |
| KLEROS | PNKFaucet 0x9f6ffc13B685A68ae359fCA128dfE776458Df464 code present | 2905 hex chars | PASS | 17:28:59 |
| PNK-FAUCET | PNKFaucet PNK balance and amount per claim (read only; no claim made) | faucet holds 1850000000000000000000000 wei PNK, pays 10000000000000000000000 wei per claim | PASS (10,000 PNK per claim) | 17:29:02 |
| KLEROS | currentRuling(1) on KlerosCore (decoded read) | 1 false false  | PASS | 17:29:04 |
| KLEROS-JUROR | SortitionModule getJurorBalance(court 8 juror 0x2453...d8c6, 8): total staked, locked, staked in court 8, courts (wei PNK) | 20724000000000000000000, 2244000000000000000000, 18255000000000000000000, 1 | PASS (court 8 stake of at least 11,000 PNK; the juror has locked stake in open disputes) | 17:29:05 |
| ERC8004 | IdentityRegistry 0x8004A818BFB912233c491871b3d84c89A494BD9e on Hedera testnet: code length, getVersion() | 263 hex chars; "2.0.0" | PASS | 17:29:07 |
| ERC8004 | ReputationRegistry 0x8004B663056A597Dffe9eCcC1965A193B7388713 on Hedera testnet: code length, getVersion() | 263 hex chars; "2.0.0" | PASS | 17:29:09 |
| ROLE:deployer | deployer 0x4A63342B48741dA2A84e7681eE8aCF4D56B4D964: Hedera balance (wei), Arbitrum Sepolia balance (wei), mirror account | hedera 0; arbitrum 0; mirror 404 (no account yet) | INFO (not funded) | 17:29:10 |
| ROLE:ops-hedera | ops-hedera 0xB5077EA5A97Ec3Ee8Ce9DeF73064aE82c4b7058d: Hedera balance (wei), Arbitrum Sepolia balance (wei), mirror account | hedera 0; arbitrum 0; mirror 404 (no account yet) | INFO (not funded) | 17:29:12 |
| ROLE:ops-arb | ops-arb 0xb9Ad51ffcA49AD8aC40DFaCd679Cf71965F4588B: Hedera balance (wei), Arbitrum Sepolia balance (wei), mirror account | hedera 0; arbitrum 0; mirror 404 (no account yet) | INFO (not funded) | 17:29:13 |
| ROLE:precheck-signer | precheck-signer 0x1036Ba3820ab816e142eB1D7D84fbaAF8351Cc8D: Hedera balance (wei), Arbitrum Sepolia balance (wei), mirror account | hedera 0; arbitrum 0; mirror 404 (no account yet) | INFO (not funded) | 17:29:14 |
| ROLE:platform | platform 0xff845c7d57eb58f30dEEE83a96010FeE055FdaF6: Hedera balance (wei), Arbitrum Sepolia balance (wei), mirror account | hedera 0; arbitrum 0; mirror 404 (no account yet) | INFO (not funded) | 17:29:15 |
| ROLE:agent | agent 0xC9d6E94A0Ada9293ACbf871c4bC15c580355b623: Hedera balance (wei), Arbitrum Sepolia balance (wei), mirror account | hedera 0; arbitrum 0; mirror 404 (no account yet) | INFO (not funded) | 17:29:16 |
| ROLE:shop | shop 0x0d87ED2F5D792561B53043Ff028956125c820287: Hedera balance (wei), Arbitrum Sepolia balance (wei), mirror account | hedera 0; arbitrum 0; mirror 404 (no account yet) | INFO (not funded) | 17:29:18 |
| ROLE:scheme | scheme 0x54E4545AFcf8960884A750320e70aFE16b2b3CaE: Hedera balance (wei), Arbitrum Sepolia balance (wei), mirror account | hedera 0; arbitrum 0; mirror 404 (no account yet) | INFO (not funded) | 17:29:19 |
| ROLE:buyer | buyer 0x8A6f54dD8b639C2748cf3B3EFBb9fA7d54Fd4792: Hedera balance (wei), Arbitrum Sepolia balance (wei), mirror account | hedera 0; arbitrum 0; mirror 404 (no account yet) | INFO (not funded) | 17:29:21 |
| ROLE:facilitator | facilitator 0xa16eC81150F648aC59f39d11aaB2dAdB1db84e32: Hedera balance (wei), Arbitrum Sepolia balance (wei), mirror account | hedera 0; arbitrum 0; mirror 404 (no account yet) | INFO (not funded) | 17:29:22 |

Reading the table:
- Hedera balances are weibar over JSON-RPC (1 HBAR = 10^18); Arbitrum balances are wei.
- `mirror 404` for a role means the mirror node has no account for that EVM address yet.
- The Router reports `typeAndVersion` "Router 1.2.0" while the OnRamp and OffRamp report 2.0.0; both are as expected for this lane. Lane liveness was read through `isChainSupported`, `getOnRamp` and `getOffRamps` on each Router.
- `getExecutionState(messageId)` on the destination OffRamp returned 2 (success) for the last real message each way, so the message id is the correct lookup key.
- `getLogs` rows show 0 logs because KlerosCore and the LINK token emitted nothing in the 2,000-block window; the request shape answered.
- PNK faucet: read only, no claim made. Per-address claim state of the two standby juror addresses is not read yet.
- Court 8 read matches: arbitration cost 0.00081 ETH for extra data (8, 3, 1), periods 900/2700/1800/2700 s, not paused, dispute kit 1 supported, minStake 11,000 PNK, fee per juror 0.00027 ETH. The four Kleros proxies point at the expected implementations. The court 8 juror holds 18,255 PNK in court 8 with 2,244 locked.

## Not read in this pass

| Check | Why |
|---|---|
| `ccip-cli` fee quotes, `send --help` / `manual-exec --help` signing options, timed pings, `ccip-cli show` | The package download was not permitted in this session; pings also need funded wallets |
| Hedera accounts exist, are ECDSA and not hollow; USDC association and balances; LINK and HBAR on ops roles | No account exists yet (mirror 404 for all ten addresses); see `docs/keys.md` and `ops/fund/` |
| Arkiv RPC chain id and tGLM, LLM key, IPFS pin key, public HTTPS host, alert path | No credentials or host set up on this machine yet. The public gateway `gateway.pinata.cloud` served the court 8 policy CID with 200 in 8.7 s; `ipfs.io` and `dweb.link` returned 429 |
| ERC-8004 `register` overloads and the self-feedback revert check | Needs the verified ABI; only code and `getVersion()` were read |
| Facilitator `/supported` lists, Goldsky subgraph (recent court 8 disputes) | Not run |

## Gate log

Rows are appended and never edited; a correction is a new row. Columns: time, id, action, result, link, decision, by.

| Time | Id | Action | Result | Link | Decision | By |
|---|---|---|---|---|---|---|
