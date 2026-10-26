# dxFeed Data Capability Reference

> Historical capability and implementation evidence. Instrument observations
> name the catalog that was probed at the time and are not the current governed
> instrument list. Start with the [dxFeed final-state overview](README.md).

This file separates provider documentation, account-scoped live evidence, and
implemented behavior. A bounded probe can prove that data arrived or that an
explicit provider error arrived. Silence during a short window is only
`NO_DATA_OBSERVED`; it is not proof that an entitlement does not exist.

## Files

- `apps/runtime/scripts/verify/dxfeed/verify-dxfeed-capability-probe.js` — Quote/Trade/Candle/Order on the shared `AUTO` channel
- `apps/runtime/scripts/verify/dxfeed/verify-dxfeed-extended-probe.js` — per-type isolated-channel probe (`STREAM`/`TICKER`/`HISTORY`/DOM), see "Probe methodology" below
- `apps/runtime/scripts/verify/dxfeed/verify-dxfeed-order-book-feasibility-probe.js` — Order-v2 index/transaction-flag feasibility check ahead of the L2 assembler build

## Implemented capability matrix

| Capability | Provider semantics | Account evidence | Implemented use |
|---|---|---|---|
| Quote | Current top of book/latest state | Observed for `/NQ`, `/ES`, AAPL, TSLA | Canonical and durable L1 evidence. AUTO is not represented as a lossless quote tape. |
| Trade | Current last trade; naturally conflating under TICKER/AUTO | Observed for all four instruments | Stored for all instruments as raw evidence, but no longer a bar source for either asset class. |
| TimeAndSale | Continuous trade tape under STREAM; includes NEW/CORRECTION/CANCEL and `validTick` | Observed for `/NQ`, `/ES`, AAPL, and TSLA, each with real aggressor side | Canonical and stored for every instrument. Valid NEW prints drive bars, tape, and markers for futures and equities alike. Corrections/cancels remain raw evidence. |
| Equity TimeAndSale | Same event type | Observed live for AAPL and TSLA during regular US equity hours; real fractional-share prints with `validTick:false` | Subscribed by the collector and both WS servers on the same shared STREAM channel as futures. Equity no longer uses the Trade/tick-direction approximation for bars. |
| TradeETH | Extended-hours latest-state event for eligible equities | Observed for AAPL and TSLA | Capability evidence only; not part of the collector. |
| Candle | Native aggregate/time-series event under HISTORY | No data observed in bounded probes | Not relied on. One-minute bars are built locally from TimeAndSale. |
| Order | Indexed order event | Observed with GLBX/NTV sources | Raw-index Order-v2 capture, durable storage, and source-specific L2 assembly. |
| AnalyticOrder | Iceberg-analysis indexed event under STREAM | Schema/channel accepted; no event observed in a short window | Not used. Requires a longer active-market probe. |
| DOM service | Aggregated book snapshot service | The corrected probe captured an explicit `BAD_ACTION` (`Unsupported service: 'DOM'`) on all four symbols | Not used. The account/feed does not carry a DOM entitlement; this is a definitive negative result, not an inconclusive channel-close timeout. |

