# Text that is safe to print or send: what `ctl.sh health` prints and what the watch forwards go through it.
# A URL keeps only its scheme and host (a keyed RPC URL carries its key in the path or the query, and
# userinfo is dropped too); a run of 64 or more hex digits (a private key, a Hedera DER key, but also a
# claim id or a hash) becomes <hex>; a JWT becomes <jwt>; a token of 32 or more letters, digits, _ and -
# that mixes letters and digits becomes <redacted> (an address, 0x and 40 hex digits, is kept); and a
# query string left without its URL becomes ?…
# Use: jq -L <this folder> 'include "redact"; ... | redact'
def redact:
  gsub("(?<s>[A-Za-z][A-Za-z0-9+.-]*)://(?:[^\\s/@]*@)?(?<h>[A-Za-z0-9.-]+(?::[0-9]+)?)[^\\s\"'<>)\\]}]*"; "\(.s)://\(.h)/…")
  | gsub("(?:0x)?[0-9a-fA-F]{64,}"; "<hex>")
  | gsub("eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]*)?"; "<jwt>")
  | gsub("(?<![A-Za-z0-9_-])(?!0x[0-9a-fA-F]{40}(?![A-Za-z0-9_-]))(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}"; "<redacted>")
  | gsub("\\?[A-Za-z0-9_.-]+=[^\\s]*"; "?…");
