# L1 tick concepts, cycle 1 (L1 Tick Specialist)

Five concepts built on the tape and nothing the capability sheet does not
promise. Concepts only; no code was written and the repository is unchanged.

## Findings from the code that bound every concept

1. **The browser tape is sided-only.** `TradeFrame.side` is `"buy" | "sell"`
   with no unknown value, and both dxFeed servers skip a print whose
   `aggressorSide` is `UNDEFINED` before building a `trade` frame
   (`dxfeed-market-data-server.js:1627`, `dxfeed-eager-market-data-server.js:2176`).
   On AAPL/TSLA, `ctx.trades` and `ctx.ticks` therefore hold only the 25 to 65
   percent of volume that carries a side, while `bar.volume` and
   `bar.trade_count` count every print. Every concept below computes
   **tape share = Σ print size in the bar ÷ `bar.volume`** and shows it; on
   Binance and ES/NQ it reads about 100 percent and doubles as a store
   integrity check (a sudden drop means dropped prints), on equities it is the
   honest denominator. No browser-side quote-rule classification can fix this:
   the unsided prints never arrive. A runtime tick/quote rule would be a host
   change for the PM to raise.
2. **No top of book reaches `IndicatorBarCtx`.** A `BookFrame` exists on the
   wire but is not in the ctx. The only routes are `ctx.l2.ladder()` (exact
   book, live, reads the state now, needs `category: "l2"`) or the lane-0
   heatmap column (1-second, row-quantised). None of the five concepts
   requires top of book; one uses it as an advanced, live-only refinement.
   "Price response" is therefore measured trade to trade, not against quotes.
3. **`ctx.trades` vs `ctx.ticks`.** `ctx.trades` is live only, `[]` plus
   `HISTORICAL_UNAVAILABLE` on every replayed bar, capped at 10,000 prints per
   source bar. `ctx.ticks` (`ticksWanted: true`) is the shared `AggressiveTape`
   (250,000-print cap, `coverageOf` → `all | thin | none`) and the runtime
   replays a `ticksWanted` indicator when the store arrives, backfilling
   earlier bars. All five concepts read `ctx.ticks`; `ctx.trades` is only a
   cross-check for `LIVE_PARTIAL`.
4. **"thin" is very thin.** History is complete only above the served floor,
   and older history is further thinned to the 4 largest prints per minute per
   side (`HISTORY_THIN_PER_MINUTE_SIDE`). Anything that needs the small prints
   (intensity, impact per unit volume, intrabar path) is null on `thin`.
5. **`IndicatorTicks` does not expose the tape's `autoFloor`**, so a size tier
   needs its own bounded quantile estimate.
6. **Measured cost of the shared access pattern** (Node 24, scratchpad): binary
   search into a 250,000-print store plus a full scan of a 1,000-print forming
   bar = **0.0105 ms per `onBar`**, 0.53 ms/s at 50 updates/s.

## Shared method (every concept inherits this)

| Topic | Rule |
|---|---|
| Window | Bar window `[ts_open, ts_open + interval_ms)`. `firstPrintAtOrAfter` locates the start; scan stops at the window end or the newest print. |
| Incremental | A closed bar is summarised once, when the next bar's first `onBar` arrives, and frozen (a late print splicing into it is ignored). The forming bar is **rescanned from scratch on every `replace: true`** (cheap, finding 6) and its summary overwrites the previous one: no double counting, no cursor to corrupt. |
| No future data | A bar uses only prints with `ts < min(now, bar close)`. Baselines (medians, EMAs, quantiles) update only from **closed** bars and are fixed for the forming bar at its open. A replayed closed bar sees only prints inside its own window. |
| Warm-up | Each concept names a minimum number of closed covered bars and prints; before that it emits `null` (fail closed, never zero). |
| Coverage | `all` → full value. `thin` → only the parts the concept says survive a floor (otherwise `null`). `none` → `null`; the line carries a gap, the legend says "tape not available for this stretch". Historical Mode: `unavailableReason` policy, like `vwapBands`. |
| Equities | Values computed on the sided subset; the legend shows "tape covers N% of volume"; pressure markers are suppressed under a settable share (default 50 percent). |
| Memory | One small struct per bar (6 to 10 numbers), bounded by the chart's 10,080 retained bars (< 1 MB); baselines in fixed ring buffers; no copy of the print array ever. |
| Alerts | Documented conditions drawn with `ctx.markers.plotshape`, repeated in the legend/table; one marker per bar per condition, finalised at bar close, provisional (lighter colour) while forming. |
| Common fixture | **Bar A**: one 100-unit buy at 100.00. **Bar B**: a hundred 1-unit buys at 100.00. Same OHLCV and `buy_volume`; equal `trade_count` is forced with matched filler. Candle-only tools cannot tell A from B (verified: identical bar fields; max-print share 1.00 vs 0.01). Each concept adds the variant that exposes what it measures. |

