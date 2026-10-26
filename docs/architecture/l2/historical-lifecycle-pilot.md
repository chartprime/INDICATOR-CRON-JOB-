# Historical level and lifecycle pilot

**Status:** complete-day ES/NQ/AAPL/TSLA output, independent full-source and every-state checks, strict read measurements and pinned local descriptors pass for 2026-08-05. Monthly publication and Replay restoration remain unqualified.

## Observations and identity

`historical-level-events.js` observes the existing engine after each accepted source input and scheduled prune. It adds seeded levels, every observed size change, quote changes, lifecycle starts, observation endings and changed engine level views to the engine's original events. The live engine is unchanged.

The admitted profile is Databento top-ten depth with integer quantities and one price per engine key. Source prices, four-field order keys and nanoseconds remain decimal strings. Engine ratios and statistics retain their explicitly labelled numeric representation. Crypto fractional quantities are not supported by this profile.

| Identity | Source anchor |
|---|---|
| Segment | Schema, derivation, instrument and trusted seed key |
| Observation | Segment, side, price key and first observed input key |
| Lifecycle | Observation and this wall cycle's first input key |
| Event | Segment and contiguous append sequence |

An observation may contain several empty/refill cycles. Refills receive new lifecycle IDs and reference the previous cycle. Engine counters belong to the observation record, not just the newest cycle. The engine's persistent seeded flag and previous ending do not determine the new cycle's age or outcome.

Initial seeds and levels entering from beyond observed depth have unknown prior age. A depth exit ends observation without inventing a zero or a fill/pull verdict. A returning price receives a new observation ID. Record expiry is explicit. Gaps and EOF close outstanding observations with unresolved endings retained; EOF does not force a prune or final verdict.

Trades at an unobserved resting level retain unknown resting evidence. Once a record includes that gap, `record_evidence_gap` remains true through its later refills. Its cumulative metrics cannot become trustworthy merely because the price later becomes visible. Consumers must honor this flag as well as individual event quality.

## Time and capture

Each row records its source cursor, exact knowledge time, engine observation clock and original engine sequence when applicable. Later verdicts are appended against the ended lifecycle. Reads before that knowledge time exclude them.

The caller must report each actual prune through `pruned=true`; this captures changes and expirations at otherwise untouched levels. A standalone prune keeps the last source cursor but uses its actual later knowledge time. It must not borrow a future source cursor. Quote changes allow a consumer to derive current distances; stored engine views alone are not complete engine restoration state.

Overflow, missed engine events, source/knowledge regression, book disagreement or invalid engine geometry poison the observer. A failed observer cannot resume or seal its output. Each successful capture is a bounded immutable batch.

## Local parts and reads

`conversion/historical_l2_lifecycles.py` writes `historical-l2-level-event/1` to multipart Parquet with typed indexed fields and structured JSON payloads. It validates event and original engine sequences, source-anchored genealogy, size continuity, price/key geometry, evidence gaps and terminal observation/segment closure across parts. Existing output directories are refused. The manifest is sealed last and pins writer code, DuckDB version and every part's hash/count/bytes.

| Limit | Local diagnostic setting |
|---|---:|
| Tracked observations | 8,192 |
| Capture rows / bytes | 20,000 / 8 MiB default |
| Event or payload size | 16 KiB |
| Stored rows / parts / segments | 100,000,000 / 1,024 / 1,024 |
| Part rows / encoded bytes / decoded bytes | 100,000 / 16 MiB / 128 MiB |
| Read interval / scan bytes | 1 hour / 64 MiB |
| Read output | 20,000 rows / 4 MiB |
| DuckDB memory / threads / spill | 128 MB / 1 / 256 MB |

Readers pin the manifest, verify selected objects and footer counts, filter both knowledge time and exact source key, then recheck integrity before returning. Response bytes include compact JSON array brackets and commas, including an empty response. Cancellation and overflow return no partial result. These reads return event updates; they do not assemble an indicator view or restore an engine. Limits are admission bounds, not measured production defaults.

## Combined diagnostic producer

`verify-historical-lifecycle-pilot.js` produces events and one-second state/coverage from the same retained ES/NQ native examples, sharing derivation and segment IDs. Independent checks compare every source size change, final books and trade volumes. Tests also cover delayed and forced verdicts, refills, depth exits, unknown resting evidence, cancellation and malformed output.

`derive_historical_cme_core.py` and `derive-historical-cme-core.js` are the complete-day diagnostic candidate. Admission requires local raw and canonical depth hashes plus a pinned successful native-order flow report. Native Trade records must repeat the preceding book; unknown direction is preserved. Knowledge time is the high-water mark of event and receive times, as pinned in the derivation identity. Crossed books close the old engine; re-established books start fresh.