Official semantics are described by dxFeed's
[TimeAndSale API](https://docs.dxfeed.com/dxfeed/api/com/dxfeed/event/market/TimeAndSale.html),
[TradeETH API](https://docs.dxfeed.com/dxfeed/api/com/dxfeed/event/market/TradeETH.html),
[AnalyticOrder API](https://docs.dxfeed.com/dxfeed/api/com/dxfeed/event/market/AnalyticOrder.html),
and the
[dxLink AsyncAPI specification](https://raw.githubusercontent.com/dxFeed/dxLink/main/dxlink-specification/asyncapi.yml).

## Probe methodology

`verify-dxfeed-capability-probe.js` covers Quote, Trade, Candle, and Order on
the shared AUTO channel. `verify-dxfeed-extended-probe.js` isolates event types
by delivery semantics:

- TimeAndSale and AnalyticOrder: `STREAM`.
- TradeETH: `TICKER`.
- Candle: `HISTORY`, explicit one-minute `{=m}` symbol and a 24-hour
  `fromTime`.
- DOM: isolated DOM channel per symbol with `DOM_SETUP` and bounded snapshot
  wait.

The DOM probe attaches its error listener before waiting for `CHANNEL_OPENED`.
This was load-bearing: the previous implementation attached too late,
discarded the provider's actual open-time error, and mislabeled the generic
channel closure as entitlement evidence. The corrected probe now captures the
real error: an explicit `BAD_ACTION` (`Unsupported service: 'DOM'`) on all
four symbols, resolving the earlier inconclusive result.

Each attempt reports exactly one outcome:

- `DATA_OBSERVED`: a matching payload arrived.
- `EXPLICIT_ERROR`: an actual provider/channel error was captured.
- `NO_DATA_OBSERVED`: the bounded window ended without either; no negative
  entitlement inference is permitted.

Symbol, event type, and Order source are correlated before a result can prove a
cell. Secrets are redacted from configuration, payload evidence, and errors.
Signals and connection loss abort outstanding waits and close all channels.

## TimeAndSale methodology

The live `/NQ` evidence included an `index` larger than
`Number.MAX_SAFE_INTEGER`. dxLink delivers JSON numbers, so byte-exact 64-bit
identity is already lost by JavaScript parsing. The normalizer represents an
unsafe `index` or `tradeId` as null and retains safe
`time`/`timeNanoPart`/`sequence` values. Their tuple is used to synthesize the
local wire ID, deduplicate the current aggregation bucket, and keep
same-millisecond candle updates in provider order.

All healthy TimeAndSale events are stored, including invalid ticks,
corrections, cancels, and spread legs. A print with `aggressorSide=UNDEFINED`
still contributes to OHLCV, while `buy_volume` becomes unavailable and no tape
side or large-trade marker is fabricated. This applies to futures and
equities alike.

### Asymmetric `validTick` bar-inclusion policy

Live/materialized bars require `type=NEW` for every instrument, but the
`validTick` requirement differs by asset class, driven by one shared predicate
(`isDxFeedTimeAndSaleBarWorthy`) with an explicit, caller-supplied
`requireValidTick` flag rather than an implicit assetClass check buried inside
it:

- Futures also require `validTick=true`. The excluded tail is rare
  (corrections/cancels), so this costs essentially nothing.
- Equities do not require `validTick`. Real captured equity prints are
  routinely marked `validTick:false` on genuine, executed fractional-share
  trades (dxFeed appears to mark odd-lot/fractional prints ineligible for
  last-sale/tick-rule purposes even though they are real fills):
  ```json
  {"eventType":"TimeAndSale","eventSymbol":"AAPL","time":1787938223488,"price":319.772,"size":0.003142,"exchangeSaleConditions":"@  o","aggressorSide":"BUY","validTick":false,"type":"NEW"}
  {"eventType":"TimeAndSale","eventSymbol":"TSLA","time":1787938224919,"price":346.2391,"size":0.01444,"exchangeSaleConditions":"@  o","aggressorSide":"BUY","validTick":false,"type":"NEW"}
  ```
  Requiring `validTick` for equities the way futures does would silently
  undercount real candle volume, not just weaken CVD. `valid_tick` is still
  captured and stored raw regardless, so nothing is lost if this policy needs
  revisiting later.

### `exchangeSaleConditions` allow-list gap (lesson learned)

The normalizer's `TIMEANDSALE_ALLOWED_KEYS` allow-list did not originally
include `exchangeSaleConditions`, an NMS-tape sale-condition field present on
every real captured equity TimeAndSale print. `snapshotFlatFields()` is
fail-closed: any unrecognized key on the raw wire object degrades the entire
message to `MALFORMED_RAW_MESSAGE`, silently dropped. Futures never hit this
gap because CME's futures feed never populates the field. Any future
equity-specific TimeAndSale field should be checked against the allow-list
before assuming it will simply pass through unmapped.

## Local candle methodology

Native Candle is not a dependency. The collector and both WS servers share the
same bar aggregator and event-source policy:

- Futures and equities: NEW TimeAndSale under STREAM (see the asymmetric
  `validTick` policy above for the one difference between them).
- Duplicate synthesized IDs and event-time regressions are dropped.
- Closed bars are stored; live bars are sent to the browser.
- Candle warm-up reads the same stored methodology used live.

This makes futures and equity history/live behavior internally consistent
with each other. It does not correct an already materialized bar when a
provider CORRECTION/CANCEL arrives. Exact correction-aware research bars
require a replay/reconciliation layer over the raw TimeAndSale table.

## L2 boundary

`dxfeed_orders` (retired at schema v20, `L1L2-V2-039`) was not a current book.
Correct indexed-event assembly requires
snapshot boundaries, transaction flags, removals, and exact index identity.
The legacy canonical Order contract omits those fields, but the separate
Order-v2 capture preserves them before JSON number coercion. The assembler
publishes only complete, single-source, non-crossed snapshots; a snipped
snapshot or capture fault is explicitly unavailable. No book may be derived
from legacy row counts or naive price aggregation.

## Required follow-up evidence

1. Equity TimeAndSale (AAPL/TSLA) is resolved: observed live during regular
   US equity hours, wired into the collector and both WS servers.
2. DOM is resolved: the corrected probe captured an explicit `BAD_ACTION`
   (`Unsupported service: 'DOM'`) on all four symbols, a definitive negative
   result superseding the earlier generic-close inference.
3. Observe AnalyticOrder for minutes during active CME trading before judging
   iceberg availability.
4. Replace static dated futures contracts with a verified rollover/instrument
   master before unattended production deployment.
5. Planned token rotation (`DX3.17`) is done. dxFeed's retention/archive
   backup system (`DX3.18`, `storage-archive-scheduler.js`) was removed
   2026-08-29 in favor of no retention at all — every accepted row stays in
   the single live database indefinitely, with a manual, on-demand backup
   script (`backup-to-drive.js`) instead of automated archival (see
   `docs/architecture/storage/storage-pipeline-evidence.md`). Capture-session lineage is durable: a new collector
   session atomically marks an unfinished predecessor `INVALID`, and orderly
   exits persist their outcome. Raw-event replay/reconciliation remains
   absent. The later launcher adds one bounded retry for an unexpected
   full-session transport drop as well as repeatable planned rotation; see the
   final-state overview and operations runbook for the current lifecycle.
6. The absence of a live connection during this document's original migration
   remains part of its evidence boundary. Use later acceptance evidence and
   current service observations rather than treating this dated limitation as
   the present deployment state.
