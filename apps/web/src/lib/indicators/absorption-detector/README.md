# Prime Absorption (browser side)

A sphere on a wall that took a beating and held, printed the moment it did
and kept: the third L2 indicator, beside the Passive Liquidity Heatmap and
the Aggressive Orders. A bid wall holding against sellers is drawn in the
heatmap's bid colour, an ask wall holding against buyers in its ask colour;
the two colours are read from the heatmap's own settings, not copied, so
the pair can never drift apart.

Rebuilt on 2026-09-20 on the second order-blocks indicator's engine, after
the trader found its absorption accounting the more exact of the two. The
rule was made modular on 2026-10-07: the walls are the heatmap's own walls,
and the sphere needs a share of the wall and a multiple of the book's
typical level, the same three numbers on every book. The per-asset tables
(a floor per chart, a wall and strong size per instrument from the OB
indicator, a quarter and sixty percent on crypto, twice and three times on
the index books), the two-minute hold and the hour-by-hour replacement of
live spheres are gone: on NQ and ES they missed the real absorption (small
refilling bids that absorb 500-1,175 contracts against a resting size of a
few dozen), printed two minutes late, and a live sphere vanished when the
host's hour arrived.

## The walls

The band tracker of `institutional-order-blocks-v2` (`bandTracker.ts`),
driven here one column at a time, reading the heatmap's walls:

- **The band is the heatmap's band**: `clusterRowsFor` of the market's
  heatmap settings on this chart (NQ twelve rows by default, BTC perp ten,
  times the band factor from 15m up, as the heatmap widens).
- **A band's size is read the market's way** (`liquidityStyleFor(...).bandSizes`):
  summed rows on crypto, the biggest row on an index, so a level is not
  diluted by its neighbours.
