# Iceberg Detector (runtime side)

One indicator, two detection modes, one wire frame (`iceberg_orders`, see
`docs/contracts/ws-frame-contract/v1/ws-frame-contract-v1.md`). Futures use
the order stream; crypto uses price levels and trades. Native only on both:
no synthetic detection anywhere until dxFeed delivers order ids.

## Native icebergs (dxFeed, `native-iceberg-tracker.js`)

A CME native iceberg never leaves the book, so it keeps its dxFeed slot
(`index`). The exchange refills it with a PARTIAL whose size goes **up**;
nothing else can raise an order's size through a PARTIAL. Per slot life:

- a life starts at NEW, or at the first sight of a slot; it ends at DELETE,
  EXECUTE, a NEW over the slot, a REPLACE to another price, a change of side,
  or a remove flag
- `display` is the largest size the life showed, `executed` is the sum of
  PARTIAL decreases at that price plus the remainder on EXECUTE,
  `tranches` is refills + 1
- an iceberg is published from the first size-raising PARTIAL and on every
  change after; its end is `filled`, `pulled`, `replaced` or `interrupted`
  (the book was re-snapshotted under it, the assembler dropped it, or its
  dxFeed session ended; `updatedAt` is that moment)
- a REPLACE or MODIFY that raises the size is the owner adding, not a refill;
  a MODIFY down is a partial cancel, not execution
- a price or side change starts a new life. A CME order cannot change side,
  so a slot that changes side holds a new order, and a size-raising PARTIAL
  from the other side is never a refill

Facts from the captures that shape the code: refills land in the same
millisecond as the fills, so every event in a frame is processed in order;
`Order.time` is the placement time, so the receive time stamps the marker;
the slot is recycled the moment the life ends, so state is dropped on end.
Open lives are bounded (`MAX_OPEN_LIVES`); past the cap the oldest ordinary
life is dropped and icebergs are kept. Events arrive through the assembler's
`onApplied` tap, after it has applied them to the book. When a book that was
live is dropped (the assembler needs a new snapshot, the eager server ends
the session, or the runtime stops), the server calls
`onNativeUnavailable(pair, now)`, which ends every open life as
`interrupted` at that moment, so the final save carries it; a crossed book
inside its grace keeps its lives. The host builder
ends them the same way, on the receive clock of the capture row that dropped
the live book; a session end leaves no row in the capture, so on the host an
iceberg open across a capture session break ends at the next session's
snapshot.

## Probable icebergs (Binance, `probable-iceberg-tracker.js`)

Trades at one price and side with gaps under `gapMs` (2 s) form an episode.
The episode is a probable iceberg once it has lasted the learned duration,
the level has shown at least the learned floor, and the volume taken is at
least the learned ratio times the largest size shown. `confidence` is
`strong` above the strong ratio, `probable` otherwise, and `weak` when the
display later outgrows the ratio (the mark stays). The episode ends when the
price goes quiet for `gapMs`; `sweep(ts)` closes stale episodes from the tick.
A level that was never shown, or a sub-second sweep through a stale 100 ms
snapshot, never qualifies. Open episodes are bounded (`maxOpenEpisodes`),
dropping the quietest unmarked first. A price level is forgotten once it shows
0 and no episode holds it, and a tracker holds at most `maxLevels` levels: the
indicator sets it to twice the depth the runtime's own Binance book keeps per
side (`MAX_RETAINED_DEPTH_LEVELS`, 5,000 on perp and 10,000 on spot), so
10,000 levels on perp and 20,000 on spot, both sides together.
Past it the levels farthest from the last trade go first (from the latest
depth update before any trade); a level with an open episode is never
forgotten. A level hit while it holds no known size (forgotten at the cap,
never seen, or last seen at 0) takes its first depth update as the episode's
baseline, not as a refill, so tranches start at 1 there. `trackedLevels()`
gives the count, also in the indicator's `stats()`.

