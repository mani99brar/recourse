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

# A value too short, or too broken up by punctuation, to look like a long token: no part of it is printed.
printed() { local p; for p in "$@"; do grep -qF "$p" "$W/out" && return 0; done; return 1; }
A=$(openssl rand -hex 4); B=$(openssl rand -hex 4); C=$(openssl rand -hex 3)
echo "DB_PASSWORD=$A!$B@$C" > db.env.sample; git add -A; git commit -qm pw
NAME="a short punctuated secret in an env-style line is blocked"; LABEL="secret assigned in an env file"; expect_push_blocked main
if printed "$A" "$B" "$C"; then bad "part of the short secret is printed"; else ok "no part of the short secret is printed"; fi
reset_to_remote
A=$(openssl rand -hex 12); B=$(openssl rand -hex 4)
echo "const auth = { token: '$A.$B!' };" > tok.ts; git add -A; git commit -qm tok
NAME="a quoted token literal is blocked"; LABEL="api key literal"; expect_push_blocked main
if printed "$A" "$B"; then bad "part of the token is printed"; else ok "no part of the token is printed"; fi
reset_to_remote

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

# Merges: both parents clean, the key only in the merge commit. Each case uses its own files, so a push the scan
# under test lets through cannot change the next case.
conflict_fork() { # <file>: pushes <file>, then side and main change the same line; the merge stops on the conflict
  printf 'line one\nshared line\n' > "$1"; git add "$1"; git commit -qm "base $1"; push main
  git checkout -qb side; sed -i 's/shared line/side line/' "$1"; git commit -qam side
  git checkout -q main; sed -i 's/shared line/main line/' "$1"; git commit -qam main-side
  git merge -q side -m merge >/dev/null 2>&1
}
clean_fork() { # <name>: side and main each add a file; the merge is left uncommitted
  git checkout -qb side; echo s > "$1.side"; git add -A; git commit -qm side
  git checkout -q main; echo t > "$1.main"; git add -A; git commit -qm main-side
  git merge -q --no-commit --no-ff side >/dev/null 2>&1
}
merge_commit() { # commits the merge in progress; a test whose setup made no merge fails
  if git rev-parse -q --verify MERGE_HEAD >/dev/null; then git commit -qm "merge side" --no-edit
  else bad "$NAME (setup: no merge in progress)"; fi
}
done_fork() { reset_to_remote; git branch -qD side; }

NAME="a key written only by a conflict resolution is blocked"; LABEL="hex key next to a key word"
conflict_fork m1.txt; printf 'line one\nDEPLOYER_PRIVATE_KEY=0x%s\n' "$(hex)" > m1.txt; git add m1.txt; merge_commit
expect_push_blocked main; done_fork

NAME="a file added only by a merge commit is scanned"; LABEL="hex key next to a key word"
clean_fork m2; echo "PLATFORM_KEY=0x$(hex)" > m2.evil; git add m2.evil; merge_commit
expect_push_blocked main; done_fork

NAME="a .pass file added by a merge and removed later in the push is blocked"; LABEL="forbidden path tracked"
clean_fork m3; touch m3.json.pass; git add m3.json.pass; merge_commit; git rm -q m3.json.pass; git commit -qm "drop it"
expect_push_blocked main; done_fork

NAME="a clean conflict resolution passes"
conflict_fork m4.txt; printf 'line one\nmain and side line\n' > m4.txt; git add m4.txt; merge_commit
expect_push_ok main; git branch -qD side

# Key shapes.
K=$(hex)
echo "cast send \$TO 'f()' --rpc-url \$RPC --private-key 0x$K" > send.sh; git add -A; git commit -qm pk
NAME="--private-key 0x<64 hex> is blocked"; LABEL="private key on a command line"; expect_push_blocked main
if grep -q "$K" "$W/out"; then bad "the --private-key value is printed"; else ok "the --private-key value is not printed"; fi
reset_to_remote
echo "cast send \$TO 'f()' --private-key \"\$PK\"   # placeholder, no literal" > send.sh; git add -A; git commit -qm pk2
NAME="--private-key with a variable passes"; expect_push_ok main

K=$(hex)
echo "const operator = PrivateKey.fromStringDer('302e020100300506032b657004220420$K');" > op.ts; git add -A; git commit -qm der1
NAME="a Hedera ED25519 DER private key is blocked"; LABEL="Hedera DER private key"; expect_push_blocked main
if grep -q "$K" "$W/out"; then bad "the DER key value is printed"; else ok "the DER key value is not printed"; fi
reset_to_remote
echo "OPERATOR_KEY=3030020100300706052b8104000a04220420$(hex)" > op.txt; git add -A; git commit -qm der2
NAME="a Hedera ECDSA DER private key is blocked"; LABEL="Hedera DER private key"; expect_push_blocked main; reset_to_remote
printf "const pubEd = '302a300506032b6570032100%s';\nconst pubEc = '302d300706052b8104000a032200%s02';\n" "$(hex)" "$(hex)" > pubder.ts
git add -A; git commit -qm pubder
NAME="Hedera DER public keys pass"; expect_push_ok main

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
