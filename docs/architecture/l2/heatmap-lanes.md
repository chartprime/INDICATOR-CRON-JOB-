# Heatmap lanes and the compact reader

**Status:** built on `l2-engine` (report 61 P3). Lane 0 is the `liquidity` frame; the wider lanes go out as `l2_view` (P4a) and indicators read them through [`ctx.l2`](l2-sdk.md) (P4b).
**Code:** `apps/runtime/src/indicators/l2-memory/compact/` and `passive_liquidity/liquidity-publisher.js` · **Tests:** `apps/runtime/test/indicators/l2-memory/compact-lanes.test.js`, `ladder.test.js`, `passive_liquidity/liquidity-publisher-golden.test.js`
**Builds on:** the [L2 memory system](memory-system.md).

## Why lanes exist

A heatmap column is capped at 1,023 rows on each side of the mid. The cap binds before any window in percent does:

| Pair | Row | What lane 0 reaches |
|---|---|---|
| BTC perpetual | $4 | ±5.25 % |
| ETH spot | $0.12 | ±5.0 % |
| NQ | 1 tick | ±0.87 % |

Widening the window would mean wider rows for every chart, or a larger wire cap. Instead the publisher keeps a zoom pyramid:
- **Lane 0** is the heatmap as it has always been.
- **Lane k** has rows `2^k` times taller and columns `2^k` times longer, so the same 1,023 rows cover `2^k` times the price range.
- A pair gets the fewest lanes that reach its window:

| Asset class | Window |
|---|---|
| Crypto spot and perpetual | ±7 % |
| Futures and equities | ±3 % |

An instrument can override its window with `l2.windowPct` in `config/market-instruments.json`; `L2_HEATMAP_LANES=0` turns lanes off.

| | Lane 0 | Lane 1 | Lane 2 |
|---|---|---|---|
| BTC perpetual | $4, 1 s, ±5.25 % | $8, 2 s, ±10.5 % | – |
| ETH spot | $0.12, 1 s, ±5.0 % | $0.24, 2 s, ±10 % | – |
| NQ | 0.25, 1 s, ±0.87 % | 0.5, 2 s, ±1.7 % | 1 pt, 4 s, ±3.5 % |

Each lane keeps the same row count and half as many columns as the one below, so the pyramid's memory is bounded by twice lane 0's. Measured on recorded hours:
- BTC lane 1 adds 23 MB to lane 0's 46 MB;
- NQ's two lanes add 24 MB and 12 MB to 48 MB.

## How a lane is filled

- **Live.**
  - Every tick samples lane 0 and every lane from the same ledger snapshot, each with its own row geometry, so sizes are exact with no drift between lanes: a wider row sums its ticks on crypto and keeps the biggest of them on futures and equities (`laneFoldFor`), since an index band is read by its biggest row and summing made the same wall read twice as big on rows 0.5 as on rows 0.25.
  - Unquantized, a lane row equals the two rows below it added together (tested).
  - A lane's 1 s samples fold into its `2^k`-second column by keeping, per row, the largest size the row held in the column's time: the deep tier's rule, so a wall that stood for part of a column stays visible. Its deep tier folds the same 1 s samples into `2^k × 10 s` columns.
  - Prints go to every lane's flow, so buy and sell volume per row is kept at every resolution.
- **Rebuild from the recording.** The backfill replays the recording once and samples every lane per column in that same pass. The worker posts lane columns in their own batches.
  - The recent pass collects each lane's columns and, when it lands, merges them into the lane's recent tier and folds them into its deep tier.
  - Deep and hole passes merge into the deep tier.
  - Repair and coarse passes do not sample lanes.
  - Lane merges are by column time, and a column already present wins, so a live column is never replaced by a rebuilt one and the order passes arrive in does not matter.
- **Store.**
  - A lane's recent and deep columns are saved beside lane 0's, in an optional `lanes` section with each lane's geometry. A file written before lanes existed still loads.
  - A saved lane whose geometry no longer matches is left out while lane 0 restores; malformed lanes reject the file like any malformed section.

## The publisher split

`liquidity-publisher.js` coordinates: options, per-pair state, the clock, the public API. The work lives in four modules:

| Module | Owns |
|---|---|
| `compact/lane.js` | Per-pair state for lane 0 and the lanes; the recent, deep and coarse tiers; the deep shelf that keeps evicted deep columns for the store; lane sampling and merging |
| `compact/lane-store.js` | Saving and restoring. A file no older than the recent window is taken whole; an older one keeps its deep tier and its ended walls only, and the recent window is rebuilt |
| `compact/lane-rebuild.js` | The rebuild passes. The recent pass runs first and holds nothing back from the chart. The deep pass follows, filling the hole before the live window first, then what lies behind the stored tier, then repairs of columns that lost their flow, then the coarse tier. Deep columns sampled meanwhile wait in `deepPending` so the ring stays in time order |
| `compact/lane-frames.js` | The per-tick column and its frames (recent, deep, coarse), and the snapshot a new client receives: coarse, then deep, then recent, each tier starting with its own reset and told apart by `column_ms` |

**When a client hears about a rebuild (2026-10-07).** A pass that merges columns into a tier sets the pair's `announce` flag; the next tick builds the full snapshot for it only when the pair is the selected one, a client is connected, and `L2_HEATMAP_BACKFILL_ANNOUNCE_S` (default 60 s) has passed since the last snapshot. A pair nobody is looking at keeps the flag until it is selected. The paths that break a client's live chain go out at once (`announceNow`): the restore, the recent pass landing, a repair, a coarse prepend, the flush of deep columns held during the hole passes, and a snapshot that had to drop unsendable columns. Every other merge keeps the chain: `liquidity-history` `merge()` inserts older columns by time and leaves `seq` where the live chain is, and the snapshot `rebase()`s `seq` to the retained count before it is cut into chunks. The hole passes collect their columns and merge once at the end rather than pushing into the ring mid-pass. Selecting a pair moves its queued passes ahead of the other pairs' queued passes (`scheduler.prioritise`). Before this, every tracked pair's snapshot was built and thrown away on every merge (724 builds and 14 min of blocked main thread on 2026-10-05), and a merge reset `seq`, so the browser asked for a resync every 2 s on top.

The split changed no output: a harness drives the real publisher through three recorded hours and fingerprints every frame, snapshot replay and store payload (`scripts/bench/l2-publisher-golden.js`, with a synthetic twin in CI). The fingerprints were identical before and after, and remain identical for lane 0 with lanes on.

## MBP-N ladder

`engine.ladder({ side, depth })` (also on the heavy reader) returns the exact per-price book, best first, to `depth` levels (default 50, at most 500).
- It reads the ledger's per-price sizes inside each record, so banded crypto keys still give true price levels.
- It walks outward from the best key, and sorts only when keys are not whole numbers or the walk runs long.
- On three recorded hours it matched the order-book assembler's top 20 and top 50 at every second (21,294 comparisons per depth, 0 mismatches) at 14–20 µs a read (`scripts/bench/l2-ladder-check.js`).
- The DOM `book` frame still comes from the assembler.

## Time pyramid (host)

`terminal-heatmap-pyramid.service` keeps 7 days of lane-0 heatmap columns per pair at 10 s, 30 s, 1 m and 5 m, under `/srv/terminal-data/heatmap` (`src/indicators/l2-memory/pyramid/`).

- **Geometry.** Each pair's store pins one geometry, from `laneZeroGeometry` (the function the live lane uses), at the price when it was pinned. The pinned record also identifies the replay warm-up; changing it rebuilds the store rather than mixing derivations. Binance row widths follow the price, so the pin is kept until the price moves the row count more than twofold, or the configuration changes; then the store is wiped and rebuilt. dxFeed rows are fixed in ticks.
- **Columns.** A run of up to 12 consecutive 5 min windows is replayed through `runBackfillInProcess` in one engine, after 30 min of warm-up, with 1 s samples folded to 10 s. Each window's 30 s, 1 m and 5 m columns are the time folds of its 10 s columns (the largest size each row held), with full lane-0 rows at every level.
- **Store.** One SQLite file per pair (rollback journal, so live-storage can read it without write access). Each window is written in one transaction with a state: `COVERED` (all 30 ten-second grid slots present), `PARTIAL`, `NO_DATA` or `FAILED`. Capture progress is checked for that pair, not the provider as a whole. A window is built once the recording has passed its end, or 30 min after its end when the recording has stopped. Failed replays are retried after one hour; the status file reports a degraded pair while failed windows remain. Missing windows are built newest first; a short run at the tail waits until six windows or 30 min are due.
- **Serving.** The live-storage route `heatmap-columns` (`levelMs`, `fromTs`, `toTs`, optional `rowFactor` 1–64) returns whole windows, oldest first, up to about 1.5 MB of JSON, with `next` for the following page. Each window's columns chain from their own first column. `rowFactor` sums rows into wider ones on the host.

## Histories (host)

