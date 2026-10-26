# Data for indicator authors

[Handbook](../../README.md) · [Indicator index](README.md) ·
[Onboarding](../../operations/00-developer-onboarding.md) ·
[Indicator SDK](../indicator-sdk/TA.01-indicator-authoring-core-evidence.md)

An indicator never opens SQLite, S3 or a provider connection itself. It reads
what the runtime and the archive deliver through a small number of supported
boundaries. This page names those boundaries, says what each one carries for
each instrument, and lists the rules every indicator has to follow. The code
named here is the authority; when this page and the code disagree, the code
wins and this page is the defect.

## Three sources of data

| Source | How it reaches an indicator | You need | When it is missing |
|---|---|---|---|
| **Live ticks** | Terminal C holds the provider session and sends canonical frames (`bar`, `trade`, `book`, `health`, profiles, VPIN readings) over the local `/ws` WebSocket | Binance: nothing. dxFeed: layer 2 (Tailscale broker) | dxFeed instruments show *History only*: with layer 1 their recorded host history still loads, without new ticks |
| **Warm-up** | Before live ticks arrive, the runtime reads recent history through its storage reader: candles, large trades, aggressive prints, volume profile, VPIN calibration | Layer 1 (WireGuard + bearer); otherwise only a local collector's SQLite | The indicator starts from live ticks only and reports itself not ready |
| **Archive** | Historical Mode reads candles through `/archive/query` and asks the host for four studies through `/archive/study` | Layer 1 | Historical Mode shows *Historical Mode needs host data access* |

The three layers are explained in [onboarding](../../operations/00-developer-onboarding.md);
`npm run doctor` reports which ones a machine has.

Warm-up and live ticks meet in the runtime; the archive is a separate path used
only by Historical Mode. A successful warm-up does not prove an archive
partition exists, and an archive answer says nothing about the live collector
today.

