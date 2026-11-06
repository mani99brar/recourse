# Contract source verification

`ops/verify/verify.sh` publishes the source of every contract in `deployments/hedera.json` and `deployments/arbitrum.json` so the explorers show it, and prints a table of the result. It sends no transaction and needs no funds or keys, except the optional Etherscan key below.

| Chain | Verifier | Where it shows |
|---|---|---|
| Hedera testnet (296) | Sourcify (`forge verify-contract --verifier sourcify`) | HashScan, `https://hashscan.io/testnet/contract/<address>`, and `https://repo.sourcify.dev/296/<address>` |
| Arbitrum Sepolia (421614) | Sourcify | `https://repo.sourcify.dev/421614/<address>` |
| Arbitrum Sepolia (421614) | Arbiscan, through Etherscan's v2 API (`--verifier etherscan`) | `https://sepolia.arbiscan.io/address/<address>#code` |

HashScan reads verified source from Sourcify: its `networks-config.json` names `sourcify.dev/server` and `repo.sourcify.dev` for chain 296, and its old verification server (`server-verify.hashscan.io`) redirects to `sourcify.dev/server`. So a Sourcify match on 296 is what HashScan shows.

## Running it

```
bash ops/verify/verify.sh --dry-run            # builds, compares, reads the status; sends nothing
bash ops/verify/verify.sh                      # both chains
bash ops/verify/verify.sh --chain hedera       # or --chain arbitrum
```

After a redeploy nothing else is needed: once `deployments/*.json` and the new `contracts/broadcast/*/<chainId>/run-*.json` are written, run it again. A contract a verifier already holds is reported and not sent again, so a rerun is safe.

For each contract (every entry under `contracts`, plus `usdc` when `usdc.mode` is `mock`, because that token is this repo's `MockUsdc`; Circle's USDC is not ours to verify), it:

1. finds the CREATE for the address in `contracts/broadcast/*/<chainId>/run-*.json`, which gives the contract name, the creation input and the `commit` forge recorded when it deployed;
2. checks that commit out in a detached git worktree under `${TMPDIR:-/tmp}/recourse-verify-src/<sha>` (`--src-dir` or `RECOURSE_VERIFY_SRC` to move it), links the repo's `node_modules` into it, and runs `forge build` there with the commit's own `foundry.toml` and `remappings.txt`; the main checkout is not touched;
3. compares the build's creation code with the deploy's input: `exact` (byte for byte, metadata hash included), `partial` (the same code with other metadata) or `differs`. Nothing is sent for `differs`. The constructor arguments are the rest of the input after that code;
4. reads Sourcify's status (`GET /v2/contract/<chainId>/<address>`) and sends the contract only when Sourcify has no match;
5. on Arbitrum, does the same on Arbiscan when `~/.config/recourse/etherscan.key` exists (one line, the key; `ETHERSCAN_KEY_FILE` to move it). The key goes to forge in `ETHERSCAN_API_KEY` and to curl on stdin, never on a command line, and is never printed. With no key file the row says `Arbiscan pending: no key`.

It exits 1 when any row failed and 2 on a usage error. `VERIFY_COMMIT=<commit>` builds every contract from that commit instead of the one recorded, for a deploy made from a tree with changes that were committed later. `VERIFY_LOCK=<file>` runs each `forge build` under `flock -w 1800 <file>`. When `FOUNDRY_OUT` and `FOUNDRY_CACHE_PATH` are set, each commit builds into `<dir>/<sha>` under them.

The worktrees stay registered in this clone (`git worktree list`). Remove one with `git worktree remove --force <dir>`, or delete the dirs and run `git worktree prune`.

## What "verified" means

Sourcify recompiles the published source with the published settings and compares the result with the code on chain.

- **Full match** (Sourcify's `exact_match`, HashScan's "Full Match"): the bytecode and the metadata hash solc appends to it are both identical. The metadata covers every source file byte for byte, the compiler version and the settings, so the published files are exactly the ones that were compiled.
- **Partial match** (`match`, "Partial Match"): the executable bytecode is identical but the metadata hash is not, for example because a comment, a file path or a metadata setting differs. The code that runs is the published code; the files are not proven to be byte for byte the same.

Sourcify compares the runtime code (`runtimeMatch`) and, when it can fetch the creation transaction, the creation code too (`creationMatch`); `match` is the better of the two. On Hedera it has given `runtimeMatch: exact_match` with `creationMatch: null`: it matched the code on chain without reading the creation transaction. The script's own check (step 3) covers the creation code.

Arbiscan has no full or partial level: a contract is verified or it is not. It needs the constructor arguments, which the script passes.

## When a chain is down

Sourcify reads Hedera through its own RPC provider, not `testnet.hashio.io`, so a relay outage there does not stop it; a Hedera testnet pause does. A failed row gives the tool's own error, for example `failed (exit 1): Error: ...`, and the next contract is still tried. Run it again once the chain is back; contracts that are done are skipped.
