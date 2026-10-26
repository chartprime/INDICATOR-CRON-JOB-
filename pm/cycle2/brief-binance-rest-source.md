# Build brief: optional REST-polling Binance SPOT source (`TT_BINANCE_TRANSPORT=rest`)

Survey of `Terminal-L1-L2-development-indicator-sdk` (main), 2026-10-26. Paths are relative to `apps/runtime/src/` unless stated. The repository was not modified.

## 0. Step one, independent of the REST work: spot WebSocket URL override

Binance runs an un-geo-blocked spot stream mirror, `wss://data-stream.binance.vision:9443`. Today the spot WS origin is the constant `BINANCE_SPOT_WS_BASE_URL` (`providers/binance/binance-config.js:4`), read by `wsBaseUrlsFor` (:121-132), frozen into the market-kind context (:134-146) and made the route URL `${base}/stream` in `binance-connection.js:108-110, 291-322`. The REST origin is the constant at :7, read by `restBaseUrlFor` (:111-119) and used by `binance-http-client.js:261, 292, 314`.

Build:
1. `binance-config.js`: add `binanceEndpointsFromEnv(env)` returning `{ spotWsBaseUrl, spotRestBaseUrl }` with the current constants as defaults; `wsBaseUrlsFor(marketKind, endpoints)` and `restBaseUrlFor(marketKind, endpoints)` accept the override for SPOT only. PERPETUAL constants (:5-6, :8) untouched.
2. `binance-connection.js:112-139`: new option `endpoints`, passed to `createBinanceMarketKindContext` (:226-229) and as `baseUrl` to `fetchDepthSnapshot`/`createBinanceKlineBackfill` (:251, :1612, :1652); `binance-http-client.js` functions take an optional `baseUrl`. `server/app.js:128` passes `endpoints: binanceEndpointsFromEnv(process.env)`.
3. `platform/config-registry.js`: `TT_BINANCE_SPOT_WS_BASE_URL` (new kind `wsOrigin`: bare `ws:`/`wss:` origin, port allowed; `describeExpected`/`valueIsValid` :261-337) and `TT_BINANCE_SPOT_REST_BASE_URL` (kind `origin`), both `[TERMINAL_C]`, `.env`. Matching rows in `docs/operations/09-configuration.md` (:35ff; `scripts/validate-docs.cjs:91-102` enforces them).
4. Tests: `test/providers/binance/binance-config.test.js:53-70` gains the override cases; `binance-connection.test.js:128-142` gains "with `endpoints.spotWsBaseUrl` the SPOT route URL is `<override>/stream` and the two PERPETUAL URLs are unchanged"; `binance-http-client.test.js:35-41` gains the REST override URL.

This alone lets a VPS in a blocked region run the normal stream transport for spot. It does not help this container (the proxy refuses WebSocket upgrades); hence the REST source.

## 1. Integration point

The seam is the connection object, which `market-data-server.js` duck-types: `onMessage` (:3602), `connect`/`getStatus` (:3609-3610; `requiredRoutesConnected` :3533-3539 needs `status.SPOT.public === "CONNECTED"`), `subscribeMany`/`unsubscribeMany` (:1261, :1288), `getFeedHealth` (:822, :955, :2680), `getOrderBook`/`getOrderBookStatus` (:1018, :1130-1137), `recoverStaleSubscription` (:2642), `fetchRecentKlines` (:1807), `disconnect` (:3629). The public surface is `binance-connection.js:1930-1949`.

Build `providers/binance/binance-rest-connection.js` exporting `createBinanceRestConnection(options)` with that surface, selected in `server/app.js:128`:

```js
const connection = transport === "rest"
  ? createBinanceRestConnection({ telemetry, fetchImpl, endpoints, pollMs, weightBudget })
  : createBinanceConnection({ telemetry, webSocketImpl, fetchImpl, endpoints, backpressureMaxQueueDepth });
```

