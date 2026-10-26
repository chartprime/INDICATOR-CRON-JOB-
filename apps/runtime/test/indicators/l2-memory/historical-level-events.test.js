"use strict";

const { createHistoricalLevelEvents } = require("../../../src/indicators/l2-memory/historical-level-events");
const { createHistoricalTopNFrames } = require("../../../src/indicators/l2-memory/historical-topn-frames");
const { createHistoricalSourceRunner } = require("../../../src/indicators/l2-memory/historical-source-runner");
const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");
const { tradeFrame } = require("../../../src/indicators/l2-memory/input-frames");

const book = { bids: [{ price: "99", size: "10" }, { price: "98", size: "8" }],
  asks: [{ price: "101", size: "5" }, { price: "102", size: "7" }] };
const config = { derivationId: "a".repeat(64), instrumentId: "ES", seedKey: ["1000000000", "2", "0", "0"],
  tickSize: "1", depthLimit: 2 };

function harness({ observerOptions = {}, ledgerOptions = {} } = {}) {
  const source = createHistoricalTopNFrames({ depthLimit: 2 });
  const runner = createHistoricalSourceRunner({ createEngine: () => createMemoryEngine({ tickSize: 1,
    snapshotDepth: 2, ledgerOptions }) });
  const observer = createHistoricalLevelEvents({ ...config, ...observerOptions });
  let index = 0;
  let previousKey;
  function step(ms, changes = {}, trade = null, receive = ms) {
    const key = [String(ms * 1_000_000), "2", String(index++), "0"];
    const transition = source.push({ event_ns: key[0], source_rank: key[1], stable_position: key[2], ordinal: key[3],
      instrument_id: "ES", depth_action: "SNAPSHOT", depth_model: "TOP_N", depth_limit: 2,
      continuity: "OK", book_epoch: "1", date: "2026-08-05", ...book, ...changes }, { observationOnly: trade !== null });
    const engine = runner.applyTransition(transition);
    if (trade) {
      runner.applyTransition({ restartEngine: false, frames: [tradeFrame(ms, trade.price, trade.size, trade.side, `trade:${key[2]}`)] });
      expect(engine.drainPrints()).toHaveLength(1);
    }
    previousKey = key;
    return observer.capture(engine, { sourceKey: key, knownNs: String(receive * 1_000_000),
      bookFrame: transition.frames.find((frame) => frame.kind === "book") });
  }
  return { observer, runner, step, get key() { return previousKey; } };
}

test("seed, additions and every reduction are retained with stable source-anchored observation and lifecycle IDs", () => {
  function run() {
    const h = harness();
    const rows = [...h.step(1000), ...h.step(1100, { asks: [{ price: "101", size: "14" }, book.asks[1]] }),
      ...h.step(1200, { asks: [{ price: "101", size: "12" }, book.asks[1]] }),
      ...h.step(1300, { asks: [{ price: "101", size: "9" }, book.asks[1]] })];
    const sizes = rows.filter((row) => row.event_type === "level_size" && row.price_key === 101);
    expect(sizes.map((row) => [row.payload.previous_size, row.payload.size])).toEqual([[null, 5], [5, 14], [14, 12], [12, 9]]);
    expect(new Set(sizes.map((row) => row.lifecycle_id)).size).toBe(1);
    expect(new Set(sizes.map((row) => row.observation_id)).size).toBe(1);
    expect(rows.filter((row) => row.event_type === "lifecycle_start")).toHaveLength(4);
    expect(rows.find((row) => row.event_type === "lifecycle_start").payload.age_unknown).toBe(true);
    expect(rows.filter((row) => row.event_type === "engine_shrank" && row.price_key === 101)).toHaveLength(1);
    return rows;
  }
  expect(run()).toEqual(run());
});

