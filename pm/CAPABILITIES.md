# Platform capability sheet (maintained by the PM)

What an indicator in this terminal can read, draw, and configure. Specialists
design against this sheet, not against what they wish existed. Code wins over
this sheet; report a disagreement to the PM instead of working around it.

Snapshot: `Terminal-L1-L2-development-indicator-sdk`, imported 2026-10-26.
Authoritative files: `apps/web/src/lib/chart/indicatorTypes.ts` (contract),
`indicatorRegistry.ts` (registration and Historical policies),
`indicatorTicks.ts`, `indicatorL2.ts`, `indicatorLiquidity.ts`,
`apps/web/src/types/frames.ts` (wire shapes),
`docs/architecture/indicators/data-for-indicator-authors.md`,
`docs/architecture/l2/l2-sdk.md`.

## 1. Instruments and feeds

| Instrument | Live source | What arrives live | Historical Mode |
|---|---|---|---|
| BTC, ETH spot and perpetual | Binance WebSocket | every trade with taker side; aggregated depth diffs per price (no individual orders); 1m bars | 1m/1h/1d candles with taker buy volume; verified L2 book states for some August 2026 hours only |
| ES, NQ (continuous futures) | dxFeed (needs layer 2 access) | TimeAndSale tape with aggressor side; Order-v2 indexed orders assembled into a per-price book (one tick per level, full depth) | 1m/1h/1d candles; host studies: volume profile, VPIN, large prints, bar flow |
| AAPL, TSLA (equities) | dxFeed (layer 2) | tape, 35 to 75 percent of volume has NO aggressor side; Order-v2 book | as futures; regular session only (09:30 to 16:00 New York) |
| NVDA | dxFeed (layer 2) | tape and book | not archived |

Not available anywhere: dxFeed DOM service (no entitlement), native dxFeed
candles, individual order IDs on Binance, a complete historical tick archive
(the archive keeps only the largest prints of each minute), historical depth
outside the verified August 2026 hours.

