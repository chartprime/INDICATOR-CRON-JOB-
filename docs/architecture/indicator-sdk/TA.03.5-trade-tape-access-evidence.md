# Trade Tape Access & Proof-of-Concept Indicator (TA.03.5)

> **Historical implementation evidence.** This dated page records the result
> of a completed build or audit. It is not a current deployment/health
> statement; use the handbook and final-state overview for supported operation.

`ctx.bar` (TA.01) gives an author one candle's OHLCV summary -- a single
whale trade and a hundred small trades can produce an identical bar,
same total volume, same buy volume, even the same trade count. This
ticket adds `ctx.trades`: the individual trades that occurred during the
current chart bar, alongside it. Not the order book -- the tape, not the
book.

## The scope decision, made here, not deferred

Live trades already reach the browser (`market-data-server.js` broadcasts
every trade for the active symbol; `useMarketData.ts` already listened
for them -- previously only for an unrelated 60-row "recent trades"
ticker). Historical trade depth does not: a snapshot's trades are capped
at the last 100 raw trades (`history.js`, `DEFAULT_MAX_TRADES`),
decoupled from the 10,080-bar OHLCV retention, and full trade history
lives in SQLite (confirmed 78.8M live rows for Binance) with no
query-by-time-range path today. **`ctx.trades` ships correctly for live
bars going forward only.** Every bar touched by a full replay (warm-start,
`REBUILT`, a recompute-tagged settings change) gets `ctx.trades = []` and
`tradeAvailability: "HISTORICAL_UNAVAILABLE"`, honestly. Building a
historical-backfill query endpoint is real, separate, deferrable work --
not built speculatively here.

## `tradeAvailability`: distinguishing absence from ignorance

`ctx.trades` being empty is ambiguous on its own -- a genuinely quiet bar
and a bar whose trade record is incomplete or unavailable both look like
`[]`. `IndicatorBarCtx.tradeAvailability` disambiguates:
`"LIVE_COMPLETE"` (a full, live-observed trade set for this bar),
`"LIVE_PARTIAL"` (live, but a bounded buffer overflowed or a stale record
was evicted before this update), or `"HISTORICAL_UNAVAILABLE"` (replay,
or before activation). An indicator deriving a real signal from
individual prints must gate on this before treating `[]` as "no trades
happened" -- `largeTradeBubblesIndicator` does exactly that.

## Files

- `apps/web/src/lib/chart/indicatorTypes.ts` -- `IndicatorBarCtx` gains
  `trades: readonly TradeFrame[]` and `tradeAvailability?: TradeAvailability`.
- `apps/web/src/lib/chart/indicatorRuntime.ts` / `replayBars.ts` -- both
  thread `trades`/`tradeAvailability` through to `onBar`, defaulting to
  `EMPTY_TRADES`/`"HISTORICAL_UNAVAILABLE"` so the ~40 pre-existing calls
  in `indicatorRuntime.test.ts` need no mechanical update.
- `apps/web/src/hooks/useMarketData.ts` -- the actual correlation, keyed
  by source-bar `ts_open` in `correlatedTradesByOpenTime` (a `Map`, not a
  one-shot buffer): every dispatch for a given bar hands the indicator
  the **complete observed trade set for that bar so far**, not just the
  increment since the last animation frame -- a bar updated many times
  before it closes must not have its earlier prints silently overwritten
  by a later, smaller increment. Bounded three ways: a per-source-bar cap
  (`MAX_TRADES_PER_LIVE_SOURCE_BAR`), a global pending-correlation cap
  (`MAX_PENDING_TRADES_FOR_BAR_CORRELATION`) whose overflow is tracked by
  timestamp so the *specific* affected bar can still be marked
  `LIVE_PARTIAL` rather than every bar universally, and a bounded
  retention of the most recently **closed** bars' trade records
  (`MAX_RECENT_CLOSED_TRADE_SOURCE_BARS`) so a late duplicate close still
  finds its true trade history rather than an empty one. A separate
  bounded set (`evictedTradeBarOpenTimes`) remembers which bars have had
  their record evicted, so a duplicate-close arriving *after* that
  eviction is honestly reported `LIVE_PARTIAL` rather than a
  false-precise `LIVE_COMPLETE` zero -- found and fixed during this
  ticket's own closure audit (below).
- `apps/web/src/components/chart/Terminal.tsx` -- unions each resampled
  bucket's (5m/15m/1h/4h/...) trades from its constituent 1m source bars'
  records (`sourceBarTradesRef`), not merely the one raw source bar that
  triggered the current update -- a 5m candle's `ctx.trades` reflects the
  whole 5 minutes, not the last one. Retention of these per-source-bar
  records is **sized dynamically off the selected display timeframe**
  (`requiredSourceBarsForDisplay + headroom`, floored at a lean default),
  not a single flat constant -- a flat cap sized for small timeframes
  cannot also cover a 1D bucket's 1,440 constituent 1-minute bars; this
  was a real, found-and-fixed gap (below).