It reuses unchanged: `binance-config.js`, `binance-subscription-guard.js` (:99-115), `providers/shared/subscription-registry.js`, `binance-event-normalizer.js` (`normalizeBinanceEvent` :671-690, fed raw objects in stream shape so the output is the same frozen envelope :540-552), `binance-feed-health.js`, `binance-kline-backfill.js`; plus `binance-book-assembler.js` with one additive method (section 3) and `binance-http-client.js` with `fetchAggTrades`. It emits envelopes as the WS path does: `patchEnvelopeHealthContext` (`binance-connection.js:1446-1461`) and `feedHealth.recordEvent` before emission (:1356-1358).

Files to touch: new `binance-rest-connection.js`, `binance-rest-trade-pager.js`, `binance-rest-weight-budget.js`; `binance-http-client.js` (`fetchAggTrades`, `baseUrl`; it already returns `headers` :248); `binance-book-assembler.js` (one method); `binance-config.js`, `server/app.js:128`, `config-registry.js`, `09-configuration.md`; `market-data-server.js:845-856` only to carry the health context's `reason` into `healthFrame` (today only `WIRE_VALUE_OUT_OF_RANGE` does, :839-843).

Must not change: `binance-connection.js` beyond the `endpoints` option, `binance-event-normalizer.js`, `binance-feed-health.js`, `binance-backpressure-queue.js`, `server/frames.js`, `provider-router.js`, every `indicators/**`, the web app.

## 2. Configuration (`config-registry.js`, `[TERMINAL_C]`, `.env`)

| Setting | Kind | Default | Meaning |
|---|---|---|---|
| `TT_BINANCE_TRANSPORT` | enum `ws`,`rest` | `ws` | absent or `ws` is byte-for-byte today's path |
| `TT_BINANCE_SPOT_WS_BASE_URL` | wsOrigin | `wss://stream.binance.com` | documented alternative `wss://data-stream.binance.vision:9443` |
| `TT_BINANCE_SPOT_REST_BASE_URL` | origin | `https://api.binance.com` | documented alternative `https://data-api.binance.vision` |
| `TT_BINANCE_REST_POLL_MS` | number, integer, min 250 | `1000` | trades and klines cadence |
| `TT_BINANCE_REST_WEIGHT_BUDGET` | number, integer, 100..6000 | `4000` | REQUEST_WEIGHT the runtime allows itself per minute |

`09-configuration.md` gets the rows plus a paragraph: spot only, perpetual pairs unselectable, container prerequisite `NODE_USE_ENV_PROXY=1` (section 5). `bootProcess` (`platform/process-env.js:48-67`) validates them at start.

## 3. Polling design per family

**Trades (`/api/v3/aggTrades`, weight 4).** The WS path emits one envelope per `@trade` message (`binance-connection.js:76`), normalized from keys `t,p,q,T,m` (`normalizer :21, :42, :318-325`, event time `T` :297), and downstream derives side as `isBuyerMaker ? "sell" : "buy"` (`frames.js:163`, `l2-memory/live-binding.js:52`) and dedupes by `trade_id` (`server/history.js:206-214`). Pager: on subscribe, `GET aggTrades?symbol&limit=1` sets `cursor = a`. Each tick: `GET aggTrades?symbol&fromId=cursor+1&limit=1000`; while a page is full, fetch the next at once (cap 5 pages per tick, then `feedHealth.beginRecovery(TRADE)` and continue next tick, never drop). Aggregate ids are contiguous: a row with `a <= cursor` is dropped as a duplicate; a jump is telemetry `market_data.binance_rest.trade_id_gap`, never filled. Each row becomes raw `{e:"trade", E: receivedAtMs, s, t: a, p, q, T, m, M}` for `normalizeBinanceEvent`: `payload.tradeId` is the aggregate id, `eventTime` the exchange time `T`, emission order `a` ascending.

