#!/usr/bin/env bash
# Offline test that readonly.sh never prints a keyed URL: bash ops/checks/readonly-test.sh
# Stubs on PATH: cast fails every call with an error that quotes its --rpc-url, as cast does when an endpoint
# cannot be reached, and curl answers nothing. Every key is made at run time and lives only in the temp folder.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
W=$(mktemp -d "${TMPDIR:-/tmp}/checks-test.XXXXXX"); trap 'rm -rf "$W"' EXIT
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
mkdir "$W/bin"
cat > "$W/bin/cast" <<'EOF'
#!/usr/bin/env bash
u=; while [ $# -gt 0 ]; do [ "$1" = --rpc-url ] && u=$2; shift; done
echo "Error: error sending request for url ($u): client error (Connect)" >&2; exit 1
EOF
printf '#!/usr/bin/env bash\nexit 0\n' > "$W/bin/curl"
chmod +x "$W/bin/cast" "$W/bin/curl"
K1=$(openssl rand -hex 16); K3=$(openssl rand -hex 16); K4=$(openssl rand -hex 16); K5=$(openssl rand -hex 16)
K6=$(openssl rand -hex 16)
# K2 is longer than any column, so a cut made before the URL is cleaned falls inside the password, before its '@'.
K2=$(openssl rand -hex 48)
echo "deployer 0x0000000000000000000000000000000000000001" > "$W/addresses.txt"
PATH="$W/bin:$PATH" ADDRS_FILE="$W/addresses.txt" \
  HEDERA_RPC_URL_1="https://hedera.example.invalid/v2/$K1" HEDERA_RPC_URL_2="https://rpcuser:$K2@hedera2.example.invalid" \
  ARB_RPC_URL="https://arbitrum.example.invalid?apikey=$K3" \
  ARB_RPC_URL_2="https://arbitrum2.example.invalid/v3/$K4 https://user:$K6@arbitrum3.example.invalid" \
  SEPOLIA_RPC_URL="https://sepolia.example.invalid/$K5/" bash "$HERE/readonly.sh" > "$W/out" 2>&1

NAME="the check table is written"
if [ "$(grep -c '^| ' "$W/out")" -gt 40 ]; then ok "$NAME"; else bad "$NAME"; sed 's/^/    /' "$W/out" | head -20; fi
NAME="no key from a URL's path, query or user info is printed, even from a failed call or a long password"
ends=(); for k in "$K1" "$K2" "$K3" "$K4" "$K5" "$K6"; do ends+=(-e "${k:0:12}" -e "${k: -12}"); done
if ! grep -qF "${ends[@]}" "$W/out"; then ok "$NAME"; else bad "$NAME"; grep -F "${ends[@]}" "$W/out" | head -8 | sed 's/^/    /'; fi
NAME="each endpoint is still named by its host"
if grep -q 'hedera2.example.invalid: ' "$W/out" && grep -q 'RPC-A:arbitrum.example.invalid |' "$W/out" && grep -q 'RPC-A:arbitrum2.example.invalid |' "$W/out" \
  && grep -q 'RPC-A:arbitrum3.example.invalid |' "$W/out"; then ok "$NAME"; else bad "$NAME"; fi

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
