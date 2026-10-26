# Flowprint Blocks

Boxes over the price ranges price pushed through fast, with the volume that
traded on the way. What stays on the chart is a quick move through a thin
book. Two rules decide which pushes are drawn, picked by **Thresholds** in
the dialog: **Fixed** uses a set move and a maximum traded per market;
**Learned** learns the move from the market's own recent trading, for the
chart's timeframe, and keeps a maximum traded. The choice is kept per market
class: the index futures (NQ, ES and their micros) start on Learned,
everything else on Fixed, and the dialog shows only the current market's
choice. Under Learned a **Maximum Traded** slider appears, saved per
instrument, starting at the market's own maximum (below), and the Window
field, which only Fixed uses, is hidden.

The indicator was called Liquidity Voids while it was built, then Order Flow
Gaps; the code keeps the first name (`liquidityVoids`, this folder, the saved
settings key) so saved settings carry over.

## The push

Every lane-0 column (1 s live, 10 s in the deep tier and from the host) is a
sample of the mid, read from the touch. Each new column is compared with the
newest sample at least one window older. When the mid moved at least
`minMoveRows` rows, the rows crossed become a box on the side the move ran
into: a push up swept asks, a push down swept bids. A later window that keeps
moving the same way while the box is open extends it; a move the other way
starts a new box. Under a tier coarser than the window (the 10 s deep tier
under a 5 s window) the window's start sample is kept, so each column is
compared with the one before it. A hole of more than two column spacings and
more than twenty seconds resets the reference, so no box spans missing data;
the runtime's short skips of a few seconds in the 1 s tier do not.

The **volume** of a box is the aggressive volume of the side that drove it
(buys for a push up, sells for a push down) that printed in the rows crossed,
over the columns of the push, from its start up to its end. It is unknown
when any column of the push carries no flow (see below). The model keeps ten
minutes of columns; a push that runs longer keeps the prints of the columns
it lets go, by row, so its volume still counts from its first column.

A box ends only when it is **mitigated**: a later bar closes beyond its far
side (below the box after a push up, above it after a push down). No bar that
holds any part of the push can mitigate it. The model keeps the newest 64
boxes.

## Thresholds: Fixed

The window is `windowS` seconds (30 by default) on every timeframe.
`minMoveRows` is the minimum move divided by the row width, rounded, never
under two rows. The minimum move comes from **Sensitivity**:

- a base per instrument on the 1-minute chart: BTC 30 USD, ETH 1 USD, NQ 22
  ticks, ES 6 ticks, anything else 2 bp of price (in ticks for a future whose
  tick the catalog has);
- High is the base, Normal is 50/30 of it, Low is 70/30 of it (on BTC: 30, 50
  and 70 USD); Normal by default;
- scaled with the chart timeframe by `1 + 0.3 × log2(minutes)`, to one
  decimal: ×1.7 on 5m, ×2.2 on 15m, ×2.8 on 1h, ×3.4 on 4h, ×4.1 on 1D.

**Maximum traded** is always applied: a box that traded more than three
Aggressive Orders bubbles of the instrument, or more than 100 contracts on NQ
and 300 on ES, scaled by the same timeframe factor, is not drawn (BTC perp:
30 BTC on 1m, 84 BTC on 1h; NQ 170 contracts on 5m). A box whose
volume is not known yet is held back while its columns are still on the
chart, so it never appears and then vanishes when its volume lands; a box
whose columns the chart has already dropped can never get a volume, and is
drawn without one. A box that started before the oldest column the chart
still holds survives a re-read until a close mitigates it.

Measured on a week of the host's columns (2026-09-28 to 10-05), when the
maximum was still three bubbles on NQ and ES (15 and 60 contracts): every
push in the US cash session traded more than it (the median NQ push 295
contracts, one in ten under 115), so the Fixed rule drew nothing there on any
timeframe; hence the set numbers on the indexes. On NVDA the maximum is 0, so
it never draws.

## Thresholds: Learned