## Concept 1: Size-Split Delta ("whales vs retail CVD")

| | |
|---|---|
| Question | Are the large prints and the small prints pushing the same way, and which one is price following? |
| User, decision | Discretionary intraday trader on BTC perp or NQ; join a move when the large tier agrees with price, stand aside or fade when the large tier diverges from price while small prints chase. |
| Feed | Tape with side via `ctx.ticks`. Coverage `all` for both tiers; on `thin` the large tier draws only when the tier threshold is at or above the served floor (history is complete above it), the small tier is `null`. |
| Default view | Own pane, two cumulative lines: large tier (thick) and small tier (thin), zero line. Legend: "Large ≥ 12 BTC (top 2%) · tape covers 100%". Three seconds: are the two lines going the same way, and does the thick one agree with price. |
| Primary controls | Tier threshold (auto top-2% or fixed size in instrument units); anchor (session window or N-bar lookback, as VWAP Bands); divergence lookback K (default 10). Advanced: colours, show/hide small tier, thin-history behaviour, suppression share for equities. |
| Alerts (markers) | **Large-tier divergence**: price makes a K-bar high while large-tier CVD makes a lower high (and the mirror). **Tier conflict**: over K bars the two tiers' deltas have opposite sign and each exceeds its rolling stdev. Drawn above/below the bar, finalised at close. |
| Baseline to beat | `orderFlow` CVD (all sizes, from `barSides`) and the plain per-bar delta. |
| Evidence | On the fixture both bars give CVD +100 under the baseline. Size-Split gives A: large +100, small 0; B: large 0, small +100. Labelled fixture: 300 synthetic bars where price follows the large tier and the small tier is anti-correlated with 8 planted divergences; must flag ≥ 7 with ≤ 2 false markers. |
| Cost, memory | One scan per update (0.01 ms). Size quantile from a 20,000-value ring buffer re-sorted once per closed bar (160 KB, about 2 ms per minute) or a P² streaming estimator. Per-bar struct: 4 numbers. |
| Failure modes | A sliced iceberg prints as retail ("large print", not "large participant"; the hint says so). Threshold drift between sessions. Binance sizes are base asset: tier in coins, not USD. Equities: the small tier is unknowable; faded under 50 percent coverage. |
| Effort | S to M. |
| Pitch | Two CVD lines instead of one: the whales' and everyone else's, so you see who is actually behind the move. |

Estimation, per bar: fix threshold T at bar open (from closed bars only); scan
prints in the window; `tier = size ≥ T ? large : small`;
`delta[tier] += (side === "buy" ? +size : -size)`; cumulative = frozen sum of
prior closed bars in the anchor window + forming bar's contribution.
Warm-up: 50 live prints for T, otherwise `null`.

## Concept 2: Flow Impact ("absorbed or running")

