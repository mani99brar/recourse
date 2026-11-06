#!/usr/bin/env bash
# Serialised commit + push for parallel work in one tree: ops/scripts/commit.sh "<message>" <path>...
# Commits only the given paths: anything else already staged stays staged and out of this commit, so concurrent
# writers never commit each other's files. Pushes the current branch to the branch of the same name on origin
# (never to main from another branch) and exits non-zero if the push still fails after three tries; the commit
# is then kept locally. The Co-Authored-By trailer is added unless the message already ends with it.
set -euo pipefail
[ $# -ge 2 ] || { echo "usage: commit.sh \"<message>\" <path>..." >&2; exit 2; }
msg=$1; shift
cd "$(git rev-parse --show-toplevel)"
lock="${GIT_LOCK_FILE:-$HOME/.local/state/recourse/git.lock}"
exec 9>"$lock"; flock -w 300 9
branch=$(git symbolic-ref --quiet --short HEAD) || { echo "commit.sh: HEAD is detached; check out a branch first" >&2; exit 1; }
git add -A -- "$@"
if git diff --cached --quiet -- "$@"; then echo "commit.sh: nothing staged"; exit 0; fi
trailer="Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
case "$msg" in *"$trailer") ;; *) msg="$msg"$'\n\n'"$trailer" ;; esac
git commit -q -m "$msg" -- "$@"
git log --oneline -1
if git remote get-url origin >/dev/null 2>&1; then
  for i in 1 2 3; do
    if git push -q origin "HEAD:refs/heads/$branch" 2>&1; then exit 0; fi
    [ "$i" = 3 ] || sleep 5
  done
  echo "commit.sh: pushing $branch to origin failed three times; the commit is kept locally, push it by hand" >&2
  exit 1
fi
