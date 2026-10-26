# Passive Liquidity Heatmap (browser side)

What rests on the book, drawn under the candles: a time by price matrix where
every cell is the resting size at that price in that second, plus a size ladder
against the price axis showing the book as it stands right now.

The server sends one column per second (and a coarser column per ten seconds
behind it) with the size of every row of the book, and a list of the large
levels it tracks. Everything in this folder turns that into the picture.

## The path a column takes

```
wire frame  ->  liquidityGrid      the browser's copy of the column history
            ->  liquidityHeatmapLayout   where columns, bands and the ladder land on the pane
            ->  liquidityRunFinder       what is a level here, and what became of it
            ->  <market>LiquidityStyle   how this instrument is coloured and worded
            ->  liquidityHeatRenderer / liquidityLadderRenderer   pixels
```

`liquidityHeatmapPrimitive` owns those pieces and plugs them into
lightweight-charts. `liquidityBandHover` answers the tooltip from the same runs
the renderer draws, so the picture and the tooltip can never disagree.

## The files

| File | What lives there |
| --- | --- |
| `liquidityGrid.ts` | Rebuilds the column history from delta frames, per tier, and carries each column's own yardstick (95th percentile and median of the book near price when it printed, and the ceiling: the biggest row near price, smoothed over half an hour). |
| `liquidityRuns.ts` | The run model, the heart of the indicator: where a level begins, how long it lasts, and how it ends (resting, consumed, pulled). Pure functions, no chart. |
| `liquiditySettings.ts` | The settings object, its defaults and small formatters. |
| `liquidityStyle.ts` | The `LiquidityStyle` interface and the router that picks one from provider and wire symbol. |
| `cryptoLiquidityStyle.ts` | The Binance drawing, shared by every pair. **Frozen: do not change without the trader's say-so.** |
| `btcLiquidityStyle.ts`, `ethLiquidityStyle.ts` | Where BTC's and ETH's settings start. Drawing unchanged. |
| `indexLiquidityStyle.ts` | The shared dxFeed drawing (levels read by their biggest row, shaded and thickened by their share of the column's ceiling, contracts or shares on the axis) plus the tuning knobs, and the fallback style for equities. |
| `esLiquidityStyle.ts`, `nqLiquidityStyle.ts`, `aaplLiquidityStyle.ts`, `tslaLiquidityStyle.ts` | Where each instrument's settings start, and the wall an absorption is measured against. Changing one cannot touch another. |
| `liquidityHeatmapLayout.ts` | Pure geometry for one frame: bands, tiers, candles, ladder rows. |
| `liquidityRunFinder.ts` | Binds the run model to one frame: floors (including the quiet zone), sizes per market, fates settled by the server's ledger. Keeps the scan of the settled columns between frames (see below). |
| `liquidityHeatRenderer.ts` | The heat, painted into one RGBA buffer and blitted once. |
| `liquidityLadderRenderer.ts` | The ladder bars and their numbers. |
| `liquidityBandHover.ts` | The band under the cursor, for the tooltip. |
| `liquidityHeatmapPrimitive.ts` | The chart primitive: owns the grid, the layout and the three renderers. |
| `LiquidityHeatmapSettingsModal.tsx` | The settings dialog. |
| `liquidityHeatmapHost.ts` | The small contract between the primitive and its renderers. |

## Aggressive orders ride on the same frame

The server's aggressive-orders tracker reports clusters of market buying and
selling (who hit what, how hard) in the `aggressive` list of the same
`liquidity` frame, and the grid keeps the latest list like it keeps `levels`.
The heatmap does not draw them: that is the separate **Aggressive Orders**
indicator in `../aggressive-orders/`, which reads this grid and switches on and
off independently.

## Two markets, kept apart on purpose

Crypto and the index instruments are read by different eyes, so they are drawn
by different code. The run model, the grid and the settings are shared; the
style decides everything else.

- **Crypto** (Binance): rows summed into a band, numbers in coins on the ladder,
  the tooltip carries size and peak, brightness against the biggest level in
  view, a level darkens a little over its first fifteen minutes.
- **Both**: a resting or consumed level is painted at the most it has held
  over its run, in every column, so a wall being eaten keeps its size and
  colour until price ends it; the ladder and the tooltip still say what
  rests there now. Only a pulled level is drawn as it was, and faint.
- **Indexes and equities** (dxFeed): a band is read by its **biggest** row and
  every floor is per row, so the cluster size never inflates a level. Whole
  numbers on the ladder and in the tooltip (contracts on a future, shares on an
  equity), no age fade. A level is shaded and thickened by its share of the
  column's **ceiling**: the biggest row near price, smoothed over half an hour
  (`LIQUIDITY_CEILING_ALPHA`), carried by every column like its other two
  yardsticks, so history keeps its look and scrolling moves no colour. The
  curve is crypto's (size over the ceiling, to the power `LIQUIDITY_GAMMA`,
  from a quarter of the row to the whole row), on the index floors. Measured
  on the stores of 2026-10-05 to 10-11 within 50 bp of price: the biggest row
  sits at about 6 times the 95th percentile on NQ (50 to 60 contracts in the
  day session, 130 at the busiest tenth), 2.5 times on ES (150 to 250), 7 to 10
  times on AAPL, NVDA and TSLA; the half-hour smoothing moves it under 7 % over
  ten minutes in the median and under 27 % at the busiest tenth, so a wall's
  stripe keeps one tone along its run. Before 2026-10-12 full darkness came at
  four times the server's wall threshold (1.5 times the 95th percentile), which
  on NQ was about 40 contracts, so a 50-lot, a 150-lot and a 500-lot painted
  the same; a ceiling that has not caught up with its own book (the first
  columns after a reset) still reads that threshold, as does a column from an
  older store with no ceiling. A ceiling starts from its first column's
  biggest row near price, but never above ten times that column's 95th
  percentile (`LIQUIDITY_CEILING_SEED_CAP`, `seededCeiling`: the live grid on
  both tiers, the history decode and a summed lane); later columns move it as
  before. On NQ and the stocks, whose biggest row is about 6 to 10 times the
  95th percentile, a spike in the first column after a reset, a reload or a
  gap in the history now seeds within about twice the usual ceiling instead
  of holding every wall faint for the next hour. On ES, where the biggest row
  is about 2.5 times the 95th percentile, the cap still lets such a spike seed
  at up to about four times the usual ceiling, and a first column with fewer
  than eleven rows near price is not capped at all (its 95th percentile is its
  biggest row). From 15m up the chart folds columns into cells of an eighth of
  a bar (`liquidityCells.ts`), and each cell carries the biggest ceiling of
  its columns like its other two yardsticks; the raster repaints a cell whose
  ceiling alone changed. The ceiling is built in the browser and every decode
  starts from a fresh one: the columns the runtime replays on connect, and
  each page of history from the host (pieces of up to three hours counted back
  from the live edge when the reach was loaded, later windows one or two at a
  time). So after a reload, in a terminal opened later, or for about half an
  hour after each page boundary, the same past columns can draw a shade
  lighter or darker than in a terminal that loaded them at another moment. The "Colour scale" setting on fixed is the
  trader's own ceiling: that many contracts or shares is full dark, as before.
  The wall an absorption is measured against (`wallSize`, the monster multiple
  of the threshold) is unchanged by this.

