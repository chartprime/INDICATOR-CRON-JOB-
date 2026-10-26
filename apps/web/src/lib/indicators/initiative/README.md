# Initiative Continuation (chart side)

One menu entry, "Initiative Continuation", under Orderbook · L2. The runtime
computes the bands (`apps/runtime/src/indicators/initiative/README.md` has
the rule and its measurement); the chart only draws the `initiative_bands`
frames it is sent, for the candle length it is on. A band marks the start of
a price leg and shows, as facts, whether that start was driven. Nothing on
the chart says whether the leg went on.

## The shade and the chip

A band is drawn as a soft shade behind the leg's start, linked to a chip the
way the Iceberg Detector links its marks to their cards. The shade has no
outline and carries no score, so it never reads as an Exhaustion box, and
the chip tells it from an Absorption sphere.

**The shade.** A soft column in the side's colour, drawn behind the candles
and kept exactly to the window at every zoom: in time from the pivot
candle's open to the flip candle's close, never a pixel wider, so zoomed out
it thins to the window's own width instead of spilling over the neighbours;
in price from the highest high to the lowest low of the chart's own candles
there (the pivot and the flip close when the chart has none), never
taller. The fade lives inside that box: clear at the top and bottom edges,
full strength through the middle, over 40 px at each end or half the box
when it is shorter. Its strength is the Opacity slider times 0.4 (0.24 at
the default); the score stays on the chip.

**The chip.** A dark rounded card in the Iceberg card's style, 34 px tall:
"INITIATIVE" with a triangle for the leg's direction, then the score and the
pushing side (`4/5 buyers`). A 1 px leader starts 4 px below the window's
lowest low for an up leg (above its highest high for a down leg) and runs
26 px to the chip, which hangs below an up leg and sits above a down leg,
centred on the window and kept inside the pane. Chips that would touch stack
away from the candles, the later one further out.

**The colour and the word** follow the leg's direction: an up leg is a buy
initiation, green and "buyers"; a down leg a sell initiation, red and
"sellers". Both colours are changeable in the dialog. Which side owned the
window's aggressive volume is a fact, not the colour: the card's Delta
share row shows the pushing side's share, and the delta fact counts toward
the score only when that share ranks in the top fifth of the typical
candles. (The first build coloured by the larger side, `dominant` on the
wire; a 15m crash window split 50.5 to 49.5 came out green and called
buyers while every shorter length called it sellers, so the colour moved to
the direction.)

**Show shade** and **Show chip** in the Visibility tab hide either on its
own; hiding the chip hides its leader too.

