# L2 Memory System

**Status:** live on Binance spot and perpetual since 2026-09-03, and on the
dxFeed futures and equities since 2026-09-07.
**Code:** `apps/runtime/src/indicators/l2-memory/` · **Tests:** `apps/runtime/test/indicators/l2-memory/`
**Feeds:** `market-data-server.js` and `dxfeed-eager-market-data-server.js`
(live), `replay-source.js` and `dxfeed-replay-source.js` (recorded days).

## Why it exists

The order book only knows what each price level looks like *now*. Every L2
indicator, from icebergs to absorption, needs to know how a level got there:
how much size arrived and left, whether it left by trading or by
cancellation, how often it emptied and came back, how much traded there
beyond what was ever visible. The memory system computes that once, per
active pair, and every indicator reads from it instead of re-deriving it.

## Architecture

```
 Binance depth + trades     dxFeed Order-v2 + TimeAndSale     recorded days
        │                             │                             │
        ▼                             ▼                             ▼
 live-binding.js            dxfeed-liquidity-binding.js     replay-source.js
 (Binance packer)           (dxFeed packer)                 dxfeed-replay-source.js
        │                             │                             │
        └────── input frames: book, trade, gap ─────┐                │
                                                    ▼                │
                              l2-input-binding.js   one engine per   │
                                                    pair, pruned on  │
                                                    the packer's     │
                                                    policy           │
                                                    │                │
                                                    ▼                ▼
 memory-engine.js     apply(frame): seeds from the first READY book, applies
        │             each diff and trade in wire order, reconciles after a
        │             gap (resync), keeps the clock monotonic for late trades
        ├──────────────────────────┬──────────────────────────┐
        ▼                          ▼                          ▼
 level-ledger.js           size-history.js            flow-window.js
 per-level history:        size of every level         aggressive volume and
 added / cancelled /       over the last 30 s          mid-price move over the
 traded / hidden /                                     last 60 s
 refills / reloads /
 filled-or-pulled …
```

### Inputs

Every source reaches the engine as input frames (`input-frames.js`), and
`engine.apply(frame)` is the engine's only input:

| Frame | Carries |
|---|---|
| `book` | `ts`, `status`, the book (full `bids`/`asks`, or only `bestBid`/`bestAsk` once seeded), and `delta`, the levels that changed |
| `trade` | `ts`, `price`, `size`, `side` (the aggressor), `tradeId` |
| `gap` | `cause`: the book is no longer trusted. Recorded days send `anchor`, a gap caused by a fresh snapshot |

**Live.** Each provider has a packer that turns its data into frames and hands
them to one binding (`l2-input-binding.js`). The binding keeps one engine per
pair, keyed by scope (market kind on Binance, asset class on dxFeed) and
symbol, creates it through the packer's factory, and prunes it on the packer's
policy.

| Packer | Turns into frames | Engine and prune |
|---|---|---|
| `live-binding.js` (Binance) | A DEPTH envelope and the assembler state after it: a `book` frame with the envelope's own diff, or a `gap` when the envelope or state is unavailable. A pair off screen sends only its best prices; the full book is fetched to seed or resync. A TRADE envelope: a `trade` frame, aggressor from `isBuyerMaker` | Created once the tick size resolves; price-relative band and dust floor from the first quote unless the instrument catalog fixes them. Pruned every 30 s of wall clock |
| `dxfeed-liquidity-binding.js` (dxFeed) | The assembler's per-price book, diffed at most every 250 ms: the levels that changed, or the whole book to seed and after a snapshot restart. Eligible prints with an aggressor side | One engine per catalog instrument, one tick per record, full depth. Pruned after a READY book, at most every 60 s of exchange time |

**Recorded days.** `replay-source.js` reads the collector's SQLite tables
(`l2_depth_snapshots`, `l2_depth_events`, `trades`) and
`dxfeed-replay-source.js` reads source-scoped Order-v2 capture and eligible
TimeAndSale. Both run the same provider book assembler as the live path and
yield the same frames straight into an engine, so an indicator can be
developed and calibrated on recorded days against the book states the live
server saw.

