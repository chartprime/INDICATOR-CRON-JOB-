# Databento Historical Data Entitlement v1

Real entitlement for the account backing `databento_key`, per-symbol, exact
dates. Produced by `apps/runtime/scripts/verify/databento/verify-databento-entitlement.js`
(metadata-only, cannot incur cost). Raw evidence:
`databento-entitlement-boundaries.json`. Datasets: `GLBX.MDP3` (ES, NQ),
`XNAS.ITCH` (AAPL, TSLA).

## As of 2026-09-06 — what's actually free right now

| Schema | Futures (ES, NQ) | Equities (AAPL, TSLA) | Is this permanent? |
|---|---|---|---|
| `ohlcv-1s`, `definition`, `statistics`, `status` | free | free | **Yes** — free every day tested, dataset start to now. |
| `mbp-1` / `tbbo` / `trades` (L1) | free | free (since 2025-09-04) | Futures: **yes, permanent.** Equities: **no** — this schema cycles between paid (9mo–3.5yr stretches) and free; it will go paid again. |
| `mbo` / `mbp-10` (L2/L3) | free (since 2026-08-04) | free (since 2026-07-03) | **No, for both.** Normally paid most of the year, with short (~8-9 day) free windows; the current window is already longer than the historical pattern. |

**The one durable fact: futures L1 (`mbp-1`/`tbbo`/`trades`, ES & NQ) plus the
4 reference schemas are the only real, permanent entitlements.** Everything
else being free today is a snapshot of where the account happens to sit in a
real, moving cycle — not a standing rule. If it's been more than a few weeks,
re-run `verify-databento-entitlement.js` before relying on this table for a
decision.

## Full history, every period found — `always free` schemas

| Schema | ES | NQ | AAPL | TSLA |
|---|---|---|---|---|
| `ohlcv-1s` | free | free | free | free |
| `definition` | free | free | free | free |
| `statistics` | free | free | free | free |
| `status` | free | free | free | free |
| `mbp-1` | free | free | see below | see below |
| `tbbo` | free | free | see below | see below |
| `trades` | free | free | see below | see below |

Futures `mbp-1`/`tbbo`/`trades`: confirmed free across the full dataset
history (2010–2026), no exceptions, both symbols.

## GLBX.MDP3 (ES, NQ) — `mbo` / `mbp-10` paid periods

Free everywhere not listed, including currently (2026-08-04 onward).

| # | Paid period | ES `mbo` $/day | ES `mbp-10` $/day | NQ `mbo` $/day | NQ `mbp-10` $/day |
|---|---|---|---|---|---|
| 1 | 2010-07-25 – 2017-02-03 (`mbp-10` only — predates `mbo`'s own 2017-05-21 start) | — | 0.43 | — | 0.29 |
| 2 | 2017-05-21 – 2022-11-04 | 1.92 | 2.77 | 1.55 | 2.07 |
| 3 | 2022-11-13 – 2024-10-04 | 1.02 | 1.44 | 1.31 | 1.83 |
| 4 | 2024-10-13 – 2025-09-12 | 0.57 | 0.82 | 0.85 | 1.27 |
| 5 | 2025-09-21 – 2026-08-03 | 1.01 | 1.41 | 2.02 | 2.98 |

Free gaps between paid periods are short (8-9 days each): 2022-11-05→12,
2024-10-05→12, 2025-09-13→20.

## XNAS.ITCH (AAPL, TSLA) — `mbo` / `mbp-10` paid periods

Same calendar for both schemas. Free everywhere not listed, including
currently (2026-07-03 onward).

| # | Paid period | AAPL `mbo` $/day | AAPL `mbp-10` $/day | TSLA `mbo` $/day | TSLA `mbp-10` $/day |
|---|---|---|---|---|---|
| 1 | 2018-07-16 – 2022-01-07 | 0.31 | 0.50 | 0.25 | 0.24 |
| 2 | 2023-01-09 – 2023-10-13 | 0.31 | 0.33 | 0.70 | 0.40 |
| 3 | 2023-12-11 – 2024-10-04 | 0.37 | 0.33 | 0.51 | 0.38 |
| 4 | 2024-12-09 – 2025-09-12 | 0.28 | 0.21 | 0.71 | 0.54 |
| 5 | 2025-09-22 – 2025-10-17 | 0.40 | 0.26 | 0.43 | 0.40 |
| 6 | 2025-11-24 – 2026-07-02 | 0.75 | 0.45 | 0.44 | 0.39 |

Free gaps: 2022-01-08→2023-01-08, 2023-10-14→12-10, 2024-10-05→12-08,
2025-09-13→09-21, 2025-10-18→11-23.

## XNAS.ITCH (AAPL, TSLA) — `mbp-1` / `tbbo` / `trades` paid periods

Same calendar across all three schemas. Free everywhere not listed,
including currently (2025-09-04 onward — the longest free stretch found,
still ongoing).

| # | Paid period | AAPL `mbp-1` | AAPL `tbbo` | AAPL `trades` | TSLA `mbp-1` | TSLA `tbbo` | TSLA `trades` |
|---|---|---|---|---|---|---|---|
| 1 | 2018-07-16 – 2022-01-07 | 0.20 | 0.06 | 0.04 | 0.07 | 0.08 | 0.05 |
| 2 | 2023-01-09 – 2023-10-13 | 0.14 | 0.04 | 0.02 | 0.13 | 0.08 | 0.05 |
| 3 | 2023-12-11 – 2024-10-04 | 0.12 | 0.05 | 0.03 | 0.11 | 0.10 | 0.06 |
| 4 | 2024-12-09 – 2025-09-03 | 0.10 | 0.10 | 0.06 | 0.18 | 0.14 | 0.08 |

($/day figures above)

## Pattern

Paid periods for `mbo`/`mbp-10` recur roughly annually as long stretches
broken by short (8-9 day) free windows; the paid stretches have been
shrinking each cycle (5.5 years → 23 months → 11 months → 10.5 months,
GLBX). XNAS's `mbp-1`/`tbbo`/`trades` show fewer, longer free windows and
have been continuously free since 2025-09-03. Exact mechanism not confirmed
(plausibly a recurring exchange billing/settlement cycle) — dates and costs
above are real measurements, not a model.

## Trades vs. MBP-1

`trades` is trade prints only. `mbp-1` is best bid/ask plus trade prints,
interleaved, distinguished by an `action` field per record — a superset of
`trades`, confirmed from real decoded sample data (see
`apps/runtime/data/historical/databento/samples/`).

## Files

- `apps/runtime/scripts/verify/databento/verify-databento-entitlement.js` — produces this evidence; free, safe to re-run.
- `apps/runtime/scripts/verify/databento/verify-databento-content.js` — real per-schema field shapes and sample data.
- `apps/runtime/scripts/verify/databento/verify-databento-s3-inventory.js` — lists everything actually sitting under `raw/databento/` in S3 and reports real file counts/sizes/date coverage per dataset/schema/symbol (`npm run verify:databento-s3-inventory`, read-only, no key needed).
- `databento-entitlement-boundaries.json` (same directory) — full raw evidence.

## Versioning

`v1` is this entitlement snapshot (2026-09-06). A version bump means
re-running the boundary-finder script and this account's real entitlement
having actually changed.