**The leg floor.** A band is shown once its leg has moved at least Minimum
leg size from the pivot, in the band's ATR, 3 to 10 ATR in halves, default
7.5. The runtime sends every new extreme of the leg, so a band appears live
the moment its leg reaches the floor, a few candles after the flip at the
default, and a start whose leg never gets that far never appears, live or
in history. At 3 ATR every band shows at the flip, since the flip is the
three-ATR comeback itself. Measured on two weeks, nothing known at the flip
tells the starts that go on from the ones that fail (the old leg's length
and the window's length both sit within a few points of the base), so the
floor is the trader's dial between early and clean.

**Under the cursor** a band answers inside its shade or inside its chip: the shade brightens, the
chip's rim goes to full strength, and a one-liner, `Buy start · Strong (4 of
5)`. A click pins the card (`InitiativeCard.tsx`) until the next click
elsewhere or Escape. The card is written for a trader, not for us: the title
names the side's start, a strength word for the score (0 to 2 Weak, 3
Moderate, 4 Strong, 5 Very strong) and the score, `▲ BUY START · STRONG (4
of 5)`, then the five facts, one per line, a green tick when the fact
counted toward the score and a purple cross when it did not, the fact's
name on the left and the reason in plain words on the right:

| Row | Counted | Not counted |
|---|---|---|
| Clean move | `price went mostly one way` | `price went back and forth` (`price barely moved` when the closes never left the pivot) |
| Strong candles | `3 of 4 closed near the high` (the low for a down leg) | `only 1 of 4 closed near the low`, `none of 4 ...` |
| Volume burst | `volume 2.6× the quiet before` | `volume only 1.6× the quiet before` |
| Buyers in charge / Sellers in charge | `71% of orders were buys, unusually high` | `48% of orders were sells, not unusual` |
| Big buyers / Big sellers | `more large buy trades than usual` | `large sell trades at a usual pace`, `no large sell trades` |

The percentage on the "in charge" row is the pushing side's share of the
window's market orders (the delta fact's share), so a balanced window reads
49% or 51%; "unusually high" means that share ranked in the top fifth of the
typical candles. A number the runtime could not read says so (`volume not
measured`). The exact ratios, ranks and thresholds are in the runtime README
and on the wire, not on the card. The pinned card keeps only the band's id
and the click point: it is rebuilt from the book as pages arrive and goes
when the band is filtered out or gone, when the indicator is hidden or
removed, or when the chart changes pair. Like a whale card it stays inside
the chart's width and opens below the click when there is no room above it.

Where shades overlap, the smaller one under the cursor answers, and a chip
beats a shade. A band
yields to a whale marker, an absorption sphere, an iceberg and an exhaustion
box, and quiets the heatmap wall, Book Map, whale wall, pivot, FVG and
session-level cards beneath it; a click pins one card at most, by the same
order (a whale wall inside a band's shade pins the band's card, not the
wall's).

## Live and history

History Off shows the bands this runtime process read since it started (the
frame's `liveSince`, `origin: "runtime"`). A band the runtime restored from
its store or read from the host keeps that origin when the live feed moves
its leg later, so History Off never shows a band born before the runtime
started. 1 / 3 / 5 days / 1 week shows the bands whose flip candle lies in
that span, whatever their origin. The runtime reads a day of the host's
columns at a pair's start, the chart's pair first; a longer span is asked
for with `initiative_history` (`requestInitiativeHistory`, sent from
MainPanel whenever the indicator is on, the span is not Off and the runtime
has answered, again for a new runtime process) and read behind the live feed
a day at a time, the newest day first. While the runtime reads, the frames
carry `loading` and the chart shows `INITIATIVE · LOADING 1 DAY` (the span
named as the heatmap names its reaches) in the status badges' row 9, with
` · loading 1 day` in the legend. The badge reads `INITIATIVE · WAITING FOR
THE RUNTIME` before the first page and `INITIATIVE · UNTRUSTED UNTIL THE NEXT
PAGE` across a dropped socket.

The candle lengths are Exhaustion's (`initiativeCandleMsOf` is
`exhaustionCandleMsOf`): a chart interval off the list, or an equity above
30m, draws nothing and the legend reads "no engine at this timeframe".
Otherwise the legend reads how many bands the chart draws (`N shown`: the
candle, the History span, the minimum score and the leg floor applied, the
same filter as the chart's) and, with History Off, since when; "waiting for the runtime"
until the first page, "reconnecting" while the socket is down, "untrusted
until the next page" across a dropped socket. The indicator needs the live
runtime: in archive mode it is unavailable.

The shown set is filtered once per book page, candle length, settings object
and minute, not on every view update, and the layer repaints at most every
100 ms.

The book keeps a band for a week after its flip candle, the longest History
span and the runtime's own age limit, counted on the runtime's clock as each
frame carries it (`ts`), never the browser's. A band older than that in a
frame is not taken, and the ones the book holds are dropped as frames
arrive, so a tab left open all week holds a week of bands, not everything
it was ever sent; the drop alone counts as a change, so the chart redraws.

## Settings

Per instrument, kept with the chart's other extras
(`initiativeByInstrument`) and in the per-instrument presets. The dialog,
with no explanatory text: Inputs (Minimum score 0 to 5, default 4 of 5 on every
timeframe; Minimum leg size 3 to 10 ATR, default 7.5; History Off / 1 / 3 / 5 days /
1 week, default 1 day), Visibility (Show shade, on; Show chip, on; Buyers
colour, green; Sellers colour, red; Opacity 0.15 to 1, default 0.6; Show on
chart).

## Files

| File | Role |
|---|---|
| `../../l2/initiativeBook.ts` | the frames kept by id, newest `updatedAt` wins, in pivot order, a week of bands on the frame's clock; `liveSince` and `loading`; trusted across a reset, untrusted across a dropped socket |
| `initiativePrimitive.ts` | the series primitive: the shade behind the window's chart candles (a vertical fade on the bottom layer, exactly the window's box), the chip and its leader on the top layer (stacked when chips touch, kept inside the pane), the status badge, the hit test (chip first, then the smallest shade) |
| `InitiativeCard.tsx` | the pinned card: the title and the five facts, a green tick or a purple cross each |
| `initiativeHover.ts` | the hover line, the card's title and the five fact rows in plain words from a band |
| `initiativeWords.ts` | the leg's pushers, the strength word for a score, percent and times formats |
| `initiativeSettings.ts` | settings, defaults, the dialog's schema, the History options, colours, opacity, the candle length rule, the shown-bands filter (candle, span, origin under Off, minimum score, the leg's reach against the leg floor) |
| `InitiativeSettingsModal.tsx` | the dialog |
| `initiativeIndicator.ts` | the registry entry |
| `tests/` | one spec per file |

Plumbing: `types/frames.ts` parses the frame (`parseInitiativeBandsFrame`,
every band field and the cross-field rules, a bad band refuses the frame)
and declares the `initiative_bands` capability; `marketDataWorker.ts`
forwards the `initiative_history` ask; `useMarketData.ts` keeps the book
(`initiatives`, `initiativesVersion`), cleared on a pair switch and
untrusted across a dropped socket like the shades; `Terminal.tsx` hands it
to `MainPanel.tsx`, which gives the chart the book, the settings and the
candle length (`applyInitiatives`, `refreshInitiatives`,
`setInitiativeSettings`, `setInitiativeCandle`) and draws the legend row;
`ChartPanel.tsx` attaches the primitive, owns the hover line and the pinned
card and shows or hides the book with the indicator; `statusBadge.ts` has
its row (9); `tooltipPriority.ts` puts its hover line under a whale's or an
absorption sphere's.
