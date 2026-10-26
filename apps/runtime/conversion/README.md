# Local resumable conversion

Phase 2 entry: `node apps/runtime/scripts/convert/run-conversion.js --inputs-json inputs.json --dataset-version v2 --staging-root /scratch/conversion --curated-root /data/curated --catalog-root /data/curated/_catalog` from the repository root. Paths are examples; use isolated local locations before host qualification.

`inputs.json` is a list:

```json
[
  {
    "local_path": "/downloads/aapl.csv",
    "s3_key": "raw/databento/dataset=XNAS.ITCH/schema=ohlcv-1s/symbol=AAPL/year=2025/month=09/aapl.csv",
    "schema": "ohlcv-1s",
    "dataset": "XNAS.ITCH",
    "symbol": "AAPL",
    "last_modified": "2025-10-01T00:00:00Z",
    "coverage_verified": false
  }
]
```

`coverage_verified` defaults false. For CSV, set true only after independently verifying delivery completeness for every represented date; rows existing is not proof. Unknown overlapping coverage fails rather than silently choosing a partial source. `last_modified` is a timezone-aware authority tie-break, not event time or proof of source availability. Local input files must remain immutable.

## Resume and publication

Rerun the same command and input descriptors. Semantic inputs participate in job identity. Completed split files and published parts are hash checked; damage fails with an integrity error rather than being silently reused. Partitions publish through staging/rename and can recover a rename-before-checkpoint interruption if the regenerated content matches. The recovery comparison also recognizes the prior sorted-key logical hash only for partitions atomically published by the pre-throughput writer immediately before their checkpoint; any other manifest mismatch remains a conflict. Catalog intent and receipt files recover publication interruptions; rerunning an older job returns its own receipt without rolling CURRENT back.

Each new catalog snapshot retains prior non-replaced partitions. A new partition replaces an earlier same-instrument/family/date catalog entry. This is an explicit date-replacement policy: supply the complete intended replacement date, not an arbitrary additive fragment. Old immutable files remain retained. Source overlap within a job is resolved by half-open time intervals. Different schemas/families are routed independently.

Staging and curated roots must be disjoint. OS locks serialize writes to the same dataset version and staging root; the catalog publisher lock holds through remote catalog publication. These are host-local coordination mechanisms, while S3 conditional writes reject a conflicting remote parent. Old pre-audit checkpoints have neither the new identity nor split checksums and are not silently migrated. Use a new version and isolated staging after reviewing any already-published version; do not delete production artifacts to force reuse.

## Local bounds

`backfill_driver.run_range` runs ordered dates within a shared checkpoint. All supplied raw files are split before the first selected date is mapped, so a monthly-cadence source still requires its whole raw file present locally for the life of that job. `fully_published=False` means the overall local catalog is not yet committed. Per-date cleanup removes only reproducible partition staging under the conversion locks; raw inputs, split files and the checkpoint are kept for resume until the whole requested range finishes. Once the complete plan has a remotely verified catalog publication, the S3 driver removes its cached inputs and the job's `raw/` split tree, but retains its checkpoint, frozen inventory and publication evidence.

Local partition copies and depth continuity use only manifest-listed, hash-verified parts. Round-trip validation compares complete rows exactly in bounded parts. Contradictory facts within one definition day fail instead of selecting a value by input order.

## S3-native daily backfill

`backfill_driver.run_s3_backfill` downloads a frozen set of source objects, converts requested UTC dates and publishes each completed partition before removing its local copy. Eviction records bind to the S3 bucket and namespace. Recovery verifies remote manifests and parts under filesystem locks; catalog publication verifies already-remote artifacts rather than trusting a boolean flag. Source discovery requires a listed ETag, then download uses that conditional ETag and a hashed cache identity with local SHA-256 verification. `backfill_cli.py` exits nonzero until the complete source-month plan is published; a narrow date request that intersects a monthly source may therefore perform safe partial work but remains an incomplete command.

