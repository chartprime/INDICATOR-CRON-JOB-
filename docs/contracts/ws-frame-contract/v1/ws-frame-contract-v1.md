# WS Frame Contract v1

The shape of every message the terminal's WebSocket server sends to a
connected browser tab. Server-side authority is
`apps/runtime/src/server/frames.js` (frame builders + validation);
client-side authority is `apps/web/src/types/frames.ts` (`parseServerFrame`
+ the same validation, re-implemented independently so a compromised or
buggy server cannot hand the client a frame it trusts blindly).

Those two implementations stay independent deliberately — the point of the
client's checks is that they do not trust the server's. What they must not do
is *disagree about the bounds*. `ws-frame-contract-v1.schema.json` is the
authority for every numeric and length limit on this wire, and
`apps/runtime/test/contracts/ws-frame-contract-limits.test.js` reads the bounds
back out of the schema and fails if either implementation has drifted from it.
The apps are separate npm workspaces and `apps/web/tsconfig.app.json` includes
only `src`, so the browser cannot import runtime code; one shared module is not
available across that boundary, and an enforced invariant stands in for it.

v1 is the shape as of DX3.01, extended since: **ten** frame kinds carrying a
`provider` discriminant. DX3.03 now produces the `DXFEED` selection, snapshot, health,
trade, bar, marker, and order-book branches through the live WebSocket server.
dxFeed books are reconstructed only from the exact-index Order-v2 stream; a
partial, snipped, crossed, mixed-source, capacity-breached, quiet, or
capture-faulted book is represented as `UNAVAILABLE` rather than as usable
depth. A raw-index capture fault clears all retained indexed state and requires
a fresh complete snapshot; it is never treated as a one-frame visual warning.

## Client selection restore (W5.01, 2026-09-06)

Client-to-server dxFeed select controls may include the optional literal
`resume: true` alongside `type`, `provider`, `symbol` and `assetClass`. The worker
uses it only when automatically resending an already-sent selection after
socket reconnect. Deliberate selection omits it. The router validates and
forwards the marker; Binance controls reject it. Lazy dxFeed restore cannot
replenish an exhausted or pending full-session retry allowance, or override a
permanent startup rejection. Eager selection does not control its session retry
budget. This extends client controls; server frame shapes/schema are unchanged.
Older clients that omit the marker are treated as deliberate selections; use
the matching frontend/runtime build for the bounded automatic-restore behavior.

## Analytics query availability (W5.02, 2026-09-07)

`analytics_status` carries the normal provider/symbol identity plus
`indicator: "PROFILE" | "VPIN"` and `status: "READY" | "UNAVAILABLE" | "WARMING" | "EMPTY" | "CLOSED"`.
It reports whether the live analytic query succeeded, independently of feed
health. READY does not certify an unbroken capture history or market-wide
completeness. EMPTY is a successful query with no profile trades, CLOSED is a
scheduled market closure, and WARMING means bounded catch-up is not finished.
An existing nonempty profile remains READY when no new trades arrive.

Servers publish status transitions and replay the latest status after snapshots.
The browser withdraws the affected live profile on any non-READY transition,
or VPIN history on UNAVAILABLE,
including queued output, and shows a status label. Historical profiles remain
separate observed-data results. Successful subsequent polling can recover without
resetting the cursor or counting already-applied trades twice.

Snapshot `vpin_status` also permits `DISABLED`. It means VPIN was intentionally
turned off by configuration and no calibration or poll is expected. This is
distinct from `UNAVAILABLE`, which means an enabled VPIN path could not provide
a result. The browser clears retained VPIN history for either state.

Deploy matching frontend/runtime versions: an older strict parser rejects the
new frame kind. The worker now also remembers confirmed shared selection changes
for reconnect, while protecting an outstanding deliberate selection request.
Historical period responses omit periods ending after the last completed minute;
an elapsed prefix cannot carry the requested future closed-period label.

## The `provider` discriminant

Before DX3.01, every frame carried one Binance-shaped pair tag:
`marketKind: "SPOT" | "PERPETUAL"`. Extending that same field to also
describe a dxFeed instrument would have been wrong — dxFeed's own
dimension is asset class (`FUTURE` | `EQUITY`), not spot-vs-perpetual,
and the two are not points on one scale. So `provider` was added as a
new top-level discriminant, and each provider carries its *own* pair
tag:

```ts
type BinanceIdentity = { provider: "BINANCE"; marketKind: "SPOT" | "PERPETUAL"; assetClass?: never };
type DxFeedIdentity  = { provider: "DXFEED";  assetClass: "FUTURE" | "EQUITY"; marketKind?: never };
type FrameIdentity   = BinanceIdentity | DxFeedIdentity;
```

Every frame type is `{ ...frame-specific fields } & FrameIdentity`. A
frame is never partially one provider and partially the other — TypeScript
enforces this at the type level (`frame.marketKind` is a compile error
unless `frame.provider === "BINANCE"` has already been checked), and
`parseFrameIdentity`/`assertMarketKind`+`assertAssetClass` enforce the
same thing at the wire boundary: a raw message with `provider: "BINANCE"`
and an `assetClass` field is not a valid Binance frame with an extra
field, it fails identity parsing entirely.

**Existing Binance frames changed by exactly one thing**: every builder
in `frames.js` now stamps `provider: "BINANCE"` on its output. No
existing builder's parameters or internal logic changed — this was a
hard constraint DX3.01 found and kept: `market-data-server.js` calls
these builders positionally at 13+ call sites, so a signature change
there was explicitly out of scope.

## Frame kinds

