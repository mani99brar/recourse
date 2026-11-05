#!/usr/bin/env bash
# Secret scan over tracked files. Exit 1 on a hit. Run before every push (installed as pre-push hook).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
hits=0
files=$(git ls-files)
check() { # pattern, label
  local out
  out=$(printf '%s\n' "$files" | grep -v '^ops/scan/' | xargs -r -d '\n' grep -nIEi -- "$1" 2>/dev/null | cut -c1-160)
  if [ -n "$out" ]; then echo "secret-scan: $2"; echo "$out" | sed -E 's/(0x)?[0-9a-fA-F]{40,}/<hex>/g'; hits=1; fi
}
check '-----BEGIN [A-Z ]*PRIVATE KEY' 'PEM private key'
check '"ciphertext"[[:space:]]*:' 'keystore json'
check '(private[_-]?key|secret|mnemonic|seed)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?(0x)?[0-9a-f]{64}' 'hex key next to a key word'
check '(api[_-]?key|access[_-]?key|token)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9_\-]{20,}' 'api key literal'
check 'https?://[^ "]*(alchemy\.com/v2|infura\.io/v3|quiknode\.pro)/[A-Za-z0-9_-]{16,}' 'RPC url with key'
if printf '%s\n' "$files" | grep -qE '(^|/)(node_modules|\.env$|\.env\.[^e]|.*\.pass$)'; then echo "secret-scan: forbidden path tracked"; hits=1; fi
[ $hits -eq 0 ] && echo "secret-scan: clean"
exit $hits
