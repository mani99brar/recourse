#!/usr/bin/env bash
# Throwaway-repo test of commit.sh: bash ops/scripts/commit-test.sh [commit.sh to test]
# Builds a repo and a bare remote in a temp folder (with its own lock file) and checks what gets committed and pushed.
set -uo pipefail
C=$(readlink -f "${1:-$(dirname "$0")/commit.sh}")
W=$(mktemp -d "${TMPDIR:-/tmp}/commit-test.XXXXXX"); trap 'rm -rf "$W"' EXIT
export GIT_LOCK_FILE=$W/git.lock
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
TR="Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git init -q --bare "$W/remote.git"
git init -q -b main "$W/work"; cd "$W/work"
git config user.email t@example.invalid; git config user.name test
git remote add origin "$W/remote.git"
echo a > a.txt; echo b > b.txt; echo d > d.txt; mkdir dir; echo x > dir/x.txt
git add -A; git commit -qm init; git push -q origin main
run() { bash "$C" "$@" > "$W/out" 2>&1; }
files_of() { git show --name-only --format= "$1" | sort | tr '\n' ' '; }

echo mine >> a.txt; echo theirs >> b.txt; git add b.txt
run "mine only" a.txt; rc=$?
[ $rc = 0 ] && [ "$(files_of HEAD)" = "a.txt " ] && ok "only the named path is committed" || { bad "only the named path is committed (rc $rc, files: $(files_of HEAD))"; }
git diff --cached --name-only | grep -qx b.txt && ok "another writer's staged file stays staged" || bad "another writer's staged file stays staged"
[ "$(git rev-parse origin/main)" = "$(git rev-parse HEAD)" ] && ok "pushed to origin main" || bad "pushed to origin main"
git reset -q b.txt; git checkout -q b.txt

msg=$(git log -1 --format=%B); [ "$(grep -c "$TR" <<<"$msg")" = 1 ] && ok "trailer added once when missing" || bad "trailer added once when missing"
echo more >> a.txt; run "$(printf 'with trailer\n\nbody\n\n%s' "$TR")" a.txt
msg=$(git log -1 --format=%B); [ "$(grep -c "$TR" <<<"$msg")" = 1 ] && ok "trailer not doubled when present" || bad "trailer not doubled when present ($(grep -c "$TR" <<<"$msg"))"

rm d.txt; run "delete d" d.txt; rc=$?
[ $rc = 0 ] && ! git cat-file -e HEAD:d.txt 2>/dev/null && ok "a deleted path is committed" || { bad "a deleted path is committed (rc $rc)"; sed 's/^/    /' "$W/out"; }

echo new > n.txt; run "new file" n.txt; rc=$?
[ $rc = 0 ] && git cat-file -e HEAD:n.txt 2>/dev/null && ok "a new file is committed" || { bad "a new file is committed (rc $rc)"; sed 's/^/    /' "$W/out"; }

echo y > dir/y.txt; echo x2 >> dir/x.txt; run "dir" dir; rc=$?
[ $rc = 0 ] && [ "$(files_of HEAD)" = "dir/x.txt dir/y.txt " ] && ok "a directory pathspec commits what is under it" || { bad "a directory pathspec (rc $rc, $(files_of HEAD))"; sed 's/^/    /' "$W/out"; }

run "nothing" a.txt; rc=$?
[ $rc = 0 ] && grep -q "nothing staged" "$W/out" && ok "nothing to commit exits 0" || bad "nothing to commit exits 0 (rc $rc)"

main_before=$(git rev-parse origin/main)
git checkout -qb feature; echo f > f.txt; run "feature work" f.txt; rc=$?
git fetch -q origin
[ $rc = 0 ] && [ "$(git rev-parse origin/main)" = "$main_before" ] && ok "a feature branch does not move origin main" || bad "a feature branch does not move origin main (rc $rc)"
[ "$(git rev-parse origin/feature 2>/dev/null)" = "$(git rev-parse HEAD)" ] && ok "a feature branch is pushed to its own name" || bad "a feature branch is pushed to its own name"
git checkout -q main

git checkout -q --detach; echo z > z.txt; run "detached" z.txt; rc=$?
[ $rc != 0 ] && ok "a detached HEAD is refused" || bad "a detached HEAD is refused"
rm -f z.txt; git reset -q; git checkout -q main

git remote set-url origin "$W/missing.git"
echo q >> a.txt; start=$(date +%s); run "offline" a.txt; rc=$?
[ $rc != 0 ] && ok "a failed push exits non-zero ($(( $(date +%s) - start )) s)" || bad "a failed push exits non-zero"
git log -1 --format=%s | grep -qx offline && ok "the commit is kept after a failed push" || bad "the commit is kept after a failed push"

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
