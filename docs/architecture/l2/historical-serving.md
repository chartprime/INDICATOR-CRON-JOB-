# Historical L2 serving

Status: historical inputs and wiring for all 12 L2 menu entries are implemented. Real-data qualification covers four wall/individual-trade index days. Wider-view performance, full index coverage, visual acceptance and reviewed production activation remain open.

## Data path and scope

Qualified source → immutable events and one-second states → verified S3 release → authenticated gateway → isolated reader → validated browser pages → historical indicator inputs.

The published `curated/l2-core/` release covers 92 August 2026 ESU6/NQU6/AAPL/TSLA days, with 32 explicitly unavailable dates. It contains top-ten observations, not the full order book. A missing level inside an observed price range is zero; depth outside that range remains unknown. States represent the book at interval close, not time-weighted average liquidity. Top-ten exits do not prove cancellation.

`candidate.json` remains immutable local-verification evidence. Publication requires the authenticated release catalog to reference its exact descriptor bytes and hash. Candle/L1 publication and the existing `archive-query/1` API remain separate.

Wall and individual-trade indexes are protected, operator-admitted files bound to that release. Qualified pilot dates are **ES/NQ/TSLA August 5 and AAPL August 3**. Their qualification does not imply index coverage for all 92 days. Discovery advertises each optional family only for its admitted instrument-day.

## API

Send bearer-authenticated POST requests to `/archive/l2` using `historical-l2-query/1`. The Node gateway derives a viewer identity and forwards that identity and the private service secret to the loopback Python reader. The L2 reader receives no viewer credential and reads only declared objects; it neither lists bucket prefixes nor accepts raw paths from clients.

```json
{"contractVersion":"historical-l2-query/1","operation":"catalog"}
```

The catalog contains a viewer-bound `snapshotToken`, immutable `releaseId`, all date dispositions, depth limit, inference disclaimer and admitted optional indexes. Tokens expire after 15 minutes and belong to one reader process: restart requires discovery. Limits are 128 snapshots globally and four distinct releases per viewer. Repeated discovery reuses the viewer's unexpired token for the same release.

| Page field | Meaning |
|---|---|
| `operation` | `page` |
| `snapshotToken` | Previously issued viewer token |
| `instrumentId`, `date` | Exact catalog identity and UTC day |
| `family` | `states`, `events`, `walls` or `prints` |
| `from`, `to` | Decimal-string knowledge times; half-open interval |
| `asOfKey` | Four decimal strings: source time, rank, position, ordinal |
| `limit` | 1–10,000; default 1,000 |
| `cursor` | Optional signed continuation; at most 512 characters |
| `maxScanBytes` | Selected compressed-part budget; at most 64 MiB |

A request spans at most one hour within one UTC day, including its single terminal boundary instant. Both knowledge time and accepted source prefix constrain returned evidence. Each continuation binds viewer, release, snapshot, identity, family, window, cuts and scan budget. Page size can change. A page is at most 4 MiB including metadata; intermediate empty pages can advance over excluded records. Completion is `nextCursor: null`. Numeric append positions preserve timestamp ties.

## Integrity and failure behavior

- Verify pointer → release → descriptor → manifest → parts with exact lengths and SHA-256. Validate identity, units, tick size, schema, counts, ordering, bounds and inventory.
- Admit cache paths only from authenticated manifests and retain pins until readers close their files. Rehash warm parts around reads. Optional indexes additionally require protected registry hashes and matching release, descriptor, event manifest and profile/source identities.
- Preserve nanoseconds as strings and reject inexact engine integers. Index readers enforce exact knowledge/source cuts, bounded decompression and manifest positions.
- Reuse archive admission, cancellation, worker isolation and bounded framing. Two DuckDB workers have 128 MiB each, one thread, 256 MiB temporary disk and a 30-second response deadline. HTTP admission uses a rolling per-viewer limit, not a strict one-request-per-second rule.
- Cursor tampering fails before part reads. Corruption fails the selected L2 day atomically. Missing coverage, storage failure, cancellation and reader failure have explicit errors.
- Browser state loading consumes at most 128 pages and 100,000 rows and folds into bounded display columns. Retained client windows default to 32 MiB; explicit qualification uses at most 64 MiB. The loader bounds wall history to 64 MiB/14,400 records and individual trades to 32 MiB/100,000 records.
- Panning is debounced; obsolete requests are cancelled. Previous inputs are cleared and a new window is installed only after all required families pass. Snapshot expiry permits one discovery/full-window restart; partial data and cursors are discarded. Different releases cannot be combined.

## Wall and individual-trade indexes

`historical-wall-profile.js` canonicalizes cadence, geometry, fold and tracker settings into a SHA-256 identity. Changed settings cannot reuse it. Version-2 wall views and stream proofs carry this profile. Version-1 pilot artifacts remain evidence, not valid input to the indexed path.