| Kind | Carries | Notes |
|---|---|---|
| `trade` | one executed trade | tape row. A dxFeed equity trade may carry `auction: true` for an opening, closing or periodic-auction/cross print; it remains in the tape and bar but is excluded from large-trade visuals. The field is absent on Binance frames. Older strict browser parsers reject this additive field, so Terminal C and D must be updated together. |
| `marker` | one large/whale trade | derived from `trade`, own dedup id. Selection is by **magnitude rank within a 60-second bucket and side** — no statistical baseline, no threshold, and no provider-specific floor; see `docs/architecture/indicators/P4.01-large-trade-detector-evidence.md`. The optional `baseline_log_median`/`baseline_log_mad` fields (added v2, 2026-08-29) are **deprecated as of 2026-09-02 and are no longer emitted by any server**; the detector that consumed them was removed. Parsers still accept them so pre-existing captures and older clients keep working, and they may be dropped from the contract once no stored frame carries them. Unlike `trade`/`bar` frames, a marker has no lower-bound age check on `ts_exchange` — it is a permanent historical record, not a live-only concept, so an arbitrarily old marker still parses (the future-skew upper bound still applies to all three). A marker is always broadcast **after** the trade frame it derives from. |
| `bar` | one OHLCV candle | dxFeed bars are locally aggregated from NEW TimeAndSale for both asset classes. Futures require `validTick`; equities retain real fractional-share fills when `validTick:false`. `buy_volume` is omitted when any included print lacks a safe side classification. `reconstructed: boolean` (optional, Binance only, 2026-08-28) marks a bar sourced from REST kline backfill rather than genuinely captured — see below. |
| `snapshot` | bars + trades + markers, and the pair's pool of big prints | sent once per pair switch; every nested item's identity must match the snapshot's own `provider`/pair tag, or the whole snapshot is rejected. `aggressive_prints` (2026-09-14, at most 20,000 trade frames, oldest first) is the server's pool of the pair's biggest prints over the last four hours, the way `markers` is its pool of large trades: warmed from the collector's recording on pair warm-up (the newest fifteen minutes at no floor to calibrate, then hourly chunks back at that floor), fed live from the trade stream, complete from `aggressive_prints_floor` (the size only the top 2% of the pair's recent prints reach, raised when the pool trims to its cap) over [`aggressive_prints_from`, now]. The three pool fields come together or not at all. The browser lays them under the Aggressive Orders tape by trade id and asks the collector only for what they leave uncovered at the floor in force. |
| `health` | feed recovery state | `RECOVERING`/`UNAVAILABLE` always imply `stale: true`. dxFeed frames may also carry `printsQuiet: boolean` (2026-08-26) — see below. Binance frames may also carry `recordingStale: boolean` and `recordingLatestTs` (2026-09-15) — see below. |
| `book` | order book (`READY`) or a reason (`UNAVAILABLE`) | Binance and dxFeed use the same bounded shape; dxFeed `READY` requires a complete source-specific indexed snapshot |
| `selection` | server-confirmed active pair | Carries one pair because a frame describes one pair, in that provider's own pair-tag shape. This is **not** a statement that the server holds one selection per tab — selection is shared across connected clients, which is the server's semantics, not this frame's. |
| `profile` | one volume or delta profile | `continuous`, `per_candle` or `fixed_range`. `period_end_ts` is `null` while the period is still developing. `row_width` is the resolved price width of one bucket, after `ticks_per_row` is applied. Bucket count is bounded; see the schema. A bucket's `volume`, `buy_volume` and `sell_volume` are bounded by `profileVolume`, not by the shared magnitude ceiling: one row of an equity profile holds a summed share count, and a long range on a liquid name passes ten million shares (an AAPL row over a year approaches ten billion). Prices retain the shared ceiling; bar volumes use `barVolume`, and dxFeed equity trade sizes use `equityTradeSize`. |
| `vpin` | one sealed VPIN reading | Volume-sealed, not time-ruled, so readings arrive irregularly and a client maps them onto its own bars. `direction` is `null` exactly when `active` is false. Historical readings arrive in bulk on `snapshot.vpin_readings` rather than as individual frames. |
| `liquidity` | L2 passive-liquidity heatmap columns (+ optional walls) for the active pair | Additive, 2026-09-08. Delta-encoded resting size per price row, up to three tiers told apart by `column_ms`, each `seq`-chained, the coarse one on rows of its own width. See the dedicated section below. |
| `l2_view` | columns of heatmap zoom lane 1–6 (recent and deep tier) | Opt-in capability, 2026-09-28. The `liquidity` column encoding on wider, coarser lanes; `seq` per (lane, tier). See "L2 channels" below. |
| `l2_walls` | the engine's walls with stable ids and whale detail | Opt-in capability, 2026-09-28. Changed walls and removed ids per frame, or the whole set on `reset`; `seq` +1 per frame. |
| `l2_events` | wall lifecycle, near-price trades and hidden fills, segment changes | Opt-in capability, 2026-09-28. Capped per frame with a `missed` count; `seq` counts events. |
| `l2_ladder` | the exact order book, up to 50 levels a side | Opt-in capability, 2026-09-28. Latest state, no chain. |
| `iceberg_orders` | the Iceberg Detector's icebergs for the active pair | Opt-in capability, 2026-10-08. A reset page replaces, an increment carries what changed; icebergs are idempotent by `id`. See "`iceberg_orders`" below. |
| `exhaustion_shades` | the Exhaustion engine's shades for the active pair, every candle length together | Opt-in capability, 2026-10-10. A reset page replaces, an increment carries what changed; shades are idempotent by `id`. See "`exhaustion_shades`" below. |
| `initiative_bands` | the Initiative Continuation engine's bands for the active pair, every candle length together | Opt-in capability, 2026-10-14. A reset page replaces, an increment carries what changed; bands are idempotent by `id`. See "`initiative_bands`" below. |

Snapshots are bounded to 10,080 bars, 100 trades, and 60,000 markers.
READY books are bounded to 20 levels per side. `liquidity` frames are
bounded to 120 columns, 2048 rows per column, and 400 walls. Runtime builders and the
browser parser enforce the same limits so the server cannot construct a frame
that its own client rejects.

## `reconstructed` — marking REST-backfilled bars as such (2026-08-28)

When storage doesn't cover a pair's full warm-up window, `market-data-
server.js`'s `ensurePairWarm` falls back to Binance's REST `/klines`
endpoint to fill the gap (`restKlineRowToBarFrame`). That data is real,
not fabricated, but before this it was wire-identical to a genuinely
captured or stored bar — nothing distinguished a reconstructed bar from
one the collector actually observed live. `restKlineRowToBarFrame` now
stamps `reconstructed: true` on every bar it builds; `klineEnvelopeToFrame`
(live) and `storageCandleRowToBarFrame` (collector-captured) never set
it, so its absence is itself meaningful — a bar with no `reconstructed`
field is guaranteed genuine. The field is optional and additive: an
older client that doesn't know about it still parses the bar correctly,
it just doesn't see the distinction.

The flag describes the copy currently held, not the minute's history.
`history.js`'s `recordBar` is last-write-wins by `ts_open`, and
`repairDetectedKlineGap` re-runs the full backfill window when a live kline
gap is detected, so a minute already delivered as genuine can later be
re-sent carrying `reconstructed: true`. That is deliberate — a later REST
fetch is authoritative on values — but it means the flag can appear on a
bar that was previously observed live, and never the reverse. So absence
still guarantees genuine at the moment of delivery, while presence means
only "this copy came from REST", not "this minute was never captured".
A consumer caching bars by `ts_open` must expect the flag to turn on, and
must not treat it as stable per minute.

This is intentionally a backend/data-contract disclosure only. The product
decision is to keep rendered candles visually identical: `ChartPanel.tsx`
does not add an origin badge, colour, or shape distinction. Any research or
export consumer that needs lineage must read `reconstructed` from the wire
frame; it must never infer capture status from candle appearance.

dxFeed has no equivalent REST reconstruction path. `warmUpBars` in both
dxFeed WS servers sends available locally observed closed bars, including a
partial window where storage does not reach the requested start. A missing
minute is not evidence of zero volume and, from candle rows alone, cannot be
distinguished from a capture gap. Consumers must therefore treat dxFeed warm-up
as **observed non-empty bar history**, not as a complete vendor-history claim.
The reader's `startsAtRequestedWindow` fact says only that the first observed
row begins near the requested start; it does not prove internal contiguity and
must not be used as a completeness assertion. The server maps it to the
additive snapshot `bar_history.coverage` value (`START_COVERED`,
`START_NOT_COVERED`, or `NO_ROWS`) together with availability and the earliest
observed open time.

## `printsQuiet` — distinguishing a quiet market from a broken connection (2026-08-26)

Before this addition, a dxFeed instrument's `recoveryState` could only
ever move `RECOVERING` → `READY` on the first successful valid-NEW
TimeAndSale print, with no timeout or
fallback. A real, current market closure — no new qualifying prints at
all — was therefore indistinguishable on the wire from a genuinely hung
connection: both sat at `RECOVERING` forever, driving the same alarming
"Recovering feed…" UI treatment. Live-observed: the collector's own
Order/Trade activity kept updating for a futures instrument while
TimeAndSale was genuinely empty, confirming the market was quiet, not
the connection.

`recordingStale` and `recordingLatestTs` (2026-09-15) are Binance-only,
optional, and about the collector's recording rather than the feed: the
runtime reads the newest trade the collector has written for the active
pair at most every five seconds, and reports `recordingStale: true` once
that trade is more than 120 s old or the recording cannot be read at all.
`recordingLatestTs` is that trade's exchange time in ms, present whenever it
is known, so a client can say how far behind the recording is on its own
clock. `recordingLatestTs` is never sent without `recordingStale` beside it.
A stale recording never changes `recoveryState` or `stale`: the feed the
chart draws from is fine, what is missing is the history the indicators
rebuild from tomorrow. The frontend shows it as a separate chip beside the
feed chip, never in place of it. On 2026-09-15 the collector died at
05:27 UTC and nobody knew until a query the next afternoon; this is the
field that makes that visible within two minutes. dxFeed's `healthFrame`
builder never sets either, so both are always absent on dxFeed frames.

`printsQuiet` is a new, dxFeed-only, optional boolean carried alongside
`stale`/`recoveryState` — deliberately not a new `recoveryState` value,
since `RecoveryState`/`HealthFrame` are shared, provider-agnostic types
and `recoveryState`'s own invariant ("non-READY requires `stale: true`")
doesn't fit a quiet-but-otherwise-healthy market. Binance's `healthFrame`
builder never sets it, so it is always absent on Binance frames.

Both dxFeed server modules (`dxfeed-market-data-server.js` lazy,
`dxfeed-eager-market-data-server.js` eager) track, per instrument, the
time since the last qualifying print. If 90 seconds pass with no such
print, `printsQuiet` flips to `true` and a corrected health frame is
published — independent of whether `recoveryState` is currently
`RECOVERING` (never printed yet) or `READY` (was printing, then went
quiet) — and clears back to `false` the moment a fresh qualifying print
arrives. It never applies once `recoveryState` is `UNAVAILABLE`: a real
connection failure always takes priority and is never softened into a
"quiet market" reading.

The frontend treats `printsQuiet` as informational, not alarming: the
status chip shows a neutral "QUIET" state instead of "RECOVERING"/"LIVE",
and the chart overlay is suppressed entirely (not blurred) whenever
existing history is already on screen — only the chip communicates the
state in that case. `UNAVAILABLE` always keeps its existing blocking
"Feed unavailable" treatment regardless of `printsQuiet`, with one exception:
reason `DXFEED_NOT_CONFIGURED` means this machine has no dxFeed token broker,
not a failure. The runtime keeps serving the instrument's recorded host
history, and the frontend shows a neutral "History only" state instead.

## Symbol / asset-class validation — no hardcoded contract enum

Binance validates `symbol` against a fixed two-entry allowlist
(`BTC-USDT`, `ETH-USDT`) because those never change. dxFeed futures
contracts roll quarterly (`/NQU26:XCME` stops being current after
rollover), so the same fixed-enum approach would silently start
rejecting valid symbols after every roll. This follows the precedent
already set in `dxfeed-instrument-catalog.js` and the DX2.01 storage layer: validate
the **stable root**, accept any correctly-shaped dated contract.

```
FUTURES_ROOTS = { "/NQ", "/ES" }
EQUITY_SYMBOLS = { "AAPL", "TSLA" }
FUTURES_SYMBOL_PATTERN = /^(\/[A-Z]{2,3})[FGHJKMNQUVXZ]\d{2}:[A-Z]+$/
```

`isAllowedDxFeedSymbol(symbol, assetClass)`: for `EQUITY`, exact
membership in `EQUITY_SYMBOLS`; for `FUTURE`, the symbol must match the
pattern *and* its extracted root must be in `FUTURES_ROOTS`. A symbol
that matches neither branch (including a Binance symbol like
`BTC-USDT` presented under `provider: "DXFEED"`) is rejected. The
reverse spoof — a real dxFeed symbol presented under `provider:
"BINANCE"` — is rejected too, since it will never appear in the
two-entry Binance allowlist. Both directions are round-trip-tested on
both sides of the wire.

`dxfeedToWireSymbol`/`dxfeedFromWireSymbol` are identity passthroughs
(no transform) — unlike Binance's `BTCUSDT` → `BTC-USDT` hyphen
insertion, dxFeed's own symbols (`/NQU26:XCME`, `AAPL`) are already in
their wire-ready form.

## Why the dxFeed trade/marker builders take flat fields, not a raw envelope

Binance's `tradeEnvelopeToFrame(envelope)` converts a raw envelope to a
frame in one step because Binance's envelope already carries everything
a `TradeFrame` needs (`tradeId`, `isBuyerMaker` → `side`). dxFeed
`TimeAndSale` must first be adapted into the same resolved fields
(`symbol, assetClass, price, size, tsExchange, side, tradeId`), so
`dxfeedTradeFrame`/`dxfeedMarkerFrame` intentionally take those flat
fields rather than a raw envelope.

Both equities (`AAPL`/`TSLA`) and futures (`/NQ`/`/ES`) use the same
`STREAM` `TimeAndSale` wire plan and `aggressorSide` classification:
`"BUY"` maps to `buy`, `"SELL"` maps to `sell`, and `"UNDEFINED"` (or
any other value) is never guessed. A side-unknown print still contributes
to locally aggregated OHLCV but makes directional volume unavailable; it
is omitted from the sided tape/marker stream. Only `type: "NEW"` prints
materialize live frames. Futures additionally require `validTick:true`;
equities deliberately retain qualifying real fractional-share
`validTick:false` prints, making their local series a terminal methodology,
not a dxFeed/vendor Candle equivalent. `CORRECTION`/`CANCEL` and invalid
futures ticks remain durably captured but do not revise an already
materialized local bar. `TimeAndSale.index` is a real 64-bit value that
can exceed `Number.MAX_SAFE_INTEGER`; it is normalized to `null` via the
same `resolveOrderIdentifier` guard used for `Order.index`/`orderId`, never
passed through as a raw number.

This stream is not a guaranteed lossless historical tape or a vendor-candle
substitute. Research must account for observed-print capture coverage,
the asset-class `validTick` policy, and the absence of correction replay.
`dxfeedHealthFrame` and
`dxfeedSelectionFrame` are live today; `dxfeedBookFrame` takes pre-assembled
levels — assembling them is DX3.07's scope.

## `liquidity` — L2 Passive Liquidity heatmap (2026-09-08)

Added as an additive frame kind — nothing else in this contract changed.
Server authority `apps/runtime/src/server/frames.js` (`liquidityFrame` /
`dxfeedLiquidityFrame`), client authority `apps/web/src/types/frames.ts`
(`parseLiquidityFrame`), hand-kept in sync, numeric limits reconciled by
`ws-frame-contract-limits.test.js`.

Resting order-book size per price row, one column per `column_ms`, for the
active pair. The chart paints it as a heatmap under the candles and as a
size ladder in the price axis.

```ts
type LiquidityEntry = [offset: number, size: number]; // row = column.lo + offset; size 0 = the row emptied

type LiquidityColumn = {
  ts: number;            // column time, epoch ms, aligned to column_ms
  lo: number;            // first row of the window; price = row * row_width
  hi: number;            // last row of the window (inclusive); hi - lo + 1 <= 2048
  bid: LiquidityEntry[]; // rows whose resting bid size differs from the previous column
  ask: LiquidityEntry[]; // same for asks; offsets strictly increasing, at most one per row
  buy?: LiquidityEntry[];  // the flow (2026-09-14): aggressive buy volume that printed per row in the second ending at ts, plus what printed in the second before it and reached the runtime only after that column was taken (2026-09-20); the whole flow, never a delta
  sell?: LiquidityEntry[]; // same for aggressive sells
  prints?: LiquidityPrint[]; // the biggest prints of that second, and of the one before it when they reached the runtime late (2026-09-20), every one at or above prints_floor, at most 64
  prints_floor?: number;     // the size from which prints is complete for this column's covered print window; raised when a print-count cap excludes a size group
};

type LiquidityPrint = {   // one aggressive print, as the live trade frame carried it
  ts: number;            // epoch ms, at most two column widths before the column ts (its own second, or the one before when it arrived late) and one after
  price: number;
  size: number;          // base unit of the pair
  side: "buy" | "sell";  // the aggressor
  id: string | null;     // the trade id the live trade frame carries, so the browser dedupes; null when the source had none
};

type LiquidityLevel = {   // a wall: a cluster of adjacent rows that is large for this book
  side: "bid" | "ask";
  row: number;           // lowest row of the cluster; price = row * row_width
  span: number;          // rows in the cluster, >= 1; the wall covers row .. row + span - 1
  start_ts: number;      // column in which it first qualified
  end_ts: number | null; // column in which it fell under half the threshold; null while resting
  size: number;          // resting size now (0 once gone)
  peak: number;          // largest size it showed; >= size
  ended_by: "filled" | "partial" | "hit" | "pulled" | "moved" | null; // see Walls; null while resting
  ratio: number;         // peak as a multiple of the typical row near price when the wall qualified; 0 when unknown
  chain: number;         // id of the first wall of the trace this wall belongs to; 0 when it never moved
  fill: number;          // of the size that has left it so far, the share that traded rather than being cancelled, 0..1
  eaten: number;         // of the most it ever held, the share that has traded on its rows, 0..1
  absorbing: boolean;    // resting, being traded into, and still holding most of its peak
};

type LiquidityFrame = {
  type: "liquidity";
  symbol: string;        // wire symbol, e.g. "BTC-USDT"
  ts: number;            // time of the last column in the frame, epoch ms
  seq: number;           // columns ever sent for this pair, including this frame's
  reset: boolean;        // true: discard what you have; the first column here is complete
  row_width: number;     // price height of one row (BTC: about $2); the coarse tier carries its own, wider one
  column_ms: number;     // time width of one column: 1000 for the recent tier, 10000 for the deep tier, 300000 for the coarse tier (see Tiers)
  columns: LiquidityColumn[]; // 1..120 in time order; 0 allowed only with reset
  levels?: LiquidityLevel[];  // at most 400; present when the wall set changed, on the first live column, and on the last replay chunk
  aggressive?: LiquidityAggressive[]; // at most 200; present when the cluster set changed, on a reset, and on the last replay chunk
  backfill?: { status: "RUNNING" | "COMPLETE" | "FAILED"; reason: string | null }; // history-fill progress for the pair (2026-09-18); absent before a pass has started
} & FrameIdentity;

type LiquidityAggressive = { // an aggressive-order cluster: same-side market volume printing on one level (2026-09-09)
  side: "buy" | "sell";  // buy: market buyers lifting asks; sell: market sellers hitting bids
  row: number;           // lowest row of the level(s) it printed on; price = row * row_width
  span: number;          // rows, >= 1 (a sweep across neighbouring levels in one column is one cluster)
  start_ts: number;      // column of its first print
  end_ts: number | null; // column of its last print once it has gone quiet for the gap (5 s); null while still printing
  volume: number;        // aggressive volume printed so far, in the frame's base unit
  peak: number;          // the most it printed within one column; <= volume
  floor: number;         // the server's reporting floor when the cluster first qualified, in the base unit
};       // provider: "BINANCE" + marketKind, or "DXFEED" + assetClass
```

### The flow on a column (`buy`, `sell`, `prints`, `prints_floor`)

Every column can carry what traded during its second (its window, on the
deep tier) next to what rested: `buy` and `sell` sum the aggressive volume
per row on the aggressor's side, and `prints` lists the biggest prints of
the second by name. The publisher drains the engine's prints at every tick,
and the backfill drains its replay engine at every boundary, so a rebuilt
column carries the same flow as a live one (`liquidity-backfill-equivalence
.test.js`). A print belongs to the column whose ts is the first at or after
it. The deep tier sums the volume per row and pools the prints of its ten
seconds, keeping the largest 64 at the highest floor of the window.

`prints_floor` is the size only the biggest 2% of the pair's recent prints
reach (4,096-print window, 200 to warm up, 0 until then), measured on the
server as the column printed, so a column says for itself from which size
its `prints` are complete. The browser lays the prints under the Aggressive
Orders tape by trade id, the same way it lays an `aggressive_history` reply,
and asks the collector only for the stretches the columns do not cover at
the floor the trader has set (`historyRequestFor` in
`aggressive-orders/columnPrints.ts`). A column that predates the flow (a
store written before 2026-09-14) carries none of these fields.

### Backfill status (`backfill`)

History for a pair fills in behind the live columns after a switch or a
reset; `backfill` (2026-09-18) makes that pass visible on the wire instead of
leaving a slow or failed one indistinguishable from "no history yet." It is
attached to the live-tick frame while it changes and, like `levels` and
`aggressive`, to the last chunk of a replay/snapshot pass — not to every
frame.

| `status` | meaning | `reason` |
|---|---|---|
| `RUNNING` | the pass is in flight; live columns keep arriving meanwhile | `null` |
| `COMPLETE` | the pass finished, with or without applying real history | `null` when it found and applied history; otherwise a diagnostic code, e.g. `"NO_DATABASE"` (no local recording for the instrument) or `"NO_DATA_IN_WINDOW"` |
| `FAILED` | the pass itself errored; this instrument is running on live data only until the next attempt | `"WORKER_ERROR"` |

`reason` is not a closed vocabulary the client switches on the way
`aggressive_history`'s is — it is diagnostic text for logs/telemetry, not UI
copy; the client's own behaviour should key off `status` alone. `backfill`
absent from a frame does not mean `COMPLETE` — it means the publisher has
not attached a status to that frame, most often because backfill has not
started sampling for the pair yet.

### Aggressive orders (`aggressive`)

Where market buyers and market sellers print, for the Aggressive Orders
indicator (bubbles in the candle colours, area by `volume`). The server
(`indicators/passive_liquidity/aggressive-orders-tracker.js`) reads the level
ledger's per-record `traded` growth each column: growth on ask records is
buyers, on bid records sellers. Same-side prints on one ledger band within
5 s of the previous print are one cluster; bands within one of each other are
one cluster too. A cluster is sent once its volume reaches the server's floor,
the 90th percentile of what clusters on this book print (re-measured every
10 s, seeded from the store after a restart; `L2_AGGRESSIVE_FLOOR` pins a fixed
one, `L2_AGGRESSIVE=0` turns the list off), and the chart applies the trader's
own per-instrument floor on top. The list carries every reported cluster still
printing plus the most recent ended ones, capped at 200; ended clusters stay as
long as walls do. It replaces the earlier `absorption` list (2026-09-08), which
inferred absorption from the same volume and was withdrawn at the trader's
request: the indicator now shows who hit what, and the heatmap behind it
tells whether the level held.

### Walls (`levels`)

The server tracks a superset and each chart filters by timeframe: a
one-minute chart shows walls from 1.5x the typical row with a walls-only
band of about $40 around price, a five-minute chart from 2x and $100, a
fifteen-minute chart from 2.5x, an hourly chart from 3x and $150. The
profile is picked in the browser from the chart interval and can be pinned
by the user; `ratio` on each wall is what it filters on.

A wall is a cluster of adjacent rows, each holding at least half the entry
threshold, whose total reaches it: at least `L2_HEATMAP_WALL_MULT`
(default 1.5) times the 95th-percentile row size within `L2_HEATMAP_REF_BP`
(default 50 bp) of the column's mid (smoothed; the far book is thicker, so
the reference is local), and at
least `L2_HEATMAP_LEVEL_MIN_USD` (default $500k, converted to base units
from the pair's first quote). The relative part is what lets one setting
serve a perpetual whose typical row holds tens of BTC and a spot book whose
typical row holds a few; the clustering turns stacked rows of size into one
bar. Each column a resting wall follows the cluster overlapping its rows
(an older wall claims first; a younger wall swallowed by it is dropped
silently), and it is tracked until its rows hold less than half the
threshold it entered at. At that
moment it starts a settle (`L2_HEATMAP_WALL_SETTLE_MS`, default 5 s): it
stays on the wire as resting, because depth updates and trades travel on
different streams and the update that shows a level empty usually lands
before the trades that emptied it, and a verdict taken on the spot calls a
swept wall "pulled". A wall whose rows fill again during the settle was never
gone. After it, the verdict is taken on what arrived, with `end_ts` the
moment it left.

Each row of the wall carries its own baseline of traded and cancelled
volume, taken when the wall first covered that row, because a wall slides
sideways and narrows as it is worked and a single sum taken at the start is
not comparable with one taken at the end. Two numbers come out of those
baselines. `fill` is, of everything that has left the wall so far, the share
that traded rather than being cancelled. `eaten` is the volume that has
traded on its rows as a share of the wall's own peak.

`fill` alone was the verdict until 2026-09-06, on the reasoning that the book
cancels a hundred times more than it trades so a fraction of the wall could
never be reached. Measurement said otherwise: over 253 ended walls on BTC
perp not one was ever called filled or partial, while a wall of 83.6 coins
with 43.6 printed on its rows came out at `fill` 0.01, because the churn
around it cancelled thousands. A share of the wall is reachable, and it is
what a trader means by a level being eaten. Either number can now carry a
verdict. The seven states:

- resting: on the book, `end_ts` null, `absorbing` false.
- absorbing: resting, trades landed on its rows within the last 5 s, and it
  still holds at least half its peak. Being hit and refilled.
- filled: at least half of what left it traded, or half its peak printed on
  its rows (`eaten` >= 0.5).
- partial: at least a fifth of what left it traded, or `eaten` >= 0.15.
- hit: pulled at the touch. Price was at or through its rows within the
  last 10 s before it left, and it left mostly by cancelling.
- pulled: withdrawn before price got there.
- moved: pulled or hit, and re-placed within 15 s on the same side within
  30 rows at a similar size; both carry `chain`. A pulled wall
that reappears within 15 s on the same side, within 30 rows (about $120 on BTC), at a size
within 35% of its peak is the same order re-placed: the old wall becomes
"moved" and both carry `chain`, the id of the first wall of that trace, so
the chart can draw a bot's path as one stepped bar (a wall that never moved
carries 0; chains adopted from a backfill are renumbered past the live
ids). Ended walls stay in the list for the history window, then
drop. The client keeps the last list it received; a `reset` clears it.
The chart draws each wall as a bar from `start_ts` to `end_ts` (or the
right edge while resting); an eaten wall keeps a bright bar with a dot where
price consumed it, a hit wall a hollow dot, a moved wall a step to its
successor, and a pulled wall stays faint when it rested long enough
(`pulledMinLifeS`, default 45 s) or leaves at once.

