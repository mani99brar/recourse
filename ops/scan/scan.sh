#!/usr/bin/env bash
# Secret scan. Exit 1 on a hit. Installed as the pre-push hook (.git/hooks/pre-push execs it).
#   As the hook: git passes one "<local ref> <local sha> <remote ref> <remote sha>" line per pushed ref on stdin.
#     Every line added by the commits being pushed is scanned, not the files as they are now, so a key committed
#     and removed again in a later commit of the same push is still caught. The files those commits add and the
#     tree of each pushed tip are checked against the forbidden paths.
#   By hand (no ref lines on stdin, or --tree): scans the tracked files of the working tree.
# A hit prints its place (path:line, or commit and path) with keys, keyed URL paths and long tokens redacted.
# A published test vector is allowed by a line "<path> <sha256 of the line>" in ops/scan/allow.txt.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 2
HERE=ops/scan
ZERO=0000000000000000000000000000000000000000
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
hits=0

# label, flags (i = ignore case), extended regex
LABELS=(); FLAGS=(); RES=()
pat() { LABELS+=("$1"); FLAGS+=("$2"); RES+=("$3"); }
Q="[\"']"
pat 'PEM private key' '' '-----BEGIN [A-Z ]*PRIVATE KEY'
pat 'keystore json' i '"ciphertext"[[:space:]]*:'
pat 'hex key next to a key word' i "(key|secret|mnemonic|seed)${Q}?[[:space:]]*[:=][[:space:]]*${Q}?(0x)?[0-9a-f]{64}([^0-9a-f]|$)"
pat 'api key literal' i "(api[_-]?key|access[_-]?key|token|secret)${Q}?[[:space:]]*[:=][[:space:]]*${Q}[A-Za-z0-9_\\-]{20,}"
pat 'secret assigned in an env file' '' '^[[:space:]]*(export[[:space:]]+)?[A-Z0-9_]*(API_KEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*=[^[:space:]$"'"'"'{]{12,}'
pat 'RPC url with key' i 'https?://[^ "]*(alchemy\.com/v2|infura\.io/v3|quiknode\.pro)/[A-Za-z0-9_-]{16,}'
pat 'reference to an outside planning folder' i '(agent-workflow|recourse-prds|docs/prd|\bPRDs?\b|\b(SPEC|PLAN|CF|SM|TC|LS|RPT|I5|PR):[0-9]|round1[0-9]/|recourse-homepage)'
FORBIDDEN='(^|/)(node_modules(/|$)|[^/]*\.env$|\.env\.[^e]|.*\.pass$)'

redact() { # the text of a hit, without the secret in it
  sed -E -e 's/(0x)?[0-9a-fA-F]{32,}/<hex>/g' \
    -e 's#(https?://[^/[:space:]"'"'"']+)/[^[:space:]"'"'"']*#\1/<path>#g' \
    -e 's/[A-Za-z0-9_+/=-]{20,}/<redacted>/g' | cut -c1-160
}
allowed() { # allowed <path> <line text>
  [ -f "$HERE/allow.txt" ] || return 1
  local h; h=$(printf '%s' "$2" | sha256sum | cut -d' ' -f1)
  grep -qxF "$1 $h" "$HERE/allow.txt"
}

# Collect what to scan into $T/text (one line of content per line) and $T/where (its place, same line number).
: > "$T/text"; : > "$T/where"; : > "$T/paths"
refs=()
if [ "${1:-}" != --tree ] && [ ! -t 0 ]; then
  while read -r -t 5 lref lsha rref rsha; do [ -n "${lsha:-}" ] && refs+=("$lsha $rsha"); done
fi
if [ ${#refs[@]} -gt 0 ]; then
  mode="the commits being pushed"
  for r in "${refs[@]}"; do
    lsha=${r% *}; rsha=${r#* }
    [ "$lsha" = "$ZERO" ] && continue                               # a branch deletion pushes nothing
    if [ "$rsha" != "$ZERO" ] && git cat-file -e "$rsha^{commit}" 2>/dev/null; then range=("$rsha..$lsha")
    else range=("$lsha" --not --remotes); fi                          # new branch: what no remote has yet
    git log -p -U0 --no-color --no-ext-diff --format='@@@commit %h' "${range[@]}" -- . ":(exclude)$HERE" |
      awk -v W="$T/where" -v X="$T/text" '
        /^@@@commit / { c = $2; hdr = 0; inh = 0; next }
        /^diff --git / { hdr = 1; inh = 0; p = ""; next }
        hdr && /^\+\+\+ / { p = ($0 == "+++ /dev/null") ? "" : substr($0, 7); next }
        hdr && /^@@ / { hdr = 0; inh = 1; next }
        hdr { next }
        inh && /^\+/ { if (p != "") { print c " " p >> W; print substr($0, 2) >> X }; next }'
    git log --format= --name-only --diff-filter=A "${range[@]}" >> "$T/paths"
    git ls-tree -r --name-only "$lsha" >> "$T/paths"
  done
  for i in "${!RES[@]}"; do
    out=$(grep -n${FLAGS[$i]}E -- "${RES[$i]}" "$T/text" 2>/dev/null || true)
    shown=""
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      n=${line%%:*}; text=${line#*:}; place=$(sed -n "${n}p" "$T/where")
      allowed "${place#* }" "$text" && continue
      shown+="  commit ${place%% *} ${place#* }: $(printf '%s' "$text" | redact)"$'\n'
    done <<<"$out"
    if [ -n "$shown" ]; then echo "secret-scan: ${LABELS[$i]}"; printf '%s' "$shown"; hits=1; fi
  done
else
  mode="the tracked files"
  git ls-files | grep -v "^$HERE/" > "$T/files"
  cp "$T/files" "$T/paths"
  for i in "${!RES[@]}"; do
    out=$(xargs -r -d '\n' grep -nI${FLAGS[$i]}E -- "${RES[$i]}" < "$T/files" 2>/dev/null || true)
    shown=""
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      path=${line%%:*}; rest=${line#*:}; n=${rest%%:*}; text=${rest#*:}
      allowed "$path" "$text" && continue
      shown+="  $path:$n: $(printf '%s' "$text" | redact)"$'\n'
    done <<<"$out"
    if [ -n "$shown" ]; then echo "secret-scan: ${LABELS[$i]}"; printf '%s' "$shown"; hits=1; fi
  done
fi
bad=$(sort -u "$T/paths" | grep -E "$FORBIDDEN" | grep -v '\.env\.example$' || true)
if [ -n "$bad" ]; then echo "secret-scan: forbidden path tracked"; sed 's/^/  /' <<<"$bad"; hits=1; fi
[ $hits -eq 0 ] && echo "secret-scan: clean ($mode)"
exit $hits