Adding an instrument with its own feel means adding a file like
`esLiquidityStyle.ts` and one line in the router, nothing else.

## The trader's settings, as of 2026-09-07

| Instrument | Cluster | Quiet zone | Hide under | Pulled |
| --- | --- | --- | --- | --- |
| BTC spot and perp | 5 rows | 7 | 0 | shown |
| ETH spot and perp | 4 rows | 16 | 0 | shown |
| ES | 1 tick | 16 | 20 | shown |
| NQ | 3 ticks | 16 | 7 | shown |

They live in each style's `defaultSettings`, and `MainPanel` keeps one live
settings object per style name, so switching instrument restores its own.

## The scan is kept between frames

A column a second used to mean a full rescan of every retained column for every band in view, on every frame. Since 2026-10-07 the finder keeps one scanner per band side standing at the open of the live candle. A frame forks that scanner and feeds it only the live candle's columns, so a new second costs the live candle, not the retained span. When the candle closes the kept scanners advance over it. The kept scan is thrown away when anything the settled part depends on changes: the rows per band, the row width, the settings, the clocks, a reset, a closed candle revised, or a column landing in the past. Two things do not throw it away: a tier's cut moving later as the finer tier evicts its oldest columns (those columns were already scanned at the finer width), and the colour reference changing while every settled column carries its own yardstick. While host history lands, page after page, the oldest tier is a new list every few hundred milliseconds; the kept scan is rebuilt for it at most once per `HISTORY_RESCAN_MS` (400 ms) and the frame answers from the scan it has in between. `createRunFinder` still returns the same finder object while the live candle stays within the bands it already touches, so the heat image and the hover keep their caches.

