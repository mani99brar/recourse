#!/usr/bin/env bash
# Serialised commit + push for parallel work in one tree: ops/scripts/commit.sh "<message>" <path>...
# Stages only the given paths, so concurrent writers never commit each other's files.
set -euo pipefail
msg=$1; shift
cd "$(git rev-parse --show-toplevel)"
lock="${GIT_LOCK_FILE:-$HOME/.local/state/recourse/git.lock}"
exec 9>"$lock"; flock -w 300 9
git add -A -- "$@"
if git diff --cached --quiet; then echo "commit.sh: nothing staged"; exit 0; fi
git commit -q -m "$msg" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1
if git remote get-url origin >/dev/null 2>&1; then
  for i in 1 2 3; do git push -q origin HEAD:main 2>&1 && break || sleep 5; done
fi