The same replay feeds a wall tracker (`trackerOptions` on the builder, the live lane's rule: the dollar floor `L2_HEATMAP_LEVEL_MIN_USD` over the price the capture shows and the contract's notional, `L2_HEATMAP_WALL_MULT`, `L2_HEATMAP_WALL_GAP`, `L2_HEATMAP_WALL_SETTLE_MS`), so each pair's store also keeps, beside the columns:

- **Walls.** Every wall that ended inside a window, with its verdict and the tracker's own record, in the `walls` table, read by the time it ended. A wall still standing at the next run's seed time (the run's end minus the warm-up) goes to the `standing` table as a hand-over list; a wall born at that seed, same side and overlapping rows, takes the record's birth and peak, whichever of the two arrives first, and a chain of runs passes the birth all the way down to the walls a later run saw. The warm-up's own walls are dropped.
- **Events.** The window's trades near the mid and into walls, folded the way the runtime's event history folds them (1 s and 10 s buckets per row, aggressor and mode; trades into walls per wall, second and mode), one gzip blob per window in the `events` table.
- **Rebuild.** A window built before the histories existed is replayed once more when the tracker is on; the columns stay served meanwhile. The replay's columns replace the stored ones only when they cover at least as well (a better state, or the same state and no fewer columns); otherwise only the walls and events are written and the stored columns stay. A failed replay of such a window leaves it as it was and the builder waits `failedRetryMs` before asking for its histories again. A replay that returns no events is a failed window. `TT_PYRAMID_HISTORIES=0` builds columns only.
- **Serving.** The live-storage routes `wall-history` (`fromTs`, `toTs`, `limit` up to 400, `after` `{ endTs, id }`, and for Binance pairs the optional size filter `minUsd` with `alwaysOutcomes`: a wall is kept when `peak * (row + span / 2) * rowWidth` is at least `minUsd` or it ended in one of the listed outcomes; the filter runs in the query before the page limit, so the cursor stays correct, a page answered under a filter carries `filter` as an echo, and dxFeed pairs refuse it) and `event-history` (`fromTs`, `toTs`, paged by the reader's byte budget) answer with the pair's generation and pinned geometry, or `NO_PYRAMID` / `NOT_PINNED`.

## Pinned rows and the deep warm-up (runtime)

- **Pinned rows.** From a pair's first tick the publisher asks the pyramid (through the live-storage relay, or the local `TT_HEATMAP_DIR`) for the rows it pinned. When the pair's lane is made, pinned rows on the engine's own tick size and cluster ticks replace the price-derived ones, so live columns and pyramid pages share a grid. Rows configured in ticks (futures and equities) are kept as they are. A pin that arrives after the lane was made is taken at the next restart.
- **Deep warm-up.** Before the deep passes, the publisher fills the deep tier with the pyramid's 10 s columns over the deep window, in seconds rather than minutes. The raw passes it would have run are worked out before the fill and still run, for the walls, the aggressive bubbles and the wider lanes the pyramid does not hold. Their lane-0 columns fill only the pyramid's holes (the pyramid's columns, built after a 30 min warm-up, are kept). A host that is down, a page in other rows, or `L2_HEATMAP_PYRAMID=0` leaves the raw rebuild exactly as before. The deep readiness reports `pyramid: { columns, reason, ms }`. The `COVERED` windows the host sends are kept encoded for ten minutes, 64 MB at most, the oldest out first (a `PARTIAL` window is rebuilt once its capture lands, so it is never kept), and an ask whose windows another ask is reading waits for that read instead of asking again; so the deep warm-up and the Exhaustion and Initiative history walks, which ask for the same hours of the same pair at a start, have the host decode-free from memory after the first read (`cachedWindows`, `sharedWindows`, `keptWindows` and `keptBytes` in the warm-up's stats). A read that fails answers every ask waiting on it with the reason and keeps nothing.

- **What an event answer claims.** An `l2_event_history` answer carries `trades_held_from`: the start of the unbroken stretch the history holds up to the asked end, on a whole deep bucket and never before the asked start; the asked end itself when it holds nothing there. The live stretch counts up to the moment of the request. Trades the byte cap or the age window dropped are never claimed, and that mark is saved with the events file (a file saved without it claims only from its oldest trade). Only the spans whose events are held count: the fill's own range claims nothing, since it runs over windows the recording did not hold. A refusal carries `null`.
- **Histories.** Once the deep and coarse tiers are ready and before the fill from the recording, the publisher asks the pyramid for the walls and events over the fill horizon (`L2_HEATMAP_FILL_S`) up to the live tracker's start (the start of the startup pass), over every stretch the event history does not hold, so a deep tier the pyramid filled is asked for like the rest, in the lane's rows. The walls go into the wall history as they are, each event window merges into the event history and the covered span is marked, so the fill from the recording then replays what the host could not give, over every uncovered stretch of the horizon up to the live start, newest first. The chunk ending at the live start is always replayed from the recording when no deep pass reached it, so a wall standing at the runtime's start gets its birth, and every fill chunk hands its standing levels to the live tracker as the deep passes do; a deep pass that found no data in its window covers nothing, so the host is still asked for that window (a fresh runtime, or the time it was down, is exactly where the local recording is empty); the window is only remembered as empty so the fill from the recording does not replay it. The event history keeps the spans whose events it already holds, whatever brought them in: the live tracker (from the pair's first tick to each save), the startup and deep replay passes, the fill and the host. On a restart they come back from disk with the events, and the host is asked only for the stretches outside them, in practice the downtime; any merge skips the events inside a held span, and a wall or window the host sends outside what was asked is refused, so a trade is counted once however many starts and however far apart. A page from other rows is refused (`GEOMETRY`); a read cut short (a cursor that does not move, the page cap, a page lost after its retries) keeps what was read and says why; a host that is down or without the routes leaves the fill as it was, and the fill readiness reports `pyramid: { walls, windows, refused, reason, ms }`.

## History in the chart (browser)

- **Path.** The market-data worker posts `POST /heatmap/columns` to the runtime, beside the WebSocket and never through it, so a page never queues ahead of live frames or heartbeats. The runtime (`src/server/heatmap-route.js`) accepts the WebSocket's own origins, bounds concurrent reads and a per-origin budget, and caches available pages for a minute; a request without a row factor and one asking for row factor 1 are the same page to the cache. `/heatmap/walls` is a second instance of the same route, so it has its own 48 MB cache, its own four concurrent reads and its own per-origin budget. The browser's readers of `/heatmap/columns` stay under the 240 a minute together: the heatmap's store up to 90, the indicators' readers (the column stream and its forks up to 140, the band store up to 60) 149 between them (`requestBudget.ts`); and together they hold open at most four reads, the route's own concurrency, through one `InFlightPool` shared by the heatmap's store, the column stream and the band store, so a reader whose slot another holds waits for it instead of drawing a `429 BUSY` that still spends the minute's budget. Identical requests that arrive while a read runs share that read and do not count against the concurrency bound; the read is abandoned only when every viewer waiting on it has gone, and a viewer still waiting then gets `503 HEATMAP_UNAVAILABLE` rather than no answer (2026-09-30: two viewers opening the same chart had doubled every host read). It reads the host through the remote storage reader, or a local pyramid (`TT_HEATMAP_DIR`) when it reads locally. The worker decodes each page (`heatmapHistoryDecode.ts`, the live decoder's column rules, session filter and yardstick) and transfers the buffers.
- **Store.** `heatmapHistory.ts` keeps decoded windows per level and row factor for the live pair only. It asks for missing windows newest first in requests of at most three hours, at most two in flight inside the shared pool of four and 90 a minute, follows `next`, and retries unbuilt windows or failures after 30 s. Its memory cap (96 MiB) never evicts the windows on screen or the reach being shown. `reach(want)` is how the chart asks since 2026-10-07: the whole reach is wanted at once, and the store answers with the last reach that landed whole (`shown`) and whether the asked one is still loading; a reach of the same level and length that slides with the live edge is not a new choice and fills in quietly.
- **Drawing.** The heatmap's History setting (1 day by default, 3, 5 days or a week) is the reach behind the oldest live column, asked for as soon as the pair is on screen. One column width per reach: a day at 1 m, longer at 5 m. Always row factor 1; on a wider lane the loaded columns' rows are folded by 2^lane in the browser (`foldHistoryRows`: summed on crypto with the yardstick measured again on the wider rows, the biggest tick on an index market with lane 0's yardstick kept). Nothing of a reach is drawn until it has all landed; the badge `HEATMAP · LOADING 1 DAY` shows meanwhile and a longer choice keeps the shorter reach on screen until the longer one is whole. The ask runs up to the five-minute window holding the live edge, and the host's columns fill the holes inside the runtime's own columns too, on every lane (`fillHoles`): after a restart each lane rebuilds from its own point, and the past of the x2 lane began hours after rows 4's. From 15 min bars the columns are folded into cells. Each lane holds the same span of the past as lane 0 in the browser (`laneGrids.ts`, capacities divided by the lane factor), and a fixed colour scale is per row of the finest lane, multiplied by the rows per drawn row on a wider one. Time is laid out past the chart's session breaks (`chartTime.ts`): lightweight-charts places bars by index and the candle series carries one break point per hole, so a hole gets exactly one bar of room, and every column, cell and hover maps wall time to chart time through the bar list's holes. A page whose rows are not the runtime's rows, or a lane whose rows are not a whole multiple of them, is not drawn (`GEOMETRY`); unbuilt or failed windows are holes that fill on their retry. The legend says the reach and how far back it reaches, or why it is not drawn.

- **Walls.** `/heatmap/walls` beside `/heatmap/columns` (the same route code, its own path and fields: `fromTs`, `toTs`, `limit`, `after`, and for Binance `minUsd` and `alwaysOutcomes`) reads the host's `wall-history` through the remote reader, or the local pyramid; the answer is the host page as is. `minUsd` keeps a wall whose dollar size, `peak × (row + span / 2) × rowWidth`, reaches it, and `alwaysOutcomes` (any of `filled`, `partial`, `hit`, `pulled`, `moved`) keeps a wall by its verdict whatever its size; the test runs in the host's query before the page limit, so `next` and the `{endTs, id}` cursor stay exact across the filter. A filtering page echoes `filter` and carries `sizeBands` (`n`, `p50`, `p75`, `p90`, `p95`, `p99` of the dollar size, rescanned every ten minutes and after a re-pin). dxFeed is refused (`SIZE_FILTER_NEEDS_BINANCE`): its futures need a notional multiplier the pyramid does not store. The browser's `wallHistoryStream.ts` asks it in six-hour chunks newest first, two in flight, under its own request ids, and `hostWalls.ts` turns the records into history walls with ids below the runtime's (`-(2^40 + id)`). IOB v2 asks the runtime for its day over the WebSocket, then the host for the rest up to its History setting (48 h by default, up to a week), adopts the pages as they land and keeps them for that reach. The Whale Limit Order Heatmap asks through a second stream of its own (request ids from `2^32 + 2^30`, twelve-hour chunks, the size filter on, a single `want` of its own), so the two never answer each other's requests.
- **Indicators.** Prime Absorption reads the same 10 s pages behind the live book through `columnHistoryStream.ts`: one-hour chunks, four in flight inside the shared pool, request ids of its own, each page handed to the indicator's tracker and dropped (a decoded 10 s column is ~34 KB, so nothing is retained). The reach is the indicator's own History choice (Off, 1 day by default, 3, 5 days or a week), loaded a UTC day at a time oldest first with an eight-hour warm-up, shown only once whole, and its judged hours are kept in the browser (512 KB, keyed by the engine version) so a reload shows the reach at once. The host's columns carry the flow the tracker needs (92 % of Binance's own candle volume on BTC perp, 2026-10-03, bursts exact), which is why history comes from the columns and not from the engine's event history (69 %).