For phases in `QUARANTINE_SKIP_PHASES` (`ohlcv` and `l1`; `l2` is excluded because its depth family carries continuity across days) a day whose rows the contract rejects does not end the symbol. The date, its error, the archived evidence path and that evidence's SHA-256 are written to `checkpoint.json`, the month is recorded as partial in `_sequence/<version>-partial.json` with the frozen raw identities and the operator action required, and the symbol continues to its next month. A partial month never writes a completion receipt, never enters the catalog, and keeps its staging so it stays retryable. More than `MAX_QUARANTINED_DAYS_PER_MONTH` quarantined dates in one symbol-month is treated as systemic and stops that symbol; the budget is counted from the durable set, so it survives a restart. `--retry-quarantined` is an explicit recovery action that clears that set only after the evidence has been fixed. `backfill_sequence.py` admits a month only when free space covers `TT_CONVERT_GLOBAL_RESERVE_BYTES`, the configured `TT_CONVERT_SCRATCH_BYTES` ceiling and the next frozen source download; it repeats that admission before definition downloads. Active workers record those reservations in a lock-protected durable ledger, so concurrent admissions cannot all approve the same free space. This accounts for retained partial months that a per-stage scratch budget cannot see.

`backfill_sequence_cli.py` orchestrates OHLCV, L1, L2 or the derived families in
source-month units. For a derived phase it also takes `--source-prefix` and
`--source-catalog-root`, so the production command itself can be trialled: it
reads the real sources and publishes into a qualification namespace and catalog.
A non-derived phase never receives them. Monthly and daily overlaps remain together. Each dataset/schema/symbol/month has a separate version and retained inventory. Durable completion markers follow remote catalog publication; verified completed months skip raw downloads on restart. Completed split scratch is then removed, while checkpoints and source inventories remain as evidence. The driver still needs an entire source month's raw/split working set; it is not a streaming downloader with a one-day total disk bound. `--pool-size` defaults to 1; a larger value runs isolated per-symbol workers while catalog publication remains serialized. Do not set a non-default pool size in the service until a host benchmark has qualified its CPU, memory and scratch budget.

Futures CSV identities require actual provider definitions. Mappings are bounded by the first definition date and expiration and reject inconsistent identities. Missing definitions must be retrieved as provider evidence; do not manufacture timestamps or infer a concrete contract from a continuous alias. A date without raw rows is recorded as such, not inferred to be a closed trading session.

See the [archive worker runbook](../../../docs/operations/04-archive-runbook.md) for background execution and recovery. Partial publication fails the sequence; no later stage should start on a failed stage result.

| Environment | Default | Meaning |
|---|---|---|
| `TT_CONVERT_SCRATCH_BYTES` | 8 GiB | Staging budget, checked during split/map and around sort/output |
| `TT_CONVERT_FREE_RESERVE_BYTES` | 1 GiB | Local free-space floor; tune upward for the host |
| `TT_CONVERT_SPILL_BYTES` | 512 MiB | DuckDB spill cap, additionally limited by available staging budget |
| `TT_CONVERT_PART_ROWS` | 262144 | Maximum output-part rows; split by event-time ranges |
| `TT_CONVERT_DUCKDB_MEMORY_BYTES` | 4 GiB | Writer DuckDB working-memory limit; enforce a separate host cgroup limit |
| `TT_CONVERT_FINALIZE_THREADS` | 8 | DuckDB worker threads for Parquet finalization and depth-continuity summaries |
| `TT_CONVERT_BATCH_ROWS` | 2048 | Maximum source rows per contract-worker request; request and response must remain below the bridge frame limit |

An oversized equal-timestamp group fails `PARTITION_UNSPLITTABLE`. Insufficient staging fails `SCRATCH_BUDGET_EXCEEDED` before catalog publication. These are application guardrails, not a filesystem quota or a cgroup RSS limit. Host resource/throughput qualification is still required before large archive jobs. Split handles are bounded; Parquet validation stays in DuckDB instead of materializing all IDs into Python sets. Historical raw files are still hashed on restart; completed split sources are not decoded again.

