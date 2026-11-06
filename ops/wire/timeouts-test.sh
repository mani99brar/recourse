#!/usr/bin/env bash
# Offline test of the claimTimeout relation in 00-readback.sh and 09-lock-hedera.sh:
#   bash ops/wire/timeouts-test.sh [folder holding lib.sh, 00-readback.sh and 09-lock-hedera.sh; default ops/wire]
# The scripts run from a temp copy of the repo layout with fixture deployment files, a stub cast that answers each
# read from the test's values, and a stub hedera.sh. HOME is the temp folder, so no env file or key is read, and
# both RPC URLs point at a closed local port, so nothing reaches a chain and nothing can be signed or sent.
# The relation under test: RecourseCase's claimTimeout must be at least the relay budget below Hedera's.
set -uo pipefail
SRC=$(readlink -f "${1:-$(dirname "$0")}")
REPO=$(cd "$(dirname "$0")/../.." && pwd)
W=$(mktemp -d "${TMPDIR:-/tmp}/timeouts-test.XXXXXX"); trap 'rm -rf "$W"' EXIT
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); sed 's/^/    /' "$W/out"; }

R=$W/root
mkdir -p "$R/ops/wire" "$R/ops/lib" "$R/deployments" "$R/packages/shared/vectors" "$R/contracts/script/hedera" \
  "$W/home/.local/bin" "$W/keys"
cp "$SRC/lib.sh" "$SRC/00-readback.sh" "$SRC/09-lock-hedera.sh" "$R/ops/wire/"
cp "$REPO/ops/lib/vault-token.sh" "$R/ops/lib/"
cp "$REPO/packages/shared/vectors/params.json" "$W/params.base.json"
printf '#!/usr/bin/env bash\necho "stub hedera.sh $*"\n' > "$R/contracts/script/hedera/hedera.sh"
chmod +x "$R/contracts/script/hedera/hedera.sh"

# Fictional addresses.
CLAIMS=0x1111111111111111111111111111111111111111; VAULT=0x2222222222222222222222222222222222222222
CASE=0x3333333333333333333333333333333333333333;   USDC=0x4444444444444444444444444444444444444444
HLINK=0x5555555555555555555555555555555555555555;  ALINK=0x6666666666666666666666666666666666666666
DEP=0x7777777777777777777777777777777777777777;    SIGNER=0x8888888888888888888888888888888888888888
OPSH=0x9999999999999999999999999999999999999999;   SCHEME=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
OPSA=0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
for role in deployer precheck-signer ops-hedera scheme ops-arb; do : > "$W/keys/$role.json"; : > "$W/keys/$role.json.pass"; done
jq -n --arg c "$CLAIMS" --arg v "$VAULT" --arg u "$USDC" --arg l "$HLINK" \
  '{contracts:{claims:{address:$c}, vault:{address:$v, id:"0.0.2"}}, usdc:{mode:"mock", address:$u, decimals:6, tokenId:null}, local:{link:$l}}' \
  > "$R/deployments/hedera.t.local.json"

