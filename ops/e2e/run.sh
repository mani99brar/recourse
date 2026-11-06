#!/usr/bin/env bash
# The whole test table in one command, against whatever deployments/*.json says.
#   ops/e2e/run.sh [--send] [--restarts] [--suites] [--label <name>] [--replace] [--only <groups>]
# A label already in results/ is refused (its rows would mix with this run's); --replace moves the earlier
# run's raw files into raw/prev-<time>/, where the table no longer reads them, and runs again under that label.
# Groups, in the order they run (--only takes a comma list of them; the preflight always runs first):
#   preflight  GET /v1/health and /v1/params on the status API name the contracts, chain ids and records
#              topic of deployments/*.json (read with the repo's loaders). Different: the run stops there.
#              Not readable (a Hedera relay outage): a blocked row; a dry run goes on, --send stops.
#   ops        ops-checks.sh check: ctl.sh health, the watch, keeper alerts forwarded, keeper gas and intents
#   api        api-agent.mjs: every /v1 read and action the way an agent calls it, dry
#   selftest   api-agent.mjs --selftest: the checks fail on broken answers
#   ui         ui-wallet.mjs: the web app in Chromium with an injected wallet, dry (a browser: under the
#              suite lock, with 1200 MB available)
#   send       only with --send: the money paths on testnet (README, "What --send does")
#   restarts   only with --restarts: each service restarted alone with ops/units/ctl.sh restart <svc>, then
#              ops-checks.sh after <svc>; stops at the first that does not come back (the build session runs it)
#   suites     only with --suites: pnpm test in each package, one at a time, and forge test --no-match-contract
#              Probe, each under the suite lock, recording pass counts
# Writes results/<label>/raw/*.jsonl (and screenshots), then results/<label>/results.json and results.md.
# Compare two runs with: node ops/e2e/compare.mjs <labelA> <labelB>.
# Env: the shared env file is read as the services read it (RECOURSE_ENV_FILE, else
# ~/.config/recourse/recourse.env); nothing from it is printed. E2E_LOCK (else SUITE_LOCK_FILE, else
# ~/.local/state/recourse/suite.lock) is the heavy-job lock; E2E_PLAYWRIGHT_DIR a node_modules/playwright folder;
# RECOURSE_NOTIFY_LOG the notifier's log (read only); E2E_MEM_WAITS how many 10-minute waits for memory (3).
# Exit: 0 no row failed, 1 a row failed or the run stopped, 2 usage.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
export RECOURSE_REPO=$REPO

usage() { sed -n '2,/^set -/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
SEND=0 RESTARTS=0 SUITES=0 LABEL="" ONLY="" REPLACE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --send) SEND=1 ;;
    --restarts) RESTARTS=1 ;;
    --suites) SUITES=1 ;;
    --label) LABEL=${2:?--label needs a name}; shift ;;
    --replace) REPLACE=1 ;;
    --only) ONLY=${2:?--only needs groups}; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "run.sh: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
FLAGS=$(printf '%s' "$([ $SEND = 1 ] && echo '--send ')$([ $RESTARTS = 1 ] && echo '--restarts ')$([ $SUITES = 1 ] && echo '--suites ')${ONLY:+--only $ONLY}" | sed 's/ $//')
LABEL=${LABEL:-$(date -u +%Y%m%dT%H%M%SZ)-$([ $SEND = 1 ] && echo send || echo dry)}
[[ "$LABEL" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "run.sh: --label: letters, digits, dot, dash, underscore" >&2; exit 2; }
OUT=$HERE/results/$LABEL
RAW=$OUT/raw
if [ -e "$OUT" ]; then
  [ $REPLACE = 1 ] || { echo "run.sh: results/$LABEL already holds a run; give another --label, or --replace to run again under it" >&2; exit 2; }
  if [ -d "$RAW" ]; then
    prev=$RAW/prev-$(date -u +%Y%m%dT%H%M%SZ)
    mkdir -p "$prev"
    find "$RAW" -mindepth 1 -maxdepth 1 ! -name 'prev-*' -exec mv -t "$prev" {} +
  fi
fi
export E2E_RAW_DIR=$RAW
mkdir -p "$RAW"
RUNLOG=$RAW/run.jsonl

ENV_FILE=${RECOURSE_ENV_FILE:-$HOME/.config/recourse/recourse.env}
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
LOCK=${E2E_LOCK:-${SUITE_LOCK_FILE:-$HOME/.local/state/recourse/suite.lock}}
STATUS_API=${STATUS_API_URL:-http://127.0.0.1:8787}

enabled() { # enabled <group>: on by its flag (send, restarts, suites) and by --only
  case "$1" in send) [ $SEND = 1 ] || return 1 ;; restarts) [ $RESTARTS = 1 ] || return 1 ;; suites) [ $SUITES = 1 ] || return 1 ;; esac
  [ -z "$ONLY" ] || [[ ",$ONLY," == *",$1,"* ]]
}