**Bars (`/api/v3/klines`, weight 1 for limit ≤ 100).** Today 1m bars come from the `@kline_1m` stream, not from trades (`market-data-server.js:119, :1248-1249`; `klineEnvelopeToFrame` `frames.js:168-210`, closed from `k.x`); backfill uses REST rows (`restKlineRowToBarFrame` `frames.js:212-263`). Each tick: `GET klines?symbol&interval=1m&startTime=<previous minute open>&limit=2`. Row 0 is emitted `x:true` once per `openTime`, only after `closeTime < receivedAtMs`; row 1 `x:false` whenever `c,v,n` changed. Raw: `{e:"kline", E: receivedAtMs, s, k:{t,T,s,i:"1m",o,c,h,l,v,n,x,q,V,Q}}`; `f`,`L`,`B` are optional (`normalizer :24, :48-64`). `fetchRecentKlines` delegates to the existing backfill.

**Depth (`/api/v3/depth?limit=1000`, weight 50) as periodic snapshots.** The assembler needs a snapshot and then a bridging diff: `applySnapshotStatus` sets `needsBridgeCheck = true` (`binance-book-assembler.js:352`) and `getStatus` stays `BUFFERING` until a diff with `U <= lastUpdateId+1` arrives (:85-105, :264-288, :381-398). A snapshot-only feed never leaves BUFFERING, so add one explicit method, `applyStandaloneSnapshotStatus(body)`: the same validation (`snapshotDepthBody` :27-43, crossed book :339-344, level cap), then `needsBridgeCheck = false`, `localUpdateId = body.lastUpdateId`, buffer cleared. No synthetic update ids. The transport keeps one real assembler per pair and feeds it every poll, so `getOrderBook` returns a READY book whose `lastUpdateId` is the snapshot's own id (`emitBook` fingerprints on it, `market-data-server.js:963-968`).

For the L2 engine the transport emits one DEPTH envelope per snapshot: `firstUpdateId = lastUpdateId = snapshot.lastUpdateId`, `previousUpdateId: null` (SPOT, `normalizer :364-367`, `assembler :69-71`) and `bids`/`asks` = the observed level changes between the previous and current snapshot, computed only inside the price window both snapshots cover (bids `>= max(oldLowestBid, newLowestBid)`, asks mirrored); a vanished level is reported with quantity `"0"` as Binance does; levels that merely left the 1000-level window are not reported. `live-binding.js:44-47` makes a `book` frame whose `delta` is those changes; `memory-engine.js:201-250` applies it as a diff while `live`, seeds on the first READY book (:131-141), resyncs after a gap (:143-158), and `coverageOf` (:106-114) reads the real edge of the 1000-level book. A failed poll emits nothing; `429/418` or three consecutive failures mark DEPTH recovering, the `gateBookState` equivalent returns `UNAVAILABLE: RECOVERY_IN_PROGRESS` and `live-binding.js:45` sends a `gap` frame, as a WS sequence gap does (`binance-connection.js:1377-1390`). The periodic and shadow refreshes (:65, :867-886, :1580-1641) do not apply.

## 4. Honesty