# The stub cast. T_CT Claims' claimTimeout, T_CW Claims' contestWindow, T_KT the case's claimTimeout, T_HL/T_VL/T_KL
# the locks of Claims, the vault and the case.
cat > "$W/home/.local/bin/cast" <<EOF
#!/usr/bin/env bash
lc() { tr 'A-F' 'a-f' <<<"\$1"; }
sub=\$1; shift
case "\$sub" in
  chain-id) case "\$*" in *127.0.0.1:9/h*) echo 31337 ;; *) echo 31338 ;; esac ;;
  code) echo 0x6080 ;;
  balance) echo 2000000000000000000 ;;
  wallet)
    ks=""; while [ \$# -gt 0 ]; do [ "\$1" = --keystore ] && ks=\$2; shift; done
    case "\$(basename "\$ks" .json)" in
      deployer) echo $DEP ;; precheck-signer) echo $SIGNER ;; ops-hedera) echo $OPSH ;; scheme) echo $SCHEME ;; ops-arb) echo $OPSA ;;
      *) echo "stub cast: unknown role \$ks" >&2; exit 1 ;;
    esac ;;
  call)
    to=\$(lc "\$1"); sig=\$2
    case "\$to \$sig" in
      "$CLAIMS peer()(address)") echo $CASE ;;
      "$CASE peer()(address)") echo $CLAIMS ;;
      "$CLAIMS vault()(address)") echo $VAULT ;;
      "$VAULT claims()(address)") echo $CLAIMS ;;
      *" owner()(address)") echo $DEP ;;
      "$CLAIMS preCheckSigner()(address)") echo $SIGNER ;;
      "$CLAIMS rulingRelayer()(address)") echo $OPSH ;;
      "$VAULT pool()(address)") echo $SCHEME ;;
      "$CASE trustedRelay()(address)") echo 0x0000000000000000000000000000000000000000 ;;
      "$CLAIMS bridgeMode()(uint8)") echo 0 ;;
      "$CLAIMS feeToken()(address)") echo 0x0000000000000000000000000000000000000000 ;;
      *" extraArgs()(bytes)") echo 0x181dcf1000000000000000000000000000000000000000000000000000000000000249f00000000000000000000000000000000000000000000000000000000000000001 ;;
      "$CLAIMS params()((uint64,uint64,uint256,uint256,uint16,uint256,uint64,uint8))")
        echo "(\${T_CW:-600}, \$T_CT, 1000000 [1e6], 1000000 [1e6], 500, 4000000 [4e6], 1800, 5)" ;;
      "$CASE params()(uint64,uint16,uint64,uint8)") printf '7200\n10\n1800\n5\n' ;;
      "$VAULT params()(uint64,uint64,uint256)") printf '604800\n10368000\n5000000 [5e6]\n' ;;
      "$CASE claimTimeout()(uint64)") echo "\$T_KT" ;;
      *" balanceOf(address)(uint256)") echo "1000000000000000000 [1e18]" ;;
      "$CASE feePool()(uint256)") echo "10000000000000000 [1e16]" ;;
      "$VAULT usdc()(address)") echo $USDC ;;
      "$VAULT usdcAssociated()(bool)") echo true ;;
      "$CLAIMS configLocked()(bool)") echo "\${T_HL:-false}" ;;
      "$VAULT configLocked()(bool)") echo "\${T_VL:-false}" ;;
      "$CASE locked()(bool)") echo "\${T_KL:-false}" ;;
      "$CLAIMS arbSelector()(uint64)") echo 1 ;;
      "$CASE hederaSelector()(uint64)") echo 2 ;;
      "$VAULT lockConfig()") echo 0x ;;
      *) echo "stub cast: unknown call \$to \$sig" >&2; exit 1 ;;
    esac ;;
  *) echo "stub cast: unknown command \$sub" >&2; exit 1 ;;
esac
EOF
chmod +x "$W/home/.local/bin/cast"

# fixture <case claimTimeout on record, or "none"> [locked claimTimeout]: writes the Arbitrum file and params.json.
fixture() {
  jq --argjson t "${2:-64800}" '.locked.claimTimeout = $t' "$W/params.base.json" > "$R/packages/shared/vectors/params.json"
  jq -n --arg k "$CASE" --arg l "$ALINK" --arg t "$1" \
    '{contracts:{case:{address:$k}}, gas:{ccipReceive:{limit:119205}}, mocks:{link:$l}}
     + (if $t == "none" then {} else {constructorArgs:{claimTimeout:($t|tonumber)}} end)' > "$R/deployments/arbitrum.t.local.json"
}
run() { # run <script> [args]: in the temp root, offline, with the test's values
  env -i PATH="$W/home/.local/bin:$PATH" HOME="$W/home" WIRE_LOCAL=1 KEYSTORE_DIR="$W/keys" \
    HEDERA_RPC_URL_1=http://127.0.0.1:9/h ARB_RPC_URL=http://127.0.0.1:9/a RECOURSE_ENV_FILE=/nonexistent \
    HEDERA_FILE=hedera.t.local.json ARBITRUM_FILE=arbitrum.t.local.json WIRING_FILE=wiring.t.local.json \
    T_CT="$T_CT" T_KT="$T_KT" T_CW="${T_CW:-600}" T_HL="${T_HL:-false}" T_VL="${T_VL:-false}" T_KL="${T_KL:-false}" \
    ${CASE_RELAY_BUDGET:+CASE_RELAY_BUDGET=$CASE_RELAY_BUDGET} ${LOCK_IGNORE_RELAY_BUDGET:+LOCK_IGNORE_RELAY_BUDGET=$LOCK_IGNORE_RELAY_BUDGET} \
    bash "$R/ops/wire/$1" "${@:2}" > "$W/out" 2>&1
}
has() { grep -qF -- "$1" "$W/out"; }

# --- 00-readback.sh --------------------------------------------------------------------------------------------
NAME="read-back: case 2 h below Claims (the deploy's relation) is ok"
T_CT=64800 T_KT=57600; fixture 57600
if run 00-readback.sh && has "ok   claimTimeout: RecourseCase 57600 is 7200 s below" && ! has "WARN claimTimeout" && has "read-back OK"; then ok "$NAME"; else bad "$NAME"; fi