The Binance server feeds the tracker only while the pair's book is in sync
(its gated book status `READY`, the one the heatmap reads). The moment it is
not (a depth sequence gap, a resync, the route down), the server calls
`onDepthUnavailable(pair, at)`: `reset(at)` ends every marked episode as
`ended` at that moment without teaching the learned cuts from the truncated
ones, drops the open episodes and every level, and the watched run closes at
the last event before the outage, so the outage is a gap the host fill
answers. Trades are ignored until the next depth update of a book in sync,
which starts a new run.

## Learned cuts (`learned-cuts.js`)

Nothing in lots or BTC. Ring buffers (last 4096 observations) of what the
touch showed, how long multi-hit episodes lasted, and the ratio of long solid
episodes. The cuts are percentiles of those (visible 0.90, duration 0.99,
ratio 0.99, strong = 1.5 x ratio) and are `ready` after `minSamples` (200).
Single-print episodes do not shape the duration cut; short or thin episodes
do not shape the ratio cut. The ratio floor (`minRatio`) is 1, so the learned
cut alone decides what is marked; the chart's Refills slider is the trader's
floor on what is shown. Any new instrument gets its scale from its own
book as the samples arrive. On 3 h of BTC perp with the defaults the cuts
landed at floor 0.255 BTC, duration 2.9 s, ratio 2.1, strong 3.15. The
percentiles are settings, not a calibration.

## Indicator, history and store

`iceberg-indicator.js` owns one tracker and one `iceberg-history.js` per
pair. Every tracker update is mapped to the wire shape (`wireIcebergOf`);
settled ones are recorded in the history (idempotent by id, newest
`updatedAt` wins, pruned past `maxAgeS`, capped by count and bytes), and the
list is published through the server's `iceberg-channel.js`. The cap keeps the newest by end
(`updatedAt`), and time the history dropped for room is never claimed as
watched: each drop moves a floor past the newest mark dropped, and every span
watched after it (the runtime's own run or a host fill) starts at or after the
floor. `heldFrom()` is the first mark the history can still hold: that floor,
and while it is at its count cap also just past its oldest iceberg's end. The
floor is not saved; a history loaded at its cap gets the same answer from its
oldest iceberg.
Every iceberg the runtime publishes, pages, records or restores is held to its
pair's wire size ceiling (`sizeCeilingFor`: 1e7 for Binance and futures, 1e12
for equities); the history takes its id length, vocabularies, price magnitude
and epoch bound from the frame builder. `snapshot(pair)` is the settled
history plus the live icebergs, in mark order, and is what a joining client
receives. `tick(at)` sweeps each Binance pair's probable tracker on that
pair's own exchange clock (its latest event time plus the local time since
that event arrived, never earlier than the event, nothing before the first
one), prunes, and saves a dirty history in the background every `storeS`
seconds. A background save that `stop()` has superseded never renames over
the final save (it removes its temp file), and a background save marks the
history saved only if nothing changed after its payload was taken. `stop()`
closes the watched run and saves synchronously; icebergs still open at that
moment are not saved. On start the store is restored whole: a strong or
probable mark under the ratio floor is dropped on load, weak marks always come
back. Every wire iceberg says where it came from (`origin`): `runtime` for
the runtime's own, `host` for one the host fill brought; every frame says
where the live window begins (`liveSince`: the frame's time less the heatmap's
live horizon, which both servers hand the indicator as `liveReachMs` from the
liquidity publisher: `L2_HEATMAP_DEEP_S` when it is above
`L2_HEATMAP_HISTORY_S`, else `L2_HEATMAP_HISTORY_S`; four hours by default).
The chart's History Off shows the runtime's own marked inside that window,
the window absorption draws with history off; the hours before are the stored
history's or the host's to bring.

