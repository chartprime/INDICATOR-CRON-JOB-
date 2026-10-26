"use strict";

const { createHistoricalWallProjection } = require("../../../src/indicators/l2-memory/historical-wall-projection");
const { createHistoricalLevelEvents } = require("../../../src/indicators/l2-memory/historical-level-events");
const { createHistoricalTopNFrames } = require("../../../src/indicators/l2-memory/historical-topn-frames");
const { createHistoricalSourceRunner } = require("../../../src/indicators/l2-memory/historical-source-runner");
const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");
const { createWallService } = require("../../../src/indicators/l2-memory/wall-service");
const { sampleLiquidityColumn } = require("../../../src/indicators/passive_liquidity/liquidity-sampler");
const { tradeFrame } = require("../../../src/indicators/l2-memory/input-frames");

const identity = { derivationId: "a".repeat(64), instrumentId: "ES", tickSize: "1" };
const options = { minSize: 40, multiplier: 0, gapRows: 0, settleMs: 1000, keepEndedMs: 7200000, maxLevels: 60 };
const book = { bids: [{ price: "99", size: "80" }, { price: "98", size: "8" }],
  asks: [{ price: "101", size: "90" }, { price: "102", size: "7" }] };

function harness() {
  const engine = createMemoryEngine({ tickSize: 1, snapshotDepth: 2 });
  const runner = createHistoricalSourceRunner({ createEngine: () => engine });
  const source = createHistoricalTopNFrames({ depthLimit: 2 });
  const observer = createHistoricalLevelEvents({ ...identity, depthLimit: 2, seedKey: ["1000000000", "2", "0", "0"] });
  const projection = createHistoricalWallProjection({ ...identity, trackerOptions: options, windowRows: 10, referenceRows: 10 });
  const trades = [], wallTrades = [];
  const service = createWallService({ engine, ...options, onTrades: (rows) => trades.push(...rows), onWallTrade: (row) => wallTrades.push(row) });
  let index = 0, key = null, lastRows = null;
  function step(ms, changes = {}, trade = null) {
    key = [String(ms * 1000000), "2", String(index++), "0"];
    const transition = source.push({ event_ns: key[0], source_rank: key[1], stable_position: key[2], ordinal: key[3],
      instrument_id: "ES", depth_action: "SNAPSHOT", depth_model: "TOP_N", depth_limit: 2, continuity: "OK",
      book_epoch: "1", date: "2026-08-05", ...book, ...changes }, { observationOnly: trade !== null });
    runner.applyTransition(transition);
    if (trade) runner.applyTransition({ restartEngine: false, frames: [tradeFrame(ms, trade.price, trade.size, trade.side, `trade:${key[2]}`)] });
    lastRows = observer.capture(engine, { sourceKey: key, knownNs: key[0], bookFrame: transition.frames.find((frame) => frame.kind === "book") });
    projection.consume(lastRows);
    return lastRows;
  }
  function tick(ms) {
    engine.prune(ms);
    const rows = observer.capture(engine, { sourceKey: key, knownNs: String(ms * 1000000), pruned: true });
    if (rows.length) projection.consume(rows);
    // A quiet capture can emit no rows. Sampling is valid only at the last recorded knowledge cut.
    const cut = rows.at(-1)?.known_ns ?? lastRows.at(-1).known_ns;
    const ts = Number(BigInt(cut) / 1000000n);
    const snapshot = engine.liteSnapshot();
    service.update({ ts, snapshot, column: sampleLiquidityColumn(snapshot, { ts, rowClusters: 1, windowRows: 10 }), rowClusters: 1, referenceRows: 10 });
    const result = projection.sample(cut);
    expect(result.walls).toEqual(service.walls());
    expect(result.lifecycle).toEqual(service.drainLifecycle().records);
    expect(result.trades).toEqual(trades.splice(0));
    expect(result.wall_trades).toEqual(wallTrades.splice(0));
    expect(Object.isFrozen(result.walls)).toBe(true);
    lastRows = rows.length ? rows : lastRows;
    return result;
  }
  return { engine, observer, projection, step, tick, get key() { return key; } };
}

test("recorded engine state and events reproduce native wall evidence, including a wall formed before the displayed window", () => {
  const h = harness();
  h.step(1000); const first = h.tick(1000);
  expect(first.walls).toHaveLength(2);
  h.step(2000, {}, { side: "buy", price: "101", size: "30" });
  const traded = h.tick(2000);
  expect(traded.walls.find((wall) => wall.side === "ask").detail.traded).toBe(30);
  expect(traded.walls[0].startTs).toBe(first.walls[0].startTs);
  h.step(3000, { asks: [{ price: "101", size: "60" }, book.asks[1]] }); h.tick(3000);
  h.step(4000, { asks: [book.asks[1], { price: "103", size: "6" }] }); h.tick(4000);
  h.step(6000, { asks: [book.asks[1], { price: "103", size: "6" }] }); h.tick(6000);
});