## Validation

From `apps/runtime/conversion`: `uv run --frozen pytest -q`. From `apps/runtime`: run the runtime Jest suite. Regression coverage includes partition/catalog interruption, cumulative publication, old receipts, corrupted artifacts, mixed-source authority, unknown CSV overlap, budget exhaustion and multi-part/unsplittable output.

Futures identity/rolls and depth are implemented; host qualification remains distinct from fixture acceptance.

## Derived trade families

`derive_families.py` (phase `l1agg` in `backfill_sequence.py`) produces four
families from published `trade` partitions, without touching raw data:

| Partition family | Record family | Row | Filters |
|---|---|---|---|
| `trade_minute_1m` | `trade_minute` | one UTC minute: `volume`, `buy_volume`, `sell_volume`, `undefined_volume`, `buy_notional`, `sell_notional`, `trade_count` | `NEW`; futures need a valid tick; every side counts |
| `trade_level_1m` | `trade_level` | one minute × one price bucket at the instrument tick (`price_bucket = floor(price / tick_size)` in fixed-point integers): `volume`, `buy_volume`, `sell_volume`, `trade_count` | as above |
| `trade_slice_2s` | `trade_slice` | one 2 s slice: `buy_notional`, `sell_notional`, `trade_count`, `last_trade_ns` | `NEW`; futures need a valid tick; BUY and SELL only |
| `trade_prints_1m` | `trade_prints` | the four largest BUY and SELL executions of a minute by rank: `trade_ns`, `price`, `size`, `trade_entity_id` | as slices; magnitude is `size` for futures and `price × size` for equities; ties go to the later execution |

The filters are those of the live storage reads (`readMinuteRollup`,
`readSlicedNotional`, `readLargeTrades`, `readDailyNotional`) so an archive
study equals its live counterpart; the golden fixture
`benchmarks/fixtures/golden/trade-families.json` pins both sides. Arithmetic is
exact decimal (values must round-trip through six decimal places, or the day is
refused as `FAMILY_PRECISION_UNSUPPORTED`). Tick sizes come from the roll table
for futures and a declared constant per equity dataset.

Every row is a `market-observation/1` record created and validated by the
contract bridge, written by `PartitionWriter`, published and evicted per
partition, and catalogued cumulatively, exactly as every other family. The
manifest's `derivation` block records the stage and family method versions, the
geometry, the filters, the source partition (identity, version, date, manifest
hash, record count) and the stage's reconciliation totals; `source_objects` is
the source manifest. One job is one symbol-month
(`w606-l1agg-v1-<dataset>-<symbol>-<YYYY-MM>`); the source set is the converter
catalog's published `trade` partitions for the symbol, refused when unpublished
or listed under two versions. A rejected aggregate row stops the job — there is
no quarantine for derived work.

`trade_families_rederive.py` is the independent check: a pure-Python
recomputation of every family from the source parts, compared row for row with
the published partitions, plus per-family digests. It also cross-checks each
minute's volume against the independently converted candles of the same day
(`--candle-family`, family `candle`, whose bars are summed into the minute).
A minute can legitimately differ there: the provider buckets its bars on the
capture timestamp and the families bucket on the exchange event timestamp, as
the live reads do, so a print at the edge of a minute is attributed to a
different bar. The report proves that rather than asserting it: for every
differing minute it measures the size whose event is inside the minute but whose
capture is not, less the size whose capture is inside it but whose event is not,
and counts the minute as explained only when that equals the difference exactly.
Neither direction is assumed -- GLBX carries prints captured before the
matching-engine timestamp (996 of 311,759 on 2025-09-24, to -149 ms), so a
candle can hold volume the families place a minute later. `unexplained` is the
number that matters: it must be zero, and any minute that is not is reported in
full. The qualified months measured 8 differing minutes of 18,008 (AAPL), 80 of
29,098 (ES) and 106 of 30,087 (NQ, across a contract roll), all explained. `derive_families_cli.py` runs
one symbol outside the sequence for qualification: `--source-prefix` and
`--source-catalog-root` name the production namespace and converter catalog the
`trade` partitions are read from, while `--curated-prefix`, `--curated-root` and
`--catalog-root` name the qualification namespace (`curated/_qualification/<run-id>`,
as for A6) and an empty local catalog lineage that receives the families. The
production catalog and namespace are only read. The re-derivation then takes
`--families-snapshot` and `--families-prefix` for the same split. In the phase
sequence both sides are the production namespace and the flags are absent.

