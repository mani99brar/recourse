# Keeper runbook

Steps for the alerts that need a person. `ctl.sh` is `ops/units/ctl.sh`; `ctl.sh keeper <args>` runs
keeper-ctl with the unit's port and state directory (`~/.local/state/recourse/keeper`).

## A CCIP message failed on an OffRamp (exec_failure)

The alert names the message id, links its CCIP Explorer page and says which leg it is:

- an **outbound message** carries the claim from Hedera to the case contract on Arbitrum;
- a **ruling message** carries the court's ruling from Arbitrum back to Hedera.

Failure means the OffRamp ran the receive and it did not complete. Both contracts are written never to
revert on a message the router delivers, so the usual cause is gas: each message carries a gas limit of
150,000 (`gasClaimToCourt`, `gasRulingBack`), against about 95,000 and 37,000 measured.

What the keeper does and does not do:

- It does not execute a failed message by hand, and no setting makes it do so
  (`KEEPER_AUTO_MANUAL_EXEC` is not read).
- It resends an outbound message only while every copy is still Untouched, so a Failure stops resends.
  The claim expires on Hedera at preCheckedAt + claimTimeout unless the message is executed first.
- A ruling message in Failure holds expiry back: the keeper raises expiry_race and does not call
  expireClaim, so the court's ruling can still be delivered.

Steps:

1. `ctl.sh keeper status <claimId>` shows the claim's phase and its `outbound` and `inbound` messages, each
   with its OffRamp state and its CCIP Explorer link.
2. Open the link. The CCIP Explorer offers manual execution of a failed message from its page: connect a
   wallet on the destination chain (Arbitrum Sepolia for an outbound message, Hedera testnet for a ruling
   message), raise the gas limit (300,000 is twice the configured limit) and send. Any funded account can
   execute it; it does not have to be a keeper key, and using another account keeps clear of the keeper's
   nonces.
3. Confirm: the Explorer shows Success, and on the keeper's next ticks the claim moves on. An outbound
   message brings ClaimReceived on Arbitrum and the phase goes to Delivered, then the case opens. A ruling
   message brings RulingReceived on Hedera and the keeper settles the claim.
4. If a ruling message cannot be executed and you decide to let the claim expire instead,
   `ctl.sh keeper expire <claimId>` lets the keeper call expireClaim; the ruling is then ignored.

## Journal lines that do not parse (journal_error)

At start the keeper reads `journal.jsonl` in its state directory. A complete line that does not parse is
skipped, and the alert lists the line numbers; the keeper runs on with the rest. (A cut-off last line,
left by a crash in the middle of a write, is dropped when the journal opens and is not this alert.)
keeper-ctl has no rebuild command. A skipped line can leave a claim in an older phase (an event or state
record), or the keeper no longer follows one of its own transactions (an intent or result record).

1. `ctl.sh keeper pause`, then `ctl.sh stop keeper`.
2. Copy the whole state directory aside before changing anything.
3. Look at each listed line, for example `sed -n '<n>p' journal.jsonl | cut -c1-300`. Every line is one
   JSON record and its `t` field names the kind: event, state, evidence, intent, result, alert, alertSent,
   seen, alertClock, compacted.
4. Mend the line if it is plainly a damaged copy of one record, otherwise delete it. `journal.jsonl.prev`,
   when present, is the journal as it was before the last compaction, kept for reference.
5. `ctl.sh start keeper`, then compare `ctl.sh keeper status <claimId>` for each open claim with the chains
   (the claim on Hashscan, the case and dispute on Arbitrum). If a removed line was an intent, look up that
   nonce among the key's transactions in the explorer.
6. `ctl.sh keeper resume`.

## Alerts not delivered (/health 503)

Every alert is written to the journal and to the service log as an `alert <kind> ...` line. There are
two ways it reaches a person:

- **Without `ALERT_URL`** the log is the channel: `recourse-watch.timer` (ops/watch/watch.sh) forwards each
  new `alert` line through `RECOURSE_NOTIFY_CMD`. The keeper logs "ALERT_URL is not set: alerts go to this
  log only" once, and `/health` shows `alerts.delivery: "log only ..."`. If the watch timer is not
  installed (`systemctl --user list-timers | grep recourse-watch`) or has no notifier, nobody is told.
- **With `ALERT_URL`** the keeper posts each alert. When one has waited more than 10 minutes, `/health`
  answers 503 and `problems` gives the HTTP status the endpoint answers (`HTTP 404` for a wrong path,
  `HTTP 503` while it is down). The log says the same once per change ("alerts not delivered: ..."). The
  URL itself is never printed.

To mend: install the watch timer with a notifier, or set or correct `ALERT_URL` in the keeper's
environment file and restart the keeper. Nothing is lost: alerts still waiting for `ALERT_URL` are read
back from the journal and sent oldest first. To read them meanwhile:
`grep '"t":"alert"' journal.jsonl | cut -c1-300` (those without a later `alertSent` record of the same
`id` were never posted).

## A Kleros dispute that cannot be read (expiry_race)

Before expiring a claim on Hedera, or marking its case stale on Arbitrum, the keeper reads the Kleros
dispute: a final ruling in its execution period still reaches Hedera through executeRuling. When that
read fails, the keeper does not know, so neither call goes ahead; the alert says "could not be read" and
the keeper tries again every tick. A read that keeps failing points at the Arbitrum RPC (see `rpc_down`
and `lastError` in `/health`). If the dispute has no ruling and you want the claim to expire now,
`ctl.sh keeper expire <claimId>` sends both calls without the read.