## History: one reach, drawn whole

The **History** setting (1 day, 3 days, 5 days, 1 week; 1 day by default,
saved per market with the other heatmap settings) says how far back the
host's stored columns are loaded behind the live tiers. The whole reach is
asked for as soon as the pair is on screen, whatever the view shows, in
chunks of three hours newest first, two in flight (inside one pool of four
reads shared by every reader of the host's columns route, so the heatmap,
Prime Absorption's loader and the band fills together never hold open more
than the route serves at once). Nothing of it is drawn
until every window of the reach has answered; until then the chart shows
the badge `HEATMAP · LOADING 1 DAY` and the legend says so. A longer
choice keeps the reach already on screen and swaps once the longer one is
whole. A reach of the same length that merely slides with the live edge
fills in quietly. A window the host failed to build, or has not built yet,
is a hole that fills on its retry; it never holds the picture back.

Each reach has one column width that fits in the browser: a day at
one-minute columns, the longer reaches at five minutes. A day at the host's
finest ten seconds would be some 290 MB at full rows. The reach is always
loaded at the runtime's own rows (row factor 1); when the price zoom puts
the chart on a wider lane, the loaded columns' rows are folded in pairs or
fours before drawing (`foldHistoryRows`): summed on crypto, the same sum the
host does for a row factor, with the yardstick measured again on the wider
rows; on an index market a wider row is the **biggest** of its ticks and the
yardstick stays lane 0's, because a band on NQ is read by its biggest row
and summing the ticks made the same wall read twice as big on rows 0.5 as
on rows 0.25. The runtime samples its own zoom lanes the same way
(`laneFoldFor` on both sides). So neither the time zoom nor the price zoom
ever asks the host for anything.

The ask does not stop at the lane's oldest column: it runs up to the end of
the five-minute window holding the live edge, and the host's columns are
kept wherever the lane's own raw columns have none (`fillHoles`), cut at the
live edge. After a restart each lane rebuilds from its own point, and
without this the x2 lane showed a past that began hours after rows 4's.
The tiers then interleave in time, so the run finder and `bandRuns` feed
the scan oldest column first across tiers.

## Lanes

