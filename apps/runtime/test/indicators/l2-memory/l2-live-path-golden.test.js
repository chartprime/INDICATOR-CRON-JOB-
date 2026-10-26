"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { createLiveMemoryBinding } = require("../../../src/indicators/l2-memory/live-binding");
const { createDxFeedLiquidityBinding } = require("../../../src/indicators/passive_liquidity/dxfeed-liquidity-binding");

// Golden output of the two live input paths into the L2 engine, frozen before
// report 61 P4f moved them onto one input binding. A seeded synthetic market
// drives the Binance live binding (DEPTH/TRADE envelopes, light and full book
// states, a feed gap and resync, the wall-clock prune timer) and the dxFeed
// live binding (an assembler stand-in with a snapshot restart and an
// unavailable stretch, a function book source, trailing-timer coalescing).
// Any later change must reproduce these outputs exactly, or name the
// difference and regenerate with UPDATE_L2_LIVE_GOLDEN=1.

const GOLDEN_PATH = path.join(__dirname, "..", "..", "fixtures", "golden", "l2-live-path-p4f.json");
const T0 = 1_780_000_000_000;
const STEP_MS = 250;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");

function createRecorder() {
  const events = crypto.createHash("sha256");
  const lite = crypto.createHash("sha256");
  const ladder = crypto.createHash("sha256");
  let cursor = 0;
  let samples = 0;
  let eventCount = 0;
  return {
    sample(engine) {
      if (!engine || !engine.seeded) return;
      const read = engine.events(cursor);
      cursor = read.nextSeq;
      eventCount += read.events.length;
      events.update(JSON.stringify(read.events));
      lite.update(JSON.stringify(engine.liteSnapshot()));
      ladder.update(JSON.stringify([engine.ladder({ side: "bid", depth: 20 }), engine.ladder({ side: "ask", depth: 20 }), engine.segment, engine.live]));
      samples += 1;
    },
    finish(engine) {
      const { pendingPrints, ...stats } = engine.stats;
      return { samples, eventCount, eventsSha256: events.digest("hex"), liteSha256: lite.digest("hex"), ladderSha256: ladder.digest("hex"), stats, pendingPrints };
    },
  };
}

function createSyntheticBook(rand, tickSize, midTick, depthTicks) {
  const sides = { bid: new Map(), ask: new Map() };
  const priceOf = (tick) => Number((tick * tickSize).toFixed(8));
  for (let offset = 1; offset <= depthTicks; offset += 1) {
    sides.bid.set(midTick - offset, 1 + Math.floor(rand() * 20));
    sides.ask.set(midTick + offset, 1 + Math.floor(rand() * 20));
  }
  const sorted = (side) => [...sides[side].entries()]
    .sort((a, b) => (side === "bid" ? b[0] - a[0] : a[0] - b[0]))
    .map(([tick, size]) => [String(priceOf(tick)), String(size)]);
  function step(mid) {
    const changes = { bid: [], ask: [] };
    for (let n = 0; n < 6; n += 1) {
      const side = rand() < 0.5 ? "bid" : "ask";
      const offset = 1 + Math.floor(rand() * depthTicks);
      const tick = side === "bid" ? mid - offset : mid + offset;
      const size = rand() < 0.15 ? 0 : 1 + Math.floor(rand() * (rand() < 0.05 ? 400 : 25));
      if (size === 0) sides[side].delete(tick);
      else sides[side].set(tick, size);
      changes[side].push([String(priceOf(tick)), String(size)]);
    }
    for (const tick of [...sides.bid.keys()]) if (tick >= mid) sides.bid.delete(tick);
    for (const tick of [...sides.ask.keys()]) if (tick <= mid) sides.ask.delete(tick);
    return changes;
  }
  return { sides, sorted, step, priceOf };
}

async function microtasks() {
  for (let n = 0; n < 6; n += 1) await Promise.resolve();
}

