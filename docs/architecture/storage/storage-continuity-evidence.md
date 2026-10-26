# Storage Continuity and Gap Detection

> **Historical implementation evidence.** This dated page records the result
> of a completed build or audit. It is not a current deployment/health
> statement; use the handbook and final-state overview for supported operation.

How the storage layer knows what it might be missing, for both
providers. Each mechanism below is protocol-specific — none of them
are a copy of another — because Binance depth, Binance trades, dxFeed
trades, and dxFeed order-book events each expose a different kind of
sequence guarantee (or none at all).

## Files

- `apps/runtime/src/storage/storage-gap-audit.js` — Binance yielding L2 continuity verification and the daily per-pair depth-continuity ledger
- `apps/runtime/src/storage/archive-schedule.js` — shared UTC day-boundary helper (`dayStartMs`) used by both providers' continuity scans
- `apps/runtime/src/storage/storage-service.js` — Binance trade-ID continuity classification (SPOT vs PERPETUAL)
- `apps/runtime/src/storage/dxfeed/dxfeed-storage-service.js` — dxFeed trade-ID continuity tracking
- `apps/runtime/src/storage/dxfeed/dxfeed-gap-audit.js` — dxFeed order-book transaction-continuity audit

## Binance depth-continuity ledger

The daily depth-continuity ledger is a lightweight breadcrumb, not a
retention mechanism. Rows are never deleted from the live table, so the
ledger's job is purely to give a fast, durable per-day anchor for
continuity checks without re-scanning the whole table on every restart.
Once a day, the writer worker scans the previous UTC day's L2 sequence
chains and persists a per-pair ledger row: `CLEAN`, a gap count, or an
explicit `NO_DATA` state — never a fabricated clean result for a day
with no rows. The scan uses time-first indexes rather than a full
market-partition scan and runs in the writer worker, not on the
WebSocket event loop. Until its first completed live audit, health
reports `gapAuditStatus: NOT_RUN`, never a false zero-gap result.

## Binance trade-ID continuity

Trade continuity has explicit evidence boundaries. The first trade for
a pair in a new process is compared with the prior session only to
report an inter-session coverage gap; planned downtime does not
invalidate the newly started capture session. In-session SPOT
raw-trade-ID gaps, accounted local overflow, route clearing, and depth
recovery gaps degrade the affected capture segment and remain
queryable for exclusion or reconciliation. PERPETUAL provider
trade-ID discontinuities are counted separately because the subscribed
provider stream does not establish a contiguous-ID completeness
contract; they are not presented as proven local queue loss.
Unaccounted event drops and writer failure remain invalidating for
both markets.

## dxFeed trade continuity

`dxfeed-storage-service.js` tracks `provider_trade_id` per
symbol/asset-class live, in-stream, mirroring Binance's own trade-ID
gap counters — but honestly scoped to what dxLink's transport can
actually guarantee: dxLink's JSON-number transport loses precision on
large `index`/`tradeId` values, and the normalizer nulls them out when
that happens. The counter set reflects this directly:
`tradeIdGaps`/`missingTradeIds` for a real detected gap between two
safe values, `tradeIdNonMonotonic` for a repeated or decreasing value,
and a distinct `tradeIdUnavailable` for every event where the
identifier simply wasn't safe to compare — never silently folded into
"no gap."

## dxFeed order-book continuity

dxFeed's Order-v2 stream has no first/last-update-ID range the way
Binance depth deltas do — `order_index` is a per-order key, not a
sequence counter, so "count the missing IDs" doesn't map onto the
protocol at all. The real, protocol-correct signal is transactional:
`dxfeed-gap-audit.js`'s `auditOrderBookTransactionContinuityDay` scans
each day's raw `dxfeed_order_book_capture` rows per (symbol, asset
class, source) and checks whether a `TX_PENDING` transaction or an
open `SNAPSHOT_BEGIN…SNAPSHOT_END` pair was ever left dangling at the
end of the day's captured rows — a genuine, protocol-meaningful signal
that the capture was cut off mid-transaction (a restart, a blip),
recorded per day in the `dxfeed_order_book_continuity_audits` table
(schema v12) as `CLEAN` / `INTERRUPTED` / `NO_DATA`, never a
fabricated clean result for a day with no rows.
