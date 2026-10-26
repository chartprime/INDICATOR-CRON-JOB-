# Iceberg Detector (chart side)

One menu entry, "Iceberg Detector", under Orderbook · L2. One mark per
iceberg on the candle that holds `markedAt`, at its price or, by choice, at
the candle's high for a sell and its low for a buy, joined by a line to a card
clear of the candles, above a sell and below a buy: ICEBERG, an arrow in the
side's colour (up for a bid, down for an ask), then the total and how it adds
up. `40 (10 × 4)` is
an order that showed 10 at a time and went through 4 times. Hover a mark or
its card for three plain lines: what it is and its side, the total as orders
times size, what traded (and "still refilling" while live); then when it was
marked and how long it ran.

| | Futures (NQ, ES) | Crypto (Binance) |
|---|---|---|
| What a mark is | a native iceberg: CME itself refilled the order's visible part | a probable iceberg: a price that kept taking more than it showed, judged against the pair's own book |
| Drawn by default | a filled dot | a hollow circle |
| Certainty | certain | strong or probable; weak (dashed) once the level showed more than the learned ratio allows |

The shape can be set to dot, triangle (pointing up on a bid, down on an ask)
or circle. Dot and triangle are filled, circle is an outline. A weak, pulled or
interrupted iceberg is drawn hollow with a dashed outline and line. Each mark
grows with its total against the typical total of the icebergs held for the
pair (`icebergMarkRadius`, 3.5 to 10 px times the size setting), so the
biggest on the chart is drawn largest; the filters below never change a kept
mark's size.

## Where the data comes from

The runtime's `iceberg_orders` frame (opt-in capability, see the WS frame
contract). `hooks/useMarketData.ts` routes it into `lib/l2/icebergBook.ts`
beside the L2 store: a reset page replaces the set, increments upsert by id
keeping the newest `updatedAt`, a pair switch clears it, a dropped socket
leaves it visible but untrusted until the next reset. The reset page carries
the settled icebergs the runtime holds: its own store (seven days) plus what
the host's builder saw for the spans this runtime did not watch, asked for
the last five days, the longest History option (see the runtime README, "Host
history"). The history span is
a client-side filter on `markedAt`, not a request. Every frame also carries
`watched`, the spans either machine actually watched; the legend's "watched
from" is the start of the oldest span or of the runtime's oldest own mark,
whichever is older, and a span with no marks inside it is quiet, not unknown.
Each iceberg says where it came from (`origin`) and every frame says where
the runtime's live window begins (`liveSince`: the frame's time less the
heatmap's live horizon, four hours by default). History off is live like
absorption: the runtime's own icebergs (`runtime`) marked inside that rolling
window, the same hours absorption draws with history off; the legend then
reads "live since". A span shows the stored history and the host's (`host`)
inside its days, and the legend reads "watched from".

From the hour up (1h, 4h, 1D) the chart keeps one mark a candle: the biggest
by total among everything shown, ties by what traded then the newest; below
the hour every mark stays (`biggestPerCandle`).

## Files

| File | Role |
|---|---|
| `icebergIndicator.ts` | the registry entry (legacy def, `category: "l2"`) |
| `icebergPrimitive.ts` | the series primitive: layout, triangles, labels, status badge, hit test |
| `icebergSettings.ts` | settings, defaults, the shown filter, the label format |
| `icebergHover.ts` | the hover card's words |
| `IcebergSettingsModal.tsx` | the settings dialog |
| `tests/` | one spec per file; the primitive is tested with a recording canvas context |

Plumbing: `ChartPanel.tsx` attaches the primitive and owns the hover card and
the handle methods (`applyIcebergs`, `refreshIcebergs`, `setIcebergSettings`);
`MainPanel.tsx` keeps the per-instrument settings (`icebergByInstrument` in
the live extras blob), the legend row and the modal.

## Settings

Per instrument, starting from one standard for every asset: History Off,
Size: biggest 20%, Refills ×2, pulled shown.

- History: Off / 1 day / 3 days / 5 days. A live iceberg always shows.
- Refills (`minTranches`, 1 to 10, 2 by default): the ×N on the card, how many
  orders the total adds up to. Marks under it are hidden, live ones too, so a
  ×1 is never shown as an iceberg by default.
- Size: biggest N% by total. The live window and the older history are
  ranked apart, so below the hour a span only adds to what Off shows. From the
  hour up each candle keeps its biggest mark of everything shown, so there a
  span can replace a smaller live mark in the same candle.
- Mark placement (`placement`): where it appeared (the iceberg's own price,
  the default) or the candle's high / low (a sell at the high, a buy at the
  low). The hover and the mark's size stay the iceberg's.
- Show pulled, labels, mark shape, bid and ask colours (the heatmap's until
  changed), mark size.

A weak mark (a probable whose ratio fell after its mark) always shows, dashed;
there is no switch for it. The standard carries a `revision`: a saved
per-instrument entry from an older revision is let go, so a new standard
reaches every asset.

The learned cuts behind probable icebergs (visible-at-touch percentile,
duration percentile, ratio percentile, strong multiple) live in the runtime
and are not settings here yet: exposing them needs a client-to-server
message, which is a follow-up.

## Status badge

Top-left, its own row: "waiting for the feed" until the first page, "untrusted
until the next page" across a dropped socket, nothing while in sync, and
nothing at all while the indicator is off or hidden (the chart tells the layer
whether it is shown, `setShown`). The
legend row says the same, plus how many icebergs are held.