# row <path> <result> <test> [note] [tx hashes]
row() {
  jq -c -n --arg t "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" --arg path "$1" --arg result "$2" --arg test "$3" --arg note "${4:-}" --arg tx "${5:-}" \
    '{t: $t, suite: "run", path: $path, result: $result, test: $test}
     + (if $note == "" then {} else {notes: [$note]} end) + (if $tx == "" then {} else {txHash: $tx} end)' >>"$RUNLOG"
  printf 'run: %-8s %s: %s%s%s\n' "$2" "$1" "$3" "${4:+ ($4)}" "${5:+ tx $5}" >&2
}
finish() {
  jq -n --arg commit "$(git -C "$REPO" rev-parse --short HEAD)" --argjson dirty "$([ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ] && echo true || echo false)" \
    --arg started "$STARTED" --arg finished "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg flags "$FLAGS" \
    '{commit: $commit, dirty: $dirty, started: $started, finished: $finished, flags: $flags}' >"$RAW/meta.json"
  local rc=0
  node "$HERE/results.mjs" "$LABEL" || rc=$?
  return "$rc"
}
# stop <path> <why> [tx hashes]: a step that must not be followed by the next one failed.
stop() {
  row "$1" fail "the run stopped here" "$2" "${3:-}"
  finish || true
  exit 1
}
# last_line <file>: its last non-blank line for a note, a URL cut to its host as lib.mjs safeText does.
last_line() { { grep -v '^\s*$' "$1" || true; } | tail -1 | sed -E "s#\\b(https?|wss?)://([^/[:space:]\"'?\#]+)[^[:space:]\"']*#\\1://\\2/…#g" | cut -c1-300; }

# mem_ok <MB>: waits up to E2E_MEM_WAITS times 10 minutes for that much available memory.
mem_ok() {
  local need=$1 waits=${E2E_MEM_WAITS:-3} i avail
  for ((i = 0; ; i++)); do
    avail=$(free -m | awk '/^Mem:/ {print $7}')
    [ "$avail" -ge "$need" ] && return 0
    [ "$i" -lt "$waits" ] || { MEM_SEEN=$avail; return 1; }
    echo "run: $avail MB available, $need needed; waiting 10 minutes" >&2
    sleep 600
  done
}

# ---- preflight: the API serves this checkout's deployments ----

preflight() {
  node "$HERE/state.mjs" deployments >"$RAW/deployments.json" 2>"$RAW/deployments.err" \
    || stop "deployments/*.json" "the checkout's deployments could not be read: $(last_line "$RAW/deployments.err")"
  local rc=0
  node "$HERE/state.mjs" preflight 2>"$RAW/preflight.err" >/dev/null || rc=$?
  case $rc in
    0) ;;
    3) stop "status API vs deployments/*.json" "the status API names other contracts than deployments/*.json (see the rows above): restart it on this checkout's deployments, then run again" ;;
    4) if [ $SEND = 1 ]; then stop "status API vs deployments/*.json" "the status API's addresses could not be read, so nothing is sent"; fi
       row "status API vs deployments/*.json" blocked "the dry run goes on without the full address check" "the API's params could not be read; built transactions are still checked against what it serves" ;;
    *) stop "status API vs deployments/*.json" "state.mjs preflight failed: $(last_line "$RAW/preflight.err")" ;;
  esac
}