test("a delayed verdict updates the emptied lifecycle; a refill gets a new lifecycle and retains record totals", () => {
  const h = harness();
  const first = h.step(1000);
  const original = first.find((row) => row.event_type === "lifecycle_start" && row.price_key === 101);
  const removed = { asks: [book.asks[1], { price: "103", size: "6" }] };
  const ending = h.step(1200, removed);
  expect(ending.some((row) => row.event_type === "engine_verdict")).toBe(false);
  h.runner.engine.prune(2800);
  const later = h.observer.capture(h.runner.engine, { sourceKey: h.key, knownNs: "2800000000", pruned: true });
  const verdict = later.find((row) => row.event_type === "engine_verdict");
  expect(verdict).toMatchObject({ known_ns: "2800000000", observed_engine_ms: 2800,
    lifecycle_id: original.lifecycle_id, payload: { endedBy: "pulled" } });
  const refill = h.step(2900);
  const start = refill.find((row) => row.event_type === "lifecycle_start" && row.price_key === 101);
  expect(start.lifecycle_id).not.toBe(original.lifecycle_id);
  expect(start.observation_id).toBe(original.observation_id);
  expect(start.payload).toMatchObject({ age_unknown: false, refill: true, previous_lifecycle_id: original.lifecycle_id });
  const state = refill.find((row) => row.event_type === "engine_level_state" && row.price_key === 101);
  expect(state.payload.state).toMatchObject({ refills: 1, reloads: 0 });
  expect(ending.find((row) => row.event_type === "engine_emptied").lifecycle_id).toBe(original.lifecycle_id);
});

test("a fill and immediate refill retain verdict ordering and cycle association", () => {
  const h = harness();
  const original = h.step(1000).find((row) => row.event_type === "lifecycle_start" && row.price_key === 101);
  h.step(1100, {}, { side: "buy", price: "101", size: "5" });
  const ended = h.step(1200, { asks: [book.asks[1], { price: "103", size: "6" }] });
  expect(ended.find((row) => row.event_type === "engine_verdict")).toMatchObject({ lifecycle_id: original.lifecycle_id,
    payload: { endedBy: "filled", explained: 5 } });
  const refill = h.step(1300);
  expect(refill.find((row) => row.event_type === "engine_level_state" && row.price_key === 101).payload.state)
    .toMatchObject({ refills: 1, reloads: 1, tradedVisible: 5 });
});

test("refill during the grace period associates the forced verdict with the previous cycle", () => {
  const h = harness();
  const old = h.step(1000).find((row) => row.event_type === "lifecycle_start" && row.price_key === 101);
  h.step(1100, { asks: [book.asks[1], { price: "103", size: "6" }] });
  const rows = h.step(1200);
  const verdictIndex = rows.findIndex((row) => row.event_type === "engine_verdict" && row.price_key === 101);
  const startIndex = rows.findIndex((row) => row.event_type === "lifecycle_start" && row.price_key === 101);
  expect(verdictIndex).toBeLessThan(startIndex);
  expect(rows[verdictIndex].lifecycle_id).toBe(old.lifecycle_id);
  expect(rows[startIndex].lifecycle_id).not.toBe(old.lifecycle_id);
});

test("coverage exits produce unknown endings; returning levels have new observations and unknown age", () => {
  const h = harness();
  const old = h.step(1000).find((row) => row.event_type === "lifecycle_start" && row.price_key === 102);
  const rows = h.step(1100, { asks: [{ price: "100", size: "4" }, book.asks[0]] });
  expect(rows.find((row) => row.event_type === "observation_end" && row.price_key === 102))
    .toMatchObject({ lifecycle_id: old.lifecycle_id, payload: { cause: "DEPTH_EXIT" } });
  expect(rows.some((row) => row.event_type === "level_size" && row.price_key === 102 && row.payload.size === 0)).toBe(false);
  const returning = h.step(1200).find((row) => row.event_type === "lifecycle_start" && row.price_key === 102);
  expect(returning.observation_id).not.toBe(old.observation_id);
  expect(returning.lifecycle_id).not.toBe(old.lifecycle_id);
  expect(returning.payload.age_unknown).toBe(true);
});

