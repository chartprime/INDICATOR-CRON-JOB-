"use strict";

const { createHistoricalWallStream } = require("../../../src/indicators/l2-memory/historical-wall-stream");
const { createHistoricalWallProjection } = require("../../../src/indicators/l2-memory/historical-wall-projection");
const { createHistoricalLevelEvents } = require("../../../src/indicators/l2-memory/historical-level-events");
const { createHistoricalTopNFrames } = require("../../../src/indicators/l2-memory/historical-topn-frames");
const { createHistoricalSourceRunner } = require("../../../src/indicators/l2-memory/historical-source-runner");
const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");
const { createWallService } = require("../../../src/indicators/l2-memory/wall-service");
const { sampleLiquidityColumn } = require("../../../src/indicators/passive_liquidity/liquidity-sampler");
const { tradeFrame } = require("../../../src/indicators/l2-memory/input-frames");
const { historicalWallProfile } = require("../../../src/indicators/l2-memory/historical-wall-profile");

const identity = { derivationId: "a".repeat(64), instrumentId: "ES", tickSize: "1" };
const options = { minSize: 40, multiplier: 0, gapRows: 0, settleMs: 1000, keepEndedMs: 7200000, maxLevels: 60 };
const projectionOptions = { ...identity, trackerOptions: options, rowClusters: 1, windowRows: 10, referenceRows: 10, fold: "max" };
const initial = { bids: [{ price: "99", size: "80" }, { price: "98", size: "8" }],
  asks: [{ price: "101", size: "90" }, { price: "102", size: "7" }] };
const steps = [
  { ms: 1000, book: initial },
  { ms: 1200, book: initial },
  { ms: 2500, book: { ...initial, asks: [{ price: "101", size: "70" }, initial.asks[1]] } },
  { ms: 3000, book: initial },
  { ms: 3000, book: { ...initial, asks: [{ price: "101", size: "100" }, initial.asks[1]] } },
  { ms: 3500, book: { ...initial, asks: [{ price: "101", size: "100" }, initial.asks[1]] }, trade: { side: "buy", price: "101", size: "30" } },
  { ms: 7000, book: initial },
];

function native({ collect = false, offset = 0, settings = projectionOptions } = {}) {
  const engine = createMemoryEngine({ tickSize: 1, snapshotDepth: 2 });
  const runner = createHistoricalSourceRunner({ createEngine: () => engine });
  const source = createHistoricalTopNFrames({ depthLimit: 2 });
  const observer = createHistoricalLevelEvents({ ...identity, depthLimit: 2, seedKey: [String((1000 + offset) * 1000000), "2", "0", "0"] });
  const trades = [], wallTrades = [], samples = [], rows = [];
  const service = createWallService({ engine, ...settings.trackerOptions, onTrades: (value) => trades.push(...value), onWallTrade: (value) => wallTrades.push(value) });
  let position = 0, lastKey = null;
  function apply(step) {
    lastKey = [String(step.ms * 1000000), "2", String(position++), "0"];
    const transition = source.push({ event_ns: lastKey[0], source_rank: lastKey[1], stable_position: lastKey[2], ordinal: lastKey[3],
      instrument_id: "ES", depth_action: "SNAPSHOT", depth_model: "TOP_N", depth_limit: 2, continuity: "OK",
      book_epoch: "1", date: "2026-08-05", ...step.book }, { observationOnly: Boolean(step.trade) });
    runner.applyTransition(transition);
    if (step.trade) runner.applyTransition({ restartEngine: false, frames: [tradeFrame(step.ms, step.trade.price, step.trade.size, step.trade.side, `trade:${lastKey[2]}`)] });
    if (collect) rows.push(...observer.capture(engine, { sourceKey: lastKey, knownNs: lastKey[0], bookFrame: transition.frames.find((frame) => frame.kind === "book") }));
  }
  if (collect) {
    steps.forEach((step) => apply({ ...step, ms: step.ms + offset }));
    rows.push(...observer.close(engine, { sourceKey: lastKey, knownNs: String((9000 + offset) * 1000000), cause: "EOF" }));
    return { rows: rows.map((row, index) => ({ ...row, append_position: String(index) })) };
  }
  let index = 0;
  for (let ts = 1000 + offset; ts < 9000 + offset; ts += 1000) {
    while (index < steps.length && steps[index].ms + offset <= ts) {
      const step = steps[index++]; apply({ ...step, ms: step.ms + offset });
    }
    const snapshot = engine.liteSnapshot();
    service.update({ ts, snapshot, column: sampleLiquidityColumn(snapshot, { ts, rowClusters: settings.rowClusters,
      windowRows: settings.windowRows, fold: settings.fold }), rowClusters: settings.rowClusters, referenceRows: settings.referenceRows });
    samples.push({ known_ns: String(ts * 1000000), walls: service.walls(), lifecycle: service.drainLifecycle().records,
      trades: trades.splice(0), wall_trades: wallTrades.splice(0) });
  }
  return { samples };
}