- **A wall opens when the band's size reaches the heatmap's own paint floor
  for that column**: `max(minBandSizeFor(settings), style.paintFloor(column, ...))`,
  the floor the heatmap itself paints a level at, read against the column's
  own colour reference (`column.reference`, the yardstick that was live when
  the column printed; the grid's live reference when a column carries none).
  The floor moves with the book, column by column, and the trader's heatmap
  sensitivity and minimum band size move it too.
- The tracker's strong size is three times that floor (`STRONG_WALL_MULTIPLE`);
  it only drives its guard flags.

The tracker got three optional hooks for this (`wallSizeAt`, `strongSizeAt`,
`bandSizeOf` on `TrackerRules`); without them it reads as it always did for
the order-blocks indicator. What it holds, the most it held, what has traded
into it from the other side and its refills are kept from the opening column
on; a wall nothing has traded into is pulled at a tenth of its peak; a
traded-into wall stays, however thin, until a bar closes through it; a gap
in the columns up to ten minutes is bridged; an ended wall is remembered
four hours and comes back with its history.

**What counts as traded into a wall** is the tracker's rule too: opposing
flow into the band's rows from the column *after* the one the wall opened
or came back on, so the sweep that made a wall is never credited to it.

The heatmap settings that make the floor (style, cluster rows, minimum band
size, scale mode and size, heat floor) are part of the rules as a string
(`wallKey`), so the engine, the browser stores and the history loader all
start over when they change, and a colour change changes nothing.

## The rule

1. **Attack and resting size.** An opposing print into the band after two
   minutes without one (or the first of the wall's life) begins an attack;
   the band's size in the column before is the attack's resting size, and
   the column's typical level (`column.reference`, the feed's own when the
   column carries none) is the attack's yardstick. Both are read once, at
   the first hit; the peak is not used. No attack opens while that level is
   0 (a host column right after a gap, the live grid before its reference
   has warmed up): with a level of 0 the multiple asks nothing and the
   attack would be judged on the share of the wall alone.
   Two quiet minutes (`quietMs`, a cell of the bar on the slower charts)
   end the attack; the next print begins another, read against what the
   wall holds then. A wall back after a pull is a new life, its first hit a
   new attack; a wall back from a hole or the window's edge carries on.
2. **The attack is recorded once**, at the first eligible column where what
   has traded into the wall in this attack is at least the sliders' lowest
   numbers (`RECORD_PERCENT`, half of the resting size, and
   `RECORD_MULTIPLE`, three yardsticks; `absorptionSettings.ts` derives
   both from the sliders and hands them to the engine as
   `rules.recordPercent` and `rules.recordMultiple`). Eligible means the wall still has something
   resting (an iceberg shows a few lots while it absorbs, so the heatmap's
   floor is asked of the wall when it opens, not here) and the column's
   mid has not gone through the band: above a bid wall's bottom, below an
   ask wall's top, inside the band included (`holdsAt`). A band is forty
   dollars on the BTC perp and a holding wall is eaten row by row with the
   price inside it; counting only the columns with the mid at or outside
   the band (the near edge, the first build) threw those away, and threw
   away more of them on the bid side, where the sell-offs punch in, than
   on the ask side, where the rallies grind at the edge (2026-10-07, 150%
   and five yardsticks: 5 bid spheres to 9 ask; with the far edge 11 to 12).
   The record (`AbsorptionRecord`) keeps the attack's facts -- side, band,
   the attack's first column, what the band showed before the first hit
   (`shown`), the size the attack is measured against (`resting`: the shown
   size, or the heatmap's wall size for the column when it showed less,
   `rules.wallSize`: the paint floor on crypto, the full-dark row on an
   index book, since a thin book shows a tenth of what trades and NQ walls
   showing 12-20 contracts took 100-500 each, so a share of what showed
   never bit), yardstick, the band's mid price
   -- its flow and refills, which keep growing with the attack, and a
   **trail**: the record's first column, then the first eligible column at
   which each number a slider can ask for is met -- every Absorbed share of
   the resting size, 50-500% in tens, and every Minimum absorbed multiple of
   the yardstick, 3-200 in ones (`rules.askedPercents`,
   `rules.askedMultiples`, the sliders' own steps) -- each with what had
   been absorbed by then and what the wall held. So every setting a slider
   can make reads the very column its numbers were first met at, drawn the
   moment that column is read, and a kept entry is never moved or dropped: a
   sphere, once drawn, stays where it was drawn however long the attack goes
   on. A saved number reads at its slider's nearest step, so no setting falls
   between two kept columns. The newest eligible reading is kept apart in
   `latest` (the strong ring reads it). At most 245 entries, under
   `TRAIL_MAX` (256). The first build kept its entries a yardstick apart
   and, once 64 were kept, moved the last one on with every column: on a
   wall showing more than about 42 yardsticks the sphere then slid forward
   with the attack at the default numbers (PR #48 review). A ladder of
   two-percent steps, tried next, stopped the sliding but drew a setting met
   between two steps only when the attack grew another step or ended, and
   then at its last reading. Measured on the host's columns (NQ 2026-10-05
   to 10-07, the BTC perp 10-06 and 10-07; 1,899 records, against a trail
   that keeps every column): at all 9,108 settings the sliders can make the
   sphere sits on the exact column every time (17.3 million readings);
   trails hold about five entries on NQ and three on the BTC perp (the
   longest 62), about 650 characters a record. When
   the attack's wall ends the record gets `endTs` and `endReason`: "closed"
   (a bar closing through it, `closeThrough`), "pulled", or "other" (a hole
   or the window's edge). Records are keyed by side, band, rows and the
   attack's first column (`printKey`), so the store, the merge and the
   history all treat one attack as one.
3. **The rule's numbers read the record** (`readPrint(record, rules)`,
   pure): the sphere sits at the first trail entry whose flow reaches
   `absorbedPercent` of the resting size (200% by default) and
   `absorbedMultiple` yardsticks (40 by default: on NQ, where a band's
   typical level is about 8 contracts, 320 contracts), holding what the
   wall held at that column, with the record's whole flow and refills;
   `judgedAt` is that column, `held` is true. No entry reaches the numbers:
   no sphere at those numbers. The reading is instant, so **a slider never
   reloads anything**: the engine and the history keep their records and the
   chart re-reads them on the next paint. Below the sliders nothing can be
   read, which is why the records are made at the sliders' lowest numbers.
4. **One sphere an attack, the strong ring from the same record.** When the
   newest reading (`latest`) reaches `strongPercent` of the
   resting size (300% by default) and the same ratio above the minimum
   absorbed (one and a half times `absorbedMultiple` yardsticks at the
   defaults, so a few lots into a refilling wall never read as strong) the
   sphere is the strong ring: darker, `strong` true, `share` the strong
   share.
5. **Broken later, never removed.** A record whose wall ended "closed" or
   "pulled" within `breakWindowMs` of the sphere's own column (three bars,
   three minutes at least, an hour at most; the history reads that far past
   each day so a break just after midnight reaches the sphere printed before
   it) reads as `broken` and is drawn hollow; the hover says it broke later.
   A close through the wall later than that is the market moving on, not
   the sphere breaking; a wall ending in a hole or at the window's edge
   never breaks it. Nothing takes a record off once it is made. (The
   tracker never pulls a traded-into wall, and a wall at three floors that
   has eaten a quarter of its peak is guarded and outlives holes, so in
   practice a sphere breaks on a close through its wall.)
6. **One column source.** Live, the engine reads the grid's ten-second deep
   columns alone (the fine tier is not fed); the history reads the host's
   ten-second columns. Live and history run the same inputs.

The engine's own key is the walls: instrument, band, wall key, quiet spell
and row width. The three numbers and the break window are not in it, so
changing them keeps every record; the quiet spell or the wall key starts it
over.

Measured on NQ host data (2026-10-07; yardstick about 8 contracts a band,
heatmap sensitivity 20): 200% and 40x print about 0.3 an hour on a quiet 5m
stretch and 3 an hour on a busy 1m session, where the old rule printed 0 and
32. The three numbers are constants in one place (`absorptionSettings.ts`)
and sliders in the dialog.

## What is drawn

A sphere at the crossing column, on the band's mid price, in the heatmap's
colour for the wall's side, its radius between 8 and 30 px by the square
root of absorbed over two hundred times the yardstick
(`ABSORPTION_RADIUS_FULL_MULTIPLE`), times the bubble size setting. Alpha
0.55, plus 0.1 a refill, plus 0.15 for the strong ring, capped at one. A
sphere whose wall broke later is a solid outline with no fill. Hidden above
the four-hour candle like the bubbles. Hovering one says who was absorbed
by what wall, how much of what rested, what the wall held at the sphere, its
refills, when, and whether the wall broke later.

**On the slower charts the spheres of a side inside one candle draw as
one** (`absorptionMerge.ts`): one sphere centred on the candle, at the
absorbed-weighted price, sized by the summed absorbed over the largest
yardstick among them, the darkest of them a shade darker for every further
print; broken only when every wall in it broke. An attack counted twice in
a candle (a live sphere and the history's twin) counts once, at its fullest
reading. The print remains stored but is not drawn if the chart has no
candle at its timestamp.

## Where the spheres live

Records go to `localStorage` under `terminal.absorption.v8`, filed under
the walls they were read with -- the engine's own key (`absorptionWallsKey`:
instrument, band, wall key, quiet spell, row width), what the engine starts
over on -- each set with the time it was last added to, a record keyed side
+ band + rows + the attack's first column, trail, newest reading and end
included (`absorptionStore.ts`). Only the current walls' set is loaded and
drawn; another band, scale or row width loads its own, and a set comes back
whole when its walls are set again. Filed under the instrument alone (`v7`),
every change of the heatmap's band or scale re-read the book and added a
full set beside the one before, the same attacks drawn over and over: on NQ
on 2026-10-13, 500 records at eleven band widths in half an hour, seven
attacks drawn seventeen times. The store reads back only a whole record (a
non-empty trail, the newest reading, an end with both its time and its
reason or neither).
The store only ever adds, and lets a record of the same attack grow: more
flow, a newer reading (each new trail entry is one), another refill or the
wall's end replace what was kept; a thinner reading never does. It keeps its own copy
of what it takes, the trail copied too: the tracker hands the same record
over on every recompute and grows it in place, so a kept record that was
the tracker's own would be compared with itself and its growth never
written. A week is kept, at most five hundred a set of walls, and every read
and write is guarded. The whole store keeps within 1 M characters
(`STORE_MAX_BYTES`, about a fifth of an origin's ~5 M): over it the sets
used longest ago go first, whole, never the one being saved, and a set over
it on its own keeps its newest records, a whole column at a time. A record let go, by the budget or by the cap, is never
taken back, so the tracker handing its whole list over again writes
nothing. Writes come at most every 5 s (`STORE_SAVE_INTERVAL_MS`): a new
record is in memory at once, the first recompute past the interval writes
what was held, and `flush()` writes at once; the primitive flushes when it
is taken off the chart and when the page closes or reloads (`pagehide`). A refused write (a full storage) is retried up to
three times, each at half the size, and the store then keeps to the size
that fit for the session; if every try fails it stops writing for the
session, warns once in the console (the error, the characters, the records
left out) and keeps serving its records from memory. `v1` to `v7` are
removed on load; `v6` was a bare list per instrument with no budget, `v7`
filed records under the instrument alone.

**A live record is never taken back.** Within the History reach a saved
record shows beside the history's, whether the history is still loading or
has read its hour; the one exception is a twin, a history record of the
same side and band whose attack began within two minutes
(`LIVE_HISTORY_TWIN_MS`, on `attackTs`), the same attack read by both, where
the history's fuller reading is the one shown. The primitive reads every
record it shows -- the history's and its own -- through `readPrint` with
the rules in hand, so a slider notch re-reads on the next paint and asks
the history for nothing.

**On a historical chart** (#50's `DATABENTO` grid) the rules come from Historical Mode's own
settings (`HistoricalL2Settings`): the instrument's absorption numbers and its archive heatmap,
while the detector is a shown favourite on a timeframe it runs on, as on the live chart. The primitive reads the
grid's own feed (`historicalFeed`) at the grid's own clock (`clockMs()`,
the second after the window's last column), and reads every change at once,
since that clock never moves. It never loads the saved records nor saves its
own, so a historical sphere never lands under the live instrument's key or
on a live chart, and setting a historical grid drops whatever the live grid
had kept. #50's columns are a second wide and carry no typical level or
median of their own, so each second is read as the grid's own column for
it (`grid.columns`, matched by `ts`: the same second with the smoothed
95th percentile and median the archive heatmap is coloured by), and the
ten-second fold keeps the largest level and median of its seconds, as the
heatmap's own fold does. So an attack is read against the book's level
where it happened, an index wall at the median the heatmap paints it by,
and the same attack makes the same sphere however far the loaded window
runs past it. A second the grid holds no column for is read as it is, and
the historical feed has no window-wide level to fall back on: a column
without a level opens no attack. (Handing the whole window the grid's level
at its last second, tried first, recorded an attack on a one-minute window
and dropped it once the window ran ten minutes on into a thicker book.)

## History behind the live book

The host keeps a week of the heatmap's 10 s columns (the pyramid,
`docs/architecture/l2/heatmap-lanes.md`), carrying the same resting book per
row, the same aggressive flow per row and the same colour reference as the
live deep tier. The engine runs over them unchanged
(`AbsorptionHistory`, `absorptionHistory.ts`, through
`ColumnHistoryStream`): one UTC day at a time, one tracker from eight hours
before that midnight (`HISTORY_WARMUP_MS`) through the day and on for the
quiet spell, with the chart's own candle closes and timeframe; days are
read oldest first, an hour counts as read once its last attack's quiet
spell has run, the newest day stops at the live seam and is carried on with
the live deep columns past the host's end. A warm-up hour that ends before
the host's oldest column is read as empty at once (the stream finishes it
as done); the NQ chart's bars begin hours before the host's columns do, and
the week stayed loading for ever while those hours were asked again every
thirty seconds. The judged hours hold records,
trails and ends included, and the chart reads them at the rule's numbers.
Hours are kept in the browser per instrument, timeframe and walls
(`absorptionHistoryStore.ts`, keyed on `ABSORPTION_ENGINE_VERSION`, 6 since
the trail of the sliders' steps; every older version's key, `v1` on, is removed when the
store is made) so a reload shows the reach at once; the key covers the wall
key, the band, the quiet spell, the row width and the timeframe, and not
the three numbers or the break window, so a slider keeps the judged days
(nothing asked, not loading, a run in flight carries on) while another wall
floor or timeframe is read again, and nothing judged by an older engine is
read back. An hour is saved when it is judged and again when its run ends,
since the run reads on past it for the quiet spell and an attack can still
grow there; a reload shows each record as the run left it. An attack begun
before a UTC midnight is read by its own day only, which reads on past
midnight only for the quiet spell or the break window, the longer, so what
the attack does after that is not in the history.

## Settings

The rule's three numbers: **Absorbed** (`absorbedPercent`, 50-500% in tens,
200 by default), **Strong** (`strongPercent`, 150-1000%, 300, never under
the absorbed share) and **Minimum absorbed** (`absorbedMultiple`, 3-200
times the book's typical level in ones, 40), then "Show broken levels" (`showBroken`,
on by default; off hides the hollow spheres, `withoutBroken`) and History
(`historyDays`: off, 1 day, 3 days, 5 days or 1 week) under Inputs; the two
colours, bubble size, the shape, opacity and "Show on chart" under
Visibility, as the other indicators have it. Off or hidden, the panel hands
the chart no rules at all (`MainPanel.tsx`), so the history stops asking
the host and the badge goes; shown again, the rules return. The colours are the heatmap's until the
trader picks his own; Reset puts everything back. A saved number outside its
slider reads at the slider's end, one between two steps at the nearest step,
a missing or nonsense one as the default;
the floors an older session saved are let go on load. Moving one of the
three sliders re-reads the records on the next paint and never reloads the
history. The walls themselves are set in the heatmap's dialog: cluster rows,
sensitivity (minimum band size) and scale; those, and the timeframe, start
the engine and the history over.

## Where the data comes from

The grid's ten-second deep columns live and the host's ten-second columns
behind them, each column carrying the resting book per row, the aggressive
volume that printed per row and its colour reference. The chart's own
closed bars are handed to the tracker as closes (`barCloses`). The spheres
come from the heatmap columns alone; `engineAbsorption.ts` stays because
Flowprint Blocks reads the engine's trades through it.

## Files

| File | What it is |
| --- | --- |
| `absorptionSettings.ts` | The rules: the heatmap's band and paint floor as the wall, the three numbers with their sliders and clamps, the record gates (the sliders' lowest numbers), the wall key, the quiet spell; the settings; the words for the dialog. Session Levels still reads the older per-chart floor and share from here. |
| `absorptionEngine.ts` | The engine: v2's tracker driven column by column on the heatmap's walls, attacks with their resting size and yardstick, the records at the sliders' lowest numbers with their trails and ends; `readPrint`, the rule's numbers reading a record into a sphere (the first qualifying entry, the strong ring, broken by the break window); the record's shape check the stores use. Incremental, with the one-shot form as its oracle. |
| `engineAbsorption.ts` | The L2 engine's trade events folded into the columns' flow, with the history fill; used by Flowprint Blocks, not by this indicator. |
| `absorptionStore.ts` | The records per instrument in the browser, add-only, a record growing with its attack (a copy of its own, so growth made in place is seen); within a 1 M character budget (the instruments used longest ago go first), written at most every 5 s, a full storage shrunk and retried, never failing silently. |
| `absorptionHistory.ts` | The engine over the host's 10 s columns, one chunk at a time, through the column stream; the records behind the live book, keyed on the walls and not the numbers. |
| `absorptionHistoryStore.ts` | The history's judged hours of records in the browser, keyed on the engine version and the walls; the older engines' keys removed when it is made. |
| `absorptionPrimitive.ts` | The canvas layer: the ten-second feed, the records read at the rules in hand, layout, alpha, radius, the hollow broken sphere, the closes from the chart's bars, the store (flushed when taken off the chart), the twins by attack, what it asks the history for, and a historical grid's own feed, level and clock. |
| `absorptionMerge.ts` | The printed spheres merged by the chart's candle for drawing; the alpha rules. |
| `absorptionHover.ts` | A sphere in words, one print's or a candle's. |
| `absorptionColumns.ts` | Reading the columns as one sequence: a column's mid, the flow into a stretch of rows, the feed's reference. Shared with v2 and the first order-blocks indicator. |
| `absorptionWalls.ts` | Two constants the first order-blocks indicator still reads. |
| `AbsorptionSettingsModal.tsx` | The dialog. |