The store (`iceberg-store.js`) writes `<pair>.icebergs.json` atomically
(temp file, rename) under `<data root>/icebergs`, its own directory so the
liquidity store's startup prune never touches it. Load rejections carry a
reason (`NOT_A_FILE`, `TOO_LARGE`, `UNREADABLE`, `MALFORMED`, `FOREIGN`) and
the pair starts empty. A history that fails the model's checks (version, an
invalid or oversize entry, a duplicate id) also restores none of its watched
spans, so the host fill asks for them again; its learned cuts still come
back. A payload over the history's byte budget (`maxBytes`, 2 MiB by
default) is refused before anything is written, and the indicator then trims
the oldest; the store itself never reads or writes a file over
`MAX_ICEBERG_FILE_BYTES` (8 MiB).

## Host history

The runtime only sees what it watched itself, so a laptop that was off has
no icebergs for those hours. The host builds the same thing from its capture
and serves it; the runtime takes it only for the spans it did not watch.

- **Builder** (`iceberg-host-builder.js`, run by
  `scripts/serve/run-iceberg-history.js`, unit
  `terminal-iceberg-history.service`). One pass per catalog pair over the
  host's capture, forward only, in 5 min chunks, 60 s behind the capture's
  newest row (one lookup in index order per chunk: the newest arrival id on
  dxFeed, the newest depth event or snapshot on Binance). It feeds the real
  `iceberg-indicator.js` (same trackers, same learned cuts, same floors)
  through `iceberg-capture-sources.js`: dxFeed order events on the capture's
  receive clock, starting at the last snapshot before the replay start so
  every order life is known (found once rows arrive if the capture was empty
  at start), each chunk reading up to the capture's current end; Binance
  trades, snapshots and depth diffs in exchange-time order, trades first on a
  tie, as the live tap sees them. The first 24 h of a Binance pair are a
  warm-up for the learned cuts and are not served; futures need none. Settled
  icebergs, the cursor, the learned cuts, the coverage and the gaps are
  checkpointed in one transaction per chunk, so a restart resumes 10 min
  before the cursor and settles nothing twice, inside the Binance warm-up
  too; rows replayed before the cursor create no gaps. Silence over 30 s in
  the capture is a `NO_CAPTURE` gap, a dxFeed book that is not `READY` a
  `BOOK_UNAVAILABLE` gap (a stretch that starts and ends in the same receive
  millisecond is none). Either gap still open when a chunk ends is
  checkpointed up to the cursor and replaced by the next checkpoint (extended,
  or closed by the next event), and a restart keeps its true start. A gap the store cannot hold is
  dropped, logged once and counted (`droppedGaps` in `status.json`). The
  builder's start, coverage and gaps follow the 7-day retention, so a prune
  sticks across checkpoints. A capture that cannot be opened is retried every
  cycle (`CAPTURE_UNREADABLE`, state `WAITING`), so a dxFeed database that
  appears later is picked up without a restart. SIGTERM and SIGINT stop the
  builder after the chunk in hand.
- **Store** (`iceberg-host-store.js`): one SQLite file per pair under
  `TT_ICEBERG_DIR` (default `<data root>/iceberg-history`), pruned to
  7 days, wiped and restarted under a new generation when
  `ICEBERG_RULES_VERSION` changes. `status.json` beside the stores says
  what each pair is doing (state, reason, cursor, settledThrough, icebergs,
  gaps, droppedGaps).
- **Route** `iceberg-history` on live-storage (relayed by the gateway):
  `symbol`, `marketKind`, `fromTs`, `toTs`, `limit` up to 2000,
  `after` `{ markedAt, id }`; answers the icebergs marked in the window in
  mark order, the store's `watched` spans (coverage minus gaps, clipped at
  the settled line) and `next`, or `NO_HISTORY` / `NOT_BUILT`.
  A page carries only the watched spans inside its window, at most
  20,000 of them, oldest first (the fill asks for the rest at the next fill),
  so the largest page, 2,000 icebergs at their longest, is 1.52 MB against the
  2 MB caps of the gateway relay and the remote reader; at 4,500 gaps a page
  takes about 4 ms. A window at or past the settled line answers no span.
  The reads behind one page (checkpoint, page, generation, rules version,
  watched spans) run inside one read transaction (`readTransaction`), so a
  builder commit or a rules wipe cannot land between them. live-storage
  closes the per-pair readers when it stops.
