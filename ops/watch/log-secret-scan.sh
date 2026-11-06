#!/usr/bin/env bash
# Looks for secrets in what the Recourse services log and keep, and prints where and how many, never the text.
#   bash ops/watch/log-secret-scan.sh        exit 0: nothing found; 1: a hit that may be a secret
# Reads:
#   - the journal of every recourse-* user unit (journalctl --user -u <unit> -o cat), every unit the journal
#     has seen and every installed unit file;
#   - every file under ~/.local/state/recourse/*/ and services/*/state/ of this checkout.
# Looks for:
#   1. the values of the variables in ~/.config/recourse/*.env whose names look secret (KEY, TOKEN, SECRET,
#      PASS; a *_FILE or *_DIR among them holds a path and is reported as such, not counted as a secret), and
#      of every *_URL whose value carries a key (userinfo, a query value, a long mixed path segment): the whole
#      URL and the key part alone;
#   2. a 64-hex string within 24 characters of "key" or "private";
#   3. shapes: Hedera DER and PEM private keys, keystore JSON, bot tokens, JWTs, common API key prefixes,
#      bearer tokens, RPC URLs with a key in the path or the query.
# Output: "<source> line <n,...> <variable or pattern> count <n>", then a total per variable or pattern.
# The values are read and compared inside one node process (ops/watch/log-secret-scan.mjs); none is ever
# printed, written to a file, or put on a command line. ~/.config/recourse/keys is never read.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
NODE=${NODE_BIN:-$(command -v node || true)}
[ -n "$NODE" ] || NODE=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true)
[ -x "$NODE" ] || { echo "log-secret-scan: no node found; set NODE_BIN" >&2; exit 2; }
LOG_SCAN_REPO=$(cd "$HERE/../.." && pwd) exec "$NODE" "$HERE/log-secret-scan.mjs"
