# Acceptance run: Binance REST transport (Stage B, candles only)

Branch `build/binance-rest-transport`, worktree `/home/user/Terminal-L1-L2/worktrees/binance-rest`.
Container: no WebSocket egress (the proxy refuses upgrades), `api.binance.com` geo-blocked (451),
`data-api.binance.vision` reachable over the HTTPS proxy. Date 2026-10-26, 04:08 to 04:17 UTC.

## Command

```bash
export PATH=/root/.nvm/versions/node/v24.21.0/bin:$PATH
cd apps/runtime
NODE_USE_ENV_PROXY=1 TT_BINANCE_TRANSPORT=rest TT_BINANCE_SPOT_REST_BASE_URL=https://data-api.binance.vision \
  node ../../scripts/node-launcher.cjs scripts/serve/run-ws-server.js 8001 BTCUSDT
```

`NODE_EXTRA_CA_CERTS` (set by the container) supplied the proxy CA; `.env` in the worktree carried
`L2_HEATMAP_TRACK_ALL=1`, so ETH spot was polled beside BTC and the two perpetual pairs were refused
(their route never connects on this transport, as designed).

## `/health` after 25 s (second run, final code)

| Field | Value |
|---|---|
| `ready` | true |
| `status` | `SPOT.public: CONNECTED`, `PERPETUAL.public/market: DISCONNECTED` |
| `delivery.transport` / `routeState` | `rest` / `CONNECTED` |
| `delivery.polls` / `pollFailures` | 48 / 0 (168 / 0 after the recording) |
| `delivery.exchangeOffsetMs` | 400 (first run 387): exchange clock ahead of the container |
| `delivery.pollers[*].lastLatencyMs` | 174 (BTC), 167 (ETH); cadence 1000 ms each |
| `delivery.weight` | budget 4000; this minute reserved 138, exchange header 158, used 158 (two pairs plus the ETH candle backfill); after the recording reserved 251, header 155; deferrals 0 |
| `readiness.dimensions.transport` | READY |
| `readiness.warmups.candles` | READY; `large_trades`, `aggressive_prints`, `volume_profile`, `vpin` DEGRADED (no tape, no storage here) |
| `instrument-tick-size` failures in the log | 0 (the tick-size `exchangeInfo` call now follows the spot REST override; the first run, before that fix, logged `HTTP_ERROR` from the blocked default origin) |

Note: the tick-size `exchangeInfo` call (weight 20 per pair, cached 24 h) is not reserved against the budget; the
exchange header catches it (`observed` 158 > `reserved` 138 above).

## Recording 1: 90 s, plain client (first run)

| Count | Value |
|---|---|
| snapshot bars | 10,080 (seven days of 1m candles, backfilled from the mirror in 11 pages) |
| snapshot trades / markers | 0 / 0 |
| bar frames | 70: 2 closes (04:10 and 04:11), 67 revisions of a forming bar, 3 distinct open times (04:10, 04:11, 04:12) |
| trade frames | 0 (no side counts: the tape is not served) |
| health frames | 1: `READY`, `stale: false`, reason `Polled spot candles · no tape · no order book` |
| book frames | 1: `UNAVAILABLE`, reason `REST_NO_DEPTH` |
| last forming bar | 04:12 open 79855.08 high 79865.54 low 79855.08 close 79865.54 volume 0.25708 buy_volume 0.25686 trade_count 271 |

## Recording 2: 60 s, client declaring every L2 capability (second run)

The client sent `{"type":"capabilities", marker_history, l2_view, l2_walls, l2_walls_lanes, l2_events, l2_ladder,
iceberg_orders, exhaustion_shades, initiative_bands: true}` before selecting BTC spot.

| Count | Value |
|---|---|
| frame types received | `selection` 1, `snapshot` 4, `book` 1, `health` 1, `bar` 59; nothing else |
| `l2_*`, `liquidity`, `iceberg_orders`, `exhaustion_shades`, `initiative_bands`, `marker_history` frames | 0 |
| bar frames | 59: 1 close, 57 revisions, 2 distinct open times (04:15, 04:16) |
| trade frames | 0 |
| health | `READY`, reason `Polled spot candles · no tape · no order book` |
| book | `UNAVAILABLE:REST_NO_DEPTH` |