**dxFeed batching.** `dxfeed-book-frames.js` holds the 250 ms window, the
shared book steps and the two named batching policies. Live batches on a
wall-clock timer that fires 250 ms after the first order of a burst
(`trailing-wall-clock`). Replay emits on the first order at least 250 ms of
exchange time after its last emission (`leading-exchange-time`). The same order
stream can therefore end its diffs at different moments live and replayed.

Nothing below the binding knows about Binance, dxFeed, timers or the server.
The ledger speaks one small language, `seed`, `applyDelta`, `applyTrade`,
`observeQuote`, `resync`, all in numbers.

## What the ledger knows per level

Each record is one price band (`keyFor` groups ticks into bands). Read them
through `engine.snapshot()`; every field is documented at the top of
`level-ledger.js`. Anything sampling on a fast timer should call
`engine.liteSnapshot()` instead, which returns key, size, traded and cancelled
without building a frozen view per record. The fields indicators lean on:

| Field | Meaning |
| --- | --- |
| `size`, `peakSize`, `sizeMean`, `sizeStdDev` | what the band shows now, the most it ever showed, and how steady that was |
| `added`, `cancelled`, `traded`, `tradedVisible` | how size arrived and left, and how much of the leaving was trades |
| `hiddenTraded`, `hiddenWindows`, `lastHiddenTs` | trade volume beyond the visible shrink (the iceberg footprint), how many diff windows it grew in, and when it last grew |
| `absorbed`, `swept`, `hiddenSwept` | trades while the band held at the top of book, versus trades after price had already moved past it |
| `refills`, `reloads`, `lastSlice`, `endedBy` | empty-and-back cycles, the subset whose emptying was filled, the last real slice that left, and its verdict (`filled` / `pulled`) |
| `tests`, `closestDistance`, `isBest` | how often and how closely price came to the band |
| `seeded`, `ageMs` | whether the band predates the memory, and how long it has been known |

## Inference rules

Market-by-price data never says *why* a level changed. These rules are
decided once in the ledger and inherited by every indicator; the ledger tests
are their specification.

- **Cancel versus fill.** A visible shrink is explained by the trades seen at
  that level since the previous diff, up to the size of the shrink. The rest
  is a cancel. Trade volume beyond the shrink is hidden: the level refilled
  inside the diff window, so more traded than ever showed.
- **Absorption versus sweep.** A trade within one band of the best price is
  the level holding (absorption). A trade at a price the market has already
  moved past is a sweep. Only absorption feeds `hiddenTraded`.
- **Late trades.** Upstream delivers depth synchronously but queues trades, so
  10–25% of trades arrive after the diff that already reflects them. The
  engine flags those, and the ledger lets such a trade reclaim a shrink
  booked as a cancel within the last 500 ms, so a late fill is not counted
  once as a cancel and once as hidden volume.
- **Verdicts.** When a level's last real slice leaves, the ledger waits up to
  1.5 s for the trades that explain it before calling it `filled` or
  `pulled`, because the emptying diff routinely arrives before those trades.
- **Dust floor.** A displayed size under the floor (`L2_MIN_SLICE_USD`,
  default $800) does not count as the level being there. Dust appearing or
  vanishing starts no cycle and changes no verdict, so the requoting that
  repopulates every band near price is invisible to the history.
- **Gaps.** A sequence gap or snapshot refetch does not wipe anything. The
  engine keeps the ledger, keeps attributing trades, and applies the next
  READY book as one large diff: levels that shrank are explained by the
  trades seen meanwhile, levels that vanished get their verdict, levels
  beyond the snapshot's depth are left alone.

## Configuration is price-relative