| | |
|---|---|
| Question | Is the aggressive flow moving price, or is it being absorbed? |
| User, decision | Scalper or breakout trader deciding whether a push has follow-through: continue when flow moves price cheaply in its direction; stand aside or fade when heavy flow produces no movement. |
| Feed | Tape with side via `ctx.ticks`, coverage `all` only (impact per unit volume is biased without the small prints); `thin`/`none` → `null`. Advanced, live only: `ctx.l2.ladder()` spread to express impact in spreads (would require `category: "l2"`, so default off). |
| Default view | Own pane: efficiency line `E` with a fill to zero (positive = price moved more than the flow usually buys, negative = absorbed). Markers on the price pane: "A" at the bar where heavy flow was absorbed, "!" where little flow moved price a lot. Legend: "1 tick per 8.4 BTC net · median 3.1 · absorbed". |
| Primary controls | Baseline length (closed bars, default 50); absorption threshold (flow multiple × movement fraction, default 1.5× and 0.5×); display mode (efficiency or absorbed volume). Advanced: ATR normalisation, min flow floor, colours. |
| Alerts (markers) | **Absorbed**: net flow ≥ 1.5× its rolling median and price progress ≤ 0.5× its median. **Fought**: net flow sign opposite to the close-to-open sign with both above their medians. **Efficient surge**: progress ≥ 2× median on flow ≤ 0.5× median. |
| Baseline to beat | Candle Kyle-lambda proxy: `(close − open) ÷ barSides.delta`, and plain range ÷ volume. |
| Evidence | A' = one 100-unit buy with no later print; B' = a hundred 1-unit buys walking price 100.00→100.10; one matched filler print gives both the same OHLC and delta, so the candle ratio is identical, while the tape's per-print signed impact (Σ side × next price change) is 0 for A' and +10 ticks for B'. Sequencing fixture: all buying in the first 10 s then a drift down on tiny sells, versus the reverse order, same candle; the "flow into the extreme" reading differs. |
| Cost, memory | Scan plus `ta.atr`; medians from 50- to 200-value ring buffers. 0.01 ms per update. |
| Failure modes | Net flow near zero makes the ratio explode: floor at the 10th percentile of |flow| and emit `null` below it. Tick size differs per instrument (use `market-instruments.json`). Low-volume bars and news spikes dominate medians: median, not mean, and a bar cap. Equities: flow underestimated, so impact overestimated; markers off under 60 percent coverage. |
| Effort | M. |
| Pitch | Tells you whether the market is eating the flow or running from it, bar by bar, without an order book. |

Estimation: `I = Σ signed size`; `P = close − open` in ticks (forming bar:
last print − open); `λ = P / I` when `|I|` clears the floor; `E = log(|λ| ÷
median|λ| over closed bars)`; the median and the flow floor are frozen at bar
open. Warm-up: 20 closed covered bars.

## Concept 3: Breakout Tape Confirmation (cross-layer theme)

