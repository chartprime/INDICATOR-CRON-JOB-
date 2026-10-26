# Historical L2 state and coverage pilot

**Status:** complete-day output, independent source and every-state checks, strict read measurements and local descriptors pass for ES, NQ, AAPL and TSLA on 2026-08-05. No publication, catalog entry or terminal enablement.

## Output

`historical-second-sampler.js` consumes qualified, source-ordered book observations and trades. The Databento profile uses exact decimal price/tick strings and positive integer quantities. It emits `historical-l2-second/1` rows in two families:

| Family | Content |
|---|---|
| `l2_level_state_1s` | Explicit interval coverage, the last observed book, known-side volume per price, unknown volume/count and trades outside trust |
| `l2_book_segment` | Ordered open/close records for trusted and unavailable intervals, plus a required final window closure |

Seconds use `[open_ns, close_ns)`. A trade exactly at the boundary belongs to the next second. Receipt delays constrain knowledge time. Readers filter both exact knowledge time and the four-field source cursor. Initial unavailable coverage has no source cursor; trusted output has an anchored segment ID. Unavailable intervals use `segment_id=null`; their boundary records have stable derivation/instrument/append IDs. This pilot does not yet supply the complete segment lineage required for publication.

Within each side's observed price range, zero means observed empty. Outside it, size is null. Unknown-side trades are not allocated to prices. Known-side trades beyond observed depth remain flow with unknown resting size. Segment changes separate all accumulated flow. A reset at the same nanosecond may emit a zero-duration `point_prefix` for trades ordered before the reset; that record is never a complete second.

A suspected source gap ends trusted coverage one nanosecond after the last verified observation, with explicit unavailable coverage before the next seed. EOF follows the same conservative rule and does not carry the final book through an unverified tail. The caller must qualify source continuity, reset admission and source identities before calling the sampler. A quiet period between accepted observations is not itself a provider completeness proof.

## Local storage and reads

`conversion/historical_l2_seconds.py` validates interval continuity, trusted book bounds, price ordering, flow sums, stable IDs and knowledge order across part boundaries. It requires coverage through the terminal window closure. Missing book rows, truncated generators and trailing rows after closure prevent the manifest from being sealed.

Parts use explicit Parquet columns, Zstandard compression and global append positions. The manifest is written last and records every part's bytes, hash, rows and knowledge bounds, plus the writer hash and DuckDB version. Existing directories are refused. Failed output remains incomplete and is never read as a completed partition.

| Limit | Pilot setting |
|---|---:|
| Source window | At most one UTC day of duration |
| Observed depth / distinct traded prices per second | 10 per side / 4,096 |
| Total rows / parts | 3,000,000 / 1,024 |
| Part rows / compressed bytes / decoded bytes | 100,000 / 16 MiB / 128 MiB |
| Payload | 16 KiB per row |
| Read window / scan bytes | 1 hour / 64 MiB |
| Read output | 20,000 rows / 4 MiB |
| DuckDB memory / threads / spill | 128 MB / 1 / 256 MB |

Reads require a manifest hash, verify selected object hashes and footer counts, enforce output limits and support cancellation without returning a partial result. Response bytes include compact JSON array brackets and commas, including an empty response. Object and manifest hashes are checked again before returning. They return updates known within the requested interval; they do not assemble a complete chart view or restore an engine. These limits are pilot admission bounds, not measured production defaults.

## Verification and remaining work

`verify-historical-second-pilot.js` pins the native fixture, raw hashes, producer/engine/adapter code, geometry and prune cadence. Tests independently compare its stored final books and trade totals to the retained source records. They also exercise multi-part reads, half-open boundaries, delayed receipts, exact cursor cutoffs, same-time resets, missing rows, cancellation, corruption and resource refusal.

The [combined output](historical-core-contract.md) includes lifecycle observations and shared derivation/segment IDs. All four pilot days pass independent complete-day source accounting and every stored second's book, known-side price flow and knowledge checks. Every sampled state window in the four strict read benchmarks passes. Crypto, full-month release and exact Replay remain separate gates; local pilot measurements are not host performance or monthly size estimates.

Related: [compact output target](historical-core-contract.md), [engine-event pilot](historical-event-pilot.md), [source qualification](historical-topn-input.md).
