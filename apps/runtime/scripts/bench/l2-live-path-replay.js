"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const Database = require("better-sqlite3");
const { createReplaySource } = require("../../src/indicators/l2-memory/replay-source");
const { createLiveMemoryBinding } = require("../../src/indicators/l2-memory/live-binding");
const { createDxFeedLiquidityBinding } = require("../../src/indicators/passive_liquidity/dxfeed-liquidity-binding");
const { createDxFeedOrderBookAssembler } = require("../../src/providers/dxfeed/dxfeed-book-assembler");
const { isStoredDxFeedTimeAndSaleTapeRow, adaptStoredDxFeedTimeAndSaleRow } = require("../../src/providers/dxfeed/dxfeed-trade-adapter");
const { orderSourceFor, tickSizeFor } = require("../../src/providers/dxfeed/dxfeed-instrument-catalog");
const { dxfeedLiquidityFrame } = require("../../src/server/frames");
const { createPublisherCapture } = require("./publisher-capture");

const COLUMN_MS = 1_000;
const PRUNE_EVERY_MS = 30_000;
const LADDER_DEPTH = 50;
const LIGHT_EVERY_MS = 60_000;
const PUBLISHER_OPTIONS = Object.freeze({ deepS: 4 * 3_600, deepColumnMs: 10_000, coarseS: 8 * 3_600, coarseColumnMs: 300_000, storeS: 60 });

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    const [name, inline] = arg.slice(2).split("=", 2);
    options[name] = inline ?? argv[++index];
  }
  for (const required of ["provider", "symbol", "kind", "db"]) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  if (options.provider !== "binance" && options.provider !== "dxfeed") throw new Error("--provider must be binance or dxfeed");
  if (options.provider === "binance" && !(Number(options.tick) > 0)) throw new Error("--tick is required for binance");
  if ((options.from === undefined) !== (options.to === undefined)) throw new Error("--from and --to go together");
  if (options.from !== undefined) {
    options.fromTs = Date.parse(options.from);
    options.toTs = Date.parse(options.to);
    if (!Number.isSafeInteger(options.fromTs) || !Number.isSafeInteger(options.toTs) || options.toTs <= options.fromTs) throw new Error("--from/--to must be ISO times with from before to");
  }
  return options;
}

function dxfeedOrderRange(db, symbol, kind, orderSource, fromTs, toTs) {
  const bounds = db.prepare("SELECT (SELECT MIN(id) FROM dxfeed_order_book_capture) AS lo, (SELECT MAX(id) FROM dxfeed_order_book_capture) AS hi").get();
  if (bounds.lo === null) return null;
  const receivedAt = db.prepare("SELECT received_at FROM dxfeed_order_book_capture WHERE id >= ? ORDER BY id LIMIT 1");
  const firstIdAt = (ts) => {
    let lo = bounds.lo;
    let hi = bounds.hi + 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const row = receivedAt.get(mid);
      if (row !== undefined && row.received_at < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const windowFrom = firstIdAt(fromTs);
  const windowTo = firstIdAt(toTs + 10 * 60_000 + 1);
  const lookback = firstIdAt(Math.max(0, fromTs - 6 * 3_600_000));
  const snapshot = (lo, hi, order) => db.prepare(
    `SELECT id FROM dxfeed_order_book_capture WHERE id >= ? AND id < ? AND symbol = ? AND asset_class = ? AND source = ? AND (event_flags & 4) != 0 ORDER BY id ${order} LIMIT 1`,
  ).get(lo, hi, symbol, kind, orderSource);
  const anchor = snapshot(lookback, windowFrom, "DESC") ?? snapshot(windowFrom, windowTo, "ASC");
  return anchor ? { fromId: anchor.id, toId: windowTo } : null;
}

function percentiles(values) {
  if (values.length === 0) return { count: 0 };
  const sorted = Float64Array.from(values).sort();
  const at = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] * 1_000_000) / 1_000;
  return { count: sorted.length, p50Us: at(0.5), p99Us: at(0.99), maxUs: at(1) };
}

