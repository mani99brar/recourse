# Backlog: shared core

Open items, each small and self-contained.

- **Live address check.** No script yet reads the chains to confirm the address book: `eth_chainId`
  (0x128 Hedera testnet, 0x66eee Arbitrum Sepolia), `eth_getCode` non-empty for every contract
  entry, and the mirror node's decimals for USDC `0.0.429274`. It is read-only and needs no keys.
- **Status vectors.** `deriveStatus` cases live inline in `packages/shared/test/status.test.ts`.
  There is no JSON vector file that other packages can replay.
- **Batch draws.** The status and settle code covers `undrawn`, but no shared helper picks or checks
  a batch draw. `batchSize` and `pBps` exist only as params until the Hedera contracts ship
  batches.
- **CCIP CLI signing.** `ccip-cli` 1.16.1 signs with `--wallet foundry:<name>` (Foundry named
  keystores) or a raw key in `USER_KEY`. It has not been checked how it reads a keystore from
  `KEYSTORE_DIR` with its password file. Until that is checked, use it only for read commands
  (`show`, `lane`, `--only-estimate`). Its `--rpcs-file` defaults to `./.env`, so pass `--rpcs`
  explicitly.
- **Native add-ons.** The CLI's native add-ons (USB/HID for hardware wallets, keccak, bigint-buffer,
  ws speedups) are not built. They fall back to plain JS, and the CLI prints one
  `bigint: Failed to load bindings` line.
- **Workspace-wide checks.** `pnpm -r typecheck` and a full `forge build` depend on every
  package's files. The `packages/shared` and `contracts/test/shared` checks run on their own.
