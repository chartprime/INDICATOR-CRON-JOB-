# Institutional Order Blocks v2

Walls read straight from the book. No candles, no swing structure: a zone is
a band of adjacent rows that held real resting size, drawn from the moment it
appeared for as long as it stands, and graded by what the book did to it.

Built to the rules agreed with the trader on 2026-09-18 and measured on the
recordings of 2026-09-17/18 (nine instruments, 15 to 36 hours each).

## The rules

1. **Wall.** A band of `bandRows` adjacent rows, summed, holding at least the
   wall size for three minutes. Born at the first column it reached the size;
   drawn from there. Length on the chart is its lifetime, like the heatmap.
2. **Life.** Two ends, by what the wall was. A wall nothing has traded into
   ends when its band falls to 10% of the most it held: it was pulled. A
   wall that has been traded into was consumed, and stays however thin it
   gets until a bar closes through it -- under a bid wall, over an ask wall,
   on the chart's own bars, so at the chart's timeframe. On the live feeds
   of 2026-09-18, walls born within three dollars of price were consumed in
   a median of two minutes and 87% had been traded into; walls over thirty
   away lived a median of 46 minutes and none had. The old rule ended both
   alike, so the walls doing the absorbing died before they were drawn and
   came back reading Fresh. Either kind also ends when the column window
   leaves its rows, or a gap in the book longer than ten minutes
   (`HOLE_MS`) follows; a shorter gap is bridged, the wall's age and count
   carrying over it. **Guarded** walls are the exception: a wall that
   reached the strong size and has had a quarter of its peak traded into it
   (`earnsGuard`) is guarded from there, the trader's rule -- what a wall
   that big absorbed is the reading, and only a bar closing through it ends
   that. It stands through the window leaving its rows, at its last read
   size, and through any gap; its grade never drops. The strong size decides
   which walls are guarded, so changing it is a replay. The live feeds of 2026-09-18 had a gap over a
   minute every twenty minutes, most under four; at a minute's tolerance no
   wall lived long enough to be graded. **Memory.** An ended wall is
   remembered for four hours (`MEMORY_MS`). A band back at the wall size
   inside that is the same wall come back: its birth and its refills are
   kept, it is drawn the moment it is back since the level stood its three
   minutes long ago, and the band on the chart runs from the level's first
   birth, as the heatmap draws the level's run. A wall back from the
   window's edge or a gap resumes as it was, nothing having happened to
   it. One back from being pulled counts a refill of what it came back
   with and starts a new life: its peak starts there, and its crossing is
   earned again, since the level was empty in between (nothing had traded
   into it, or it would not have been pulled). The birth, the refills and
   what they brought back are the level's, kept across its lives.
   **Mitigation**, the classic block's rule: a wall a bar has closed
   through is not come back to, and neither is a level whose wall had
   already gone when the close came -- orders resting there again are a new
   wall from that moment, with a new birth, a new age and nothing carried
   over, so cumulative counting belongs only to a wall price has never
   broken. The chart's closes are replayed with the columns, not applied
   one per bar to the state as it ends up: a read covering eleven hours
   ends each wall at the bar that closed through it. Before that, a
   start-over -- which happens on every page load and every deep-tier
   resync -- re-read those hours with only the newest bar's close, so
   every wall price had broken since rose again over the price with its
   whole cumulative life, which is what the trader saw on 2026-09-19. It is hidden unless `showMitigated` is on,
   and drawn faded then, from its birth to the bar that closed through it,
   in the grade it held at that moment, its card dimmed and its age frozen.
   Orders resting there again are a new wall from that moment: a new birth,
   nothing traded into it, no refills. **Refills** within a life: the band down to half its peak, then
   back to four fifths of it or up by a wall size from its low, counted
   with what came back -- so a wall consumed and refilled well short of its
   old peak still counts each time. Growth to a new peak is not a refill.
   **What counts as traded into it.** Opposing-side flow in the wall's rows,
   from the column *after* the one it opened or came back on. A column is ten
   seconds of the book and a wall that opens in one was posted somewhere
   inside those ten seconds, so what traded in them is mostly what happened
   before it was there: counting it made a wall born as price swept through
   read Tested at birth. On the ETH perp of 2026-09-19 a bid wall at 2620 was
   born already 23% absorbed and passed its own peak within ninety seconds,
   credited with the sweep that made it. It now stands Fresh until something
   trades into it while it stands. The ten-second bucketing still over-credits
   a wall that stood for part of a window -- the tier's own granularity -- but
   the sweep is no longer counted.
   **Columns.** Walls are read from the deep tier, ten-second columns with
   each row at the most it held in the window, as far as it reaches; past
   its edge the fine tier is folded into columns of the same width, whole
   windows only (a folded column keeps the largest typical level and median
   of its seconds, none when no second has one, as the heatmap's own fold
   does; the tracker reads neither, Prime Absorption does), so the live
   minute the deep tier has not reached yet reads
   the same as the rest and a wall's size on the card is at most ten seconds
   behind the book. **The book changes behind the clock.** The chart's book
   is not delivered once in order: on a fresh page the live columns come
   first and the deep history lands up to a minute later, entirely before
   the clock; on a resync the deep tier is cleared and replayed from
   yesterday while the live tier stands still; columns for windows already
   passed land late. Watched in the browser on 2026-09-19, all three
   happened inside six minutes. A read that only continued from its clock
   skipped every one, and a wall was born where the tracker first saw it
   rather than where the book says, its refills and earlier lives lost. So
   the tracker starts over -- everything read again from what the book holds
   now, about 200 ms on the ETH perp's eleven hours -- on a new epoch, on a
   deep column landing before or inside the span it has read, or on one at
   or before its clock for a window the fine tier had not already given; a
   deep column for a window already folded from the fine tier is that
   window again and is passed. At most one start-over every five seconds
   (`REBUILD_MIN_MS`), so a replay in pieces is read over a handful of
   times, not on every piece.
