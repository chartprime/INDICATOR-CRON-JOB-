# Aggressive Orders (browser side)

One shaded sphere per aggressive market order, at the price and the moment it
printed, its area following the order's size, buyers in the bullish candle
colour and sellers in the bearish one. An L2 indicator in its own right,
beside the Passive Liquidity Heatmap, with its own settings. It infers
nothing: a big buyer bubble on an ask wall with price not moving is
absorption, and the trader reads that himself (the Absorption Detector draws
it when asked).

## The hover

The cursor on the core of a bubble (the middle third of its radius, never
less than three pixels, along the spine of a capsule) shows what happened
there: the side, the size in the instrument's unit (the coin on Binance,
contracts on a future, shares on an equity), the number of prints and the
price they filled at (`aggressiveOrdersHover.ts`). The rest of the sphere
stays quiet, so a hover over a cluster of bubbles answers for the one under
the cursor and not for every one it overlaps; the bubble drawn last (the
biggest) answers where cores overlap.

## Where the data comes from

The market-data hook receives every trade of the live instrument as a `trade`
frame with the aggressor's side, price and size (Binance from the buyer-maker
flag, dxFeed from TimeAndSale's aggressor side). The hook puts each print on
an `AggressiveTape` the moment the frame arrives, outside the batched flush
that feeds the candles; the tape tells its subscribers, and the chart layer
repaints once per animation frame, at most fifteen times a second. Nothing
waits for a bar, a heatmap column or the server.

The tape holds at most 250,000 prints and trims 25,000 at a time once it is
over, so a history reply never rewrites the whole array. Prints are deduped
by trade id, which is the same id the live path and the history path give the
same print.

## History: the server's pool in the snapshot, the columns, the collector for the rest

Like the Large Trade Detector's markers, the runtime keeps a pool of the
pair's biggest prints over the last four hours (`server/aggressive-pool.js`):
warmed from the collector's recording when the pair warms up (the newest
fifteen minutes at no floor to calibrate, then hourly chunks back at that
floor), fed live from the trade stream, capped at 20,000 with the smallest
dropped first, and shipped in every `snapshot` as `aggressive_prints` with the
floor it is complete from and the moment its coverage starts. `useMarketData`
lays it under the tape by trade id and counts its span as history received,
so the bubbles are there on connect, before any request. Over its cap the
tape sheds small prints before big ones, so a flood of tiny prints never
pushes the pool's history out.

### The columns and the collector

Since 2026-09-14 every heatmap column carries the biggest prints of its
second (`prints`, complete from `prints_floor` up) and the traded volume per
row (`buy`/`sell`), live and backfilled alike, so the bubbles' history comes
with the heatmap on connect: `useMarketData` lays each column's prints under
the tape by trade id as it applies the frame. `historyRequestFor`
(`columnPrints.ts`) then counts the columns whose floor is at or under the
floor in force as history received and asks the collector only for the
stretches they leave uncovered, oldest hole first. The Absorption Detector
reads its attacks off the columns' own per-row flow and never off this tape,
so it asks the collector for nothing.

## History: the collector recordings for what the columns do not cover