### Delta rule

A column is the previous column carried forward, restricted to the new
window, with the listed entries applied on top. A row that was inside the
previous window and is outside the new one is implicitly zero. Both ends
apply exactly this rule, so the server only ever lists rows whose size
differs from that carried-forward value. The first column after a `reset`
has no predecessor: it lists every non-zero row.

### Tiers

The server keeps up to three rings per pair. The recent tier holds
`L2_HEATMAP_HISTORY_S` (default 20 min) of columns `L2_HEATMAP_COLUMN_MS`
wide (default 1 s). Behind it the deep tier holds `L2_HEATMAP_DEEP_S`
(default 4 h; 0 disables it) of columns `L2_HEATMAP_DEEP_COLUMN_MS` wide
(default 10 s, a multiple of the recent width). Each deep column covers one window of `deepColumnMs` and holds, per row, the largest size that rested there at any moment of the window (not one instant), so a wall that stood for a few seconds survives once the recent ring has rolled past it. A window's column is published when the next window begins, on the deep tier's own chain, so the deep tier stays continuous while the recent ring rolls forward; the two overlap over the recent window and the chart paints the fine tier over it. Frames of the two
tiers are told apart by `column_ms`: each tier has its own `seq` chain and
its own `reset`, and a reset of one tier leaves the other alone unless
`row_width` changed. Four hours at 10 s is 1,440 columns, about 46 MB of
rows on the server.

Behind the deep tier the coarse tier holds `L2_HEATMAP_COARSE_S` (off
unless set; a week is 604800; it only exists when it reaches further back
than the deep tier) of columns `L2_HEATMAP_COARSE_COLUMN_MS` wide (default 5 min, a
multiple of the deep width, above it) on rows `L2_HEATMAP_COARSE_ROWS`
times as tall as the fine ones (default 40: about $160 on BTC). It is
folded from the deep columns as they land: each coarse row sums the fine
rows it covers, and the window keeps the largest such size, the same rule
as the deep tier; it carries no walls, bubbles or prints. Its frames carry
their own `row_width`, so a reset of the fine tier with a new row width
clears the deep tier (which shares the fine rows) and leaves the coarse one
alone. Behind what the deep tier and the store reach, the server rebuilds
it from the recording in chunks, newest first, sampled at the deep column
width on the coarse rows so both halves of the tier measure the same thing,
once the deep passes are done. A week at 5 min is 2,016
columns of about 60 rows. The chart reads it on the 4h and daily charts.

### Sequencing

`seq` counts columns ever appended to that tier for the pair on the server.
A frame with N columns therefore covers columns `seq - N .. seq - 1` of its
tier. The client checks that each non-reset frame starts where the tier's
last one ended; on a gap it drops the frame and every following one of
that tier until a `reset` arrives, so a stale picture is never extended
with columns that do not chain.

### Delivery

- Live: one frame per `column_ms` with one column, sampled on the column
  boundary from the L2 memory engine's ledger (see
  `indicators/passive_liquidity/liquidity-publisher.js`). Nothing is sent
  until the engine is seeded and the book has a best price. The very first
  column of a pair carries `reset: true`.
- On connect and on pair switch, the retained history is replayed as
  chunks of at most 120 columns per tier, the deep tier first: each tier's
  first chunk is marked `reset`, chained by `seq` like live frames, and the
  walls ride on the very last chunk. When nothing is retained nothing is
  sent; the client's grid is cleared by the `selection` frame and starts
  again on the first live column. Both servers pace that replay the same
  way (`createLiquidityReplayer` in `market-data-server-shared.js`): four
  chunks per event-loop turn, held while the client's socket buffer is a
  quarter of the soft limit or more, live liquidity frames queued behind
  it (300 at most, then the replay starts over), and a `liquidity_resync`
  request carrying no other field replays the history to that client
  again, at most once every 2 s.
- The store (`L2_HEATMAP_STORE=0` disables it, `L2_HEATMAP_STORE_DIR`,
  `L2_HEATMAP_STORE_S`, default every 300 s, and only when a tier changed): the columns and walls the
  publisher has already worked out are written to one small file per pair
  (`indicators/l2-memory/liquidity-store.js`), and read back on start
  before any replay. A column is about 300 bytes delta encoded, so both
  tiers come to a quarter of a megabyte; rebuilding the same picture from
  the recording costs tens of seconds for the recent tier and minutes for
  the deep one. A file no older than the recent window is taken whole and
  only the seconds since its last column are replayed. An older one keeps
  its deep tier and the walls that had already ended, and the recent window
  is rebuilt normally. A file from another row geometry, a later version,
  or one that will not parse is ignored: the store is a cache, never a
  source of truth.
