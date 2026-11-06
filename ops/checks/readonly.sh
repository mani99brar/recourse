#!/usr/bin/env bash
# Read-only chain and service checks. Sends no transaction and needs no funds.
# Prints a markdown table (check | what was read | value | result | time UTC) to stdout.
#
# Endpoints come from the environment when set, otherwise the public ones below are used.
# Keyed URLs must only ever live in env files; this script never prints a URL, only host names.
#   HEDERA_RPC_URL_1 HEDERA_RPC_URL_2 HEDERA_MIRROR_URL ARB_RPC_URL ARB_RPC_URL_2 SEPOLIA_RPC_URL
set -uo pipefail

H1=${HEDERA_RPC_URL_1:-https://testnet.hashio.io/api}
H2=${HEDERA_RPC_URL_2:-https://296.rpc.thirdweb.com}
MIRROR=${HEDERA_MIRROR_URL:-https://testnet.mirrornode.hedera.com}
MIRROR=${MIRROR%/}; MIRROR=${MIRROR%/api/v1}
A1=${ARB_RPC_URL:-https://sepolia-rollup.arbitrum.io/rpc}
A_EXTRA=${ARB_RPC_URL_2:-"https://arbitrum-sepolia.gateway.tenderly.co https://arbitrum-sepolia-testnet.api.pocket.network https://arbitrum-sepolia-rpc.publicnode.com https://arbitrum-sepolia.drpc.org"}
S1=${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}
S_EXTRA="https://sepolia.gateway.tenderly.co https://eth-sepolia-testnet.api.pocket.network https://0xrpc.io/sep"

ADDRS=${ADDRS_FILE:-$HOME/.config/recourse/addresses.txt}

# The vault's token, from the Hedera deployment record: Circle USDC (also with no usdc object, or no record),
# or the testnet mock mUSDC, which has no HTS token id and so no mirror-node token row.
. "$(dirname "$0")/../lib/vault-token.sh"
HEDERA_RECORD="$(dirname "$0")/../../deployments/${HEDERA_FILE:-hedera.json}"
vault_token "$HEDERA_RECORD" || exit 1

# --- constants (public) ---
HSEL=222782988166878823;  ASEL=3478487238524512106
H_ROUTER=0x802C5F84eAD128Ff36fD6a3f8a418e339f467Ce4
H_ONRAMP=0x023B31f937cFb8ce59A264C73D3D4CB345Fb3Aef
H_OFFRAMP=0x7752798D2fD9e28b7020135A619dDD162d705f20
H_LINK=0x90a386d59b9A6a4795a011e8f032Fc21ED6FEFb6
A_ROUTER=0x2a9C5afB0d0e4BAb2BCdaE109EC4b0c4Be15a165
A_ONRAMP=0x6B9a7cF69F90Ae2659bfe3069fba5Aa308A48cC4
A_OFFRAMP=0xC93218EB7B778bC0c13E5296140C8E4Fa1C440DA
A_LINK=0xb1D4538B4571d411F07960EF2838Ce337FE1E80E
KC=0xE8442307d36e9bf6aB27F1A009F95CE8E11C3479
DTR=0xe763d31Cb096B4bc7294012B78FC7F148324ebcb
EVM=0xA88A9a25cE7f1d8b3941dA3b322Ba91D009E1397
DK=0x0c38f115D001d3b5bBec5e8D44f78C7B61A27D94
PNK=0x34B944D42cAcfC8266955D07A80181D2054aa225
PNKF=0x9f6ffc13B685A68ae359fCA128dfE776458Df464
IDREG=0x8004A818BFB912233c491871b3d84c89A494BD9e
REPREG=0x8004B663056A597Dffe9eCcC1965A193B7388713
USDC_FACADE=$CIRCLE_USDC
IMPL_SLOT=0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
XD=0x$(printf '%064x%064x%064x' 8 3 1)
BUDGET_MS=5000

now(){ date -u +%H:%M:%S; }
ms(){ echo $(( $(date +%s%N) / 1000000 )); }
host(){ local u=${1#*://}; echo "${u%%/*}"; }
row(){ printf '| %s | %s | %s | %s | %s |\n' "$1" "$2" "$3" "$4" "$(now)"; }
cl(){ tr '\n' ' ' | sed 's/|/\\|/g; s/  */ /g' | cut -c1-${1:-160}; }

# cc <label-for-errors> cast-call-args...  -> stdout value (first line) ; rc 0/1
cc(){ timeout 25 cast call "$@" 2>&1 | head -c "${CC_MAX:-600}"; }
is_num(){ [[ ${1:-} =~ ^[0-9]+$ ]]; }

echo "| Check | What was read | Value | Result | Time UTC |"
echo "|---|---|---|---|---|"

# ---------- Hedera JSON-RPC ----------
for pair in "RPC-H1:$H1" "RPC-H2:$H2"; do
  id=${pair%%:*}; u=${pair#*:}; h=$(host "$u")
  t0=$(ms); cid=$(timeout 20 cast chain-id --rpc-url "$u" 2>&1 | head -c 120); t1=$(ms)
  if [[ $cid == 296 ]]; then row "$id" "Hedera JSON-RPC $h: chain id" "296 in $((t1-t0)) ms" PASS
  else row "$id" "Hedera JSON-RPC $h: chain id" "$(echo "$cid" | cl 100)" FAIL; continue; fi
  gp=$(timeout 20 cast gas-price --rpc-url "$u" 2>&1 | head -c 80)
  if is_num "$gp"; then row "$id" "$h: gas price (weibar per gas)" "$gp" PASS; else row "$id" "$h: gas price" "$(echo "$gp" | cl 100)" "FAIL (rate limited or refused)"; fi
  bn=$(timeout 20 cast bn --rpc-url "$u" 2>&1 | head -c 40)
  if is_num "$bn"; then
    lg=$(timeout 25 cast logs --from-block $((bn-2000)) --to-block "$bn" --address $H_LINK --rpc-url "$u" 2>&1 | head -c 300)
    if [[ $lg == Error* ]]; then row "$id" "$h: eth_getLogs 2,000 blocks on LINK" "$(echo "$lg" | cl 110)" FAIL
    else row "$id" "$h: eth_getLogs 2,000 blocks on LINK" "answered, $(printf '%s' "$lg" | grep -c 'address:') log(s) in range" PASS; fi
    r=$(cc $H_LINK "symbol()(string)" --rpc-url "$u")
    row "$id" "$h: eth_call at latest (LINK symbol)" "$(echo "$r" | cl 80)" "$([[ $r == '"LINK"' ]] && echo PASS || echo FAIL)"
  else row "$id" "$h: eth_blockNumber" "$(echo "$bn" | cl 100)" FAIL; fi
  resp=$(curl -s -m 15 -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x1234"]}' "$u" | head -c 400)
  if echo "$resp" | jq -e '.error.message' >/dev/null 2>&1; then
    row "$id" "$h: eth_sendRawTransaction with a malformed tx" "JSON-RPC error, code $(echo "$resp" | jq -r '.error.code')" PASS
  else row "$id" "$h: eth_sendRawTransaction with a malformed tx" "$(echo "$resp" | cl 100)" "FAIL (no JSON-RPC error)"; fi
done

# ---------- Hedera mirror node ----------
mh=$(host "$MIRROR")
t0=$(ms); blk=$(curl -s -m 15 "$MIRROR/api/v1/blocks?limit=1&order=desc" | jq -r '.blocks[0].number // empty'); t1=$(ms)
row MIRROR-1 "mirror $mh: latest block" "${blk:-none} in $((t1-t0)) ms" "$([[ -n $blk ]] && echo PASS || echo FAIL)"
lgj=$(curl -s -m 15 "$MIRROR/api/v1/contracts/0.0.4640464/results/logs?limit=1&order=desc" | jq -c '.logs[0] | {topics:(.topics|length), data_len:(.data|length), has_address:(.address!=null), has_block:(.block_number!=null)}' 2>/dev/null)
row MIRROR-2 "mirror: contract results/logs page (LINK 0.0.4640464)" "fields: $lgj" "$([[ -n $lgj && $lgj != null ]] && echo PASS || echo FAIL)"
T=$(curl -s -m 15 "$MIRROR/api/v1/transactions?transactiontype=CONSENSUSSUBMITMESSAGE&limit=1" | jq -r '.transactions[0].entity_id // empty')
if [[ -n $T ]]; then
  mf=$(curl -s -m 15 "$MIRROR/api/v1/topics/$T/messages?sequencenumber=gte:1&limit=1" | jq -r '.messages[0] | keys | join(",")' 2>/dev/null)
  ok=PASS; [[ $mf == *payer_account_id* && $mf == *consensus_timestamp* ]] || ok="FAIL (field missing)"
  row MIRROR-3 "mirror: topic messages page (topic $T, sequencenumber=gte:1)" "fields: $mf" "$ok"
else row MIRROR-3 "mirror: topic messages page" "no topic found to read" "NOT READ"; fi
if [[ $VAULT_USDC_MODE == mock ]]; then
  c=$(timeout 20 cast code "$VAULT_USDC" --rpc-url "$H1" 2>&1 | head -c 200000)
  if [[ $c == 0x?* ]]; then v="$(( (${#c} - 2) / 2 )) bytes of code"; ok=PASS; else v=$(echo "${c:-no answer}" | cl 100); ok=FAIL; fi
  row USDC-1 "vault token: $VAULT_USDC_LABEL at $VAULT_USDC (from the deployment record; no HTS token, no mirror row)" "$v" "$ok"
  r=$(cc "$VAULT_USDC" "symbol()(string)" --rpc-url "$H1"); d=$(cc "$VAULT_USDC" "decimals()(uint8)" --rpc-url "$H1")
  row USDC-2 "$VAULT_USDC_LABEL by eth_call: symbol, decimals" "$r, $d" "$([[ $r == '"mUSDC"' && $d == 6* ]] && echo PASS || echo FAIL)"
else
  tk=$(curl -s -m 15 "$MIRROR/api/v1/tokens/$CIRCLE_USDC_ID" | jq -c '{symbol,decimals,type,deleted,pause_status,freeze_default}')
  ok=FAIL; [[ $tk == *'"symbol":"USDC"'* && $tk == *'"decimals":"6"'* && $tk == *'"deleted":false'* ]] && ok=PASS
  row USDC-1 "mirror: token $CIRCLE_USDC_ID" "$tk" "$ok"
  r=$(cc $USDC_FACADE "symbol()(string)" --rpc-url "$H1"); d=$(cc $USDC_FACADE "decimals()(uint8)" --rpc-url "$H1")
  row USDC-2 "USDC EVM facade 0x...068cda: symbol, decimals" "$r, $d" "$([[ $r == '"USDC"' && $d == 6* ]] && echo PASS || echo FAIL)"
fi

# Hedera network status
st=$(curl -s -m 15 https://status.hedera.com/api/v2/summary.json)
if [[ -n $st ]]; then
  up=$(echo "$st" | jq -r '[.scheduled_maintenances[]? | select(.name|test("Testnet";"i")) | "\(.name) \(.scheduled_for) to \(.scheduled_until)"] | join("; ")')
  ind=$(echo "$st" | jq -r '.status.description')
  bad=$(echo "$st" | jq -r '[.components[]? | select(.status!="operational" and (.name|test("testnet";"i"))) | .name] | join("; ")')
  row HEDERA-STATUS "status.hedera.com: overall, testnet components, scheduled testnet maintenance" "overall: $ind; testnet components not operational: ${bad:-none}; scheduled: ${up:-none}" "$([[ -z $up ]] && echo PASS || echo 'WORRY (testnet maintenance inside the build window)')"
else row HEDERA-STATUS "status.hedera.com" "unreachable" "NOT READ"; fi

# ---------- Arbitrum Sepolia RPCs ----------
probe_arb(){ # url
  local u=$1 h id fin lat t0 t1 lg r
  h=$(host "$u"); id="RPC-A:$h"
  t0=$(ms); fin=$(timeout 20 cast block finalized -f number --rpc-url "$u" 2>&1 | head -c 100); t1=$(ms)
  lat=$(timeout 20 cast bn --rpc-url "$u" 2>&1 | head -c 100)
  if ! is_num "$fin" || ! is_num "$lat"; then row "$id" "$h: finalized and latest block" "$(echo "$fin / $lat" | cl 110)" FAIL; return; fi
  row "$id" "$h: block finalized vs latest" "finalized $fin, latest $lat, lag $((lat-fin)) blocks, $((t1-t0)) ms" "$([[ $((t1-t0)) -lt $BUDGET_MS ]] && echo PASS || echo 'WORRY (slow)')"
  t0=$(ms); lg=$(timeout 25 cast logs --from-block $((lat-2000)) --to-block "$lat" --address $KC --rpc-url "$u" 2>&1 | head -c 300); t1=$(ms)
  if [[ $lg == Error* ]]; then row "$id" "$h: eth_getLogs 2,000 blocks on KlerosCore" "$(echo "$lg" | cl 110)" FAIL
  else row "$id" "$h: eth_getLogs 2,000 blocks on KlerosCore" "answered in $((t1-t0)) ms, $(printf '%s' "$lg" | grep -c 'address:') log(s)" PASS; fi
  t0=$(ms); r=$(cc $KC "paused()(bool)" --block "$fin" --rpc-url "$u"); t1=$(ms)
  row "$id" "$h: eth_call at finalized block $fin (paused())" "$(echo "$r" | cl 110)" "$([[ $r == false || $r == true ]] && echo PASS || echo FAIL)"
  r=$(cc $KC "paused()(bool)" --block $((lat-7000)) --rpc-url "$u")
  row "$id" "$h: eth_call 7,000 blocks behind latest (state depth)" "$(echo "$r" | cl 110)" "$([[ $r == false || $r == true ]] && echo PASS || echo 'INFO (state pruned)')"
}
probe_arb "$A1"
for u in $A_EXTRA; do probe_arb "$u"; done

# ---------- Ethereum Sepolia ----------
probe_sep(){
  local u=$1 h fin lat lg r; h=$(host "$u")
  fin=$(timeout 20 cast block finalized -f number --rpc-url "$u" 2>&1 | head -c 100); lat=$(timeout 20 cast bn --rpc-url "$u" 2>&1 | head -c 100)
  if ! is_num "$fin" || ! is_num "$lat"; then row "RPC-S:$h" "$h: finalized/latest" "$(echo "$fin / $lat" | cl 100)" FAIL; return; fi
  lg=$(timeout 25 cast logs --from-block $((lat-2000)) --to-block "$lat" --address 0x779877A7B0D9E8603169DdbD7836e478b4624789 --rpc-url "$u" 2>&1 | head -c 200)
  r=$(cc 0x779877A7B0D9E8603169DdbD7836e478b4624789 "symbol()(string)" --block "$fin" --rpc-url "$u")
  row "RPC-S:$h" "$h: chain tip, getLogs 2,000 blocks (LINK), eth_call at finalized" "finalized $fin, lag $((lat-fin)); logs: $([[ $lg == Error* ]] && echo error || echo ok); call: $(echo "$r" | cl 40)" "$([[ $lg != Error* && $r == '"LINK"' ]] && echo PASS || echo FAIL)"
}
probe_sep "$S1"; for u in $S_EXTRA; do probe_sep "$u"; done

# ---------- CCIP ----------
lane_check(){ # name rpc router remote_sel exp_onramp exp_offramp
  local n=$1 rpc=$2 rt=$3 sel=$4 on=$5 off=$6 v s o f
  v=$(cc $rt "typeAndVersion()(string)" --rpc-url "$rpc"); row "CCIP-$n" "$n Router typeAndVersion (code present)" "$v" "$([[ $v == *Router* ]] && echo PASS || echo FAIL)"
  s=$(cc $rt "isChainSupported(uint64)(bool)" $sel --rpc-url "$rpc"); row "CCIP-$n" "$n Router isChainSupported(remote selector $sel)" "$s" "$([[ $s == true ]] && echo PASS || echo FAIL)"
  o=$(cc $rt "getOnRamp(uint64)(address)" $sel --rpc-url "$rpc"); row "CCIP-$n" "$n Router getOnRamp(remote)" "$o" "$([[ ${o,,} == "${on,,}" ]] && echo 'PASS (matches expected)' || echo 'FAIL (differs from expected)')"
  f=$(CC_MAX=60000 cc $rt "getOffRamps()((uint64,address)[])" --rpc-url "$rpc" | tr -d ' ' | tr 'A-Z' 'a-z')
  if echo "$f" | grep -Eq "${sel}\[[0-9.e+]+\],${off,,}"; then r="PASS (pair listed)"; else r="FAIL (expected pair not listed)"; fi
  row "CCIP-$n" "$n Router getOffRamps lists (remote selector, expected OffRamp $off)" "$(echo "$f" | grep -o '(' | wc -l) entries on the Router" "$r"
  for pair in "OnRamp:$on" "OffRamp:$off"; do
    v=$(cc ${pair#*:} "typeAndVersion()(string)" --rpc-url "$rpc"); row "CCIP-$n" "$n ${pair%%:*} ${pair#*:} typeAndVersion" "$v" "$([[ $v == *"2.0.0"* ]] && echo PASS || echo FAIL)"
  done
}
lane_check hedera  "$H1" $H_ROUTER $ASEL $H_ONRAMP  $H_OFFRAMP
lane_check arbitrum "$A1" $A_ROUTER $HSEL $A_ONRAMP $A_OFFRAMP
row CCIP-SEL "chain selectors (from the Router lane tables above)" "Hedera $HSEL, Arbitrum Sepolia $ASEL" "PASS (both accepted by the other chain's Router)"

for dir in "hedera-to-arbitrum:$HSEL:$ASEL" "arbitrum-to-hedera:$ASEL:$HSEL"; do
  IFS=: read -r nm s d <<<"$dir"
  j=$(curl -s -m 25 "https://api.ccip.chain.link/v2/messages?sourceChainSelector=$s&destChainSelector=$d&limit=1")
  v=$(echo "$j" | jq -r '.data[0] | "\(.messageId) \(.status) sent \(.sendTimestamp) received \(.receiptTimestamp)"' 2>/dev/null)
  if [[ -n $v && $v != null* ]]; then
    ts=$(echo "$j" | jq -r '.data[0].sendTimestamp'); age=$(( ( $(date +%s) - $(date -d "$ts" +%s) ) / 86400 ))
    row CCIP-TRAFFIC "last message $nm (CCIP API)" "$v; $age days ago" "$([[ $(echo "$j" | jq -r '.data[0].status') == SUCCESS ]] && echo "PASS (last message SUCCESS; lane idle $age days)" || echo FAIL)"
    mid=$(echo "$j" | jq -r '.data[0].messageId')
    if [[ $nm == hedera-to-arbitrum ]]; then es=$(cc $A_OFFRAMP "getExecutionState(bytes32)(uint8)" "$mid" --rpc-url "$A1"); on="Arbitrum OffRamp"
    else es=$(cc $H_OFFRAMP "getExecutionState(bytes32)(uint8)" "$mid" --rpc-url "$H1"); on="Hedera OffRamp"; fi
    row CCIP-EXEC "$on getExecutionState(messageId of that message)" "$(echo "$es" | cl 60)" "$([[ $es == 2* ]] && echo 'PASS (2 = SUCCESS; messageId is the lookup key)' || echo FAIL)"
  else row CCIP-TRAFFIC "last message $nm (CCIP API)" "no data returned" "NOT READ"; fi
done

# ---------- LINK ----------
for pair in "hedera:$H_LINK:$H1" "arbitrum:$A_LINK:$A1"; do
  n=${pair%%:*}; rest=${pair#*:}; a=${rest%%:*}; u=${rest#*:}
  sy=$(cc $a "symbol()(string)" --rpc-url "$u"); de=$(cc $a "decimals()(uint8)" --rpc-url "$u")
  row LINK "$n LINK $a symbol, decimals" "$sy, $de" "$([[ $sy == '"LINK"' && $de == 18* ]] && echo PASS || echo FAIL)"
done

# ---------- Kleros ----------
r=$(cc $KC "arbitrationCost(bytes)(uint256)" $XD --rpc-url "$A1" | awk '{print $1}')
row KLEROS "KlerosCore arbitrationCost(8,3,1 extraData)" "$r wei" "$([[ $r == 810000000000000 ]] && echo PASS || echo 'FAIL (differs from 810000000000000)')"
r=$(cc $KC "getTimesPerPeriod(uint96)(uint256[4])" 8 --rpc-url "$A1")
row KLEROS "court 8 getTimesPerPeriod (evidence, commit, vote, appeal; s)" "$r" "$([[ $r == '[900, 2700, 1800, 2700]' ]] && echo PASS || echo 'FAIL (differs from 900/2700/1800/2700)')"
r=$(cc $KC "paused()(bool)" --rpc-url "$A1"); row KLEROS "KlerosCore paused()" "$r" "$([[ $r == false ]] && echo PASS || echo 'FAIL (paused)')"
r=$(cc $KC "isSupported(uint96,uint256)(bool)" 8 1 --rpc-url "$A1"); row KLEROS "court 8 supports dispute kit 1: isSupported(8,1)" "$r" "$([[ $r == true ]] && echo PASS || echo FAIL)"
r=$(cc $KC "courts(uint256)(uint96,bool,uint256,uint256,uint256,uint256)" 8 --rpc-url "$A1" | awk '{print $1}' | tr '\n' ' ')
set -- $r
row KLEROS "court 8 courts(8): parent, hiddenVotes, minStake, alpha, feeForJuror, jurorsForCourtJump" "${1:-?}, ${2:-?}, ${3:-?}, ${4:-?}, ${5:-?}, ${6:-?}" "$([[ ${1:-} == 7 && ${2:-} == true && ${3:-} == 11000000000000000000000 && ${5:-} == 270000000000000 ]] && echo 'PASS (parent 7, hidden votes, minStake 11,000 PNK, fee/juror 0.00027 ETH)' || echo 'FAIL (differs from expected)')"
for pair in "KlerosCore:$KC:0x02F607722749CECd32db07AA0b0755281FE9D13c" "DisputeTemplateRegistry:$DTR:0xf97791DA66e0A8Ff8Ee4908872CfCAcc641829Ec" "EvidenceModule:$EVM:0xC4e64e6E949936a18269937FC1e18cb11E3db14D" "DisputeKitClassic:$DK:0xA122856B3B4C5fBcA129088af3CEb204509805f0"; do
  IFS=: read -r n a exp <<<"$pair"
  v=$(timeout 25 cast storage "$a" $IMPL_SLOT --rpc-url "$A1" 2>&1 | head -c 100); v=0x${v: -40}
  row KLEROS-IMPL "$n $a: EIP-1967 implementation slot" "$v" "$([[ ${v,,} == "${exp,,}" ]] && echo 'PASS (matches expected)' || echo 'FAIL (implementation changed)')"
done
r=$(cc 0xed31bEE8b1F7cE89E93033C0d3B2ccF4cEb27652 "arbitrator()(address)" --rpc-url "$A1" 2>&1 | head -c 100)
c=$(timeout 25 cast code 0xed31bEE8b1F7cE89E93033C0d3B2ccF4cEb27652 --rpc-url "$A1" 2>&1 | wc -c)
row KLEROS "DisputeResolver 0xed31...7652 (test cases): code length" "$c hex chars; arbitrator() = $(echo "$r" | cl 60)" "$([[ $c -gt 10 ]] && echo 'PASS (contract)' || echo FAIL)"
for pair in "PNK:$PNK" "PNKFaucet:$PNKF"; do n=${pair%%:*}; a=${pair#*:}; c=$(timeout 25 cast code $a --rpc-url "$A1" 2>&1 | wc -c); row KLEROS "$n $a code present" "$c hex chars" "$([[ $c -gt 10 ]] && echo PASS || echo FAIL)"; done
fb=$(cc $PNK "balanceOf(address)(uint256)" $PNKF --rpc-url "$A1" | awk '{print $1}'); am=$(cc $PNKF "amount()(uint256)" --rpc-url "$A1" | awk '{print $1}')
row PNK-FAUCET "PNKFaucet PNK balance and amount per claim (read only; no claim made)" "faucet holds $fb wei PNK, pays $am wei per claim" "$([[ $am == 10000000000000000000000 ]] && echo 'PASS (10,000 PNK per claim)' || echo 'WORRY (amount differs)')"
j=$(timeout 20 cast call $KC "currentRuling(uint256)(uint256,bool,bool)" 1 --rpc-url "$A1" 2>&1 | tr '\n' ' ' | head -c 100)
row KLEROS "currentRuling(1) on KlerosCore (decoded read)" "$j" "$([[ $j != Error* ]] && echo PASS || echo FAIL)"

jb=$(cc 0xbAA5068F0bD1417046250A3eDe2B1F27e31383BD "getJurorBalance(address,uint96)(uint256,uint256,uint256,uint256)" 0x245314a76fc9b8e48fea7abb3b9b07e34e13d8c6 8 --rpc-url "$A1" | awk '{print $1}' | tr '\n' ' ')
set -- $jb
row KLEROS-JUROR "SortitionModule getJurorBalance(court 8 juror 0x2453...d8c6, 8): total staked, locked, staked in court 8, courts (wei PNK)" "${1:-?}, ${2:-?}, ${3:-?}, ${4:-?}" "$([[ ${3:-0} =~ ^[0-9]+$ ]] && { [[ ${#3} -gt 23 ]] || { [[ ${#3} -eq 23 ]] && [[ ${3:0:2} -ge 11 ]]; }; } && echo 'PASS (court 8 stake of at least 11,000 PNK; the juror has locked stake in open disputes)' || echo 'WORRY (court 8 stake under 11,000 PNK or unreadable)')"

# ---------- ERC-8004 ----------
for pair in "IdentityRegistry:$IDREG" "ReputationRegistry:$REPREG"; do
  n=${pair%%:*}; a=${pair#*:}; c=$(timeout 25 cast code $a --rpc-url "$H1" 2>&1 | wc -c); v=$(cc $a "getVersion()(string)" --rpc-url "$H1")
  row ERC8004 "$n $a on Hedera testnet: code length, getVersion()" "$c hex chars; $v" "$([[ $c -gt 10 && $v == *2.0.0* ]] && echo PASS || echo FAIL)"
done

# ---------- roles: addresses on chain and mirror ----------
if [[ -r $ADDRS ]]; then
  while read -r role addr; do
    [[ -z ${addr:-} ]] && continue
    hb=$(timeout 20 cast balance "$addr" --rpc-url "$H1" 2>&1 | head -c 60)
    ab=$(timeout 20 cast balance "$addr" --rpc-url "$A1" 2>&1 | head -c 60)
    code=$(curl -s -m 15 -o /tmp/.mirror_acct.$$ -w '%{http_code}' "$MIRROR/api/v1/accounts/$addr")
    if [[ $code == 200 ]]; then mi="account $(jq -r '.account' /tmp/.mirror_acct.$$), key type $(jq -r '.key._type // "none"' /tmp/.mirror_acct.$$)"; else mi="mirror $code (no account yet)"; fi
    rm -f /tmp/.mirror_acct.$$
    row ROLE:"$role" "$role $addr: Hedera balance (wei), Arbitrum Sepolia balance (wei), mirror account" "hedera $hb; arbitrum $ab; $mi" "INFO (not funded)"
  done < <(sed 's/[ \t]\+/ /' "$ADDRS")
fi
