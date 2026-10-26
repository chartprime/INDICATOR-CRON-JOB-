# Technical Indicators — RSI, EMA, Bollinger Bands, SMA

> **Historical implementation evidence.** This dated page records the result
> of a completed build or audit. It is not a current deployment/health
> statement; use the handbook and final-state overview for supported operation.

The `category: "technical"` and `category: "community"` entries built on
the indicator-authoring core (`TA.01` — see its own evidence doc,
`TA.01-indicator-authoring-core-evidence.md`, for the shared runtime
mechanism all four run on). Documented together, and more briefly than
the L1 indicators, because they make no claim about market-data
provenance: each is a standard formula computed over closing prices that
are already established as trustworthy by the time they run. The L1
indicators each get their own evidence doc because each one asserts
something about order flow that has to be justified.

**Superseded by `TA.01`, 2026-09-04.** RSI, EMA and Bollinger Bands were
originally a batch implementation (`lib/chart/indicators.ts`, recomputed
from the full closes array on every call). They are now each a
self-contained incremental indicator — the same formulas, computed
bar-by-bar with persisted state, matching how the chart's runtime and a
live feed actually work. The batch functions still exist in
`lib/chart/indicators.ts`, but only as a hand-verified reference the
incremental versions are checked against in their own test suites — they
have no production caller anymore.

## Files

- `apps/web/src/lib/indicators/rsi/rsi.ts` — incremental Wilder RSI
- `apps/web/src/lib/indicators/ema/ema.ts` — incremental dual-leg EMA,
  with the trend-based per-bar line coloring
- `apps/web/src/lib/indicators/bollinger/bollinger.ts` — incremental
  Bollinger Bands (bounded ring-buffer window)
- `apps/web/src/lib/indicators/sma/sma.ts` — incremental SMA, new in
  `TA.01` as the authoring core's own proof indicator; `category:
  "community"` ("ChartPrime Library" menu section), with a real
  length/color settings panel
- `apps/web/src/lib/chart/indicators.ts` — the retired batch formulas,
  kept only as each incremental indicator's own value-parity test
  fixture (see `## Superseded` above)
- `apps/web/src/lib/indicators/{rsi,ema,bollinger,sma}/tests/*.test.ts` —
  each indicator's own exact-value, value-parity, live-replace-semantics,
  and (where applicable) settings-driven-color tests

## Input domain

All four take the closed-bar `close` series from the bar pipeline
(`docs/contracts/ws-frame-contract/v1`), after resampling to the selected
timeframe, delivered one bar at a time through the shared runtime
(`TA.01-indicator-authoring-core-evidence.md`). They therefore inherit,
and do not re-check, bar provenance or the resampler's gap behavior.

Each outputs `null` during its own warm-up period. Unlike the retired
batch versions (which failed an entire series to all-`null` on any
non-finite value anywhere in it), each incremental version fails closed
per-bar: a single non-finite close outputs `null` for that bar only and
recovers on the next valid one, rather than poisoning the whole run — a
deliberate, documented divergence forced by the incremental model (a
batch function can look at the whole array before deciding; an
incremental one only ever sees one bar at a time).

## RSI (14)

Wilder's RSI. The first value is seeded from the simple mean of the first
`length` gains and losses; every later value uses Wilder smoothing,
`avg = (avg * (length - 1) + current) / length`. All-flat input returns
50, no losses returns 100, no gains returns 0 — conventions, not derived
values, since RSI's usual formula divides by zero there. `RSI_LENGTH = 14`.

Internally split into a **committed** baseline (finalized once a bar is
truly in the past) and a **tentative** value (recomputed from the
committed baseline on every revision of the still-open bar) — this is
what lets a live, still-updating candle report a correct live RSI without
ever double-counting a diff once that candle actually closes.

## EMA (12 / 21)

Two exponential moving averages, each an independent leg of the same
committed/tentative design as RSI. Seeded with the simple mean of the
first `length` closes, then `ema = value * k + previous * (1 - k)` with
`k = 2 / (length + 1)`. `EMA_SHORT_LENGTH = 12`, `EMA_LONG_LENGTH = 21`.

Both lines share one `color()` function: up-colored whenever the short
leg is at or above the long leg (an exact tie counts as up), down-colored
otherwise, recomputed fresh per bar — the generalized version of what the
retired `toTrendColoredLineData` helper did specifically for this pair.

## Bollinger Bands (20, 2)

`basis` is the 20-period simple moving average, held in a capped ring
buffer (`committedWindow`, never exceeding `length` entries — this is the
one of the four that most needed the incremental redesign, since a
sliding-window variance can't reuse a single running scalar the way RSI/
EMA can). `upper`/`lower` are `basis ± mult * σ`, population standard
deviation (dividing by `length`, not `length - 1`). `BOLLINGER_LENGTH =
20`, `BOLLINGER_MULT = 2`. A negative multiplier fails closed to all-null
rather than producing an inverted band.

## SMA (20) — new in TA.01

Plain simple moving average over the same capped-window design as
Bollinger's basis line, with no bands. Exists specifically to prove two
`TA.01` mechanisms with real, shipped code rather than a synthetic test
fixture: a real settings panel (`length`, recompute-tagged; `color`,
cosmetic-tagged — purple/blue/green) and the 4th `IndicatorCategory`
value rendering a real, non-empty menu section. `SMA_LENGTH = 20`.

## Limitations

- Warm-up bias: the first `length` points are `null`, not approximated.
- No look-ahead: every value at bar `i` uses only bars at or before `i`.
- None of the four is a market-data claim — they describe price history,
  not order flow, participation, or intent, and carry no per-provider
  confidence level.
- Settings persistence: none of the four persist a customized settings
  value across a page reload (matches the existing behavior of every
  other indicator's settings in this app, e.g. Large Trade Detector's
  threshold). A customized value does survive being un-favorited and
  re-favorited within the same session — see `TA.01-indicator-authoring-
  core-evidence.md`.
