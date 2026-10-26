# Exhaustion (runtime side)

One engine per instrument and chart candle length, fed the heatmap's deep
columns, one wire frame (`exhaustion_shades`, see
`docs/contracts/ws-frame-contract/v1/ws-frame-contract-v1.md`). The browser
draws what it is sent; it computes nothing of the shades (it catches the
legs it draws from its own candles with the same rule, `legCatcher.ts`).

## The rule (`exhaustion-engine.js`)

The same rule on every instrument and on every candle length the engine runs
(every chart timeframe, 1m to 1D, candles bucketed on UTC). Nothing is in
ticks, contracts or currency: price is
measured in the instrument's ATR, flow and prints against the leg's own rate,
the book against its own size at the extreme, windows in candles.

**Candles.** The 10-second deep columns fold into candles of the mid (the
midpoint of the two touches): open, close, high, low of the mid, the
aggressive buys and sells, the big prints per side, and the last column's
book. Only a column with a trade opens a candle, the way only a minute with
a trade has a candle on the chart. A column without a trade closes the
candle in progress when it belongs to a later one, and within two minutes
of the last trade it still moves the candle in progress; past that it is
ignored. The heatmap keeps sending the frozen book through every closure
(the CME break from 21:00 to 22:00 UTC, weekends, the equity overnight,
holidays), and none of it makes a candle, so the ATR leaves a closure as it
went in instead of wearing down on flat candles (that wear had the open's
first legs measured on an ATR at about half its size). A hole with no
columns longer than two minutes and longer than one candle, or more than
two candles skipped between one candle and the next, is a session gap: the
structure starts afresh and every shade still waiting is `interrupted`. So
the daily break cuts the legs of 30 minutes and under while the 1h candle
carries straight on across it, and a weekend cuts everything under 4h. From
4h up a hole of up to three days is not a gap, so a weekend does not cut a
4h, 6h, 12h or daily leg. Candles are bucketed on UTC (the daily opens at midnight
UTC). A candle drops its column once it has closed; only the flows, the
mid's OHLC and the bands read at the extreme stay.

**ATR.** Wilder's ATR(14) over those candles, the same as the chart's leg
catcher. Nothing is read before fourteen candles.

**Legs.** A zigzag on the mid in ATR: while no leg runs, the lowest low and
the highest high are tracked; a rise of three ATR (the ATR at that low) from
the lowest low starts a leg up at that low, mirror for a leg down. The leg's
extreme follows every new high; it ends when price pulls back three ATR (the
ATR at the leg's start) from the extreme, and the next leg starts at that
extreme. Every leg is judged; its size in ATR and its straightness (size over
the path of its closes from the start to the extreme) go on the wire with
each shade, and the chart's sliders decide which legs' shades are shown (the
defaults, eight ATR and half straight, are the measured rule).

**The zone.** At least two candles into a leg, at a candle close within the
last fifth of the leg's range. Nothing is read at any other close.

**The veto, first.** The pushing side's big prints (the heatmap's prints
floor) over the last two candles at or above the leg's per-two-candle rate:
not exhaustion. That is the absorption case; this indicator does not label it.

**Six readings**, yes or no, every one relative to the leg itself (the
pushing side is buyers on a leg up):

1. `rate`: the pushing side's volume over the last two candles, per candle,
   under half the leg's per-candle average;
2. `progress`: price gained over the last two candles per unit of pushing
   volume under half the leg's (size over its own volume);
