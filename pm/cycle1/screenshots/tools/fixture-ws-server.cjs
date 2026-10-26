#!/usr/bin/env node
// Minimal stand-in for the runtime (apps/runtime) when Binance is unreachable.
// Speaks the frame contract in apps/web/src/types/frames.ts: on connect (and on
// every `select` from the browser) it sends `selection`, `snapshot` (synthetic
// 1m bars), `health` READY and a tiny `book`, then revises the forming bar once
// a second so live paths see motion. Any HTTP path (e.g. /health) answers 200
// JSON so the Vite proxy is satisfied.
//
// Usage: REPO=<checkout> node fixture-ws-server.cjs [port=8001] [bars=900] [seed=7]
// The web app's Vite proxy targets 127.0.0.1:8001 by default (TT_LIVE_PROXY_URL
// overrides it), so running this on 8001 needs no web-app change. REPO is the
// checkout whose node_modules holds `ws` (the PM checkout by default).
const http = require("node:http");
const path = require("node:path");
const { createRequire } = require("node:module");

const repo = process.env.REPO ?? path.resolve(__dirname, "../../../../Terminal-L1-L2-development-indicator-sdk");
const { WebSocketServer } = createRequire(path.join(repo, "package.json"))("ws");

const port = Number(process.argv[2] ?? 8001);
const barCount = Number(process.argv[3] ?? 900);
let seed = Number(process.argv[4] ?? 7);
const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const identity = { provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT" };
const INTERVAL = 60_000;
const openTime = Math.floor(Date.now() / INTERVAL) * INTERVAL;

// A random walk with slow regime changes so RSI visits both bands and candles vary.
const bars = [];
let price = 65_000;
for (let i = 0; i < barCount; i += 1) {
  const regime = Math.sin(i / 55) * 18;
  const open = price;
  const close = Math.round((open + regime + (random() - 0.5) * 70) * 10) / 10;
  const high = Math.max(open, close) + random() * 25;
  const low = Math.min(open, close) - random() * 25;
  const volume = Math.round((4 + random() * 20 + Math.abs(close - open) / 10) * 1000) / 1000;
  const buy = Math.round(volume * (close >= open ? 0.52 + random() * 0.2 : 0.28 + random() * 0.2) * 1000) / 1000;
  bars.push({
    type: "bar", ...identity, interval_ms: INTERVAL, ts_open: openTime - (barCount - 1 - i) * INTERVAL,
    open, high: Math.round(high * 10) / 10, low: Math.round(low * 10) / 10, close, volume,
    buy_volume: buy, sell_volume: Math.round((volume - buy) * 1000) / 1000,
    trade_count: 40 + Math.floor(random() * 300), closed: true,
  });
  price = close;
}
// Every snapshot bar must be closed (the parser refuses a forming bar there), so the
// forming bar is a separate live `bar` frame for the current minute, revised every second.
const closedBars = bars.slice(0, -1);
const forming = { ...bars[bars.length - 1], ts_open: openTime, closed: false };

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, fixture: true, symbol: identity.symbol, bars: bars.length }));
});
const wss = new WebSocketServer({ server, path: "/ws" });
const send = (socket, frame) => { if (socket.readyState === 1) socket.send(JSON.stringify(frame)); };
const initialize = (socket) => {
  send(socket, { type: "selection", ...identity });
  send(socket, { type: "snapshot", ...identity, bars: closedBars, trades: [], markers: [] });
  send(socket, { type: "health", ...identity, recoveryState: "READY", stale: false });
  send(socket, { type: "book", ...identity, status: "READY", bids: [{ price: forming.close - 0.5, size: 3.2 }], asks: [{ price: forming.close + 0.5, size: 2.1 }], lastUpdateId: 1, stale: false });
  send(socket, { ...forming });
};
wss.on("connection", (socket) => {
  socket.on("message", (wire) => {
    try { if (JSON.parse(wire.toString()).type === "select") initialize(socket); } catch { /* not JSON: ignore */ }
  });
  initialize(socket);
});
setInterval(() => {
  forming.close = Math.round((forming.close + (random() - 0.5) * 12) * 10) / 10;
  forming.high = Math.max(forming.high, forming.close);
  forming.low = Math.min(forming.low, forming.close);
  for (const socket of wss.clients) send(socket, { ...forming });
}, 1000);
server.listen(port, "127.0.0.1", () => {
  console.log(`fixture runtime on http://127.0.0.1:${port} (ws at /ws), ${bars.length} synthetic 1m bars for ${identity.symbol}`);
});