## Tardis trades (crypto)

Phase `tardis-l1` converts Binance spot and USDⓈ-M perpetual trades for
BTCUSDT and ETHUSDT from `raw/tardis/exchange=<binance|binance-futures>/data_type=trades/...`,
one series-month per dataset version (`w606-tardis-l1-v1-<exchange>-trades-<symbol>-<YYYY-MM>`),
clamped to the owner window in `PHASE_WINDOWS`. Phase `tardis-l1agg` derives the
four study families from the published trades, as `l1agg` does for Databento.

- **One stream per series-month.** Tardis cuts its daily files by receive time;
  partitions are dated by exchange time, like Databento and live capture. The
  job reads the month's daily files plus the next day's file as one ordered
  stream (`tardis_decode.stream_rows`) and keeps only rows whose exchange date
  is inside the month. A trade executed before midnight and received after it
  lands on its own date. Rows must arrive on their exchange day or the following
  UTC day; older arrivals stop decoding, including rows otherwise filtered out.
  This bounds the lookahead on the files read, not on unseen future files. A
  trade stamped after the window ends but received before it sits in a file the
  next window does not read, so it stops decoding
  (`TARDIS_EXCHANGE_TIME_CROSSES_WINDOW_END`) instead of being dropped. Every file's row count and
  the rows kept, before and after the window are recorded in the checkpoint
  (`stream_counts`).
- **Order and lineage.** `stable_position` is the row's arrival index across the
  stream, so rows with the same timestamp keep arrival order across the file
  boundary. `lineage` names the row's own file and its row in that file. A
  partition's manifest lists every file that contributed to its date.
- **Every day file, exactly once.** The driver refuses a month when any day file
  from its first day through the day after its last is missing or duplicated.
  An exchange day with no rows also stops the job before publication. Discovery
  must cover the full owner window; it cannot silently shorten it. The date
  window is part of the checkpoint identity.
- **Identity and time.** Records map to the same `BINANCE` instruments as the
  served candles. Binance trades carry the exchange trade time (`EXCHANGE`):
  microseconds for spot, milliseconds for perpetual. Tardis's receive clock
  lags the exchange in short episodes (measured up to 10.2 ms, on four dates
  from 2025-09 to 2026-08, on every series at once). A row whose exchange time is
  up to 50 ms after its receive time keeps the exchange label, keeps both raw
  times and carries `RECEIVE_BEFORE_EXCHANGE_TIME`. A row more than 50 ms after
  its receive time, or a sub-millisecond perpetual time, is quarantined.
- **Where it goes.** `curated/binance` in S3, converter catalog
  `/srv/terminal-data/curated-binance/_catalog`, staging
  `/srv/terminal-data/binance-staging`, unit `terminal-backfill-binance@<phase>`
  (pool 4). The served Binance catalog is `curated/binance/_historical`,
  reconciled from the converter catalog as for Databento.
- **Ticks.** `config/archive-crypto-ticks.json` is read by `trade_families.CRYPTO_TICK_BY_INSTRUMENT`, the archive study gateway and the browser: spot 0.01; perpetual
  BTCUSDT 0.1, ETHUSDT 0.01 (Binance exchangeInfo).

## Conditional S3 publication