No number per instrument and none per timeframe. The **window** a push is
measured over follows the chart: 30 s on 1m, 90 s on 5m, 3 min on 15m, 8 min
on 1h, 20 min on 4h, 70 min on 1D; any other timeframe gets
`30 s × minutes^0.68` rounded to the 10 s column (50 s on 2m, 60 s on 3m,
5 min on 30m, 27 min on 6h, 44 min on 12h). The Window field is hidden.

A push is drawn when three things hold.

1. **It moved far enough.** Its move over one window is at least *k* times
   the market's usual fast move: the 90th percentile of its moves over one
   window, sampled every 10 s, over the last 60 windows of trading. *k* is
   Sensitivity: High 1, Normal 1.25, Low 1.5.
2. **Little traded during it.** Its volume is divided by what normally
   trades in the same time: the median traded volume per second over the
   last 30 minutes of trading, times the push's duration (never under 10 s).
   On a thin market, where more than half of those 10 s slots traded
   nothing, the median is zero and the mean is used instead.
   The push must be among the lightest 25 % of the last 60 pushes on that
   measure. Thirty minutes, on every timeframe, so that a session's pace
   replaces the last one's within half an hour: with a memory of 120
   windows (16 h on 1h) the US cash session on NQ got no boxes on 1h, every
   push there looking heavy against the overnight pace.
3. **The market has enough data.** The usual fast move needs 30 windows of
   moves, the normal volume 60 samples, the ranking 8 earlier pushes. After
   an open, a weekend or a hole longer than both two windows and ten
   minutes, no new push is measured until 3 windows of fresh data exist; a
   push still open when the hole began is judged at the first column after
   it.

Every memory is counted in trading data, never in clock time: nights,
weekends and closed sessions do not exist for the rule, so a stock at 9:30
continues from the previous session. The usual move and the normal volume
are refreshed every minute, or every half window on 15m and slower, so a push
is judged against memories at most a minute old up to 5m and half a window
old above. The refresh runs on the clock (whole minutes, or whole half
windows, from the epoch), not from the run's first column, and the mean
adds the memory's values in sorted order, so two runs over the same columns
hold the same numbers to the last bit. The learned minimum move is never
under two rows.

A push is **judged once, when it ends**: the first column where the move over
the window has fallen back under the minimum, up to one window after its
last new ground. Until then it is not on the chart. A heavy push, one of the
first 8 pushes and a push whose volume is unknown are dropped from the model
and never appear. A light push that traded more than the instrument's
**Maximum Traded** slider is not drawn either; the slider starts at the
market's maximum (above: 100 contracts on NQ, 300 on ES, three bubbles
elsewhere), reaches ten times it, and scales with the timeframe like the
Fixed maximum.

The status card says **More data needed** while the market has not enough
data for the chart's timeframe: expected for a stock on 4h and 1D, which
trades about 30 hours a week where the 1D rule needs 35 hours of moves, and
on a market where nothing traded at all over the last 30 minutes of trading.
It says **Loading history** while the host's columns are still arriving
(below).

Measured on the same week, boxes per open hour on High (Normal is about 60 %
of it, Low about 40 %):

| Chart | Crypto | NQ / ES | Stocks |
|---|---|---|---|
| 1m | 4.6 to 5.1 | 4.9 to 5.8 | 4.3 to 4.8 |
| 5m | 2.3 to 2.8 | 2.9 to 3.0 | 1.9 to 2.1 |
| 15m | 1.6 to 1.8 | 1.9 to 2.0 | 0.9 to 1.5 |
| 1h | 0.9 to 1.0 | 1.2 to 1.3 | 0.4 to 0.7 |
| 4h | 0.7 | 0.6 to 0.7 | 0.0 to 0.2 |
| 1D | 0.1 to 0.3 | 0.2 | 0 |

A box is about 2 candles tall on 1m, 1 on 5m, 0.7 on 15m, 0.5 on 1h, 0.4 on
4h and 0.25 on 1D. Cost: 5 to 35 µs per column; the whole run with 48 hours of
History rebuilds in 0.1 to 0.3 s on 1m to 15m and about 0.6 s on 1D (NQ,
2026-10-07).

## The box