async function simulateBinance({ seed, seconds }) {
  jest.useFakeTimers({ now: T0 });
  try {
    const rand = mulberry32(seed);
    const tickSize = 0.1;
    let mid = 20_000;
    const book = createSyntheticBook(rand, tickSize, mid, 80);
    const binding = createLiveMemoryBinding({
      tickSizeResolver: { getBinanceTickSize: async () => tickSize },
      clusterTicks: 5,
      ledgerOptions: { minSliceSize: 2 },
      geometryFor: () => null,
      log: () => {},
    });
    binding.start();
    const recorder = createRecorder();
    const iso = (ms) => new Date(ms).toISOString();
    const gapFrom = Math.floor(seconds * 2);
    const gapTo = gapFrom + 10;
    let light = 0;
    let full = 0;
    for (let step = 0; step <= seconds * 4; step += 1) {
      const ts = T0 + step * STEP_MS;
      jest.setSystemTime(ts);
      if (step > 0 && rand() < 0.2) mid += rand() < 0.5 ? -1 : 1;
      const changes = step === 0 ? { bid: [], ask: [] } : book.step(mid);
      const envelope = { eventType: "DEPTH", marketKind: "PERPETUAL", providerSymbol: "BTCUSDT", eventTime: iso(ts), state: "READY", payload: { bids: changes.bid, asks: changes.ask } };
      const fullState = () => ({ status: "READY", book: { bids: book.sorted("bid"), asks: book.sorted("ask"), lastUpdateId: step } });
      if (step >= gapFrom && step < gapTo) {
        binding.onDepth(step % 2 === 0 ? { ...envelope, state: "UNAVAILABLE" } : envelope, { status: "BUFFERING" }, fullState);
      } else if (Math.floor(step / 120) % 2 === 1) {
        const bids = book.sorted("bid");
        const asks = book.sorted("ask");
        binding.onDepth(envelope, { status: "READY", bestBid: bids[0]?.[0] ?? null, bestAsk: asks[0]?.[0] ?? null }, fullState);
        light += 1;
      } else {
        binding.onDepth(envelope, fullState(), fullState);
        full += 1;
      }
      if (step === 0) await microtasks();
      const tradeCount = Math.floor(rand() * 3);
      for (let n = 0; n < tradeCount; n += 1) {
        const isBuyerMaker = rand() < 0.5;
        const price = book.priceOf(isBuyerMaker ? mid - 1 : mid + 1);
        binding.onTrade({ eventType: "TRADE", marketKind: "PERPETUAL", providerSymbol: "BTCUSDT", eventTime: iso(ts - Math.floor(rand() * 400)), state: "READY", payload: { tradeId: step * 10 + n, price: String(price), quantity: String(1 + Math.floor(rand() * 30)), isBuyerMaker } });
      }
      jest.advanceTimersByTime(STEP_MS);
      if (step % 4 === 0) recorder.sample(binding.getEngine("PERPETUAL", "BTCUSDT"));
    }
    const engine = binding.getEngine("PERPETUAL", "BTCUSDT");
    const result = { ...recorder.finish(engine), light, full };
    binding.stop();
    return result;
  } finally {
    jest.useRealTimers();
  }
}

function createAssemblerStandIn(book) {
  let status = "READY";
  let snapshots = 1;
  let pending = { bids: [], asks: [] };
  return {
    record(changes) {
      pending.bids.push(...changes.bid);
      pending.asks.push(...changes.ask);
    },
    setStatus(next) {
      status = next;
    },
    restart() {
      snapshots += 1;
    },
    getStatus: () => ({ status }),
    getSnapshotCount: () => snapshots,
    drainLevelChanges() {
      const drained = pending;
      pending = { bids: [], asks: [] };
      return drained;
    },
    getBestPrices() {
      const bids = book.sorted("bid");
      const asks = book.sorted("ask");
      return { bestBid: bids[0]?.[0] ?? null, bestAsk: asks[0]?.[0] ?? null };
    },
    getState: () => (status === "READY" ? { status, book: { bids: book.sorted("bid"), asks: book.sorted("ask") } } : { status }),
  };
}