- Backfill (on by default; `L2_HEATMAP_BACKFILL=0` disables it): when a pair
  becomes active and the collector's SQLite exists (`L2_HEATMAP_DB_PATH`,
  default the collector's own file), the history is rebuilt from the
  recording by `indicators/l2-memory/liquidity-backfill.js` (replay source
  -> memory engine -> the live sampler, same geometry) in **two passes**, so
  a restart or a pair switch no longer empties the chart:
  1. the recent tier, `historyS` of fine columns (or only the gap the store
     could not cover, and never more than `L2_HEATMAP_BACKFILL_MAX_S`).
     Live sampling carries on meanwhile on its own chain; when the pass
     lands the ring is rebuilt as the restored columns, then the rebuilt
     ones, then the live ones, and replayed to every client with a reset.
     Progress is replayed the same way at most every
     `L2_HEATMAP_BACKFILL_ANNOUNCE_S` (default 60 s), for the selected pair only and only while a client is connected; the pass landing is replayed at once. The walls the pass's
     own tracker found are adopted so they keep their real ages.
  2. the deep tier, from `deepS` ago (or from the last column the store
     gave back, whichever is later) until the recent window starts, in the
     background while the chart is already live. Its columns are folded
     from fine samples exactly as the live tier folds them (the largest
     size each row held in the window), so a rebuilt deep column equals the
     live one for the same recording. Skipped entirely when the store
     already covers it. Its columns are all older than the recent ones, so
     deep-boundary columns sampled meanwhile wait in memory and land when it
     finishes. Only its walls that **ended** before the
     recent window are adopted: one still resting there is already on the
     chart from the first pass, and adopting it again would draw a second
     bar (or a ghost, if it has since gone). Beyond the recent window the
     tracker keeps only ended walls that meant something: anything price
     reached or that moved, and pulled walls that rested at least a minute.

  Every pass goes through one scheduler per server
  (`liquidity-backfill-scheduler.js`): at most `L2_HEATMAP_BACKFILL_WORKERS`
  (default 1) run at once across every pair, the pair on screen is queued
  ahead of the others, a pass still running after
  `L2_HEATMAP_BACKFILL_TIMEOUT_S` (default 300) is stopped, and stopping the
  server or dropping a pair cancels its passes. A window the recording does
  not reach is answered `NO_DATA_IN_WINDOW` after one indexed lookup, with no
  tape replayed. The replay reads a window's depth events from its anchor
  snapshot's capture time onward (`ts >= captured_at - 60 s`; the first event
  a snapshot needs never precedes it by more than two seconds in the
  recordings measured), never the pair's whole history.

  One chronological pass over both tiers was tried first and is why this is
  split: four hours of replay left price bare and wall-less for minutes,
  because the recent columns and the wall list only arrive at the end.
  **It runs on a worker thread** (`liquidity-backfill-worker.js`): the SQLite
  replay is synchronous, and on the server's own thread a 20-minute rebuild
  starved the event loop enough that Binance REST calls timed out, leaving
  the server with no depth snapshot and no klines. Only the finished columns
  and the wall list cross the thread boundary; the ledger stays in the
  worker. The worker also runs the wall tracker, and the server adopts its
  levels so walls keep the ages they had in the recording (their
  traded/cancelled baseline restarts at the first live column).

### Validation

Both sides: `ts` a sane epoch (client applies the live future-skew guard);
`seq` a non-negative integer no smaller than the column count; `reset` a
boolean; `row_width > 0`; `column_ms` a positive integer; at most 120
columns, strictly increasing `ts`, none later than the frame `ts`;
`0 <= lo <= hi`, window at most 2048 rows; entries `[offset, size]` with
offsets strictly increasing inside the window and `size >= 0`; at most 400
`levels`, each with `start_ts <= end_ts <= ts` (or `end_ts` null),
`peak >= size >= 0`, `ratio >= 0`, `chain` a non-negative integer, `fill`
and `eaten` each from 0 to 1, `absorbing` a boolean that is false on an
ended wall, and `ended_by` (one of filled, partial, hit, pulled, moved) set
exactly when `end_ts` is. A frame failing any check is rejected whole.

### Provenance, resolution and limits

- Source: the level ledger in `apps/runtime/src/indicators/l2-memory/`,
  fed by Binance's unbounded diff depth stream (5000 spot / 1000 perpetual
  snapshot levels, then a change at any price). Bybit-style truncated
  windows would lose the distant walls; this is why Binance is the source.
- Rows and windows are price-relative so one configuration serves every
  pair: a row is `L2_HEATMAP_ROW_BP` of price (default 0.5 bp, about $4 on
  BTC, 8 ledger bands), the window is +-`L2_HEATMAP_WINDOW_BP` around the
  mid (default 600 bp, capped at 1023 rows per side, so about +-$4,000 or
  +-5% on BTC at $4 rows). The chart decides what to paint far from the
  mid; the wire carries the whole window. Sizes are rounded to two
  significant digits before comparison so tiny churn does not appear as
  change.
- Sub-100 ms flicker is invisible: the diff stream batches and the column
  is a one-second sample. A depth gap does not blank the picture (the
  ledger reconciles), but the column at that moment may lag.
