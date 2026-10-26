# Historical L2 event storage pilot

**Status:** implemented and checked locally. No publication, catalog entry or Historical Mode reader uses this pilot. It is one part of Report 67 stage 2.

## What it proves

The real engine's events can be stored as small Parquet parts and read with an exact source cursor and knowledge-time cutoff. A delayed verdict appears only when its evidence becomes known. Events retain source-anchored segment/event IDs; identical inputs and code produce identical logical rows.

The format is `historical-l2-engine-event/1`. It is an intermediate format, not the complete `l2_level_event` family. The engine outbox omits initial seeded levels, ordinary size increases and repeated reductions after the first shrink. The [lifecycle format](historical-lifecycle-pilot.md) supplies those observations and identities for the [combined output](historical-core-contract.md). The separate [state/coverage format](historical-second-pilot.md) stores one-second observations and trust intervals. These materialized families cannot restore an engine for exact Replay.

## Code and data flow

| Component | Responsibility |
|---|---|
| `src/indicators/l2-memory/historical-event-tap.js` | Drain one engine's events after each accepted input/prune; attach exact knowledge key/time, stable IDs and evidence quality |
| `conversion/historical_l2_events.py` | Validate rows; write a bounded Zstandard Parquet part and hashed manifest; read pinned events within an admitted interval |
| `scripts/verify/databento/verify-historical-event-pilot.js` | Run the pinned ES/NQ source examples through the real adapter, runner, engine and event tap |

The caller supplies an immutable derivation ID, instrument and exact segment seed key. The example producer hashes its native source pin, fixture, code, tick size, depth and prune cadence. A new engine needs a new segment tap. The tap refuses missed ring events, disabled capture, regressing cursors and events from a future engine clock. File exhaustion does not force a pending wall verdict.

`observed_engine_ms` preserves the engine's millisecond clock; it is not an exact source nanosecond timestamp. `known_ns` and the four-field `known_key` retain exact strings. For native examples, knowledge time is at least source receive time. A prune keeps the last accepted source key and uses the actual later clock as its knowledge time.

Evidence outside the supplied observed depth is marked `resting_unknown`. A trade there remains valid flow. Later hidden-volume evidence at that level also remains unknown until a new observed lifecycle or coverage reset establishes fresh evidence. Consumers must not turn these rows into hidden resting-liquidity claims.

## File and read contract

One part contains one instrument/derivation and contiguous event sequences beginning at zero for each included segment. It carries a physical append position so simultaneous segment changes retain producer order. Multi-part continuation is not implemented.

The writer creates a new local directory, validates rows before finalizing, writes `part.parquet`, then writes `manifest.json` last. A directory without that manifest is incomplete. Existing output directories are refused. The manifest pins compressed bytes, SHA-256, rows, identity and knowledge bounds; it explicitly declares the incomplete pilot scope.

Reads require the manifest SHA-256, verify the part's hash/bytes/footer count, then apply **both** knowledge time and the exact source-key cutoff. The requested interval covers event updates known within that interval; it does not assemble a full book or recover earlier wall context. Compact JSON bytes include array brackets and commas. Reads fail on overflow rather than truncate, and recheck cancellation and object integrity before returning. Cancellation returns no partial result.

| Limit | Pilot setting |
|---|---:|
| Events per tap drain | 8,192 maximum |
| Unobserved resting-evidence keys | 8,192 maximum |
| Rows / compressed bytes per part | 100,000 / 16 MiB |
| Payload / decoded source bytes | 16 KiB per row / 128 MiB per part |
| Read interval / output | 1 hour / 20,000 rows / 4 MiB |
| DuckDB buffer / threads / spill | 128 MB / 1 / 256 MB |

These are local pilot limits. The combined producer uses the separate lifecycle format for complete days. Hosted concurrency, paged reads and full-month release remain later gates.

## Acceptance and next work

Tests cover real engine-to-Parquet reads, a delayed prune verdict, equal-time source keys, append order across a segment switch, stable rows, missed event buffers, source/code identity, corrupt files, cancellation and size/count limits. Both pinned native examples round-trip through the actual producer.

The [level/lifecycle format](historical-lifecycle-pilot.md) adds seeded/full level changes, lifecycle IDs and multipart continuation alongside shared state/coverage output. The [combined output contract](historical-core-contract.md) records complete-day qualification, strict reads and the restoration decision. This earlier format remains an intermediate engine-event witness; it is not the published output or complete Replay state.

Related: [compact output target](historical-core-contract.md), [top-N source qualification](historical-topn-input.md).
