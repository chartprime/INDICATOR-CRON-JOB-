# Initiative Continuation (runtime side)

One engine per instrument and chart candle length, fed the heatmap's deep
columns, one wire frame (`initiative_bands`, see
`docs/contracts/ws-frame-contract/v1/ws-frame-contract-v1.md`). The browser
draws what it is sent; it computes nothing of the bands.

A band marks the start of a price leg and states, as facts, whether that
start was driven: how efficient the move was, how its candles closed,
whether it burst out of a quiet patch, whether the pushing side owned the
delta, whether the pushing side's big prints were above the usual. There is
no verdict: nothing says whether the leg went on. It is the sibling of the
Exhaustion engine, which reads the end of a leg (its last fifth); this one
reads the beginning, on the same legs.

## The legs are Exhaustion's (`initiative-engine.js`)

`createInitiativeTracker` wraps an Exhaustion tracker
(`../exhaustion/exhaustion-engine.js`) and follows its legs through the
engine's leg events: `createExhaustionTracker({ candleMs, rowWidth, onLeg })`
calls `onLeg` with `reset` (the first candle, or a session gap), `start` (a
leg out of no leg), `extreme` (a new extreme of the running leg) and `flip`
(a three-ATR comeback ends a leg and starts the next at its extreme, with the
ATR at that extreme's candle), and `candleAt(index)` reads the candles the
engine keeps. So there is one leg rule: the candles of the mid folded from
the 10-second columns (only a traded column opens a candle), Wilder's
ATR(14), the three-ATR zigzag on highs and lows, session gaps that start the
structure afresh, every chart candle length bucketed on UTC.

The hook was chosen over lifting the candle builder and the zigzag into a
shared module: it adds fourteen lines to the Exhaustion engine and changes
none of its behaviour (its tests are unchanged, one test was added for the
events), while a shared module would have moved the engine's candle and
zigzag code, its saved state and the mutants anchored on it. The cost is
that each Initiative tracker runs a whole Exhaustion engine, so the readings
Exhaustion computes for its own shades are computed a second time here and
dropped.

## The rule

**When it fires.** Once, at the flip: the candle where the engine itself
declares the new leg. The new leg's pivot is the old leg's extreme
(`pivotTs`, `pivotPrice`) and `atr` is the ATR at that pivot candle. The
first leg after a warm-up or after a session gap comes out of no leg (a
`start`) and is not a band. Nothing is published before the flip: measured,
a third to a half of the moves that reach two ATR never become a leg, and
waiting for the flip costs a median of one or two candles.

**The window.** The new leg's candles from the one after the pivot to the
flip candle, inclusive (`windowCandles`, a median of three or four). The
facts are read at the flip candle's close (`frozenTs`, `frozenPrice`) and
never change after it.

**The typical.** The pivot candle and the candles before it, four hours of
them: `max(12, round(4 h / candle length))`, so 240 on 1m, 48 on 5m, 16 on
15m and 12 from 30m up. Without twelve of them there is no band (the engine
keeps its last 1,000 candles, so a pivot older than that gives none either).
The typical may reach across a session gap, as the measurement's did. A rank
is the share of typical candles strictly below the window's value.

**The five facts**, each yes or no with the number it came from:

1. `efficiency`: the move from the pivot to the flip close over the path of
   the window's closes, starting from the pivot price; yes at 0.7 or more.
   `null` when the window's closes never left the pivot price.
2. `closes`: how many window candles closed in their strong third (the top
   third of the candle's range on an up leg, the bottom third on a down
   leg; a candle with no range is never strong); yes when at least half the
   window.
3. `burst`: the window's per-candle volume over the per-candle volume of the
   candles just before the pivot, as many as the window has and at least
   three, ending at the pivot candle; yes at 2 or more.
4. `delta`: the pushing side's share of the window's aggressive volume
   (`share`), ranked among the typical candles' per-candle shares of that
   side (`rank`); yes at a rank of 0.8 or more.
5. `prints`: the pushing side's big prints per window candle (`perCandle`,
   the heatmap's prints floor, the same source Exhaustion reads), ranked
   among the typical candles' per-candle big prints of that side; yes at 0.8
   or more.

Two choices in these facts are the measurement's, kept on purpose:

- **A rank compares the window with single candles.** `delta` and `prints`
  rank the window's value (its share, its big prints per candle) among the
  typical's single candles, not among windows of the same length, because
  that is the comparison the measurement made. Where the typical is mostly
  zeros it is generous: on 5m, with 40 of 48 typical candles holding no big
  print, one print in a three-candle window is 0.33 per candle, ranks 0.83
  and counts. For `delta` it runs the other way: a share over several
  candles spreads less than single-candle shares, so a longer window needs
  a more one-sided tape to reach the top fifth. Ranking against windows of
  the typical with the window's own length would compare like with like; it
  has not been measured.
- **The quiet before ends at the pivot candle**, the old leg's extreme and
  often its heaviest candle: a driven start has to out-trade the turn it
  came from. With a window of three candles or fewer the pivot is a third
  of the baseline, so `burst` is harder to reach right after a heavy turn.

`score` counts the yeses, 0 to 5. `dominant` is the side with the larger
aggressive volume in the window and `dominantShare` its share, a fact for
the card; the chart colours a band by the leg's direction, since a window
split 50.5 to 49.5 is not a side. Numbers go on the wire rounded to three
decimals.

**After the flip** only the leg can move a band: `legExtremePrice` and
`legExtremeTs` follow the new leg's running extreme, and `legEndTs` is set
when the engine ends the leg, at the candle of the next flip or at the first
candle after a session gap. Each move is an increment; the facts never
change.

Guards that cannot fire were left out: the ATR at a flip is always ready
(the zigzag needs it to flip), and every candle has volume (only a traded
column opens one), so the window and the typical never divide by zero.

**Measured** (two weeks of the host's columns, nine markets: BTC and ETH
perp and spot, NQ, ES, AAPL, TSLA, NVDA; October 2 to 9 in sample, 9 to 14
out of sample; `Trading indicators/initiative-measurement/`, outside the
repo, scripts beside the results). Continuation, for the measurement only:
the new leg reaches six ATR from its pivot before the engine ends it. At the
leg's start on 1m, against a base of 37 % on crypto and 34 % on futures and
stocks, in points:

| fact | crypto | futures and stocks |
|---|---|---|
| efficiency at 0.7 or more | +12 | +9 |
| strong closes | +7 | +10 |
| burst out of quiet | +8 (fires 11 %) | +8 (fires 4 %) |
| delta in the top 20 % | +5 | +5 |
| big prints in the top 20 % | +2 | +5 |

The score ladder 0 to 5 on 1m: crypto 25 / 32 / 36 / 39 / 40 / 53 %,
futures and stocks 24 / 27 / 33 / 37 / 45 / 50 %, the same on even and odd
days and in the out-of-sample week. On 5m and 15m efficiency, closes and the
burst get stronger (+14 to +33) while delta and prints go weak. Raw volume
against the typical and a quiet patch on its own were measured and dropped
(no lift). 1h and up hold too few legs in two weeks: they run the same rule,
unmeasured.

## Indicator, store and channel

**History from the host.** At a pair's first tick the indicator reads the
host up to its edge, the same walk as Exhaustion's
(`initiative-history.js` re-exports `readHours` and `probeBack` from
`../exhaustion/exhaustion-history.js`): the hours probed newest first until a
day of traded hours is found (`L2_INITIATIVE_FILL_S`, empty hours and
frozen books walked past, stopping at the age cap or where the store says
the last run stopped), then read oldest first from that hour, three reads
in flight (`L2_INITIATIVE_FILL_CONCURRENCY`), into the pair's own engines.
Exhaustion walks the same hours for the same pair at the same time, and
each walk asks again for the hours its probe already read, so the host
would answer four times for one hour. The pyramid warm-up
(`l2-memory/pyramid/pyramid-warmup.js`) keeps the host's encoded
five-minute windows for ten minutes, 64 MB at most (only windows the host
built `COVERED`: a `PARTIAL` one is rebuilt once its capture lands, so it
is read again), and shares a read in
flight between asks for the same windows, so an hour reaches the host once
and the other asks decode it from memory (13 to 19 ms an hour). Measured on
a simulated start of nine pairs, both indicators reading a day of traded
hours each (`Trading indicators/initiative-measurement/start-host-reads.cjs`,
outside the repo): 1,098 hour-walks cost 342 host reads instead of 1,098,
with a working set of about 62 MB when every pair's windows weigh what BTC
perp's do (100 KB each; NQ 50 KB, TSLA 11 KB); half the budget would cost
441. The warm-up's stats report `cachedWindows`, `sharedWindows`,
`keptWindows` and `keptBytes`.
The warm-up hours below the read are Initiative's own, so the typical and
the ATR are there before the first band: five hours for 1m to 3m, six for
5m, nine for 15m, fourteen for 30m (Exhaustion's are one to eight). Bands
read on the host's columns carry `origin: "host"`. When the read reaches the
host's edge the engines are live and take the heatmap's deep columns newer
than the last host column; `liveSince` is the first of them. One pair reads
at a time, the chart's pair first. A host that answers `NO_HOST` switches
the fill off; `L2_INITIATIVE_HOST_FILL=0` switches the host read off.

**History on demand.** `{ "type": "initiative_history", "from_ts": <epoch ms> }`
(the chart sends the start of its History span once the indicator is on,
the span is not Off and the runtime has answered, and again for a new
runtime process; a malformed ask is dropped with a warning). The span below
the covered start is read a day at a time, the newest day first, by fresh
engines for the candle lengths up to 30m, fed from the warm-up hours below
the day to the after-hours above it (one to eight hours by length, never
past the live start). The bands whose pivot lies in the day are handed over,
`origin: "host"`, kept as stored, a band already live skipped. A band whose
leg still runs where the day's read ends is handed over with
`legEndTs: null`; no engine follows it afterwards, so its leg stays where
the read left it (the chart's rest-of-the-leg outline stops at its last
extreme). `coveredFrom` moves down a day at a time; the first hour that
fails ends the pass with the days it finished.

**Live.** `initiative-indicator.js` owns, per pair, one tracker per candle
length (an equity gets the lengths up to 30m only, as Exhaustion's). Once a
second it takes up to 1,000 of the pair's deep columns newer than the last
one fed and pushes each through every tracker; changed bands go out through
`server/initiative-channel.js` as one increment, idempotent by id.
`snapshot(pair)` is the stored and live bands in pivot order. A band keeps
the origin it was first seen under: a stored or host band moved later by the
live feed stays stored or host, so History Off (the runtime's own bands)
never shows a band born before this runtime process started. Live bands are
capped at 4,000 a pair; the oldest leaves first, the evictions are counted
(`stats().evicted`) and the first is logged.

**The store** (`initiative-store.js`) writes `<pair>.initiative.json`
atomically under `<data root>/initiative`: every band of the last seven days
(counted from its frozen candle), `coveredUntil` and `coveredFrom` as
Exhaustion's, and the state of every candle length's engine, each with its
open band. Exhaustion keeps only its long lengths' engines and rebuilds the
short ones from the warm-up read; here every length is kept, because a
band's leg can run on long past the warm-up hours, and a short engine
rebuilt from them would never see the open band's flip again, so the band
would never get its leg's end. A restart continues each engine where it
stopped and the host read fills the downtime; an open band, saved in the
list and in its engine's state, comes back once, from the engine,
`origin: "stored"`, and goes on moving. A restore gives the chart's pair a
fresh page, so a client that joined before the first tick gets the stored
bands. A saved engine state that is refused (another candle length or row
width, another `EXHAUSTION_RULES_VERSION`, a band in it that is not a band)
or that breaks the reader restarts that engine afresh with a warning; the
stored bands stay. A file written under another `INITIATIVE_RULES_VERSION`
is refused (`STALE_RULES`) and the pair starts empty, as is a file that is
not a file, too large, unreadable, malformed or another pair's. A change to
a band's shape must bump `INITIATIVE_RULES_VERSION`; so must a change to the
legs themselves, since a bump of `EXHAUSTION_RULES_VERSION` alone restarts
the engines but keeps the stored bands. A payload over
`MAX_INITIATIVE_FILE_BYTES` (8 MB) is refused before anything is written.
Saves run in the background every `L2_INITIATIVE_STORE_S`, mark the state
clean only when they land with nothing changed since, and are superseded by
the stop's own save.

A change of the heatmap's row width for a pair restarts its engines and its
fill at the new width.

## Env

| Variable | Meaning |
|---|---|
| `L2_INITIATIVE` | `0` stops the engines; the channel still answers with empty pages |
| `L2_INITIATIVE_HISTORY` | `0` keeps the bands in memory only |
| `L2_INITIATIVE_HOST_FILL` | `0` switches the host read off: no start fill, no asks |
| `L2_INITIATIVE_FILL_S` | how much of the host's columns a pair reads below the host's edge before its engines go live: the newest hours that hold trades adding up to this span (default one day; the age cap bounds it) |
| `L2_INITIATIVE_FILL_CONCURRENCY` | hours of the host's columns the history walk reads at once (default 3) |
| `L2_INITIATIVE_STORE_DIR` | directory of the history files (default `<data root>/initiative`) |
| `L2_INITIATIVE_STORE_S` | seconds between background saves (default 300) |
| `L2_INITIATIVE_MAX_AGE_S` | age after which a band leaves the history, counted from its frozen candle (default 7 days) |

## Files

| File | Role |
|---|---|
| `initiative-engine.js` | the tracker: the wrapped Exhaustion engine, the typical, the five facts at the flip, the open band's leg, its state for the store |
| `initiative-indicator.js` | per pair: the trackers, the host fill, the history pass, the live tick, the store, the snapshot |
| `initiative-store.js` | the history file: atomic writes, the size cap, the rules version |
| `initiative-history.js` | the warm-up and after-hours per candle length; the host walk itself is Exhaustion's |
| `../../server/initiative-frames.js` | the `initiative_bands` builder: 18 band fields, the bounds and the cross-field rules |
| `../../server/initiative-channel.js` | the opt-in channel (`initiative_bands`), the snapshot pages, the `initiative_history` ask |

Tests: `test/indicators/initiative/`, `test/server/initiative-*.test.js`,
`test/contracts/initiative-*.test.js`; fixtures in
`test/fixtures/initiative/candles.js` (bars built from four columns a
minute) on top of Exhaustion's column fixtures.
