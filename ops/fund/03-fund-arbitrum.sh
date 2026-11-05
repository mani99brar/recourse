#!/usr/bin/env bash
# Split Arbitrum Sepolia ETH: the deployer keeps enough for ping and contract deploys and sends
# the rest of the budget (ARB_ETH_TO_OPS, default 0.035) to ops-arb, which pays for Kleros cases
# (0.00081 ETH each) and the fee pool. Usage: 03-fund-arbitrum.sh [--send]
source "$(dirname "$0")/lib.sh"; need_tools; parse_send_flag "$@"
bal=$(cast balance "$(addr deployer)" --rpc-url "$ARB_RPC_URL" --ether)
echo "deployer holds $bal ETH on Arbitrum Sepolia; sending $ARB_ETH_TO_OPS to ops-arb"
send_cast deployer "$ARB_RPC_URL" "$(addr ops-arb)" --value "$(cast to-wei "$ARB_ETH_TO_OPS")"