function stream(rows, overrides = {}) {
  const samples = [], ends = [];
  const value = createHistoricalWallStream({ ...projectionOptions, manifestSha256: "b".repeat(64), expectedRows: rows.length,
    fromNs: "0", toNs: "10000000000", onSample: (sample) => samples.push(sample), onSegmentEnd: (end) => ends.push(end), ...overrides });
  return { value, samples, ends };
}

test("uniform samples, including quiet intervals and timestamp ties, equal an independent native engine/wall-service walk", () => {
  const { rows } = native({ collect: true });
  const expected = native().samples;
  for (const pageSize of [1, 7, rows.length]) {
    const h = stream(rows);
    for (let start = 0; start < rows.length; start += pageSize) h.value.consume(rows.slice(start, start + pageSize));
    const proof = h.value.finish();
    expect(h.samples.map(({ known_ns, walls, lifecycle, trades, wall_trades }) => ({ known_ns, walls, lifecycle, trades, wall_trades }))).toEqual(expected);
    expect(proof).toMatchObject({ samples: 8, processed_samples: 8, segments: 1, rows: rows.length });
    expect(h.ends).toEqual([{ segment_id: rows[0].segment_id, known_ns: "9000000000", cause: "EOF" }]);
    expect(h.samples.find((s) => s.known_ns === "2000000000").observed_through_ns).toBe("1000000000");
    expect(Object.isFrozen(h.samples[0].walls)).toBe(true);
  }
});

test("a later display window warms the entire earlier prefix without moving wall births or losing earlier fills", () => {
  const { rows } = native({ collect: true });
  const h = stream(rows, { fromNs: "4000000000", toNs: "7000000000" });
  h.value.consume(rows);
  const proof = h.value.finish();
  expect(h.samples.map(({ known_ns, walls, lifecycle, trades, wall_trades }) => ({ known_ns, walls, lifecycle, trades, wall_trades })))
    .toEqual(native().samples.filter((sample) => BigInt(sample.known_ns) >= 4000000000n && BigInt(sample.known_ns) < 7000000000n));
  expect(proof).toMatchObject({ samples: 3, processed_samples: 8 });
  expect(h.samples[0].walls.find((wall) => wall.side === "ask").detail.traded).toBe(30);
});

test("every sample and completion proof bind the immutable effective settings, not later caller mutations", () => {
  const { rows } = native({ collect: true });
  const callerOptions = { ...options };
  const expected = historicalWallProfile({ ...projectionOptions, trackerOptions: callerOptions });
  const h = stream(rows, { trackerOptions: callerOptions });
  callerOptions.minSize = 10000;
  h.value.consume(rows);
  expect(h.value.finish()).toMatchObject({ schema: "historical-l2-wall-stream-proof/2", profile_id: expected.id, profile: expected.profile });
  expect(h.samples.every((sample) => sample.schema === "historical-l2-wall-view/2" && sample.profile_id === expected.id)).toBe(true);
  expect(h.samples.map(({ known_ns, walls, lifecycle, trades, wall_trades }) => ({ known_ns, walls, lifecycle, trades, wall_trades })))
    .toEqual(native().samples);
});

test.each([
  { rowClusters: 1, windowRows: 8, referenceRows: 4, trackerOptions: { ...options, minSize: 20, gapRows: 1, settleMs: 0 } },
  { rowClusters: 2, windowRows: 16, referenceRows: 10, trackerOptions: { ...options, minSize: 40, multiplier: 1.2, gapRows: 2 } },
  { rowClusters: 4, windowRows: 8, referenceRows: 4, trackerOptions: { ...options, minSize: 100, multiplier: 3, settleMs: 5000 } },
])("changed geometry and thresholds reproduce the native tracker: %j", (changed) => {
  const settings = { ...projectionOptions, ...changed };
  const { rows } = native({ collect: true });
  const h = stream(rows, settings);
  for (let start = 0; start < rows.length; start += 3) h.value.consume(rows.slice(start, start + 3));
  h.value.finish();
  expect(h.samples.map(({ known_ns, walls, lifecycle, trades, wall_trades }) => ({ known_ns, walls, lifecycle, trades, wall_trades })))
    .toEqual(native({ settings }).samples);
});

