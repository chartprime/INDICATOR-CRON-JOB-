#!/usr/bin/env node
// Minimal stand-in for the runtime (apps/runtime) when Binance is unreachable.
// Speaks the frame contract in apps/web/src/types/frames.ts: on connect (and on
// every `select` from the browser) it sends `selection`, `snapshot` (synthetic
// 1m bars), `health` READY and a tiny `book`, then revises the forming bar once
// a second so live paths see motion. Any HTTP path (e.g. /health) answers 200
// JSON so the Vite proxy is satisfied.
//
// Usage: REPO=<checkout> [TAPE=size-split] [POOL_BARS=200] [LOW_SHARE_MINUTE=n] node fixture-ws-server.cjs [port=8001] [bars=900] [seed=7]
// The web app's Vite proxy targets 127.0.0.1:8001 by default (TT_LIVE_PROXY_URL
// overrides it), so running this on 8001 needs no web-app change. REPO is the
// checkout whose node_modules holds `ws` and `rolldown` (the PM checkout by default).
//
// TAPE=size-split adds the tape: the last 300 bars are the frozen Size-Split
// Delta fixture (`sizeSplitFixture()` in apps/web/src/lib/chart/validation/
// fixtures.ts, bundled with rolldown at startup), preceded by the synthetic
// walk ending at the fixture's open. The snapshot carries the fixture's last
// 20,000 prints as `aggressive_prints` at floor 0, so the browser's print store
// reads those windows as complete, and the forming minute's prints arrive as
// `trade` frames second by second; after the fixture's last bar the server
// cycles its bars 200..299 with prices continuing from the last close.
// POOL_BARS limits the pooled history to that many bars (0 for none, so the
// tape starts at connect and the learning states show); LOW_SHARE_MINUTE=n
// inflates the n-th live minute's candle volume to 2.6 times its prints, so the
// tape share gate refuses that bar (`Tape 38% · below 50%`).
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");

const repo = process.env.REPO ?? path.resolve(__dirname, "../../../../Terminal-L1-L2-development-indicator-sdk");
const requireFromRepo = createRequire(path.join(repo, "package.json"));
const { WebSocketServer } = requireFromRepo("ws");

const port = Number(process.argv[2] ?? 8001);
const barCount = Number(process.argv[3] ?? 900);
let seed = Number(process.argv[4] ?? 7);
const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const withTape = process.env.TAPE === "size-split";
const poolBars = process.env.POOL_BARS === undefined ? null : Number(process.env.POOL_BARS);
const lowShareMinute = process.env.LOW_SHARE_MINUTE === undefined ? null : Number(process.env.LOW_SHARE_MINUTE);

