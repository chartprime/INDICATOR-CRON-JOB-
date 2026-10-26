# Size-Split Delta (large vs small)

[Handbook](../../README.md) · [Indicator index](README.md) ·
[Data for indicator authors](data-for-indicator-authors.md) ·
[Setting presets](setting-presets.md)

Code: `apps/web/src/lib/indicators/size-split-delta/` (`sizeSplitDelta.ts` is
the registry definition, `sizeSplitDeltaMath.ts` the pure machinery, `tests/`
the evidence). Registry id `sizeSplitDelta`, label "Size-Split Delta (large vs
small)", category L1, own pane, `ticksWanted`. The code wins over this page.
Brief: `pm/cycle2/brief-size-split-delta.md`.

## The question it answers

"Does large-print flow confirm this price extreme?" Small-print flow is shown
as context, not as a second question.

Aggressive flow is split by **trade frame size as delivered**: a print at or
above the bar's tier threshold is "large", the rest "small". The purple line is
the cumulative signed size of the large tier since the anchor, the blue line
the small tier's. When price makes a new extreme and the large line makes it
too, the large prints confirm; when it does not, they lag, and when they lag by
enough an arrow marks the bar. Print size is not participant size (a sliced
iceberg prints small), and the tool never infers a side it was not given.
Joining or fading remain the trader's decisions. Descriptive only.

## Calculation

One bar at a time, incrementally; `onBar` never rebuilds from an array.

1. **Window.** `[ts_open, ts_open + interval_ms)` over the terminal's print
   store (`ctx.ticks`), located with `firstPrintAtOrAfter`; a print with a
   non-finite or non-positive size or price is skipped.
2. **Tier threshold, read before write.** On a bar's first dispatch, after the
   previous bar has committed, the bar stores `tierAtOpen`: in `auto` mode the
   nearest-rank 98th percentile (index `ceil(0.98 n) - 1` of the ascending
   sort) of the size ring, `null` while the ring holds fewer than 200 sizes;
   in `fixed` mode the `tierSize` setting. Every revision and the commit of the
   bar use that value. "Top 2%" is therefore an estimate from preceding trade
   frames, ties included: a bar can classify more than 2 percent of its prints
   large, and with fewer than 4,096 sizes the quantile can land on a small
   print, which then classifies large.
3. **Size ring.** The last 4,096 sizes of committed windows with coverage
   `"all"`, both tiers, kept in arrival order and in sorted order in two typed
   arrays (64 KB); an insert or eviction moves at most 4,096 doubles and nothing
   is ever re-sorted. With no threshold nothing is classified, but valid sizes
   still train the ring.
4. **Contribution.** Per print, `size >= tierAtOpen` is large (the boundary
   print included); buys positive, sells negative; `largeBar` and `smallBar`
   are the bar's two sums, `tapeVolume` the sum of all valid sizes.
5. **Tape share, fail closed.** `share = tapeVolume / bar.volume` when the
   candle volume is finite and positive, else unknown. The bar is eligible when
   the share is known and inside `[minTapeShare, 1.25]`. Zero or missing candle
   volume with prints, no prints with positive volume (share 0), no prints and
   zero volume (unknown) and a share above 1.25 (a mismatch between tape and
   candle) are all ineligible; an ineligible bar's flow is `null`, never zero.
6. **Commit, keyed to the bar close, tail-only.** A bar commits at the first of
   (a) its first dispatch with `closed: true`, (b) the first dispatch of a
   later bar while it is uncommitted. On (a) the window is rescanned once from
   the store, flow and eligibility are frozen, the sizes enter the ring (if the
   window was `"all"`), and the cumulatives advance if the bar is valid. On (b)
   the runtime cannot republish the previous bar, so the commit uses the last
   revision's values with no rescan: the committed history equals what was
   displayed, and **a print that arrived after the last revision and before
   the next bar is excluded** from that bar's flow and from the next threshold
   until a rebuild replays everything from the store. After commit nothing
   about the bar changes on a later dispatch of the same bar.
7. **Forming bar.** Every revision rescans the forming window from scratch and
   overwrites the tail; the forming output is the frozen cumulative under the
   current anchor plus the forming contribution, drawn provisional (50 percent
   alpha, status `Forming`) until the bar commits, by its close or by
   supersession (UX pass, finding 5).