| | |
|---|---|
| Question | When price breaks a level, did participation and price response change with it, or is the break hollow? |
| User, decision | Breakout trader: enter on a confirmed break, wait for the retest on a half-confirmed one, fade a hollow one. |
| Feed | Tape with side via `ctx.ticks`; coverage `all` for the break window and the baseline bars (breaks are evaluated live anyway). `thin`/`none` → the break is drawn as an unverified hollow outline, never scored. |
| Level source | Standalone: N-bar high/low from closed bars (`ta.highest`/`ta.lowest`, default 20). Merge-ready: accepts an external break event (the OHLCV compression range's edges) beside an L2 "liquidity ahead" reading; the tally stays a separate, explained component so a combined score gets its own validation, as the charter asks. |
| Default view | Price pane only: one arrow per break, solid when 3 of 3 tests pass, half-filled at 2, hollow at 0 or 1; a small `draw.table` top right with the three readings of the latest break ("tape ×3.1 · 68% with the break · held, 0.3 adverse"). |
| Primary controls | Level lookback N (or "external"); confirmation window W seconds (default 30, extended to bar close); intensity multiple (default 2×). Advanced: direction share (60%), min break distance in ticks, re-arm bars (3), colours. |
| Alerts (markers) | **Confirmed break** (3/3), **hollow break** (≤ 1/3); plus **failed confirmation**: a break that scored 3 provisionally and closed back inside the level. |
| Baseline to beat | Candle breakout with a volume filter: close beyond the N-bar level and `volume ≥ 1.5× average`. |
| Evidence | Fixture (a): one whale buy beyond the level, then 59 s of small sells pushing price back under, close just above; volume is high, so the baseline says "volume-confirmed"; the tape fails intensity (one print) and direction (post-break flow 90% sells) → hollow. Fixture (b): 100 small buys at 3× the baseline print rate walking price through → confirmed, same bar volume. Labelled set: 40 planted breaks (20 continuations, 20 fakeouts) with noise; target ≥ 75 percent correct. |
| Cost, memory | Donchian via `ta.*` every bar (negligible). Scan only while a break is open: ≤ 1,000 prints per update. Baseline struct per bar: 3 numbers. |
| Failure modes | Whipsaw: one break per level per direction, re-armed after 3 closes back inside. W suits one market speed at a time (hence primary). The tests are correlated, so the tally is a reading, not a probability. Equities: the direction test uses the sided subset and is dropped (tally out of 2) under 50 percent coverage. |
| Effort | M standalone, L merged. |
| Pitch | A break with no change on the tape is just a price touching a line; this shows which breaks the tape actually showed up for. |

Estimation: baseline over the 10 closed bars before the break: prints/s,
break-direction volume share, progress per unit flow. Break window from the
first print beyond the level: test 1 `prints/s ≥ 2× baseline`; test 2
`break-direction aggressive volume ≥ 60%`; test 3 price still beyond the
level at window end with maximum adverse excursion ≤ 50 percent of progress.
Revised in place while forming, finalised at bar close. Warm-up: N + 10 closed
bars.

## Concept 4: Intrabar Delta Reversal ("delta give-back")

| | |
|---|---|
| Question | Inside this bar, did one side win early and then give it back? |
| User, decision | Scalper on 1m to 5m deciding to hold or exit on an indecisive-looking bar: a big intrabar delta extreme that reverses into the close is exhaustion; a delta that holds its extreme is continuation. |
| Feed | Tape with side via `ctx.ticks`, coverage `all` (the path needs every print); `thin`/`none` → `null`. |
| Default view | Own pane: final bar delta as a line, with a fill from the line up (or down) to the bar's intrabar delta extreme, so the "shadow" is the give-back. Legend: "Δ +12 · peaked +140 · 91% given back". |
| Primary controls | Give-back threshold (default 70%); extreme size multiple vs rolling median (default 1.5×); min prints per bar (default 30). Advanced: colours, show delta at high/low. |
| Alerts (markers) | **Buyers flushed**: `dmax ≥ 1.5× median|extreme|` and give-back ≥ 70%. **Sellers flushed**: mirror. Marker above/below the bar at close. |
| Baseline to beat | `orderFlow` per-bar delta plus candle shape (doji, wick ratios). |
| Evidence | Fixture: bar X = +100 of buys in the first 30 s then −100 of sells; bar Y = alternating ±1 prints; identical candle and zero delta in both. Give-back is 1.0 for X and about 0 for Y. Whale variant: one 100-unit buy followed by a hundred 1-unit sells → delta 0, give-back 1.0, versus a balanced 50/50 retail tape → give-back near 0. |
| Cost, memory | Same scan; 6 numbers per bar (dmax, dmin, final, delta at high, delta at low, prints). Extremes only grow during the forming bar, so the rescan is exact. |
| Failure modes | Few prints per bar make the path noisy (the min-prints gate). On 1h+ bars give-back is common and uninformative (timeframe gate to ≤ 15m by default). Descriptive, not predictive; validation on labelled fixtures only. |
| Effort | S. |
| Pitch | The candle shows the net; this shows the fight inside it. |

## Concept 5: Burst Detector (sub-bar intensity)

| | |
|---|---|
| Question | Where within the bar did the activity concentrate, and is the tape bursting right now relative to normal? |
| User, decision | Scalper and news trader: do not chase into a burst, watch the price a burst printed at as a level. |
| Feed | Tape via `ctx.ticks`; side optional (colour only); coverage `all` (prints/s is meaningless on `thin`); `thin`/`none` → `null`. |
| Default view | Own pane: burst ratio (busiest 5 s of the bar ÷ rolling median of the same statistic), with a marker on the price pane at the burst's VWAP when the ratio clears the threshold, coloured by the burst's delta sign. Legend: "busiest 5 s: 212 prints, 61% of bar volume, ×4.3". |
| Primary controls | Burst window seconds (default 5); threshold multiple (default 4); measure (print count or volume). Advanced: baseline length (60 closed bars), time-of-day baseline, colours. |
| Alerts (markers) | **Burst** at the burst's price; **concentration**: ≥ 50 percent of the bar's volume inside its busiest window. |
| Baseline to beat | `bar.trade_count ÷ interval` and relative volume (RVOL). |
| Evidence | Bars with equal `trade_count` 100 and volume 100: A = all prints in 3 s, B = spread over 60 s; the candle is identical, the burst share is 1.0 vs 0.08. Whale variant: one 100-unit print gives a low count burst but a 1.0 volume burst placed at the whale's price. |
| Cost, memory | Two-pointer sliding window over the bar's prints, O(n), about 0.02 ms at 1,000 prints; 3 numbers per bar. |
| Failure modes | Routine bursts at open, funding and settlement (time-of-day baseline is the advanced fix). Same-millisecond sweeps inflate the count variant (volume variant default on futures). On equities the count is of sided prints only. |
| Effort | S. |
| Pitch | Shows the three seconds that made the minute. |

## Registry overlap, and why each concept is not redundant

| Registered | Overlaps with | Difference |
|---|---|---|
| `orderFlow` Aggressive Order Flow (CVD from `barSides`) | 1, 2, 4 | Candle sided volume per bar, all sizes, net only. Concept 1 splits by print size, 4 reads the path inside the bar, 2 divides movement by flow; none is computable from `barSides`. |
| `largeTradeDetector` Large Trade Detector, `largeTradeBubbles` (Demo) | 1 | Single-print markers with no accumulation or direction over time; concept 1 is the cumulative line of that tier against the rest. |
| `aggressiveOrders`, `aggressiveOrdersProfile` (L2 category) | 1, 5 | Bubbles and a profile of clustered prints by price; no per-bar scalar, no baseline, no divergence or burst-rate condition. |
| `liveDeltaProfile`, `volumeDeltaProfileTick`, `sessionDeltaProfile` | 1, 4 | Delta by price row; concepts 1 and 4 are delta by size and by time within the bar. |
| `absorptionDetector` Prime Absorption, `exhaustion`, `initiative` (L2, host studies) | 2, 3 | Host-computed from heatmap per-row flow and the book; concept 2 is tape-only, per bar, own pane, works on Binance and futures without L2; concept 3 adds the break context. |
| `vwapBands` | all | Shares the `ctx.ticks` access and coverage idiom only. |
| `marketStructure`, `fvgDelta`, `l1OrderBlocks`, `classicOrderBlocks` | 3 | Candle structure; none measures the tape during the break. |
| `vpinCloud` | 1, 2 | Host VPIN over volume buckets; not per bar, not by size tier. |

## Ranking and recommendation

| Rank | Concept | Why |
|---|---|---|
| 1 | Size-Split Delta | Clearest in three seconds, strongest candle-beating evidence, S to M effort, no dependency on another layer. |
| 2 | Breakout Tape Confirmation | The theme concept; standalone level definition makes it buildable alone, and its tally is a clean component for the integrated breakout tool. |
| 3 | Flow Impact | Useful and distinct, but the ratio needs careful flooring and its reading takes longer to learn. |
| 4 | Intrabar Delta Reversal | Cheap and honest, narrower audience (scalpers on low timeframes). |
| 5 | Burst Detector | Real but modest gain over `trade_count`; best as an advanced output of 3. |

Recommendation: brief Size-Split Delta as the cycle-1 L1 build, since it beats
the existing CVD on a fixture a validator can reproduce in an afternoon and
needs nothing from the other layers. Hold Breakout Tape Confirmation as the L1
component of the integrated breakout tool once the OHLCV specialist defines the
break event, and raise the two capability gaps (no top of book in the ctx,
unsided equity prints dropped before the browser) as PM decisions rather than
indicator work.