test("outside-depth trades stay flow-only until an observed seed establishes a new observation", () => {
  const h = harness({ ledgerOptions: { sweepToleranceKeys: 10 } });
  h.step(1000);
  const flow = h.step(1100, {}, { side: "buy", price: "104", size: "3" });
  const trade = flow.find((row) => row.event_type === "engine_trade");
  expect(trade).toMatchObject({ lifecycle_id: null, evidence_quality: "resting_unknown" });
  const hidden = h.step(1200).find((row) => row.event_type === "engine_hidden" && row.price_key === 104);
  expect(hidden).toMatchObject({ lifecycle_id: null, evidence_quality: "resting_unknown" });
  const observed = h.step(1300, { asks: [{ price: "103", size: "6" }, { price: "104", size: "4" }] });
  const newLife = observed.find((row) => row.event_type === "lifecycle_start" && row.price_key === 104);
  expect(newLife.observation_id).not.toBe(trade.observation_id);
  expect(newLife.payload.age_unknown).toBe(true);
});

test("EOF and gaps leave pending endings unknown and close the observation without forcing prune", () => {
  for (const cause of ["EOF", "SOURCE_GAP_SUSPECTED"]) {
    const h = harness();
    h.step(1000);
    h.step(1100, { asks: [book.asks[1], { price: "103", size: "6" }] });
    const engine = h.runner.engine;
    if (cause !== "EOF") engine.apply({ kind: "gap", ts: 1100, cause });
    const rows = h.observer.close(engine, { sourceKey: h.key, knownNs: "1100000000", cause });
    expect(rows.some((row) => row.event_type === "engine_verdict")).toBe(false);
    expect(rows.at(-1)).toMatchObject({ event_type: "segment_close", payload: { cause, unresolved_endings: 1 } });
    expect(h.observer.trackedLevels).toBe(0);
    expect(() => h.observer.capture(engine, { sourceKey: h.key, knownNs: "1100000000" })).toThrow(/closed/);
  }
});

test("missed events, budget overflow, source regression and engine reuse poison output", () => {
  for (const options of [{ ledgerOptions: { eventCapacity: 0 } }, { observerOptions: { maxRowsPerCapture: 1 } },
    { observerOptions: { maxBytesPerCapture: 256 } }]) {
    const h = harness(options);
    expect(() => h.step(1000)).toThrow();
    expect(() => h.step(1100)).toThrow(/failed/);
  }
  const h = harness();
  h.step(1000);
  expect(() => h.observer.capture(h.runner.engine, { sourceKey: ["999000000", "2", "1", "0"], knownNs: "1100000000" })).toThrow(/order/);
  const other = harness();
  other.step(1000);
  expect(() => other.observer.capture(createMemoryEngine({ tickSize: 1 }), { sourceKey: other.key, knownNs: "1100000000" })).toThrow(/identity/);
});

test("an unseen trade's cumulative metrics retain their evidence gap after an in-range wall appears", () => {
  const h = harness({ ledgerOptions: { sweepToleranceKeys: 10 } });
  const sparse = { asks: [book.asks[0], { price: "103", size: "6" }] };
  h.step(1000, sparse);
  const old = h.step(1100, sparse, { side: "buy", price: "102", size: "3" })
    .find((row) => row.event_type === "engine_trade");
  expect(old).toMatchObject({ lifecycle_id: null, record_evidence_gap: true, evidence_quality: "resting_unknown" });
  const rows = h.step(1200);
  const start = rows.find((row) => row.event_type === "lifecycle_start" && row.price_key === 102);
  expect(start.observation_id).toBe(old.observation_id);
  expect(start.payload.age_unknown).toBe(false);
  expect(rows.find((row) => row.event_type === "engine_level_state" && row.price_key === 102))
    .toMatchObject({ record_evidence_gap: true, evidence_quality: "resting_unknown" });
});

test("a dropped ring event cannot be repaired by synthesizing size history", () => {
  const h = harness({ ledgerOptions: { eventCapacity: 1 } });
  h.step(1000);
  h.runner.engine.apply(tradeFrame(1100, "101", "5", "buy", "not-drained"));
  expect(() => h.step(1200, { asks: [book.asks[1], { price: "103", size: "6" }] })).toThrow(/missing/);
  expect(() => h.observer.close(h.runner.engine, { sourceKey: h.key, knownNs: "1200000000", cause: "EOF" })).toThrow(/failed/);
});