So a chart on this transport receives candles and an explicit unavailable book, and no depth-derived frame at all:
every L2 visual shows its own unavailable state rather than stale data. Nothing in the runtime is "previously
seeded" on REST because the L2 engine is never fed; a browser that was earlier connected to a stream runtime and
reconnects to a REST runtime rebuilds from the new selection and snapshot. The rendered chart itself could not be
inspected here (no browser); the owner's run below covers it.

## Recorder

```js
// record-rest-run.cjs <port> <seconds>: connect to /ws, declare the L2 capabilities, select BTC spot, summarise.
const WebSocket = require("ws");
const [port = 8001, seconds = 90] = process.argv.slice(2).map(Number);
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const counts = {}; const bars = new Map(); const closed = []; let snapshotBars = 0, trades = 0;
const health = new Set(); const book = new Set();
ws.on("open", () => {
  ws.send(JSON.stringify({ type: "capabilities", marker_history: true, l2_view: true, l2_walls: true, l2_walls_lanes: true, l2_events: true, l2_ladder: true, iceberg_orders: true, exhaustion_shades: true, initiative_bands: true }));
  ws.send(JSON.stringify({ type: "select", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT" }));
  setTimeout(() => ws.close(), seconds * 1000);
});
ws.on("message", (data) => {
  const f = JSON.parse(data.toString()); counts[f.type] = (counts[f.type] ?? 0) + 1;
  if (f.type === "snapshot") snapshotBars = f.bars.length;
  if (f.type === "bar") { bars.set(f.ts_open, f); if (f.closed) closed.push(f); }
  if (f.type === "trade") trades += 1;
  if (f.type === "health") health.add(`${f.recoveryState}:${f.stale}:${f.reason ?? ""}`);
  if (f.type === "book") book.add(`${f.status}:${f.reason ?? f.lastUpdateId}`);
});
ws.on("close", () => console.log(JSON.stringify({ counts, snapshotBars, distinctBars: bars.size, closed, trades, health: [...health], book: [...book] }, null, 1)));
```

## Semantic baseline on the owner's machine (WebSocket reachable)

Run the two transports side by side on the same symbol and compare overlapping complete minutes:

```bash
# terminal 1: the stream transport (default), port 8001
cd apps/runtime && node ../../scripts/node-launcher.cjs scripts/serve/run-ws-server.js 8001 BTCUSDT
# terminal 2: the REST transport, port 8002
cd apps/runtime && TT_BINANCE_TRANSPORT=rest node ../../scripts/node-launcher.cjs scripts/serve/run-ws-server.js 8002 BTCUSDT
# terminal 3: record both for 20 minutes
node record-rest-run.cjs 8001 1200 > ws.json & node record-rest-run.cjs 8002 1200 > rest.json; wait
```

Pass criteria, on every `ts_open` present as `closed: true` in both files: `open`, `high`, `low`, `close`,
`volume`, `buy_volume` and `trade_count` equal within rounding (the wire carries finite doubles of Binance's
decimal strings; allow 1e-9 relative), and the REST close arrives within 3 s of the exchange close (the 1 s grace
plus one poll plus latency). Catch-up deadline: unplug the REST runtime's network for five minutes and restore
it; every missed close must appear, in order, within 5 s of `/health` showing `SPOT.public: CONNECTED` again
(outages up to 10,000 bars are one burst of at most ten 1000-row pages; longer ones add one poll cadence per
further ten pages), and the health reason must read `· catching up` only while that runs.

Also check in the browser: the chart renders candles and updates the forming bar once a second; the status line
shows LIVE with the reason text; the DOM and every L2 panel show "unavailable (REST_NO_DEPTH)" and no stale ladder,
heatmap or wall; Large Trade Bubbles and other print-based tools stay empty.

## Not verifiable here

- The rendered chart (no browser in the container).
- Equality against the stream transport (no WebSocket egress): the procedure above is for the owner's machine.
