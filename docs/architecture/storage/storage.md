# Historical data, and how indicator code reaches it

> Detailed local replay and derived-store reference. For the final-state choice
> between local SQLite, remote live storage, P1g replay pages, and the curated
> archive, start with [Storage, warm-up, replay, and archive](README.md).

**Code:** `apps/runtime/src/indicators/l2-memory/` (replay, backfill, store) ·
`apps/runtime/src/storage/` (the collector's writers) ·
**Tests:** `apps/runtime/test/indicators/l2-memory/`

Three different things in this repository are called "history", and an
indicator uses them for different jobs. This page says what each one is, which
module opens it, and what to do when a new indicator needs a past instead of
starting blank.

| What | Where it lives | Written by | Read by |
| --- | --- | --- | --- |
| The raw recording | `apps/runtime/data/live/market-data.sqlite` (Binance), `dxfeed-market-data.sqlite` (dxFeed) | the collector process, independently of the browser-facing server | `replay-source.js`, and the backfill through it |
| Derived history | `apps/runtime/data/liquidity/<PAIR>.json`, one per instrument | the liquidity publisher, every 5 min when something changed, and on shutdown | the same publisher on its next start |
| Live memory | process memory only | `memory-engine.js` as events arrive | every indicator, through `engine.snapshot()` |

The raw recording is the only source of truth. Derived history is a cache and
is discarded whenever it does not fit. Live memory is gone at exit.

## The raw recording

The collector is a separate process that owns its own market connection, so
restarting the server or the frontend cannot interrupt capture. It writes
REST snapshots and every depth diff and trade; see
`storage-pipeline-evidence.md` for the schema and the capture-quality
lineage, and `DX2.01-dxfeed-storage-evidence.md` for the dxFeed side.

`replay-source.js` (Binance) and `dxfeed-replay-source.js` (dxFeed) are the
only ways indicator code should read it. Each feeds stored snapshots, diffs,
and eligible trades through the same provider-specific book assembler as the
live path. The dxFeed source preserves the configured Order source and replays
Order rows in arrival (`id`) order on a clock that never runs backwards (see
the dxFeed storage contract for why `event_time` cannot order them). The Binance source emits its recorded
`UNAVAILABLE` reasons; the dxFeed source records unavailable capture spans in
its replay statistics and re-anchors on the next complete snapshot.

```js
const source = createReplaySource({ dbPath, marketKind: "SPOT", symbol: "BTCUSDT", fromTs, toTs });
const engine = createMemoryEngine({ tickSize, clusterTicks, snapshotDepth });
try {
  for (const frame of source.frames()) {
    engine.apply(frame); // the same input frames the live bindings send
    // sample here on every column boundary, and prune on the replay clock
  }
} finally {
  source.close(); // `source.stats` says what the recording gave you
}
```

**Replaying is synchronous and expensive.** better-sqlite3 blocks the thread
it runs on, and twenty minutes of BTC perpetual is about 65,000 depth events,
four hours about three quarters of a million. Run it on a worker thread. On
the server's own thread it starves the event loop badly enough that REST
calls time out, which costs the server its depth snapshot and its klines.
`liquidity-backfill.js` shows the pattern: it spawns
`liquidity-backfill-worker.js`, keeps the ledger's bulk on that thread, and
posts only finished results back in batches. Tests that already hold an open
database call `runBackfillInProcess` directly instead.

## Derived history

Rebuilding from the recording is slow; the finished product is tiny. One
heatmap column costs about 300 bytes delta encoded, so a pair's whole
retained picture is well under a megabyte. `liquidity-store.js` writes that
to `data/liquidity/<PAIR>.json`:

```
{ version, pairKey, savedAt, geometry: { rowWidth, rowClusters, windowRows, columnMs, deepColumnMs },
  recent: [...columns], deep: [...columns], levels: [...walls] }
```

On start the publisher reads it back in milliseconds and replays only the gap
between the last saved column and now. The file is never authoritative: one
that is missing, truncated, malformed, **written for a different row
geometry**, or older than `L2_HEATMAP_STORE_MAX_AGE_S` is ignored, and the
caller rebuilds exactly as it would have without it. Geometry is the common
reason a file is rejected, because `rowWidth` follows the price.

Store keys use camelCase (`startTs`, `endTs`, `endedBy`); the wire uses
snake_case (`start_ts`, `end_ts`, `ended_by`). A script reading the store
wants the former.

## Giving a new indicator a past

The liquidity heatmap is the worked example; follow it in this order.

1. **Sample from the ledger, not from the feed.** Write a pure function of
   `engine.snapshot()` (or `engine.liteSnapshot()`, which skips the frozen
   per-record views and is what a per-second sampler should use) that returns
   one immutable slice of whatever your indicator plots. `liquidity-sampler.js`
   is one column of the heatmap. Because it reads the ledger and nothing else,
   the same function serves live and replayed data.
2. **Keep the retained slices in a ring**, delta encoded if they are wide, with
   a `seq` that increments per appended slice so a client can tell a gap from a
   reorder. `liquidity-history.js` is the heatmap's.
3. **Rebuild the same slices from the recording on a worker thread.** Point the
   provider's replay source at the gap you need, drive a *fresh* engine with the
   live engine's own geometry (`engine.tickSize`, `engine.clusterTicks`,
   `engine.snapshotDepth`), and call the sampler from step 1 on every boundary.
   Reuse the same geometry or the rebuilt slices will not line up with the live
   ones. Prune the replay engine periodically or it grows for the whole window.
   If the indicator keeps a coarse tier, fold the fine samples into it with the
   same folder live uses (`createDeepFolder` in `liquidity-history.js`) rather
   than sampling once per coarse window, or the two tiers will never agree.
   The rebuild can also be fed by a history source of your own (`createSource`
   in process, `sourceModule` for the worker): anything that yields the replay
   source's frames, which is how a hosted archive reader plugs in later
   without touching the rebuild.