Native and canonical source admission refuses `MAYBE_BAD_BOOK` and `BAD_TS_RECV`, including a flagged first record or reset. These flags require separate gap or receive-clock qualification; the pilot cannot manufacture trust by replacing them with `OK`. The guard also applies when equity rows are streamed from a previously checked native/canonical receipt. [Databento DBN flags](https://github.com/databento/dbn/blob/main/rust/dbn/src/flags.rs).

The only receive-clock exception is a first native Add snapshot preceding the requested day, marked `SNAPSHOT`, with its synthetic receive timestamp exactly at the day boundary. The normalizer uses its book solely to check a later Trade echo; it emits no seed row and borrows neither that clock nor prior wall age. `MAYBE_BAD_BOOK` is still refused. A flagged in-day snapshot, reset or later record receives no exception.

The pipeline uses bounded pipes and backpressure with a separate process for each writer. This allows decoding and both writers to use separate CPU cores. Each writer retains its existing schema, genealogy, part and memory checks. A 25,000-row native NQ comparison produced identical part and manifest hashes in both execution paths: 62.359 seconds with threaded writers and 37.219 seconds with process writers. This is a local prefix measurement, not a full-day or host throughput claim.

Admission requires 40 GiB free disk and caps streamed JSON at 128 GiB. JSON passes through pipes and is not retained as a complete file. Each stored family admits at most 1,024 parts of 16 MiB; the disk requirement covers that encoded bound and working reserve. Budgets and writer code are pinned in the derivation identity. Progress reports source rows, delivered family counts, JSON bytes, elapsed time and Node peak RSS. Source/book/flow totals must agree with the accepted day before either writer receives EOF. Writer failure, malformed output or cancellation terminates the other processes. Only `result.json` declares successful combined completion; an individual family manifest is insufficient. Failed or stopped runs cannot be published.

`derive_historical_equity_core.py` version 2 uses quote-confirmed first-depth trade anchors and requires a complete native-order receipt from `verify_historical_equity_native.py`. That receipt compares every retained MBP-10 row's position, event/receive times, sequence, flags and full book with the canonical archive, and every native Trade with the independent L1 anchor. A matched Trade that repeats the preceding book observes it without settling pending fills. A Trade carrying a changed book applies that retained change before its new print. Add/Cancel/Modify book updates still settle normally. The CME rule requiring every Trade to repeat the book cannot be applied to equities.

This distinction is required by retained Nasdaq data: the AAPL pilot contains 63,984 changed Trade books. Raw witnesses show a later Trade carrying the reduction from an earlier execution. Databento documents Nasdaq execution normalization as Trade/Fill/Cancel and shared sequence numbers within one upstream message; the exact MBP-10 ordering is checked against the retained file rather than inferred from that MBO description. [Nasdaq normalization](https://databento.com/docs/knowledge-base/datasets/xnas-itch).

Version 1 treated repeated equity Trade books as ordinary deltas and could prematurely classify pending prints as hidden. Its output is diagnostic and is refused by candidate preparation. Unknown-direction half-cent prints contribute only to unknown interval volume; they are not rounded or assigned to a price level. Known-direction prints still require exact book-grid prices.

`check_historical_core_day.py` walks the pinned source again with independent Python accounting. It compares every size change, depth exit, known-side print, visible/hidden conservation, unexplained reduction and delayed/forced verdict against stored events and views. Knowledge timestamps must match the source receive-time high-water mark. State flow, unknown/outside counts, family totals, hashes and footer/time bounds must also reconcile. The receipt names the exact combined result and checker revision. The checker pins its code before work and refuses a change before sealing the receipt. It proves model accounting over observed depth, not individual order cancellation truth.

`check_historical_state_cuts.py` then independently assembles the book at every stored second's exact source cursor from those source-qualified events. Every state level, observed range, trusted segment, known-side price volume and directional total must agree. Evidence cannot precede its knowledge bound, and level rows must share their coverage row's exact cursor and knowledge time. Missing or duplicated level rows are refused even when day totals agree. Unknown-direction and outside-trust flow remain independently reconciled by day; this check does not invent their price or direction. Both receipts are required by candidate preparation.

`historical_l2_coverage.py` keeps single/empty snapshot sources unavailable, even if their trade family is present. ES/NQ August 2 each contain one late snapshot alongside 12,706/14,458 trades. Their L2 days require repair or explicit exclusion; existing candles and L1 are unaffected. Its source-presence result stays conservative: `AWAITING_FULL_DAY_QUALIFICATION` records preflight admission. Separate pinned source/state receipts establish local qualification; the published catalog will declare serving availability.

`prepare_historical_core_candidate.py` builds a local descriptor only after the combined output, full-source receipt and every-state receipt agree. It pins the source catalog, manifests, units, derivation, output objects and verification receipts. Object keys use `curated/l2-core/databento/instrument=<sha256>/derivation=<sha256>/date=<UTC-date>/<events|states>/`. States contain both one-second level rows and explicit book segments. The descriptor is marked `LOCAL_VERIFIED; NOT_PUBLISHED`; its `source_admission` retains the preflight source-presence result with `available=false`. Uploaded object and descriptor verification, catalog publication and rollback remain separate release work.

`bench_historical_core_reads.py` measures authenticated 1/10/60-second reads at beginning/middle/end part boundaries, retaining refusals. Results include selected compressed part bytes, response size and median/maximum timings. The scan budget counts admitted parts, not total operating-system I/O; authentication and integrity rechecks can read those bytes more than once. OS cache state is uncontrolled, so these are local measurements rather than cold-read or host latency claims.

The four encoded days pass independent source/state checks and strict read measurements. Dense event windows are refused rather than truncated; Historical Mode must supply bounded event pages where admission is exceeded. The [output contract](historical-core-contract.md) records measured sizes and the separate complete-state checkpoint requirement. Host throughput, monthly estimates, publication and Historical L2 enablement require their later release gates.

Related: [compact output contract](historical-core-contract.md), [one-second state](historical-second-pilot.md), [earlier engine-event pilot](historical-event-pilot.md).
