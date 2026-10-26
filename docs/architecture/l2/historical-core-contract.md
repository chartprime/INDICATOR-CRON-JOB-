# Historical L2 compact output

**Status:** Report 67 stage 2 passes for ES, NQ, AAPL and TSLA on 2026-08-05. All four complete-day outputs pass independent source and every-state checks, strict read measurements and pinned local descriptor preparation. No files using this contract are published. Full-month and host qualification remain stage 3; complete checkpoint restoration remains stage 7.

## Purpose

Derive the accepted source once, then let Historical Mode read bounded indicator data. Keep the existing engine and indicator SDK. Exact tick Replay also requires ordered inputs and complete restore state; the one-second output alone cannot provide it.

## Source and identity

One derivation pins an instrument, source manifests and hashes, input order, geometry, engine revision, configuration, adapter revision and prune cadence. Changing any of those creates a new derivation version. A mutable branch name or host path is not a version.

- Databento uses one price per key: ES/NQ 0.25, AAPL/TSLA 0.01. Its observed depth is ten levels per side.
- The CME pilot takes native MBP-10 row order for both book observations and Trade records. The separate MBP-1 trade authority is an independent reconciliation source. A timestamp/sequence match does not supply within-event order.
- Equity version 2 requires a complete native/canonical ordering receipt. Verified repeated Trade books observe without settling pending fills; changed Trade books apply their retained change before the new print. Ordinary book updates settle normally. Version 1 equity lifecycle outputs are refused. Do not apply the CME echo rule to equities by default.
- Crypto geometry and source qualification are fixed before producing its version. Price-relative geometry must not silently change inside a partition.

Canonical source decimals and exact nanoseconds remain available through pinned lineage. Do not label floating-point engine inferences as exact source decimals. Persist an explicit representation and unit for each field; display rounding belongs at the UI boundary.

Use stable identifiers derived from the version, instrument and exact first accepted input key. A level lifecycle also includes its side, price key and first accepted lifecycle occurrence. Random IDs, process counters without a source anchor and local file paths cannot identify published history.

## Three derived families

| Family | Meaning | Required content |
|---|---|---|
| `l2_level_state_1s` | A closed one-second view, stored sparsely by observed price | Instrument/version, interval bounds, segment, price key, bid/ask sizes, known-side buy/sell volume, source-depth coverage and direction coverage |
| `l2_level_event` | Append-only observations and lifecycle updates | Stable event/lifecycle IDs, side/price key, event type, observed time, time/key when known, source trigger, evidence quality and the fields changed by that event |
| `l2_book_segment` | A trusted or unavailable source interval | Stable segment, interval bounds, reason, observation depth/range, seed provenance, source pins and the key when the boundary became known |

State sampling uses `[open_ns, close_ns)`. A closed row is available no earlier than `close_ns` and only after its recorded knowledge time and source cursor are admitted; delayed receipts can make that later than the interval close. A partial final second is explicit, never labelled complete. The precise source cursor used at each boundary is retained. A ten-second navigation fold must not include unfinished seconds or blend trusted segments across a gap.

Sparse omission must be unambiguous. Within a declared observed range, a stored zero means observed empty. Outside that range, or during an unavailable segment, absence means unknown. An explicit coverage interval is required even when no nonzero price rows exist.

Unknown-side trades remain counted as unknown volume/count in the interval coverage. They are not distributed into BUY/SELL, and an indicator cannot present known-side flow as complete directional flow. Trades outside trusted books are counted separately and never carried into the next seed.

A known-side trade can also occur beyond the observed tenth level during a sweep. It remains valid directional flow, but its unseen resting size, reduction cause and hidden-liquidity footprint are unknown. Do not interpret a trade-only ledger record outside observed coverage as proof of hidden liquidity.

## Event and knowledge time

Keep both when a change happened and when the producer had evidence for it. A wall can empty before its fill/pull verdict is known. Store that later verdict as an append-only update, not as a rewrite visible at the earlier emptying time.

Each event carries an exact `known_key` in the chosen input order and `known_ns`. Events emitted by a prune are anchored to the producer cursor and prune clock that actually emitted them. Source receive time is retained where available; it is not interchangeable with the engine's exchange-time clock.

A historical read has an explicit `as_of` cursor/time. It must filter all events, segment boundaries and inference updates by knowledge time before assembling a view. Filtering only the lifecycle's start or end time is insufficient. Equal-millisecond inputs retain their exact ordering keys. Tick Replay advances an exact cursor; a browser millisecond selection has a documented inclusive cutoff.

Level events preserve additions, reductions, emptying/refill cycles, trades, hidden-volume updates, later verdicts and loss of observed coverage. A final lifecycle summary alone cannot recover intermediate evidence or prevent look-ahead. Indicator wall clustering, whale thresholds and spoof scores remain indicator policy over accepted core evidence.

Top-ten coverage exits end observation without a fill/pull conclusion. A returning price starts with unknown prior age. Locked, crossed, incomplete or suspected-gap source intervals end trust; unresolved endings remain unknown. Do not force a pending ending to a final verdict merely because a file or job ended.

## Producer and verification