- Both providers are wired: Binance (`provider: "BINANCE"` + `marketKind`)
  and dxFeed (`provider: "DXFEED"` + `assetClass`, via `dxfeedLiquidityFrame`
  — sizes are then contracts or shares and `row_width` is a multiple of the
  instrument's tick). Only the active pair is published.

## `aggressive_history` — Aggressive Orders history off the collector (2026-09-10)

The browser builds the Aggressive Orders bubbles itself from the live `trade`
frames. What the feed cannot give it is the past, so the client asks:

```json
{ "type": "aggressive_history", "request_id": 7, "from_ts": 1789040000000, "to_ts": 1789047200000, "min_size": 5 }
```

for the instrument it is on (the server's current selection, like
`profile_history`). The first request has exactly those five fields; a capped
reply supplies an opaque `next_cursor`, and the next request repeats the same
window and floor with that token as a sixth field. `to_ts` is after `from_ts`,
at most a day apart and not in the future; `min_size` is a non-negative number
in the instrument's base unit. The server answers with one frame:

```json
{ "type": "aggressive_history", "symbol": "/NQU26:XCME", "provider": "DXFEED", "assetClass": "FUTURE",
  "request_id": 7, "from_ts": 1789040000000, "to_ts": 1789047200000, "min_size": 5, "complete": true, "reason": null, "next_cursor": null, "retry_after_ms": null,
  "trades": [ { "type": "trade", "...": "ordinary trade frames, oldest first" } ] }
```

- `trades` are ordinary `trade` frames (`tradeFrame` in the schema) with the
  same `trade_id` the live path gives the same print (the exchange's id on
  Binance, the synthesized time/sequence id on dxFeed), so the client can lay
  history under live and drop duplicates by id.
- The rows come straight from the collector recordings (`trades` on Binance,
  `dxfeed_time_and_sales` with `event_kind = NEW`, a known aggressor and, on
  futures, a valid tick) through the storage reader's worker thread. The
  runtime tracks nothing and stores nothing for this: the collector's storage
  is the memory, the server only reads it.
- At most 10,000 trades per reply (`MAX_AGGRESSIVE_HISTORY_TRADES`); past the
  cap the NEWEST part of the window is kept and `complete` is false.
- `reason` is `null` when `complete` is true, and otherwise one of a closed
  vocabulary that tells the client what to do:

  | `reason` | meaning | client response |
  |---|---|---|
  | `CAP_REACHED` | 10,000 eligible rows hit; `next_cursor` names the next page in stable storage order | repeat the same `from_ts`, `to_ts`, and `min_size` with `cursor: next_cursor`; do not record coverage yet |
  | `STORAGE_UNAVAILABLE` | the collector database is missing or cannot be opened | show history as degraded; retry under bounded backoff |
  | `READ_FAILED` | the worker or the query failed | same as unavailable |
  | `CONVERSION_INCOMPLETE` | recorded rows the server could not turn into trade frames | do not record the window as covered |
  | `OVERLOADED` | the server refused or timed out the request under load | retry later with backoff; when `retry_after_ms` is supplied, wait at least that long and preserve the request's cursor |

`next_cursor` is `null` unless `reason` is `CAP_REACHED`. It is opaque: the
client returns it unchanged and never derives continuation from trade time or
trade ID. This makes tied timestamps lossless and prevents a page boundary from
creating false time coverage.

`retry_after_ms` is `null` except on `OVERLOADED`. A non-null value is a
bounded server-directed delay, currently used when the per-client rate budget
is exhausted. The client retries the exact failed request, including its cursor,
after the delay, so a dense multi-page window resumes from its last durable
page boundary rather than starting again.

- Admission is bounded per server, not per client: at most two reads run at
  once (`DEFAULT_MAX_CONCURRENT_READS`), at most 32 requests wait
  (`DEFAULT_MAX_QUEUED`), a request that waited longer than 15 s is refused when
  its turn comes (`DEFAULT_MAX_QUEUE_WAIT_MS`), and one client may ask at most
  60 times a minute (`DEFAULT_RATE_LIMIT`). A refused request is answered with
  `complete: false, reason: "OVERLOADED"`, never dropped silently. Measured on
  the development machine: a typical read is 50-120 ms; the worst case, a
  day-long window with a floor that matches almost nothing, was 7.9 s cold.
- Per client, one read runs at a time and one request may wait; a newer request
  from the same client replaces the waiting one. Only the newest request per
  client is answered; the server tracks the request itself, not the client's
  `request_id`, so a reused id cannot swap an older answer for the newer one.
  A client that disconnects is forgotten: its waiting request never starts and
  its in-flight read, if any, is abandoned (the worker finishes, the result is
  dropped).

## `delta_profile` — traded volume by side per price over a window (2026-09-26)

The Live Delta Profile draws, beside the price axis, the net of market buys
and market sells at every price since the trading day (or week) opened. Live
prints come from the `trade` frames the browser already receives; the past
comes from the collector's trades, read through the host, so the client asks:

```json
{ "type": "delta_profile", "request_id": 9, "from_ts": 1790380800000, "to_ts": 1790434800000, "row_width": 1 }
```

for the instrument it is on (the server's current selection). Exactly those
five fields, plus an optional sixth, `piece_ms`, a whole divisor of the
two-hour piece length no shorter than half an hour (`MIN_PIECE_MS`: 30, 60 or
120 minutes), for a client whose window slides and wants to drop old pieces at
that step. `to_ts` is after `from_ts`, at most eight days apart and not in
the future; `row_width` is a positive price step, and rows sit on the absolute
grid (row price = an integer multiple of `row_width`), so pieces read at the
same width add up whatever their window. The server cuts the window into
pieces on two-hour UTC boundaries (`PIECE_MS`, or `piece_ms` boundaries when
given), reads them newest first, and answers one frame per piece:

```json
{ "type": "delta_profile", "symbol": "BTC-USDT", "provider": "BINANCE", "marketKind": "PERPETUAL",
  "request_id": 9, "from_ts": 1790431200000, "to_ts": 1790434800000, "row_width": 1, "complete": true, "reason": null, "retry_after_ms": null,
  "pending": 7, "rows": [ [84610, 12.4, 3.1], [84611, 0, 7.75] ] }
```

- `from_ts`/`to_ts` are the piece's window, not the request's. `pending` is
  how many pieces will still follow; `0` marks the last. The client adds the
  pieces up as they land and knows the request is done when `pending` is 0.
- `rows` are `[price, buy, sell]` ascending by price, at most 8,192 per piece
  (`MAX_DELTA_PROFILE_ROWS`). `buy` is the volume that traded against resting
  asks in the row, `sell` against resting bids; both from the recording's
  aggressor side, via the same `readVolumeProfile` query Volume Profile uses.
- The reads are per piece so every one stays inside the host's 8 s query
  limit. The runtime waits up to 20 s for a `volume-profile` read (the
  relay's 10 s wait on the host plus a full answer at the measured 200 KB/s),
  and a read that runs out of time, on the host or in the runtime, answers
  `OVERLOADED`. Measured on 2026-09-26 against
  the host: a week of BTC perp (18 M trades) is 28 six-hour pieces of at most
  1.7 s; ETH perp (26.6 M) has six-hour pieces of up to 5.6 s, hence two
  hours; NQ reads a day in under a second. A week of BTC in one request is
  refused by the host (503 at 8.1 s).
- Closed pieces (a whole two-hour piece that ended more than two minutes ago)
  are cached in the runtime per instrument and row width, at most 1,024 pieces
  (`DEFAULT_MAX_CACHED_PIECES`, oldest out: a week is 84 two-hour pieces per
  instrument, so a dozen instruments fit), so a week is read from the host
  once per runtime start and later requests cost only the open piece. A
  piece read less than 30 minutes after it ended (`RECENT_PIECE_TTL_MS`) is
  kept for 30 minutes only and then read again, so a piece read while the
  recorder was behind is not served for good; a backlog longer than that is
  not covered.
- `reason` is `null` when `complete` is true, and otherwise one of:

  | `reason` | meaning | client response |
  |---|---|---|
  | `ROWS_CAPPED` | more than 8,192 rows in the piece at this `row_width` | ask again with a wider row |
  | `STORAGE_UNAVAILABLE` | the recording is missing or cannot be opened | show the profile as partial; retry under bounded backoff |
  | `READ_FAILED` | the worker, the host or the query failed | same as unavailable |
  | `OVERLOADED` | the server refused the request under load, or the recording did not answer in time | retry later with backoff; when `retry_after_ms` is supplied, wait at least that long |
  | `BAD_REQUEST` | the request was malformed (unexpected fields, a window in the future or over eight days, a bad `piece_ms`); the piece echoes its `request_id`, `from_ts`, `to_ts` and `row_width` | fix the request; the same request gets the same answer |

  A request whose `request_id`, `from_ts`, `to_ts` or `row_width` cannot be
  echoed in a piece gets no answer and is logged.

  An incomplete piece carries no rows and ends the request (`pending` is 0):
  the client retries the whole remainder later rather than reading a hole as
  zero.

- Admission is bounded per server, not per client: at most two reads run at
  once (`DEFAULT_MAX_CONCURRENT_READS`), at most 32 requests wait
  (`DEFAULT_MAX_QUEUED`), a request that waited longer than 15 s for a read
  slot is refused when its turn comes (`DEFAULT_MAX_QUEUE_WAIT_MS`), and one
  client may ask at most 30 times a minute (`DEFAULT_RATE_LIMIT`). A request
  goes back to the end of the queue after each piece, so two clients loading a
  week each take turns rather than one waiting a minute for the other. Two
  clients asking for the same piece share one read.
- Only the newest request per client is served; a newer one cancels the older
  (its in-flight read is abandoned unless another client shares it). A client
  that disconnects is forgotten the same way. The server tracks the request
  itself, not the client's `request_id`.

## `band_history` — the book and the flow of a few price rows over a window (2026-09-23)

The L2 indicators grade a level by what the book did at that level's rows,
and the page only holds the last hours of columns. For anything older the
client asks the runtime, and the runtime asks the host's live storage:

```json
{ "type": "band_history", "request_id": 12, "from_ts": 1789040000000, "to_ts": 1789047200000, "price_lo": 84000, "price_hi": 84040, "column_ms": 10000 }
```

for the instrument it is on. Exactly those six fields. `to_ts` is after
`from_ts`, at most two hours apart and not in the future; prices are
positive with `price_hi` at or above `price_lo`; `column_ms` is whole
seconds between one and sixty. The runtime adds the chart's own grid (tick
size, cluster and row width of the live book) so the rows in the answer are
the rows the chart draws, and refuses a band wider than 256 rows. The server
answers with one frame:

```json
{ "type": "band_history", "symbol": "BTC-USDT", "provider": "BINANCE", "marketKind": "SPOT",
  "request_id": 12, "from_ts": 1789040000000, "to_ts": 1789047200000, "price_lo": 84000, "price_hi": 84040, "column_ms": 10000,
  "row_width": 4, "row_lo": 21000, "row_hi": 21010, "complete": true, "reason": null, "retry_after_ms": null,
  "columns": [ { "ts": 1789040010000, "bid": [0, 12.5, "..."], "ask": ["..."], "buy": ["..."], "sell": ["..."] } ] }
```

- Each column is the book as it stood at `ts` and the flow since the previous
  column, at every row from `row_lo` to `row_hi`: `bid`/`ask` resting size
  per row, `buy`/`sell` aggressive volume that printed on the row. All four
  arrays are `row_hi - row_lo + 1` long. At most 7,200 columns per reply.
- **A time with no column is a time the recording does not cover.** The
  client treats it as zero, never as the last known book stretched over the
  gap, and may say so in a hover.
- The runtime keeps nothing: the host replays its own recording for the rows
  asked (the `band-history` live-storage route, cached there) and the runtime
  relays the answer.
- `reason` is `null` when `complete` is true, and otherwise one of a closed
  vocabulary; an incomplete reply carries no columns:

  | `reason` | meaning | client response |
  |---|---|---|
  | `STORAGE_UNAVAILABLE` | the runtime has no host reader, or the host could not answer | show the level as ungraded; retry under bounded backoff |
  | `READ_FAILED` | the read errored, or the host's answer did not fit the wire | same as unavailable |
  | `READ_TIMEOUT` | the host replay worker reached its deadline | split the time piece at an aligned boundary; overlap one column to preserve boundary flow; wait before retrying; pieces at or below the minimum use bounded backoff |
  | `OVERLOADED` | the runtime refused or timed out the request under load | retry later with backoff; when `retry_after_ms` is supplied, wait at least that long |
  | `GEOMETRY_UNAVAILABLE` | the instrument has no live book grid yet (just after a switch) | ask again once liquidity columns arrive; `row_width`/`row_lo`/`row_hi` are null |
  | `BAND_TOO_WIDE` | the band spans more than 256 rows at the chart's grid | do not ask again for this band; narrow it or leave the level ungraded; the row fields are null |
  | `BAD_REQUEST` | the request carried numbers but broke a bound: a window in the future or over two hours, a column not whole seconds between one and sixty | fix the request; do not retry it as is; the row fields are null. A request whose fields are not even numbers is dropped, since there is nothing to answer to |

- Admission is bounded per server, not per client: two reads at once, 32
  waiting, a request that waited longer than 15 s refused when its turn
  comes, thirty asks a minute per client. Per client one read runs at a time
  and one request may wait; a newer request replaces the waiting one and only
  the newest is answered. A client that disconnects is forgotten and its
  in-flight read abandoned. Two clients asking the same window share one read.

Successful adjacent pieces overlap one column. The older piece supplies the
boundary column's complete preceding flow; columns are de-duplicated by time,
never summed twice. An incomplete piece remains ungraded, not empty.

Equity `trade`, `marker` and compact marker-history sizes have a separate
`equityTradeSize` bound of 1,000,000,000,000 shares. Prices and non-equity
single-trade sizes retain the 10,000,000 bound. This is a numeric wire bound,
not a statement that the exchange produces prints of that size. Candle
eligibility (`validTick`, spread legs and provider conditions) is unchanged.

Since 2026-09-30 the same identity bound covers every other size and volume a
dxFeed EQUITY frame carries (schema `sizeAmount`): `book` levels, `liquidity`
bid/ask/buy/sell rows, prints, `prints_floor`, walls and aggressive clusters,
the snapshot's `aggressive_prints_floor`, `band_history` cells and the
`l2_view`, `l2_walls`, `l2_events` and `l2_ladder` sizes. The trigger was
NVDA's 16:00 ET closing cross on 2026-09-29: one 12,281,274-share sell, which
put a flow row above 10,000,000 and was refused. Every other identity keeps
10,000,000. Prices, ratios and distances are not sizes and keep their bounds.

## `marker_history` — the retained large-trade markers, paged (2026-09-20)

The server keeps up to 100,000 large-trade markers per Binance pair — a full
seven-day window at four per side per minute is 80,640 — and it used to put
every one of them in every `snapshot`. At that size a snapshot is a 17 MB
message, re-sent on connect, on every pair switch and on every warm-up slice,
and one such message is most of a slow client's 24 MB allowance. Two things
changed.

`snapshot.markers` now carries only the **newest 5,000** markers (the schema's
`maxItems`), so the snapshot stays one bounded message and the recent bubbles
paint at once. The whole retained set then follows as `marker_history` frames:

```json
{ "type": "marker_history", "symbol": "BTC-USDT", "provider": "BINANCE", "marketKind": "SPOT",
  "reset": true, "seq": 0,
  "rows": [ [1789875397090, 80309.27, 0.15234, "s", "4234567890"] ] }
```

Each row is a marker in positional form — `[ts_exchange, price, size, side,
trade_id]`, side abbreviated to `b`/`s` — and expands to a `marker` frame with
the enclosing frame's identity. A row is 50 bytes on the wire against 176 for
a marker frame. Pages hold at most 5,000 rows, oldest first, and are paced to
each client against its socket buffer like the liquidity replay is.

- `reset: true` is the first page after a snapshot on connect or on a pair
  switch: the client replaces everything it holds for the pair, then applies
  the rows. `reset: false` appends; the history warm-up sends one such page
  per published slice with only the markers that slice added, instead of
  re-sending the whole set inside another snapshot.
- `seq` is the zero-based page ordinal within one reset or append delivery;
  separate deliveries may restart it. It is informational: rows are idempotent
  by `trade_id`, so a client applies every page it gets and does **not** require
  continuity. A same-pair `snapshot`
  arriving mid-session merges its inline markers into what the client holds;
  only a `reset` page or a pair switch replaces it.
- Kind: bulk history. A slow client keeps receiving control and latest-state
  frames while its history pages wait.

A pair with no retained markers sends no page at all. dxFeed pairs retain at
most 5,000 markers, so they fit inline and never page. `marker_history` is a
negotiated extension: after opening the socket, a supporting browser sends
`{"type":"capabilities","marker_history":true}` before selection traffic.
The server sends these pages only to opted-in clients and restores the opt-in
when the provider router returns a client from dxFeed to Binance. This makes a
host-first rolling deployment safe for older fail-closed browser parsers.

## `iceberg_orders` — the Iceberg Detector on the wire (2026-10-08)

One frame kind carries both detection modes of the Iceberg Detector:

```json
{ "type": "iceberg_orders", "symbol": "/NQZ26:XCME", "provider": "DXFEED", "assetClass": "FUTURE",
  "ts": 1789000060000, "seq": 3, "reset": false, "watched": [[1788996400000, 1789000060000]], "liveSince": 1788985660000,
  "icebergs": [ { "id": "/NQZ26:XCME|5137554220647449213|1788999933000", "kind": "native", "confidence": "certain",
                  "side": "bid", "price": 31188, "display": 10, "tranches": 4, "executed": 32,
                  "startedAt": 1788999933000, "markedAt": 1788999940000, "updatedAt": 1789000059000, "status": "filled",
                  "origin": "runtime" } ] }
```

- `kind: "native"` is a CME order the exchange itself refilled: the slot's
  size went back up through a PARTIAL on the same side and price, which only
  the matching engine can do. `confidence` is always `certain`; `tranches` is
  refills + 1.
- `kind: "probable"` is a Binance price level that kept taking more than it
  showed for longer than the learned duration, judged against the pair's own
  distributions (visible-at-touch percentile, episode length, ratio percentile).
  `confidence` is `strong` or `probable` at the mark, and drops to `weak` when
  the level later shows more than the ratio allows; the mark stays.
- `markedAt` is the column where the marker sits: the first refill for a
  native iceberg, the moment the cuts were passed for a probable one.
  `startedAt <= markedAt <= updatedAt` always holds.
- `status: "active"` means the order or episode is still open and the entry
  will be sent again as it grows. `filled`, `pulled`, `replaced` (the order
  was moved or re-entered), `interrupted` (the runtime lost the book under
  it: a re-snapshot, a dropped book or an ended dxFeed session) and `ended`
  (the episode went quiet) are final.
- `reset: true` is the first page on join or on a pair switch and replaces
  everything the client holds for the pair; further pages of one delivery
  append with `reset: false`. An increment is never empty. Icebergs are in
  `markedAt` order within a frame, unique by `id`, and idempotent by `id`
  across frames: the client keeps the entry with the newest `updatedAt`.
  `seq` is informational: the pages of one reset delivery count 0, 1, 2 and
  increments carry a per-pair counter of their own, so it orders nothing
  across the two.
- `liveSince` is on every frame: where the runtime's live window begins, the
  frame's time less the heatmap's live horizon (`L2_HEATMAP_DEEP_S`, or
  `L2_HEATMAP_HISTORY_S` when the deep tier is off; four hours by default), so
  it rolls forward with every frame. The chart's History Off
  shows the runtime's own icebergs marked from there on: the same window
  absorption draws with history off. What is older is the stored history's or
  the host's to bring.
- `origin` says which machine saw the iceberg: `runtime` for this runtime's
  own, `host` for one the host's builder saw over hours this runtime did not
  watch. The chart's History Off shows `runtime` only, across the runtime's
  restarts; a history span adds the host's.
- `watched` is on every frame: the spans, as `[from, to]` epoch-ms pairs in
  ascending and disjoint order, that this runtime watched itself or that a
  host history fill covered (the host's own watched spans, holes of 30 s or
  less merged). Inside a span, no iceberg means none happened; outside,
  nothing is known, and a later fill may bring icebergs from the host. A span
  closes after 30 s without a feed event and a new one opens at the next. The
  runtime saves them with the history, the saved span ending at the earliest
  still-open iceberg's mark so a lost open one is never vouched for. Time
  whose icebergs the history dropped for room is never inside a span. At most
  64 spans, the oldest dropped first.
- Bounds: at most 500 icebergs a frame (a longer snapshot is paged), ids of at
  most 96 characters, prices under the shared magnitude ceiling, `display` and
  `executed` under the identity's size ceiling.
- Kind: incremental, like the L2 chains. A reset delivery is replayed paced
  against the socket buffer; increments that arrive meanwhile queue behind it,
  and an overflowing queue replays the page from the start. A client over its
  send budget keeps receiving increments for the grace period and is then
  closed with 1013, getting a fresh reset page when it reconnects; no
  increment is dropped while the client stays connected.
- Gated by the `iceberg_orders` capability on both providers. The runtime
  keeps the settled icebergs of the last seven days per instrument on disk,
  at most 5,000 of them, the newest by end
  (`<data root>/icebergs/<pair>.icebergs.json`), and serves them in the reset
  page, together with the trackers' learned cuts and the watched spans; the
  cuts start from zero with `L2_ICEBERG_HISTORY=0`, when the saved file is
  refused, or when the file's saved cuts are rejected or absent. With `L2_ICEBERG=0` the channel still answers, with empty pages.
  How the chart draws an iceberg (a card with the total, orders and size per
  order) is described in the chart's README, not here.

## `exhaustion_shades` — the Exhaustion engine on the wire (2026-10-10)

One frame kind carries the runtime's exhaustion shades for the pair, for every
candle length the engine runs (every chart timeframe, 1m to 1D, bucketed on
UTC), the chart keeping the ones of
the candle it is on:

```json
{ "type": "exhaustion_shades", "symbol": "/NQZ26:XCME", "provider": "DXFEED", "assetClass": "FUTURE",
  "ts": 1789000500000, "seq": 3, "reset": false, "liveSince": 1788996400000, "loading": null,
  "shades": [ { "id": "60000|buyers|1788999900000", "candleMs": 60000, "side": "buyers", "status": "held", "intensity": 2, "score": 4,
                "readings": { "rate": true, "progress": true, "delta": true, "divergence": false, "prints": true, "book": false },
                "values": { "rate": 0.3, "progress": 0.2, "delta": -0.25, "divergence": 0.1, "prints": 0.2, "book": 0.95 },
                "raw": { "own": 3, "other": 7, "legOwn": 14.222, "moved": 0, "legMoved": 1.778, "big": 0, "legBig": 0, "extremeOwn": 20, "extremeOther": 0, "bookNow": 1, "bookAt": 2, "bookBand": 0 },
                "startTs": 1788999900000, "endTs": 1789000020000, "extremeTs": 1788999840000, "extremePrice": 31188.25,
                "legStartTs": 1788999300000, "legStartPrice": 31170, "legSize": 18.25, "efficiency": 0.8, "atr": 3.25,
                "judgedAt": 1789000500000, "updatedAt": 1789000500000, "origin": "runtime" } ] }
```

- A shade is a zone of candle closes in the last fifth of a leg where the
  push is fading. The engine builds candles of the mid from its 10-second
  columns, takes Wilder's ATR(14) over them, and catches legs with a
  three-ATR zigzag; it judges every leg it catches, and the chart filters the
  shades by the leg's size in ATR (`legSize / atr`) and straightness
  (`efficiency`, the size over the path of its closes, 0 to 1, as it stood at
  the first shaded close) with its own sliders. `candleMs` is the chart
  candle the engine ran on; `side` `buyers` is a rise ending, `sellers` a
  fall.
- `readings` says which of the six held at the close that first reached the
  shade's highest score, every one relative to the leg itself: `rate` (the pushing side's volume over the
  last two candles under half the leg's per-candle rate), `progress` (price
  gained per unit of pushing volume under half the leg's), `delta` (the last
  two candles' delta against the push), `divergence` (that delta weaker than
  at the candle that set the extreme), `prints` (the pushing side's big
  prints gone or under half the leg's rate), `book` (a half-ATR band beyond
  or behind the extreme pulled, the book at the extreme's candle against
  now). `score` is how many held, 0 to 6; a shade needs three. Big prints at
  or above the leg's rate veto the shade: that is absorption, which this
  indicator does not label. `intensity` bands the score: 1 for 3, 2 for 4 to
  5, 3 for 6.
- `values` are the same six as numbers, from that same close, rounded to
  three decimals, each a finite number within 1,000,000 either side of zero or
  `null` when it cannot be read: `rate` and `prints` the last two candles
  against the leg's own per-candle rate (`prints` null when the leg had no big
  prints on the pushing side), `progress` the price gained per unit of pushing
  volume against the leg's (negative when price went back), `delta` the last
  two candles' (own − other) / (own + other) of the pushing side, `divergence`
  that delta minus the delta at the candle that set the extreme, `book` the
  half-ATR band that decides the reading, the one furthest under its own
  line, now against its size at the extreme (`raw.bookBand` names it;
  `divergence` and `book` null at the extreme's own candle). A reading counts
  under 0.5 (`rate`, `progress`, `prints`), under 0 (`delta`, `divergence`),
  under 0.9 for the band just beyond or 0.75 for the others (`book`).
  Readings are judged on the unrounded numbers, so a value within rounding of
  its threshold (a delta of −0.0004 is sent as 0) can still have counted.
- `raw` holds the sums the six ratios came from, volumes in the instrument's
  own units (base asset, contracts or shares), prices in price units and
  `big` and `legBig` counts of big prints, from the same close, so the chart can say "3.1 BTC against the leg's 16.2" instead
  of "0.19×": `own` and `other` the pushing and the other side's volume over
  the two-candle window, `legOwn` the leg's average pushing volume per two
  candles; `moved` the price gained along the push over the window and
  `legMoved` the leg's average; `big` and `legBig` the pushing side's big
  prints, window and leg average; `extremeOwn` and `extremeOther` the two
  sides over the two candles at the extreme (null until a candle has closed
  there); `bookNow` and `bookAt` the size of the half-ATR band that decides
  the book reading (the one furthest under its own line: 0.9 for the band at
  the extreme, 0.75 for the other two), now and at the extreme, and
  `bookBand` which band that is: 0 the band at the extreme, 1 the biggest
  band beyond it, 2 the band behind it, on the other side of the book (all
  three null before the book can be read). `values.book` is that same band's
  ratio. Each sum is null when unreadable, else finite within a billion
  either side of zero, three decimals; `bookBand` is null, 0, 1 or 2. Twelve
  keys, all required.
- `startTs` is the open of the first shaded candle, `endTs` the close of the
  last (so `endTs > startTs` always); the leg runs from `legStartTs` /
  `legStartPrice` to `extremeTs` / `extremePrice`, the extreme as it stood
  at the first shaded close, with `legStartTs <= extremeTs < endTs`.
  `legSize` and `atr` (the leg's ATR at its start) are in price units;
  `efficiency` is a ratio above 0 and at most 1.
- The verdict has no window: it comes when the move is decided. `status`:
  `open` while the strip extends over consecutive firing closes; `pending`
  once it has stopped and nothing has decided it; then `broke` (a wick past
  the extreme by more than the tolerance, one and a half ATR or a tenth of `legSize`,
  whichever is larger, judged at the close of the candle that made it, even
  while the strip still runs), `held` (a candle came back three ATR from the
  running extreme, the frozen one pushed out by wicks inside the tolerance;
  the same comeback ends the leg) or `interrupted` (a session gap first: a
  feed hole, or a closure that skips more than two candles of the shade's
  length, the frozen book sent while the market is closed making no
  candles).
  `judgedAt` is `null` until one of the three, then at or after `endTs`. One shade per extreme: a leg shades again
  only once price has made a new extreme beyond the last shaded one, and
  several shades of one leg can wait for their verdicts at once.
- `reset: true` is the first page on join or on a pair switch and replaces
  everything the client holds for the pair; further pages of one delivery
  append with `reset: false`. An increment is never empty. Shades are in
  `startTs` order (then `id`) within a frame, unique by `id`, and
  idempotent by `id` across frames: the client keeps the entry with the
  newest `updatedAt`. `seq` is informational: the pages of one reset count
  0, 1, 2; increments carry a per-pair counter of their own; it orders
  nothing across the two.
- `liveSince` is on every frame: the first deep column this runtime process fed
  its engine for the pair. The chart's History Off shows the runtime's own
  shades (`origin: "runtime"`) from there on; a history span adds the ones the
  engine judged over the host's 10-second columns for the days before
  (`origin: "host"`: one day back at start, or from where the runtime's store
  stopped, and more on request, see `exhaustion_history` below) and the ones
  restored from its store (`origin: "stored"`: the judged ones, and the
  waiting ones of the candle lengths from 1h up, whose engine state the store
  keeps).
- `loading` is on every frame: while the runtime is reading the host's columns
  for the pair (the day before the live window at start, or a span a client
  asked for), the start of the span being read; `null` when nothing is being
  read. Every change resends the reset page, so a client always learns when a
  read begins and ends.
- Bounds: at most 500 shades a frame (a longer snapshot is paged), ids of at
  most 96 characters, intensity at most 3, score at most 6, reading values
  within 1,000,000 either side of zero, prices and sizes under the shared
  magnitude ceiling.
- Kind: incremental, like the L2 chains. A slow client may miss an increment
  and recovers on the next reset.
- Gated by the `exhaustion_shades` capability on both providers. The runtime
  keeps the judged shades of the last seven days per instrument on disk
  (`<data root>/exhaustion/<pair>.exhaustion.json`) and serves them in the
  reset page.

### `exhaustion_history` — asking for more days (2026-10-10)

The runtime reads the last day of the host's columns below a pair's live
start (the newest hours that hold columns, empty hours walked past) before
the pair's engines go live. For more, the client asks:

```json
{ "type": "exhaustion_history", "from_ts": 1788480000000 }
```

for the instrument it is on (the server's current selection). `from_ts` is
epoch milliseconds, the start of the span wanted; the server clamps it to
seven days back. There is no direct answer: the runtime judges the span
below its covered start a day at a time, the newest day first, each day by
fresh engines fed oldest first, for the candle lengths up to 30m; the
shades arrive in ordinary
`exhaustion_shades` pages with `origin: "host"`, and `loading` on the frames
says when the read begins and ends. An ask inside a span already covered, an
ask while a deeper one waits, or one made before the pair's start fill is
done is dropped without a word; a malformed one (other fields, a `from_ts`
that is not a non-negative epoch-ms integer) is dropped with a server
warning, like the other client messages. A read that fails part-way keeps the
days it finished, so the client's next ask reads the rest again; a client that
wants a span sends the ask again after a reconnect, since a new runtime
process starts with one day. Gated by nothing beyond the socket: a
client that never declared `exhaustion_shades` can ask and sees nothing.

### `candle_monitor` — the last closed candle for the Candle Monitor (2026-10-11)

Once a second, to every client that declared `exhaustion_shades`, the runtime
sends what happened in the last closed candle of every candle length, for the
pair it is on. The numbers come from the heatmap's own columns and are
independent of the Exhaustion engine: no leg, no side, no threshold.

```json
{ "type": "candle_monitor", "symbol": "/NQZ26:XCME", "provider": "DXFEED", "assetClass": "FUTURE", "ts": 1789000530000,
  "entries": [ { "candleMs": 60000, "candleTs": 1789000440000, "buy": 2.97, "sell": 0.56,
                 "biggestBuy": { "price": 31190, "size": 1.21 }, "biggestSell": { "price": 31186.5, "size": 0.4 } } ] }
```

- One entry per candle length that has a closed candle, in rising candle
  length: `candleTs` is the candle's open (a multiple of `candleMs`),
  `buy` and `sell` the aggressor volumes in the instrument's units (base
  asset, contracts or shares), `biggestBuy` and `biggestSell` the largest
  single trade of each side in the candle (size and price), among the
  heatmap's big prints (about the largest two per cent of recent trades);
  `null` when no trade of that side reached that floor in the candle.
- Only candles the runtime saw whole are counted: a candle joined part-way
  (the first of each length after a start, or after a hole in the feed wider
  than two minutes) and a candle with such a hole inside it are never sent.
  An equity gets the lengths up to 30m only, like the shades. A print whose
  size rounds to nothing is no print.
- Latest state (a newer frame replaces the older); the entries change only
  when a candle closes, so a client shows the same numbers through the
  candle in progress. Nothing is sent before the first close; after a start
  the daily candle waits for the first daily close. Gated by
  `exhaustion_shades`; sent only for the server's current selection.

## `initiative_bands` — the Initiative Continuation engine on the wire (2026-10-14)

One frame kind carries the runtime's initiative bands for the pair, for every
candle length the engine runs (every chart timeframe, 1m to 1D, bucketed on
UTC), the chart keeping the ones of the candle it is on:

```json
{ "type": "initiative_bands", "symbol": "/NQZ26:XCME", "provider": "DXFEED", "assetClass": "FUTURE",
  "ts": 1789000500000, "seq": 3, "reset": false, "liveSince": 1788996400000, "loading": null,
  "bands": [ { "id": "60000|down|1788999300000", "candleMs": 60000, "side": "down", "dominant": "sellers", "dominantShare": 0.75, "score": 4,
               "facts": { "efficiency": { "yes": true, "value": 0.714 }, "closes": { "yes": true, "value": 2 }, "burst": { "yes": false, "value": 0.8 },
                          "delta": { "yes": true, "rank": 1, "share": 0.75 }, "prints": { "yes": true, "rank": 0.833, "perCandle": 1 } },
               "pivotTs": 1788999300000, "pivotPrice": 31188.25, "frozenTs": 1788999480000, "frozenPrice": 31170, "windowCandles": 3, "atr": 3.25,
               "legExtremePrice": 31160, "legExtremeTs": 1788999900000, "legEndTs": null, "updatedAt": 1789000500000, "origin": "runtime" } ] }
```

- A band marks the start of a price leg and says, as facts, whether that
  start was driven. The legs are exactly the Exhaustion engine's: candles of
  the mid folded from the 10-second columns, Wilder's ATR(14), a leg flips
  when price comes back three ATR from the running extreme, session gaps
  reset the structure. The band is born once, at the candle where the engine
  flips the leg; the new leg's pivot is the old leg's extreme
  (`pivotTs` / `pivotPrice`) and `atr` is the ATR at that pivot candle.
  `frozenTs` / `frozenPrice` are the flip candle and its close; the facts
  are read over the window from the candle after the pivot to the flip
  candle, `windowCandles` of them, and never change after. The first leg
  after a warm-up or a session gap is no band: the engine must flip.
  `candleMs` is the chart candle the engine ran on; `side` `up` is a rising
  leg, `down` a falling one.
- `dominant` is the side with the larger aggressive volume in the window and
  `dominantShare` its share (0 to 1): an up leg driven by sellers' flow is
  the sellers', and the chart colours it so. That is the fact, not an error.
- `facts` are the five readings, each `yes` or no with the number it came
  from, rounded to three decimals, `null` when it could not be read:
  `efficiency` (the move from the pivot to the flip close over the path of
  the window's closes, 0 to 1; yes at 0.7 or more), `closes` (the count of
  the window's candles that closed in their strong third, the top third for
  an up leg, the bottom third for a down leg, a candle with no range never
  counting; yes when at least half the window), `burst` (the window's
  per-candle volume over the per-candle volume of the candles just before
  the pivot, as many as the window has and at least three, ending at the
  pivot candle; yes at 2 or more), `delta` (`share`, the pushing side's share
  of the window's aggressive volume, and `rank`, where that share sits among
  the typical candles' per-candle shares of that side; yes at a rank of 0.8
  or more), `prints` (`perCandle`, the pushing side's big prints per window
  candle, the heatmap's print floor, and `rank` among the typical candles';
  yes at 0.8 or more). The typical is the last four hours of candles before
  the pivot, at least twelve of them (1m: 240 candles; 30m and up: 12), and a
  rank is the share of typical candles strictly below the window's value.
  Without twelve candles before the pivot there is no band. `score` counts
  the yeses, 0 to 5; the chart draws every band and fades by score.
- `legExtremePrice` / `legExtremeTs` follow the new leg's running extreme
  while it runs (an increment per move); `legEndTs` is `null` while the leg
  runs and set when the engine ends it: the candle of the next flip, or the
  first candle after a session gap. Those three are the only fields that
  change after birth.
- `reset: true` is the first page on join or on a pair switch and replaces
  everything the client holds for the pair; further pages of one delivery
  append with `reset: false`. An increment is never empty. Bands are in
  `pivotTs` order (then `id`) within a frame, unique by `id`, and idempotent
  by `id` across frames: the client keeps the entry with the newest
  `updatedAt`. `seq` is informational: the pages of one reset count 0, 1, 2;
  increments carry a per-pair counter of their own; it orders nothing across
  the two.
- `liveSince` is on every frame: the first deep column this runtime process
  fed its engine for the pair. The chart's History Off shows the runtime's
  own bands (`origin: "runtime"`) from there on; a history span adds the ones
  the engine read over the host's 10-second columns for the days before
  (`origin: "host"`: one day back at start, or from where the runtime's store
  stopped, and more on request, see `initiative_history` below) and the ones
  restored from its store (`origin: "stored"`; every candle length keeps its
  engine state in the store, so a band whose leg still runs at a stop comes
  back as stored and goes on moving). A band keeps the origin it was first
  seen under: a stored or host band that the live feed moves later stays
  stored or host, so History Off never shows a band born before this runtime
  process started.
- `loading` is on every frame: while the runtime is reading the host's
  columns for the pair (the day before the live window at start, or a span a
  client asked for), the start of the span being read; `null` when nothing
  is being read. Every change resends the reset page.
- Bounds: at most 500 bands a frame (a longer snapshot is paged), ids of at
  most 96 characters, score at most 5, `windowCandles` 1 to 1,000 and the
  strong-close count never above it, ratios 0 to 1, `burst.value` and
  `prints.perCandle` 0 to 1,000,000, prices and the ATR above zero and under
  the shared magnitude ceiling, `frozenTs` after `pivotTs`, `legExtremeTs`,
  `legEndTs` and `updatedAt` never before `frozenTs`.
- Kind: incremental, like the L2 chains. A slow client may miss an increment
  and recovers on the next reset.
- Gated by the `initiative_bands` capability on both providers. The runtime
  keeps the bands of the last seven days per instrument on disk
  (`<data root>/initiative/<pair>.initiative.json`), counted from their
  frozen candle, and serves them in the reset page.

### `initiative_history` — asking for more days (2026-10-14)

The runtime reads the last day of the host's columns below a pair's live
start (the newest hours that hold columns, empty hours walked past) before
the pair's engines go live. For more, the client asks:

```json
{ "type": "initiative_history", "from_ts": 1788480000000 }
```

for the instrument it is on (the server's current selection). `from_ts` is
epoch milliseconds, the start of the span wanted; the server clamps it to
seven days back. There is no direct answer: the runtime reads the span
below its covered start a day at a time, the newest day first, each day by
fresh engines fed oldest first and warmed on the hours below it (five hours
for 1m, up to fourteen for 30m, so the typical is there), for the candle
lengths up to 30m; the bands whose pivot lies in the day arrive in ordinary
`initiative_bands` pages with `origin: "host"`, and `loading` on the frames
says when the read begins and ends. A leg still running where a day's
columns end keeps `legEndTs` `null`; when the read of the next day finds its
end at the session's open, the band is sent again with it. An ask inside a
span already covered, an ask while a deeper one waits, or one made before
the pair's start fill is done is dropped without a word; a malformed one
(other fields, a `from_ts` that is not a non-negative epoch-ms integer) is
dropped with a server warning, like the other client messages. A read that
fails part-way keeps the days it finished, so the client's next ask reads
the rest again; a client that wants a span sends the ask again after a
reconnect, since a new runtime process starts with one day. Gated by
nothing beyond the socket: a client that never declared `initiative_bands`
can ask and sees nothing.

## L2 channels — the L2 engine on the wire (2026-09-28, report 61 P4a)

Four opt-in frames carry what the server's L2 engine knows beyond the
`liquidity` heatmap: wider zoom lanes, walls with their evidence, the events
behind them, and the exact book. `liquidity` is unchanged; a client that does
not opt in receives exactly what it received before, byte for byte.

### Opting in

The `capabilities` message now declares a **set** of flags:

```json
{ "type": "capabilities", "marker_history": true, "l2_view": true, "l2_walls": true, "l2_events": true, "l2_ladder": true }
```

- Every present flag must be `true` and one of `marker_history`, `l2_view`,
  `l2_walls`, `l2_walls_lanes`, `l2_events`, `l2_ladder`, `iceberg_orders`,
  `exhaustion_shades`, `initiative_bands` (`CAPABILITY_FLAGS` in
  `apps/runtime/src/server/l2-frames.js`); anything else refuses the whole
  message, which then changes nothing.
- A message replaces the client's previous declaration. A flag it no longer
  names stops that channel; `{"type":"capabilities"}` alone opts out of
  everything. A newly named channel is replayed from a snapshot at once.
- The provider router keeps each client's set and re-declares it when it
  moves a client between providers. dxFeed receives the set without
  `marker_history`, which is Binance-only.
- The schema marks every opt-in kind with `"x-capability": "<flag>"`.
  - The browser declares its set from one constant (`CLIENT_CAPABILITIES` in `apps/web/src/types/frames.ts`).
  - Its contract corpus test requires a parser and a pinned producer sample for every ungated kind and every declared one.
  - `ws-frame-contract-limits.test.js` requires that each flag the server accepts gates exactly the kind of the same name.

### Frames

| Frame | Chain | Carries |
|---|---|---|
| `l2_view` | `seq` per (`lane`, `tier`), counted as on `liquidity`: a frame with N columns covers seq−N+1 … seq | `lane` 1–6 (lane *k* every 2^k s), `tier` `recent` or `deep`, and `liquidity`-encoded columns on `row_width` rows. Columns carry no prints. |
| `l2_walls` | `seq` +1 per frame | `walls`: every `liquidity` level field plus `id` (stable for the wall's life) and `detail`; `removed`: ids that left the set. `reset: true` is the whole set, and `removed` is empty. An increment always changes something. Lane 0 only, at most 400 walls and 400 ids. A client that also declares `l2_walls_lanes` gets every heatmap lane's walls instead, each with `lane` (0..6), up to 1,000 walls and 1,000 ids, on a seq chain of its own; `l2_resync` with `l2_walls` re-sends the variant the client declared. |
| `l2_events` | `seq` counts events ever sent: an increment with N events follows `seq − N` | In time order, each at or before the frame `ts`. `missed` counts events the per-frame cap dropped. `reset: true` is the server's ring of the latest 500, time-ordered. |
| `l2_ladder` | none: latest state | `depth`, then `bids` descending and `asks` ascending, as exact `[price, size]` pairs; best bid below best ask. |

Each frame except `l2_events` names the engine's current book `segment` when
the frame is emitted. A replayed `l2_view` frame can contain older columns
from several segments; its `segment` is not provenance for every column.

**Event kinds:**
- `wall_born` (side, row, span, size) and `wall_shrink` (the first shrink: `exact` when the event stream saw it, else inferred from the columns; `reached` when price was at the wall);
- `wall_trade` (`absorbed` or `swept`, price, size) and `wall_hidden` (fill beyond the visible shrink);
- `wall_end` (`ended_by` verdict, `distance_rows` from the mid);
- `trade` and `hidden` within the heatmap's reference band of the mid;
- `segment`.

### Sequencing and recovery

The same model as CME MDP 3.0 recovery, per channel, never the whole feed:
- A snapshot states the last `seq` it reflects. A client drops increments at or below it.
- Increments that arrive while a snapshot is still being paced out queue behind it. If that queue overflows, the replay restarts from a fresh snapshot.
- A client that sees a gap in one channel asks for that channel only: `{"type":"l2_resync","channel":"l2_walls"}` (exactly these two keys). At most one resync per channel per 2 s is honoured, and a refused request is not queued, so a client that still sees a gap asks again later. `l2_ladder` simply re-sends the latest book.
- The server re-sends a channel's snapshot to every subscriber, instead of an increment, in three cases:
  - its own L2 state was rebuilt;
  - a lane chain broke (lane history rebuilt);
  - an increment could not be built.
- A pair switch forgets the old pair's ladder and replays every chain for
  which the new pair already has a snapshot. The client must clear all L2
  state on the `selection` frame: if the new pair has not produced a snapshot
  yet, no empty L2 reset is sent and its first fresh output supplies one.
  If the new pair already has a book snapshot, the ladder is sent at once,
  even before its next live tick.
- Slow clients: chains are incremental frames and the ladder is latest-state, as on `liquidity`. Snapshot replays are paced against the socket buffer.
- A client that opts back into a chain within 2 s of its last snapshot on that chain receives nothing on it until the 2 s have passed, then one snapshot, however many times it toggled. It never receives an increment ahead of that snapshot. `l2_ladder` is never delayed.
- Timing: each second's L2 frames are built and sent in a separate task that runs right after the `liquidity` frame for that second has been sent, never inside it. An L2 snapshot taken in between already contains that second, so the increment that follows is at or below the snapshot's `seq` and is dropped by the rule above.

### What the fields promise

- **Segment id:** `<marketKind|assetClass>:<symbol>:<start_ts>:<state>`.
  - `start_ts` is the engine's own start of the segment: the first full book for `LIVE`, the last trusted exchange instant for `GAP`. Rebuilding the same data gives the same ids (report 60, D5).
  - `GAP` means state on either side must not be joined.
- **`detail.life_ms`** is `null` while a wall is active (derive it as frame `ts − start_ts`) and exact once the wall ended.
- **`detail.cross_side` and `cross_side_share`** of an active wall refresh at most every 10 s. Every trade near the mid moves them for every wall on that side, and re-sending each wall every second was 83% of all wall traffic. Every other field is current as of the frame, and an ended wall's detail is final.
- **Two clocks in one stream:**
  - `trade`, `hidden`, `wall_trade`, `wall_hidden`, `segment` and an exact `wall_shrink` carry the exchange time of the book or print that caused them.
  - `wall_born`, `wall_end` and an inferred `wall_shrink` (`exact: false`) carry the column time the tracker decided at, which is the host clock, the same as a wall's `start_ts`/`end_ts`.
  - Events are sorted by `ts` within a frame, so the two groups can interleave by the host's skew. Live, this has been measured up to 1.8 s.
  - A consumer must not infer that a trade came before a wall's birth, or after its end, from `ts` alone.
- **Event cap:** 500 events per frame. Segment events have first priority;
  if more than 500 occur in one frame, the newest 500 survive so the latest
  transition is present. Wall lifecycle then outranks near-price trades and
  hidden fills. Every dropped event is counted in `missed`. In an extreme
  burst, lifecycle events alone can pass 500; this happened in 1 of 3,518
  frames in the BTC perp hour. `l2_walls` stays the authority on each wall's
  state, and the events stream is its narrative.

Bounds (the schema is the authority; `ws-frame-contract-limits.test.js` reads
them back from `apps/runtime/src/server/l2-frames.js`):

| Bound | Value |
|---|---|
| Lanes | 1–6 |
| Walls per frame | 400 (the tracker's own level cap) |
| Removed ids per frame | 400 |
| Events per frame | 500 |
| Ladder levels a side | 50 |
| Segment id length | 160 characters |

### Measured on the P0 recordings

One hour each, 2026-09-08 14:00–15:00 UTC:
- The `liquidity` output is identical with every channel on.
- 0 chain breaks.
- Every 5-minute mid-stream join matches the live client's wall state, event
  sequence and ring, view sequences, latest ladder, and current segment.
- All four channels together were 0.19× (NQ), 0.37× (BTC perp) and 0.43× (ETH spot) of the `liquidity` bytes.

### The browser side (2026-09-28, report 61 P4b)

The browser always declares all four channels: `CLIENT_CAPABILITIES` is `marker_history` plus the four L2 flags, sent on every connect.

**Parsing.** `parseServerFrame` admits an L2 frame only if it satisfies every rule the server's builder enforces:
- lane 1–6, no prints on lane columns;
- a wall reset carries no removals, and a wall increment changes something;
- known event kinds with their exact fields, events in time order and at or before the frame `ts`, and `seq` at least the event count;
- ladder sides strictly ordered and uncrossed;
- the segment shape;
- every bound in the table above, held as `MAX_L2_*` in `apps/web/src/types/frames.ts`.

`ws-frame-contract-limits.test.js` holds the two sides equal. `wire-parity.property.test.js` feeds random builder output through the browser parser and requires identical values back. A frame that fails fails the socket, as for every other kind.

**Models** (`apps/web/src/lib/l2/`), one `L2Store` per session:

| Channel | Model | On a reset | On an increment |
|---|---|---|---|
| `l2_view` | one `LiquidityGrid` per lane, holding at most 20 min recent and 2 h deep columns | replaces that lane's tier | `seq` at or below the tier's last: dropped as the post-snapshot duplicate. A break: that lane untrusted, resync. |
| `l2_walls` | wall set by `id` | replaces the set | `seq` ≤ last: dropped; last + 1: applied; beyond: untrusted, resync |
| `l2_events` | the latest 5,000 events, `missed` summed since the reset | replaces the ring | `seq − N` ≤ last: dropped; `= last`: applied; else untrusted, resync. An increment with only `missed` and no events continues the chain. |
| `l2_ladder` | latest book | – | replaces |

- **Resync:** a gap sends `{"type":"l2_resync","channel":…}` for that channel only, at most once every 3 s per channel (the server honours one per 2 s).
- **Pair switch:** the `selection` frame clears all four models at once, whether or not the new pair has a snapshot yet.
- **Dropped socket:** the models are kept but marked untrusted until the reconnect's resets arrive, and the ladder until its next book, as the heatmap is kept.
- Frames apply on the main thread. The chart is told once per animation frame, through `l2Version`.

Indicators read this state through `ctx.l2`; see [`docs/architecture/l2/l2-sdk.md`](../../../architecture/l2/l2-sdk.md).

**Measured on the P0 recordings** (`apps/runtime/scripts/bench/l2-client-replay.js`):
- Every live frame was fed through the browser parser and `L2Store`. At each 5-minute join, a fresh store built from the join's snapshot was compared with the live one on walls, wall `seq`, event `seq` and ring, every lane tier's columns, ladder and segment.
- 33 of 33 joins were equal. There were 0 rejected frames and 0 resync requests.
- Dropping one live walls increment made all 11 later joins differ and requested resyncs. The comparison can fail.
- Main-thread apply cost was 0.16–0.20 ms per frame and 0.38–0.66 ms per second (p99). After one hour, lanes held 23 MiB (BTC), 24 MiB (ETH) and 37 MiB (NQ). BTC, replayed for 2.5 hours past both lane caps, held 30 MiB, with 29 of 29 joins equal.

## Files

- `ws-frame-contract-v1.schema.json` — the machine-readable form of this
  contract, and the authority for every bound on this wire
- `apps/runtime/test/contracts/ws-frame-contract-limits.test.js` — asserts the
  schema and both implementations state the same bounds
- `apps/runtime/src/server/frames.js` — builders + server-side validation
- `apps/runtime/src/server/dxfeed-market-data-server.js` and
  `apps/runtime/src/server/dxfeed-eager-market-data-server.js` — the two
  dxFeed frame producers. Both emit the identical `selection`/`snapshot`/
  `health`/`trade`/`bar`/`marker` shapes above through the same builders;
  they differ only in session architecture (lazy: one instrument at a
  time, connects on selection; eager: all 4 instruments at once, one
  shared token, opt-in via `npm run dev:dxfeed:live`), never in what a
  frame looks like on the wire.
- `apps/runtime/src/providers/dxfeed/dxfeed-instrument-catalog.js` — `FUTURES_ROOTS`,
  `EQUITY_SYMBOLS`, `futuresRootOf`, `isAllowedDxFeedSymbol`
- `apps/web/src/types/frames.ts` — `parseServerFrame` + client-side
  validation, `identitiesMatch`
- `apps/web/src/workers/marketDataWorker.ts` — parses every inbound WS
  message through `parseServerFrame`; imports `isAllowedSymbol`/
  `isMarketKind` from `frames.ts` rather than keeping its own copy
  (a real pre-existing duplication bug, fixed as part of DX3.01)
- `liquidity` frame: `apps/runtime/src/server/frames.js`
  (`liquidityFrame` / `dxfeedLiquidityFrame`, `MAX_LIQUIDITY_COLUMNS`,
  `MAX_LIQUIDITY_ROWS`, `MAX_LIQUIDITY_LEVELS`);
  `apps/runtime/src/indicators/passive_liquidity/` (sampler, history,
  publisher, dxFeed binding); `apps/web/src/types/frames.ts`
  (`parseLiquidityFrame`, `isLiquidityFrame`);
  `apps/web/src/hooks/useMarketData.ts` (`liquidity` grid,
  `liquidityVersion`);
  `apps/web/src/lib/indicators/passive-liquidity/` (grid model, primitive,
  settings modal); `apps/web/src/lib/chart/indicatorRegistry.ts`
  (`passiveLiquidityIndicator`, an `l2` entry)
- L2 channels: `apps/runtime/src/server/l2-frames.js` (builders, bounds,
  `parseCapabilities`); `apps/runtime/src/server/l2-channel.js` (per-channel
  snapshot, increments, resync, pacing, shared by both servers that publish);
  `apps/runtime/src/indicators/l2-memory/compact/lane-l2.js` (what the
  publisher collects each column); `apps/runtime/src/server/provider-router.js`
  (the capability set across providers); `apps/web/src/types/frames.ts`
  (`parseL2ViewFrame`, `parseL2WallsFrame`, `parseL2EventsFrame`,
  `parseL2LadderFrame`, `CLIENT_CAPABILITIES`); `apps/web/src/lib/l2/`
  (`L2Store` and the four models); `apps/web/src/lib/chart/indicatorL2.ts`
  (`ctx.l2`)
- Iceberg Detector: `apps/runtime/src/server/iceberg-frames.js` (the
  `iceberg_orders` builder and bounds); `apps/runtime/src/server/iceberg-channel.js`
  (the opt-in channel, shared by both servers); `apps/runtime/src/indicators/iceberg/`
  (trackers, learned cuts, history, store, indicator; its README has the rules);
  `apps/web/src/types/frames.ts` (`parseIcebergOrdersFrame`); the pinned samples
  come from `apps/runtime/test/contracts/iceberg-corpus.test.js` and the guards
  from `apps/runtime/test/contracts/iceberg-orders-contract.test.js`
- Exhaustion: `apps/runtime/src/server/exhaustion-frames.js` (the
  `exhaustion_shades` builder and bounds); `apps/runtime/src/server/exhaustion-channel.js`
  (the opt-in channel, shared by both servers); `apps/runtime/src/indicators/exhaustion/`
  (engine, indicator, store; its README has the rule); `apps/web/src/types/frames.ts`
  (`parseExhaustionShadesFrame`); the pinned samples come from
  `apps/runtime/test/contracts/exhaustion-corpus.test.js` and the guards from
  `apps/runtime/test/contracts/exhaustion-shades-contract.test.js`
- Initiative Continuation: `apps/runtime/src/server/initiative-frames.js` (the
  `initiative_bands` builder and bounds); `apps/runtime/src/server/initiative-channel.js`
  (the opt-in channel, shared by both servers); `apps/runtime/src/indicators/initiative/`
  (engine, indicator, store, history; its README has the rules); `apps/web/src/types/frames.ts`
  (`parseInitiativeBandsFrame`); the pinned samples come from
  `apps/runtime/test/contracts/initiative-corpus.test.js` and the guards from
  `apps/runtime/test/contracts/initiative-bands-contract.test.js`

## Versioning

`v1` covers the identity-discriminant extension and every frame kind in
the schema's `serverFrame` list (`liquidity` added additively 2026-09-08 — nothing else
changed, so it stays inside `v1` rather than forking a `v2`). The four L2
channel frames (2026-09-28) are additive the same way and reach only clients
that declared them, so they stay inside `v1` too. A future
version bumps when a frame kind's shape changes, when an existing frame
shape changes, or when book-level semantics change.

Deploy the server and web client atomically for this version. A DX3.01 client
requires `provider` and intentionally rejects frames from a pre-DX3.01 server;
the contract does not guess a provider for legacy frames.

## Where the browser's allow-lists come from

`apps/web/src/types/frames.ts` derives its Binance symbol set, dxFeed equity
set and dxFeed futures roots from `config/market-instruments.json` — the same
governed catalog the instrument picker and both server configs read.

They used to be hardcoded there. Adding one catalog entry therefore made an
instrument **selectable in the picker** while every frame for it failed
`parseFrameIdentity`: `parseServerFrame` returns null, the worker calls
`failCurrentSocket`, the reconnect re-sends the same selection, and it loops
permanently — on an instrument the application itself offered, with a
`console.warn` as the only diagnostic (`L1L2-V2-059`).

The futures symbol *pattern* stays in code, because it encodes the contract
shape (`/ROOT` + month code + 2-digit year + venue) rather than the instrument
list; contract rollover (`U26` to `Z26`) is therefore tolerated without a
catalog edit, while a new root or a new equity requires one.