Live Mode also has a bounded `band_history` request for a historical price band.
The laptop sends the instrument, price range and time window through Terminal C;
the host replays its recorded raw depth and returns resting size and traded
flow per row. Institutional Order Blocks v1 reads a block the visible live
history did not cover from the host's stored heatmap columns first
(`/heatmap/columns`, cut to the block's rows in the browser) and uses
`band_history` only when the host has no stored columns for the pair or that
read fails. Session Levels reads a touched level's five minutes and a range's
totals from the same stored columns, with no raw-replay fallback. A missing book interval remains a gap, never a
zero-liquidity observation. Each host read is capped at two hours, 256 rows and
100,000 row/column cells; the client pieces longer requests. This is an
on-demand derivation, **not a stored canonical L2 row dataset**, and it does
not make order-book indicators available in the separate Historical Mode
archive. See the [wire contract](../../contracts/ws-frame-contract/v1/ws-frame-contract-v1.md)
and `apps/runtime/src/server/band-history.js` for the exact boundary.

## What each instrument has

| Instrument | Live ticks | Warm-up from the host | Historical candles | Historical studies |
|---|---|---|---|---|
| BTC, ETH spot and perpetual (Binance) | always | yes | 1m, 1h, 1d, each with taker buy volume | none yet |
| ES, NQ (continuous futures) | with layer 2 | yes, what the weekday collector captured | 1m, 1h, 1d | profile, VPIN, large prints, bar flow |
| AAPL, TSLA (equities) | with layer 2 | yes, what the weekday collector captured | 1m, 1h, 1d | profile, VPIN, large prints, bar flow |
| NVDA (equity) | with layer 2 | yes, what the weekday collector captured | not archived | none |

**Equity candles are regular session only**, live and historical alike:
09:30–16:00 New York time, with the exchange's holidays and early closes from
[`config/market-calendar.json`](../../../config/market-calendar.json). Hourly
bars start at 09:30, the last one ends at the bell, and a daily bar is that
session. Pre-market and after-hours prints are not in equity candles. Futures
and crypto candles are UTC-aligned and cover every traded minute.

Other timeframes are resampled in the browser from those rungs. The governed
instrument list, exact provider symbols and tick sizes live in
[`config/market-instruments.json`](../../../config/market-instruments.json);
the archive's list lives in `apps/web/src/lib/archive/historicalCatalog.ts`.

The four studies are computed on the host from trade-derived families, so the
browser never pages minute rows. Their request, limits and refusals are in the
[archive study contract](../../contracts/archive-study/v1/archive-study-v1.md).
In short: a profile per requested range, VPIN over whole UTC weeks (at most 26),
and large prints and bar flow over one bar-aligned range of at most 5,000 bars.

## Which indicators work in Historical Mode

`HISTORICAL_INDICATOR_POLICIES` in `apps/web/src/lib/chart/indicatorRegistry.ts`
decides this, per indicator, from the capabilities the selected archive
provides. There are three policies:

| Policy | Needs | Works on |
|---|---|---|
| Candles | `ohlcv` | every archived instrument |
| Candle flow | `ohlcv` + `buy_volume` | Binance (candles carry taker buy volume) and ES/NQ/AAPL/TSLA (the `bar_flow` study supplies both sides) |
| Trade families | `ohlcv` + `trade_families` | ES/NQ/AAPL/TSLA |

An indicator can also be marked unavailable with a reason, as order-book and
every-trade indicators are: the archive has no historical depth and keeps only
the largest prints of each minute.

## Rules every indicator follows

**Read buy and sell through `barSides`.** Never compute sell volume as
`volume - buy_volume`. `apps/web/src/lib/indicators/barSides.ts` returns
`{known, buy, sell, unknown, delta, sided}` for a bar. It uses an explicit
`sell_volume` when the bar has one, and falls back to `volume - buy_volume`
only for bars that carry just a buy side. That fallback is exact for Binance,
where every trade has a taker side. It is not exact for equities.

**Unsided volume is real and large for equities.** A Databento equity trade
often has no aggressor side. Measured on the host (Report 54): ES and NQ are
effectively fully sided, but AAPL is about 40% unsided on one-minute bars and
65–75% on hourly and daily bars; TSLA is 35–55%. Historical bars carry that
volume separately as `unknown`, and `unsidedShare(bars)` gives the share to
show beside an equity delta. Counting it as selling would make every equity
delta read bearish by that amount.

Live dxFeed bars built from the tape carry buy and sell only when every trade in
that minute had a side. A minute with any unsided trade carries neither, so
`barSides` reports it unknown and it draws no delta, which is common for
equities. Stored native dxFeed candles carry both sides explicitly (volume at
the ask and at the bid), with any remainder unknown.

**`missing` is not `empty`.** A study reports ranges it could not read as
`missing`; draw them as unavailable, never as zero. It reports ranges it read
and found no trades in (a weekend, an overnight hour for an equity) as `empty`,
and those legitimately have nothing to draw. A bar with no trades is absent
from `bar_flow`; draw no delta for it, not a zero delta.

**Gate on capabilities, not on provider names.** Declare what the indicator
needs through its `HISTORICAL_INDICATOR_POLICIES` entry. Do not branch on
`provider === "BINANCE"`. The map is typed over every indicator id, so a new
indicator does not compile until it has a policy.

**Warm-up failure is not an empty signal.** When the storage reader cannot
reach the host it reports the read as unavailable. Show the indicator as
warming up or degraded, never as a flat or zero reading.

**Quantities are provider units.** Futures sizes are contracts, equity sizes
are shares, Binance sizes are the base asset. Do not add them across providers
or convert them to a notional the provider did not report.

**Need a new trade-derived aggregate?** Do not fetch minute rows into the
browser. A new study is a change to the archive study contract and the host,
and goes through the owner.

## Adding an indicator that works in both modes

1. Create `apps/web/src/lib/indicators/<name>/`. The folder owns the whole
   indicator: computation, geometry, primitive and settings. Follow the
   [SDK execution model](../indicator-sdk/TA.01-indicator-authoring-core-evidence.md).
   Its settings dialog gets [setting presets](setting-presets.md): a
   `settingsSchema` is enough for the generic dialog, and a hand-built one
   declares a preset schema for every setting it stores.
2. Register it in `INDICATOR_REGISTRY` and give it a
   `HISTORICAL_INDICATOR_POLICIES` entry that names what it needs.
3. Read sides through `barSides`. For example, a cumulative delta that leaves
   bars without a known side undrawn:

   ```ts
   import type { BarFrame } from "../../../types/frames";
   import { barSides } from "../barSides";

   export function cumulativeDelta(bars: readonly BarFrame[]): (number | null)[] {
     let total = 0;
     return bars.map((bar) => {
       const sides = barSides(bar);
       if (!sides.known) return null;
       total += sides.delta;
       return total;
     });
   }
   ```

4. Check it in Live Mode on Binance (every machine can), then in Historical
   Mode on BTC and on one futures and one equity instrument (layer 1). On AAPL,
   confirm the unsided share is shown and the delta is not skewed.
5. Add tests for the computation, lifecycle, capability gating and rendering,
   as listed under *Adding or changing an indicator* in the
   [indicator index](README.md).

## Where the code is

| Concern | File |
|---|---|
| Indicator registration and Historical Mode policy | `apps/web/src/lib/chart/indicatorRegistry.ts` |
| Buy/sell sides of a bar | `apps/web/src/lib/indicators/barSides.ts` |
| Archive instruments and candle rungs | `apps/web/src/lib/archive/historicalCatalog.ts` |
| Study requests and validation | `apps/web/src/lib/archive/archiveStudyClient.ts` |
| When studies are asked for, and how results reach the chart | `apps/web/src/lib/archive/useArchiveStudies.ts` |
| Wire frames the browser accepts | `apps/web/src/types/frames.ts` and the [WebSocket frame contract](../../contracts/ws-frame-contract/v1/ws-frame-contract-v1.md) |
| Warm-up source selection (local or host) | [Storage architecture](../storage/README.md) |