- **Fill** (`iceberg-host-fill.js`): 120 s after start and every 30 min the
  runtime asks for the last 5 days minus the spans its own history watched
  (`history.uncovered`), never the last 10 min. A host that answers no gap
  (storage unavailable, or a read that failed its three tries) ends the fill
  at that gap, the other gaps are not asked, and the pair is left alone for a
  minute, then twice as long each time up to half an hour (`HOST_BACKED_OFF`
  in the fill's reasons, `backedOff` in its stats); a page that lands for
  that pair ends its pause. Each pair (provider, market kind and symbol)
  keeps its own pause, and a fill counts only its own pages, so one pair's
  silent host never holds back another pair's fill. The host's `watched` spans
  are first joined across holes of at most 30 s (the runtime's own watch
  gap); a longer hole stays a hole and is asked again at the next fill. It
  records only settled icebergs whose mark lies inside those spans and under
  the pair's size ceiling (the rest are counted as `refused` and logged once
  per gap), then marks exactly those spans as watched, so the chart's
  "watched from" and the `watched` list on every frame are honest about both
  machines. If paging stops early (a page still unavailable after its three
  tries, the 64-page cap, or a later page under another host generation or
  rules version because the store was wiped and rebuilt meanwhile), the gap
  is watched only up to the last mark fully read, the outcome carries the
  page's reason, `MAX_PAGES` or `GENERATION_CHANGED`, counted as
  `incomplete`, and the rest is asked at the next fill. It
  never asks before `heldFrom()`, so once the history is at its cap it asks for
  nothing it could not keep: gaps are asked newest first, each older one cut
  at `heldFrom()` again, and only the icebergs the history kept are handed on.
  Three tries per page with growing waits, at most two reads in flight. Ids
  never need to match across machines: a span is either the runtime's or the
  host's, and a host iceberg of the same kind, side and price marked within
  30 s of one the runtime holds is the same iceberg and is left out
  (`duplicates`). What is taken carries `origin: "host"`. The runtime warns
  once per pair when the set of fill reasons changes, with counts, and logs
  once when every gap is answered again; `stats()` carries each pair's
  `hostReasons` and the fill's counters (`hostFill`).

## Env

| Variable | Meaning |
|---|---|
| `L2_ICEBERG` | `0` turns the Iceberg Detector off: no trackers, no restore or save, no host fill; the channel still answers with empty pages that carry `liveSince` |
| `L2_ICEBERG_HISTORY` | `0` keeps histories in memory only and asks the host for nothing |
| `L2_ICEBERG_STORE_DIR` | directory of the history files (default `<data root>/icebergs`) |
| `L2_ICEBERG_STORE_S` | seconds between background saves (default 300) |
| `L2_ICEBERG_MAX_AGE_S` | age after which a settled iceberg leaves the history (default 7 days) |
| `L2_ICEBERG_HOST_FILL` | `0` stops asking the host for the spans this runtime did not watch (on when the gateway URL and token are set) |
| `L2_ICEBERG_FILL_DELAY_S` | seconds after start before the first host fill; 0 fills at once (default 120) |
| `L2_ICEBERG_FILL_EVERY_S` | seconds between host fills (default 1800) |

The live window follows the heatmap's own settings (`L2_HEATMAP_DEEP_S`,
`L2_HEATMAP_HISTORY_S`). The builder's own settings (`TT_ICEBERG_*`) are
listed in `docs/operations/09-configuration.md`.

## Measured

- native: about 360 ns per order event on the 28-minute PM capture
  (1.5 M events), 85 icebergs (11 NQ, 74 ES)
- probable: about 5.5 µs per event for the tracker with its learned cuts on
  3 h of BTC perp (8.8 M events), about 2-3 % of a core live; on the same
  recording the perp level maps stay at 10,000 levels (27,424 and still
  rising without the cap) with the same marks on all four pairs
- fixtures in `test/fixtures/iceberg/`: 19 native trails and 7 controls cut
  from the captures, 4 Binance episodes and one sweep to reject
