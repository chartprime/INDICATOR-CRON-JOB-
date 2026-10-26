# dxFeed Storage Layer Contract v1

This contract defines the dedicated `dxfeed-market-data.sqlite` store. The
executable authority is the SQLite DDL, offline migrations, layout/index
verification, boundary validation, and tests. The store is separate from
Binance so the writers do not share locks, WAL growth, migrations, or failure
domains.

## Ownership and schema

Exactly one dxFeed writer may own a database path. The service acquires
`<dbPath>.lock` before opening SQLite, rejects a second live writer, recovers a
stale lock only after its recorded process is proven absent, and releases only
its own token. Read-only readers may run concurrently.

Schema version 21 contains:

| Table | Purpose |
|---|---|
| `dxfeed_quotes` | Canonical Quote events. |
| `dxfeed_trades` | Canonical conflated Trade/latest-state evidence. |
| `dxfeed_time_and_sales` | TimeAndSale prints including correction, cancellation, spread-leg, and validity evidence. |
| `dxfeed_candles` | Locally materialized closed one-minute OHLCV bars. |
| `dxfeed_order_book_capture` | Exact-index, flagged Order-v2 reconstruction input. |
| `dxfeed_capture_sessions` | Start/end, clean-shutdown, termination, and quality lineage. |

> **`dxfeed_orders` retired at schema v20 (`L1L2-V2-039`).** It held a
> *strictly lossier* duplicate of `dxfeed_order_book_capture` from the same
> Order-v2 stream: no `event_flags`, no `action_time`, and `order_index`
> coerced to `INTEGER`, destroying the 64-bit identity the capture table
> preserves as `TEXT`. Measured on the live database, capture held more rows
> than it for **every** symbol over an identical time span, so nothing unique
> was stored there. Order events now feed the capture path only. The schema no
> longer creates or requires the table; **an existing database keeps its rows
> until an operator drops them deliberately** — migration does not delete data.
| `dxfeed_order_book_continuity_audits` | Per-day, per-symbol/source L2 transaction-continuity results. |

Canonical tables share event and receipt times, provider, venue, asset class,
symbol, stale state, and recovery state. SQL constraints restrict provider to
`DXFEED`, asset class to `FUTURE` or `EQUITY`, and booleans/enums to their
declared values. Optional provider integers must be null or safe non-negative
integers.

TimeAndSale also stores `time`, `time_nano_part`, `sequence`, exchange and
aggressor evidence, event kind, and provider index/trade ID. Unsafe 64-bit JSON
numbers become null; safe ordering fields remain available.

The `baseline_log_median`, `baseline_log_mad` and `baseline_sample_count`
columns still exist but are **no longer written** (`L1L2-V2-084`): the
statistical large-trade detector that consumed them was removed in Phase 15,
and the per-trade estimator plus three expression indexes it required were pure
cost on the ingest path. The columns are retained rather than dropped because
removing one from a 40 GB table is a full table rewrite that buys nothing. Rows
written from schema v20 onward carry `NULL` in all three.

Candles contain aligned `ts_open`, OHLC, total volume, nullable buy volume, and
trade count. Null buy volume means at least one included print could not be
classified safely; it never means zero. Readers resolve duplicate
materializations by greatest trade count and then newest insertion.

`dxfeed_order_book_capture` preserves the raw JSON spelling of the bounded
unsigned Order index plus flags, action time, source, scope, and reconstruction
fields. A removal-flagged structural event may omit unusable values; non-removal
rows remain strict. The replay order is arrival order: `id` within
`(symbol, asset_class, source)`. An Order row's `event_time` is the order's own
`time`, so a removal carries the time of the order it removes and `event_time`
is not monotone within one order's history; sorting by it would move a removal
ahead of the changes that preceded it. `received_at` is monotone in `id` and
selects a replay window; the replay clock is the running maximum of
`event_time`. The index `idx_dxfeed_order_book_capture_arrival` on
`(symbol, asset_class, source)` carries `id` implicitly, so one pair's
arrival-order window is an index seek rather than a scan of every symbol's
rows. The replay source uses it when present and falls back to the table scan
on a capture built before it. Writers require it: an existing capture gains it
from the offline migration (`migrate-dxfeed-storage-schema.js`) before the
first writer on the new release starts.

