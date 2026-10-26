# dxFeed Collector Operations Runbook

This is the operator sequence for the dedicated dxFeed history collector. The
collector is dev/test only under the current provider agreement. Commands are
run from `Terminal-L1-L2/apps/runtime` unless stated otherwise.

## Safety rules

1. Only one writer may own `data/live/dxfeed-market-data.sqlite`.
2. Stop the collector before migration, integrity verification, continuity
   audit, baseline backfill, or backup. Each tool takes the same exclusive lock
   and must fail if a writer remains alive.
3. Never delete or rename the database, `-wal`, `-shm`, or `.lock` merely to make
   startup pass. First establish process ownership and preserve the evidence.
4. The live writer validates schema v22 only. It must never perform migration or
   a full-database integrity scan in the market-data path.
5. Exit code 75 requests planned rotation. Exit 76 reports an unexpected
   connection drop: the launcher permits one retry after 120 seconds per
   deliberate run, then exits on another drop. Exit 1 is a non-retryable
   fault. Successful recovery/planned rotations do not replenish the allowance.

## First deployment or schema upgrade

With every dxFeed collector stopped:

```powershell
# Optional but strongly required before changing a valuable live store.
$env:TT_BACKUP_REMOTE = "gdrive:arkeos-backups"
npm run backup:manual

npm run migrate:dxfeed-storage-schema
npm run verify:dxfeed-storage-integrity
npm run audit:dxfeed-order-book-continuity
```

Only commands present in `apps/runtime/package.json` are supported. Historical
large-trade baseline backfill scripts have been removed; current ranking does
not use that deprecated statistical baseline.

The default continuity audit targets the previous UTC day. To audit an explicit
day or database:

```powershell
node scripts/audit-dxfeed-order-book-continuity.js "C:\path\dxfeed-market-data.sqlite" 2026-08-30
```

Interpret exit codes: migration/integrity/backfill use 0 success and 1 failure;
the continuity audit uses 0 clean/no interrupted capture, 2 interrupted L2
transactions/snapshots found, and 1 tool failure. `NO_DATA` is evidence, not a
positive continuity claim.

## Rebuild reconstructed candles

Candles the collector built from TimeAndSale before a change to the candle
eligibility rules keep the old rules until they are rebuilt. The rebuild reads
the stored prints of each reconstructed minute in a window, applies the current
rules (a `NEW` event, `validTick` required, spread legs excluded) through the
same aggregator the collector uses, and then replaces the minute, removes it
when no eligible print remains, or leaves it alone when its prints are no
longer stored. Native candles are never read or written.

```powershell
npm run rebuild:dxfeed-candles -- --from 2026-09-15T00:00:00Z --to 2026-09-23T00:00:00Z --report rebuild-dry-run.json
npm run rebuild:dxfeed-candles -- --from 2026-09-15T00:00:00Z --to 2026-09-23T00:00:00Z --write --report rebuild-write.json
```

The first command is a dry run: it opens the store read-only, so it can run
while the collector does, and it reports every minute with its old and rebuilt
values, the rejections by reason and the widest changes. `--write` takes the
writer lock and refuses while the collector runs, so do it inside a stopped
window (the weekend, when the stop timer has ended the collector). `--symbol`
limits the run to one governed instrument; an instrument outside the governed
catalog, such as an expired contract, is refused.

## Preflight and capacity qualification

Run the deterministic write-path gate after a material storage/runtime change:

```powershell
npm run qualify:dxfeed-storage
```

It writes only a disposable temporary database by default. To attach read-only
metadata about the deployment store while it is stopped:

```powershell
npm run qualify:dxfeed-storage -- --existing-db "data\live\dxfeed-market-data.sqlite"
```

Passing requires exact row counts and continuity, `quick_check=ok`, at least 5x
the declared 1,000 rows/second nominal load, batch/event-loop p99 below 250 ms,
and RSS growth below 512 MiB. Growth projections are planning upper bounds from
synthetic rows, not provider forecasts.

## Start and stop

```powershell
npm run collector:dxfeed:live
```

The launcher obtains short-lived tokens and can repeatedly replace children
after planned exit 75, subject to its minimum-uptime guard. Unexpected exit 76
gets one retry after 120 seconds; other faults do not. The collector stops five
minutes before authoritative token expiry. Stop it
with Ctrl-C and wait for `capture stopped` plus the capture-session result before
closing the terminal. Do not kill the process during normal maintenance.

Expected healthy evidence:

- increasing Quote, Trade, Order, and TimeAndSale counters;
- `diskProbeHealthy=true`, no persistent capacity breach;
- `orderV2PendingFrames` returning to zero rather than trending upward; a
  sustained rise means raw frames are outrunning parsed delivery toward the
  bounded correlation cap, which is fatal once exceeded;