8. **Anchor and reset.** `day` (default) and `week` are UTC-aligned windows
   (`floor(ts / period) · period`, the session kernel's convention: the week
   window starts on the epoch's weekday, a Thursday); `tape` cumulates from the
   first covered bar. On the first dispatch inside a new window, forming
   included, the cumulative base is zero, the marker ring is empty and the
   table's state and condition rows are cleared.
9. **Gaps.** A bar without a value (coverage not `"all"`, no threshold,
   ineligible share) adds nothing; both lines are `null` on it; the cumulative
   resumes unchanged at the next valid bar, so a sum after a gap omits the gap's
   flow. The marker ring empties and the status row names the gap until `K`
   valid bars have followed.
10. **Markers**, a function of committed state, provisional on the forming bar
    and final at the close. The marker ring holds exactly `K` (default 20)
    consecutive valid committed bars immediately before the bar; a gap or an
    anchor reset empties it and nothing fires until it is full again. `mabsL`
    and `mabsS` are the means of `|largeBar|` and `|smallBar|` over the ring
    (the bar itself excluded). With `h` the ring bar with the highest close
    (latest if tied) and `l` the lowest: a strict new high (`close > close_h`)
    **confirms** when `large > large_h` and **lags** otherwise; the bearish
    divergence condition holds when `large <= large_h - m · mabsL` (`m`
    default 2); the mirror for a strict new low. The **conflict** holds when
    the ring-plus-bar sums of the two tiers have opposite signs and each clears
    `q · sqrt(K + 1)` times its tier's mean absolute contribution (`q` default
    2). **Both markers fire on the onset only** (PM amendment to the brief's
    rule 11): the arrow or circle is drawn when the condition holds at the bar
    and did not hold, in that direction, at the previous valid bar, the
    condition being re-evaluated every bar as written. A trend where every bar
    is a new extreme with a persistently lagging large tier marks once and
    again only after the condition has cleared. At most two markers on a bar.
11. **No future data.** The window end is the cutoff, so a committed bar
    ignores prints at or after it even when the store already holds them;
    thresholds come from committed bars only. Truncating the series changes no
    earlier output or committed marker (tested at every cut of the fixture).
12. **Fail closed.** Any non-finite intermediate yields `null`; nothing ever
    emits `NaN`.

## Data and where the tool works

Only the print store is read for flow: `ctx.ticks` (`prints`, `liveSince`,
`coverageOf`). From the bar: `ts_open`, `interval_ms`, `closed`, `close`,
`volume`. Never `barSides`, `buy_volume`, `ctx.trades` or
`ctx.tradeAvailability`: tick-store coverage is the only gate on tick-derived
values. Sizes are provider units (coins on Binance, contracts on a future,
shares on an equity) and are never added across providers.

| Path | Tape | Indicator |
|---|---|---|
| Runtime WebSocket, Binance or dxFeed | live prints complete from connect; the pre-connect pool and `aggressive_history` are floor-filtered (`"thin"`) | lines begin at the first bar whose whole window is `"all"`; earlier bars `null`, status `Needs live tape · thinned` |
| Browser-direct | live `trade` stream complete from connect; the `aggTrades` bootstrap is `"thin"` | as above; the bootstrap never enters a value |
| REST candle transport | no trade frames, coverage `"none"`, no store | every output `null`, no markers, status `Needs live tape · no feed` |
| Historical Mode | no store | unavailable: "Needs the live tape: the archive keeps only the largest prints of each minute." |
| Equities (dxFeed) | only prints with an aggressor side reach the browser | the tape share gate: on AAPL/TSLA the sided share is often under 50 percent and the bar reads `null` with `Tape 38% · below 50%` |

The store drops live prints past 250,000 (`liveDroppedThrough`): at about
1,600 trade frames a minute on BTC-USDT the complete stretch is roughly 2.6
hours, and windows that reached the drop read `"thin"`. The cumulative starts
at the later of the anchor and the covered start; the line's own start shows
it. The first forming bar after connect (or after a reconnect) is not covered
either, because its window began before the live recording: that is its own
state, `tapeStarting`, shown as `Tape live · next bar` (coverage `"none"`
while the store exists, has held at least one print and `liveSince` falls
inside the window); `Needs live tape · no feed` is kept for no store at all or
a store that has never held a print (UX pass, finding 2). The "never held a
print" clause is the build's addition: the REST-only path absorbs an empty
trade list on every snapshot, which sets `liveSince` without any feed, and
without the clause a REST-only chart would read `Tape live · next bar` for
ever.