Whenever the tape starts, the socket comes back after a drop, the floor
changes, heatmap columns land or the chart is scrolled, MainPanel works out
what is still uncovered at the floor in force (the trader's, or the
instrument's reference when the floor is automatic) between now and the
start of what the chart is showing -- never less than four hours back, never
more than thirty-one days (`historyWantedFrom`) -- and asks the server for
that stretch only, six hours at a time, the newest first (`HISTORY_ASK_MAX_MS`).
The server refuses a request longer than a day, and the host answers a long
window on an old day too slowly: measured 2026-09-23 on BTC spot at a 5 BTC
floor, a day ending 18 Sept 18:00 took 8.1 s and was refused, twelve hours
6.9 s, six hours 4.1 s. `historyAskWindow.test.ts` pins the piece under the
runtime's limit and at six hours. The visible range is
read from the chart, settled for 300 ms and rounded down to the hour, so a
scroll asks once, not once per pixel. The stretch since the live feed took
over (`liveSince` on the tape: the snapshot, or the first live print) is never
asked for, and an ask ending where the last one at that floor ended is not
repeated for thirty seconds while its reply is due: the server admits sixty
requests a minute per client and refuses the rest as OVERLOADED, which is what
"history busy, retrying" meant on 2026-09-14 when the page asked once a second
for the last second before now.

Every request the hook posts itself -- the next hole after a complete reply,
a capped page's continuation, a retry -- is noted on the tape as the last
ask, so MainPanel's own pass on the next heatmap frame sees it as due and
does not queue the same window behind it; the re-ask period (thirty seconds)
outlasts the runtime's wait on a host read of the print route (twenty
seconds, `TIMEOUT_MS_BY_ROUTE` in both remote readers, pinned by
`historyAskWindow.test.ts`). Measured 2026-09-23: a day of BTC spot prints
at a 5 BTC floor answers in 0.8-2.2 s for the four newest days, while every
older day is refused by the host after about 8 s, so the runtime's old flat
5 s timeout had read all of them as STORAGE_UNAVAILABLE. When the last retry
of a window fails, the hook gives that window up on the tape for ten minutes
(`HISTORY_GIVE_UP_MS`): the next ask skips it and takes the piece below, and a
scroll or a frame does not send the host the same hopeless read every half
minute. Giving up also clears the legend's history note: the note reports a
reply the page is still acting on, and once the last piece asked -- usually
the one before the chart's first candle -- has been given up there is nothing
outstanding, so "history unavailable" over a fully drawn chart would be
wrong.

A week of prints at the floor would overrun the tape, so a reply's prints
older than the four-hour raw stretch are thinned as they land to the four
biggest of each minute and side (`HISTORY_THIN_PER_MINUTE_SIDE`, the same
bucket rule the Large Trade Detector keeps its markers by), a later reply
into the same minute competing against what is already there; the last four
hours, the snapshot's pool and the columns' prints stay whole. Should the cap
still force the oldest prints out, the tape gives up its coverage of them
and stops wanting them, so they are neither drawn as history it has nor asked
for again.

The request is an `aggressive_history` message; the server answers with one
indexed query on the collector's SQLite, run on its storage reader's worker
thread, at most 20,000 trades per reply, newest part of the window first.
Every reply carries `complete` and a `reason` (contract:
`docs/contracts/ws-frame-contract/v1`), and the hook does one thing per
reason:

| reason | the hook |
| --- | --- |
| `null` (complete) | covers the window; then asks for the nearest hole below it, if any |
| `CAP_REACHED` | covers nothing; returns the opaque `next_cursor` with the unchanged window and floor until a terminal reply arrives |
| `CONVERSION_INCOMPLETE` | keeps the prints, covers nothing, asks for nothing more |
| `STORAGE_UNAVAILABLE`, `READ_FAILED`, `OVERLOADED` | covers nothing; retries the exact request, including its cursor; a server `retry_after_ms` takes precedence over bounded backoff |

Coverage is kept on the tape as intervals, each with the floor it was
answered at, merged only where they overlap or touch at the same floor, so
two windows with a hole between them never read as one. A question at a
floor is answered by coverage at that floor or a finer one: the snapshot's
pool (a floor of a fraction of a coin) covers its twelve hours for any ask,
a day answered at the trader's floor of 3 covers asks at 3 or above, and
lowering the floor to 1 asks that day again. Until 2026-09-23 the tape kept
one floor, the lowest seen, and treated a reply at a higher floor as
covering nothing; once the page asked beyond the pool at the trader's
floor, every reply was ignored, the same day was asked again on arrival,
and the server refused the loop at sixty requests a minute. A reply at a
floor other than the newest request's still lays its prints under the tape
but continues nothing. The coverage list is bounded (`MAX_COVERAGE_ENTRIES`,
the oldest shed first). The hook exposes
`aggressiveHistoryIssue` and the legend shows it ("history unavailable",
"history busy, retrying", "history partial"). History only exists while a
collector was recording: a collector outage is a hole.

The server bounds admission for the whole process (two reads at once, a
queue of 32, 60 requests a minute per client) and answers a refused request
with `OVERLOADED` rather than silence. Its own cluster tracker
(`liquidity.aggressive` on the wire) still runs; this layer does not read it.

## What is drawn