- `apps/web/src/lib/indicators/large-trade-bubbles/largeTradeBubbles.ts`
  -- the proof-of-concept, registered for real (`indicatorRegistry.ts`,
  category `"community"`). A simplified version of the real Large Trade
  Detector: a 20-bar rolling median/MAD baseline of each bar's own largest
  trade magnitude. Binance magnitude is USD notional; dxFeed futures
  magnitude is contracts, because no contract multiplier is available in
  this browser contract. The baseline is built only from prior *completed*
  `LIVE_COMPLETE` bars. For every individual trade in `ctx.trades` that
  clears the settable multiplier (default 3x), a `ctx.markers.plotshape` circle
  drawn directly **at that trade's own price**
  (`position: "atPriceMiddle"`, `price: trade.price`) on the main chart,
  sized by how far past the threshold it is and colored by buy/sell side
  -- not a subpanel oscillator with one arrow per bar. It emits no numeric
  series, so trade magnitude cannot alter the chart price scale. A bar with
  no trades is skipped rather than fed a zero, any bar whose
  `tradeAvailability` is not `"LIVE_COMPLETE"` is declined outright, and
  a busy bar is capped at its 50 largest qualifying prints.

## Two real defects found and fixed during this ticket's own closure audit

Both were found by a fresh, adversarial line-by-line re-read of the
already-hardened implementation, after `npm run check` was already fully
green. Neither was caught by the test suite that existed at the time.

1. **A duplicate close for an already-evicted bar read back as a false
   `LIVE_COMPLETE` zero.** `useMarketData.ts`'s eviction of a closed bar's
   trade record (after `MAX_RECENT_CLOSED_TRADE_SOURCE_BARS` newer bars
   close) also deleted the "this bar was ever partial" flag, so a late
   duplicate-close arriving afterward had no signal left to distinguish
   "genuinely zero trades" from "we no longer remember." Fixed with a
   dedicated bounded set (`evictedTradeBarOpenTimes`) that outlives the
   shorter eviction window and permanently marks any later dispatch for
   that bar `LIVE_PARTIAL`. Mutation-tested: reverting the check causes
   the regression test (`useMarketData.test.tsx`, "marks a duplicate
   close for an already-evicted bar...") to fail exactly as expected.
2. **`ctx.trades` could never reach `LIVE_COMPLETE` on the 4h, 6h, 12h,
   or 1D timeframes.** `Terminal.tsx`'s per-source-bar trade retention
   was a flat 120-bar cap; a 1D bucket needs 1,440 constituent 1-minute
   bars, 4h needs 240 -- both permanently exceed a flat 120 no matter how
   long the app runs live. Fixed by sizing retention off the actually
   selected timeframe (with a small headroom margin and a `while`-loop
   eviction so a cache built up under a large timeframe can drain back
   down promptly after switching to a smaller one). Mutation-tested:
   reverting to the flat cap causes the regression test (`Terminal.test.tsx`,
   "reaches LIVE_COMPLETE on a display timeframe wider than the old flat
   120-bar retention cap") to fail exactly as expected.

## Verification

`apps/web`: 85 test files, 1,306 tests. `apps/runtime`: unaffected (99
suites, 2,692 tests). Production build green. Lint clean.

Every new mechanism was mutation-tested, not just covered, including the
two defects above and (from the initial build and the subsequent
hardening pass): the bar-boundary correlation logic, the
`indicatorRuntime.ts` trades pass-through on the `APPENDED` branch, the
demo indicator's max-vs-sum and per-trade-not-per-bar logic, the
resample-aggregation completeness check, and the full pipeline end to
end via a DOM-level proof-of-concept test in `ChartPanel.lifecycle.test.tsx`
that activates `largeTradeBubbles` for real and asserts a real
`createSeriesMarkers()` plugin received a circle marker at the correct
price.

## Not yet built, by design

No server-side query endpoint for historical trades-by-range --
`ctx.trades` is `[]` (`tradeAvailability: "HISTORICAL_UNAVAILABLE"`) for
every replayed bar, by design, not by oversight. No L2 order-book depth.
The real Large Trade Detector (whale bubbles) was not migrated onto
`ctx.trades` when `TA.04` reached it -- a directly-checked call, not an
oversight: it needs real hit-test geometry for hover tooltips, which
`ctx.trades`/the generic marker system has no equivalent for, so it kept
its own existing live-trade pipeline instead. `ctx.trades`'s only real
production consumer remains this ticket's own `largeTradeBubbles` demo.