Aggregates: the 10,000-row BTC-USDT fixture holds Binance aggregate trades
(one taker order at one price), so a tier estimated on it is higher than one
estimated on individual prints (p98 0.106 BTC, p99 0.198, max 2.0; the top 2
percent carry 52.5 percent of its volume). The tier is "per trade frame as
delivered"; fixture numbers do not transfer between transports.

## Default view

Own pane with a dotted zero line: `large` purple `#8672b3` width 2, `small`
blue `#2563eb` width 1, no fill; both at 50 percent alpha until the bar
commits. Divergence arrows (`arrowDown` above the bar for a bearish
divergence, `arrowUp` below for a bullish one, size 2) in the large line's
colour; conflict circles (`inBar`, size 1, same colour) are off by default.
Table, top right, three rows of at most 30 characters, values with three
significant digits and `k`/`M` suffixes; row (a) always in the solid large
colour, since it describes the current reading:

| Row | Content |
|---|---|
| (a) state | `L +12.4 · S −8.1 · confirms`, `… · lags` or `… · no extreme`; `Need 20 valid bars` until the ring is full; `—` while the bar has no value. If a row would exceed 30 characters the values are dropped: `Large confirms`, `Large lags`, `No extreme`. |
| (b) condition | the newest condition in this anchor window whose Visibility toggle is on, with its time (UTC on Binance, New York on dxFeed) and value: `Divergence ↓ 12:34 · −8.12k` (depth `large − large_h`) or `Conflict 12:34 · +4.21k/−3.12k` (the two sums; over 30 characters, `Conflict 12:34`); divergence wins when both fire on one bar; `—` when none, or when the toggle of the only condition is off; cleared on an anchor reset. |
| (c) status | first match wins: `Needs live tape · no feed`, `Tape live · next bar`, `Needs live tape · thinned`, `Learning sizes · 120 of 200`, `Tape share unknown`, `Tape 160% · mismatch`, `Tape 38% · below 50%`, `Tape gap · 3 bars`, `Forming`, ready `≥ 0.106 BTC · tape 100%`. |

## Controls

