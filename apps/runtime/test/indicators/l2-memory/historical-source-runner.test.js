"use strict";

const { createHistoricalSourceRunner } = require("../../../src/indicators/l2-memory/historical-source-runner");
const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");
const { bookFrame, gapFrame } = require("../../../src/indicators/l2-memory/input-frames");

const seed = (ts, bid = 100) => bookFrame(ts, "READY", { bids: [[bid, 5]], asks: [[bid + 1, 5]] }, null);

describe("historical source runner", () => {
  test("prunes rolling memory by source time while replaying a long session", () => {
    const runner = createHistoricalSourceRunner({ createEngine: () => createMemoryEngine({ tickSize: 1 }) });
    runner.applyTransition({ restartEngine: true, reason: "INITIAL", frames: [seed(1)] });
    for (let ts = 1001; ts <= 120001; ts += 1000) {
      const size = ts % 2000 === 1 ? 6 : 5;
      runner.applyTransition({ restartEngine: false, frames: [
        bookFrame(ts, "READY", { bestBid: 100, bestAsk: 101 }, { bids: [[100, size]], asks: [] }),
      ] });
    }
    expect(runner.engine.sizeHistory.stats().samples).toBeLessThanOrEqual(33);
    expect(runner.engine.sizeHistory.sizeAt({ side: "bid", key: 100, ts: 120001 })).toBe(6);
    expect(runner.engine.sizeHistory.sizeAt({ side: "bid", key: 100, ts: 115001 })).toBe(5);
    expect(runner.segment).toBe(1);
  });

  test("closes the old engine before a new seed and never carries an old level across an edge", () => {
    const ended = [];
    const runner = createHistoricalSourceRunner({
      createEngine: () => createMemoryEngine({ tickSize: 1 }),
      onSegmentEnd: (record) => ended.push(record),
    });
    runner.applyTransition({ restartEngine: true, reason: "INITIAL", frames: [gapFrame("INITIAL", 1), seed(1)] });
    const first = runner.engine;
    runner.applyTransition({ restartEngine: false, reason: null, frames: [
      bookFrame(2, "READY", { bestBid: 100, bestAsk: 101 }, { bids: [[100, 7]], asks: [] }),
    ] });
    expect(first.level("bid", 100).size).toBe(7);
    runner.applyTransition({ restartEngine: true, reason: "DEPTH_EDGE", frames: [gapFrame("DEPTH_EDGE", 3), seed(3, 102)] });
    expect(ended).toMatchObject([{ segment: 1, reason: "DEPTH_EDGE" }]);
    expect(ended[0].engine).toBe(first);
    expect(first.live).toBe(false);
    expect(runner.engine).not.toBe(first);
    expect(runner.engine.level("bid", 100)).toBeNull();
    expect(runner.engine.level("bid", 102).size).toBe(5);
    expect(runner.segment).toBe(2);
  });

  test("a gap without a seed removes the trusted engine until a new snapshot", () => {
    const runner = createHistoricalSourceRunner({ createEngine: () => createMemoryEngine({ tickSize: 1 }) });
    runner.applyTransition({ restartEngine: true, reason: "INITIAL", frames: [seed(1)] });
    runner.applyTransition({ restartEngine: true, reason: "SOURCE_GAP", frames: [gapFrame("SOURCE_GAP", 2)] });
    expect(runner.engine).toBeNull();
    expect(() => runner.applyTransition({ restartEngine: false, reason: null, frames: [seed(3)] })).toThrow(/trusted seed/);
    runner.applyTransition({ restartEngine: true, reason: "SOURCE_SNAPSHOT", frames: [seed(4)] });
    expect(runner.engine.live).toBe(true);
    runner.close("END_OF_FILE_UNVERIFIED");
    expect(runner.engine).toBeNull();
  });

  test("rejects a malformed restart before closing a trusted segment", () => {
    const runner = createHistoricalSourceRunner({ createEngine: () => createMemoryEngine({ tickSize: 1 }) });
    runner.applyTransition({ restartEngine: true, reason: "INITIAL", frames: [seed(1)] });
    const trusted = runner.engine;
    expect(() => runner.applyTransition({ restartEngine: true, reason: "BAD", frames: [seed(2), gapFrame("BAD", 2)] }))
      .toThrow(/invalid restart frames/);
    expect(() => runner.applyTransition({ restartEngine: true, reason: "BAD", frames: [
      gapFrame("BAD", 2), bookFrame(2, "READY", { bids: [[100, -1]], asks: [[101, 1]] }, null),
    ] })).toThrow(/full book/);
    expect(runner.engine).toBe(trusted);
    expect(trusted.live).toBe(true);
  });
});
