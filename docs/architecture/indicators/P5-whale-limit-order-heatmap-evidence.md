# Whale Limit Order Heatmap (P5)

> **Historical implementation evidence.** This dated page records the result
> of a completed build. It is not a current deployment/health statement; use
> the [final-state indicator index](README.md) and the handbook for supported
> operation.

The Whale Limit Order Heatmap draws the **big resting orders the L2 engine has
stored** for Binance BTC and ETH, spot and perpetual, as horizontal bands: from
the moment a wall appeared to the moment it ended, with a mark at the end that
says how it ended. It is registered as `whaleLimitOrderHeatmap` (category `l2`).
It is a separate indicator from the Passive Liquidity Heatmap and from Book Map;
it reads walls, not depth.

## Where the walls come from

- **History** is the host's wall history (`wall-history`, served at
  `/heatmap/walls`; see [heatmap lanes](../l2/heatmap-lanes.md)). The indicator
  asks through a second `WallHistoryStream` of its own: request ids from
  `2^32 + 2^30`, twelve-hour chunks, newest first, so it never answers the
  order-blocks stream's requests or the other way round.
- **The size filter runs on the host**, before the page limit, so a page holds
  only the walls worth drawing: `minUsd` (dollar size, `peak × (row + span / 2)
  × rowWidth`) with `alwaysOutcomes` keeping every `filled` and `partial` wall
  whatever its size. A page also carries the market's size percentiles
  (`sizeBands`), which set the heat scale. An old host that does not answer the
  filter is detected after two refusals and the stream carries on unfiltered,
  with the same cut applied in the browser.
- **Live walls** come from the runtime's `IndicatorL2.walls()`: a wall with no
  end is standing and is drawn in the ladder; one that has ended joins the
  history, and a host copy replaces a live copy of the same wall.
- **A wall's identity** is `side | row | span | start`; where two copies meet,
  the host's wins, and between two from one source the longer-lived stays.

## What is drawn

| Mark | Meaning |
|---|---|
| Green band, red band | A bid, an ask |
| Heat | The wall's dollar size on a log scale from the market's median to its 99th percentile |
| Thickness | 3 to 8 px by size (setting), never thinner than the wall's true price span |
| Solid dot at the end | The wall was mostly consumed (`filled`), drawn a pixel thicker |
| Half dot | A big bite (`partial`) |
| Ring | Price reached it but little traded (`hit`) |
| Tick | Pulled |
| Faintest, no mark | Cancelled and re-placed nearby (`moved`), off by default |

The default cut is the top 10% of dollar size per market; importance
(`ratio`) is the alternative. Hover shows a compact card (one sentence, a
traded-share bar, a facts line); a click pins it with the details (first bite,
placements, other-side orders, distance at the end, importance, price) and
Escape or a click on empty chart closes it. The live ladder is a strip pinned to
the price axis, with nearest ask and bid, and clears itself when the L2 feed is
not live and synced.

Spoofing is not scored. The card states what the engine recorded, and the
evidence flags the engine keeps are not turned into a verdict.

## Speed

Measured by the density bench (`apps/runtime/scripts/bench/indicator-density.js`,
scenario `whaleHeatmap`): headless Chrome against a fake host with 50 ms of
latency, 10,080 one-minute bars, and 1,500 walls that all pass the cut in the
last 48 hours.

| Phase | Frame p95 | Long tasks |
|---|---|---|
| Steady | 16.7 ms | none |
| Hover | 16.7 ms | none |
| Pan | 16.7 ms | none |
| History scrolling | 16.7 ms | none |
| Seven timeframe switches | 16.7 to 16.8 ms each | none |

The indicator added 0 ms at p95 over the empty-chart baseline in every phase.
The wall route served seven requests and about 190 KB; the first arrived about
0.66 s after navigation and the last about 0.88 s. The bench gates `pan`,
`history` and every timeframe switch for this scenario as well as `steady` and
`hover`. Pan and zoom rebuild nothing: the selection is an object the primitive
keeps until the settings or the walls change, and the tests assert the same
object and an unmoved rebuild count across a pan. A change in the walls is
folded into the selection at most once a second; a settings change rebuilds at
once.

What this does not show: host query time and wire size with the real pyramid
(the filter is a host change and takes effect once a host runs it), browser
parse cost on the unfiltered fallback, and GPU draw cost (headless Chrome draws
in software). The bench's L2 feed is not a trusted live segment, so the ladder
shows its untrusted state there; the ladder's rows are covered by unit tests.

## Release paths

Hiding the indicator, a Historical Mode chart, a pair change and a detach each
drop the walls, the selection, the hover and any waiting timer; taking the stream
away also tells the stream to stop asking, and giving it back reloads from
scratch. The primitive holds no canvas or image of its own: it draws directly.

## Evidence in the repository

- Unit and component tests beside the code (`whale-limit-order-heatmap/tests/`,
  the chart and hook tests that name the whale stream and card).
- Replayable mutation specs, `benchmarks/mutations/p5-whale-*.json` and
  `p5-wall-filter.json`, `p5-wall-bands.json`, `p5-decoder-continuity.json`,
  replayed with `npm run verify:mutation` from `apps/runtime`; the outcomes are in
  `benchmarks/mutation-ledger.jsonl`.
- The bench scenario and its tests (`indicator-density-frames.test.js`).

## Known limits

- Walls that were moved are drawn one by one; a chain of them is not collapsed.
- The empty space between the newest candle and the ladder can be wider than the
  designed gap after a zoom change, because the chart holds its scroll room across
  the change; it never overlaps the ladder.
- Binance BTC and ETH only. Any other market shows "WHALE · BINANCE ONLY" and draws
  nothing, and the size filter is refused for dxFeed.
