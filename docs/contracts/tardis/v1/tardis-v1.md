# Tardis.dev v5 — Plan Decision, Purchased

Account created, real trial used, real data pulled and reviewed, **real
subscription purchased and confirmed**. Full evidence: `tardis-v1-report.json`
(this folder). Scope: Binance only tested so far (`binance` spot,
`binance-futures` perp), BTC-USDT and ETH-USDT. The other 63 exchanges in
All Exchanges are covered by the plan but not independently checked.

## Decision

| | |
|---|---|
| Tier | **Academic** (eligible: genuine student/researcher) |
| Data plan | **All Exchanges** |
| Billing | **Quarterly** |
| Price | **$1,950 / quarter** ($7,800/yr if billed yearly instead — same rate, unlocks 48mo instead of 12mo) |
| History | 12 months back from purchase date |
| Access type | CSV bulk download only — no live query API |
| Purchased | **Yes — confirmed 2026-09-07** via `verify-tardis-subscription.js`: real key shows `accessType=academic`, 64 exchanges, historical coverage from 2025-09-06. Tardis's own internal label for the data plan is `unlimited`, not literally "all-exchanges" — a naming difference only, the exchange count matches exactly. |

## Why this combination, not another

- **Academic vs Solo/Professional/Business:** identical capability to Solo
  (CSV-only), roughly half Solo's price, restricted to students/researchers
  — real fit here, not a workaround.
- **All Exchanges vs buying Spot + Perpetuals separately:** All Exchanges is
  cheaper at every tier (Academic: $1,950 vs. $1,350+$1,350=$2,700 combined)
  and covers 64 exchanges instead of 2. No reason to buy narrower.
- **Academic vs Professional:** Professional's only additions — on-demand
  replay API, `tardis-machine`, instrument metadata API, faster routing —
  are for live/on-demand querying. The actual plan is bulk-download once,
  land in S3, query your own database after. None of Professional's extras
  apply to that workflow.

## What All Exchanges + Academic actually gives you

**All 9 CSV data types, confirmed** (one rejected on purpose to find the
real list):

| Data type | What it is | Spot | Perp |
|---|---|---|---|
| `trades` | executed trades | Yes | Yes |
| `incremental_book_L2` | every order-book level change | Yes | Yes |
| `quotes` | best bid/ask, Tardis-derived from the L2 book | Yes | Yes |
| `book_ticker` | best bid/ask, exchange's own native feed | Yes | Yes |
| `book_snapshot_5` | top 5 book levels, periodic | Yes | Yes |
| `book_snapshot_25` | top 25 book levels, periodic | Yes | Yes |
| `derivative_ticker` | funding rate, mark/index price, open interest | — | Yes |
| `liquidations` | forced liquidation events | — | Yes |
| `options_chain` | options data | — | — (not applicable to Binance spot/perp) |

**No native OHLCV/candles.** Confirmed by a real rejected request. Build
candles from `trades` ourselves, cross-check against Binance's own klines
endpoint as a correctness check.

**`quotes` vs `book_ticker` — not duplicates, despite matching columns:**
`book_ticker` is the exchange's raw push feed (very high row count —
37M rows/day for BTC-perp). `quotes` is Tardis's own recomputed best-bid/ask
from the reconstructed book, only changing when the top level actually
moves (1.9M rows/day, same symbol). **`book_ticker` is the one to treat as
authoritative** — it matches what a live consumer actually sees; `quotes`
is a derived cross-check.

## Real data volume, one full day (2026-09-01), for sizing storage

| | BTC-spot | ETH-spot | BTC-perp | ETH-perp |
|---|---|---|---|---|
| `trades` | 3.66M | 2.47M | 3.60M | 4.85M |
| `incremental_book_L2` | 26.3M | 17.7M | **134.4M** | **108.2M** |
| `quotes` | 0.60M | 0.46M | 1.89M | 2.09M |
| `book_ticker` | 9.85M | 6.24M | 36.9M | 31.5M |
| `book_snapshot_5` | 0.62M | 0.51M | 2.03M | 2.23M |
| `book_snapshot_25` | 0.70M | 0.63M | 2.42M | 2.65M |
| `derivative_ticker` | — | — | 112K | 114K |
| `liquidations` | — | — | 1,069 | 995 |

**Perpetual futures generate far more L2 traffic than spot** (~5x on
incremental book updates) — plan storage/bandwidth accordingly; this is
also why Databento's own L2 retention is short-lived.

## Real account/auth mechanics (for future reference)

Account API: `https://api.tardis.dev` (sign-in issuer
`https://auth.tardis.dev`). Identity + refresh token: `.tardis-identity.json`
(repo root, gitignored). Data API key: `tardis_key` in `.env` (gitignored).
Real, tested endpoints: `POST /v1/account` (create-or-return), `GET
/v1/account/plans` (source of every price above), `POST /v1/account/trials`
(one per account, not per data plan), `POST /v1/account/data-api-keys`.
Billing/checkout endpoints exist and are reachable but this tooling never
called them — **the actual purchase was completed manually by the account
holder on Tardis's own checkout page**, then confirmed here the same way
everything else in this doc is confirmed: a real API call
(`verify-tardis-subscription.js`), not an assumption.

**One real anomaly, not relied on:** a Binance spot CSV download succeeded
during the trial even though the trial was scoped to `perpetuals` only.
Real, observed, not something to plan around — the paid subscription
covers spot for real regardless.

## Real scripts and data

- `apps/runtime/scripts/verify/tardis/verify-tardis-content.js` — real CSV pulls for every data type above, all 4 symbols (`npm run verify:tardis-content:live`).
- `apps/runtime/scripts/verify/tardis/build-tardis-review-samples.js` — slices the first 2 minutes out of each already-downloaded file into a plain, human-readable `.csv` (no new API calls) — `data/historical/tardis/samples/<SYMBOL>/review-samples/`.
- `apps/runtime/scripts/verify/tardis/verify-tardis-subscription.js` — checks the real entitlement behind `tardis_key` (`npm run verify:tardis-subscription:live`); the key value itself is never logged. This is what confirmed the real paid Academic subscription, 2026-09-07.
- `apps/runtime/data/historical/tardis/samples/` — real full-day `.csv.gz` files (28 files, one full trading day, 2026-09-01) plus the small review-sample CSVs.

## Still open

- Only Binance tested — the other 62 exchanges in All Exchanges are
  unverified by real data.
- Canonical output schema across Databento + Tardis (harmonizing both
  providers into one internal format for ingestion) — a design decision,
  not a data question, tracked separately.

## Versioning

v1 pre-account research. v2 added real account/trial/pricing data. v3
corrected the tier to bulk-download reality (Solo, not Professional). v4
finalized Academic (real eligibility) + All Exchanges as the decision,
added the real 9-data-type schema catalog, real per-type row-volume
evidence across all 4 symbols, and the JSON evidence file. **v5 (this
version)** confirms the real purchase went through — Academic subscription
active, verified via a real key re-check, not just decided on paper.