**Where a bubble sits in time** (`candleX`, `aggressiveOrdersPrimitive.ts`):
inside the candle the chart holds its print in, as far along the candle's
slot as the print is through the candle, with the candle's centre asked of
the chart's time scale. The chart's time axis is not time: a session break
is one bar wide whatever its length, so a line of pixels per millisecond
from the last candle (the first build) put every bubble before a break a
hole's width off its candle on NQ, and the ones before the daily break off
the pane. A print inside a break sits at the right edge of the candle before
it; one before the first candle is not drawn. The tape is asked for the time
scale's visible range, a candle each side.

- One bubble per aggressive order at least the floor big, the moment it
  prints, folded two ways:
  - a **sweep** (prints of one side with the same timestamp) is one bubble
    at its volume-weighted price;
  - a **run** joins a live cluster of its side when it lands within the
    cluster gap of the cluster's last print, within the maximum life of its
    first, and within the cluster width of the cluster's last price. The
    bubble is anchored in time at the first print and grows with every join,
    with a short pulse on the join. A run on one price is a sphere; one that
    walked the book is a capsule from its lowest print to its highest.
  Both sides are kept, nothing is netted. The floor filters prints before
  they cluster.
- Buyers in the bullish candle colour, sellers in the bearish one, from the
  chart palette, shaded as spheres.
- The area follows the order's size against a fixed size reference per
  instrument (the big-order reference in the settings module; 0 means the
  tape's automatic floor). The reference never moves with the floor: the
  floor hides small bubbles, it does not resize the rest.
- The bigger bubble is drawn in front of the smaller; a frame draws at most
  3,000 spheres, keeping the biggest.

## Settings

"Show orders larger than", in the instrument's base unit, filters single
market orders. 0 is automatic: the size only the biggest two percent of the
live prints reach, re-measured at most once a second, and 0 until 50 live
prints are in (history prints are never measured, they were already
filtered). **Grouping** is Off / Tight / Normal / Wide, one, two or four of
the product's steps (a tick on ES and NQ, a cent on a stock, half a dollar on
BTC, five cents on ETH); the dialog says in one sentence what the choice does
on that product. The gap (3 s) and the maximum life (10 s) are fixed. A
bubble-size slider and opacity; buyers and sellers can be hidden separately.

Each instrument starts on its own settings and "Reset to default" returns to
them: NQ floor 5; ES floor 20, Wide, scale 0.8; BTC perp 10, scale 0.8; BTC
spot 2, scale 0.6; ETH spot 10, scale 0.5; ETH perp 40, scale 0.8; AAPL
1,000, scale 0.6; TSLA 2,000, scale 0.7; everything else automatic.

## Timeframes

The settings hold the rules for a one-minute candle and the rules follow the
candle, not the clock. The gap and the life scale with the number of
one-minute candles in a bar (3 s and 10 s at 1m are 15 s and 50 s at 5m);
the grouping width scales with the square root of that and is snapped to the
product's step. Both are capped: gap 1 min, life 5 min, width four times the
setting. From 15 minutes up the bubbles are linked to the candles: the candle
is the gap, the life and the bucket, and each bubble is drawn on its candle's
middle, buyers a little right, sellers a little left. Above a four-hour
candle the layer draws nothing and the legend says "off above 4h". MainPanel
owns this policy and pushes the rules to the chart layer.

## Files

| File | What lives there |
| --- | --- |
| `aggressiveOrdersIndicator.ts` | The registry entry: id `aggressiveOrders`, category `l2`. |
| `aggressiveTape.ts` | The tape: prints in, clusters out, the automatic floor, history coverage as intervals, subscribers told per print. |
| `aggressiveOrdersSettings.ts` | The settings, the per-instrument defaults and steps, the radius rule, the timeframe scaling. |
| `aggressiveOrdersRenderer.ts` | Placing bubbles on the pane (smallest first, capped) and painting them as spheres. |
| `aggressiveOrdersPrimitive.ts` | The chart primitive: subscribes to the tape, lays the bubbles out once per frame. |
| `AggressiveOrdersSettingsModal.tsx` | The settings dialog. |

## Tests

```
npm test -- src/lib/indicators/aggressive-orders
```

The tape, the settings and the renderer are pure and tested under `tests/`;
the history behaviour per reason is tested in `hooks/useMarketData.test.tsx`.
Editing the primitive needs a hard reload (Ctrl+F5): the class is instantiated
once, so Vite's HMR does not swap the running instance.