From the bar holding the push's start to the live bar (both edges on bar
times, the right edge extended to the pane), over the rows crossed, in the
side's colour (`askColor`, `bidColor`). The label sits in the box's
lower-right corner, in the text style of Institutional Order Blocks:

`FPB Ask · 8m`

- the side;
- the time since the push ended.

The side alone is used when the box is narrow. Until 2026-10-12 the label
also carried the move (`+$48`, `-38 ticks / -9.5 pts`) and the aggressive
volume behind it (`3.20 BTC bought`); the volume still decides which box is
painted in front and what Maximum Traded hides, it is no longer written. A label that would have to
leave its own box to clear another one is hidden rather than drawn outside.

At most `boxesPerSide` boxes (3) are drawn on each side. **Keep the Levels**
picks which: Nearest to Price (default) or Furthest from Price, the newest
first among equals. Where boxes overlap, the one that traded least is painted
in front.

## The spread readout

A small table in the lower-right corner, above the time axis and clear of the
price axis: `Spread  $40 · thin book`. The number is how far price has to
travel through the book to fill one Aggressive Orders bubble (10 BTC on BTC
perp): the rows from each touch until the resting size covers it, averaged
over the bid and the ask, times the row width; a side that never covers it
counts all its rows. It is judged against the median of the last hour of
columns: above 1.5× is a thin book (red), under 0.5× a thick book (green),
anything else normal. It shows a dash before sixty samples, before the engine,
while the feed is stale and, under Learned, until the first stretch of
history is judged.

## Where the data comes from

The price path comes from the lane-0 columns of `ctx.liquidity`; the prints
come from the engine's `trade` events, never from the columns. The columns
lose the trades that arrive after their second was taken, most of them in
exactly the bursts this indicator looks for: on 2026-10-02, over 54 s of live
BTC perp, the trade tape carried 25.38 BTC, the engine's events 25.06 BTC
(99 %), the 1-s columns 9.22 BTC (36 %).

So the indicator keeps an `EngineAbsorptionTracker` built with
`bareUncovered`. Its `columns()` hands the model the columns with the events'
prints in place of their own, up to the engine's last frame; a column the
events do not cover (before the first frame, or in a gap of the event ring)
comes back with no flow, and the volume of a box over it is unknown.

For the time before the page opened, the indicator asks `l2.eventHistory`
through `backfillEventHistory`: newest first, in 15-minute chunks of at most
10 pages, 250 ms apart, a refused chunk retried up to 5 times with a growing
pause, and the coverage only ever grows without a hole. Every answer says
from where the runtime holds the asked trades without a hole
(`trades_held_from`); the coverage stops there, so an empty answer from
before the runtime's memory leaves those columns unknown instead of reading
as nothing traded. One fill runs per instrument and row width; it is kept
across settings and timeframe changes (for the four pairs used last), asked
again when the chart holds older columns, paused 10 s after a fill that ended
short or threw, and 60 s after one that reached the end of the runtime's
memory.

Nothing is read while `ctx.l2` is absent, not `LIVE` (Historical Mode) or not
`trusted()`; a status card says which. Columns are read once: a new grid, row
width, event coverage or timeframe re-reads from the oldest column the chart
holds; every later bar reads only the newer columns, and no bar reads past its
own end. The closes already seen are re-applied after a re-read, so a
mitigated box does not come back. A feed ten minutes behind the bar reads
`stale` and hides the boxes.

## The past, from the host's columns

With **History (hours)** above 0 (48 by default, up to 168) the pushes from
before the page opened are read from the host's stored 10 s columns, which
held 92 % of what traded where the runtime's event history held 69 to 79 %
(2026-10-03). The indicator asks a fork of the column stream
(`voidsPast.ts`) up to the seam: the moment the engine's live events start,
which is when the page opened. The host's columns are kept slim (touch rows
and flow) per instrument and row width. An hour that stopped more than ten
minutes short of the seam is asked again once.

Under **Fixed** the ask starts History hours before the chart's oldest
column. The host's columns are replayed with the chart's closes in a state of
their own, so a settings or timeframe change judges again without a new
download; a push inside the chart's own columns but older than the live
events is judged from the host's columns, whatever the runtime's event
memory holds, and a live box that started before the end of the host's
columns is hidden so one push is one box.