The producer applies accepted frames through the existing engine in the qualified source order. It drains level events and accepted trade prints before their bounded buffers can overwrite them. Any missed event, duplicate source cursor, output truncation or unsupported action fails the partition.

The final manifest records source and output counts/hashes, accepted/excluded/unknown volume, segment coverage, geometry, configuration, method version, time representation and file bounds. Publish only after the local and uploaded objects reconcile. Publish the catalog last and retain the prior catalog for rollback.

Acceptance requires:

1. Every trusted book agrees with the accepted source; unavailable periods stay explicit.
2. Known/unknown/outside-trust counts and volumes agree with independent source queries.
3. Source-ordered reductions and later lifecycle updates agree with independent bounded event examples, including multi-print events and coverage exits.
4. Two identical derivations produce the same logical rows and stable IDs. Physical bytes need match only when the writer's byte determinism is part of the version contract.
5. Reads before and after a delayed verdict differ only when that verdict became known.

Passing a rolling-flow sum alone does not qualify fill/pull attribution. MBP reductions are inferred causes, not order-level proof of cancellations or fills.

The engine's `cancelled` quantity means a reduction unexplained by accepted known-side prints under the versioned input order. Unknown-direction prints can explain activity that this model cannot assign. A `filled`/`pulled` verdict is the engine's threshold/grace inference, not an exchange-confirmed order outcome. Consumers must retain direction coverage and resting-evidence flags when interpreting those metrics.

## Bounded reads and Replay

Partition by provider/instrument/version/UTC date and index time bounds. Use sparse Parquet rows with explicit schema and compressed, hashed objects. Measure an encoded day before fixing part size, worker concurrency, scan estimates or a month-wide ETA.

Readers pin a catalog generation and enforce time span, source bytes, decoded rows, output bytes, memory and concurrency limits before work starts. They support cancellation and refuse a request that would cross an unqualified interval. Oversized reads use explicit bounded pages or a coarser accepted view; they never silently drop data.

Exact Replay needs immutable ordered input references and versioned restore artifacts in addition to these three families. A public engine snapshot is not complete restore state: pending trade attribution, deferred endings, flow/size windows, event cursors, coverage, prune clock and indicator state matter. Restore support must export/validate that complete state, or replay from a trusted source seed within a measured work budget. Never use a future checkpoint or cross an unresolved source gap.

Seek acceptance compares a fresh run to a restored run at the same exact cursor, including levels, flow, events, pending inference and segment state. Two viewers use separate clocks/cursors. Restore spacing and maximum seek work remain open until this comparison and resource measurements pass.

### Restoration decision for this storage version

The three materialized families support historical reads; they are not engine checkpoints. The retained source and exact cursor permit deterministic replay from a trusted segment seed, but a full-day restart is unsuitable for interactive seeking. A local NQ measurement replayed 10,000 source rows spanning 18.607 seconds in 6.084–6.965 seconds, including process startup and event/state serialization. Three runs produced identical output hashes. This is a quiet opening prefix under concurrent conversion, not a peak-session or checkpoint-restore measurement.

Exact Replay therefore requires a separate, versioned complete-state checkpoint family during Report 67 stage 7. Its initial spacing target is **at most 5,000 input records or 30 seconds, whichever comes first**, including checkpoints at trusted segment seeds. This is a design target, not a verified production cadence. Release qualification must measure busy periods, complete state size and restore/load cost, reduce spacing where needed, and enforce a hard seek work/time budget. Source gaps cannot be crossed and a later checkpoint cannot be used for an earlier seek.

A checkpoint must include the engine's pending fills/endings, ledger and rolling windows, source adapter and segment state, observer/event cursors, pending second/coverage state, prune and knowledge clocks, plus each selected indicator's state. Public snapshots omit required state and are refused as checkpoints. The first Historical L2 release does not claim arbitrary tick Replay or checkpoint restoration. Source-seed fallback may be used only within an explicitly admitted work budget; an oversized seek must be refused rather than silently starting with incomplete history.

## Next implementation

All four output sizes and strict reads are measured locally. Each instrument has nine event windows and nine state windows, covering 1/10/60 seconds at beginning/middle/end part boundaries, each repeated three times.

| Instrument | Event bytes | State/coverage bytes | Event windows accepted / refused | State windows accepted |
|---|---:|---:|---|---:|
| ES | 1,874,419,329 | 86,934,146 | 5 / 4 | 9 |
| NQ | 6,351,967,953 | 92,048,925 | 2 / 7 | 9 |
| AAPL | 594,305,616 | 60,581,257 | 7 / 2 | 9 |
| TSLA | 418,142,446 | 60,464,982 | 8 / 1 | 9 |

Dense event requests are explicitly refused, including NQ's busy one-second window. The readers admit at most one hour, 64 MiB selected compressed part bytes, 20,000 rows and 4 MiB compact JSON including array framing. Historical Mode must use bounded event pages when a window exceeds admission. Local measurements have uncontrolled cache and concurrent work; they do not qualify host throughput or browser latency.

Full-August generation, per-session qualification, uploaded-object verification and catalog-last publication follow the [August release plan](historical-august-release.md) in stage 3. Crypto, Historical Mode, live/archive convergence and exact Replay retain their separate Report 67 gates. Extend the schema only where an accepted indicator requires it.
