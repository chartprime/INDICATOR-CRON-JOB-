# Historical equity flow pilot

`apps/runtime/scripts/verify/databento/verify_historical_equity_flow.py` tests a candidate merge of retained XNAS.ITCH `mbp-10` depth and `mbp-1` trades. It is a local qualification tool; it does not publish L2 core rows, change a catalog or enable Historical Mode.

## Admission and order

All three depth/trade/quote plans and their parts must pass the existing local manifest, byte and SHA-256 admission. Each family is limited to 256 MiB compressed. Decoded row counts must agree with the pinned catalog. Quote and trade authorities share an instrument, date and dataset version.

The [trade-time quote check](historical-topn-input.md) must give every trade one lineage-matched quote and one matching first depth candidate, including BBO prices/sizes and source flags. Retained event and receive times must not regress in source order; duplicate trade identities are refused. This candidate supports only publisher 2, XNAS.ITCH, unmodified valid `NEW`/`T` trades, positive integer shares and exact-integer-range volume. A CME or crypto source needs its own qualification; it cannot reuse this rule silently.

The pilot observes the first matching depth record, applies its known-side trade, then processes remaining depth records in exact archive order. Anchors retain exchange nanoseconds and the four-field archive key; millisecond flooring happens only at the current engine boundary. An ambiguous or missing anchor is refused before starting the engine. The same engine and top-N adapter process the complete day, including source boundaries and one-sided intervals.

## Independent checks

- Every trusted engine ladder must match all observed levels in its canonical source snapshot, including after trades.
- Observed BUY, SELL and UNKNOWN counts and shares reconcile to independent DuckDB sums over the trade authority.
- UNKNOWN prints stay in their own observed totals and never receive a guessed aggressor side. Trades outside a trusted segment are counted separately and never injected into a later seed.
- At UTC minute ends and segment ends, DuckDB independently sums known-side trades within the exact accepted source-key range and `(sample_ms - 60000, sample_ms]`. Buy/sell shares and trade counts must match the engine's 60-second flow window.
- Accepted trade counts and outside-trust totals independently reconcile against the segment key ranges. Each applied print must drain exactly once with its original identity and size.

This proves directional flow accounting for the admitted partition and candidate order. It does **not** prove fill/pull attribution, hidden liquidity, wall verdicts, venue completeness, or full-depth equivalence from the BBO comparison. Rolling flow totals alone cannot distinguish two orders with identical trades. Those lifecycle checks remain separate gates before the compact core is published.

## Resources and reports

The runner uses one DuckDB worker, a 256 MB DuckDB memory limit, a unique temporary spill directory and one persistent Node worker. It sorts disjoint verified parts separately, drains trade prints, and retains the engine across parts. At most 10,000 flow samples and a 4 MiB worker report are admitted. Resource measurements are local qualification costs, not a host backfill ETA.

Run with the provisioned Python 3.12 conversion environment, `-X faulthandler`, and an explicit Node 24.21.0 executable. Required options are `--depth-plan`, `--trade-plan`, `--quote-plan`, `--tick-size` and `--node`. Use `--output` for the completed report and `--worker-report` for a diagnostic worker result. Both are separate JSON files next to the ignored pilot plans; neither can overwrite a source plan.

The worker report is explicitly `UNRECONCILED`. A complete pass requires a successful runner exit and the final report after independent reconciliation. Phase markers distinguish source admission, Node completion and reference completion. An interrupted attempt or worker report alone is not acceptance evidence. Final report time stops at the final source record; the pilot does not advance beyond it to force a terminal wall verdict.