The wall stream consumes the complete authenticated event prefix, keeps timestamp ties together, advances quiet seconds and resets at segment closure. Sampling occurs before later records are applied. The index retains causal samples, lifecycle/trade deltas and explicit closures without sampling gaps. Attributed wall trades are engine inference; they are never substituted for individual source prints.

The wall writer creates a fresh directory, exclusively writes and syncs minute gzip parts, rereads their bounded bytes/hashes, and exposes a manifest only after complete input-count and closure proof. Limits are 4 MiB decoded per part, 4,096 parts and 256 MiB compressed per day. Failed attempts remain provisional. Linux directory entries are synced; Windows power-loss durability is unproven.

Individual-print indexes retain original classified `BUY`, `SELL` and `UNKNOWN` source records, price/size, exact times, ordering key and native identity. CME IDs bind the original DBN hash and record position; equity IDs retain their source hash identity. Count/side-volume reconciliation and source hashes bind the completed manifest. Parts use exclusive writes and file sync, followed by atomic manifest replacement and Linux directory sync. Limits include 10,000 rows/4 MiB decoded per part, 4,096 parts, ten million prints and 256 MiB compressed per day. Off-tick source prices are preserved. Unknown direction is reported and excluded from side-dependent models.

Qualified fixed wall profiles use 1,000 ms sampling, one row per cluster, max fold, multiplier 3 and minimum size **40 contracts** or **800 shares**. Client display filters can narrow admitted results; they cannot recover walls below the indexed floor or silently change detector geometry. The profile and loaded population are exposed in status. Arbitrary detector settings need their own qualification.

## Historical chart inputs

All selected indicators share one verified load. Select an available UTC day and a visible window of at most one hour. Depth, wall history and prints request up to ten preceding minutes within the same day/contract. Loaded history is explicitly bounded; it does not claim the entire earlier session.

| Menu entries | Required admitted inputs |
|---|---|
| Book Map, Passive Liquidity Heatmap, Book Profile, Institutional Order Blocks, Liquidity Voids, Empty Orderbook, Feed Status | Candles and depth states |
| Support & Resistance, Institutional Order Blocks v2, Whale Limit Order Heatmap | Candles, depth and qualified walls |
| Aggressive Orders | Candles and qualified individual prints |
| Absorption Detector | Candles, depth and qualified individual prints |

SDK accessors cut information at each bar's close using knowledge time, precomputed bounds and binary searches. A cut view cannot expand; invalid cuts return no input. Rolling liquidity evidence uses only the latest uninterrupted segment: gaps, partial/missing seconds and segment changes reset it. Unknown cells remain `NaN`. Historical freshness, verdicts and drawing use the logical chart clock; live timers/history requests cannot alter archive results.

The shared grid is read-only. Contract/share units and ES/NQ contract multipliers are preserved, including wall notional. Prints known after a column's close cannot amend that earlier column. Source direction remains unknown where unclassified. Historical mode installs/withdraws book, grid, wall and tape inputs together; live frames cannot overwrite them. Switching back restores the existing live path.

Book Map reports **HISTORICAL TOP10 1s CLOSE** and omits unknown/untrusted cells. Feed Status describes retained archive observations at chart time, without claiming live freshness. Wall studies disclose the indexed detector floor and loaded history. An unqualified optional family keeps dependent studies unavailable rather than showing empty successful output.

## Operation and verification

Run `historical_l2_http.py --bucket ... --cache-root ...` with the protected `TT_QUERY_SERVICE_SECRET` and `TT_QUERY_S3_*` environment. Default binding is loopback port 8004. Optional wall inputs require both `--wall-index-root` and `--wall-index-registry`; prints require both `--print-index-root` and `--print-index-registry`. Registry hashes and paths are operator-controlled, never browser-supplied. Configure the gateway's optional `TT_L2_ARCHIVE_SERVICE_URL` only after reviewed qualification.

Verification tools in `scripts/verify/databento/` cover native wall replay, original-source print derivation, registry preparation, actual authenticated gateway paging and independent full-index comparisons. `verify_historical_index_pages.py` reads every sealed part independently and compares all selected wall/print payload fields with captured pages. Qualification leaves production services and S3 data unchanged.

`historicalL2Qualification.test.ts` admits real captured API pages through the production browser codec and shared models when `TT_HISTORICAL_L2_CAPTURE` is set. Normal CI skips these external-data cases. Its compatibility bars are synthetic, explicitly separate from provider OHLCV and GUI evidence. Runtime timing is not network latency or canvas frame time. Review requires actual cold/warm loading, panning, settings changes, memory and combined rendering alongside real candles/L1.

The isolated `serve-historical-l2-preview.js` uses a dedicated loopback gateway, the qualified reader and authenticated candle/L1 relay. It does not activate the production route or grant SSH forwarding. See the [activation and rollback procedure](../../operations/10-historical-l2-service.md).