Inputs (primary), each with a one-line hint: `tierMode` "Large tier"
(Largest 2% of prints / Fixed size), `tierSize` "Large from (BTC)" (shown for
a fixed tier; the label names the instrument's unit, the hint suggests 0.5
BTC, 20 contracts or 2,000 shares; the stored default is 0.5), `anchor`
"Anchor" (Day (UTC) / Week (UTC) / Tape start), and a closing paragraph:
"Needs the live tape; lines start one bar after connect. Arrow: price made a
new high or low that the large prints did not. Circle: large and small prints
pulling opposite ways." Advanced: `K` "Extreme window (bars)" 10..60 step 5,
`m` "Divergence depth (×)" 1..4 step 0.5, `q` "Conflict strength (×)" 1..4
step 0.5, `minTapeShare` "Tape share floor (0–1)" 0.2..1 step 0.05.
Visibility: `showSmall` "Show small tier (blue)" (on), `showDivergence` (on),
`showConflict` (off), `showBarLines` "Show per-bar lines" (off; the per-bar
contributions as two grey lines, the harness's seams). Every setting replays,
the Visibility toggles included (a hidden line reads `null`, which `recolor`
cannot do), so a toggle costs a replay of the retained bars, well under a
second; there are no colour pickers.

## Alert conditions

| Name | Rule | Fires on | On the mechanism fixture |
|---|---|---|---|
| Large-tier divergence (arrow) | strict new `K`-window close extreme with `large` on the wrong side of `large_h` (or `large_l`) by at least `m · mabs`; onset only | the first bar the condition holds after it did not, provisional while forming, final at its close | 7 of 300 bars at the default day anchor (8 planted; one falls inside the 20 bars after the UTC-midnight reset), 8 with the tape anchor; every planted bar is an onset |
| Tier conflict (circle, off by default) | the ring-plus-bar sums of the two tiers oppose each other, each at `q · sqrt(K + 1)` times its tier's mean absolute contribution; onset only | the first bar the condition holds after it did not | 17 of 300 bars with the tape anchor |

## Warm-up

Auto mode: 200 trade frames from complete windows, then the next bar open; on
the fixture (100 prints a bar) the first value is bar 2 (`Learning sizes · 0
of 200`, then `100 of 200`). Fixed mode values from the first covered bar.
Markers and row (a) need `K` valid committed bars before the bar (`Need 20
valid bars`). The first minute after connect reads `Tape live · next bar`.

## Replay and Historical Mode

Live and replay read the same store, so a replay reproduces the live values
for every bar whose window the store covers; the forming bar is provisional
and excluded. The documented differences are a reconnect (a new store covers
fewer windows, which read `null`) and a rebuild after a late print (a print
that arrived after a bar's last revision and before its supersession enters
only when a `REBUILT` or `setTicks` replay rescans the bar from the store,
and only if the candle's volume carries it too, else the share gate refuses
the bar). The runtime trims its outputs and markers on the rollover but does
not notify indicator state, so the indicator bounds its own: two running
totals, the 4,096-size ring, the `K`-ring and a ring of 10,080 committed bars
(`maxReplayBars`); the size ring may hold sizes from bars the chart has
discarded, so a replay over the retained bars can give the earliest retained
bars a different threshold. Equivalence is tested from the first retained bar
whose anchor start and whose preceding 4,096 committed sizes both lie inside
the retained series (8,726 bars compared equal on the 10,380-bar rollover
fixture). Historical Mode is unavailable with the reason above; a replay with
no store is `null` everywhere.

## Baseline comparison

Two comparisons, both from `tests/sizeSplitDeltaBaseline.test.ts`, truth
from the generators' hidden state, every arrow also checked against the
independent reference implementation of the rule
(`validation/sizeSplitReference.ts`).

Mechanism fixture `sizeSplitFixture()` (300 bars, seed 20261102, 2 large
prints of 1.0 BTC and 98 small in [0.01, 0.049) a bar, 8 planted divergences at
bars 45 + 30 j where the large prints oppose a forced strict new extreme), tape
anchor:

| Configuration | planted | hits on the planted bar | off-label arrows | conflict onsets |
|---|---|---|---|---|
| auto (top 2%) | 8 | 8 | 0 | 17 (equal to the reference) |
| fixed 0.5 BTC | 8 | 8 | 0 | |
| CVD from `barSides`, same rule | 8 | 8 | 5 | |

Regime fixtures `sizeSplitRegimeBars({ seed, priceFollows })`, 600 bars, seeds
1..10, the common evaluation mask being the bars where both configurations have
a value and a full ring (5,780 bars per regime over the ten seeds); `"large"`
plants 10 events per seed, `"small"` and `"none"` plant nothing so every arrow
there is off-label:

| regime | configuration | eligible | planted | hits | off-label arrows |
|---|---|---|---|---|---|
| large | auto | 5,780 | 100 | 100 | 0 |
| large | fixed 0.5 | 5,780 | 100 | 100 | 0 |
| large | CVD | 5,780 | 100 | 80 | 171 |
| small | auto | 5,780 | 0 | 0 | 488 |
| small | fixed 0.5 | 5,780 | 0 | 0 | 490 |
| small | CVD | 5,780 | 0 | 0 | 37 |
| none | auto | 5,780 | 0 | 0 | 256 |
| none | fixed 0.5 | 5,780 | 0 | 0 | 256 |
| none | CVD | 5,780 | 0 | 0 | 180 |

(Arrows are onsets; the held condition would count 703/709/37 on `"small"`
and 290/293/186 on `"none"`.) Acceptance holds: auto matches fixed on
`"large"` (100 of 100) with no more off-label arrows on `"small"` (488 against
490) and `"none"` (256 against 256), and beats the candle delta on its own
regime (100 hits against 80, 0 off-label against 171). What the split shows that candles hide: on the
`"large"` regime the candle delta misses one planted event in five and draws
171 arrows the rule does not support, because the small prints' opposite flow
is folded into one number. The off-label counts on `"small"` are the rule
reading correctly a regime built so that price follows the small tier: the
large tier lags most extremes there by construction.

`whaleVersusCrowd()` in fixed mode with `tierSize` 1.0: the single-large-print
tape reads `largeBar +50, smallBar 0`, the hundred-print tape `0, +50`, the
candle is identical and the candle delta reads +50 on both. The 10,000
aggregate trades: five full minutes of 1,199 to 2,345 aggregates each, the auto
tier after each commit equal to the test's nearest-rank p98 of the same ring
(0.0963 to 0.106 BTC), tape share 1 within 1e-9, tier totals equal to the signed
sum.

## Marker budget

Mechanism fixture at default settings: 7 markers over 300 bars (23 per 1,000),
at most one on a bar; with conflict circles on, 24 over 300. The protocol's
busy instrument (`trendBars(1000)` with `busyTapeFor` at 60 prints a bar)
measures 59 onset arrows per 1,000 bars at defaults (66 before the onset
rule), above the 40 per 1,000 ceiling for a signal tool. That fixture closes
above its previous 20 closes on 980 of 980 bars, so the ring high is almost
always the previous bar and the divergence condition reduces to
`largeBar <= -m · mabsL` for the bar itself: a random large tier meets it on
about one bar in seventeen and rarely on two bars running, so the onset rule
removes few of them. The number is reported, not hidden; the PM decides.

## Performance and bounded state

Frozen method (`probeReplayPooled`, three warm-ups, five timed runs, `onBar`
plus `readOutput`) on 10,080 trend bars with 20 prints each in one store of
201,600 prints: pooled p99 0.038 ms (p50 0.011); real activation p99 0.035 ms,
wall 150 ms; forming bar in fixed mode, 3,000 revisions over 1,000 prints, p99
0.047 ms; rollover of 1,000 extra bars: every output key 10,080 long, no stale
marker, 412 bytes per extra bar with gc exposed (the harness floor is about
370). Measured on the final build with the machine otherwise idle; the test
asserts pooled p99 under 0.5 ms and forming p99 at or under 0.1 ms. State: a ring of 10,080 committed bars of seven fields (under 1 MB), two
32 KB typed arrays, the `K`-ring, two totals, and on the forming bar only its
last revision's sizes (at most 4,096).

## Limitations

Print size is not participant size; the tier follows the delivered trade
frame. Lines start at the tape start (about 2.6 hours back on BTC-USDT at
most) and never in Historical Mode or on the REST transport. A bar superseded
without a close keeps its last displayed values until a rebuild. Equities show
sided flow only and are `null` under the share gate on most bars.
Cumulative-since-anchor is a presentation choice with no claimed benefit over
a per-bar view; a per-bar histogram display mode is v2. The `week` anchor is
epoch-aligned (Thursday 00:00 UTC). No hover tooltip. Descriptive; no forward
claim.

## Tests

`tests/sizeSplitDeltaMath.test.ts` (the hand-computed three-bar fixture, the
size ring against the reference quantile, the window scan, the share cases,
both commit paths, the anchor reset, gaps, the marker rule, formatting),
`tests/sizeSplitDelta.test.ts` (identity, policy, schema, table copy, markers
through a hand-built ctx), `tests/sizeSplitDeltaValidation.test.ts` (protocol
checks 1 to 4 and 9, the forming prefix, the late-print supersession, the
reconnect, the retention equivalence), `tests/sizeSplitDeltaBaseline.test.ts`
(checks 5 and 7, the acceptance table, whale versus crowd, the aggregate
fixture), `tests/sizeSplitDeltaPerf.test.ts` (check 6). Run with
`NODE_OPTIONS=--expose-gc npx vitest run src/lib/indicators/size-split-delta`.

## Screenshots

`pm/cycle2/screenshots/size-split-delta/`, taken from the fixture WebSocket
server in `TAPE=size-split` mode (`pm/cycle1/screenshots/tools/fixture-ws-server.cjs`,
with `POOL_BARS=0 LOW_SHARE_MINUTE=4` for the warm-up and share states and
without `TAPE` for the no-feed state) by `size-split-states.cjs`, which polls
the table and shoots each state at two zooms: `cream-01-tape-live-next-bar`,
`cream-02-learning-sizes`, `cream-03-need-valid-bars`,
`cream-04-tape-share-below`, `cream-05-rest-no-feed`,
`cream-06-forming-no-extreme`, `cream-07-large-confirms`, `cream-08-large-lags`,
`cream-09-divergence-row`, the dark-chart (`data-theme="dark"`) variants
`dark-01`, `dark-03`, `dark-06`, `dark-07`, `dark-08` and `dark-10-conflict-row`
(the dark run has conflict circles on, so its row (b) is the conflict row and
the cream run's is the divergence row; a cream `10` and a dark `09` were not
produced because row (b) shows one condition at a time), and the dialog shots
(`cream-dialog-inputs-advanced-closed`, `cream-dialog-inputs-advanced-open`,
both with Fixed size selected, `cream-dialog-visibility`). Each shot comes in a
`-zoomed-out` and a `-zoomed-in` pair taken from the same reset view.