- `getStatus()` reports `SPOT.public` `CONNECTED` only after a successful `exchangeInfo?symbol=BTCUSDT` probe (weight 20, `fetchExchangeInfo` :303-319), `DISCONNECTED` after three consecutive failures; PERPETUAL routes stay `DISCONNECTED`, so a perpetual `subscribeMany` throws today's "route is connected" error (`binance-connection.js:1004-1016`) and `requestSwitch` parks the selection (`market-data-server.js:3496-3508`).
- `getFeedHealth()` returns the feed-health context plus `transport: "rest"`, `pollMs`, `lastPollLatencyMs` and `reason`: `REST_POLL` while READY, `REST_RATE_LIMITED`, `REST_POLL_FAILED`, `REST_BACKOFF_<ms>` while degraded. `market-data-server.js:845-856` passes the worst context's `reason` to `healthFrame` (`frames.js:663-694` accepts a reason with READY, limit 256 chars :28); the browser already prints it (`apps/web/src/components/chart/MainPanel.tsx:2436`). The health fingerprint includes it (`market-data-server.js:944`), so every change is broadcast.
- Staleness keeps today's thresholds (`binance-feed-health.js:7-12`: TRADE 30 s, KLINE 10 s, DEPTH 5 s). A successful empty trade poll is a real observation and records `recordEvent(TRADE)`; a failed poll records nothing, so silence becomes `stale: true` as with a dead stream. No envelope is ever emitted without a row.
- Backoff: on `RATE_LIMITED` (`binance-http-client.js:231-234` parses `Retry-After`) every family of every pair pauses until the later of `Retry-After` and exponential backoff (1 s base, 30 s cap, 20% jitter, as `binance-connection.js:47-49, :1704-1740`), with `beginRecovery` on all families and telemetry `market_data.binance_rest.backoff`. A `418` (IP ban) waits the full `Retry-After` and sets `DISCONNECTED`.
- Weight accounting: every response's `x-mbx-used-weight-1m` (already in `result.value.headers`) is authoritative; the budget module also projects per calendar minute: aggTrades 4 per page, klines 1, depth 50 (limit 1000), exchangeInfo 20, kline backfill 5 per 1000-row page. With one pair at `pollMs=1000`: 60·(4+1) + 60·50 = 3300/min ≤ 4000, so depth polls every tick. The scheduler stretches the depth cadence first (to the smallest multiple of `pollMs` that fits), then klines, never trades; two pairs: 600 + 3000 (depth every 2 s) = 3600. If the header reaches the budget, all polling stops until the minute boundary; the hard limit 6000 is never approached (margin ≥ 2000).

## 5. Proxy support

The REST client is Node's built-in `fetch` (`binance-http-client.js:208-211`, `fetchImpl = globalThis.fetch` :253; `binance-connection.js:116`), not `undici` or `https`; `redirect: "error"`, 5 s timeout, 2 MB cap. It ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21; the repo pins 24.21.0, `package.json:6-7`). CA: Node reads `NODE_EXTRA_CA_CERTS`, which this container sets beside `SSL_CERT_FILE` (Node ignores the latter). No code change: document both in `09-configuration.md` and `03-server-runbook.md`; on the owner's machine neither is set and nothing changes. `ws` never honoured a proxy.

## 6. Tests (jest, `apps/runtime/test/providers/binance/`)

Fixture: `test/fixtures/binance-rest/fake-binance-server.js`, a `node:http` server on `127.0.0.1:0` (precedent `test/fixtures/offline-serving-process.js`) serving scripted `aggTrades`, `klines`, `depth`, `exchangeInfo` bodies with `x-mbx-used-weight-1m`, status overrides (`429` plus `Retry-After`, `418`, `500`) and a request log; the connection gets `endpoints.spotRestBaseUrl = http://127.0.0.1:<port>`. Unit tests use `jest.fn` fetch fakes as in `binance-connection.test.js:1608-1628`.

- `binance-rest-trade-pager.test.js`: 2500 trades over three pages arrive once, in order, no id missing; overlapping pages drop duplicates by id; a jump logs telemetry and fabricates nothing; the 5-page cap marks TRADE recovering.
- `binance-rest-weight-budget.test.js`: per-family ledger, depth cadence stretching, hard stop at the header, minute-boundary reset (fake clock).
- `binance-rest-connection.test.js`: `getStatus` lifecycle; backoff on 429/418 honouring `Retry-After`; failed polls emit nothing and turn `stale`; health context carries `transport`, `reason`, latency; perpetual subscribe throws; `quiesce` drains in-flight polls.
- `binance-book-assembler.test.js`: `applyStandaloneSnapshotStatus` reaches READY with the snapshot's `lastUpdateId`, rejects malformed and crossed books; the real assembler plus `live-binding.binanceDepthFrame` feed `memory-engine` (seed, diffs, gap, resync; `stats.resyncs` counts one per gap, not per poll).
- `binance-rest-shape-parity.test.js`: a recorded fixture of WS `trade`/`kline`/`depthUpdate` messages and the equivalent REST rows for the same instant; per family the normalized envelopes have identical key sets and types, identical `provider`, `venue`, `marketKind`, `eventType`, `timingClass`, and identical `price`, `quantity`, `isBuyerMaker`, `eventTime` per print; the documented differences (`tradeId` space, kline `eventTime` = poll time, depth `firstUpdateId === lastUpdateId`) are asserted.
- `test/server/app.test.js:210-230`: with `TT_BINANCE_TRANSPORT=rest` `createApp` constructs no WebSocket; absent, `createBinanceConnection` is used.
- `test/platform/config-registry.test.js` covers the new entries automatically (:46-60).

