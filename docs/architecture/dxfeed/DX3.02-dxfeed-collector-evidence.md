# DX3.02 dxFeed Collector Evidence

> **Historical implementation evidence.** This dated page records the result
> of a completed build or audit. It is not a current deployment/health
> statement; use the handbook and final-state overview for supported operation.

`run-dxfeed-collector.js` is a manually started, realtime-only capture process
for the four approved instruments. It is isolated from the Binance collector
and uses the dedicated schema-v16 dxFeed database.

## Files

- `apps/runtime/scripts/collect/run-dxfeed-collector.js` — the collector process itself
- `apps/runtime/src/providers/dxfeed/dxfeed-token-lifecycle.js` — the shared shutdown-deadline math backing the five-minute-before-expiry arming below
- `apps/runtime/src/providers/dxfeed/dxfeed-trade-adapter.js` — `tickDirection`/`aggressorSide` → bar-side mapping, fail-closed trade-ID synthesis (see "Capture policy" below)
- `apps/runtime/src/providers/dxfeed/dxfeed-order-v2-capture.js` — the raw-frame correlator behind `dxfeed_order_book_capture`

```text
private token broker
  -> exact expiresAt forwarded in memory
  -> fail-closed token deadline
  -> dxLink authorize/open
  -> 16 subscriptions
  -> canonical transactional storage + exact-index Order-v2 capture
  -> local closed one-minute bars
  -> bounded cleanup and exit
```

## Lifecycle guarantees

- Clock, token, expiry, endpoint/mode, storage ownership, connection, and
  handshake failures stop before a false running state is published.
- The broker expiry is mandatory and bounded; shutdown is armed before network
  setup and occurs five minutes before authoritative expiry.
- Signal, deadline, channel error, connection loss, malformed batch, canonical
  rejection, candle write failure, and monitor failure converge on one
  idempotent cleanup path with accurate exit status.
- Authorization/channel waits cannot miss immediate transitions and are
  abortable. Listener, channel, connection, monitor, storage, and lock cleanup
  are attempted independently.
- **Planned token rotation (DX3.17, 2026-08-27)**: at the five-minute
  safety deadline, the collector closes its authenticated session and exits
  with a reserved rotation status. `run-with-dxfeed-token.js` obtains one
  fresh token and starts the next collector only after the prior child exits.
  This replaces the live-rejected same-WebSocket second `AUTH` path, which
  caused the SDK to re-request an existing channel ID. A planned-exit status
  before five minutes of child uptime fails closed instead of fetching another
  token, so malformed startup cannot create a rapid broker loop. The capture
  window is bounded and explicit. Unexpected transport drops remain fatal;
  there is no reconnect loop for them.

## Capture policy

- Quote, Trade, and source-qualified legacy Order rows are stored for all four
  instruments. The same Order feed is also raw-frame correlated and persisted
  to `dxfeed_order_book_capture` with exact index text and event flags.
- TimeAndSale is stored for all four instruments under STREAM.
- Futures Trade remains latest-state evidence only. Futures derived bars use
  valid NEW TimeAndSale with real aggressor semantics.
- Equity and futures bars use NEW TimeAndSale under STREAM. Futures require
  `validTick`; equities deliberately do not, because real fractional-share
  fills are routinely marked `validTick:false`.
- Corrections, cancels, spread-leg status, invalid ticks, and unknown
  aggressors remain raw/canonical evidence. Only valid NEW prints enter bars;
  unknown side leaves buy volume unavailable but does not remove OHLCV.
- Unknown cells and wrong Order sources are counted and filtered. Degraded
  envelopes are counted and warning-deduplicated. A healthy storage rejection
  is fatal.
- Heartbeat activity includes Quote, Trade, Order, and TimeAndSale progress.

## Durability and capacity

Each received provider batch is one SQLite transaction. A token-owned
single-writer lock prevents two collectors from appending to the same file.
Schema/layout/quick-check validation runs before writes. The live capture proof
requires all 16 cells and independent physical count deltas.

The write path is synchronous in this bounded process. It has no unbounded
application queue, but it also has no worker-thread isolation comparable with
the Binance collector. Sustained capacity must be established on the target
host with real volume before changing the bounded operating model.

## Declared limitations

- Planned token rotation is automatic through the launcher; unexpected
  transport failures deliberately stop the process. There is no retention,
  rotation, or archival step (see
  `docs/architecture/storage/storage-pipeline-evidence.md`); every accepted row stays in the single live database
  indefinitely. Capture-session lineage is durable. Off-host replication now
  has a concrete, manual tool (`apps/runtime/scripts/maintain/backup-to-drive.js`,
  shared with Binance) rather than being purely a deployment control; alert
  delivery remains a deployment control.
- Static dated futures symbols require quarterly rollover.
- Arbitrary manual restarts can split a candle minute; raw events are the
  reconciliation authority.
- Equity Trade/AUTO may conflate prints.
- `dxfeed_orders` (retired at schema v20, `L1L2-V2-039`) was not a
  reconstructable DOM/L2 book; the separate Order-v2
  capture is. A raw-frame correlation failure terminates the collector rather
  than silently continuing with an unverifiable L2 stream.

The full runtime suite, real temporary SQLite integration tests, frontend
suite, production build, lint, schema JSON parse, and `git diff --check` are
the non-live audit gates. A real broker/session acceptance run remains a
deliberate operator action.
