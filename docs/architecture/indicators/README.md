# Indicators: final-state index

[Handbook](../../README.md) · [Data for indicator authors](data-for-indicator-authors.md) ·
[Indicator SDK](../indicator-sdk/TA.01-indicator-authoring-core-evidence.md) · [Storage selection](../storage/README.md)

The authoritative runtime registration is
`apps/web/src/lib/chart/indicatorRegistry.ts` (`RUNTIME_INDICATOR_DEFS`). Menu
composition and product grouping are exercised by
`apps/web/src/components/chrome/tests/IndicatorsMenu.test.tsx`. Do not maintain
a second supposedly exhaustive indicator list in documentation.

## Documentation map

| Capability | Detailed evidence/reference |
|---|---|
| Technical overlays (EMA, SMA, RSI, Bollinger) | [Technical indicators](technical-indicators-evidence.md) |
| Large-trade ranking and bubbles | [Large Trade Detector](P4.01-large-trade-detector-evidence.md) |
| Aggressive flow and CVD | [Aggressive Order Flow](P4.02-aggressive-order-flow-evidence.md) |
| Delta divergence | [Delta Divergence](P4.03-delta-divergence-evidence.md) |
| Rolling-delta divergence | [CVD Divergence](P4.13-cvd-divergence-evidence.md) |
| Volume distribution | [Volume Profile](P4.09-volume-profile-evidence.md) |
| Volume, net-delta and buy/sell views (one indicator) | [Session Volume Profile](P4.09-volume-profile-evidence.md#session-volume-profile-one-indicator-three-views) |
| VPIN visualization | [VPIN Cloud](P4.12-vpin-cloud-evidence.md) |
| Session overlays | [Session Killzones](session-killzones-evidence.md) |
| Session volume-weighted average price | [Session VWAP](P4.14-session-vwap-evidence.md) |
| Print-priced session VWAP bands | [VWAP Bands](P4.15-vwap-bands-evidence.md) |
| Big resting orders from the stored book history (Binance BTC and ETH) | [Whale Limit Order Heatmap](P5-whale-limit-order-heatmap-evidence.md) |
| Drawing infrastructure | [Trendline](P4.04-drawing-tools-trendline-evidence.md), [Fibonacci](P4.05-fibonacci-retracement-evidence.md) |
| Named setting presets in every settings dialog | [Setting presets](setting-presets.md) |
| Volume against the same minute of day on recent sessions | [Relative Volume (Time of Day)](relative-volume.md) |

These pages are dated implementation evidence. Current registration,
capability gating, settings schemas, and Historical Mode availability come from
the code and tests named above.

## Data-source rules

The full version, with what each instrument has in each mode, is
[data for indicator authors](data-for-indicator-authors.md).

- Candle-only indicators can run in Historical Mode when the selected archive
  capability supplies the required candle fields.
- Trade-, profile-, VPIN-, and L2-derived indicators require their declared
  live or historical data family; a candle archive must not fabricate it.
- Binance and dxFeed quantities are not automatically comparable. Futures use
  contract quantities; equities use provider share quantities; Binance trade
  magnitude uses its documented market semantics.
- Remote warm-up failure is an unavailable/degraded state, not a valid empty
  signal.
- New indicators should consume a supported storage/SDK boundary rather than
  opening SQLite or creating provider-specific fetch logic in the browser.
- Read buy and sell volume through `barSides`; never compute sell as
  `volume - buy_volume`. Equity bars carry a large unsided share.

## Adding or changing an indicator

1. Define the runtime indicator and settings schema through the registry/SDK
   pattern where applicable. A hand-built settings dialog declares a preset
   schema covering every setting it stores ([setting presets](setting-presets.md)).
2. State its input families, provider semantics, units, warm-up source, and
   missing-data behaviour.
3. Add lifecycle, rendering, menu, persistence, and capability-gating tests.
4. Update the detailed evidence/reference page and this map when a genuinely
   new capability category is introduced.
5. Verify both Live Mode and any claimed Historical Mode path. Registration is
   not evidence that archive inputs exist.
