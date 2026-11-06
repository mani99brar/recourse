#!/usr/bin/env bash
# Offline test of send_cast's chain guard: bash ops/fund/lib-test.sh
# A stub cast on PATH answers chain-id with the id a case gives it and writes down every send instead of sending.
# Nothing reaches a network, and the keystore, address and env paths point into an empty temp folder.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
W=$(mktemp -d "${TMPDIR:-/tmp}/fund-test.XXXXXX"); trap 'rm -rf "$W"' EXIT
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); sed 's/^/    /' "$W/out"; }
mkdir "$W/bin"
cat > "$W/bin/cast" <<'EOF'
#!/usr/bin/env bash
case $1 in
  chain-id) echo asked >> "$STUB_LOG.asked"; [ -n "$STUB_CHAIN" ] || { echo "Error: error sending request for url ($3)" >&2; exit 1; }; echo "$STUB_CHAIN" ;;
  send) shift; echo "$*" >> "$STUB_LOG" ;;
  *) echo "stub cast: $1 is not stubbed" >&2; exit 1 ;;
esac
EOF
chmod +x "$W/bin/cast"
export PATH="$W/bin:$PATH" STUB_LOG="$W/sends"
export RECOURSE_ENV_FILE="$W/none.env" ADDRS_FILE="$W/addresses.txt" KEYSTORE_DIR="$W/keys"
KEY=$(openssl rand -hex 16)
export HEDERA_RPC_URL_1="https://hedera.example.invalid/v2/$KEY" ARB_RPC_URL=https://arbitrum.example.invalid/rpc

# send <chain id the RPC answers, empty = no answer> <rpc> [--send]: send_cast deployer in a fresh shell, output in $W/out
send() {
  : > "$STUB_LOG"; : > "$STUB_LOG.asked"
  STUB_CHAIN=$1 bash -c 'source "$0/lib.sh"; parse_send_flag "${@:2}" >/dev/null
    send_cast deployer "$1" 0x0000000000000000000000000000000000000001 --value 1' "$HERE" "$2" "${@:3}" > "$W/out" 2>&1
}
sent() { [ -s "$STUB_LOG" ]; }

NAME="a Hedera send on chain 296 goes, signed for 296"
if send 296 "$HEDERA_RPC_URL_1" --send && grep -q -- '--chain 296' "$STUB_LOG"; then ok "$NAME"; else bad "$NAME"; fi
NAME="an Arbitrum send on chain 421614 goes, signed for 421614"
if send 421614 "$ARB_RPC_URL" --send && grep -q -- '--chain 421614' "$STUB_LOG"; then ok "$NAME"; else bad "$NAME"; fi
NAME="a Hedera RPC that answers another chain is refused"
if send 1 "$HEDERA_RPC_URL_1" --send || sent; then bad "$NAME"; else ok "$NAME"; fi
NAME="an Arbitrum RPC that answers Hedera's chain (swapped endpoints) is refused"
if send 296 "$ARB_RPC_URL" --send || sent; then bad "$NAME"; else ok "$NAME"; fi
NAME="an RPC that is neither HEDERA_RPC_URL_1 nor ARB_RPC_URL is refused"
if send 296 https://other.example.invalid --send || sent; then bad "$NAME"; else ok "$NAME"; fi
NAME="an RPC that does not answer is refused"
if send "" "$HEDERA_RPC_URL_1" --send || sent; then bad "$NAME"; else ok "$NAME"; fi
NAME="the refusal does not print the RPC URL's key"
if grep -qF "$KEY" "$W/out"; then bad "$NAME"; else ok "$NAME"; fi
NAME="a dry run sends nothing and asks the RPC nothing"
if send 1 "$HEDERA_RPC_URL_1" && ! sent && [ ! -s "$STUB_LOG.asked" ]; then ok "$NAME"; else bad "$NAME"; fi

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