## Write semantics

Incoming dxLink data is normalized first. The storage service independently
checks exact envelope/payload fields, identity, configured symbol/asset-class
pair, venue, timestamps, enums, and event-time agreement.

Structural Order removals are routed only to `dxfeed_order_book_capture`.
`dxfeed_orders` stores no event flags, so a removal written there could not
be told apart from a resting order; the collector filters removals out of
that path and counts them as filtered rather than degraded.

- A canonical or exact-index batch may contain at most 2,000 envelopes.
- Every accepted batch commits in one transaction; one malformed item rolls
  back the batch.
- Oversized provider FEED_DATA arrays are fatal before normalization/storage.
- Degraded canonical envelopes are counted and skipped. A healthy envelope
  rejected by storage is an internal contract failure and stops capture.
- Any candle write failure is fatal; raw capture never continues while derived
  storage silently falls behind.

The collector and live L2 servers install a raw WebSocket interceptor before
JSON parsing. It FIFO-correlates raw Order indexes to parsed FEED_DATA for the
selected channel. Pending frame count/bytes are bounded; correlation loss is
fatal to capture and invalidates the served book.

Canonical tables are append-only. Quote and Trade lack natural event IDs;
Order index represents mutable state rather than a unique event; TimeAndSale
identifiers may be missing or precision-unsafe, so no false uniqueness is
asserted.

**No dxFeed table carries a uniqueness constraint, and every insert is a plain
`INSERT`.** That is deliberate, and the obvious "make it match Binance" fix is
actively wrong. A duplicate scan over 500,000 TimeAndSale rows found four keys
colliding on `(symbol, asset_class, time, sequence, time_nano_part)` and **none
was a duplicate**: each was a `NEW` row paired with a `CANCEL` about 34 minutes
later, which is dxFeed's bust protocol. A
`UNIQUE (symbol, asset_class, time, sequence) ON CONFLICT DO NOTHING` would
have silently discarded every cancellation and correction the feed sent. Any
constraint added here must carry `event_kind`.

**What this means for a direct reader.** `dxfeed_candles` is the cleaner case
— 8,535 rows, zero duplicates in practice, and nothing enforcing it. The
storage *reader* already compensates: `mergeCandleRowSets` dedups on `ts_open`,
preferring the higher `trade_count`. So duplicates were anticipated and handled
at read time, and any consumer that queries the table directly rather than
through the reader gets them unfiltered.

### A minute's candle volume and its raw tape volume can differ

The collector persists raw prints **before** bar aggregation, and the
aggregator drops an out-of-order in-window print outright
(`OUT_OF_ORDER_TRADE`, `dxfeed-bar-aggregator.js`). A print that arrives after
its own minute has advanced is therefore durable in the raw table but absent
from that minute's candle.

This matters because the two are read by different things. The chart reads
candles; Volume Profile and VPIN read the raw table. **Same minute, two
legitimate volume totals**, and nothing in either output says so. Neither
number is wrong — the candle reflects prints in order, the raw table reflects
everything received — but they answer different questions and should not be
reconciled against each other. Frequency is unquantified: measuring it needs
live capture, which sits under the standing dxFeed connection constraint.

Futures and equities both use non-conflating STREAM TimeAndSale. Futures require
valid `NEW` ticks for derived flow; equities accept valid fractional-share NEW
prints even when `validTick:false`. Raw Trade stays durable latest-state
evidence and never drives candles, tape, or markers. Corrections/cancels remain
durable but do not revise bars. Unknown aggressor side retains OHLCV while
making directional volume unavailable.

## Schema lifecycle

The live writer is validate-only. It requires exactly one version row at v21,
exact required table layouts, and all 15 required indexes. It does not migrate,
run `quick_check`, scan historical Order-v2 rows, quarantine corruption, or
create a replacement database. An invalid/corrupt store fails closed with its
database and sidecars preserved for investigation.

Exclusive offline migration is transactional:

- v1-v2 removes invalid Order-index uniqueness.
- v2-v3 adds candles; v3-v4 adds TimeAndSale; v4-v5 adds Order-v2 capture.
- v5-v6 permits legitimate zero-price `TRADE`/`BUST` indexed actions.
- v6-v7 adds stable source-aware replay order; v7-v8 adds optional bid/ask.
- v8-v9 preserves legal structural removals without weakening normal rows.
- v9-v10 adds capture-session lineage and invalidates unfinished predecessors.
- v10-v11 adds the L2 transaction-continuity ledger.
- v11-v12 adds baseline median/MAD.
- v12-v13 adds causal `baseline_sample_count` and the qualifying-marker index.
- v13-v14 permits legitimate zero-price generic `TRADE`/`BUST` Order rows.
- v14-v15 permits a `TRADE`/`BUST` exact-index Order-v2 row to omit `time`
  entirely (previously only price was relaxed for these actions; a real
  captured `TRADE`/`BUST` event can also carry no usable provider timestamp).
- v15-v16 extends the same `time` relaxation to the generic `dxfeed_orders`
  table, closing an equivalent gap that independently existed there.
- v16-v17 adds the TimeAndSale covering index used by VPIN warm-up.
- v17-v18 adds fixed-floor detector indexes; v18-v19 removes those and the
  retired z-score index after the detector changed.
- v19-v20 retires the generic `dxfeed_orders` path from the current schema;
  v20-v21 removes its two now-unused indexes without deleting retained rows.

Migration is transactional and asserts its own outcome: if a chain ends on
any version other than the current one, startup fails rather than reporting
success on a partially migrated store.

After a stopped collector, the required deployment order is: verified backup,
offline migration, offline integrity verification, any required backfill/audit,
then live writer startup. Every tool acquires the same exclusive process lock.

## Capture and control-plane proof

`verify-dxfeed-storage-capture.js` requires Quote/Trade/Order/TimeAndSale for all
four configured instruments (16 cells), exact Order-source routing, storage
acceptance, and matching physical count deltas. Silence or zero delta cannot
pass.

Capture sessions persist quality. Any unfinished predecessor becomes `INVALID`.
Planned rotation is `HEALTHY` only if there were no skipped/rejected cells,
trade-ID continuity issues, or WAL checkpoint busy/failure evidence. Signals
produce a clean but `DEGRADED` interrupted boundary. Unexpected transport,
storage, correlation, capacity, or cleanup failure is fail-closed.

The checkpoint is non-blocking PASSIVE maintenance. Its run count, busy result,
log/checkpointed frames, and failures enter heartbeat telemetry. Persistent disk
capacity pressure stops capture after the declared grace interval.

## Performance gate

`qualify-dxfeed-storage.js` drives the real storage service with all four event
families plus exact Order-v2 across every configured instrument. Default gates:

- 5,000 sequences per instrument and 100 sequences per batch.
- 100,000 total durable rows.
- At least 5x a declared 1,000 rows/second nominal load.
- Batch p99 and event-loop-delay p99 below 250 ms.
- RSS growth below 512 MiB.
- Exact physical counts, clean sequential TimeAndSale identity, healthy capture
  lineage, zero rejects/skips/gaps/non-monotonic IDs, and `quick_check=ok`.

`--existing-db <path>` adds read-only metadata/timing evidence but never writes
to that database. Synthetic results qualify the tested machine and build, not
provider delivery or future sustained production volume.

## Boundaries

- An unexpected transport drop fails closed; there is no in-session reconnect.
- Static dated futures require an operator rollover before expiry.
- No retention, rotation, or archive tier exists; accepted rows remain in the
  live database indefinitely.
- Off-host replication is a manual `backup-to-drive.js` operation and is not
  production-accepted until a restore is verified.
- Manual interruption can split a minute. Raw events remain authoritative until
  correction/restart-aware candle replay exists.
- Only `dxfeed_order_book_capture` may seed L2 reconstruction. A capture fault,
  source mismatch, crossed book, `SNAPSHOT_SNIP`, or incomplete transaction
  invalidates the view until a fresh complete snapshot.
- Quote and Trade under AUTO are latest-state feeds, not lossless tapes.
- Unit/load tests do not substitute for live entitlement, long-soak, physical
  disk exhaustion, power-loss, and restored-backup acceptance drills.

These are explicit production boundaries, not properties hidden by the API.
