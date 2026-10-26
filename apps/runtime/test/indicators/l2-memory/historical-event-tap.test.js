"use strict";

const { createHistoricalEventTap } = require("../../../src/indicators/l2-memory/historical-event-tap");
const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");

const config = { derivationId: "a".repeat(64), instrumentId: "ES", seedKey: ["1000000000", "2", "0", "0"] };
const coverage = { bid: [99, 100], ask: [101, 105] };
const book = { bids: [[100, 10]], asks: [[101, 10]] };
function drain(tap, engine, ms, position) {
  return tap.drain(engine, { knownKey: [String(ms * 1_000_000), "2", String(position), "0"],
    knownNs: String(ms * 1_000_000), coverage });
}

test("delayed verdict has its actual knowledge cursor and stable repeatable identity", () => {
  function run() {
    const engine = createMemoryEngine({ tickSize: 1 });
    const tap = createHistoricalEventTap(config);
    engine.apply({ kind: "book", ts: 1000, status: "READY", book });
    const rows = [...drain(tap, engine, 1000, 0)];
    engine.apply({ kind: "book", ts: 1200, status: "READY", book, delta: { bids: [], asks: [[101, 0]] } });
    rows.push(...drain(tap, engine, 1200, 1));
    expect(rows.some((row) => row.event_type === "verdict")).toBe(false);
    engine.prune(2800);
    rows.push(...tap.drain(engine, { knownKey: ["1200000000", "2", "1", "0"], knownNs: "2800000000", coverage }));
    const verdict = rows.find((row) => row.event_type === "verdict");
    expect(verdict).toMatchObject({ known_ns: "2800000000", known_key: ["1200000000", "2", "1", "0"],
      observed_engine_ms: 2800, evidence_quality: "observed_depth_inference" });
    return rows;
  }
  expect(run()).toEqual(run());
});

test("trade outside observed depth carries resting-unknown evidence", () => {
  const engine = createMemoryEngine({ tickSize: 1, ledgerOptions: { sweepToleranceKeys: 10 } });
  const tap = createHistoricalEventTap(config);
  engine.apply({ kind: "book", ts: 1000, status: "READY", book });
  drain(tap, engine, 1000, 0);
  engine.apply({ kind: "trade", ts: 1100, price: 106, size: 3, side: "buy", tradeId: "sweep" });
  expect(drain(tap, engine, 1100, 1)[0]).toMatchObject({ event_type: "trade", evidence_quality: "resting_unknown" });
  engine.apply({ kind: "book", ts: 1200, status: "READY", book, delta: { bids: [], asks: [] } });
  const rows = tap.drain(engine, { knownKey: ["1200000000", "2", "2", "0"], knownNs: "1200000000",
    coverage: { bid: coverage.bid, ask: [101, 110] } });
  expect(rows.find((row) => row.event_type === "hidden")).toMatchObject({ evidence_quality: "resting_unknown" });
});

test("ring overflow and disabled event capture fail without advancing the reader", () => {
  for (const eventCapacity of [0, 1]) {
    const engine = createMemoryEngine({ tickSize: 1, ledgerOptions: { eventCapacity } });
    const tap = createHistoricalEventTap(config);
    engine.apply({ kind: "book", ts: 1000, status: "READY", book });
    engine.apply({ kind: "trade", ts: 1100, price: 101, size: 3, side: "buy" });
    expect(() => drain(tap, engine, 1100, 1)).toThrow(/missing/);
    expect(tap.nextSeq).toBe(0);
  }
});

test("regression, lossy keys, future events, segment reuse and payload budgets fail closed", () => {
  const engine = createMemoryEngine({ tickSize: 1 });
  const tap = createHistoricalEventTap(config);
  engine.apply({ kind: "book", ts: 1000, status: "READY", book });
  drain(tap, engine, 1000, 0);
  expect(() => drain(tap, engine, 999, 1)).toThrow(/regresses/);
  expect(() => tap.drain(engine, { knownKey: [Number.MAX_SAFE_INTEGER + 1, 2, 1, 0], knownNs: "1000000000", coverage })).toThrow(/exact/);
  expect(() => drain(tap, createMemoryEngine({ tickSize: 1 }), 1100, 1)).toThrow(/one engine/);
  engine.apply({ kind: "trade", ts: 1200, price: 101, size: 3, side: "buy" });
  expect(() => drain(tap, engine, 1100, 1)).toThrow(/time/);
  expect(tap.nextSeq).toBe(1);
  const limited = createHistoricalEventTap({ ...config, maxEventsPerDrain: 1 });
  expect(() => drain(limited, engine, 1200, 1)).toThrow(/over-budget/);
});