# ---- the read-only groups ----

ops_group() {
  local rc=0
  bash "$HERE/ops-checks.sh" check >"$RAW/ops.out" 2>"$RAW/ops.err" || rc=$?
  [ "$rc" = 0 ] || row "ops-checks.sh check" fail "ops-checks.sh stopped (exit $rc)" "$(last_line "$RAW/ops.err")"
}

api_group() { # api_group <test name> [api-agent args]
  local name=$1 rc=0; shift
  node "$HERE/api-agent.mjs" "$@" >"$RAW/$name.out" 2>"$RAW/$name.err" || rc=$?
  # Exit 1 with rows is a failed check (in the rows); a run that stopped early says so on its last line.
  if grep -q '^api-agent: ' "$RAW/$name.err"; then
    row "api-agent.mjs${*:+ $*}" fail "api-agent stopped early" "$(grep '^api-agent: ' "$RAW/$name.err" | tail -1 | cut -c1-300)"
  elif [ "$rc" -gt 1 ]; then
    row "api-agent.mjs${*:+ $*}" fail "api-agent exit $rc" "$(last_line "$RAW/$name.err")"
  fi
}

ui_group() { # ui_group <name> [ui-wallet args]: one browser run under the lock; its rows in raw/<name>.jsonl
  local name=$1 rc=0; shift
  if ! mem_ok 1200; then
    row "UI (browser)${*:+ $*}" blocked "not run: ${MEM_SEEN} MB available, a browser needs 1200"
    return 1
  fi
  flock -w 1800 "$LOCK" node "$HERE/ui-wallet.mjs" "$@" --out "$RAW/$name.jsonl" >"$RAW/$name.out" 2>"$RAW/$name.err" || rc=$?
  if grep -q '^ui-wallet: ' "$RAW/$name.err"; then
    row "ui-wallet.mjs${*:+ $*}" fail "ui-wallet stopped early" "$(grep '^ui-wallet: ' "$RAW/$name.err" | tail -1 | cut -c1-300)"
    return 1
  fi
  return "$rc"
}

# ---- --send: the money paths ----

agent_cli() { # agent_cli <out file> <script> [args]: an existing CLI of services/agent, run as documented
  local out=$1; shift
  (cd "$REPO" && pnpm --silent --filter @recourse/agent "$@") >"$out" 2>&1
}
# Under set -e and pipefail a grep that matches nothing inside x=$(...) would end the run with no row, so
# these helpers, and each x=$(grep ...) below, end in `|| true` and leave the empty case to the guard after it.
sent_hashes() { { grep -oE '^sent 0x[0-9a-fA-F]{64}' "$1" || true; } | awk '{print $2}' | paste -sd' ' -; }
# last_match <regex> <field> <file>: that awk field of the last match of the regex, or nothing.
last_match() { { grep -oE "$1" "$3" || true; } | awk -v f="$2" '{print $f}' | tail -1; }

# claim_json <claimId>; party_json <role>: the API's view (and the wallet's vault token balance), or nothing.
claim_json() { node "$HERE/state.mjs" claim "$1" || true; }
party_json() { node "$HERE/state.mjs" party "$1" || true; }

