# Build brief: L1 parity for browser-direct Binance (`build/browser-direct-l1`)

2026-10-26. Browser-direct mode had no frame the runtime *derives* from the
tape (`marker`, the aggressive pool, `aggressive_history`, `marker_history`), so
Large Trade Detector drew its legend and no bubbles. This build computes them in
the worker with the runtime's own algorithms, proven equal by parity tests that
`require` the runtime's CommonJS modules on the same 10,000 recorded trades.

## 1. What the runtime derives from trades, and who reads it

There is no "baseline" for Binance markers (`baseline_log_*` are dxFeed storage
columns). `history.js` retains, per minute and side, the four prints of largest
**USD notional**, ties by time then id, 100,000 at most, seven days; a `marker`
follows the admitted `trade`; the snapshot carries the newest 5,000;
`marker_history` (opt-in) the full set, 5,000 rows a frame. The pool keeps
prints at or above a floor (98th percentile of the last 4,096 sizes once 200
are seen, never falling), 4 hours, 20,000 at most, on the snapshot as
`aggressive_prints*`; `aggressive_history` answers from storage, 10,000 a page.

| L1 indicator | Reads | Browser-direct before | Added by this build |
|---|---|---|---|
| Aggressive Order Flow, Delta Divergence, CVD Divergence, Market Structure Delta, FVG Delta, FVG Boxes, L1 Order Blocks, Volume Profile OHLC | bars via `barSides` | works | nothing |
| Large Trade Detector | `markers` (snapshot, `marker`, `marker_history`) and bar `trade_count` | legend only | live markers; bootstrap markers; `marker_history` |
| VWAP Bands, Large Trade Bubbles (tick store) | `ctx.ticks` / `ctx.trades`: live tape plus `aggressive_prints` and `aggressive_history` | live bars only (`coverageOf` "none" before connect) | pool in the snapshot; `aggressive_history` from the pool |
| Live Delta Profile, Volume Profile (Ticks) | live trades plus `delta_profile` (every trade, per price row) | forming window only | nothing: the pool is floor-filtered; reply stays `STORAGE_UNAVAILABLE` |
| VPIN Cloud | `vpin` frames (server study) | unavailable | nothing: `vpin_status: "DISABLED"` |

## 2. Shared algorithm: approach (a)

The runtime modules are CommonJS and the Vite build cannot import
`apps/runtime`. Pure TypeScript mirrors live in `apps/web/src/lib/tape/`:
`largeTradeDetection.ts` (line for line with `large-trade-detection.js`) and
`aggressivePool.ts` (`createAggressivePool`, `print-floor.js`, `floorAbove`).
Marker retention reuses `lib/chart/markerRetention.ts`, already the browser
mirror of `history.js`'s time-covered path. `workers/tests/tapeParity.test.ts`
`require`s the runtime files (vitest runs in Node) and asserts identical
output on 10,000 recorded BTC-USDT aggregate trades: every helper result,
every admit decision, the marker set, the pool's prints, floor and `from`.
Runtime code is not touched.

## 3. Markers

Every live `trade` goes through the marker buffer; an admitted print goes out
as a `marker` right after it. Bootstrap: after the first snapshot, alongside
the stream, the worker pages `GET /api/v3/aggTrades?limit=1000` from the
mirror, newest first by `fromId`, at most 30 pages (weight 4 each, 120 of the
6,000 per minute budget, one 10 s timeout per page), stopping at a short page
or seven days. Rows are aggregate trades: id `a<aggTradeId>` (a separate id space
from the stream's `t`), size the summed fills of one taker order at one price,
so a bootstrap marker can be larger than any single print the runtime saw.
Then the `snapshot` is re-broadcast (closed bars, last 100 live trades, newest
5,000 markers, the pool), as the runtime does after a warm-up chunk, and the
forming bar re-sent. The runtime's baseline is seven days of storage; the
browser's is what 30 pages cover (about twenty minutes on BTC-USDT, hours on
a quiet pair). The detector's `top N%` target counts the snapshot bars' `trade_count`
(15 hours), so a short bootstrap leaves the selection `truncated`; the legend
appends ` · partial`.

## 4. Aggressive pool and `aggressive_history`

The pool is the runtime's: live trades `record`; bootstrap pages are staged
until the stream's first trade is known (or a 2 s grace), reconciled against
every live span by fill id (`f`/`l`), then `seed`, the newest 15 minutes with
`calibrate: true`, older rows at the floor. Coverage is explicit: the
transport keeps every stretch of tape observed in full (validated
id-contiguous pages, each stream span first-to-last trade, ids at the ends)
and claims only inside one, minus milliseconds whose aggregates straddle a
span boundary; the REST-to-stream seam and reconnect holes are filled from
`aggTrades` (by id after a REST row, else `startTime`, 10 pages, three tries)
or stay holes; the bookkeeping is pruned to the pool's 4 h and bounded. A
stream lost after trades closes the transport, as a lost runtime socket
would: the worker reports `closed` (the tick store ends its live stretch,
`AggressiveTape.endLive`) and reconnects to a new instance that keeps the
pair's tape state. `aggressive_prints_from` is the start of the stretch
reaching now, or now itself (no claim) while no stream delivers. A page with
a malformed row is a failed read, never a shorter page. `aggressive_history` is answered from the pool: `complete: true`
when the window lies inside one observed stretch and `min_size >= floor`,
trades in time order, 10,000 a page with `CAP_REACHED` and a base64url cursor (`{ts, id}` bound to the
request); otherwise `complete: false`, `reason: "STORAGE_UNAVAILABLE"`,
`trades: []`, which the client retries three times and then rests, as today.

## 5. `marker_history`

With the `capabilities` flag set (the worker always sends it), the bootstrap's
completion, a later opt-in and a connect with kept state each send the full
marker set as `marker_history` frames, `reset` on the first, 5,000 rows each.

## 6. Degraded states

A failed first page is retried with the stream's backoff; after three failures
the READY health frame carries `reason: "BROWSER_DIRECT_NO_TAPE_HISTORY"`,
markers and the pool start at connect, retries continue (a later success
publishes the snapshot and restores `BROWSER_DIRECT`). A failure after some
pages keeps the pages validated before it.

## 7. Unavailable, with reason

`delta_profile`: `STORAGE_UNAVAILABLE` (needs every trade; the pool is floor
filtered). VPIN: `vpin_status: "DISABLED"`.

## 8. Round log

- Round 1 (`c0059df`): markers, pool, `aggressive_history`, `marker_history`,
  parity tests, docs, bundle.
- Round 2 (`370c53c`): explicit observed stretches; seams between the REST
  pages and the stream, and between streams, filled from `aggTrades` or left
  outside every claim; a page with a malformed row is a failed read.
- Round 3 (`1136823`): a stream lost after trades closes the transport like a
  lost runtime socket (`AggressiveTape.endLive` on `status: closed`, tape
  state kept across instances); REST rows reconciled by fill id; staged
  bootstrap commit; bookkeeping pruned to the pool's retention.
- Round 4 (final exception): a one-trade span is reconciled against both id
  boundaries; the bootstrap's oldest millisecond is claimed only when the walk
  reached the exchange's first aggregate trade; completeness ends at the last
  trade seen, never in the future.