Feed vocabulary (use these exact terms in concepts): **top of book** (best
bid and ask), **aggregated depth** (size per price level, what Binance and the
assembled dxFeed book give), **individual orders** (dxFeed Order-v2 only, and
only inside the runtime's L2 engine, not exposed raw to the browser),
**tape** (individual trades with side), **candles** (OHLCV plus sided volume).

## 2. Inputs an indicator receives (`IndicatorBarCtx`)

| Field | Content | Availability |
|---|---|---|
| `bar` | OHLCV, `buy_volume`/`sell_volume` (read through `barSides`), `trade_count`, `closed`, `reconstructed`, `interval_ms`, `provider`, `marketKind`/`assetClass` | always; 1m source bars, other timeframes resampled in the browser; at most 10,080 bars retained |
| `trades` + `tradeAvailability` | the forming bar's individual prints | live bars after activation only; replayed bars get `[]` and `HISTORICAL_UNAVAILABLE` |
| `ticks` (declare `ticksWanted: true`) | the pair's print store: every live print since connection plus server history above a size floor; `coverageOf(from,to)` returns `all`, `thin` or `none` | live only |
| `liquidity` | lane-0 heatmap: 1-second columns of resting bid/ask size per price row, buy/sell flow per row, up to 64 largest prints per column; recent 20 min fine, 2 h deep (10 s columns) | live; a bounded history stream for backfill |
| `l2` (declare `category: "l2"`) | `ladder()` exact book `[price,size]`; `walls()` with evidence (`size, peak, ratio, fill, eaten, absorbing, startTs, endTs, endedBy, detail`); `events()` up to 5,000 (`wall_born/shrink/trade/hidden/end`, `trade`, `hidden`, `segment`); zoom `lanes()`; `trusted()`, `status(channel)`, `version` | live only; reads the state NOW, not as of a replayed bar; `undefined` until the first L2 frame |
| `bandHistory` | on-demand host replay of resting size and traded flow for a price band over a window (2 h, 256 rows, 100k cells per request) | layer 1 |
| `barIndex`, `barCount` | position in the series being fed | always from the runtime |
| `replace`, `replaying`, `drawNow` | forming-bar revision, replay pass, redraw request | always |

Heatmap and lane geometry: columns capped at 1,023 rows per side; lane 0
reaches about ±5 percent on BTC/ETH and ±0.87 percent on NQ; wider lanes
double row and column size.

## 3. Execution model

- Incremental: `createState(settings)` once, `onBar(ctx)` per bar event. A
  forming bar is revised with `replace: true`, possibly many times per second.
  Never recompute from a history array.
- Full replay on activation, symbol/provider/timeframe switch, reconnect, and
  any `recompute` setting change. `maxReplayBars` bounds it.
- Fault latching: a throw, a non-finite number, or a non-string color disables
  the indicator until it is removed and re-added. Fail closed to `null`.
- `ta.*` (62 streaming factories: sma, ema, rsi, macd, atr, bollinger,
  keltner, adx, superTrend, ttmSqueeze, vwap, obv, mfi, stdev, highest,
  lowest, prev, crossover, crossunder, ...) and `draw.*` handles are created
  once in `createState`, inside the guarded creation window.
- Main thread. An L2 frame costs about 0.2 ms at p99; lane columns are
  megabytes and are handed out by reference. Never copy them per bar.

## 4. Rendering an indicator can do by itself

| Primitive | Notes |
|---|---|
| Line series per output key | per-bar color via `color(state, settings)`, `recolor` for cheap cosmetic changes, `lineWidth` |
| Placement | `overlay`, `ownPane` (with fixed `priceLines` and optional `autoscaleRange`), `sharedPane` with another SDK indicator |
| `ctx.draw.fill(a, b, {colorAbove, colorBelow}, key)` | band between two values, split at sign flips; several keyed fills |
| `ctx.markers.plotshape/plotchar` | circle, square, arrowUp, arrowDown; positions aboveBar, belowBar, inBar, atPriceTop/Bottom/Middle; `text`, `size`, `color` |
| `draw.line/box/label/polyline` | created-once handles in domain coordinates, mutated per bar |
| `draw.table` | DOM overlay, top right, cell text and color |
| `getHoverData` | arbitrary hover payload, but only indicators hand-wired in ChartPanel show it today |

Not self-serve (needs a chart-pipeline change, PM approval required): custom
canvas primitives, histogram series, forward-displaced plots, attaching to
another indicator's bespoke series, hover tooltips for a new indicator,
alerts or notifications (no alert system exists in the web app at all).

Cycle-1 definition of an "alert": a documented condition rendered as a marker
and surfaced in the indicator's own table or legend. A notification channel is
a separate SDK project, not something a specialist builds inside an indicator.

## 5. Settings and presets

Field kinds: boolean, checkboxList, radioGroup, select, numeric, color,
slider, staticHint, custom. Each has `affects: recompute | cosmetic |
liveOnly`, optional `visibleIf`, and `tab: "inputs" | "visibility" |
"advanced"`. Numeric and slider `step` must be > 0. Every settings key must
appear in the schema (a test enforces it) and presets come for free. Since
2026-10-26 `tab: "advanced"` renders as a collapsed Advanced group at the end
of the Inputs tab (UX option A, merged): keep at most three primary controls
and mark the rest advanced. `recolor(oldColor, settings)` cannot reclassify
history, so a setting that changes which bars are colored or marked must be
`recompute`, not `cosmetic`.

## 6. Historical Mode policies

`OHLCV_POLICY` (candles), `CANDLE_FLOW_POLICY` (candles plus sided volume:
Binance, and ES/NQ/AAPL/TSLA through the bar-flow study), `TRADE_FAMILY_POLICY`
(host studies), capability lists including `l2_states`, `l2_walls`,
`l2_prints` (verified hours only), or an `unavailableReason` sentence. A
candle archive must never fabricate ticks or depth.

## 6b. Screenshots and the fixture runtime

Binance is unreachable from this container (runtime log: required routes
never reached CONNECTED). Screenshots therefore come from the UX specialist's
fixture WebSocket server at `PM/cycle1/screenshots/tools/fixture-ws-server.cjs`
(speaks the frame contract: selection, snapshot of synthetic closed 1m bars,
health, book, a forming bar revised each second) on port 8001, with the web
app on 8000 and the Playwright scripts beside it. Every snapshot bar must be
`closed: true` or the frame is dropped. Procedure in `PM/cycle1/ux-standard.md`
section 4.

## 7. Testing and evidence tooling

- `replayBars(def, bars, settings)` replays a bar sequence through an indicator.
- Fakes for the tick store (`AggressiveTape`, see `vwap-bands/tests`) and for
  `IndicatorL2` (hand-built objects, see `liquidity-voids/tests`).
- Vitest for the web app, jest for the runtime, mutation specs in
  `benchmarks/mutations`, `npm run gate` for everything.
- Recorded market data is NOT in the repository. The runtime can replay
  recorded days from the collector's SQLite (`replay-source.js`) only on a
  machine with that storage. Validation here therefore uses synthetic
  fixtures and whatever live Binance data this container can reach; the
  validation specialist states which.

## 8. Units

Binance sizes are base asset (documented USD notional is `price * size`);
futures are contracts; equities are shares. Never add across providers.

## 9. Data paths added in cycle 2 (2026-10-26)

- Spot endpoint overrides `TT_BINANCE_SPOT_WS_BASE_URL` and
  `TT_BINANCE_SPOT_REST_BASE_URL`: the stream transport can use Binance's
  unblocked market-data mirrors. Spot only; perpetual endpoints untouched.
- REST candle transport `TT_BINANCE_TRANSPORT=rest` (`TT_BINANCE_REST_POLL_MS`
  250..20000, `TT_BINANCE_REST_WEIGHT_BUDGET`): spot candles only, forming and
  closed, finality judged at dispatch time, catch-up and hole repair with an
  honest `history incomplete` reason; tape and book unavailable, health reason
  `Polled spot candles · no tape · no order book`. This is how the cloud
  container reaches real Binance spot data; evidence in
  `pm/cycle2/acceptance-rest-transport.md`. Stage B2 (aggregate trades behind a
  capability contract) and Stage C (depth) remain in the backlog.
- Browser-direct mode (`VITE_DATA_SOURCE=browser-binance` at build time, or
  `?source=browser-binance`): the web app reads Binance spot in the browser
  (REST history, then kline, trade and depth20 streams), no runtime. Candle and
  tick indicators work; the L2 engine family shows unavailable.
- Environment facts: the container cannot open WebSockets (proxy) and
  Binance's primary API geo-blocks it (451); the mirror answers REST with
  `access-control-allow-origin: *`.

