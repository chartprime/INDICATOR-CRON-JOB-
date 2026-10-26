# Session Levels

Today's killzone highs and lows and the NY AM opening ranges, drawn the way
Killzones draws its lines, each graded by what the order book did when
price came to it.

## The levels

A **range** has a start, an end, a high and a low, and comes from one of two
makers:

1. **Session range** -- a killzone occurrence on Agha's New York clock
   (`killzones.ts`: Asia 20:00-00:00, London 02-05, NY AM 09:30-11, NY
   Lunch 12-13, NY PM 13:30-16, RTH 09:30-16): the same start, end, high
   and low as his box, pinned by a test against `buildKillzoneOccurrences`.
2. **Opening range** -- NY AM's first 5, 15 and 30 minutes, each closed the
   moment its window closes, each in its own colour (amber, violet, green). A window the chart's bars cannot make is
   skipped (no five-minute range on a fifteen-minute chart), and a morning
   the chart joined after 09:30 gets no opening ranges. No other session
   has them.

A closed range gives two levels, its high and its low. Each is a solid line
in the range's colour from the range's first bar (09:30 for every NY AM
opening range, where its shading starts) to the first bar whose wick
reaches it, whatever the book then says: a level is a line up to the
moment price reached it, and the grading of that touch and of the ones
after it is in the text. Until price reaches it the line runs to the live
bar. When the 5-, 15- and 30-minute ranges share a high or a
low, each line takes over from where the previous window ended, so the
colour follows the time along the shared level (amber to 09:35, violet to
09:45, green from there, the session's colour from 10:00 if the session
made no new extreme). A level of its own price runs from 09:30 in full.
The range itself is shaded over its own bars at a faint
alpha of its colour (`SHADE_ALPHA` 0.04; three opening ranges overlap,
so Killzones' 0.12 came out heavy). Levels that read `Liquidity sweep`
can be hidden (`showSwept`): held and swept alike, since both carry that
word (`readsAsSweep`, used by the chips and the hover cards).

**Today only.** The moment a session opens again, its previous ranges are
dropped: London's levels of one day vanish at 02:00 the next and the new
ones appear at 05:00. Every level is fresh; nothing carries from an earlier
level at the same price.

**No sessions on the weekend** (2026-10-04). A session is built only while
the futures week is open (`futureSessionOpenAt`, the market calendar's
Sunday 18:00 to Friday 17:00 ET), on every instrument, crypto included: the
sessions are the trading week's, and a Saturday "NY AM" on BTC is not one.
Friday's ranges stay through the weekend, a weekend bar can still touch
them, and the next range is Sunday evening's Asia. Friday night's Asia
(20:00, after the close) is not built, so Thursday night's stays until
Sunday's.

The label is a chip: the draw kernel's rounded text card (`textBackground`,
`cornerRadius`), a white card at 92 % (the dark Order Blocks card made the
zone colours unreadable on the chart's light background), 11 px Inter,
with a stripe on its left edge and its text in the colour of the level's
range (`textAccent`, which colours both), the same colour as the line and
the shading, so the chip reads as part of its zone; the state is the word.
Each range's colour is a setting on the look tab, one per session and one
per opening window (`RangeColors`, keys `londonColor`, `orb15Color` and
so on, shown while that range is on), defaulting to Killzones' session
colours and amber, violet, green for the windows; the line, the chip and
the shade all follow it. A chip asks the kernel to paint its card after
the lines (`textOverLines` on the text box), so a chip a line runs through
stands in front of the line; every other box keeps the kernel's own order,
each card painted with its box, so a stronger zone painted later still
covers a weaker one's words. It sits above a high and below a low
(`textOffsetY` on the text box, the other field added to the draw kernel for
this; `TEXT_LIFT_PX` clears the card's half height and the line), over the
range's own bars, which by definition sit inside the range: `London.H`,
`ORB15.L`, followed by the book's reading once there is one. Each
label owns the time from where the previous range of its session ended to
its own end (`labelSpans`): NY AM's five-minute label sits over
09:30-09:35, the fifteen over 09:35-09:45, the thirty over 09:45-10:00 and
the session's over 10:00-11:00, so labels at one price never cover each
other and never run past the bars that made the range. When the full text
does not fit that width the draw kernel takes a shorter form
(`shortenLevel`: the name with the reading, the name with the verdict
alone, then
nothing), so zoomed out the chips shrink and then go before they can cross
a candle. The rest of the reading (the wall before and after, the volume
through, the earlier tests) is for a hover tooltip, not built yet.

The words on the chip are the trader's, for retail readers (2026-09-25):
Held and Swept both read `Liquidity sweep` (a level that merely held is
a sweep to the trader), Absorbed and the breaks keep their names. An opening range is named for itself
(`ORB5.H`, `ORB15.L`), the New York open taken as read, and it does not
hang on the NY AM session's checkbox: every session's hours are
followed, and a session's own high and low are drawn only when it is
checked. Each opening range has its own checkbox.

## The hover card

Hovering a level's line (within eight pixels, over the line's own span)
opens the chart's black card with the range behind the level: its name
and clock span in New York time (`ET`, the hours the sessions are set
in), the biggest market buy and market sell, the total traded and the
CVD, all from the columns over the range's own bars (`rangeStats.ts`).
The total and the CVD sum the columns' per-row buy and sell volume. A
market order is read from the columns' fills (`prints`): the fills of
one market order all carry its one timestamp and side, so fills of the
same side and the same millisecond are summed as one order, across
prices and across columns, and the biggest sum on each side is the
card's number. Measured on the stores before choosing it (2026-09-28):
the biggest one-row one-column volume, the old number, overstated the
biggest trade up to eightfold (ES sell 2,800 against a biggest trade of
340), and a single fill understates a market order that sweeps several
prices (a BTC spot sell of 87 across 20 prices, 76 in its largest
fill). Two limits: a column keeps only its fills at or above the print
floor, so the smallest pieces of a sweep are not counted; and two
market orders on one side in the same millisecond read as one. The high and the low of a range show the
same card. The card is the same for every range, session or opening
range; a range the book does not reach reads "no book for this range",
and so does a range whose start is older than the oldest column the
book still holds, rather than a total and CVD over only its later part.
The card draws no conclusion from the four; the trader reads the CVD
against the candles himself.
The indicator hands the cards over through the runtime's `getHoverData`
(`sessionLevelsHover.ts`, one per drawn level, a hidden sweep left out);
the chart panel hit-tests and draws them the way it does an FVG zone
(`components/chart/sessionLevelHoverData.ts`), under a whale, a wall, an
absorption sphere, a bubble or an FVG zone, over the Book Map.

## What the book did

Each level carries a status (`levelStatus.ts`):

- **Untested** -- no bar has reached it since its range closed. The text
  shows the resting size in its band from the bar's last column:
  `ORB15.H · resting 1.2k BTC`, refreshed once per chart bar. The
  most it held is kept (`peak`) for the tooltip; a band read empty after
  it held size shows `resting 0`, since after a runtime restart the far
  book is empty for a minute while the shallow snapshot fills back in.
- **Testing** -- a bar's wick reached the level. The window opens at the
  first column of that bar whose mid reached the band (the bar's open if
  only the wick did) and runs 5 clock minutes; the text says `Testing`
  and nothing else until the columns reach the window's end.
- **The verdict** -- Held, Absorbed, Swept, Weak break or Strong break, by
  the window rules below, with one reading whatever the verdict: what
  traded at the level or beyond it in the window, the attacking side first
  (market buys at a high, market sells at a low) and the other side after
  it (`Swept · 196 BTC sold / 200 bought`, `Strong break · 1.3k BTC
  bought / 380 sold`, `Held · 12.0 BTC bought / 0 sold`). Both sides,
  because the flush that showed the problem on 2026-09-25 (400 BTC through
  London's low and back in five minutes) was 196 sold against 200 bought:
  the buyers under the level are why it came back. The band's own volume
  is the absorption test's alone and is not written: that flush read
  `Swept · hit 7 BTC` because price spent seconds in the band. It is final, and it is the level's only reading: the trader's rule of
  2026-09-25 is that a level is what happened when price first wicked
  through it. The line ends there, the chip reports that window, and
  nothing more is read whatever the verdict. (Until then Held and Absorbed
  levels lived on and were tested again, which put a fourth test's Strong
  break on a chip beside a first touch that had held.)
- A window whose book caught under four fifths of what the candles say
  traded in it (`COVERAGE_SHARE`; the chart's candle volume prorated to
  the window against every buy and sell the columns hold) closes as
  `partial data · 43%` instead of a verdict. The runtime drops trades in
  bursts, 16% to 56% of a busy window on 2026-09-25, and a verdict on
  half the tape is a coin toss; the chip says so rather than guess. It is
  read again on every bar, like a no-book window.
- A window with no verdict yet, `no book` or `partial data`, is read again
  on every bar, the same first touch, until it gets one. The runtime sends
  the deep tier after a restart or a reload in chunks of 120 columns,
  oldest first, and only the first chunk marks a new book: read once at
  that moment, every window after the oldest few minutes was no book and
  stayed so (every level on 2026-09-25 after the runtime went to
  twenty-four hours, and some that afternoon). A decided verdict is never
  read again.
- A window the columns do not reach back to the start of (older than the
  browser's book, or the book arrived late) closes as `no book` rather than
  judge three minutes of five. A later touch does not replace it; the
  window is read again on every bar until the book reaches it (above).
- A verdict, once decided, is kept when the book is replaced by a new
  snapshot (a page reload, a deep-tier resync); only undecided and `no
  book` levels are read again. Otherwise every verdict would turn into
  `no book` as the browser's eleven hours slid past it.

## The five-minute window (`levelWindow.ts`)

`readWindow` reads the 10-second columns inside the window: what rested in
the wall's band before the first trade into it and at the end, the
aggressive volume traded into the level (buys into a high, sells into a
low, per row per column, in the band's rows on both sides of the level:
the fight happens under the level as much as over it), the aggressive
volume through the level (at it and past it), the other side's volume
there (the against), and the flow past the level with the break minus
against. A move past the band's far edge is seen both in the bars'
wicks inside the window and in the columns' mid, so a fifteen-minute chart
gives the same answer as a one-minute one.

| price at the end (last column's mid) | the book in those 5 minutes | verdict |
|---|---|---|
| inside | volume into the level at the floor and the share of what rested, the wall still over half | **Absorbed** |
| inside, went past the band | anything else | **Swept** |
| inside, never past | anything else | **Held** |
| out past the band | volume through the level at the floor and delta with the break at least `DELTA_SHARE` (a quarter) of it | **Strong break** |
| out past the band | anything less | **Weak break** |

The trader's call of 2026-09-25 on a NY PM high: 117 BTC bought just under
the level, 17 in the wall's band, 324 above it, price $68 through and back
inside within the five minutes -- that is an absorption to him, so the
attack counts both sides of the level and the run past it does not undo
it. The band's width (four rows, $16 on BTC perp) is the Absorption
Detector's wall width and thin for a level; it is a calibration number.

A wall price has gone past is gone by definition, so "eaten" is not a
condition of the break verdicts; the volume and the delta tell a wall
consumed from one pulled.

**Volume, not the columns' `prints`.** The columns carry a `prints` list,
but it comes from Binance's `@trade` stream, which is one record per fill:
a 40 BTC taker order arrives as several pieces (the largest single print in
a day's store was 17 BTC while the largest per-row volume in one second was
40). The per-row `buy`/`sell` volume in the same column holds every
order at that price, and it is what Aggressive Orders shows and what the
Absorption Detector's floor is calibrated on, so the window reads that.
The hover card's biggest market order groups the fills instead (above).

The wall is the resting size in the instrument's band of rows (`bandRowsFor`,
scaled with the timeframe as the Absorption Detector does): the asks at
and above a high, the bids at and below a low. The big prints are the
columns' own prints, every one at or above the print floor, on the
attacking side inside those rows; what rested is read in the column
before the first of them. The floor and the share are the Absorption
Detector's per instrument (a quarter of the wall on crypto, twice the wall
on the index and stock books), and the five minutes and the quarter of
delta are starting values; all of them get measured on the host's
recordings before they are fixed.

**When the book arrives.** The chart hands the bars over before the book,
and the indicator runtime replays only `l2` indicators when the book
arrives; Session Levels is a session indicator. So the indicator keeps its
own bars (`MAX_KEPT_BARS`, over a day of minutes) and reads the levels from
them the first time it sees the book, and again whenever the book is
replaced by a new snapshot (`feed.epoch`, the signal OB v2's tracker starts
over on) or its row width changes -- the undecided and `no book` levels
only; a decided verdict stays. Without that every bar already on the chart
would be read with no book.

## Bounds

- At most one occurrence per session, so `MAX_RANGES` is the six sessions
  plus the three windows; `MAX_LEVELS` 18 line and text slots plus 9 shade
  boxes, created once and reused.
- Per bar: one New York clock read, a pass over the kept ranges, and per
  level at most one column read while untested, or one walk over its open
  window's columns (thirty at 10 s) while Testing; a done level reads
  nothing.
- The same bar again (the open bar ticking) is read again from the bars
  before it; an older bar is ignored; an opening window the bars leave
  unfinished is dropped.
- Charts over thirty minutes are gated out, as Killzones is.

## Always a label (2026-10-04)

A closed window always shows a verdict word, from what there is. The
reading itself stays undecided (`verdict` null) when the book was
incomplete, so it is still read again and still asked from the host; what
the chip shows is `best`, the same rule run over what the window has:

- **A hole in the book, or under four fifths of the volume caught:** the
  verdict from the columns that are there, with the volume they hold.
- **No columns at all:** from the candles. A wick past the band with the
  window's last candle closing back inside is a `Liquidity sweep`; a last
  close past the band is a `Break` (weak or strong needs the flow, so it is
  not said); no volume is written.

The chip no longer says `no book`, `partial data` or `partial book
history`. The level's hover card does, in one line: `Label from the candles
alone: no book at this touch`, `Label from an incomplete book: a hole inside
this window`, or `Label from an incomplete book: 43% of the traded volume`.
The earlier sections describe those states; they still exist, on the card.

## A level or a range the page's book does not reach

The browser keeps at most 4,000 deep columns of 10 s (about eleven hours),
whatever the runtime sends, and less after a restart. A level touched
before that used to read `no book`, and its range `no book for this
range`. Both are now read from the host's stored heatmap columns
(`/heatmap/columns`), through the band store Institutional Order Blocks v1
uses (`lib/chart/bandHistory.ts`). A range lives a day, three over a
futures weekend, so everything asked is well inside the host's week.

- **A level.** Once its window has closed without a verdict (`no book`,
  `partial book history` or `partial data`), the level asks for the
  touching bar plus five minutes at 10 s. The page is cut on arrival: the
  flow whole, the book from the level's band to the mid, which is all the
  touch time and the verdict read. The same `touchTime` and `readWindow`
  then run over the answer.
- **Which reading shows.** A verdict from the page's own book is never
  replaced. Without one, the recording's verdict is taken; failing that, the
  recording shows when it has a book the page lacks or caught more of the
  trading.
- **A hole.** A stretch the host recorded nothing in is left out, not read
  as an empty book. Inside the window it leaves the reading undecided, and
  the chip shows the best verdict from the rest.
- **A range.** Its total and CVD come from one-minute columns over the
  range's own span, the flow alone. Checked against Binance's candle for
  09:30-09:35 ET on 2026-10-03: 22.1 BTC and +13.1, the same. The host's
  columns carry no fills, so a range read this way shows no biggest market
  buy or sell. Minutes the host did not record are left out and the card
  says how many (`book missing for 10 min`); only a range with no columns
  at all reads `no book for this range`.
- **No raw replay.** `band_history` returns only a band's rows, so it
  cannot serve either ask. When the host has no stored columns, fails three
  times or has stopped building, the ask rests ten minutes and tries again.
- **Bounds.** One ask per touched level and per range, 27 at most, each
  judged once per answer and kept while its level or range lives.

## Not yet

The biggest market buy and sell of a range read from the host: they need
the individual fills, which the Aggressive Orders tape holds. Pulled walls,
approaching and the 0-100 score are later steps.

## Files

- `sessionRanges.ts` -- ranges and the bar that first touched each level, from bars.
- `levelReader.ts` -- the band at a level and what counts as a touch.
- `levelWindow.ts` -- the five-minute window at one level, from the columns and the bars inside it.
- `levelStatus.ts` -- a level's life: untested, testing, verdict; the first touch only.
- `levelRecording.ts` -- what a level and a range ask the host for, and how the answer is read.
- `sessionLevelsRules.ts` -- settings, names, the text.
- `sessionLevelsRender.ts` -- levels onto line and text slots.
- `sessionLevelsIndicator.ts` -- the def: id `sessionLevels`, category
  session, overlay.