Under **Learned** the ask starts a warm-up earlier still, 120 windows before
the History reach (four times that on a stock, whose session is a quarter of
the clock), so the first drawn push already has its memories; a slower chart
has a longer window, so switching to it asks the host for more hours. An
hour from before the host's oldest window is answered empty and counts as
asked, so a reach past the host's week does not keep asking.

Once every asked hour has arrived or failed, the host's columns and the
chart's own columns, from the host's last column on, are judged as one run
with the chart's closes in time order, so the live pushes are judged against
the memories the host's columns built. The run is built only on the bars the
chart draws (in a replay, the last closed bar and the live one), so it always
has every close. Boxes that ended inside the warm-up are not drawn. The run
is rebuilt when an hour lands or changes, when the grid or the row width
changes, and when the event coverage reaches columns the run read from the
chart; otherwise each new column is stepped once. The spread readout samples
every column the chart holds, as under Fixed.

While hours are still to come, the status says **Loading history** and only
pushes that the missing hours cannot change are drawn. The host answers
newest hour first, and a verdict depends on the pushes before it, so the
indicator judges the newest unbroken stretch of hours it holds, with the
chart's own columns after it, and draws a light push only once it is
**settled**: the run's memories were full at a refresh (60 windows of moves
and 30 minutes of volume), a column after that with a price had no push open,
and 60 pushes opened since then have been ranked. From that point the run's
memories hold exactly what the run over the whole history holds, so the hours
still to come cannot change a drawn push's rows, times, volume or verdict.
Nothing is drawn while the run already lacks the data to judge (once loaded
it would say More data needed). A box drawn while loading can still give its
place to another from an older hour, as the per-side pick does when price
moves: a nearer one, or a further one under Furthest from Price.

The stretch starts at its oldest hour with a column (an hour before the
host's oldest window adds nothing) and runs to the newest column the chart
holds. It is judged once it spans the memories plus sixty windows (about the
time sixty pushes take at one a window), again each time it has at least
doubled, when the event coverage reaches columns it read, and after a bar it
could not judge (the newest hour missing), so every close is applied.
Measured on NQ and ES against the runtime's host (2026-10-07, History 48 h):
the first box showed after 6 to 18 s on 1m and 5m, where loading every hour
took 60 to 65 s, and every box drawn while loading was the same box once all
hours were in.

## What the box does not claim

Measured on the recorded stores when the indicator was planned: on NQ and ES a
low-effort move crosses a thinner book than a normal move of the same size;
after the move, these pushes retrace like any move of their size.
The box marks where price moved through a thin book. It does not promise a
revisit.

## Files

- `sweepModel.ts`: the push detector, pure, one column at a time.
- `learnedThresholds.ts`: the learned rule: the window ladder, the memories
  in 10 s slots, the verdict at a push's end, and when a push is settled.
- `liquidityVoidsRules.ts`: settings, the Fixed per-instrument minimum move
  and maximum traded, the timeframe factor, the learned multiple and warm-up.
- `liquidityVoidsRender.ts`: the box and its label, the per-side pick, the
  maximum-traded filter, the paint order.
- `bookDepth.ts`: the spread readout.
- `liquidityVoidsIndicator.ts`: the `l2` indicator: feed status, event
  history, the Fixed and the Learned run, closes, drawing.
- `voidsPast.ts`: the host's columns for the past, kept slim, their replay
  under either rule, when every asked hour is in, and where the newest
  unbroken stretch of held hours starts.
- `liquidityVoidsSchema.tsx`: the dialog.
- `tests/`: fail-first tests; mutation specs
  `benchmarks/mutations/liquidity-voids-step1-sweep-model.json`,
  `liquidity-voids-step2-indicator.json`, `pr-39-review-fixes.json`,
  `l2-history-voids.json`, `pr-40-review-fixes.json`,
  `ofg-learned-thresholds-model.json` and
  `ofg-learned-thresholds-indicator.json`.

`source` stays `sweep`; `walls` is reserved for version 2.