## 7. Acceptance criteria

1. In this container, `TT_BINANCE_TRANSPORT=rest TT_BINANCE_SPOT_REST_BASE_URL=https://data-api.binance.vision NODE_USE_ENV_PROXY=1 node apps/runtime/scripts/serve/run-ws-server.js 8001 BTCUSDT` reaches `CONNECTED`, and the web app shows BTC spot trades with side, a forming and a closing 1m bar, a READY book, and a health line carrying `REST_POLL`.
2. `x-mbx-used-weight-1m` observed over ten minutes stays ≤ 4000.
3. `npm test` in `apps/runtime` passes in full; `npm run docs:check` passes.
4. With the setting absent the WS path is untouched: `binance-connection.test.js` (3805 lines) passes unmodified apart from the added URL-override case, and `app.test.js:226` still finds the `stream.binance.com/stream` socket.

## 8. Risks and what is not supported

- Not supported: perpetuals (no mirror; routes stay DISCONNECTED); sub-second latency (trades arrive up to `pollMs` plus round trip late; the engine's late-trade rule, `memory-engine.js:83-94`, keeps order); order-book diffs (a 1000-level snapshot at most once per tick; iceberg and exhaustion engines see coarser deltas, to be documented as degraded on REST); bookTicker; switching transport at runtime (aggregate and raw trade ids differ).
- Risks: endpoint weights may change (the header is authoritative, the ledger a projection); the mirror's lag behind the primary is undocumented (measure `T` versus `receivedAt` in the acceptance run); a 1000-level book is shallower than the 5000-level WS snapshot, so lane-0 heatmap coverage (±5%) may be partial on volatile days, with `coverageOf` marking the real edge.

## Summary

1. First step: `TT_BINANCE_SPOT_WS_BASE_URL` override (config.js:4,121-146; connection.js:291-322) with registry entry, doc row and one URL test; helps a VPS, not this container.
2. The REST source is a second connection factory with the surface of `binance-connection.js:1930-1949`, chosen in `app.js:128`.
3. Normalizer, feed health, frames, L2 engine, router and web app stay unchanged; raw objects are built in stream shape, so envelopes are canonical.
4. Trades: aggTrades `fromId` paging, dedupe by id, side from `isBuyerMaker`, order preserved, gaps reported not filled.
5. Bars: klines `limit=2`, previous bar emitted closed once, forming bar on change; matches today's kline-stream path.
6. Depth: 1000-level snapshots into the real assembler via one additive method; L2 gets observed level changes with `U === u === lastUpdateId`, gap and resync frames as today.
7. Health reason `REST_POLL`/`REST_RATE_LIMITED`/`REST_POLL_FAILED` reaches the browser; empty polls are observations, failed polls are silence.
8. Weight ledger plus the exchange header, budget 4000/min by default, depth cadence stretched first, hard stop until the minute turns.
9. Proxy and CA need only `NODE_USE_ENV_PROXY=1`; nothing changes on the owner's machine.
10. Effort: step one half a day; REST source about five engineer-days (one specialist run plus two fix rounds), tests included, with the acceptance run in this container.
