# Exhaustion (chart side)

One menu entry, "Exhaustion", under Orderbook · L2. The runtime computes the
shades (`apps/runtime/src/indicators/exhaustion/README.md` has the rule); the
chart only draws the `exhaustion_shades` frames it is sent, for the candle
length it is on.

The chart draws two things. **Legs**, from its own candles (`legCatcher.ts`,
the same rule as the runtime's: ATR(14), a three-ATR zigzag, drawn at eight
ATR and half straight): a thin box from the leg's start to its extreme,
dashed while the leg is still running, no text. The size and straightness
sliders move these legs and filter the runtime's shades alike (each shade
carries its leg's size, ATR and straightness); the reversal slider moves the
chart's legs only, the runtime's zigzag is three ATR. The confidence slider
(3 to 6, default 5, where the measured edge starts) hides shades under that
score.
**Shades**, from the runtime's frames, two boxes each. The leg, left blank:
a thin continuous outline in the side's colour from the leg's start to its
extreme in price and from the leg's first candle through the shade's last in
time (shades of one leg share one outline, drawn once up to the furthest
extreme and the latest end; Show exhaustion areas only in the dialog drops
these outlines and keeps the boxes). The exhaustion box inside it, at the
extreme: in price the engine's zone, the last fifth of the leg from the
extreme, times the Exhaustion area slider (×1 to ×5 in halves, ×2 by
default, so two fifths of the leg; ×5 is the whole leg; never more than the
leg); in time the run of the chart's own candles touching that band that
ends at the shade's last candle, back to the leg's start at most, the
shade's own candles always in, through the shade's end. A candle touches
the band when its high reaches it for a rise, its low for a fall (the
chart's trade candles against the runtime's mid candles, so a tick or a
candle off at worst, like the legs). The box is filled in the side's colour
with its own rim and, when it has room, the score label at its top
(`5/6 · ~60%`, the measured accuracy of that score, shown only at the default
leg size and straightness where it was measured). While the shade is open
its box flashes on the half second while it still extends, then holds still
at half fill while it waits for its verdict: held the moment the leg comes
back three ATR from its extreme, broke the moment a wick goes past the
extreme by more than one and a half ATR or a tenth of the leg, whichever is
larger; whichever verdict comes first, however long that takes. When it is judged it stays: filled when the
exhaustion held, a dotted outline when it broke, a dotted outline when a
session gap interrupted it (a market closure counts: the CME break cuts the
legs of 30 minutes and under, a weekend everything under 4h); the leg's
outline stays continuous whatever the verdict, the dotted line is the
exhaustion box's alone. Shades are
never deleted. Buyers' exhaustion (a rise ending) and sellers' (a fall ending)
have their own colours; the intensity (the score banded 3 / 4–5 / 6) sets the
strength. An exhaustion box answers the cursor like a whale level, the blank
leg around it nothing:
hovering it draws a dark rim around the box and shows a one-liner (the side
and the score, `Buyers exhausted · 5/6`); clicking it pins the card —
the side, the score with its measured accuracy and the verdict on one line,
then the six readings in plain words, one per row, label left and on the
right the amount now with the reference under it, smaller and in grey: the same
words and sums as the monitor (`exhaustionWords.ts`: Buying or Selling volume
`1.27 BTC` over `Leg: 3.17`, Price moved `Now: 0.00 / 1.27` over
`Leg: 15.11 / 3.17`, Delta `Buys: 1.09` over `Sells: 1.27`, Vs the high or
low `Now: −0.18 (−8%)` over `Low: −0.43 (−31%)` (the net and its share of
the window's volume, buys minus sells), Big buyers or sellers `Now: 3` over
`Leg: 7.6`, Book at the high or low `Bids: 5.70` over `Low: 9.50` (the band
that decides the reading named: Bids, Deeper bids or Asks above for sellers,
Asks, Deeper asks or Bids below for buyers); volumes in the instrument's
unit, contracts and shares whole), each amount green when its reading counted
toward the score and purple when not — until the next click elsewhere or Escape
(`ExhaustionCard.tsx`). The pinned card keeps only the shade's id and the
click point: it is rebuilt from the book as the pages change (the score, the
verdict, the accuracy label following the sliders) and goes when the shade is
filtered out, gone, when the indicator is hidden or removed, or when the chart
changes pair. Like a whale card it stays inside the chart's width and opens
below the click when there is no room above it. Under the cursor an
exhaustion box yields to a whale marker, an absorption sphere and an iceberg,
and quiets the heatmap wall, Book Map, whale wall, pivot, FVG and
session-level cards beneath it; a click pins one card at most, by the same
order (a whale wall inside a box pins the exhaustion card, not the wall).
A leg can carry several shades whose boxes nest (Hide
nested legs in the dialog keeps only the biggest: a shade whose leg sits
inside another shown shade's leg of the same side, in time and price, is
left out, the later shade winning between equal legs); the
cursor opens the exhaustion box under it, the smallest where two overlap. Legs without a shade
answer nothing.

## Live and history

History Off shows what this runtime process has judged since it started (the
frame's `liveSince`): the runtime replays the deep tier it holds at start (four
hours by default). 1 / 3 / 5 days / 1 week adds the shades the runtime judged
over the host's 10-second columns for the days before (`origin: "host"`) and
the ones it stored over earlier runs, that ended inside that span. The runtime's
engines go live once the last day of the host's columns below the host's edge
is read (the hours probed newest first, empty hours walked past, so a weekend
reaches back into Friday), the chart's pair first, a few seconds a pair, with
no wait on the heatmap's own rebuild; a
longer span is asked for with `exhaustion_history` (`requestExhaustionHistory`,
sent from MainPanel whenever the indicator is on, the span is not Off and the
runtime has answered, again for a new runtime process) and judged behind the
live feed a day at a time, the newest day first, so yesterday lands before the
day before it and the chart never waits for history it did not ask for. While the
runtime reads, the frames carry `loading` and the chart shows
`EXHAUSTION · LOADING 1 DAY` (the span named like the heatmap's reaches) with
` · loading 1 day of history` in the legend. A chart interval the engine does
not run (a custom interval off the chart's list, or an equity above 30m: the
chart anchors equity candles of 1h and up to the regular-session open while
the runtime buckets on UTC multiples, so the runtime runs neither the engine
nor the Candle Monitor there; `exhaustionCandleMsOf(intervalMs, assetClass)`
holds that rule) draws nothing, shows no Candle Monitor and the legend reads
"no engine at this timeframe"; a timeframe where nothing has fired yet reads
`0 shown`.

The legend row reads how many shades of the chart's candle the chart draws
(`N shown`: the candle, the History span, the leg sliders, the confidence
floor and Show broken applied, the same filter as the chart's) and, with
History Off, since when; "waiting for the runtime" until the first page,
"untrusted until the next page" across a dropped socket.

## The Candle Monitor

Top right of the chart, just left of the price axis, at the head of the
top-right column the drawing tables share (ChartPanel measures the axis and
sets the column's right offset; the panel sits above the tables' layer, so a
table never covers it), when the indicator is on and its Show monitor switch
is: what happened in the last closed candle of the chart's candle length,
independent of the engine (no leg, no side, no threshold), from the
runtime's `candle_monitor` frames (one a second, the entries changing only
at a close; the newest kept by the hook as `candleMonitor` with the
browser's arrival time, handed to the chart through `applyCandleMonitor`,
dropped on a pair switch). The header names the candle, "1m · 14:59" (UTC,
as the chart's axis; "1D · 11 Oct" for daily candles), then five rows of
label and value (`candle-monitor/candleMonitorText.ts`): Buying volume and
Selling volume in the instrument's unit, Delta (buys minus sells, signed,
with its share of the candle's volume; green when positive, red when
negative), Biggest buyer and Biggest seller (the largest single trade of each
side in the candle, size and price, "1.21 BTC @ 83180.00", the price written
by the chart's own price formatter, as the axis writes it, never rounded to a
whole number; "—" when no trade of that side reached the heatmap's big-print
floor in the candle).
236 px wide, monospace at 8–9
px, no bars, nothing flashes. "Waiting for a close" until the
chart's candle length has closed one since the runtime started (the start
replay of the deep tier closes the short ones at once; the daily waits for
its first close). Fifteen seconds after the last frame reached the browser
the monitor turns stale by its own timer, whatever else re-renders: "no
feed", the rows dimmed; a cleared frame (a reconnect or a pair switch) reads
the same. While frames keep coming, the panel also turns stale when its candle
is overdue on the runtime's own clock: the frame's `ts` past the close of the
candle after the one shown plus the same fifteen seconds
(`candleOverdueAt`), as when the deep tier is held after a restart and the
runtime republishes one old candle every second. The header then reads
`stale · 1m · 13:05` and the rows dim; the browser's clock plays no part, so a
skewed laptop clock never flags it, and a frame that stopped still reads "no
feed". A chart rebuilt for a new colour scheme hands the new exhaustion
layer the last settings, unit and candle length.

## Files

| File | Role |
|---|---|
| `../../l2/exhaustionBook.ts` | the frames kept by id, newest `updatedAt` wins, in start order; `liveSince`; trusted across a reset |
| `legCatcher.ts` | the chart's legs: Wilder ATR, the zigzag, size, straightness, candles, open or settled |
| `exhaustionPrimitive.ts` | the series primitive: the chart's leg boxes, the blank outline of each shade's leg, the exhaustion box (the scaled zone at the extreme over the candles touching it, `zoneStartTs`) with the score label, the five states, the flash, the badge, the hit test over the exhaustion boxes; the shown set filtered once per book page, settings object, candle length and minute, not on every view update |
| `ExhaustionCard.tsx` | the pinned card: the first line and the six rows, the amount in green or purple over the grey reference |
| `../candle-monitor/CandleMonitor.tsx` | the Candle Monitor panel top right: the candle it counts and five rows of label and value; its own stale timer |
| `../candle-monitor/candleMonitorText.ts` | the candle header, the five rows' texts and colours from a `candle_monitor` entry (trade prices through the chart's price formatter), the staleness rule |
| `exhaustionWords.ts` | the plain-words labels per side and each reading's two lines (the amount now, the reference under it) from the raw sums, for the card; its number formats serve the Candle Monitor too |
| `exhaustionHover.ts` | the hover line, the card's first line and its six number lines, and the score's measured accuracy (share held on 1m: 3 → ~57 %, 4 → ~54 %, 5 → ~60 %, 6 → ~69 %) |
| `exhaustionSettings.ts` | settings, defaults, the sliders' bounds, the exhaustion area's scale and height (`zoneHeightOf`), the engine's candle length for the chart's interval and asset class, the shown-shades filter (candle, history span, broken, leg size and straightness, confidence) and the nested-legs sweep (each side sorted outer first, a shade checked against the earlier ones only when one reaches past its end) |
| `ExhaustionSettingsModal.tsx` | the dialog, with no explanatory text: Inputs (the three leg sliders, Confidence, Exhaustion area ×1 to ×5, Show exhaustion areas only, Show legs (off by default), Hide nested legs, Show broken, Show monitor, History), Visibility (two colours, opacity, Show on chart) |
| `exhaustionIndicator.ts` | the registry entry |
| `tests/` | one spec per file |

Plumbing: `useMarketData.ts` keeps the book (`exhaustions`, `exhaustionsVersion`),
cleared on a pair switch and untrusted across a dropped socket like the
icebergs; `Terminal.tsx` hands it to `MainPanel.tsx`, which gives the chart the
book, the settings and the chart's candle length (`applyExhaustions`,
`refreshExhaustions`, `setExhaustionSettings`, `setExhaustionCandle`);
`ChartPanel.tsx` attaches the primitive, owns the hover card and shows or hides
the book with the indicator; `types/frames.ts` parses the frame
(`parseExhaustionShadesFrame`); `statusBadge.ts` has its row;
`tooltipPriority.ts` puts its card under a whale's or an absorption sphere's.