function simulateDxFeed({ seed, seconds }) {
  const rand = mulberry32(seed);
  const tickSize = 0.25;
  let mid = 80_000;
  const book = createSyntheticBook(rand, tickSize, mid, 40);
  let clock = T0;
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
  const fireDue = () => {
    for (;;) {
      timers.sort((a, b) => a.due - b.due || a.seq - b.seq);
      if (timers.length === 0 || timers[0].due > clock) return;
      timers.shift().fn();
    }
  };
  const instrument = { assetClass: "FUTURE", symbol: "/NQZ26:XCME", tickSize };
  const binding = createDxFeedLiquidityBinding({ instruments: [instrument], now: () => clock, setTimer, clearTimer, log: () => {} });
  const assembler = createAssemblerStandIn(book);
  const recorder = createRecorder();
  const restartAt = Math.floor(seconds * 1.5);
  const outFrom = Math.floor(seconds * 2.5);
  const outTo = outFrom + 12;
  const functionFrom = Math.floor(seconds * 3.2);
  const functionTo = functionFrom + 40;
  let orders = 0;
  for (let step = 0; step <= seconds * 4; step += 1) {
    for (let burst = 0; burst < 3; burst += 1) {
      clock = T0 + step * STEP_MS + burst * 60;
      fireDue();
      if (rand() < 0.1) mid += rand() < 0.5 ? -1 : 1;
      const changes = book.step(mid);
      assembler.record(changes);
      if (step === restartAt && burst === 0) assembler.restart();
      assembler.setStatus(step >= outFrom && step < outTo ? "UNAVAILABLE" : "READY");
      const source = step >= functionFrom && step < functionTo ? () => assembler.getState() : assembler;
      binding.noteBook(instrument.assetClass, instrument.symbol, source, clock);
      orders += 1;
      if (rand() < 0.3) {
        const side = rand() < 0.5 ? "buy" : "sell";
        binding.onTrade(instrument.assetClass, instrument.symbol, { ts: clock - Math.floor(rand() * 300), price: book.priceOf(side === "buy" ? mid + 1 : mid - 1), size: 1 + Math.floor(rand() * 10), side, tradeId: `t${step}-${burst}` });
      }
    }
    if (step === outTo) binding.markUnavailable(instrument.assetClass, instrument.symbol);
    if (step % 4 === 0) recorder.sample(binding.getEngine(instrument.assetClass, instrument.symbol));
  }
  clock += 10_000;
  fireDue();
  binding.flushAll();
  const result = { ...recorder.finish(binding.getEngine(instrument.assetClass, instrument.symbol)), orders };
  binding.stop();
  return result;
}

describe("L2 live input paths golden output (report 61 P4f baseline)", () => {
  let results;

  beforeAll(async () => {
    results = {
      binanceLive: await simulateBinance({ seed: 71, seconds: 600 }),
      dxfeedLive: simulateDxFeed({ seed: 72, seconds: 600 }),
    };
    if (process.env.UPDATE_L2_LIVE_GOLDEN === "1") {
      fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
      fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify(results, null, 2)}\n`);
    }
  });

  test.each(["binanceLive", "dxfeedLive"])("%s reproduces the frozen engine events, ledger and ladder", (name) => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"));
    expect(results[name]).toEqual(golden[name]);
  });

  test("the scenarios exercise the paths they claim to", () => {
    const binance = results.binanceLive;
    expect(binance.light).toBeGreaterThan(200);
    expect(binance.full).toBeGreaterThan(200);
    expect(binance.stats.resyncs).toBeGreaterThanOrEqual(1);
    expect(binance.stats.unavailable).toBeGreaterThanOrEqual(1);
    expect(binance.stats.trades).toBeGreaterThan(500);
    expect(binance.eventCount).toBeGreaterThan(1_000);
    const dxfeed = results.dxfeedLive;
    expect(dxfeed.stats.resyncs).toBeGreaterThanOrEqual(2);
    expect(dxfeed.stats.unavailable).toBeGreaterThanOrEqual(2);
    expect(dxfeed.stats.deltas).toBeGreaterThan(1_000);
    expect(dxfeed.stats.trades).toBeGreaterThan(500);
    expect(dxfeed.eventCount).toBeGreaterThan(1_000);
    expect(sha(JSON.stringify(binance))).not.toBe(sha(JSON.stringify(dxfeed)));
  });
});