function createDigest({ engineOf, marketKind, symbol, rowClusters, provider, l2Identity }) {
  const events = crypto.createHash("sha256");
  const lite = crypto.createHash("sha256");
  const ladder = crypto.createHash("sha256");
  const counts = { columns: 0, events: 0 };
  let capture = null;
  let cursor = 0;
  let nextColumnTs = null;

  function sample(at, engine) {
    const read = engine.events(cursor);
    cursor = read.nextSeq;
    counts.events += read.events.length;
    events.update(JSON.stringify(read.events));
    lite.update(JSON.stringify(engine.liteSnapshot()));
    ladder.update(JSON.stringify([engine.ladder({ side: "bid", depth: LADDER_DEPTH }), engine.ladder({ side: "ask", depth: LADDER_DEPTH }), engine.segment, engine.live]));
    capture.tick(at);
    counts.columns += 1;
  }

  function advance(ts) {
    const engine = engineOf();
    if (engine === null || !engine.seeded || !Number.isSafeInteger(ts)) return;
    if (capture === null) {
      capture = createPublisherCapture({
        engine,
        marketKind,
        symbol,
        rowClusters,
        publisherOptions: { ...PUBLISHER_OPTIONS, ...(provider === "dxfeed" ? { buildFrame: dxfeedLiquidityFrame } : {}) },
        l2Identity,
      });
      nextColumnTs = (Math.floor(ts / COLUMN_MS) + 1) * COLUMN_MS;
    }
    while (ts >= nextColumnTs) {
      sample(nextColumnTs, engine);
      nextColumnTs += COLUMN_MS;
    }
  }

  function finish() {
    if (capture === null) throw new Error("the window held no seeded engine: nothing was captured");
    const result = capture.finish();
    const digests = {
      events: events.digest("hex"),
      lite: lite.digest("hex"),
      ladder: ladder.digest("hex"),
      publisher: crypto.createHash("sha256").update(JSON.stringify(result.digests)).digest("hex"),
      ...(result.l2 ? { l2: crypto.createHash("sha256").update(JSON.stringify(result.l2.digests)).digest("hex") } : {}),
    };
    return { counts, digests, liveSha256: crypto.createHash("sha256").update(JSON.stringify(digests)).digest("hex") };
  }

  return { advance, finish };
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function runBinance(options) {
  const { symbol, kind } = options;
  const tick = Number(options.tick);
  const db = new Database(options.db, { readonly: true, fileMustExist: true });
  const range = options.fromTs !== undefined
    ? { lo: options.fromTs, hi: options.toTs }
    : db.prepare("SELECT MIN(ts) lo, MAX(ts) hi FROM l2_depth_events WHERE symbol = ? AND market_kind = ?").get(symbol, kind);
  const source = createReplaySource({ db, symbol, marketKind: kind, fromTs: range.lo, toTs: range.hi, includeBuffering: true });
  const binding = createLiveMemoryBinding({ tickSizeResolver: { getBinanceTickSize: async () => tick }, log: () => {} });
  const digest = createDigest({
    engineOf: () => binding.getEngine(kind, symbol),
    marketKind: kind,
    symbol,
    rowClusters: null,
    provider: "binance",
    l2Identity: { provider: "BINANCE", symbol, marketKind: kind },
  });
  const timing = { depth: [], trade: [] };
  const inputs = { depth: 0, light: 0, full: 0, unavailable: 0, trade: 0 };
  let nextPruneTs = null;
  const iso = (ms) => new Date(ms).toISOString();
  for (const frame of source.frames()) {
    if (frame.kind === "anchor") continue;
    if (frame.kind === "trade") {
      const envelope = { eventType: "TRADE", marketKind: kind, providerSymbol: symbol, eventTime: iso(frame.ts), state: "READY", payload: { tradeId: frame.tradeId, price: frame.price, quantity: frame.size, isBuyerMaker: frame.side === "sell" } };
      const started = performance.now();
      binding.onTrade(envelope);
      timing.trade.push(performance.now() - started);
      inputs.trade += 1;
      digest.advance(frame.ts);
      continue;
    }
    const envelope = { eventType: "DEPTH", marketKind: kind, providerSymbol: symbol, eventTime: iso(frame.ts), state: "READY", payload: { bids: frame.delta.bids, asks: frame.delta.asks } };
    const full = () => (frame.status === "READY" ? { status: "READY", book: frame.book } : { status: frame.status });
    let state;
    if (frame.status !== "READY") {
      state = { status: frame.status };
      inputs.unavailable += 1;
    } else if (Math.floor(frame.ts / LIGHT_EVERY_MS) % 2 === 1) {
      state = { status: "READY", bestBid: frame.book.bids[0]?.[0] ?? null, bestAsk: frame.book.asks[0]?.[0] ?? null };
      inputs.light += 1;
    } else {
      state = full();
      inputs.full += 1;
    }
    const started = performance.now();
    binding.onDepth(envelope, state, full);
    timing.depth.push(performance.now() - started);
    inputs.depth += 1;
    if (binding.getEngine(kind, symbol) === null) await settle();
    const engine = binding.getEngine(kind, symbol);
    if (engine !== null && engine.seeded) {
      if (nextPruneTs === null) nextPruneTs = frame.ts + PRUNE_EVERY_MS;
      if (frame.ts >= nextPruneTs) {
        engine.prune(frame.ts);
        nextPruneTs = frame.ts + PRUNE_EVERY_MS;
      }
    }
    digest.advance(frame.ts);
  }
  binding.stop();
  db.close();
  return { window: { from: iso(range.lo), to: iso(range.hi) }, inputs, timing: { depth: percentiles(timing.depth), trade: percentiles(timing.trade) }, ...digest.finish() };
}

function runDxFeed(options) {
  const { symbol, kind } = options;
  const db = new Database(options.db, { readonly: true, fileMustExist: true });
  const orderSource = orderSourceFor(kind, symbol);
  const tickSize = tickSizeFor(kind, symbol);
  let clock = 0;
  let timerSeq = 0;
  const timers = [];
  const setTimer = (fn, ms) => {
    const timer = { due: clock + ms, seq: timerSeq++, fn, unref() {} };
    timers.push(timer);
    return timer;
  };
  const clearTimer = (timer) => {
    const index = timers.indexOf(timer);
    if (index !== -1) timers.splice(index, 1);
  };
  const fireDue = (until) => {
    for (;;) {
      timers.sort((a, b) => a.due - b.due || a.seq - b.seq);
      if (timers.length === 0 || timers[0].due > until) return;
      const timer = timers.shift();
      timer.fn();
    }
  };
  const binding = createDxFeedLiquidityBinding({ instruments: [{ assetClass: kind, symbol, tickSize }], now: () => clock, setTimer, clearTimer, log: () => {} });
  const assembler = createDxFeedOrderBookAssembler({ expectedSymbol: symbol, expectedAssetClass: kind, expectedSource: orderSource, now: () => clock });
  const digest = createDigest({
    engineOf: () => binding.getEngine(kind, symbol),
    marketKind: kind,
    symbol,
    rowClusters: binding.rowClusters(kind, symbol),
    provider: "dxfeed",
    l2Identity: { provider: "DXFEED", symbol, assetClass: kind },
  });
  const windowed = options.fromTs !== undefined;
  const orderRange = windowed ? dxfeedOrderRange(db, symbol, kind, orderSource, options.fromTs, options.toTs) : null;
  if (windowed && orderRange === null) throw new Error("no dxFeed order snapshot anchors that window");
  const orders = windowed
    ? db.prepare("SELECT id, event_time, order_index, event_flags, action, price, size, side, scope, source FROM dxfeed_order_book_capture WHERE id >= ? AND id < ? AND symbol = ? AND asset_class = ? AND source = ? ORDER BY id").iterate(orderRange.fromId, orderRange.toId, symbol, kind, orderSource)
    : db.prepare("SELECT id, event_time, order_index, event_flags, action, price, size, side, scope, source FROM dxfeed_order_book_capture WHERE symbol = ? AND asset_class = ? AND source = ? ORDER BY id").iterate(symbol, kind, orderSource);
  const tape = windowed
    ? db.prepare("SELECT * FROM dxfeed_time_and_sales WHERE symbol = ? AND asset_class = ? AND event_time >= ? AND event_time <= ? ORDER BY event_time, id").iterate(symbol, kind, options.fromTs - 6 * 3_600_000, options.toTs)
    : db.prepare("SELECT * FROM dxfeed_time_and_sales WHERE symbol = ? AND asset_class = ? ORDER BY event_time, id").iterate(symbol, kind);
  const requireValidTick = kind === "FUTURE";
  let pendingTape = tape.next();
  const timing = { order: [], trade: [] };
  const inputs = { order: 0, trade: 0, tapeSkipped: 0 };
  let first = null;

  function drainTapeUpTo(until) {
    while (!pendingTape.done && pendingTape.value.event_time <= until) {
      const row = pendingTape.value;
      pendingTape = tape.next();
      if (!isStoredDxFeedTimeAndSaleTapeRow(row, { requireValidTick })) {
        inputs.tapeSkipped += 1;
        continue;
      }
      const trade = adaptStoredDxFeedTimeAndSaleRow(row, { requireValidTick });
      if (trade.side === null) {
        inputs.tapeSkipped += 1;
        continue;
      }
      if (trade.tsExchange > clock) clock = trade.tsExchange;
      fireDue(clock);
      const started = performance.now();
      binding.onTrade(kind, symbol, { ts: trade.tsExchange, price: trade.price, size: trade.size, side: trade.side, tradeId: trade.tradeId });
      timing.trade.push(performance.now() - started);
      inputs.trade += 1;
      digest.advance(clock);
    }
  }

  for (const row of orders) {
    if (row.event_time > clock) clock = row.event_time;
    if (windowed && clock > options.toTs) break;
    if (first === null) first = row.event_time;
    drainTapeUpTo(clock);
    fireDue(clock);
    const envelope = {
      provider: "DXFEED", eventType: "ORDER", providerSymbol: symbol, assetClass: kind, state: "READY",
      eventTime: new Date(row.event_time).toISOString(),
      payload: { index: row.order_index, eventFlags: row.event_flags, action: row.action, price: row.price, size: row.size, side: row.side, scope: row.scope, source: row.source },
    };
    const started = performance.now();
    assembler.applyEventStatus(envelope);
    binding.noteBook(kind, symbol, assembler, row.event_time);
    timing.order.push(performance.now() - started);
    inputs.order += 1;
    digest.advance(clock);
  }
  drainTapeUpTo(windowed ? options.toTs : Infinity);
  fireDue(Infinity);
  digest.advance(clock + COLUMN_MS);
  binding.stop();
  db.close();
  return { window: { from: new Date(first).toISOString(), to: new Date(clock).toISOString() }, inputs, timing: { order: percentiles(timing.order), trade: percentiles(timing.trade) }, ...digest.finish() };
}

async function run(options) {
  const started = performance.now();
  const result = options.provider === "binance" ? await runBinance(options) : runDxFeed(options);
  return { kind: "l2-live-path-replay", provider: options.provider, symbol: options.symbol, instrumentKind: options.kind, ...result, wallMs: Math.round(performance.now() - started) };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = await run(options);
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (options.out) fs.writeFileSync(options.out, text);
  process.stdout.write(text);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { run, parseArgs };