A cumulative catalog carries every partition ever published under it, and
publication re-verifies each one against its remote object. That is one S3
round trip per partition, so it runs on a bounded pool (8 by default, 16 at
most, `bundle(..., verification_workers=N)`). Serially it reached 45 minutes
per symbol-month at 4,494 partitions -- twenty times the cost of converting the
month being published -- and it grows with the catalog, not with the work.

`s3_publish.py --curated-root <root> --intent <root>/_catalog/intent-<version>.json --bucket <bucket> --prefix curated/<namespace>` publishes a completed local catalog and all referenced artifacts. Use a dedicated qualification namespace first. The local intent's parent must be the remote parent used to build the cumulative catalog. A mismatch stops publication; refreshing the ETag alone is not a valid rebase.

The publisher verifies local manifest/part hashes and validation flags, uploads immutable objects with `If-None-Match: *`, and reads them back to verify SHA-256. It changes `_catalog/CURRENT.json` last, using the original parent's ETag with `If-Match` (or an absent-object condition for first publication). An immutable intent and receipt support retries. Retrying an older completed publication returns its receipt without moving CURRENT backwards. An interrupted writer whose parent has since changed fails closed and requires reconciliation.

Credentials come from the protected `RCLONE_CONFIG_TTCONVERT_*` environment settings; credentials are never CLI arguments. No raw objects are written or deleted. Single objects above 5,000,000,000 bytes fail rather than silently using an unconditional multipart upload. Current manifests use smaller partition files. This SDK mechanism does not itself prove IAM least privilege, reader integration, or remote recovery acceptance; these require separate host evidence. Readers resolve `catalog_key` under `<namespace>/_catalog/` and partition prefixes relative to `<namespace>/`.

AWS conditional-write semantics: https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html

## A6 Binance qualification

`binance_qualification.py` is the one-purpose A6 gate for the fixed four-product,
twelve-month 1-minute scope: BTCUSDT and ETHUSDT spot plus USD-M perpetual from
2025-09 through 2026-08. It is not a general downloader and it never accepts an
operator-supplied source URL. Before it creates a curated object it obtains the
provider's exact ZIP and `.CHECKSUM`, validates the full UTC minute grid, stores a
checksum-addressed raw candidate and immutable receipt, converts all 48 sources,
and reconciles the resulting catalog through the normal archive reader.

Use a new `run-id`, a new `qual-...` dataset version and an empty local work root.
The curated destination is mechanically limited to
`curated/_qualification/<run-id>` and the command refuses both a pre-existing
`CURRENT` and any orphan object in that prefix. It cannot select the production
namespace. A failed run leaves `evidence.json` in its work root; do not reuse that
root or qualification prefix for a new attempt.

The command requires two temporary IAM identities. They are separate from the
long-lived converter and query identities:

| Environment prefix | Minimum bucket permission | Permitted key scope |
| --- | --- | --- |
| `TT_A6_RAW_S3` | `GetObject`, `PutObject` | `raw/binance/*` only |
| `TT_A6_QUALIFICATION_S3` | `GetObject`, `PutObject`, `ListBucket` | `curated/_qualification/<run-id>/*` only; the list condition must use that prefix |

Neither identity needs `DeleteObject`; neither may write `curated/databento`,
`curated/binance`, any other production prefix, or a bucket policy. Credentials
come only from protected environment variables, never arguments or an evidence
file. `--bucket` is an identifier, not a credential.

From this directory, after selecting the exact Node release pinned by `.nvmrc`:

```bash
uv run --frozen python binance_qualification.py \
  --run-id a6-20260915-01 \
  --dataset-version qual-binance-a6-20260915-01 \
  --work-root /srv/terminal-data/qualification/a6-20260915-01 \
  --bucket <bucket> \
  --node-bin /absolute/path/to/node-24.21.0
```

The output and `evidence.json` must both report `"status": "PASS"`. Review the
48 source receipts, 4 × 525,600 source/output row reconciliation, 1,460
partitions, remote catalog hash, ordinary-reader digest and Node release before
authorising a separate production publication. A `FAIL` result is evidence to
diagnose, never a partially-qualified archive to promote.
