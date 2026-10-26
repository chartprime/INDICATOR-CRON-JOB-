# O1 cross-tier evidence bundle — 2026-09-21

**State:** complete.  
**Host interval:** 2026-09-21 10:43–11:15 UTC.  
**Deployed host:** `bd5c900d89621fc8c36828d8660fdae0754ad59a`.  
**Laptop runtime:** `3b8d3f0`; only the two previously retained replay-gzip
result files were untracked when C/D were restarted.  
**Network:** laptop `10.88.0.2` → WireGuard gateway `10.88.0.1:8001`.

This bundle joins the evidence needed to interpret O1. It contains no bearer,
gateway-to-service, provider, SSH or S3 credential.

## Release and health

- Host release metadata: `ref=bd5c900`, deployed at `2026-09-21T10:43:15Z`.
- `terminal-live-storage.service` and `terminal-archive-gateway.service` were
  `active/running`, `Result=success`, `NRestarts=0` at 11:14:52 UTC.
- Live-storage at that instant: ready; 2,554 admitted, 2,553 completed, zero
  rejected, unauthorized, failed, timed-out or overloaded; one request was in
  flight. Runtime event-loop p99/max was 25 ms, utilization 2%, RSS 352,100,352
  bytes and maximum GC pause 42.4 ms.
- Storage sizes were Binance DB 111,441,350,656 bytes/WAL 3,105,009,192 bytes
  and dxFeed DB 10,590,621,696 bytes/WAL 6,245,952 bytes.
- The preceding host audit also proved all five services active with zero
  restart loops, clean post-deploy journals, healthy collectors, active dxFeed
  weekday timers, stable Binance WAL and 1.7 TB available storage.

## Real laptop path

Terminal C and D were restarted. The runtime became ready with Binance spot
and perpetual connected; both 10,080-bar recoveries completed and the profile
reported `READY`. A real WebSocket client then proved this shared-selection
sequence:

1. Binance BTC-USDT: selection, snapshot, profile `READY`, recovery `READY`.
2. dxFeed AAPL: selection, snapshot, `RECOVERING`, profile `READY`, recovery
   `READY`, then a live trade.
3. Binance BTC-USDT perpetual: selection accepted.

Vite restarted on `127.0.0.1:8000` in 403 ms and returned HTTP 200. The runtime
health endpoint on `127.0.0.1:8001` returned ready.

## Production query plans

The plans below were captured with `sqlite3 -readonly` against the actively
written production databases using representative literals. `EXPLAIN QUERY
PLAN` does not execute the query.

### Binance

| Route/query | Production plan |
|---|---|
| recording-age | covering `idx_trades_symbol_market_ts` |
| recent-candles | `idx_candles_symbol_market_ts`, pair + time range |
| recent-trades | `idx_trades_symbol_market_ts`, pair + time range |
| large-trades ranked | `idx_trades_notional`, pair |
| large-trades time-covered | `idx_trades_symbol_market_ts`, pair + time range |
| aggressive-prints | `idx_trades_symbol_market_ts`, pair + time range |
| price-range | covering `idx_trades_vpin_covering`, pair + time range |
| minute-rollup | covering VPIN index + expected temporary GROUP BY B-tree |
| daily-notional raw | covering VPIN index + expected temporary GROUP BY B-tree |
| daily-notional materialized | unique rollup index, pair + day range |
| sliced-notional | covering VPIN index + expected temporary GROUP BY B-tree |
| volume-profile | covering VPIN index + expected temporary GROUP BY B-tree |

### dxFeed

| Route/query | Production plan |
|---|---|
| recent events/time-and-sales | `idx_dxfeed_time_and_sales_symbol_time`, pair |
| recent-candles | `idx_dxfeed_candles_symbol_ts`, pair + time range |
| large-trades ranked | symbol/time index + temporary ORDER BY B-tree |
| large-trades time-covered | symbol/time index, pair + time range |
| aggressive-prints | symbol/time index, pair + time range |
| price-range | covering VPIN index, pair + time range |
| minute/daily/sliced/profile aggregates | covering VPIN index + expected temporary GROUP BY B-tree |
| trades-since | symbol/time index, pair + time range |

No ordinary query performed a full table scan. The ranked dxFeed large-trade
sort is retained as an O4 measurement target rather than called a defect from
the plan alone.

## Existing pinned artifacts

- Browser manifest: `benchmarks/browser/selection-change-traced.json`, SHA-256
  `ac94e52f435b847d4edfae20914b36f59d685aa8062f58f3c0841ca195e20939`.
- Prior complete browser trace:
  `benchmarks/results/browser-selection-change-traced-local.json`, SHA-256
  `bebe3a983de6c90504411eef1663c9dcb291548458bc8f79f7415bef27e85bb1`.
  It measured request-to-first-paint at 51.8 ms with an ordered complete trace,
  but used Node 25.2.1 and an earlier dirty revision; it is diagnostic only.
- Accepted browser trace:
  `benchmarks/results/browser-selection-change-traced-3b8d3f0-node24.json`,
  SHA-256
  `de4d2a5a8c54f70887e06a00161f24c78fe82c30977db30e159fd34f3d9e5b69`.
  It used verified Node 24.21.0, commit
  `3b8d3f0e53590944b9328a349de8837ba93c1a89`, Chrome 152.0.7977.84 and web
  distribution SHA-256
  `18ac8a4c84ac815ab58b1592017c9d308d7e479d8b4ad8f876809f537bdae3d2`.
  All invariants passed, the trace was complete and ordered, request-to-first-
  paint was 65.7 ms and the only long task was 62 ms. The source reports zero
  tracked changes; its untracked files were evidence outputs and did not alter
  the built distribution.
- Sparse/gzip replay result:
  `benchmarks/results/replay-4h-20-page-run-07-sparse-gzip.json`, SHA-256
  `ad49e26c71b5cd1700fd50c642f762eb8bb441317f17c1183a2cae358cdb09e2`.
- The mutation ledger records the formerly surviving
  `vpin-remote.session.chunk-edges-unaligned` mutant as killed at
  `2026-09-21T10:07:44.912Z`.

Host/service correlation, request/response byte counts, route stages,
cancellation and failure counters were populated. The deployment audit found
zero server errors or timeouts; client cancellation remained classified
separately. The replay result retains per-page body digests and source identity
for semantic comparison.

## Acceptance

Node 24.21.0 was downloaded from the official Node distribution, and the
archive SHA-256
`158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541`
matched `SHASUMS256.txt` before execution. The exact-revision build and traced
selection scenario passed without bypassing the repository version gate. O1 is
accepted 8/8.