# closes <claimId> <tag>: the pre-check finding against the agent company, the contest window from the API,
# then the keeper's closeUncontested, each read from the API.
closes() {
  local claim=$1 tag=$2 c answer ends wait_s
  api_group "wait-$tag-finding" --wait "$claim" --status finding_made,no_finding,window_lapsed,closed_uncontested,contested --timeout-s 1200
  c=$(claim_json "$claim")
  [ "$(jq -r .ok <<<"$c")" = true ] || stop "claim $tag pre-check" "the claim could not be read from the API"
  answer=$(jq -r .answer <<<"$c")
  [ "$answer" = 1 ] || stop "claim $tag pre-check" "the pre-check answered $answer (status $(jq -r .statusKey <<<"$c")); the staged fault should make it 1, against the agent company"
  row "claim $tag pre-check" pass "the pre-check marks claim $claim against the agent company (answer 1)" "" "$(jq -r '.lastEvent.tx // ""' <<<"$c")"
  ends=$(jq -r '.windowEndsAt // empty' <<<"$c")
  [ -n "$ends" ] || stop "claim $tag contest window" "the API gives no contest window end"
  # Nobody contests: the keeper closes it once the window is over (it ticks every minute or so).
  wait_s=$(( ends - $(date +%s) + 1200 ))
  [ "$wait_s" -gt 1200 ] || wait_s=1200
  row "claim $tag contest window" pass "uncontested: the window ends at $(date -u -d "@$ends" +%H:%M:%SZ), read from the API"
  api_group "wait-$tag-closed" --wait "$claim" --status closed_uncontested --timeout-s "$wait_s"
  [ "$(jq -r .statusKey <<<"$(claim_json "$claim")")" = closed_uncontested ] || stop "claim $tag closeUncontested" "the claim is not closed_uncontested within ${wait_s}s of the window"
}

# credit_out <tag> <shop before json> <hashes>: the shop's credit is 0 and its wallet holds what it withdrew.
credit_out() {
  local tag=$1 before=$2 hashes=$3 after i credit0 bal0 credit1 bal1
  credit0=$(jq -r .credit <<<"$before"); bal0=$(jq -r '.tokenBalance // empty' <<<"$before")
  for ((i = 0; i < 20; i++)); do
    after=$(party_json shop)
    credit1=$(jq -r .credit <<<"$after"); bal1=$(jq -r '.tokenBalance // empty' <<<"$after")
    [ "$credit1" = 0 ] && break
    sleep 3
  done
  if [ "$credit1" != 0 ]; then stop "shop credit read back ($tag)" "the shop's credit is $credit1 after the withdrawal, not 0" "$hashes"; fi
  if [ -z "$bal0" ] || [ -z "$bal1" ]; then
    row "shop credit read back ($tag)" blocked "credit $credit0 -> 0 (API); the wallet balance was not read: the Hedera JSON-RPC relay did not answer" "$hashes"
  elif [ "$(python3 -c "print(int($bal1 - $bal0 == $credit0))")" = 1 ]; then
    row "shop credit read back ($tag)" pass "credit $credit0 -> 0 (API); vault token balance $bal0 -> $bal1 (chain)" "" "$hashes"
  else
    stop "shop credit read back ($tag)" "credit $credit0 -> 0, but the vault token balance went $bal0 -> $bal1" "$hashes"
  fi
}

