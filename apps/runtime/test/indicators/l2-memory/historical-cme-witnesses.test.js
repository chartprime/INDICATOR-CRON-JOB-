"use strict";

const witnesses = require("../../fixtures/golden/historical-cme-source-witnesses.json");
const { createHistoricalTopNFrames } = require("../../../src/indicators/l2-memory/historical-topn-frames");
const { createHistoricalSourceRunner } = require("../../../src/indicators/l2-memory/historical-source-runner");
const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");
const { tradeFrame } = require("../../../src/indicators/l2-memory/input-frames");

function price(value) {
  const integer = BigInt(value);
  return `${integer / 1_000_000_000n}.${String(integer % 1_000_000_000n).padStart(9, "0")}`;
}

function levels(record, side) {
  return record.levels.filter((level) => level[`${side}_px`] !== "9223372036854775807" && level[`${side}_sz`] > 0)
    .map((level) => ({ price: price(level[`${side}_px`]), size: String(level[`${side}_sz`]) }));
}

describe("pinned native CME reduction witnesses", () => {
  test.each(witnesses.cases)("$instrument observed reductions reconcile to its native prints", (fixture) => {
    const source = createHistoricalTopNFrames({ depthLimit: 10 });
    const runner = createHistoricalSourceRunner({ createEngine: () => createMemoryEngine({ tickSize: 0.25, snapshotDepth: 10 }) });
    const trades = new Map();
    let flowVolume = 0;
    let engine;
    const first = fixture.rows[0];
    const last = fixture.rows.at(-1);
    expect(first.action).not.toBe("T");
    expect(last.action).not.toBe("T");
    for (const [index, native] of fixture.rows.entries()) {
      expect(BigInt(native.native_index)).toBe(BigInt(first.native_index) + BigInt(index));
      const row = { event_ns: native.event_ns, source_rank: "2", stable_position: native.native_index, ordinal: "0",
        instrument_id: fixture.instrument, depth_action: "SNAPSHOT", depth_model: "TOP_N", depth_limit: 10,
        bids: levels(native, "bid"), asks: levels(native, "ask"), continuity: "OK", book_epoch: "1", date: fixture.date };
      const transition = source.push(row, { observationOnly: native.action === "T" });
      engine = runner.applyTransition(transition);
      expect(engine).not.toBeNull();
      if (native.action === "T") {
        expect(native.side).toBe("B");
        const atPrice = price(native.price);
        trades.set(atPrice, (trades.get(atPrice) ?? 0) + native.size);
        flowVolume += native.size;
        runner.applyTransition({ restartEngine: false, frames: [tradeFrame(Number(BigInt(native.event_ns) / 1_000_000n),
          atPrice, String(native.size), "buy", `raw:${fixture.raw_sha256}:${native.native_index}`)] });
        expect(engine.drainPrints()).toHaveLength(1);
      }
    }
    const after = new Map(levels(last, "ask").map((level) => [level.price, Number(level.size)]));
    let visible = 0;
    let cancellations = 0;
    for (const before of levels(first, "ask")) {
      expect(Number(before.price)).toBeLessThanOrEqual(Number(levels(last, "ask").at(-1).price));
      const reduction = Math.max(0, Number(before.size) - (after.get(before.price) ?? 0));
      const explained = Math.min(reduction, trades.get(before.price) ?? 0);
      const level = engine.level("ask", engine.keyFor(before.price));
      expect(level.tradedVisible).toBe(explained);
      expect(level.cancelled).toBe(reduction - explained);
      visible += explained;
      cancellations += reduction - explained;
    }
    expect(visible).toBeGreaterThan(0);
    expect(cancellations).toBe(0);
    expect(engine.flow.summary({ ts: Number(BigInt(last.event_ns) / 1_000_000n), lookbackMs: 60_000 }).buyVolume).toBe(flowVolume);
    if (fixture.instrument === "ES") {
      expect(visible).toBe(15);
      expect(engine.level("ask", engine.keyFor("7764.5")).hiddenTraded).toBe(0);
    }
  });
});