3. `delta`: the last two candles' (own − other) / (own + other) under zero;
4. `divergence`: that delta weaker than it was over the two candles ending at
   the candle that set the extreme (never at the extreme's own candle);
5. `prints`: the pushing side's big prints over the last two candles gone, or
   under half the leg's rate;
6. `book`: at the extreme's candle the engine keeps three bands of half an
   ATR (at least two rows): the band just beyond the extreme, the biggest of
   the four bands beyond, and the band just behind on the pushing side; the
   reading holds from the next close on when the first is under 0.9 of what
   it was or either of the others under 0.75.

**Score and shade.** The score is how many of the six hold, 0 to 6. A shade
opens at the first zone close with a score of three or more and its strip
extends over the consecutive closes that keep scoring three; the first close
that does not ends the strip. The shade carries the highest score reached,
with the readings, their values (`values`, the six as ratios) and the sums
behind them (`raw`: the window's and the leg's volumes, the price moved, the
big prints, the two sides at the extreme, and the book band that decides the
reading now and at the extreme, in the instrument's units) of the close that
first reached it, so the numbers on the chart's card add up to the score.
The deciding band is the one furthest under its own line (its ratio over 0.9
or 0.75); `raw.bookBand` names it (0 the band beyond the extreme, 1 the
biggest deeper band, 2 the band behind) and `values.book` is its ratio.
The intensity bands the score (1 for 3, 2 for 4 to 5, 3 for 6). One shade per
extreme: a leg shades again only once price has made a new extreme beyond the
last shaded one; several shades of one leg can wait for their verdicts at
once.

**The verdict** has no window; it comes when the move is decided, whichever
way comes first. At the first shaded close the shade freezes the extreme as
it stood, the leg's ATR at its start and the leg's size. From the next candle
on: `broke` the moment a wick (the high for buyers, the low for sellers) goes
past that extreme by more than the tolerance, one and a half ATR or a tenth
of the leg, whichever is larger, stamped at the close of the candle that made
it, even while the strip still runs (the tolerance was one ATR until 10-11:
re-judging the 1,185 shades in the stores at one and a half turns 7 % of the
verdicts from broke to held, and those shades had overshot by a median 1.25
ATR and then came back a median 3.4 ATR, 63 of 81 at least half the leg;
broke verdicts come at most one candle later); otherwise the shade follows its running extreme
(the frozen one, pushed out by any wick inside the tolerance) and is `held`
the moment a candle comes back three ATR from it, the same comeback that
ends the leg, so a leg's reversal settles its shades held on that close. A
candle that sets a new running extreme cannot settle held, as in the zigzag.
`interrupted` by a session gap. Until the verdict the shade is `open` while
its strip extends, then `pending`, however long that takes: a shade in a
flat market waits until price either breaks or comes back. The rule is exact
against the hindsight question "did the move's final extreme stay within the
tolerance of the shade's extreme?": because the running extreme only moves
outward, both answers are final the moment they are read.

**Measured** (8 days, 9 instruments, 1m/5m/15m, every leg read, shades
shown at the chart's default eight ATR and half straight,
`Trading indicators/exhaustion-measurement/verdict-study/tables.md`, scripts
beside it): the verdict above agrees 100 % with the hindsight question on
1m (928 shades), 5m (73) and 15m (29) by construction, and settles faster
than the leg-length window it replaced: on 1m half the shades in 4 candles,
nine in ten in 14, the longest 64; on 5m 5 / 15 / 99; on 15m 4 / 17 / 25.
The window rule agreed 85 % on 1m and 83 % on 5m; almost every miss was a
shade that did mark the turn (the leg came back three ATR, then the next
leg took the extreme out inside the window) or a flush between one ATR and
a tenth of the leg before the comeback. Widening the tolerance alone stayed
under 87 %; the window was the error. On 1m the share that held rises with
the score, on even and odd days alike (at the one-and-a-half ATR tolerance,
the week's 914 shades): 3 → 57 %, 4 → 54 %, 5 → 60 %, 6 → 69 % (even/odd days
55/59, 49/57, 58/62, 71/67). Any close in the last fifth of a shown leg holds
53 % of the time, so 3/6 and 4/6 sit at the base and the edge is at 5 (+7)
and 6 (+16). The chart's label carries the per-shade
numbers. Median strip one candle. The earlier measurements
(`leg-measure-verdict.md` on the window rule, 40/43/47/63 %;
`leg-measure-candles-top.md` against the leg's final top, 50–76 %) judged
other questions. The aggression gate suggested from
outside read −2 (Binance) and −13 (dxFeed) and is not in the rule. 5m and 15m
hold too few legs on 8 days (dxFeed 5m is monotonic too, 25 legs; Binance 5m
is carried by a few long even-day legs and is not readable); they run on the
same rule, unmeasured, and the chart's accuracy label is the 1m one until the
host archive holds weeks. 2m, 3m, 30m, 4h, 6h, 12h and 1D run the same rule
too, unmeasured.

**Leg events.** The tracker tells a listener about its legs as it finds
them: `createExhaustionTracker({ candleMs, rowWidth, onLeg })` calls
`onLeg` with a frozen event at each change of the structure, `reset` (the
first candle, or a session gap), `start` (a leg out of no leg), `extreme`
(a new extreme of the running leg) and `flip` (a three-ATR comeback ends a
leg and starts the next at its extreme, with the pivot, its ATR and the
extreme so far), and `candleAt(index)` reads the candles the engine keeps
(the last 1,000). The events change nothing in the engine: a listener that
throws is not caught. Initiative Continuation
(`../initiative/README.md`) is built on them, so there is one leg rule and
one candle builder; its bands read the start of the leg this engine reads
the end of.

**The Candle Monitor** (`../candle-monitor/candle-monitor.js`) is not the
engine's: a counter per pair and candle length sums each candle's buys and
sells from the same deep columns and keeps the biggest buy and sell print
(the heatmap's big prints, about the largest two per cent of recent trades;
null when none of that side landed), one cursor per pair, bounded batches a
tick, all tracked pairs so a pair switch finds its last candles ready. A
candle closes on the first column of the next one; a candle joined part-way
(the first of each length after a start, `OPEN_SLACK_MS`) is never counted.
Once a second the last closed candle of every length is published for the
chart's pair as `candle_monitor` (latest state,
`server/candle-monitor-frames.js`, sent to clients that declared
`exhaustion_shades`). Nothing is stored: after a restart the short candles
close within the replayed tier, the daily waits for its first close.

## Indicator, store and channel

**History from the host.** At a pair's first tick the indicator reads the
host up to its own edge, without waiting for the heatmap. It finds the last
day of columns below that edge: a probe reads the host's hours newest first
(`liquidity.hostColumns`, the heatmap pyramid's `deepColumns` on the pair's
own rows, three reads in flight, `L2_EXHAUSTION_FILL_CONCURRENCY`) and
counts the hours that hold trades until it has a day of them
(`L2_EXHAUSTION_FILL_S`), walking past empty hours and hours of frozen
book, so after a weekend the day reaches back into Friday; it stops at the
age cap or at the last column the store says it fed (`coveredUntil`), and a
host with nothing at all is probed to the cap and read no further. From
the hour the probe named, the hours are read oldest first by
`exhaustion-history.js`, with the warm-up hours below it first (one for 1m
to 3m, two for 5m, five for 15m, eight for 30m), each hour read once and
handed over in order, never more than the reads in flight held in memory.
The hours feed the pair's own engines, one per candle length, short and
long alike, so a leg that started hours before is seen whole and one engine
judges each shade; shades judged on the host's columns carry
`origin: "host"`. When the read reaches the host's edge the engines are
live: from then on they take the heatmap's deep columns newer than the last
host column read, so a restored tier from before a stop is never replayed
and a tier the heatmap is still rebuilding is picked up the moment it
moves past that column; `liveSince` is the first deep column fed that way.
A day reads in a few seconds a pair. Until the read is done the pair
publishes nothing live and refuses asks. The first hour that fails ends the
read: the engines start at the deep tier's newest run, and only that run
counts as covered. The span is covered
from the hour the probe named when the read ran through; it joins the saved
coverage only when it reached the saved run's end, so a downtime longer than
the fill leaves a hole that an ask can fill later. One pair reads at a time,
the chart's pair first; the others wait for their turn. A host that answers
`NO_HOST` switches the fill off without a warning; `L2_EXHAUSTION_HOST_FILL=0`
switches the host read off altogether, the asks with it.

**History on demand.** A client asks for more with
`{ "type": "exhaustion_history", "from_ts": <epoch ms> }` (the chart sends
the start of its History span whenever the indicator is on, the span is not
Off and the runtime has answered, and again for a new runtime process; the
servers refuse an ask with other fields, a non-integer, negative or
out-of-range `from_ts`, with a warning). `requestHistory(pair, fromTs)`
clamps the ask to the age cap and refuses it while the pair's fill is still
reading or off, when the span is already covered (`coveredFrom`, the start
of the span the pair's engines have judged in one unbroken run up to the
live edge, saved with the store) or already asked deeper. The pass runs
behind the start fills, one at a time, the chart's pair first, and reads
the span a day at a time, the newest day first: the day just below
`coveredFrom`, then the day before it, down to the asked start, so the
trader sees yesterday land first. Each day is judged by fresh engines for
the candle lengths up to 30m, fed oldest first from the warm-up hours below
the day to the after-hours above it (one to eight hours by candle length,
never past the first live column), so a shade that starts inside the day and
settles just above it is judged; only settled shades that started inside
the day are handed over, with `origin: "host"`, kept as stored and saved,
a copy already live or already stored with the same verdict dropped.
`coveredFrom` moves down a day at a time, so the first hour that fails ends
the pass with the days it finished covered and the rest left for the next
ask; a finished pass has moved `coveredFrom` to the asked start, so the
next ask for the same span is a no-op. The long candle lengths get no
history from an ask. While a start fill or a pass reads, every frame
carries `loading` (the start of the span being read, `null` otherwise) and
each change resends the reset page: that is what the chart's
`EXHAUSTION · LOADING 1 DAY` badge and its legend read.

**Live.** `exhaustion-indicator.js` owns, per pair, one tracker per candle
length (an equity gets the lengths up to 30m only: the chart anchors its
longer candles to the session open, the engine buckets on UTC). Once a second
(`tick`) it takes the pair's deep columns newer than the last one fed
(`liquidity.deepColumnsAfter`, at most 1,000 a tick, so the deep tier the
runtime holds, four hours by default (`L2_HEATMAP_DEEP_S`), is replayed over a
few seconds) and pushes each through every tracker. `liveSince` on every
frame is the first deep column the engines took after the host read. Updates are mapped to the wire shape, kept by id (`live`), and
published through `server/exhaustion-channel.js`; `snapshot(pair)` is the
stored and live shades together in start order, what a joining client gets.

The store (`exhaustion-store.js`) writes `<pair>.exhaustion.json` atomically
under `<data root>/exhaustion`: the judged shades of the last seven days,
the whole state of each long candle length's tracker (its last 1,000 candles
without their columns, the ATR, the zigzag and the running leg, the shades
still waiting for their verdicts), `coveredUntil` (the last column fed once the engines are live; while the
fill still reads, the store's own value, so a save or a stop mid-fill loses
nothing) and `coveredFrom` (the start of the covered run). A restart
restores the long trackers where they stopped, serves their waiting shades as
`stored` until the live feed judges them, and reads from the host the hours
from the stop to the host's edge; the restored trackers ignore any column
they already saw. The short candle lengths start afresh, warmed by the same
read, which re-judges a shade left waiting at the stop. This is what lets the
long candles work at all: the host keeps seven days of columns, which is
seven daily candles, while the rule needs fourteen for its ATR and a leg on
top, so a 4h, 6h, 12h or daily tracker builds its history across restarts,
over weeks, and the daily cannot fire before about three weeks of data. A
store written without tracker state (or under another rules version) starts
the trackers afresh from the day the fill reads. Restored
shades carry `origin: "stored"`: the judged ones, and the waiting ones of
the long candle lengths, which the live feed settles; a stored shade of the same
candle length and side starting within one candle of a replayed live one is
the same shade and is dropped. A file written under another
`EXHAUSTION_RULES_VERSION` is refused (`STALE_RULES`), as is one that is not a
file, too large, unreadable, malformed or another pair's. A payload over
`MAX_EXHAUSTION_FILE_BYTES` is refused before anything is written.

A change of the heatmap's row width for a pair restarts its trackers and
its fill at the new width.

A background save marks the state clean only when it lands and nothing
changed after its payload was taken; a failed save leaves it dirty, so the
stop writes it; a save still in flight when `stop()` runs is superseded
before its rename, so the stop's own save is what the file holds.

## Env

| Variable | Meaning |
|---|---|
| `L2_EXHAUSTION` | `0` stops the engines and the Candle Monitor, which shares their timer; the channel still answers with empty pages |
| `L2_EXHAUSTION_HISTORY` | `0` keeps the shades in memory only |
| `L2_EXHAUSTION_HOST_FILL` | `0` switches the host read off: no start fill, no asks |
| `L2_EXHAUSTION_FILL_S` | how much of the host's columns a pair reads below the host's edge before its engines go live: the newest hours that hold trades adding up to this span, empty hours walked past (default one day; the age cap bounds it) |
| `L2_EXHAUSTION_FILL_CONCURRENCY` | hours of the host's columns the history walk reads at once (default 3) |
| `L2_EXHAUSTION_STORE_DIR` | directory of the history files (default `<data root>/exhaustion`) |
| `L2_EXHAUSTION_STORE_S` | seconds between background saves (default 300) |
| `L2_EXHAUSTION_MAX_AGE_S` | age after which a judged shade leaves the history (default 7 days) |

## Measured

- engine: the unit scenarios in `test/indicators/exhaustion/` run the
  rule on synthetic columns (`test/fixtures/exhaustion/columns.js`: thirty
  warm candles, a six-candle rise of eight ATR, two quiet candles with the
  asks beyond the extreme pulled); the contract corpus pins three frames per
  provider, a `candle_monitor` among them
- the measurement the rule came from, with the per-reading lifts and the
  confidence ladder, is kept outside the repo in
  `Trading indicators/exhaustion-measurement/` (`leg-measure.mjs`,
  `leg-measure-candles-top.md`, `leg-measure-candles-ended.md`,
  `leg-measure-verdict.md`)