send_group() {
  local out order claim pay hashes before b_order b_claim p need bal
  # (a) An order paid by x402 with the staged agent-company mistake; live-order files the claim (shop signs).
  out=$RAW/live-order-a.out
  agent_cli "$out" live-order --send --sku tee-navy-m --fault ordered-size=L || stop "x402 order A (live-order)" "live-order exit $?: $(last_line "$out")"
  grep -q '^waiting for the buyer' "$out" && stop "x402 order A (live-order)" "the spend limits asked for the buyer's approval: $(grep '^waiting for the buyer' "$out")"
  order=$(last_match '^order 0x[0-9a-fA-F]{64}' 2 "$out")
  pay=$(last_match '^payment [^ :]+' 2 "$out")
  claim=$(last_match '^claim 0x[0-9a-fA-F]{64}' 2 "$out")
  [ -n "$order" ] && [ -n "$pay" ] || stop "x402 order A (live-order)" "no order id or payment in live-order's output: $(last_line "$out")"
  row "x402 order A + payment (agent, staged fault ordered-size=L)" pass "order $order" "" "$pay"
  [ -n "$claim" ] || stop "fileClaim A (live-order, shop)" "no claim id in live-order's output: $(last_line "$out")"
  row "fileClaim A through the status API (live-order, shop)" pass "claim $claim" "" "$(sent_hashes "$out")"

  # (d) The UI's fileClaim on a second order B, paid the same way and filed in the web app by the shop.
  out=$RAW/live-order-b.out
  agent_cli "$out" live-order --send --sku tee-navy-m --fault ordered-size=L --through report || stop "x402 order B (live-order)" "live-order exit $?: $(last_line "$out")"
  b_order=$(last_match '^order 0x[0-9a-fA-F]{64}' 2 "$out")
  pay=$(last_match '^payment [^ :]+' 2 "$out")
  [ -n "$b_order" ] && [ -n "$pay" ] || stop "x402 order B (live-order)" "no order id or payment in live-order's output: $(last_line "$out")"
  row "x402 order B + payment (agent, staged fault ordered-size=L)" pass "order $b_order, records through the buyer's report" "" "$pay"
  ui_group ui-send-file --send --as shop --flows file --order "$b_order" \
    || stop "UI fileClaim B (shop, injected wallet)" "ui-wallet did not file it: $(last_line "$RAW/ui-send-file.err")"
  b_claim=$({ node "$HERE/state.mjs" order "$b_order" || true; } | jq -r '.claimId // empty')
  [ -n "$b_claim" ] || stop "UI fileClaim B (shop, injected wallet)" "the API shows no claim for order $b_order"

  # (b) Claim A: the finding, the window, the keeper's close, then the shop's withdraw-credit and a read-back.
  closes "$claim" A
  before=$(party_json shop)
  [[ "$(jq -r '.credit // empty' <<<"${before:-null}")" =~ ^[1-9][0-9]*$ ]] || stop "withdraw-credit (shop)" "the shop has no credit after claim A closed (or its party could not be read)"
  out=$RAW/withdraw-credit.out
  agent_cli "$out" withdraw-credit --as shop --send || stop "withdraw-credit (shop)" "withdraw-credit exit $?: $(last_line "$out")" "$(sent_hashes "$out")"
  hashes=$(sent_hashes "$out")
  [ -n "$hashes" ] || stop "withdraw-credit (shop)" "no transaction in its output: $(last_line "$out")"
  row "withdraw-credit (shop, CLI)" pass "DepositVault.withdrawCredit" "" "$hashes"
  credit_out CLI "$before" "$hashes"

  # (d) Claim B the same way, and its credit withdrawn in the web app.
  closes "$b_claim" B
  before=$(party_json shop)
  ui_group ui-send-withdraw --send --as shop --flows withdraw \
    || stop "UI withdrawCredit (shop, injected wallet)" "ui-wallet did not withdraw: $(last_line "$RAW/ui-send-withdraw.err")"
  # This run's own file only: an earlier ui-wallet run of the same label holds claim B's fileClaim hashes.
  hashes=$({ jq -r 'select(.txHash != null) | .txHash' "$RAW/ui-send-withdraw.jsonl" 2>/dev/null || true; } | tail -1)
  [ -n "$hashes" ] || stop "UI withdrawCredit (shop, injected wallet)" "ui-wallet recorded no withdrawCredit transaction: $(last_line "$RAW/ui-send-withdraw.err")"
  credit_out UI "$before" "$hashes"
  row "UI contest, evidence, next step (send)" blocked "not sent by this round: a contest takes the claim to court (the court case itself), evidence needs a case, and the keeper takes the next step"

  # (c) The payouts came out of the agent company's deposit: top it up with the wiring order's step 4.1 tool.
  # The test is the deposit against required, not inGoodStanding: a vault with a top-up window keeps a party
  # in good standing for that window after a payout takes its deposit below required.
  p=$(party_json platform)
  [ "$(jq -r .ok <<<"$p")" = true ] || stop "agent company deposit" "the platform's standing could not be read from the API"
  need=$(jq -r '.required // empty' <<<"$p"); bal=$(jq -r '.balance // empty' <<<"$p")
  [[ "$need" =~ ^[0-9]+$ && "$bal" =~ ^[0-9]+$ ]] || stop "agent company deposit" "the API gives no deposit or required deposit (balance ${bal:-none}, required ${need:-none})"
  if [ "$(python3 -c "print(int($bal >= $need))")" = 1 ]; then
    row "agent company deposit after the payouts" pass "deposit $bal of required $need: not below it, no top-up needed (inGoodStanding $(jq -r .inGoodStanding <<<"$p"))"
    return 0
  fi
  row "agent company deposit after the payouts" pass "deposit $bal below required $need (inGoodStanding $(jq -r .inGoodStanding <<<"$p"), top-up deadline $(jq -r '.topUpDeadline // "none"' <<<"$p")): a top-up is due"
  out=$RAW/deposit.out
  bash "$REPO/ops/wire/07-deposit.sh" "$need" --send >"$out" 2>&1 \
    || stop "top-up (07-deposit.sh, platform)" "07-deposit.sh exit $?: $(last_line "$out") (in mock mode the platform's mUSDC is minted by the deployer: hedera.sh mint platform)"
  hashes=$(last_match 'DepositPosted [0-9]+ in 0x[0-9a-fA-F]{64}' 4 "$out")
  if [ -n "$hashes" ]; then
    row "top-up (07-deposit.sh $need, platform)" pass "approve + postDeposit up to the required deposit" "" "$hashes"
  elif grep -q 'nothing to deposit' "$out"; then
    row "top-up (07-deposit.sh $need, platform)" blocked "nothing sent: the chain's depositOf is already at the target while the API read $bal (the read-back says which is right)"
  else
    stop "top-up (07-deposit.sh $need, platform)" "no DepositPosted in its output: $(last_line "$out")"
  fi
  # Read back through the API: the deposit at required, in good standing, and no top-up clock running.
  local i ok=""
  for ((i = 0; i < 60; i++)); do
    p=$(party_json platform)
    if [ "$(jq -r '(.balance // "") as $b | (.required // "") as $r
          | ($b | test("^[0-9]+$")) and ($r | test("^[0-9]+$")) and ($b | tonumber) >= ($r | tonumber)
            and .inGoodStanding == true and ((.topUpDeadline // "0") == "0")' <<<"${p:-null}" 2>/dev/null)" = true ]; then ok=1; break; fi
    sleep 3
  done
  [ -n "$ok" ] || stop "agent company deposit read back" "180 s after the top-up the API reads deposit $(jq -r .balance <<<"${p:-null}"), required $(jq -r .required <<<"${p:-null}"), inGoodStanding $(jq -r .inGoodStanding <<<"${p:-null}"), top-up deadline $(jq -r .topUpDeadline <<<"${p:-null}")" "$hashes"
  row "agent company deposit read back" pass "deposit $(jq -r .balance <<<"$p") of required $(jq -r .required <<<"$p"), inGoodStanding true, no top-up deadline" "" "$hashes"
}

# ---- --restarts: one service at a time, least state first, keeper last ----

# quiet_or_stop <svc>: the plan's "before any restart" (ops-checks.sh plan, step 0): no claim within 10
# minutes of its deadline, no contest window open, no x402 order being paid. What cannot be read stops the
# run, asking for the check by hand. An action in flight in the UI or another agent is not seen from here.
quiet_or_stop() {
  local svc=$1 claims kh near
  claims=$(curl -s -m 30 "$STATUS_API/v1/claims" || true)
  jq -e '.claims | type == "array"' <<<"${claims:-null}" >/dev/null 2>&1 \
    || stop "restart $svc" "GET /v1/claims did not answer, so the claim deadlines are not known: check them by hand (ops-checks.sh plan) before this restart"
  near=$(jq -r --argjson now "$(date +%s)" '[.claims[] | select(.deadline != null and (.deadline | tonumber) < $now + 600) | .claimId[0:10]] | join(" ")' <<<"$claims")
  [ -z "$near" ] || stop "restart $svc" "a claim is within 10 minutes of its deadline ($near): not restarted"
  kh=$(curl -s -m 10 http://127.0.0.1:8706/health || true)
  [ "$(jq -r '.windowsActive | if type == "array" then length else "unread" end' <<<"${kh:-null}" 2>/dev/null || true)" = 0 ] \
    || stop "restart $svc" "a contest window is open, or the keeper did not answer: not restarted"
  if pgrep -f 'scripts/live-order' >/dev/null; then stop "restart $svc" "live-order is running (an x402 order may be being paid): not restarted"; fi
}

restarts_group() {
  local svc res kh
  for svc in web intake docket status-api precheck shop keeper; do
    quiet_or_stop "$svc"
    if [ "$svc" = keeper ]; then
      kh=$(curl -s -m 10 http://127.0.0.1:8706/health || true)
      [ "$(jq -r '.openIntents | length' <<<"$kh" 2>/dev/null)" = 0 ] || stop "restart keeper" "the keeper has an open intent (or did not answer): not restarted"
    fi
    if [ "$svc" = precheck ]; then
      [ "$(curl -s -m 10 http://127.0.0.1:8705/health | jq -r '.queue // 0' 2>/dev/null)" = 0 ] || stop "restart precheck" "a claim is waiting for its finding: not restarted"
    fi
    bash "$REPO/ops/units/ctl.sh" restart "$svc" >>"$RAW/restarts.out" 2>&1 || stop "restart $svc" "ctl.sh restart $svc failed: $(last_line "$RAW/restarts.out")"
    res=$({ bash "$HERE/ops-checks.sh" after "$svc" --wait-s 90 2>>"$RAW/restarts.out" || true; } | { grep '^{' || true; } | tail -1 | jq -r .result 2>/dev/null || true)
    [ "$res" = pass ] || stop "restart $svc" "$svc did not come back as it should (ops-checks.sh after: ${res:-no row})"
  done
}

# ---- --suites: every package's tests and the contracts', one at a time ----

suites_group() {
  local f name out rc line passed failed skipped
  for f in "$REPO"/packages/*/package.json "$REPO"/services/*/package.json "$REPO"/apps/*/package.json; do
    [ "$(jq -r '.scripts.test // empty' "$f")" ] || continue
    name=$(jq -r .name "$f")
    out=$RAW/suite-${name##*/}.out
    mem_ok 800 || { row "pnpm test $name" blocked "not run: ${MEM_SEEN} MB available, 800 needed"; continue; }
    rc=0
    (cd "$REPO" && flock -w 1800 "$LOCK" pnpm --filter "$name" test) >"$out" 2>&1 || rc=$?
    line=$({ grep -E '^ +Tests +' "$out" || true; } | tail -1 | sed 's/^ *//')
    row "pnpm test $name" "$([ "$rc" = 0 ] && echo pass || echo fail)" "${line:-no vitest summary} (exit $rc)"
  done
  out=$RAW/suite-forge.out
  mem_ok 800 || { row "forge test" blocked "not run: ${MEM_SEEN} MB available, 800 needed"; return 0; }
  rc=0
  (cd "$REPO/contracts" && FOUNDRY_OUT=${FOUNDRY_OUT:-$RAW/forge/out} FOUNDRY_CACHE_PATH=${FOUNDRY_CACHE_PATH:-$RAW/forge/cache} \
    flock -w 1800 "$LOCK" forge test --no-match-contract Probe) >"$out" 2>&1 || rc=$?
  line=$({ grep -E '^Ran [0-9]+ test suites' "$out" || true; } | tail -1)
  if [ -z "$line" ]; then
    # No summary: forge did not get as far as running the tests (a compile error, say).
    row "forge test --no-match-contract Probe" fail "no test summary (exit $rc)" "$(last_line "$out")"
    return 0
  fi
  passed=$(last_match '[0-9]+ tests passed' 1 <(printf '%s\n' "$line")); failed=$(last_match '[0-9]+ failed' 1 <(printf '%s\n' "$line"))
  skipped=$(last_match '[0-9]+ skipped' 1 <(printf '%s\n' "$line"))
  row "forge test --no-match-contract Probe" "$([ "$rc" = 0 ] && echo pass || echo fail)" "${passed:-?} passed, ${failed:-?} failed, ${skipped:-?} skipped (exit $rc)"
}

STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "run.sh: label $LABEL, flags ${FLAGS:-none (dry)}; results in $OUT" >&2
preflight
if enabled ops; then ops_group; fi
if enabled api; then api_group api-agent; fi
if enabled selftest; then api_group api-selftest --selftest; fi
if enabled ui; then ui_group ui-wallet || true; fi
if enabled send; then send_group; fi
if enabled restarts; then restarts_group; fi
if enabled suites; then suites_group; fi
finish