3. **Grades.** Two, and two doors into the second. **Strong** by absorption:
   60% of the peak has traded into the wall from the other side and it is
   still standing ten minutes after that share was crossed -- and from
   then on the grade holds whatever the wall's size does, down to nothing.
   A consumed wall is never pulled, and the trader's rule of 2026-09-20
   is that a strong tested wall is printed until it is eaten to nothing or
   a bar closes through it; what it holds is the chart's business (a wall
   with nothing resting is not drawn, see *Weak* below), not the grade's.
   For a few hours that day the door also demanded the wall size -- after
   the ETH perp ask of 2026-09-19 that read Strong at 88 ETH -- and he had
   that taken out: 88 ETH of a tested wall is 88 ETH still resting. **Strong** by
   size: the wall holds the instrument's strong size *now*
   (`strongSizeFor`: 200 BTC on the perp, 5,000 ETH, 100 NQ, 300 ES, 10,000
   AAPL, 100,000 NVDA, 23,000 TSLA — the trader's numbers where given, the
   typical wall on the recordings elsewhere), tested or not, so the largest
   resting walls read as strong while they stand at that size and not after.
   What a wall once held is no part of it: the tracker marks a wall at the
   size when it holds it (`atStrongSize`) and drops the mark when it falls
   under four fifths of it, a hold so a wall breathing around the size does
   not flip grade every column; the mark is never read from the peak, and a
   wall that came back from the peak's height without reaching the size
   again is weak. Before this the door was judged on the peak, and a wall
   that had held 200 BTC hours ago read strong at 160. **Guarded**: a
   quarter of its peak traded into it (`GUARD_EATEN_SHARE`) and the strong
   size reached at some point in this life (`reachedStrongSize`, kept for
   the life though the grade goes). The two need not hold at the same
   moment: absorption is what takes a wall's size away, so demanding both
   at once made them race each other, and on the ETH perp of 2026-09-19 a
   wall of 5,318 was consumed to nothing with 35% of it traded in, never
   guarded, and left the chart at the very moment it was doing what the
   guard is for. Once guarded it is strong whatever its size, until a bar
   closes through it (see *Life*). Crossing and holding earns no guard:
   the guard's difference is the endings it survives -- the window leaving
   its rows, a long hole -- not the grade. A quarter, not a touch:
   before this any print made a big wall "tested", and on the trader's BTC
   perp at fifteen minutes walls at 48 and 61 BTC with 0% and 7% absorbed
   stood as Strong for six hours on the strength of one print each.
   **Levels per side** (`levelsPerSide`, default 4, 0 for all): only a few
   walls on each side are drawn; the rest are tracked and graded, not drawn.
   This is the trader's knob for a busy chart, and `levelsBy` says which few.
   **Nearest to price** takes the levels price is trading into -- the
   distance from price to the band, nothing when price is inside it. It was
   the first default because ranking by size alone, on the ETH perp of
   2026-09-19, drew the four biggest asks at 2676-2690 and the four biggest
   bids at 2549-2594 -- all far from a price of 2635, off the screen at his
   zoom -- while the levels he was trading, eighteenth to twenty-sixth of
   eighty-one, were never drawn. **Largest size** takes the biggest walls
   wherever they sit, which is what a higher timeframe wants: price walks
   past a dozen small levels in one bar there, and size is the filter that
   leaves the ones worth waiting for. **Furthest from price** (the default,
   the trader's standard setting of 2026-09-20) takes the outer levels, the
   far side of the book a move is heading for rather than the ones price is
   already among. Whichever ranks, size breaks its
   ties, and for the two that rank on distance the nearer of two the same
   size. Of two walls the same size, the nearer reads in front. A higher timeframe keeps more levels alive, since fewer bars
   close through them -- twelve strong walls on the BTC perp at fifteen
   minutes -- and the sizes are deliberately not scaled with the chart: a
   wall at 81,800 is at 81,800 on every timeframe, and the same wall must
   not read strong on one chart and weak on another. **Weak**:
   everything else standing. Hidden unless switched on, drawn as outlines on
   the dimmer chip when they are.
   **The size floor** (`minSizeByInstrument`, the number the trader typed
   for this instrument, or its own `minSizeFor`: the size that leaves a
   dozen or so standing on a thick book rather than a hundred) is under
   every wall, whatever its grade -- the trader's call of 2026-09-20, where
   it had covered the weak walls alone. Per instrument, since 2,500 is a
   floor on the ETH perp and the whole book on the BTC perp. It is judged on
   what the wall holds now, the size on its card, never on its peak (the
   trader's call of 2026-09-21 evening, for every instrument): a wall away
   from the bars is drawn while it holds the floor, however much it once
   held, and hidden once it is eaten under it, back on the first refill to
   it. A wall with nothing resting is not drawn, whatever its grade or
   peak: it is still tracked, and the first size back puts it on the chart
   again. **A bar on a strong wall keeps it** (`staysOnChart`, the
   trader's rule of the same morning, after the 15m ETH chart stacked six
   bid walls a hundred dollars under a price that had run away from them,
   each holding 300 to 1,000 of the 2,400 it once did): a bar on a strong
   wall -- its range reaching the band, wick included -- keeps the wall
   drawn while anything rests, down to nothing; a weak wall needs the
   floor wherever the bars are. The candle after one that wicked into the
   wall and closed outside it counts as on it too, his grace: that candle
   decides -- a close through the wall mitigates it as any close does, a
   close away and the floor applies from then on. So a strong wall the
   market left behind fades from the chart as it is eaten below the floor,
   and comes back the moment price returns to it or it refills; nothing
   about its life changes. The floor's history: it read the size on the
   card for a few hours on 2026-09-20, when a strong wall on the ETH perp,
   absorbed 2,291 of a 3,250 peak and refilled seventeen times, breathed
   around 2,400 under price and blinked on and off thirteen times in
   twenty minutes, so the trader had it read the peak that afternoon; with
   the bar-on-wall rule of the 21st covering that case, he had it read the
   size on the card again that evening, so that a wall eaten to a remnant
   away from price is not a wall on the chart. Over the 64 slots, weak
   walls give way first, the thinnest of them first, and a strong wall
   never loses its slot to a weak one. **Cards on near bands stack, the
   strongest in front.** Every card is painted at its own band, in the
   same order the slots are filled -- weak before strong, thinner before
   thicker -- so where bands are too close for their cards, the one holding
   the most passive liquidity reads in full and the others show behind it,
   each still at its own level. That is the trader's rule after four
   layouts that tried to keep the cards apart -- moving one clear of the
   other, sliding it right, setting it smaller, hiding it -- and each time
   left him a card by the wrong band or a wall he could not see. The
   kernel's collision layout went with them. Touching bands stay separate walls
   with separate cards: fusing them was tried on 2026-09-19 and turned a
   shelf of ten stacked walls on the ETH perp into one ten-dollar block
   with a single card, which read worse than the pieces.
4. **The card.** `Strong OB · 499 BTC · Tested · 80/100`. The grade; the
   size now; **Fresh** or **Tested**, whether anything has traded into it
   since birth; and its **score** out of a hundred. The absorbed size, the
   refills and the age were on the card until 2026-09-20, when the client
   asked for them to come off, so that nobody reads the mechanics off the
   chart; they are in the score instead (`wallScore`). Four parts, each a
   share of its cap and no more: **size**, what the wall holds now against
   the instrument's strong size, 40; **defence**, what has traded into it
   against the quarter of its peak that earns the guard, 30; **refill**,
   what its refills brought back against its peak, 20; **standing**, its
   age since the level's first birth against half an hour, 10. So a fresh
   wall at the strong size that has just stood reads about 40, one at that
   size that has eaten a quarter of itself and refilled it reads 90 and up,
   and a wall eaten to a tenth of the strong size with nothing behind it
   reads 4 plus whatever it has earned for standing, 14 at most. The
   weights are the trader's choice of 2026-09-20 from three offered; they
   are one frozen object (`SCORE_MARKS`) and easy to move. The 60%
   crossing is still judged on the absorbed share, the card just does not
   say it. Too wide for the margin, the card gives up the score, then fresh
   or tested, then the size; never the grade. The nearby tape's delta was on
   the card and is gone: one reading a bar, the same on every wall, it said
   nothing a wall did not.
5. **Fires while the wall is alive**, never after it ends. Now is the last
   column read, not the bar's open: a bar's open is up to a bar behind the
   book, an hour on an hourly chart, so the score, the grade and what stands
   are judged by the book's clock and only the band's right edge sits on
   the chart's bar.
6. **Width is owned here.** `bandRows` is the instrument's and is stored
   on every wall, so a card always says what width it was judged at. On a
   slow chart the band is drawn wider than its rows, the wall in the
   middle (`bandDrawFactor`: three times from the hour, six from four
   hours, twelve from a day; `bandPadRows` says how many rows that adds a
   side) -- display only, since a band a dollar tall on the ETH perp was a
   hairline on the trader's four-hour chart of 2026-09-20. The card, the
   floor and the nearest-to-price cut read the real rows.
7. **The panel carries nothing that changes what a wall is.** Show Weak
   Walls, Show Mitigated Walls, Hide OBs Under, Keep the Levels, Levels
   per Side and the two colours. Every field is nonetheless marked
   `recompute`: this indicator owns no lines, and the runtime's cosmetic
   path (`recolorAll`) repaints line colours, so for a box-drawing indicator
   it draws nothing and the change waits for the next bar -- fifteen minutes
   on a fifteen-minute chart. The trader reported it on 2026-09-20 ("hide
   walls under doesn't do anything"), and it was true of every switch here,
   not only the new one. A replay re-runs `onBar` over the bars at once,
   which is what redraws the boxes; `tests/settingsApply.test.ts` drives the
   real runtime the way `ChartPanel` does and fails on the cosmetic marking.
   Classic Order Blocks carries the same note for the same reason. The
   width, the wall size and the strong size are the
   instrument's -- measured on its own book, listed under *Why these
   numbers* -- and were inputs until 2026-09-20, when the trader had them
   and the long hint under them taken off the panel. The floor came back
   the same day as one field over every wall. Nothing migrates: settings
   are restored field by field from the schema, so a stored width or size
   is simply no longer read.

## Why these numbers

Measured with the indicator's own tracker over the runtime's liquidity
stores, 54 hours to 2026-09-18 on most instruments (BTC spot 4 h, NQ 34 h):
every wall that turned strong as the rules say, and where price was 30
minutes later against the instrument's own median 30-minute move. A random
moment shows a move that large in a given direction 25% of the time on every
instrument, so 25% is chance.

| instrument | band | floor | walls | strong | reversed | broke | flat |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ES | 3 rows | 30 | 1,055 | 131 | 55% | 12% | 33% |
| NQ | 12 rows | 10 | 673 | 34 | 50% | 24% | 26% |
| BTC perp | 4 rows | 50 | 2,186 | 34 | 50% | 15% | 35% |
| ETH perp | 8 rows | 600 | 1,321 | 70 | 49% | 7% | 44% |
| AAPL | 8 rows | 1,000 | 838 | 281 | 55% | 17% | 28% |
| NVDA | 5 rows | 1,000 | 1,501 | 356 | 52% | 16% | 32% |
| TSLA | 6 rows | 1,000 | 1,074 | 192 | 51% | 16% | 33% |
| BTC spot | 4 rows | 10 | 296 | 1 | — | — | — |
| ETH spot | 8 rows | 180 | 1,677 | 27 | 70% | 11% | 19% |

Measured 2026-09-19 with the rules as shipped: gaps bridged, a level's lives
one wall, consumed walls kept to a close, guarded walls kept through the
window and any gap. Each of those changed the wall count and left the rates
where they were; the guard moved the counts by one to three walls. With
every gap ending every wall, as first built, the same recordings showed
several times as many walls (each rebirth counted again), at the same rates.

Strong walls precede a reversal two to three times as often as chance and
break well under it. The hit itself is a coin flip; the wall surviving it is
the signal. Refill counts and the tape's delta over the hold separated
nothing on any instrument in the earlier measurement, so neither is a
condition. The widths are the ones the signal was found at: one row finds
nothing, the band the trader sees on the heatmap finds it. The spot books
are thin and slow: a wall there is rarely eaten sixty percent, so the strong
grade almost never fires on them.

Recorded trade volume on the crypto feeds is about a quarter of the
exchange's, so "traded" and "eaten" are undercounts; the rules are relative
to each wall's own peak and survive that.

### A floor relative to the book was tried and does not hold

The floors above are absolute, per instrument. A floor that scaled with the
book -- so many times its typical band -- would spare a new instrument its
own measurement, so the calibration tries three scales: the median non-empty
band, the 95th-percentile band, and the typical wall (the median of each
column's biggest band). None of them puts the nine floors on one number: the
shipped floors sit at 0.8x to 44x the median band, 0.10x to 0.65x the big
band, and 0.01x to 0.38x the typical wall. And a floor raised toward the
biggest bands loses the signal, since the walls that turn strong are
mid-sized bands that get eaten, not the largest thing on the book: on AAPL a
floor of a quarter of the typical wall drops strong walls from 110 to 7,
on NVDA to none. Lowering the floors adds walls without adding strong ones.
So the floors stay absolute, and a new instrument is measured with the
script below. As a starting guess before measuring, 0.3x the 95th-percentile
band lands within a factor of two of the floor on seven of the nine.

### The index futures were measured on the wrong contract

The NQ and ES numbers of 2026-09-18 (wall 10 and 30, strong 35 and 80)
came from the September contracts a week after volume had rolled to
December: a dying book, three times thinner than the live one. On
2026-09-21, with the catalog rolled to December, the first half hour of
the cash session measured a median band of 14 and 47, a 95th-percentile
band of 82 and 232, and a typical wall of 109 and 350 (the calibration
tool, on the December stores). The trader set strong at 100 and 300; the
wall floor follows at about a third (35 and 90) and the hide-under floor
is 50 on NQ and, from the evening of the 21st, 300 on ES, his numbers. Thirty
minutes of one session: to be measured again at the close and over the
week, and rolled again before the December expiry on 2026-12-18.

## Calibration

`calibration/` runs the tracker over the runtime's saved liquidity stores
(`apps/runtime/data/liquidity/*.json`) and prints the table above, plus a
sweep of floors against the typical wall. From `apps/web`:

```
node src/lib/indicators/institutional-order-blocks-v2/calibration/run.mjs <folder of stores>
```

It goes through the repo's own Vite so the app's TypeScript resolves as it
does in the app; nothing is installed. Copy the stores to another folder
first, since the collector rewrites them while it runs. A store's first
minutes under-read, because its columns are deltas and the first has nothing
before it; walls born in the first ten minutes are left out for that.

## The L2 engine as the source (P4e, 2026-09-30)

"Walls From" in the dialog: **L2 Engine** (the default), **Heatmap
Tracker**, or **Both**. On the engine, `engineWalls.ts` reads `ctx.l2`
instead of the columns: the engine's active walls (clusters of rows the
server judged outsized) are grouped into this indicator's bands, and each
band keeps the rules above — opened at the wall size, its peak, its size
now, what traded into it from the engine's `wall_trade` events and its
`detail.traded`, the crossing, the guard, a candle close through it,
leaving lane 0 — so the grade is the same rule on the engine's evidence.
Ended walls the engine restores are adopted as past bands from their own
birth. It reads only while the feed is live and trusted; a status card at
the bar's close says waiting, untrusted, Historical Mode or stale, and no
engine wall is drawn while it shows. On Both the 64 slots are split in
half and the engine's boxes carry an `L2` tag and a thicker border.

## History from the host

On the engine the indicator asks the runtime over the WebSocket for its
day of ended walls (`wall_history`, `RUNTIME_HISTORY_MS`), and the
host, through the runtime's `/heatmap/walls` route, for the rest back to
the **History** setting (`historyHours`, 48 by default, up to 168):
`ctx.l2.hostWalls` is the stream (`lib/l2/wallHistoryStream.ts`), asked
once per engine from the reach to a day ago, six-hour chunks newest first;
each page's walls land in `pastWalls` and `adoptHistory` takes them on
the next bar, with the closes the chart holds (`MAX_BARS` 11,000 so a week
of 1m closes can end them). The engine keeps an adopted wall for the reach
(`memoryMs`), not four hours. Host walls carry ids below the runtime's
history ids, so the two never collide and both read as history. A wall
ended by a pull is dated and forgotten at the reach; one ended by a hit
waits for a candle close through it, as before.

## Files

- `institutionalV2Schema.ts` — the eight settings the panel carries, every
  one a replay (see rule 7). `MinSizeField.tsx` — the size floor's box,
  bound to the chart's instrument.
- `institutionalV2Rules.ts` — the constants, the grade, the per-instrument
  widths and floors, and the floor the trader typed per instrument. Pure.
- `bandTracker.ts` — reads the deep-tier columns band by band, opening a
  wall at the wall size, following its peak, its size now and what has
  traded into it, marking the crossing, ending it at a tenth of its peak or
  at a hole. Incremental: each read continues from the column the last one
  stopped at. Pure.
- `engineWalls.ts` — the same bands over `ctx.l2`: the engine's walls grouped
  by band, traded amounts from its events and details, ended walls adopted,
  trust, segment and pair changes, the hole and window rules shared with the
  tracker. Pure.
- `institutionalV2Render.ts` — the standing walls onto the chart's box slots:
  a band over the wall's rows from its birth to now, running on under its
  card and fading, the card past the band's right edge with the first
  indicator's look (its colours, chip and accent are imported, not copied).
  Weak first and strong last, so the strong read on top. Pure over the box
  handles.
- `institutionalOrderBlocksV2.ts` — the indicator itself: the box slots,
  the closed bars it keeps (`MAX_BARS`, with their closes at the grid's
  row width) to hand the tracker on every read, and on every bar a read of
  the columns up to the bar's close and the standing walls onto the slots. The
  tracker starts over when the row width changes, since the bands would
  mean different prices. Needs the chart's book; with none it draws nothing.
- `calibration/storeColumns.ts` — a saved store's deep tier as the chart's
  columns: deltas folded, flow moved from offsets to rows. Pure.
- `calibration/calibrateWalls.ts` — the tracker over a recording at a width
  and floor: walls, strong walls, where price was the horizon later against
  the instrument's typical move, chance, and the three scales. Pure.
- `calibration/calibrateCli.ts`, `calibration/run.mjs` — the nine stores by
  name, the shipped floor and the sweep, printed as tables.

## Touches outside this folder

Two files of shared code the first indicator touched too:

- `lib/chart/indicatorRegistry.ts` — the import, the registry entry, and
  the historical-mode policy (unavailable, like every book-driven indicator).
- `components/chart/MainPanel.tsx` — the gate that hands the chart its book
  now also counts this indicator among the ones that need it.

And one small addition to the settings machinery, 2026-09-20, so a field
can be bound to the instrument the chart is on:

- `lib/chart/indicatorTypes.ts` — an optional `settingsFieldsFor(identity)`
  on `RuntimeIndicatorDef`: fields by settings key, each standing in for
  the schema's static field with that key. The settings object is unchanged
  by it; a bound field reads and writes the same keys.
- `lib/chart/settingsSchemaFor.ts` (new, with its test) — the definition's
  schema with the bound fields put in place of the static ones; the same
  array back when nothing is bound (a mutant that copied it every time
  broke 59 panel tests, so the identity is load-bearing).
- `components/chart/MainPanel.tsx` — hands the generic settings modal
  `settingsSchemaFor(def, instrumentIdentity)` instead of the raw schema.
  One line. Every other indicator binds nothing and is byte-for-byte
  unchanged.
- `App.css` — three rules for a text input with a unit beside it
  (`indicator-settings-with-unit`, `indicator-settings-unit`), the same
  look as the numeric field's.

This is what makes the size floor read as a size. The trader saw a bare
`0` under "Hide Walls Under" and read it as a count of levels; then a
label naming the unit and the default was not it either: he wants to type
2500 into the box, have it mean 2,500 ETH, and see no spinner arrows. So
`MinSizeField.tsx` is that box: the floor in force for the chart's
instrument, its unit beside it, a whole number typed stored for that
instrument alone (`minSizeByInstrument`, keyed by `instrumentKey`), the box
emptied putting the instrument back on its own floor. `MainPanel.test.tsx`
opens the panel on the ETH perp and reads 2400 ETH, types 2500, switches
the chart to the BTC perp and reads 150 BTC, and comes back to 2500 ETH.
The schema lives in `institutionalV2Schema.ts` rather than the rules,
since the rules must not import the React field that imports them.

Nothing in the kernel or the runtime changed.