- a non-zero `filtered` counter is normal: it includes every structural
  Order removal, which is stored only in `dxfeed_order_book_capture`;
- no *new* skipped/rejected cells or trade-ID continuity breaks per interval.
  Heartbeat health is measured per interval, not cumulatively: a heartbeat is
  degraded when a fault counter rises during that minute, and returns to
  nominal once it stops rising. The cumulative totals stay visible in the
  printed counters. A small fixed `skipped` count that never grows is normal
  — equities subscribed outside pre-market hours have no bid/ask in their
  first Quote snapshot, and that event is correctly skipped;
- checkpoint failure/busy counters remain zero;
- planned shutdown records `HEALTHY`; operator signals record a clean
  `DEGRADED` interruption boundary by design. Capture-session quality is
  judged on cumulative evidence, so a session that skipped anything at all is
  recorded `DEGRADED` even where the heartbeat has since recovered.

## Host (systemd) weekday-scheduled operation

Report 49 P1i. Everything above this section describes manual/local operation
(`npm run collector:dxfeed:live` from a developer's own machine, stopped with
Ctrl-C). The host runs the same collector + token-rotation launcher
(`run-dxfeed-collector.js` / `run-with-dxfeed-token.js`, unchanged) as a
systemd-managed, weekday-scheduled service instead:

- **`terminal-dxfeed-collector.service`** — the collector itself. Same
  `ExecStart=` as before; the launcher still owns planned rotation (exit 75)
  and its one 120s reconnect retry (exit 76) internally. It carries **no
  `[Install]` section** — it can never be `systemctl enable`d to auto-start at
  boot, and starts only when a timer or an operator explicitly runs
  `systemctl start` on it. A crash that isn't the launcher's own rotation is
  now covered by a bounded restart envelope (`Restart=on-failure`,
  `RestartSec=150`, `StartLimitIntervalSec=900`, `StartLimitBurst=5`) — wider
  than `terminal-collector.service`'s Binance envelope (`RestartSec=10`)
  deliberately: each restart requests a fresh token from the broker, and its
  rate limit is real (a live HTTP 429 hit on 2026-09-17 from the original,
  Binance-matching `RestartSec=10`). Systemd now attempts recovery up to 5
  times, at least 2.5 minutes apart, before giving up and needing a human,
  rather than either silently staying down (`Restart=no`, the old
  manual-only posture) or restart-looping against a monitored account fast
  enough to trip its own rate limit.
- **`terminal-dxfeed-collector-start.timer`** — `OnCalendar=Mon *-*-* 00:00:00
  UTC`, starts the collector. `Persistent=false` deliberately prevents a
  missed Monday activation from being replayed during a mid-week boot; after
  such a reboot, an operator must explicitly start the collector for the
  remainder of that week.
- **`terminal-dxfeed-collector-stop.timer`** + **`terminal-dxfeed-collector-
  stop.service`** — `OnCalendar=Sat *-*-* 00:00:00 UTC`, the stop half of the
  pair (a timer can only start its own unit, so the stop timer triggers a tiny
  oneshot service whose only job is `systemctl stop
  terminal-dxfeed-collector.service`). This timer is non-persistent too; the
  collector cannot be running after a host reboot unless explicitly started.
  The token wrapper translates that deliberate SIGTERM to exit status 143;
  the collector unit declares 143 successful so a normal Saturday stop leaves
  the unit inactive rather than failed and does not raise `OnFailure`.

Clean UTC weekday boundaries, not real CME/dxFeed session hours — "off on
weekends" is the whole requirement; nothing here tries to track intraday
session open/close.

**Installing the ops release never starts or enables any of this** —
`install-ops.sh` only ships and verifies the unit files (see the [server
runbook](../../operations/03-server-runbook.md)). Actually running the
collector on a schedule is a separate, explicit operator decision
(`systemctl enable --now terminal-dxfeed-collector-start.timer
terminal-dxfeed-collector-stop.timer`). Because the timers are non-persistent,
enabling them mid-week does not immediately open a connection; starting the
collector for that partial week requires a second explicit `systemctl start
terminal-dxfeed-collector.service`. Both actions remain separately gated.
**Before either action: confirm no laptop-local
`npm run collector:dxfeed:live` session is running against the same store.**
Safety rule 1 above still applies once the writer is host-managed instead of
laptop-managed — only one writer may own `dxfeed-market-data.sqlite`, and
nothing reconciles two independent writers automatically.