## Known limits

- The wider lanes reach the web only in the wire phase; `publisher.lanes(marketKind, symbol)` is the server-side read until then.
- Walls and aggressive events are tracked on lane 0. The wall service can be attached to a wider lane for the whale indicator.
- Deep-tier columns rebuilt for a lane after the recent pass are folded from 2 s columns rather than 1 s samples. Sizes and flow sums are identical; the kept sample of prints can differ in a window that exceeds the print cap.
- Lanes do not take part in flow repair.
- Far from the mid, a book depends on how long its engine has run: a resync keeps levels the snapshot does not vouch for, so an older engine holds more of them. Pyramid runs after 30 min of warm-up match a longer-running engine exactly within ±25 rows of the mid, in flow and in prints; over the whole window 3–9 % of the resting size differed on recorded BTC (2026-09-08).
- A pyramid `rowFactor` sums each row's largest size over the column, so a wide row can read higher than a lane sampled at that width and then folded.
- The browser folds cells over the union of their columns' rows, while the pyramid's time folds keep the first column's rows; the two differ only at the far edge of the window.
- A week of BTC perpetual at 5 min is about 5 MB (lane 2) to 15 MB (lane 0) gzipped, under a second on a fast link and over a minute at 200 KB/s (measured 2026-09-28 on the laptop pyramid).
- The live-storage page reader decompresses and coarsens on its serving thread. Host qualification must measure page latency and event-loop delay under simultaneous chart traffic before enabling week views for users.