4. **Persist the ring** with the store pattern above: write atomically on a
   timer and at shutdown, validate hard on read, and treat a mismatch as
   "rebuild" rather than an error. And never let the file shrink to what one
   process happens to hold: the heatmap keeps a shelf of the coarse columns the
   ring let go of (the ring's oldest as live columns push it forward, and
   everything a history floor hid at restore) and writes shelf and ring as one
   delta chain, so a short-lived process or a floor cannot overwrite eleven
   hours with twenty minutes. On 2026-09-15 a runtime started with a floor did
   exactly that. The shelf only ever grows forward in time (a column rebuilt
   behind the tier and evicted again is dropped rather than chained behind a
   newer one), is pruned to the store's max age before every write, live or
   at restore, and the previous file is copied to `.prev` before every write.
5. **Announce a rebuilt past to clients.** A client that was cleared by a pair
   switch knows nothing of what a restore just put in memory, so the next frame
   after a restore has to be a full replay marked `reset`; deltas alone are
   dropped by the browser's chain check.

Two rules the heatmap learned the hard way. Everything a rebuild produces must
be **indistinguishable from live output**, same sampler, same geometry, same
verdicts, or the chart shows a seam where the rebuild ends
(`liquidity-backfill-equivalence.test.js` drives both paths from one recording
and demands identical columns on both tiers). And live never waits for a
rebuild: the pair keeps sampling and publishing while a pass runs, the rebuilt
columns are merged in behind the live ones when it lands, and the slower,
coarser pass fills in behind that: first the hole between what the store gave
back and the fine replay, a chunk at a time and oldest first, then, a chunk at
a time and newest first, whatever the recording holds before the stored tier,
back to the start of the deep window. Both are chunked for the same reason: a
five-hour gap as one window against a five-minute pass timeout rebuilds
nothing, and a chunk that fails costs only itself.
The coarse pass also repairs what live lost, ahead of the chunks: a stretch of
a minute or more of stored coarse columns carrying no flow (the trade queue
overflowed, the collector on its own connection kept the trades) is rebuilt
from the recording once it is two minutes old, and left alone if the recording
has no trades there either. Keep every pass bounded all the same
(`L2_HEATMAP_BACKFILL_MAX_S`, one worker at a time, a timeout), because the
replay runs at about ten seconds of tape per second on a laptop.

## Configuration

Both passes and the store are configured per process, through the environment.

| Variable | Default | Meaning |
| --- | --- | --- |
| `L2_HEATMAP_BACKFILL` | on | rebuild from the collector's recording on start; `0` turns it off |
| `L2_HEATMAP_BACKFILL_MAX_S` | 600 | at most this much of the gap is replayed at fine resolution; the rest is the coarse pass's job |
| `L2_HEATMAP_BACKFILL_WORKERS` | 1 | rebuild passes running at once, across every pair |
| `L2_HEATMAP_BACKFILL_TIMEOUT_S` | 300 | a pass still running after this is stopped |
| `L2_HEATMAP_BACKFILL_ANNOUNCE_S` | 60 | the selected pair's rebuilt history is replayed to clients at most this often; a pass landing, a restore and a repair go out at once |
| `L2_HEATMAP_DB_PATH` | the collector's own file | which recording to replay |
| `L2_HEATMAP_HISTORY_FLOOR` | unset | ISO time; nothing older than this is shown or replayed for this launch. What the store holds before it is kept on the shelf and written back, not lost |
| `L2_HEATMAP_STORE` | on | write and read the per-pair JSON |
| `L2_HEATMAP_STORE_DIR` | `apps/runtime/data/liquidity` | where those files go |
| `L2_HEATMAP_STORE_S` | 300 | seconds between saves; a store whose tiers did not change is not rewritten |
| `L2_HEATMAP_STORE_MAX_AGE_S` | 7 days | older files are ignored |
| `L2_HEATMAP_HISTORY_S` | 1200 | seconds of fine (1 s) history retained |
| `L2_HEATMAP_DEEP_S` | 4 h | seconds of coarse history behind it; `0` disables the tier. The aggressive-print pool warms over the same horizon, never less than its own four hours, so the bubbles come back with the hours the columns do |
| `L2_HEATMAP_DEEP_CHUNK_S` | 20 min | the coarse pass rebuilds in chunks of this many seconds: the gap in front of the stored tier oldest first, what lies before it newest first; a chunk has to finish inside the pass timeout (the replay runs at 8 to 10 s of tape per second) |
| `L2_HEATMAP_COLUMN_MS` / `L2_HEATMAP_DEEP_COLUMN_MS` | 1000 / 10000 | the two column widths |
| `L2_HEATMAP_ROW_BP` / `L2_HEATMAP_WINDOW_BP` | 0.5 / 600 | row height and window width, in basis points of price |
| `L2_HEATMAP_FUTURE_ROW_TICKS` / `L2_HEATMAP_EQUITY_ROW_TICKS` | 1 / 1 | dxFeed rows are fixed in ticks instead, since a tick is the unit a level lives on |

## Limits worth knowing before you build on it

- The recording is per provider. `dxfeed-replay-source.js` reconstructs
  futures and equities from source-scoped Order-v2 capture and eligible
  TimeAndSale rows; it requires a complete configured-source snapshot at or
  before the requested window, or starts at the next one inside that window.
- A rebuild can only be as good as the capture. A collector that was down
  leaves a hole no replay can fill, and the capture-quality tables say when
  that happened.
- Row geometry follows price, so a long-lived store can be invalidated by the
  market moving rather than by anything in the code.