test("separate segments reset wall evidence and never emit across their unobserved gap", () => {
  const rows = [...native({ collect: true }).rows, ...native({ collect: true, offset: 10000 }).rows]
    .map((row, index) => ({ ...row, append_position: String(index) }));
  const h = stream(rows, { toNs: "20000000000" });
  for (const row of rows) h.value.consume([row]);
  expect(h.value.finish()).toMatchObject({ segments: 2, samples: 16, processed_samples: 16 });
  const expected = [...native().samples, ...native({ offset: 10000 }).samples];
  expect(h.samples.map(({ known_ns, walls, lifecycle, trades, wall_trades }) => ({ known_ns, walls, lifecycle, trades, wall_trades })))
    .toEqual(expected);
  expect(h.ends).toHaveLength(2);
});

test.each([
  (rows) => rows.slice(1),
  (rows) => [rows[0], ...rows.slice(2)],
  (rows) => rows.map((row, index) => index === 1 ? { ...row, append_position: "0" } : row),
  (rows) => rows.map((row, index) => index === 1 ? { ...row, derivation_id: "c".repeat(64) } : row),
])("missing/duplicate/rebound prefixes cannot complete and poison the stream", (mutate) => {
  const { rows } = native({ collect: true });
  const h = stream(rows);
  expect(() => { h.value.consume(mutate(rows)); h.value.finish(); }).toThrow();
  expect(() => h.value.finish()).toThrow(/failed/);
});

test("truncated input and an absent terminal closure cannot produce a completed index", () => {
  const { rows } = native({ collect: true });
  const h = stream(rows);
  h.value.consume(rows.slice(0, -1));
  expect(() => h.value.finish()).toThrow(/incomplete/);
  const missingClose = rows.slice(0, -1);
  const other = stream(missingClose);
  other.value.consume(missingClose);
  expect(() => other.value.finish()).toThrow(/closure/);
});

test("a quiet time is admitted only below a contiguous next-record boundary; that next record remains unapplied", () => {
  const { rows } = native({ collect: true });
  const initialRows = rows.filter((row) => row.known_ns === "1000000000");
  const next = rows[initialRows.length];
  const projection = createHistoricalWallProjection(projectionOptions);
  projection.consume(initialRows);
  projection.sealBefore(next);
  const quiet = projection.sample("2000000000");
  expect(quiet.through_event_seq).toBe(initialRows.at(-1).event_seq);
  expect(quiet.observed_through_ns).toBe("1000000000");
  expect(() => projection.sample(next.known_ns)).toThrow(/current prefix/);
});

test("a late row after sampling, a fake continuation and callback failure fail closed", () => {
  const { rows } = native({ collect: true });
  const initialRows = rows.filter((row) => row.known_ns === "1000000000");
  const next = rows[initialRows.length];
  const projection = createHistoricalWallProjection(projectionOptions);
  projection.consume(initialRows); projection.sample("1000000000");
  expect(() => projection.consume([{ ...next, known_ns: "1000000000" }])).toThrow(/prefix/);
  const other = createHistoricalWallProjection(projectionOptions);
  other.consume(initialRows);
  expect(() => other.sealBefore({ ...next, event_seq: next.event_seq + 1 })).toThrow(/contiguous/);
  const h = stream(rows, { onSample: () => { throw new Error("disk full"); } });
  expect(() => h.value.consume(rows)).toThrow("disk full");
  expect(() => h.value.finish()).toThrow(/failed/);
});

test.each(["onSample", "onSegmentEnd"])("an asynchronous %s callback cannot certify unfinished output", (name) => {
  const { rows } = native({ collect: true });
  const h = stream(rows, { [name]: () => Promise.resolve() });
  expect(() => { h.value.consume(rows); h.value.finish(); }).toThrow(/synchronously/);
  expect(() => h.value.finish()).toThrow(/failed/);
});