Each zoom lane keeps the same span of the past as rows 4 (its capacities are
lane 0's divided by its factor), so zooming the price axis never shortens
the history on screen. Finest rows is the standard price zoom for every
market; a pinned lane holds while it fits the row cap and gives way to the
lane auto would pick only beyond it, so the finest rows never leave the
chart empty. A fixed colour scale is per row of the finest lane: on a wider
lane the floor and the saturation are multiplied by the rows per drawn row,
so the x2 lane reads the same scale as rows 4 (on an index lane the biggest
tick is already one row, so the factor is 1). Week columns are drawn five
minutes wide on 15m and folded only when the cells are coarser than them.

## Time past the session breaks

lightweight-charts places bars by index and gives a hole in the bars (the
futures maintenance break, the weekend) no room, so wall time and chart time
part company before every break. `chartTime.ts` maps one to the other
through the holes in the chart's bar list (`barGaps`, `chartMsOf`,
`wallMsOf`): every column, cell and hover goes through the maps, and the
raster key carries the gaps. The candle series carries one break point at
every hole (`toCandlestickSeries`), so the chart gives a hole exactly one
bar of room and the hole in the maps starts a bar after the bar before it;
without that bar every column before a break sat one bar to the right of
its candle, one more per break. The bar interval is the shortest step among
the last eight bars, so a break just behind the live bar does not pass for
one. Before this the heatmap before a break sat a break-width to the left
of its candles on every index chart.

## Rules that are easy to break by accident

- **History never gets re-judged.** Every column carries the yardstick that was
  live when it printed. Floors and colours come from the column, not from
  today's book, or the past would change shape as the market moves.
- **The quiet zone raises the floor a level needs to APPEAR near price, never
  the floor a standing level needs to stay.** Otherwise a level drawn at a
  distance vanishes the moment price arrives, which is exactly when it matters.
  Nothing else gets a pass through it. Until 2026-09-15 a band the server
  tracked as a wall kept its ordinary floor inside the zone, and since the
  server's bar is one and a half times a 95th-percentile row that is 5
  contracts on NQ, that was nearly every band: measured over twenty minutes,
  98% of what NQ painted inside the zone and 81% of what ES painted was there
  by that pass alone, and none of it cleared the zone's own floor.
- **A run ends only when the band empties.** Price wicking through a level that
  holds does not cut it. Consumed levels are drawn whole, from where they
  started to where price ate them.
- **A hole in the columns is a hole in what we know, and is drawn as one.** The
  server sends no columns while its source book is unavailable (a crossed dxFeed
  book, a lost session), or while the publisher is stalled under load, rather
  than a copy of the last book it saw. A hole of up to five seconds is bridged:
  the publisher skips a second or two many times an hour, and that is not
  losing sight of the book. A longer hole is judged when the columns resume: a
  band still standing keeps its run, its age spanning the hole; a band gone by
  then ended where the columns stopped, consumed if a candle printed in it
  during the hole, pulled if not. The hover stops at the run's age: a hole it
  spans is drawn as a gap, never listed. A run never rests at a hole. Before
  2026-09-14 every run was cut at a hole and labelled resting, and on ETH perp
  that evening walls of 9,000 ETH price had run through read as resting walls
  aged 2.8 h, because the eating happened inside a 30-second stall. (On
  2026-09-08 the NQ book was dead for half an hour and a level showed "resting"
  through a 25-point spike it never saw: that case now reads consumed.)
- **The ladder is the whole book**, like a DOM, and nothing filters it: the
  trader's minimum size and the paint floor hide levels on the chart, never on
  the axis. They are not the same filter and should not be made the same. Its
  bands come straight from the price range on lane 0's rows, so it stays when
  the view is taller than the heat's row cap, and past the finest column's
  window (2,048 rows on the wire, 512 points on NQ) it reads the wider lanes'
  live columns: a band outside the finest book reads the finest lane that holds
  it, by the band when the band is whole lane rows, else by the lane's rows.
- Editing the primitive needs a **hard reload** (Ctrl+F5). The class is
  instantiated once, so Vite's HMR does not swap the running instance.

## Tests

```
npm test -- src/lib/indicators/passive-liquidity     # this folder
npx tsc -b && npx oxlint                             # types and lint
```

Every module here is pure except the three renderers and the primitive, so the
run model, the grid, the layout, the run finder and the styles are all tested
directly under `tests/`.
