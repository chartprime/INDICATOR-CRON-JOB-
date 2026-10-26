# Benchmark and replay fixtures

Two tiers, kept apart on purpose because they prove different things.

| Tier | Where the data lives | Runs in CI | What it proves |
| --- | --- | --- | --- |
| **Deterministic** | Generated in memory by `apps/runtime/test/helpers/synthetic-binance-db.js` from a seed | Yes, always | Replay reconstruction is unchanged byte for byte on a known stream, and the cheap reconstruction path equals materialising the full book on every event. This is the permanent regression guard. |
| **Real slices** | `apps/runtime/data/fixtures/*.sqlite`, git-ignored, sliced from captured databases | No: skipped when the data is absent | The same properties on real, dense data at production-like scale. This is qualification evidence for a machine that holds the data, not a guard that CI enforces. |

Only `inventory.json` and `production-reference.json` are committed. The inventory
holds hashes, row counts, statistics, source identity and governance metadata. It
never holds rows, host paths, credentials or raw payloads, and a test rejects an
entry that does.

## Making a slice

```powershell
node scripts/maintain/export-fixture-slice.js `
  --source data/live/market-data.sqlite --id binance-btcusdt-spot-4h-2026-09-08 `
  --symbol BTCUSDT --market-kind SPOT --from 2026-09-08T22:00:00Z --duration 4h `
  --reference binance-btcusdt-spot-hour --pin-duration 20m --pin-pages 5
```

The exporter opens the source read-only (it never migrates or writes to it), takes
**one read transaction** so every table comes from a single snapshot even while a
collector is writing, and copies every column the source and the current schema
share, so a schema v15 source produces a v16 fixture. The slice contains exactly what
replay reads: the newest snapshot at or before the window start (or the first inside
it), every snapshot up to the end, depth events from the anchor minus 60 seconds,
trades from the anchor, candles, and the capture sessions and incidents that overlap
the window. Row ids are preserved, so replay ordering is untouched.

Guarantees, each with a test:

- **Snapshot consistency.** Rows committed to the source mid-export never reach the
  slice; the source's advance is recorded as `source.advancedDuringExport`.
- **Source identity.** A source file replaced or truncated while it is being read
  discards the slice (`SOURCE_REPLACED_DURING_EXPORT`). The inventory records the
  source's base name, size, schema version, capture span and highest row ids, never
  its path.
- **Reproducibility.** The same window exported twice is byte-identical, and the
  fixture's own SHA-256 is authoritative. Source name and size are metadata.
- **No sidecars.** A fixture is finalized in rollback-journal mode, so reading it
  never creates a `-wal` or `-shm` file and needs no writable directory.
- **Nothing left behind.** A refused or failed export leaves no fixture, temp or
  sidecar file, and the inventory is untouched.

## Acceptance instead of "production-sized"

Each slice is checked against an hourly reference measured on the production
capture host (`production-reference.json`). The bounds are explicit and recorded in
the inventory next to the observed values:

| Metric | Bound relative to the reference |
| --- | --- |
| `events.perSecond` | 0.8× to 1.25× |
| `events.levelsPerEvent.mean` | 0.5× to 2× |
| `trades.perSecond` | 0.5× to 2× |
| `snapshots.gapMs.p50` | no greater than the reference gap |

An export that misses a bound is refused unless `--allow-failing-acceptance` is
passed, in which case the failure is recorded and `verify-fixtures` reports it as
drift. Markets differ hour to hour, so the bands are wide on trades and depth and
tight on the depth-event rate, which is set by the exchange's update interval.

The reference was taken with read-only aggregate queries and index range scans, no
row exports and no full-table scans; its `method` field says so.

## Replay pin

Each slice is replayed through the real page reader (`readReplayPage` with its
default limits and a stated geometry) and the pages are hashed canonically. For a
multi-hour production-density fixture, `--pin-duration` may bound the semantic
window and `--pin-pages` may pin a deterministic prefix. A prefix pin records
`complete: false`; it proves byte stability over its declared pages without claiming
full-window qualification. The complete fixture remains available for deliberate
scale benchmarks. The inventory records the pin window, page ceiling, completion,
geometry, limits, page count, frame count, summed statistics and digest. A different page size is a
different pin: frame counts change because each page re-anchors, so pagination is
not asserted to be transparent. Full-window hashing is an explicit offline
qualification (`--pin-duration` omitted), not a prerequisite for publishing the
fixture inventory.

## Checking a fixture

```powershell
node scripts/verify/verify-fixtures.js            # sizes, digests, table digests, integrity, statistics, acceptance
node scripts/verify/verify-fixtures.js --replay   # also recompute the replay pins (slow for the 4 h slice)
node scripts/verify/verify-fixtures.js --require  # fail when a fixture file is missing
$env:TT_TEST_REAL_FIXTURES = "1"; npx jest test/server/replay-fixture-pin.test.js
```

A missing fixture is reported as `SKIPPED` and is not a failure unless `--require` is
given. A file that is not a database is reported as drift, not a crash.

## Data governance

- The Binance fixtures are slices of the public exchange feed captured by the
  project's own collector, kept only in the git-ignored data directory.
- dxFeed and CME data is licensed vendor data. It may be sliced only into the same
  git-ignored directory for development use, never committed, and each entry says so
  in `governance`. No real dxFeed connection is ever opened to make a fixture; slices
  come from databases the collector had already written.
- Entries are validated on every export and in the test suite: no host paths, no
  credential-shaped keys, a bare source file name, a `local-only-git-ignored`
  retention and a stated basis.

## What is not covered

- The deterministic tier is a synthetic order book: it guards logic and byte
  stability, not the statistical texture of a real market.
- Real slices are a few hours from one capture period. They do not replace the
  production databases for scale (95 GB and 34 million depth events on the host).
- The production snapshot cadence has since become sparser than the local capture's
  (3 to 12 per hour against 9 to 55), so the snapshot criterion is a ceiling rather
  than a match.
