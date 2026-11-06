#!/usr/bin/env bash
# Throwaway-repo test of the secret scan as the pre-push hook: bash ops/scan/scan-test.sh [scan.sh to test]
# Builds a repo and a bare remote in a temp folder, installs the scan as their pre-push hook and pushes good and
# bad commits. Every key it uses is generated at run time (openssl rand) and lives only in the temp folder.
set -uo pipefail
SCAN=$(readlink -f "${1:-$(dirname "$0")/scan.sh}")
W=$(mktemp -d "${TMPDIR:-/tmp}/scan-test.XXXXXX"); trap 'rm -rf "$W"' EXIT
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
hex() { openssl rand -hex 32; }
git init -q --bare "$W/remote.git"
git init -q -b main "$W/work"; cd "$W/work"
git config user.email t@example.invalid; git config user.name test
git remote add origin "$W/remote.git"
mkdir -p ops/scan; cp "$SCAN" ops/scan/scan.sh; chmod +x ops/scan/scan.sh
printf '#!/usr/bin/env bash\nexec "$(git rev-parse --show-toplevel)/ops/scan/scan.sh"\n' > .git/hooks/pre-push; chmod +x .git/hooks/pre-push
echo hello > a.txt; git add -A; git commit -qm init
push() { git push -q origin "$@" > "$W/out" 2>&1; }
expect_push_ok() { if push "$@"; then ok "$NAME"; else bad "$NAME"; sed 's/^/    /' "$W/out"; fi; }
expect_push_blocked() { if push "$@"; then bad "$NAME (push went through)"; else
  if grep -q "secret-scan: $LABEL" "$W/out"; then ok "$NAME"; else bad "$NAME (wrong reason)"; sed 's/^/    /' "$W/out"; fi; fi; }
reset_to_remote() { git reset -q --hard origin/main; git clean -qfd; }

NAME="clean first push"; expect_push_ok main

K=$(hex)
echo "DEPLOYER_PRIVATE_KEY=0x$K" > leak.txt; git add leak.txt; git commit -qm leak
echo clean > leak.txt; git commit -qam "remove it"
NAME="key committed then removed in the same push is blocked"; LABEL="hex key next to a key word"; expect_push_blocked main
if grep -q "$K" "$W/out"; then bad "the key value is printed"; else ok "the key value is not printed"; fi
reset_to_remote

echo "PLATFORM_KEY=0x$(hex)" > a.env.txt; git add -A; git commit -qm k2
NAME="PLATFORM_KEY=0x<64 hex> is blocked"; LABEL="hex key next to a key word"; expect_push_blocked main; reset_to_remote

printf '{"key":"0x%s"}\n' "$(hex)" > k.json; git add -A; git commit -qm k3
NAME='{"key":"0x<64 hex>"} is blocked'; LABEL="hex key next to a key word"; expect_push_blocked main; reset_to_remote

printf "const publicKey = '0x%s%s';\nconst txHash = '0x%s';\n" "$(hex)" "$(hex)" "$(hex)" > pub.ts; git add -A; git commit -qm pub
NAME="a 64-byte public key and a tx hash pass"; expect_push_ok main

mkdir -p cfg; echo "SHOP_PORT=8720" > cfg/recourse.env; git add -A; git commit -qm env
NAME="a tracked recourse.env is blocked"; LABEL="forbidden path tracked"; expect_push_blocked main; reset_to_remote

touch role.json.pass; git add -A; git commit -qm p1; git rm -q role.json.pass; git commit -qm p2
NAME="a .pass file added and removed in the same push is blocked"; LABEL="forbidden path tracked"; expect_push_blocked main; reset_to_remote

AK=$(openssl rand -hex 16)
echo "ARB_RPC_URL=https://arb-sepolia.g.alchemy.com/v2/$AK" > rpc.txt; git add -A; git commit -qm rpc
NAME="a keyed RPC URL is blocked"; LABEL="RPC url with key"; expect_push_blocked main
if grep -q "$AK" "$W/out"; then bad "the RPC key is printed"; else ok "the RPC key is not printed"; fi
reset_to_remote

echo "ARKIV_ACCESS_KEY=$(openssl rand -hex 12)" > cli.env.sample; git add -A; git commit -qm ak
NAME="an unquoted secret in an env-style line is blocked"; LABEL="secret assigned in an env file"; expect_push_blocked main; reset_to_remote

echo "DEPLOYER_PRIVATE_KEY=0x$(hex)" > untracked-leak.txt
echo more >> a.txt; git commit -qam "clean change"
NAME="a key only in the working tree does not block a clean push"; expect_push_ok main
rm -f untracked-leak.txt

git checkout -qb feature; echo "DEPLOYER_PRIVATE_KEY=0x$(hex)" > f.txt; git add -A; git commit -qm f
NAME="a new branch is scanned too"; LABEL="hex key next to a key word"; expect_push_blocked feature
git checkout -q main; git branch -qD feature

git checkout -qb feature2; echo fine > g.txt; git add -A; git commit -qm g
NAME="a clean new branch passes"; expect_push_ok feature2
NAME="a branch deletion passes"; expect_push_ok --delete feature2
git checkout -q main

L="const SPEC = { private_key: '0x$(hex)' };"
printf '%s\n' "$L" > vec.ts; printf 'vec.ts %s\n' "$(printf '%s' "$L" | sha256sum | cut -d' ' -f1)" > ops/scan/allow.txt
git add -A; git commit -qm vec
NAME="an allowed test vector passes"; expect_push_ok main
printf "%s\n" "${L/SPEC/SPEC2}" > vec.ts; git commit -qam "vec changed"
NAME="a changed allowed line is blocked again"; LABEL="hex key next to a key word"; expect_push_blocked main; reset_to_remote

echo "DEPLOYER_PRIVATE_KEY=0x$(hex)" > tree.txt; git add tree.txt
NAME="by hand (--tree) the tracked files are scanned"
if bash ops/scan/scan.sh --tree > "$W/out" 2>&1; then bad "$NAME"; else grep -q "hex key next to a key word" "$W/out" && ok "$NAME" || bad "$NAME"; fi
NAME="by hand with stdin from /dev/null the tracked files are scanned"
if bash ops/scan/scan.sh < /dev/null > "$W/out" 2>&1; then bad "$NAME"; else ok "$NAME"; fi
git rm -qf --cached tree.txt; rm -f tree.txt
NAME="by hand on a clean tree passes"
if bash ops/scan/scan.sh < /dev/null > "$W/out" 2>&1; then ok "$NAME"; else bad "$NAME"; sed 's/^/    /' "$W/out"; fi

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