test("depth exits invalidate walls without assigning cancellation, and returning observations reproduce native evidence", () => {
  const h = harness(); h.step(1000); h.tick(1000);
  h.step(2000, { bids: [{ price: "101", size: "4" }, { price: "100", size: "5" }],
    asks: [book.asks[1], { price: "103", size: "6" }] }); const exited = h.tick(2000);
  expect(exited.lifecycle.some((event) => event.kind === "wall_unobserved")).toBe(true);
  h.step(3000); h.tick(3000);
});

test("an arbitrary event slice cannot seed a complete wall projection", () => {
  const h = harness(); const seed = h.step(1000);
  const other = createHistoricalWallProjection({ ...identity, trackerOptions: options });
  expect(() => other.consume(seed.slice(1))).toThrow(/prefix/);
  expect(() => other.consume(seed)).toThrow(/failed/);
});

test("missing events, changed identity and regressing knowledge poison the projection", () => {
  for (const mutate of [
    (row) => ({ ...row, event_seq: row.event_seq + 1 }),
    (row) => ({ ...row, derivation_id: "b".repeat(64) }),
    (row) => ({ ...row, known_ns: "0" }),
  ]) {
    const h = harness(); h.step(1000);
    const rows = h.step(2000, { asks: [{ price: "101", size: "70" }, book.asks[1]] });
    const other = createHistoricalWallProjection({ ...identity, trackerOptions: options });
    const fresh = harness(); other.consume(fresh.step(1000));
    expect(() => other.consume([mutate(rows[0]), ...rows.slice(1)])).toThrow();
    expect(() => other.sample("2000000000")).toThrow(/failed/);
  }
});

test("future sampling and replaying the same sample are refused", () => {
  const h = harness(); h.step(1000);
  expect(() => h.projection.sample("2000000000")).toThrow(/current prefix/);
  const other = harness(); other.step(1000); other.tick(1000);
  expect(() => other.projection.sample("1000000000")).toThrow(/current prefix/);
});

test("segment closure clears the ledger and makes further sampling unavailable", () => {
  const h = harness(); h.step(1000); h.tick(1000);
  h.projection.consume(h.observer.close(h.engine, { sourceKey: h.key, knownNs: "2000000000", cause: "EOF" }));
  expect(h.projection.closed).toBe(true);
  expect(() => h.projection.sample("1000000000")).toThrow(/closed/);
});

function burst(h, count, payloadExtra = {}, tradeEvery = 3) {
  const rows = h.step(2000, {}, { side: "buy", price: "101", size: "1" });
  const template = rows.find((row) => row.event_type === "engine_trade");
  const firstEvent = h.projection.nextSeq, firstEngine = h.engine.eventHead();
  for (let start = 0; start < count; start += 128) {
    h.projection.consume(Array.from({ length: Math.min(128, count - start) }, (_, index) => {
      const i = start + index;
      const type = i % tradeEvery === 0 ? "trade" : "appeared";
      return { ...template, event_type: `engine_${type}`, event_seq: firstEvent + i,
        known_key: ["2000000000", "2", String(i + 2), "0"],
        payload: { ...(type === "trade" ? template.payload : { ts: template.payload.ts, side: template.payload.side, key: template.payload.key }),
          ...payloadExtra, type, seq: firstEngine + i } };
    }));
  }
}

test("a busy second above 8192 events retains every individual trade and drains its bounded queue", () => {
  const h = harness(); h.step(1000); h.tick(1000);
  burst(h, 9000);
  const view = h.projection.sample("2000000000");
  expect(view.trades).toHaveLength(3001);
  expect(view.trades.reduce((sum, row) => sum + row.size, 0)).toBe(3001);
  expect(view.walls.find((wall) => wall.side === "ask").detail.traded).toBe(3001);
});

test("an auction second above 49160 events preserves the complete engine prefix", () => {
  const h = harness(); h.step(1000); h.tick(1000);
  burst(h, 50000, {}, 100);
  const view = h.projection.sample("2000000000");
  expect(view.trades).toHaveLength(501);
  expect(view.trades.reduce((sum, row) => sum + row.size, 0)).toBe(501);
  expect(view.walls.find((wall) => wall.side === "ask").detail.traded).toBe(501);
});

test("pending event count and decoded bytes each fail closed instead of dropping burst evidence", () => {
  for (const [count, extra, tradeEvery] of [[65536, {}, 65536], [300, { note: "x".repeat(30000) }, 3]]) {
    const h = harness(); h.step(1000); h.tick(1000);
    expect(() => burst(h, count, extra, tradeEvery)).toThrow(/pending engine event budget/);
    expect(() => h.projection.sample("2000000000")).toThrow(/failed/);
  }
});
