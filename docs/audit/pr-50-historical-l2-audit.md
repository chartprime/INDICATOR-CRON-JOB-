# PR #50 audit: historical L2

Audit of `feat/j1-historical-l2-core` (31 commits, 227 files, +18.8k lines) before it merges into
`development-indicator-sdk`. The PR adds historical L2 for August 2026 ESU6, NQU6, AAPL and TSLA:
the source and conversion pipeline, the qualified wall and print indexes, a reader and gateway route,
and the browser inputs behind all 12 L2 menu entries. The route stays unconfigured after merge.

The review went by risk: first everything the PR changes in code that already runs live, then the
new route's security, then the new historical code's correctness, then the tests and mutation specs.

## Findings

| # | Area | Severity | Finding | Outcome |
|---|---|---|---|---|
| A-1 | Institutional Order Blocks v1 (`bookEvidence.ts`) | high | The PR made any band crossing a column's edge read as unobserved. A historical top-of-book column's edge is the depth the source saw, so that is right there. A live or band-history column's edge is only where its answer was cut: band history returns exactly the zone's rows, which rarely start on a band boundary (3 rows on ES, 12 on NQ, 8 on AAPL). Most live zones read from band history became unverifiable. Shown with the same columns before and after: evidence (held, peak 300) became `unverifiable / hole` | Fixed: the strict edge rule applies only to historical columns (`edgeUnknown`, set from `l2.availability`). A live edge reads the rows the column holds, as before. Three tests and two mutants |
| A-2 | Live Order Book Profile (`restingOrders.ts`) | medium | A resting order whose row left the live column was dropped at once, where it used to end over the hold time. An order flickering at the book's edge vanished and had to stand again before it showed | Fixed the same way: empty past a live edge, unknown past a historical one. Test and two mutants |
| A-3 | Day encoder (`derive_historical_cme_core.py`) | medium | When the events writer failed, the states writer could still seal its manifest: the writer watcher polls every 0.1 s, and a short day seals within that window. The PR's own test failed in 7 of 10 runs on Linux. No `result.json` was written, and downstream pins each family manifest from it, so nothing could publish the orphan; but the stated rule did not hold and the gate was red | Fixed: once every child has stopped, a failed day's family manifests are renamed `manifest.abandoned.json`. 15 of 15 runs pass |
| A-4 | Historical knowledge cut | none | A bar's L2 and liquidity inputs are cut at its close, and a second becomes known only once it closes, so no bar sees later depth. Nine mutants on the cut (ignored, made exclusive, trust past the cut, trust across a silent gap, the segment break, the runtime cut): all nine killed. One, trust across a silent gap, was caught only by a whale-heatmap timing test | A test now pins that a recorded second is trusted for one second only. 9 of 9 killed by the tests written for them (`audit-pr50.json`) |
| A-5 | Live paths the PR touches | none | All other live edits were checked one by one. Each new branch fires only for `HISTORICAL` or `DATABENTO` or for non-finite cells, which live data never has: Empty Orderbook sums, band maxima, IOB v2, Whale heatmap, Absorption, Feed Status, Liquidity Voids, Book Map, S/R, ChartPanel. The futures-root parser gives the same root for every live symbol. The L2 engine's `coverage` path runs only on historical frames. No edited test weakens a live expectation | No change |
| A-6 | Route and services | none | `/archive/l2` reuses the archive route: bearer auth, loopback-only upstream, body and time limits, concurrency caps, strict request and reply validation. Unconfigured, it refuses with 503 and leaves gateway readiness unchanged. The Python reader needs the shared secret and binds loopback only. The new systemd unit is hardened and is installed but not started by `install-ops.sh` | No change |
| A-7 | Mutation specs | none | The 18 retargeted guards keep or strengthen their mutations; no `mustFail` list shrank, no command narrowed, none removed | No change |
| A-8 | Gate | medium | The WebSocket fan-out benchmark failed in both full-gate runs (healthy clients missed 3,833 and 6,537 trades) and passed 58 of 58 alone. With six CPU-burning processes and no PR code it fails the same way: it is a real-time benchmark, and the PR's conversion suite (about 420 s) now overlaps it. A heatmap-route test failed once for the same reason: it waited a fixed 30 ms for a request to reach the route, and a late request was rightly told the server was stopping | The gate runs the benchmark last, on its own (`runtime load bench`), and leaves it out of the runtime suite. The two heatmap-route tests wait on the route's own state instead of a fixed delay |

## What traders see after merge

- Nothing changes on live charts.
- In Historical Mode, the 12 L2 entries now say they need verified historical L2 states, instead of
  saying the archive has no depth.
- With one of them selected on a Databento instrument, the status line notes that the L2 route refused
  (`READER_UNAVAILABLE`) until `TT_L2_ARCHIVE_SERVICE_URL` is set, per
  [the activation runbook](../operations/10-historical-l2-service.md).