Health-check commands for the host-managed collector are in the [server
runbook](../../operations/03-server-runbook.md#1-check-health-without-changing-anything).
`terminal-dxfeed-collector.service` reporting `inactive` between Saturday
00:00 UTC and Monday 00:00 UTC is the expected weekday-off state, not a fault
— check `systemctl show ... -p NRestarts` and the journal for the actual
health signal outside that window.

## Failure triage

| Symptom | Meaning | Operator action |
|---|---|---|
| Schema version/layout/index error | Live DB is not the exact v22 contract. | Stop all owners; back up; run migration then integrity verification. |
| `.lock` already owned | Another writer may be live. | Identify the recorded PID/process; never delete the lock while ownership is possible. |
| `SQLITE_CORRUPT` / malformed image | Durable evidence may be damaged. | Preserve DB/WAL/SHM, stop restarts, restore to a new path, verify integrity, investigate disk. |
| `SQLITE_BUSY` / checkpoint busy | Reader/write pressure prevented full WAL progress. | Remove long readers, inspect WAL growth, run offline integrity after stop; repeated evidence degrades the session. |
| Capacity safety stop | DB/WAL footprint or free-space guard stayed breached. | Stop capture, add verified capacity or execute an approved archival plan; do not weaken the limit. |
| Raw/parsed correlation or pending-frame overflow | Exact Order index fidelity is no longer trustworthy. | Preserve session as invalid, restart only after root-cause review; wait for a fresh complete L2 snapshot. |
| `raw order-book capture lost canonical integrity` (distinct from correlation loss above) | A correctly-correlated Order-v2 event still failed canonical normalization (e.g. a genuinely missing/invalid required field). The log line now includes the actual `reason`/`missingFields`, not just the symbol. | Read the reason/missingFields in the log directly; a `MISSING_OR_INVALID_REQUIRED_FIELD` for a real, previously-unseen field combination is worth a code review, not just a restart. |
| `migration ... stopped at N instead of M` | An offline migration chain did not reach the current schema version. | Do not run the live writer. The store is left on the last version the chain actually reached; fix the migration chain before retrying. |
| `storage-lock: gave up acquiring ... after N attempts` | The lock file exists but its owner could not be read at all (permissions, or another process holding the handle on Windows). | Inspect the `.lock` file and its owning process directly. Never delete it to make startup pass. |
| Provider/auth/channel disconnect | Current token session is no longer trustworthy. | Let the collector fail closed; inspect the redacted reason and provider status before a supervised restart. |
| Continuity audit exit 2 | A transaction or snapshot ended unresolved. | Mark the interval unsuitable for gapless L2 replay and investigate raw rows/session boundaries. |

## Backup and restore acceptance

`npm run backup:manual` snapshots both provider stores and uploads the snapshot
first, then its `COMPLETE` manifest as the remote commit marker. Local artifacts
remain on failure. A backup is not accepted until an operator has:

1. downloaded the exact snapshot/manifest pair to a separate restore path;
2. matched its SHA-256 and byte length to the manifest;
3. run the offline integrity verifier against the restored dxFeed file;
4. opened the restored file read-only and verified schema v22 and recent capture
   lineage; and
5. recorded the restore date, host, artifact identity, and result.

Never test a restore by overwriting the live database.

## Deployment acceptance checklist

- [ ] Live database backed up and restore-tested.
- [ ] Offline migration reports schema v22.
- [ ] Offline `quick_check` passes.
- [ ] Previous-day L2 continuity result reviewed.
- [ ] Synthetic capacity gate passes on the deployment machine.
- [ ] Current dated `/ES` and `/NQ` contracts verified before market open.
- [ ] Real token entitlements prove all 16 configured capture cells.
- [ ] Multi-hour supervised live soak has no rejects, gaps, non-monotonic IDs,
      checkpoint failures, capacity breach, or unexplained exit.
- [ ] Physical disk-pressure and abrupt-power-loss recovery drills completed on
      disposable/restored data, never the only live copy.
- [ ] Alert delivery and process-supervisor restart policy verified.

Until every item is recorded, the collector is code-qualified but only
conditionally accepted for deployment.

## Operator-facing behaviours worth knowing

**Collector signal handling.** Signal handlers are installed *before* any
synchronous database bootstrap, so a signal arriving during that stage is
handled through the normal stop path as soon as it returns rather than taking
the default abrupt exit.

**Integrity verification holds the collector's lock.** `verify:storage-integrity`
and its dxFeed twin take the same exclusive ownership lock as the collector for
the whole scan. That reclaims a stale crash lock, rejects a live collector, and
closes the check-then-open race a simple `existsSync()` guard would leave open.

**Backups commit last.** `backup:manual` uploads the manifest last, and the
manifest is the remote commit marker — a snapshot without its `COMPLETE`
manifest is intentionally incomplete rather than ambiguously partial.

**Heartbeat liveness.** The heartbeat advances its marker whenever the interval
fires, even if collection or rendering throws, so a probe failure is not
misreported next minute as a scheduler stall. The dxFeed collector's liveness
keys are `quotes`, `trades`, `timeAndSales` and `orderBookCapture` — the last
replaced the retired `orders` counter in Phase 21, which would otherwise have
left the only surviving Order path unwatched.