NAME="read-back: equal timeouts (the live pair) warn, not ok"
T_CT=64800 T_KT=64800; fixture 64800
if run 00-readback.sh && has "WARN claimTimeout: RecourseCase.claimTimeout() 64800 is only 0 s below" && ! has "ok   claimTimeout" && has "read-back OK"; then ok "$NAME"; else bad "$NAME"; fi

NAME="read-back: a gap short of the budget warns"
T_CT=64800 T_KT=63000; fixture 63000
if run 00-readback.sh && has "WARN claimTimeout: RecourseCase.claimTimeout() 63000 is only 1800 s below" && has "read-back OK"; then ok "$NAME"; else bad "$NAME"; fi

NAME="read-back: case above Claims stops, and says to redeploy the case, not to lower Claims"
T_CT=60000 T_KT=64800; fixture 64800
if ! run 00-readback.sh && has "is above Claims.params() claimTimeout 60000" && has "Redeploy RecourseCase with at most 52800" && ! has "wanted"; then ok "$NAME"; else bad "$NAME"; fi

NAME="read-back: the case's value must be the one the Arbitrum file records"
T_CT=64800 T_KT=57600; fixture 64800
if ! run 00-readback.sh && has "read-back mismatch: RecourseCase.claimTimeout() is arbitrum.t.local.json constructorArgs.claimTimeout is 57600, wanted 64800"; then ok "$NAME"; else bad "$NAME"; fi

NAME="read-back: no recorded constructorArgs.claimTimeout is reported, not a stop"
T_CT=64800 T_KT=57600; fixture none
if run 00-readback.sh && has "records no constructorArgs.claimTimeout to compare" && has "read-back OK"; then ok "$NAME"; else bad "$NAME"; fi

NAME="read-back: before the lock the case is also checked against the locked value"
T_CT=72000 T_KT=64800; fixture 64800
if run 00-readback.sh && has "ok   claimTimeout: RecourseCase 64800 is 7200 s below Claims.params() claimTimeout 72000" \
   && has "WARN claimTimeout: RecourseCase.claimTimeout() 64800 is only 0 s below params.json locked.claimTimeout"; then ok "$NAME"; else bad "$NAME"; fi

NAME="read-back: a locked Claims must hold the locked claimTimeout"
T_CT=60000 T_KT=52800 T_HL=true; fixture 52800
if ! run 00-readback.sh && has "Claims is locked: Claims.params() claimTimeout is params.json locked.claimTimeout is 60000, wanted 64800"; then ok "$NAME"; else bad "$NAME"; fi
T_HL=false

NAME="read-back: CASE_RELAY_BUDGET sets the budget"
T_CT=64800 T_KT=61200; fixture 61200
if CASE_RELAY_BUDGET=3600 run 00-readback.sh && has "ok   claimTimeout: RecourseCase 61200 is 3600 s below" && ! has "WARN claimTimeout"; then ok "$NAME"; else bad "$NAME"; fi

# --- 09-lock-hedera.sh (dry runs) ------------------------------------------------------------------------------
NAME="lock: refuses when the case leaves no relay budget below the locked claimTimeout"
T_CT=64800 T_KT=64800; fixture 64800
if ! run 09-lock-hedera.sh && has "refusing to lock" && ! has "stub hedera.sh lock"; then ok "$NAME"; else bad "$NAME"; fi

NAME="lock: LOCK_IGNORE_RELAY_BUDGET=1 locks with a warning"
if LOCK_IGNORE_RELAY_BUDGET=1 run 09-lock-hedera.sh && has "WARN LOCK_IGNORE_RELAY_BUDGET=1" && has "stub hedera.sh lock"; then ok "$NAME"; else bad "$NAME"; fi

NAME="lock: the deploy's relation locks without a warning"
T_CT=64800 T_KT=57600; fixture 57600
if run 09-lock-hedera.sh && has "stub hedera.sh lock" && ! has "WARN"; then ok "$NAME"; else bad "$NAME"; fi

NAME="lock: a case above the locked claimTimeout is refused even with the override"
T_CT=64800 T_KT=70000; fixture 70000
if ! LOCK_IGNORE_RELAY_BUDGET=1 run 09-lock-hedera.sh && has "is above the claimTimeout the lock writes" && ! has "stub hedera.sh lock"; then ok "$NAME"; else bad "$NAME"; fi

NAME="lock: a half lock still finishes the vault, with a warning"
T_CT=64800 T_CW=1800 T_KT=64800 T_HL=true T_VL=false; fixture 64800
if run 09-lock-hedera.sh && has "WARN finishing the vault lock anyway" && has "dry run ok: lockConfig()"; then ok "$NAME"; else bad "$NAME"; fi
T_HL=false T_CW=600

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
