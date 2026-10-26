# Empty Orderbook

Boxes over the stretches of the order book that hold much less than a normal
row: thin rows on the heatmap's own rows, each side of price, live. A row
that fills again flashes and leaves its box, so the box shrinks, splits or
ends as the book comes back. It reads the lane-0 heatmap columns and the
chart's candles, no walls and no trades, and it is unavailable in Historical
Mode.

## Rows and the typical row

The rows are the heatmap's rows at the chart's timeframe: the heatmap's Row
Size (`ctx.liquidity.heatmapClusterRows`, or the instrument's default before
the heatmap's settings arrive) scaled by `clusterRowsFor`. They are capped so
the newest column holds at least `MIN_ROWS_PER_SIDE` (30) rows on each side,
so higher timeframes get finer rows than the heatmap (`heatmapRowsOf`). The
row size the chart drew with is kept while it still leaves 28 rows a side
(`ROW_CAP_SLACK`), so a book a row or two narrower does not flip the boxes
between two row sizes.

A row's size is read the way the instrument's heatmap style and the Live
Order Book Profile read it (`LiquidityStyle.bandSizes`): every price in the
row added up on crypto, the biggest price in the row on index futures and
stocks.

The **typical row** is the median of the non-empty rows near price, both
sides, over 0.5 % of price or 10 rows a side, whichever is wider. It moves a
tenth of the way to each new median per second (`TYPICAL_KEEP_PER_SECOND`).

## The rule (`emptyBookModel.ts`)

On each column, for each side:

1. **Thin**: a row is thin when its size right now and its 2-minute average
   are both under `thinShare` × typical. The average needs the row to be in
   every column of the window, so a row that comes into view waits a full
   window.
2. **Where it looks**: the whole book the column holds, kept `clearRows` rows
   away from the best price. A row joins from `clearRows + 2` rows out and
   leaves quietly when price comes within `clearRows`, so the near edge does
   not flicker as price ticks. Nothing is judged until the first full window.
3. **Zone**: a run of thin rows at least `minRows` tall, shown once it has
   lasted 30 s (`showMs`). Zones keep their id across columns by overlap;
   both parts of a split keep the age and the zone's `group`, and two zones
   that join keep the older id, group and age.
4. **Refill**: a row of a zone that holds `refillMultiple` × typical right
   now, or whose 2-minute average reaches halfway between the thin line and
   the refill line, leaves the zone. If the zone is shown, the row flashes
   for 3 s (`flashMs`).
5. **Back in**: a refilled row may join again once it has been thin for 15 s
   in a row (`rejoinMs`); any column that holds the thin line or more starts
   the count again.
6. **Gaps**: the runtime skips a few seconds of columns about once a minute,
   so the model rides through gaps up to 30 s (`gapMs`) and starts over
   after a longer one, or when the row size changes.

The 2-minute sums and counts are typed arrays over the rows the window
covers (`fitRows`), moved with a margin when price takes the window past
them, and the typical row and the runs are sorted as typed arrays.

`emptiestWindow` finds, inside a zone, the window of a given height with the
smallest 2-minute total, nearest to price among equals.

`emptyBookRulesFor` (`emptyBookRules.ts`) builds the rules: rows and the
minimum height at least 1, `clearRows` at least 0 (4 when not a number), the
thin share above 0 (0.75 when not), and the refill never under the thin
share (1 when not a number). `minRowsOf` turns the High sizes of Order Flow
Gaps (`minMoveOf`: BTC 30 USD, ETH 1 USD, NQ 22 ticks, ES 6 ticks on 1m,
scaled by timeframe) into rows, never fewer than 2.

## The indicator (`emptyOrderbookIndicator.ts`)

- The model is kept per instrument, row width, rows, timeframe, Size per
  Zone, Refill Size, Rows Clear of Price, zone height and grid epoch
  (`modelFor`, the last `MAX_MODEL_SLOTS` (4) used), so a colour, Zone
  Length, Zones per Side or flash change redraws without reading the book
  again.
- The book is read only on bars the chart draws (the last closed bar and the
  live bar), so a replay judges it with the current price, never with the
  oldest bar's.
- On a new model it reads the columns from `REPLAY_MS` (4 h 5 min) before the
  newest one, the 10 s deep tier then the 1 s tier (`eachColumn`), so a zone
  carries its real age up to the longest Zone Length. Later bars read only
  the newer columns, past the end of the live candle too, so a market that
  stops printing candles still shows the book as it is.
- Status card: waiting for the book, unavailable in Historical Mode, or
  stale when the newest column is older than 30 s by the clock; no box is
  drawn then.
- **Boxes**: from where the area emptied, no further back than Zone Length,
  to the live bar and beyond. A box and its age start after the last kept
  candle whose range reached into the box's prices (`clearedSince`), so no
  candle sits inside a box; the left edge snaps forward to the next candle
  when that minute has none (`leftEdgeOf`).
- **Zones per Side** counts zones by `group`, so the two parts of a split
  show together; Keep the Levels picks the nearest or the furthest.
- **Fixed Zone Height**: each zone shows only its emptiest window of exactly
  that many rows (`windowOf`), and the minimum height becomes that height.
- **Flashes** are drawn only for rows that were inside a drawn box on the
  previous draw, from that box's left edge, decided once per flash
  (`drawnFlashes`, `rowsDrawn`).

## Drawing (`emptyOrderbookRender.ts`)

A box with a 20 % fill and an 85 % outline in the side's colour, the label in
its lower-right corner in the IOB text style:
`Empty Book Ask · 6 rows · 14 contracts · from 31,416 to 31,432.5 · 22m`,
falling back to shorter forms in a thin box. The size is `restingIn`: the
rows of the newest column read with the same `bandSizes` as the rule, added
up, so it equals the Live Order Book Profile's numbers beside the box (whole
contracts and shares, coins like the ladder). A flash is the row filled in
the side's colour, fading over 3 s to no less than a quarter of its strength.

## Settings (`emptyOrderbookSettings.ts`)

| Setting | Default | Range |
|---|---|---|
| Size per Zone (%) | 50 on crypto, 75 on indexes and stocks | 10 to 100, step 5 |
| Refill Size (%) | 100 | 100 to 300, step 10 |
| Fixed Zone Height | off | |
| Zone Height (rows), shown when Fixed Zone Height is on | 1 | 1 to 20 |
| Rows Clear of Price | 4 | 0 to 20 |
| Zone Length (min) | 30 | 1 to 240 |
| Keep the Levels | Nearest to Price | Nearest / Furthest |
| Zones per Side | 3 | 1 to 8 |
| Flash Refilled Rows | on | |
| Ask-Side / Bid-Side Zone Color | the heatmap's purple and green | |

Size per Zone and Refill Size each have a crypto key and an index-and-stock
key; `marketFieldsFor` hides the other market's two sliders, so each market
keeps its own values in the shared settings. Sensitivity is fixed at High
(`SENSITIVITY`).

## Tests

`tests/emptyBookModel.test.ts` (the rule on one-second books),
`tests/emptyBookRules.test.ts` (the rules and the minimum height) and
`tests/emptyOrderbookIndicator.test.ts` (settings, drawing, caching, status,
replay). Mutation specs: `benchmarks/mutations/empty-orderbook-step1-model.json`
and `empty-orderbook-step2-indicator.json`.