const identity = { provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT" };
const INTERVAL = 60_000;
const POOL_PRINTS = 20_000;
const openTime = Math.floor(Date.now() / INTERVAL) * INTERVAL;

/** The frozen fixture, bundled from the checkout this file lives in (the worktree), so the screenshots show the tested tape. */
async function loadSizeSplitFixture() {
  const { build } = requireFromRepo("rolldown");
  const source = path.resolve(__dirname, "../../../../apps/web/src/lib/chart/validation/fixtures.ts");
  const out = path.join(os.tmpdir(), `size-split-fixtures-${process.pid}.cjs`);
  await build({ input: source, platform: "node", output: { file: out, format: "cjs" }, logLevel: "silent" });
  const fixtures = require(out);
  return fixtures.sizeSplitFixture();
}

// A random walk with slow regime changes so RSI visits both bands and candles vary.
function syntheticBars(count, lastTsOpen, startPrice) {
  const bars = [];
  let price = startPrice;
  for (let i = 0; i < count; i += 1) {
    const regime = Math.sin(i / 55) * 18;
    const open = price;
    const close = Math.round((open + regime + (random() - 0.5) * 70) * 10) / 10;
    const high = Math.max(open, close) + random() * 25;
    const low = Math.min(open, close) - random() * 25;
    const volume = Math.round((4 + random() * 20 + Math.abs(close - open) / 10) * 1000) / 1000;
    const buy = Math.round(volume * (close >= open ? 0.52 + random() * 0.2 : 0.28 + random() * 0.2) * 1000) / 1000;
    bars.push({
      type: "bar", ...identity, interval_ms: INTERVAL, ts_open: lastTsOpen - (count - 1 - i) * INTERVAL,
      open, high: Math.round(high * 10) / 10, low: Math.round(low * 10) / 10, close, volume,
      buy_volume: buy, sell_volume: Math.round((volume - buy) * 1000) / 1000,
      trade_count: 40 + Math.floor(random() * 300), closed: true,
    });
    price = close;
  }
  return bars;
}

const shiftBar = (bar, tsShift, priceShift) => ({
  ...bar, ...identity, ts_open: bar.ts_open + tsShift,
  open: bar.open + priceShift, high: bar.high + priceShift, low: bar.low + priceShift, close: bar.close + priceShift,
});
const shiftPrint = (print, tsShift, priceShift, suffix = "") => ({
  type: "trade", ...identity, ts_exchange: print.ts_exchange + tsShift, price: Math.round((print.price + priceShift) * 100) / 100,
  size: print.size, side: print.side, trade_id: `${print.trade_id}${suffix}`,
});

async function main() {
  let closedBars;
  let pool = null;
  /** The minute being formed: its frame plus the prints still to be released, by offset inside the minute. */
  let forming;
  let pending = [];
  let sent = [];
  let cycle = 0;
  let fixture = null;

  if (withTape) {
    fixture = await loadSizeSplitFixture();
    const fixtureBars = fixture.bars.length;
    // Fixture bar i sits at openTime - (fixtureBars - 1 - i) minutes: its last bar is the forming minute.
    const tsShift = openTime - (fixtureBars - 1) * INTERVAL - fixture.bars[0].ts_open;
    const prefixCount = Math.max(0, barCount - fixtureBars);
    const prefix = syntheticBars(prefixCount, openTime - fixtureBars * INTERVAL, fixture.bars[0].open);
    const priceFix = prefix.length > 0 ? fixture.bars[0].open - prefix[prefix.length - 1].close : 0;
    for (const bar of prefix) { bar.open += priceFix; bar.high += priceFix; bar.low += priceFix; bar.close += priceFix; }
    const history = fixture.bars.slice(0, -1).map((bar) => shiftBar(bar, tsShift, 0));
    closedBars = [...prefix, ...history];
    const pooledBars = poolBars === null ? POOL_PRINTS / fixture.printsByBar[0].length : poolBars;
    const firstPoolBar = Math.max(0, fixtureBars - 1 - pooledBars);
    const poolPrints = [];
    for (let i = firstPoolBar; i < fixtureBars - 1; i += 1) for (const print of fixture.printsByBar[i]) poolPrints.push(shiftPrint(print, tsShift, 0));
    if (pooledBars > 0) pool = { aggressive_prints: poolPrints.slice(-POOL_PRINTS), aggressive_prints_floor: 0, aggressive_prints_from: history[firstPoolBar].ts_open };
    const last = fixture.bars[fixtureBars - 1];
    forming = { type: "bar", ...identity, interval_ms: INTERVAL, ts_open: openTime, open: last.open, high: last.open, low: last.open, close: last.open, volume: 0, buy_volume: 0, sell_volume: 0, trade_count: 0, closed: false };
    pending = fixture.printsByBar[fixtureBars - 1].map((print) => ({ offset: print.ts_exchange - last.ts_open, print: shiftPrint(print, tsShift, 0) }));
  } else {
    const bars = syntheticBars(barCount, openTime, 65_000);
    // Every snapshot bar must be closed (the parser refuses a forming bar there), so the
    // forming bar is a separate live `bar` frame for the current minute, revised every second.
    closedBars = bars.slice(0, -1);
    forming = { ...bars[bars.length - 1], ts_open: openTime, closed: false };
  }

  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, fixture: true, tape: withTape, symbol: identity.symbol, bars: closedBars.length + 1 }));
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  const send = (socket, frame) => { if (socket.readyState === 1) socket.send(JSON.stringify(frame)); };
  const broadcast = (frame) => { for (const socket of wss.clients) send(socket, frame); };
  const initialize = (socket) => {
    send(socket, { type: "selection", ...identity });
    send(socket, { type: "snapshot", ...identity, bars: closedBars, trades: sent, markers: [], ...(pool ?? {}) });
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

  /** The minute whose candle volume is inflated so the share gate refuses it (1 = the first live minute). */
  let minuteIndex = 1;
  /** Fold one print into the forming bar's candle. */
  const fold = (print) => {
    if (forming.volume === 0) { forming.open = print.price; forming.high = print.price; forming.low = print.price; }
    forming.close = print.price;
    forming.high = Math.max(forming.high, print.price);
    forming.low = Math.min(forming.low, print.price);
    forming.volume += lowShareMinute === minuteIndex ? print.size * 2.6 : print.size;
    if (print.side === "buy") forming.buy_volume += print.size; else forming.sell_volume += print.size;
    forming.trade_count += 1;
  };

  /** After the fixture's last minute: the next minute replays fixture bars 200..299 with prices continuing from the last close. */
  const nextMinute = () => {
    const sourceIndex = fixture.bars.length - 100 + (cycle % 100);
    cycle += 1;
    const source = fixture.bars[sourceIndex];
    const priceShift = Math.round((forming.close - source.open) * 100) / 100;
    const tsShift = forming.ts_open + INTERVAL - source.ts_open;
    forming = { type: "bar", ...identity, interval_ms: INTERVAL, ts_open: forming.ts_open + INTERVAL, open: forming.close, high: forming.close, low: forming.close, close: forming.close, volume: 0, buy_volume: 0, sell_volume: 0, trade_count: 0, closed: false };
    pending = fixture.printsByBar[sourceIndex].map((print) => ({ offset: print.ts_exchange - source.ts_open, print: shiftPrint(print, tsShift, priceShift, `-c${cycle}`) }));
    sent = [];
    minuteIndex += 1;
  };

  setInterval(() => {
    if (!withTape) {
      forming.close = Math.round((forming.close + (random() - 0.5) * 12) * 10) / 10;
      forming.high = Math.max(forming.high, forming.close);
      forming.low = Math.min(forming.low, forming.close);
      broadcast({ ...forming });
      return;
    }
    const elapsed = Date.now() - forming.ts_open;
    while (pending.length > 0 && pending[0].offset <= Math.min(elapsed, INTERVAL - 1)) {
      const { print } = pending.shift();
      fold(print);
      sent.push(print);
      broadcast(print);
    }
    if (elapsed >= INTERVAL) {
      const closed = { ...forming, closed: true };
      broadcast(closed);
      closedBars.push(closed);
      // A browser connecting later gets this minute's prints with the pool, as the runtime's pool would hold them.
      if (pool !== null) pool.aggressive_prints = [...pool.aggressive_prints, ...sent].slice(-POOL_PRINTS);
      else if (sent.length > 0) pool = { aggressive_prints: [...sent], aggressive_prints_floor: 0, aggressive_prints_from: forming.ts_open };
      nextMinute();
    }
    broadcast({ ...forming });
  }, 1000);

  server.listen(port, "127.0.0.1", () => {
    console.log(`fixture runtime on http://127.0.0.1:${port} (ws at /ws), ${closedBars.length + 1} synthetic 1m bars for ${identity.symbol}${withTape ? `, tape: ${pool ? `${pool.aggressive_prints.length} pooled prints from ${new Date(pool.aggressive_prints_from).toISOString()}` : "no pooled history"} plus live trade frames${lowShareMinute === null ? "" : `, low share on live minute ${lowShareMinute}`}` : ""}`);
  });
}

main().catch((error) => { console.error(error); process.exit(1); });
