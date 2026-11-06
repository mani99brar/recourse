# Test run run1

- Commit: 21ade87
- Run: 2026-11-06T20:08:32Z to 2026-11-06T20:30:07Z, flags: --suites
- Deployments (hedera.json, arbitrum.json): Hedera 296 RecourseClaims 0xc4d457991eE42438EA433773e491ba8F2B27dDee, DepositVault 0xA22fB188b49eddecc4f9DE22607e70E1d07Aea2e, vault token mUSDC (testnet mock) 0x6D6fb82e82E525B9c30619189EA8aF17117C3c73; Arbitrum 421614 RecourseCase 0xd7f11FA06A97a45a6Af03c71d7eB3219C1a703B8; records topic from HCS_RECORDS_TOPIC_ID
- Results: pass 296, fail 1, blocked 18, dry-only 5

| Path | Result | Tx hash or test name | Note |
|---|---|---|---|
| GET /v1/health vs deployments/*.json | pass | the status API names the checkout's deployment files and vault token |  |
| GET /v1/params vs deployments/*.json | pass | the status API names the checkout's contracts, chain ids and records topic |  |
| ctl.sh health | pass | every service up |  |
| ctl.sh health --json | pass | JSON for the watch: one object per unit |  |
| ctl.sh health strays | pass | no process of this checkout listens on all interfaces outside the units |  |
| recourse-watch runs | pass | timer active, 90 runs since -3 hours, last 42s ago, 0 sends kept back, 0 without a notifier |  |
| recourse-keeper alerts -> watch -> notifier | blocked | not checked: RECOURSE_NOTIFY_LOG unset (14 alert lines since the watch's first run (2026-11-06T14:30:05+00:00), 14 forwarded by the watch) |  |
| recourse-precheck alerts -> watch -> notifier | blocked | not checked: RECOURSE_NOTIFY_LOG unset (0 alert lines since the watch's first run (2026-11-06T14:30:05+00:00), 0 forwarded by the watch) |  |
| recourse-watch down/back -> notifier | blocked | not checked: RECOURSE_NOTIFY_LOG unset (20 down/back/restarted messages sent by the watch since -3 hours) |  |
| keeper gas and intents | fail | ops-hedera 0.0000 HBAR (floor 10), ops-arb 0.00000 ETH, 0 open intents, problems [] |  |
| GET /v1/openapi.json | pass | served spec loads (OpenAPI 3.1) and is the repo file | identical to services/status-api/openapi.json |
| GET /openapi.json | pass | root copy of the spec is the same document |  |
| spec openapi.json | pass | spec self-consistency: codes, statuses, revert map, action paths |  |
| GET /v1/params + /v1/claims | pass | discovery from the API |  |
| GET /v1/health | pass | health | undeclared fields: .health.deployments, .health.documents |
| GET /v1/params | pass | params, with the twelve actions |  |
| GET /v1/claims | pass | claims list |  |
| GET /v1/claims | pass | claims for the shop, with standing and groups |  |
| GET /v1/claims | pass | claims for the platform, with standing and groups |  |
| GET /v1/claims | pass | claims filtered by status closed_uncontested |  |
| GET /v1/claims | pass | claims filtered by status settled |  |
| GET /v1/claims/{claimId} | pass | claim detail 0x8f78143e |  |
| GET /v1/claims/{claimId} | pass | claim detail, upper-case id 0x8f78143e |  |
| GET /v1/claims/{claimId} | pass | claim detail 0x392d6f13 |  |
| GET /v1/claims/{claimId} | pass | claim detail, upper-case id 0x392d6f13 |  |
| GET /v1/claims/{claimId} | pass | claim detail 0x9cd70468 |  |
| GET /v1/claims/{claimId} | pass | claim detail, upper-case id 0x9cd70468 |  |
| GET /v1/parties/{address} | pass | party shop |  |
| GET /v1/parties/{address} | pass | party platform |  |
| GET /v1/parties/{address} | pass | party scheme |  |
| GET /v1/orders/{orderId}/records | pass | order records 0x6d94a648 |  |
| GET /v1/orders/{orderId}/records | pass | order records with platform and shop 0x6d94a648 |  |
| GET /v1/orders/{orderId}/records | pass | order records 0xb7da5ace |  |
| GET /v1/orders/{orderId}/records | pass | order records with platform and shop 0xb7da5ace |  |
| GET /v1/orders/{orderId}/records | pass | order records 0x1bf80d52 |  |
| GET /v1/orders/{orderId}/records | pass | order records with platform and shop 0x1bf80d52 |  |
| GET /v1/search | pass | search by claim id |  |
| GET /v1/search | pass | search by order id |  |
| GET /v1/search | pass | search by shop address |  |
| GET /v1/search | pass | search by event tx |  |
| GET /v1/search | pass | search by dispute number |  |
| GET /v1/claims | pass (invalid_field) | invalid: status not a status key |  |
| GET /v1/claims | pass (invalid_field) | invalid: party not an address |  |
| GET /v1/claims | pass (invalid_field) | invalid: party given twice |  |
| GET /v1/claims/{claimId} | pass (invalid_field) | invalid: claim id short |  |
| GET /v1/claims/{claimId} | pass (not_found) | invalid: claim id unknown |  |
| GET /v1/parties/{address} | pass (invalid_field) | invalid: party not hex |  |
| GET /v1/orders/{orderId}/records | pass (invalid_field) | invalid: order id short |  |
| GET /v1/orders/{orderId}/records | pass (missing_field) | invalid: order records with platform only |  |
| GET /v1/search | pass (missing_field) | invalid: search without q |  |
| GET /v1/search | pass (invalid_field) | invalid: search q blank |  |
| GET /v1/search | pass (invalid_field) | invalid: search q over 200 characters |  |
| GET /v1/nope | pass (not_found) | invalid: unknown /v1 path |  |
| POST /v1/health | pass (method_not_allowed) | invalid: POST on a read |  |
| DELETE /v1/claims | pass (method_not_allowed) | invalid: DELETE on claims |  |
| POST /v1/actions/contest | pass (wrong_status) | contest 0x8f78143e (closed_uncontested) as platform |  |
| POST /v1/actions/contest | pass (wrong_status) | contest 0x8f78143e (closed_uncontested) as shop |  |
| POST /v1/actions/closeUncontested | pass (wrong_status) | closeUncontested 0x8f78143e (closed_uncontested) as ops-hedera |  |
| POST /v1/actions/sendToCourt | pass (wrong_status) | sendToCourt 0x8f78143e (closed_uncontested) as ops-hedera |  |
| POST /v1/actions/resend | pass (wrong_status) | resend 0x8f78143e (closed_uncontested) as ops-hedera |  |
| POST /v1/actions/expireClaim | pass (wrong_status) | expireClaim 0x8f78143e (closed_uncontested) as ops-hedera |  |
| POST /v1/actions/settle | pass (wrong_status) | settle 0x8f78143e (closed_uncontested) as ops-hedera |  |
| POST /v1/actions/openCase | pass (not_found) | openCase 0x8f78143e (closed_uncontested) as ops-arb |  |
| POST /v1/actions/refile | pass (not_found) | refile 0x8f78143e (closed_uncontested) as ops-arb |  |
| POST /v1/actions/relayRuling | pass (not_found) | relayRuling 0x8f78143e (closed_uncontested) as ops-arb, payIn native |  |
| POST /v1/actions/relayRuling | pass (not_found) | relayRuling 0x8f78143e (closed_uncontested) as ops-arb, payIn link |  |
| POST /v1/actions/submitEvidence | pass (not_found) | submitEvidence 0x8f78143e (closed_uncontested) as ops-arb |  |
| POST /v1/actions/contest | blocked (upstream_unavailable) | contest 0x392d6f13 (settled) as platform | code upstream_unavailable is documented at 503, answered 502; expected HTTP 409, got 502 upstream_unavailable; expected wrong_status, got upstream_unavailable; slow: 15017 ms (actions answer within 12 s, the proxy waits 15 s); 502 from t... |
| POST /v1/actions/contest | blocked (upstream_unavailable) | contest 0x392d6f13 (settled) as shop | code upstream_unavailable is documented at 503, answered 502; expected HTTP 409, got 502 upstream_unavailable; expected wrong_status, got upstream_unavailable; slow: 15006 ms (actions answer within 12 s, the proxy waits 15 s); 502 from t... |
| POST /v1/actions/closeUncontested | blocked (upstream_unavailable) | closeUncontested 0x392d6f13 (settled) as ops-hedera | code upstream_unavailable is documented at 503, answered 502; expected HTTP 409, got 502 upstream_unavailable; expected wrong_status, got upstream_unavailable; slow: 15007 ms (actions answer within 12 s, the proxy waits 15 s); 502 from t... |
| POST /v1/actions/sendToCourt | pass (wrong_status) | sendToCourt 0x392d6f13 (settled) as ops-hedera |  |
| POST /v1/actions/resend | pass (wrong_status) | resend 0x392d6f13 (settled) as ops-hedera |  |
| POST /v1/actions/expireClaim | pass (wrong_status) | expireClaim 0x392d6f13 (settled) as ops-hedera |  |
| POST /v1/actions/settle | pass (wrong_status) | settle 0x392d6f13 (settled) as ops-hedera |  |
| POST /v1/actions/openCase | pass (case_wrong_state) | openCase 0x392d6f13 (settled) as ops-arb |  |
| POST /v1/actions/refile | pass (case_wrong_state) | refile 0x392d6f13 (settled) as ops-arb |  |
| POST /v1/actions/relayRuling | pass (wrong_status) | relayRuling 0x392d6f13 (settled) as ops-arb, payIn native |  |
| POST /v1/actions/relayRuling | pass (wrong_status) | relayRuling 0x392d6f13 (settled) as ops-arb, payIn link |  |
| POST /v1/actions/submitEvidence | dry-only | submitEvidence 0x392d6f13 (settled) as ops-arb |  |
| POST /v1/actions/contest | pass (wrong_status) | contest 0x9cd70468 (closed_uncontested) as platform | slow: 12218 ms (actions answer within 12 s, the proxy waits 15 s) |
| POST /v1/actions/contest | pass (wrong_status) | contest 0x9cd70468 (closed_uncontested) as shop |  |
| POST /v1/actions/closeUncontested | pass (wrong_status) | closeUncontested 0x9cd70468 (closed_uncontested) as ops-hedera |  |
| POST /v1/actions/sendToCourt | pass (wrong_status) | sendToCourt 0x9cd70468 (closed_uncontested) as ops-hedera |  |
| POST /v1/actions/resend | pass (wrong_status) | resend 0x9cd70468 (closed_uncontested) as ops-hedera |  |
| POST /v1/actions/expireClaim | pass (wrong_status) | expireClaim 0x9cd70468 (closed_uncontested) as ops-hedera |  |
| POST /v1/actions/settle | pass (wrong_status) | settle 0x9cd70468 (closed_uncontested) as ops-hedera |  |
| POST /v1/actions/openCase | pass (not_found) | openCase 0x9cd70468 (closed_uncontested) as ops-arb |  |
| POST /v1/actions/refile | pass (not_found) | refile 0x9cd70468 (closed_uncontested) as ops-arb |  |
| POST /v1/actions/relayRuling | pass (not_found) | relayRuling 0x9cd70468 (closed_uncontested) as ops-arb, payIn native |  |
| POST /v1/actions/relayRuling | pass (not_found) | relayRuling 0x9cd70468 (closed_uncontested) as ops-arb, payIn link |  |
| POST /v1/actions/submitEvidence | pass (not_found) | submitEvidence 0x9cd70468 (closed_uncontested) as ops-arb |  |
| POST /v1/actions/withdrawCredit | pass (no_credit) | withdrawCredit as the shop |  |
| POST /v1/actions/withdrawCredit | dry-only | withdrawCredit as an account with credit (scheme) |  |
| POST /v1/actions/withdrawCredit | blocked (upstream_unavailable) | withdrawCredit, body sent as text/plain (read as JSON whatever its type) | code upstream_unavailable is documented at 503, answered 502; expected HTTP 200\|409, got 502 upstream_unavailable; slow: 15017 ms (actions answer within 12 s, the proxy waits 15 s); 502 from the web server: the status API did not answer ... |
| POST /v1/actions/fileClaim | pass (claim_exists) | fileClaim by orderId alone 0x6d94a648 (already claimed) |  |
| POST /v1/actions/fileClaim | pass (claim_exists) | fileClaim by nonce + platform 0x6d94a648 (already claimed) |  |
| POST /v1/actions/fileClaim | pass (order_id_mismatch) | fileClaim, orderId that does not match nonce + platform |  |
| POST /v1/actions/fileClaim | blocked (upstream_unavailable) | fileClaim by orderId alone 0xb7da5ace (already claimed) | code upstream_unavailable is documented at 503, answered 502; expected HTTP 409, got 502 upstream_unavailable; expected claim_exists, got upstream_unavailable; slow: 15014 ms (actions answer within 12 s, the proxy waits 15 s); 502 from t... |
| POST /v1/actions/fileClaim | blocked (upstream_unavailable) | fileClaim by nonce + platform 0xb7da5ace (already claimed) | code upstream_unavailable is documented at 503, answered 502; expected HTTP 409, got 502 upstream_unavailable; expected claim_exists, got upstream_unavailable; slow: 15006 ms (actions answer within 12 s, the proxy waits 15 s); 502 from t... |
| POST /v1/actions/fileClaim | pass (order_id_mismatch) | fileClaim, orderId that does not match nonce + platform |  |
| POST /v1/actions/fileClaim | pass (claim_exists) | fileClaim by orderId alone 0x1bf80d52 (already claimed) |  |
| POST /v1/actions/fileClaim | pass (claim_exists) | fileClaim by nonce + platform 0x1bf80d52 (already claimed) |  |
| POST /v1/actions/fileClaim | pass (order_id_mismatch) | fileClaim, orderId that does not match nonce + platform |  |
| POST /v1/actions/fileClaim | pass (order_nonce_unknown) | fileClaim, orderId the shop does not know |  |
| POST /v1/actions/fileClaim | pass (no_ordered_record) | fileClaim, nonce with no ordered record |  |
| POST /v1/actions/fileClaim | pass (same_party) | fileClaim, platform is the shop itself |  |
| POST /v1/actions/fileClaim | pass (missing_field) | fileClaim, neither orderId nor nonce + platform |  |
| POST /v1/actions/fileClaim | pass (invalid_field) | fileClaim, netLossUsdc not an integer string |  |
| POST /v1/actions/fileClaim | pass (invalid_field) | fileClaim, allowUnpacked not a boolean |  |
| POST /v1/actions/fileClaim | pass (invalid_field) | fileClaim, basketUsdc above uint256 |  |
| POST /v1/actions/submitEvidence | pass (invalid_field) | submitEvidence, name over 200 characters |  |
| POST /v1/actions/submitEvidence | pass (invalid_field) | submitEvidence, blank name |  |
| POST /v1/actions/submitEvidence | pass (missing_field) | submitEvidence, no description |  |
| POST /v1/actions/submitEvidence | pass (invalid_field) | submitEvidence, fileURI not /ipfs/ or https |  |
| POST /v1/actions/submitEvidence | pass (invalid_field) | submitEvidence, attempt 3 |  |
| POST /v1/actions/submitEvidence | pass (invalid_field) | submitEvidence, attempt as a string |  |
| POST /v1/actions/submitEvidence | pass (evidence_too_large) | submitEvidence, 50 KB description (over 49152 bytes, under 64 KB) |  |
| POST /v1/actions/relayRuling | pass (invalid_field) | relayRuling, payIn not native or link |  |
| POST /v1/actions/fileClaim | pass (missing_field) | fileClaim: empty object |  |
| POST /v1/actions/fileClaim | pass (invalid_field) | fileClaim: from not an address |  |
| POST /v1/actions/fileClaim | pass (invalid_field) | fileClaim: from the zero address |  |
| POST /v1/actions/fileClaim | pass (unknown_field) | fileClaim: an extra field (privateKey) is refused |  |
| POST /v1/actions/fileClaim | pass (bad_json) | fileClaim: body not JSON |  |
| POST /v1/actions/fileClaim | pass (bad_json) | fileClaim: body a JSON array |  |
| POST /v1/actions/fileClaim | pass (payload_too_large) | fileClaim: body over 64 KB |  |
| GET /v1/actions/fileClaim | pass (method_not_allowed) | fileClaim: GET is refused |  |
| POST /v1/actions/contest | pass (missing_field) | contest: empty object |  |
| POST /v1/actions/contest | pass (invalid_field) | contest: from not an address |  |
| POST /v1/actions/contest | pass (invalid_field) | contest: from the zero address |  |
| POST /v1/actions/contest | pass (unknown_field) | contest: an extra field (privateKey) is refused |  |
| POST /v1/actions/contest | pass (bad_json) | contest: body not JSON |  |
| POST /v1/actions/contest | pass (bad_json) | contest: body a JSON array |  |
| POST /v1/actions/contest | pass (payload_too_large) | contest: body over 64 KB |  |
| POST /v1/actions/contest | pass (invalid_field) | contest: claimId short |  |
| POST /v1/actions/contest | pass (not_found) | contest: claimId unknown |  |
| GET /v1/actions/contest | pass (method_not_allowed) | contest: GET is refused |  |
| POST /v1/actions/submitEvidence | pass (missing_field) | submitEvidence: empty object |  |
| POST /v1/actions/submitEvidence | pass (invalid_field) | submitEvidence: from not an address |  |
| POST /v1/actions/submitEvidence | pass (invalid_field) | submitEvidence: from the zero address |  |
| POST /v1/actions/submitEvidence | pass (unknown_field) | submitEvidence: an extra field (privateKey) is refused |  |
| POST /v1/actions/submitEvidence | pass (bad_json) | submitEvidence: body not JSON |  |
| POST /v1/actions/submitEvidence | pass (bad_json) | submitEvidence: body a JSON array |  |
| POST /v1/actions/submitEvidence | pass (payload_too_large) | submitEvidence: body over 64 KB |  |
| POST /v1/actions/submitEvidence | pass (invalid_field) | submitEvidence: claimId short |  |
| POST /v1/actions/submitEvidence | pass (not_found) | submitEvidence: claimId unknown |  |
| GET /v1/actions/submitEvidence | pass (method_not_allowed) | submitEvidence: GET is refused |  |
| POST /v1/actions/withdrawCredit | pass (missing_field) | withdrawCredit: empty object |  |
| POST /v1/actions/withdrawCredit | pass (invalid_field) | withdrawCredit: from not an address |  |
| POST /v1/actions/withdrawCredit | pass (invalid_field) | withdrawCredit: from the zero address |  |
| POST /v1/actions/withdrawCredit | pass (unknown_field) | withdrawCredit: an extra field (privateKey) is refused |  |
| POST /v1/actions/withdrawCredit | pass (bad_json) | withdrawCredit: body not JSON |  |
| POST /v1/actions/withdrawCredit | pass (bad_json) | withdrawCredit: body a JSON array |  |
| POST /v1/actions/withdrawCredit | pass (payload_too_large) | withdrawCredit: body over 64 KB |  |
| GET /v1/actions/withdrawCredit | pass (method_not_allowed) | withdrawCredit: GET is refused |  |
| POST /v1/actions/closeUncontested | pass (missing_field) | closeUncontested: empty object |  |
| POST /v1/actions/closeUncontested | pass (invalid_field) | closeUncontested: from not an address |  |
| POST /v1/actions/closeUncontested | pass (invalid_field) | closeUncontested: from the zero address |  |
| POST /v1/actions/closeUncontested | pass (unknown_field) | closeUncontested: an extra field (privateKey) is refused |  |
| POST /v1/actions/closeUncontested | pass (bad_json) | closeUncontested: body not JSON |  |
| POST /v1/actions/closeUncontested | pass (bad_json) | closeUncontested: body a JSON array |  |
| POST /v1/actions/closeUncontested | pass (payload_too_large) | closeUncontested: body over 64 KB |  |
| POST /v1/actions/closeUncontested | pass (invalid_field) | closeUncontested: claimId short |  |
| POST /v1/actions/closeUncontested | blocked (upstream_unavailable) | closeUncontested: claimId unknown | code upstream_unavailable is documented at 503, answered 502; expected HTTP 404, got 502 upstream_unavailable; expected not_found, got upstream_unavailable; slow: 15017 ms (actions answer within 12 s, the proxy waits 15 s); 502 from the ... |
| GET /v1/actions/closeUncontested | pass (method_not_allowed) | closeUncontested: GET is refused |  |
| POST /v1/actions/sendToCourt | pass (missing_field) | sendToCourt: empty object |  |
| POST /v1/actions/sendToCourt | pass (invalid_field) | sendToCourt: from not an address |  |
| POST /v1/actions/sendToCourt | pass (invalid_field) | sendToCourt: from the zero address |  |
| POST /v1/actions/sendToCourt | pass (unknown_field) | sendToCourt: an extra field (privateKey) is refused |  |
| POST /v1/actions/sendToCourt | pass (bad_json) | sendToCourt: body not JSON |  |
| POST /v1/actions/sendToCourt | pass (bad_json) | sendToCourt: body a JSON array |  |
| POST /v1/actions/sendToCourt | pass (payload_too_large) | sendToCourt: body over 64 KB |  |
| POST /v1/actions/sendToCourt | pass (invalid_field) | sendToCourt: claimId short |  |
| POST /v1/actions/sendToCourt | blocked (upstream_unavailable) | sendToCourt: claimId unknown | code upstream_unavailable is documented at 503, answered 502; expected HTTP 404, got 502 upstream_unavailable; expected not_found, got upstream_unavailable; slow: 15017 ms (actions answer within 12 s, the proxy waits 15 s); 502 from the ... |
| GET /v1/actions/sendToCourt | pass (method_not_allowed) | sendToCourt: GET is refused |  |
| POST /v1/actions/resend | pass (missing_field) | resend: empty object |  |
| POST /v1/actions/resend | pass (invalid_field) | resend: from not an address |  |
| POST /v1/actions/resend | pass (invalid_field) | resend: from the zero address |  |
| POST /v1/actions/resend | pass (unknown_field) | resend: an extra field (privateKey) is refused |  |
| POST /v1/actions/resend | pass (bad_json) | resend: body not JSON |  |
| POST /v1/actions/resend | pass (bad_json) | resend: body a JSON array |  |
| POST /v1/actions/resend | pass (payload_too_large) | resend: body over 64 KB |  |
| POST /v1/actions/resend | pass (invalid_field) | resend: claimId short |  |
| POST /v1/actions/resend | pass (not_found) | resend: claimId unknown |  |
| GET /v1/actions/resend | pass (method_not_allowed) | resend: GET is refused |  |
| POST /v1/actions/expireClaim | pass (missing_field) | expireClaim: empty object |  |
| POST /v1/actions/expireClaim | pass (invalid_field) | expireClaim: from not an address |  |
| POST /v1/actions/expireClaim | pass (invalid_field) | expireClaim: from the zero address |  |
| POST /v1/actions/expireClaim | pass (unknown_field) | expireClaim: an extra field (privateKey) is refused |  |
| POST /v1/actions/expireClaim | pass (bad_json) | expireClaim: body not JSON |  |
| POST /v1/actions/expireClaim | pass (bad_json) | expireClaim: body a JSON array |  |
| POST /v1/actions/expireClaim | pass (payload_too_large) | expireClaim: body over 64 KB |  |
| POST /v1/actions/expireClaim | pass (invalid_field) | expireClaim: claimId short |  |
| POST /v1/actions/expireClaim | blocked (upstream_unavailable) | expireClaim: claimId unknown | code upstream_unavailable is documented at 503, answered 502; expected HTTP 404, got 502 upstream_unavailable; expected not_found, got upstream_unavailable; slow: 15014 ms (actions answer within 12 s, the proxy waits 15 s); 502 from the ... |
| GET /v1/actions/expireClaim | pass (method_not_allowed) | expireClaim: GET is refused |  |
| POST /v1/actions/settle | pass (missing_field) | settle: empty object |  |
| POST /v1/actions/settle | pass (invalid_field) | settle: from not an address |  |
| POST /v1/actions/settle | pass (invalid_field) | settle: from the zero address |  |
| POST /v1/actions/settle | pass (unknown_field) | settle: an extra field (privateKey) is refused |  |
| POST /v1/actions/settle | pass (bad_json) | settle: body not JSON |  |
| POST /v1/actions/settle | pass (bad_json) | settle: body a JSON array |  |
| POST /v1/actions/settle | pass (payload_too_large) | settle: body over 64 KB |  |
| POST /v1/actions/settle | pass (invalid_field) | settle: claimId short |  |
| POST /v1/actions/settle | blocked (upstream_unavailable) | settle: claimId unknown | code upstream_unavailable is documented at 503, answered 502; expected HTTP 404, got 502 upstream_unavailable; expected not_found, got upstream_unavailable; slow: 15010 ms (actions answer within 12 s, the proxy waits 15 s); 502 from the ... |
| GET /v1/actions/settle | pass (method_not_allowed) | settle: GET is refused |  |
| POST /v1/actions/openCase | pass (missing_field) | openCase: empty object |  |
| POST /v1/actions/openCase | pass (invalid_field) | openCase: from not an address |  |
| POST /v1/actions/openCase | pass (invalid_field) | openCase: from the zero address |  |
| POST /v1/actions/openCase | pass (unknown_field) | openCase: an extra field (privateKey) is refused |  |
| POST /v1/actions/openCase | pass (bad_json) | openCase: body not JSON |  |
| POST /v1/actions/openCase | pass (bad_json) | openCase: body a JSON array |  |
| POST /v1/actions/openCase | pass (payload_too_large) | openCase: body over 64 KB |  |
| POST /v1/actions/openCase | pass (invalid_field) | openCase: claimId short |  |
| POST /v1/actions/openCase | pass (not_found) | openCase: claimId unknown |  |
| GET /v1/actions/openCase | pass (method_not_allowed) | openCase: GET is refused |  |
| POST /v1/actions/refile | pass (missing_field) | refile: empty object |  |
| POST /v1/actions/refile | pass (invalid_field) | refile: from not an address |  |
| POST /v1/actions/refile | pass (invalid_field) | refile: from the zero address |  |
| POST /v1/actions/refile | pass (unknown_field) | refile: an extra field (privateKey) is refused |  |
| POST /v1/actions/refile | pass (bad_json) | refile: body not JSON |  |
| POST /v1/actions/refile | pass (bad_json) | refile: body a JSON array |  |
| POST /v1/actions/refile | pass (payload_too_large) | refile: body over 64 KB |  |
| POST /v1/actions/refile | pass (invalid_field) | refile: claimId short |  |
| POST /v1/actions/refile | pass (not_found) | refile: claimId unknown |  |
| GET /v1/actions/refile | pass (method_not_allowed) | refile: GET is refused |  |
| POST /v1/actions/relayRuling | pass (missing_field) | relayRuling: empty object |  |
| POST /v1/actions/relayRuling | pass (invalid_field) | relayRuling: from not an address |  |
| POST /v1/actions/relayRuling | pass (invalid_field) | relayRuling: from the zero address |  |
| POST /v1/actions/relayRuling | pass (unknown_field) | relayRuling: an extra field (privateKey) is refused |  |
| POST /v1/actions/relayRuling | pass (bad_json) | relayRuling: body not JSON |  |
| POST /v1/actions/relayRuling | pass (bad_json) | relayRuling: body a JSON array |  |
| POST /v1/actions/relayRuling | pass (payload_too_large) | relayRuling: body over 64 KB |  |
| POST /v1/actions/relayRuling | pass (invalid_field) | relayRuling: claimId short |  |
| POST /v1/actions/relayRuling | pass (not_found) | relayRuling: claimId unknown |  |
| GET /v1/actions/relayRuling | pass (method_not_allowed) | relayRuling: GET is refused |  |
| POST /v1/actions/stealFunds | pass (not_found) | unknown action name |  |
| GET /catalog | pass | shop catalog |  |
| GET /orders/{orderId} | pass | shop order by id (nonce and platform for an orderId-only fileClaim) |  |
| GET /orders/{orderId} | pass (order_not_found) | shop order unknown |  |
| POST /x402/orders/{sku}/{quantity} | pass (bad_order_headers) | x402 order without the two order headers |  |
| POST /x402/orders/{sku}/{quantity} | pass (unknown_item) | x402 order for an unknown item |  |
| POST /x402/orders/{sku}/{quantity} | pass (unknown_platform) | x402 order from an account that is not a platform |  |
| POST /x402/orders/{sku}/{quantity} | pass | x402 order, no payment yet: the payment request (nothing settles) |  |
| POST /x402/ping-order | pass | x402 ping, no payment |  |
| POST /v1/actions/withdrawCredit | pass (rate_limited) | action rate limit: 14 at once from one client | first 429 after 10 posts, retry-after 2 |
| proxy /api -> status API | pass | upstream failures during the run use the documented shape |  |
| selftest GET /v1/claims/{claimId} | pass | selftest: claim detail as served is judged pass | judged pass |
| selftest GET /v1/claims/{claimId} | pass | selftest: claim detail, statusKey not in its enum is judged fail | judged fail; schema: /claim/statusKey must be equal to one of the allowed values ["filed","finding_made","no_finding","window_lapsed","closed_uncontested","contested","at_court","stuck","refused_once","ruled","zero_twice_answer_applied",... |
| selftest GET /v1/claims/{claimId} | pass | selftest: claim detail, claimId deleted (required) is judged fail | judged fail; schema: /claim must have required property 'claimId' |
| selftest GET /v1/claims/{claimId} | pass | selftest: claim detail, claimId a number is judged fail | judged fail; schema: /claim/claimId must be string |
| selftest GET /v1/claims/{claimId} | pass | selftest: claim detail, meta deleted is judged fail | judged fail; schema: / must have required property 'meta' |
| selftest GET /v1/claims/{claimId} | pass | selftest: claim detail at HTTP 201 (not documented) is judged fail | judged fail; HTTP 201 is not documented for GET /v1/claims/{claimId}; the spec gives no JSON schema for HTTP 201 on GET /v1/claims/{claimId}: nothing to validate against |
| selftest GET /v1/claims/{claimId} | pass | selftest: claim detail served as text/html is judged fail | judged fail; content-type text/html |
| selftest GET /v1/claims/{claimId} | pass | selftest: claim detail, expected 404 on purpose is judged fail | judged fail; expected HTTP 404, got 200; expected not_found, got HTTP 200 |
| selftest GET /v1/claims | pass | selftest: claims list as served is judged pass | judged pass |
| selftest GET /v1/claims | pass | selftest: claims list, claims an object is judged fail | judged fail; schema: /claims must be array |
| selftest GET /v1/claims | pass | selftest: claims list, a row with nextActor not in its enum is judged fail | judged fail; schema: /claims/0/nextActor must be equal to one of the allowed values ["none","anyone","shop","platform","keeper","court","preCheckSigner"] |
| selftest GET /v1/claims/{claimId} | pass | selftest: unknown claim as served (404 not_found) is judged pass | judged pass |
| selftest GET /v1/claims/{claimId} | pass | selftest: unknown claim, expected 400 invalid_field on purpose is judged fail | judged fail; expected HTTP 400, got 404 not_found; expected invalid_field, got not_found |
| selftest GET /v1/claims/{claimId} | pass | selftest: error, code not in ErrorCode is judged fail | judged fail; error shape: /error/code must be equal to one of the allowed values ["bad_json","missing_field","invalid_field","unknown_field","not_contester","not_found","method_not_allowed","payload_too_large","same_party","order_id_mism... |
| selftest GET /v1/claims/{claimId} | pass | selftest: error, message deleted is judged fail | judged fail; error shape: /error must have required property 'message'; message missing or holds a URL |
| selftest GET /v1/claims/{claimId} | pass | selftest: error, a key beside error is judged fail | judged fail; error shape: / must NOT have additional properties (stack) |
| selftest GET /v1/claims/{claimId} | pass | selftest: error, a key inside error beside code, message, details is judged fail | judged fail; error object holds stack besides code, message, details |
| selftest GET /v1/claims/{claimId} | pass | selftest: error, a URL in the message is judged fail | judged fail; message missing or holds a URL |
| selftest GET /v1/claims/{claimId} | pass | selftest: error, a code documented at another status (wrong_status at 404) is judged fail | judged fail; code wrong_status is documented at 409, answered 404 |
| selftest GET /v1/claims/{claimId} | pass | selftest: error, a code this path does not list (no_credit at 409) is judged fail | judged fail; HTTP 409 is not documented for GET /v1/claims/{claimId} |
| selftest GET /v1/claims/{claimId} | pass | selftest: error, the old shape {error: code} is judged fail | judged fail; error shape: /error must be object; message missing or holds a URL |
| selftest POST /v1/actions/withdrawCredit | pass | selftest: action error, a code at its status that the action does not list (withdrawCredit wrong_status 409) is judged fail | judged fail; code wrong_status is not in /v1/actions/withdrawCredit's x-recourse-errors |
| selftest POST /v1/actions/withdrawCredit | pass | selftest: action error, a listed code at its status (withdrawCredit no_credit 409) is judged pass | judged pass |
| selftest POST /v1/actions/withdrawCredit | pass | selftest: withdrawCredit build as served is judged pass | judged pass |
| selftest POST /v1/actions/withdrawCredit | pass | selftest: build for a mainnet chain id (1) is judged fail | judged fail; schema: /chainId must be equal to one of the allowed values [296,421614]; schema: /transactions/0/chainId must be equal to one of the allowed values [296,421614] |
| selftest POST /v1/actions/withdrawCredit | pass | selftest: build sent to another contract is judged fail | judged fail; tx 1 goes to 0x000000000000000000000000000000000000dEaD, params say DepositVault is 0xA22fB188b49eddecc4f9DE22607e70E1d07Aea2e |
| selftest POST /v1/actions/withdrawCredit | pass | selftest: build whose data calls another function is judged fail | judged fail; tx 1: data does not decode as a DepositVault call |
| selftest POST /v1/actions/withdrawCredit | pass | selftest: build with a value the preview does not show is judged fail | judged fail; transactions send 1, the preview shows 0 sent |
| selftest POST /v1/actions/withdrawCredit | pass | selftest: build whose fee is not gas x gasPrice is judged fail | judged fail; fee 1 is not the sum of gas x gasPrice (127682100000000000) |
| selftest POST /v1/actions/withdrawCredit | pass | selftest: build from another account is judged fail | judged fail; from is not the account asked for |
| selftest POST /v1/actions/withdrawCredit | pass | selftest: build, movement not in its enum is judged fail | judged fail; schema: /preview/amounts/0/movement must be equal to one of the allowed values ["escrow","reserve","credit","receive","send","contract_pays","info"] |
| selftest POST /v1/actions/withdrawCredit | pass | selftest: build, transactions deleted is judged fail | judged fail; schema: / must have required property 'transactions'; builtProblems threw: Cannot read properties of undefined (reading 'forEach') |
| UI #/ (no wallet) | pass | home reads without a wallet (desktop) |  |
| UI #/claim/{id} (no wallet) | pass | claim-8f78143e reads without a wallet (desktop) |  |
| UI #/claim/{id} (no wallet) | pass | claim-392d6f13 reads without a wallet (desktop) |  |
| UI #/claim/{id} (no wallet) | pass | claim-9cd70468 reads without a wallet (desktop) |  |
| UI #/party/{id} (no wallet) | pass | party-shop reads without a wallet (desktop) |  |
| UI #/docket (no wallet) | pass | docket reads without a wallet (desktop) |  |
| UI #/file (no wallet) | pass | file reads without a wallet (desktop) |  |
| UI header Connect wallet | pass | connect: eth_requestAccounts, account and network in the header (desktop) |  |
| UI withdraw-scheme withdrawCredit | dry-only | Withdraw credit: preview, confirm, wallet asked, declined (desktop) |  |
| UI evidence-392d6f13 submitEvidence | dry-only | Add evidence to the court case: preview, confirm, wallet asked, declined (desktop) |  |
| UI claim contest | blocked | contest not offered on 0x8f78143e (closed_uncontested); the API answers wrong_status (desktop) |  |
| UI #/file fileClaim | pass | a claimed order links its claim and offers no filing (desktop) |  |
| UI #/file fileClaim | pass | unknown order: refused order_nonce_unknown, shown with its code (desktop) |  |
| UI #/file fileClaim | pass | nonce + agent company with no ordered record: refused order_id_mismatch (desktop) |  |
| UI claim next step (anyone) | blocked | no claim has an anyone-may step due: nothing offered (desktop) |  |
| UI #/ (no wallet) | pass | home reads without a wallet (mobile) |  |
| UI #/claim/{id} (no wallet) | pass | claim-8f78143e reads without a wallet (mobile) |  |
| UI #/claim/{id} (no wallet) | pass | claim-392d6f13 reads without a wallet (mobile) |  |
| UI #/claim/{id} (no wallet) | pass | claim-9cd70468 reads without a wallet (mobile) |  |
| UI #/party/{id} (no wallet) | pass | party-shop reads without a wallet (mobile) |  |
| UI #/docket (no wallet) | pass | docket reads without a wallet (mobile) |  |
| UI #/file (no wallet) | pass | file reads without a wallet (mobile) |  |
| UI header Connect wallet | pass | connect: eth_requestAccounts, account and network in the header (mobile) |  |
| UI withdraw-scheme withdrawCredit | blocked | Withdraw credit: preview, confirm, wallet asked, declined (mobile) | the harness's own build answered upstream_unavailable after 3 tries: the page's preview was checked against its own answer only |
| UI evidence-392d6f13 submitEvidence | dry-only | Add evidence to the court case: preview, confirm, wallet asked, declined (mobile) |  |
| UI claim contest | blocked | contest not offered on 0x8f78143e (closed_uncontested); the API answers wrong_status (mobile) |  |
| UI #/file fileClaim | pass | a claimed order links its claim and offers no filing (mobile) |  |
| UI #/file fileClaim | pass | unknown order: refused order_nonce_unknown, shown with its code (mobile) |  |
| UI #/file fileClaim | pass | nonce + agent company with no ordered record: refused order_id_mismatch (mobile) |  |
| UI claim next step (anyone) | blocked | no claim has an anyone-may step due: nothing offered (mobile) |  |
| pnpm test @recourse/court | pass | Tests  29 passed (29) (exit 0) |  |
| pnpm test @recourse/records | pass | Tests  61 passed (61) (exit 0) |  |
| pnpm test @recourse/renderer | pass | Tests  14 passed (14) (exit 0) |  |
| pnpm test @recourse/shared | pass | Tests  277 passed (277) (exit 0) |  |
| pnpm test @recourse/agent | pass | Tests  67 passed (67) (exit 0) |  |
| pnpm test @recourse/docket | pass | Tests  107 passed (107) (exit 0) |  |
| pnpm test @recourse/intake | pass | Tests  18 passed (18) (exit 0) |  |
| pnpm test @recourse/keeper | pass | Tests  179 passed (179) (exit 0) |  |
| pnpm test @recourse/precheck | pass | Tests  136 passed (136) (exit 0) |  |
| pnpm test @recourse/shop | pass | Tests  75 passed (75) (exit 0) |  |
| pnpm test @recourse/status-api | pass | Tests  263 passed \| 2 skipped (265) (exit 0) |  |
| pnpm test @recourse/web | pass | Tests  147 passed (147) (exit 0) |  |
| forge test --no-match-contract Probe | pass | 301 passed, 0 failed, 3 skipped (exit 0) |  |

pass 296, fail 1, blocked 18, dry-only 5