Every size-bound knob is expressed in price terms so one configuration serves
every pair. The binding converts them into a pair's units when its engine is
created, from the tick size and the first READY quote.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `L2_BAND_BP` | 0.0625 | band width in basis points of price: about $0.50 on BTC spot and perpetual, 3 ticks on ETH |
| `L2_MIN_SLICE_USD` | 800 | displayed notional below which a band counts as dust |
| `L2_MIN_SLICE_SIZE` | unset | explicit dust floor in base units, overriding the notional one |
| `L2_MEMORY_DEBUG` | off | print every engine's top levels every 5 s |

dxFeed instruments are sized from the catalog's tick instead: their engines
cluster one tick per ledger record, so a level is a tick and the band knobs
above do not apply to them.

## Running it

From the repository root:

```
npm run l2-memory:test                         # the memory's own suite, offline
npm run l2-memory:live                         # the server with the debug print on
npm run l2-memory:live -- ETHUSDT --seconds=120
```

The live command starts the normal market-data server on port 8001 with
`L2_MEMORY_DEBUG=1`. Every five seconds the terminal shows, per engine:

- a header with its counters: levels per side, diffs, trades, late trades,
  gaps and resyncs, plus whether it is seeded and live;
- the three largest walls anywhere in the book;
- the four largest levels near the top of book with what they have traded,
  cancelled and hidden, their age, refills and how often price tested them.

`--seconds` stops it after that long; without it, Ctrl+C. `--port` picks a
port when 8001 is busy. The browser can connect to it as usual while it runs.

## Mounting an indicator on it

The Passive Liquidity Heatmap is the template. A new indicator needs:

1. **A pure scorer** over `engine.snapshot()` (plus `engine.sizeHistory` or
   `engine.flow` if it needs the rolling windows), returning frozen hits. Keep
   it free of Binance, timers and the server, so it can be unit-tested on
   hand-built levels and replayed on recorded days.
2. **A tracker** only if the chart needs memory the snapshot does not have,
   such as when a hit was first seen.
3. **An accessor on the binding** reading `getEngine(marketKind, symbol)`, one
   tracker per pair.
4. **A frame builder** in `server/frames.js` that validates every field, a
   `$defs` entry in the v1 wire schema, and a `publish…IfChanged` function in
   `market-data-server.js` on the health-poll timer with a fingerprint that
   covers every field the chart renders.
5. **On the web**: the frame type and parser in `types/frames.ts`, a pending
   slot in `useMarketData.ts`, a primitive plus settings under
   `lib/indicators/<name>/`, and the wiring in `ChartPanel` / `MainPanel`.

Scorers for persistence, vacuum and absorption were written against these
same fields on 2026-09-02 and parked pending calibration; they come back as
steps 1 and 3 above.

The Passive Liquidity Heatmap (`indicators/passive_liquidity/`) is the second
worked example and the one to copy when an indicator needs a **past** as well as
a present: it samples the ledger once a second, keeps two tiers of that history
in memory, persists them per instrument, and can rebuild them from the
collector's recording. How that is put together, and the rules a rebuild has to
respect, are in [`../storage/storage.md`](../storage/storage.md).

## Known limits

Historical L2 uses a separate verified release and bounded read contract. See
[historical serving](historical-serving.md) for API limits, knowledge-time cuts,
display semantics and activation. One-second states are not engine restore checkpoints.

- Market-by-price cannot tell one participant refilling from many
  participants queueing. A busy visible wall that the crowd keeps joining
  while trades chew its front also shows volume beyond its visible shrink.
  Indicators must gate on the *share* of absorption that was hidden, not on
  hidden volume alone.
- Quote observation walks every record on a side per diff. Fine at today's
  depth (a few thousand records); the first thing to optimise for a deeper
  book.
- Market-by-order books are folded to price before the engine sees them, so
  the ledger reasons about a level, never about the individual orders queued
  in it. The per-order detail dxFeed carries is available in the assembler if
  an indicator ever needs queue position.
- The dxFeed side replays through `dxfeed-replay-source.js`. It requires a
  complete snapshot for the configured Order source at or before the requested
  window; when no such snapshot exists, the history starts at the next valid
  snapshot rather than inventing a book.