## Tests

`tests/absorptionSettings.test.ts` the rules on the heatmap's band and floor
against the style's own `paintFloor`, the band read the market's way, the
wall key, the three numbers and their clamps and steps, the record gates as
the sliders' lowest numbers, every number the sliders can ask for handed to
the engine, Session Levels' floor and share;
`tests/absorptionEngine.test.ts` the rule on a BTC-like fixture (the record
at the sliders' lowest numbers whatever numbers are in hand, each record
gate on its own, the yardstick at the first hit and no attack on a level of
0, the trail keeping the column each slider number is met at with the
newest reading kept apart, every one of the 9,108 settings read at its own
column from the update that reads it, capped at 256, a sphere that never
moves as the attack goes on, a small print's crossing drawn at once through
an hour of drips, a hole and a close that reopens the wall, the strong ring
from the same record,
the quiet spell, the record's end on a close and on a pull and a hole, never
deleted, pulled walls, a comeback as a new life, the sweep not credited, a
bar close ending a life, the band read the rules' way), `readPrint` (the
first qualifying entry, nothing below the numbers, the strong ring from the
newest reading and its minimum, broken by the window from the sphere's own
column) and the incremental tracker against the one-shot oracle, keeping
its records across the numbers and the break window, over a sliding tier, a
deep tier landing late and the deep tier alone; `tests/absorptionStore.test.ts`
add-only, a record growing (flow, trail, a newer reading, refills, end), the
week and the cap, nothing the cap let go taken back, a broken storage, only
whole records read back (the newest reading among them), `v8` with `v1` to
`v7` removed and a bare v6 list under the new key read as nothing, the 5 s
write throttle and `flush`, a record the tracker grows in place written at
each step, the budget (the set used longest ago first, one over it
alone cut to its newest whole columns, nothing let go taken back after a
reload either), a full storage (half the size, then kept to the size that
fit) and one refusing every write (one warning, no more writes, the records
still served); `tests/absorptionMerge.test.ts` the merge by candle, an attack
counted once, broken, the broken ones left out, the alpha;
`tests/absorptionPrimitive.test.ts` layout, alpha, the radius by the
yardstick, the ten-second feed, the hollow broken sphere, closes, a live
record never taken back, the twin window on the attack, what is asked of the
history, a slider change re-reading the records at once with the history
asked for nothing new and its run in flight untouched, the records filed
under the walls they were read with (another band, scale or row width loads
its own set, the first set back when its walls return), the store flushed
when the primitive is taken off the chart; and on #50's historical
(`DATABENTO`) grid: the saved records neither loaded nor written, the
grid's own feed read at its own clock, every change read at once, what a
live grid kept dropped when it is set, #50's one-second book read second
by second as the grid's own columns (level and median), the same sphere
whether the window ends a minute after the attack or ten minutes on, a
second the grid lacks read as it is with no window-wide level standing in,
a deep tier read the same way;
`tests/absorptionHistory.test.ts` twelve hours across midnight against one
continuous tracker with the closes, every field of the record; an hour the
same whichever view asked; a close through a wall ending it and one after
the sphere breaking it; waiting for the candles; timeframes apart, the walls
key, `covers` and the seam; the live tail carrying an attack on; a failed
hour; a run scrolled away from; the judged day kept across the numbers;
another row width; the History reach; an hour's records saved again with
what they became by the run's end; `tests/absorptionHistoryStore.test.ts`
hours of records with their trails round-tripped, the key on the engine
version, only whole records read back, the older engines' keys cleared
(also on a storage that cannot remove or whose remove throws); `../institutional-order-blocks-v2/tests/bandTracker.test.ts` the
hooks and the fold keeping the largest level and median of its seconds; `../../chart/tests/liveIndicatorExtras.test.ts` the three numbers'
defaults on load and the old floors let go; `tests/absorptionHover.test.ts`
the words; `benchmarks/mutations/prime-absorption-modular.json` a mutant per
guard.
