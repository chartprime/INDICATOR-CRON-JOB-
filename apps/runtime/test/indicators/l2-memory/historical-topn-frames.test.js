"use strict";

const { createHistoricalTopNFrames } = require("../../../src/indicators/l2-memory/historical-topn-frames");
const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");
const { createHistoricalSourceRunner } = require("../../../src/indicators/l2-memory/historical-source-runner");
const { tradeFrame } = require("../../../src/indicators/l2-memory/input-frames");

const T = "1785859200000000000";
const levels = (prices) => prices.map((price) => ({ price: String(price), size: "5" }));

function row(ordinal, bids = [100, 99, 98], asks = [101, 102, 103], overrides = {}) {
  return {
    instrument_id: "AAPL", depth_action: "SNAPSHOT", depth_model: "TOP_N", depth_limit: 3,
    event_ns: T, source_rank: 0, stable_position: 1, ordinal, book_epoch: 0, continuity: "OK",
    bids: levels(bids), asks: levels(asks), ...overrides,
  };
}

describe("historical top-N input frames", () => {
  test("nanosecond order remains exact and rounded JSON numbers are refused", () => {
    const source = createHistoricalTopNFrames({ depthLimit: 3 });
    expect(() => source.push(row(0, undefined, undefined, { event_ns: Number(T) })))
      .toThrow(/exact integer precision/);
    source.push(row(10, undefined, undefined, { event_ns: "1785859200000000001" }));
    expect(source.push(row(0, undefined, undefined, { event_ns: "1785859200000000002" })))
      .toMatchObject({ restartEngine: false });
    expect(() => source.push(row(11, undefined, undefined, { event_ns: "1785859200000000001" })))
      .toThrow(/order must increase/);
  });

  test("a stable observed level changes without resetting the engine", () => {
    const source = createHistoricalTopNFrames({ depthLimit: 3 });
    const first = source.push(row(0));
    expect(first).toMatchObject({ restartEngine: true, reason: "INITIAL" });
    const next = source.push(row(1, [100, 99, 98], [101, 102, 103], {
      bids: [{ price: "100", size: "7" }, ...levels([99, 98])],
    }));
    expect(next).toMatchObject({ restartEngine: false, reason: null });
    expect(next.frames[0].delta).toEqual({ bids: [["100", "7"]], asks: [] });
    const engine = createMemoryEngine({ tickSize: 1, snapshotDepth: 3 });
    for (const frame of first.frames) engine.apply(frame);
    for (const frame of next.frames) engine.apply(frame);
    expect(engine.level("bid", 100).size).toBe(7);
    expect(engine.stats.resyncs).toBe(0);
  });

  test("a smaller observed book can prove an interior removal while preserving the boundary", () => {
    const source = createHistoricalTopNFrames({ depthLimit: 3 });
    source.push(row(0, [100, 99, 98], [101, 102, 103]));
    const next = source.push(row(1, [100, 98], [101, 103]));
    expect(next).toMatchObject({ restartEngine: false });
    expect(next.frames[0].delta).toEqual({ bids: [["99", "0"]], asks: [["102", "0"]] });
  });

  test("observing repeated trade books preserves pending fills until the actual book change", () => {
    const source = createHistoricalTopNFrames({ depthLimit: 3 });
    const runner = createHistoricalSourceRunner({ createEngine: () => createMemoryEngine({ tickSize: 1, snapshotDepth: 3 }) });
    runner.applyTransition(source.push(row(0)));
    runner.applyTransition(source.push(row(1), { observationOnly: true }));
    runner.applyTransition({ restartEngine: false, frames: [tradeFrame(Number(BigInt(T) / 1_000_000n), 101, 3, "buy", "a")] });
    runner.applyTransition(source.push(row(2), { observationOnly: true }));
    runner.applyTransition({ restartEngine: false, frames: [tradeFrame(Number(BigInt(T) / 1_000_000n), 101, 2, "buy", "b")] });
    runner.applyTransition(source.push(row(3, [100, 99, 98], [102, 103, 104])));
    const level = runner.engine.level("ask", 101);
    expect(level.tradedVisible).toBe(5);
    expect(level.hiddenTraded).toBe(0);
    expect(level.cancelled).toBe(0);
    expect(runner.engine.events().events.filter(({ type }) => type === "hidden")).toEqual([]);
  });

  test("a real unchanged book update still settles hidden volume", () => {
    const source = createHistoricalTopNFrames({ depthLimit: 3 });
    const runner = createHistoricalSourceRunner({ createEngine: () => createMemoryEngine({ tickSize: 1, snapshotDepth: 3 }) });
    runner.applyTransition(source.push(row(0)));
    runner.applyTransition({ restartEngine: false, frames: [tradeFrame(Number(BigInt(T) / 1_000_000n), 101, 3, "buy", "a")] });
    runner.applyTransition(source.push(row(1)));
    expect(runner.engine.level("ask", 101).hiddenTraded).toBe(3);
  });

  test("an observation-only input cannot hide a changed book or advance past a refused row", () => {
    const source = createHistoricalTopNFrames({ depthLimit: 3 });
    source.push(row(0));
    expect(() => source.push(row(1, undefined, undefined, {
      asks: [{ price: "101", size: "2" }, ...levels([102, 103])],
    }), { observationOnly: true })).toThrow(/must not change levels/);
    expect(source.push(row(1), { observationOnly: true }).frames[0].delta).toBeNull();
    expect(() => source.push(row(2), { observationOnly: "true" })).toThrow(/must be boolean/);
  });

  test("a side shorter than the source depth limit proves an outer level was absent", () => {
    const source = createHistoricalTopNFrames({ depthLimit: 3 });
    source.push(row(0, [100, 99], [101, 102]));
    const added = source.push(row(1, [100, 99, 98], [101, 102, 103]));
    expect(added).toMatchObject({ restartEngine: false });
    expect(added.frames[0].delta).toEqual({ bids: [["98", "5"]], asks: [["103", "5"]] });
    const removed = source.push(row(2, [100, 99], [101, 102]));
    expect(removed).toMatchObject({ restartEngine: false });
    expect(removed.frames[0].delta).toEqual({ bids: [["98", "0"]], asks: [["103", "0"]] });
  });

  test("a visible level leaving the top-N edge is not reported as cancellation", () => {
    const source = createHistoricalTopNFrames({ depthLimit: 3 });
    source.push(row(0));
    const next = source.push(row(1, [101, 100, 99], [102, 103, 104]));
    expect(next).toMatchObject({ restartEngine: false, reason: null });
    expect(next.frames.map((frame) => frame.kind)).toEqual(["book"]);
    expect(next.frames[0].delta).toEqual({ bids: [["101", "5"]], asks: [["101", "0"]] });
    expect(next.frames[0].coverage).toEqual({
      unobserved: { bids: ["98"], asks: [] },
      preexisting: { bids: [], asks: [["104", "5"]] },
    });
  });

  test("a bounded edge transition preserves observed lifecycles and matches the book oracle", () => {
    const source = createHistoricalTopNFrames({ depthLimit: 3 });
    const inputs = [
      row(0),
      row(1, [100, 98], [101, 103]),
      row(2, [101, 100, 99], [102, 103, 104]),
      row(3, [101, 100, 99], [102, 103, 104], {
        asks: [{ price: "102.0", size: "8.00" }, ...levels([103, 104])],
      }),
    ];
    let engine = null;
    const restarts = [];
    for (const input of inputs) {
      const transition = source.push(input);
      if (transition.restartEngine) {
        engine = createMemoryEngine({ tickSize: 1, snapshotDepth: 3 });
        restarts.push(transition.reason);
      }
      for (const frame of transition.frames) engine.apply(frame);
      expect(engine.ladder({ side: "bid", depth: 3 }))
        .toEqual(input.bids.map(({ price, size }) => [Number(price), Number(size)]));
      expect(engine.ladder({ side: "ask", depth: 3 }))
        .toEqual(input.asks.map(({ price, size }) => [Number(price), Number(size)]));
      if (input.ordinal === 2) {
        expect(engine.level("bid", 98)).toBeNull();
        expect(engine.level("bid", 100).seeded).toBe(true);
        expect(engine.level("ask", 104).seeded).toBe(false);
        const events = engine.events().events;
        expect(events.some(({ type, side, key }) => type === "coverage_exit" && side === "bid" && key === 98)).toBe(true);
        expect(events.some(({ type, side, key }) => type === "emptied" && side === "bid" && key === 98)).toBe(false);
      }
    }
    expect(restarts).toEqual(["INITIAL"]);
  });

  test("file boundaries and gaps have distinct fail-closed behavior", () => {
    const source = createHistoricalTopNFrames({ depthLimit: 3 });
    source.push(row(0));
    expect(source.push(row(1, undefined, undefined, { continuity: "UNKNOWN", book_epoch: 1 })))
      .toMatchObject({ restartEngine: true, reason: "SOURCE_BOUNDARY_UNKNOWN" });
    expect(source.push(row(2, undefined, undefined, { continuity: "GAP_SUSPECTED", book_epoch: 2 })))
      .toMatchObject({ restartEngine: true, reason: "SOURCE_GAP_SUSPECTED", frames: [{ kind: "gap" }] });
    expect(source.push(row(3, undefined, undefined, { book_epoch: 2 })))
      .toMatchObject({ restartEngine: true, reason: "AWAITING_SOURCE_RESET", frames: [{ kind: "gap" }] });
    expect(source.push(row(4, undefined, undefined, { continuity: "RESET", book_epoch: 3 })))
      .toMatchObject({ restartEngine: true, reason: "SOURCE_RESET", frames: [{ kind: "gap" }, { kind: "book" }] });
  });

  test("same-nanosecond rows retain archive order and malformed books are refused before state moves", () => {
    const source = createHistoricalTopNFrames({ depthLimit: 3 });
    source.push(row(0));
    expect(() => source.push(row(0))).toThrow(/order must increase/);
    expect(() => source.push(row(1, [99, 100, 98]))).toThrow(/best-first/);
    expect(() => source.push(row(1, undefined, undefined, { instrument_id: "TSLA" }))).toThrow(/instrument changed/);
    expect(source.push(row(1))).toMatchObject({ restartEngine: false });
  });

  test("a one-sided opening or later book cannot seed a trusted engine", () => {
    const source = createHistoricalTopNFrames({ depthLimit: 3 });
    expect(source.push(row(0, [], [101], { continuity: "UNKNOWN" })))
      .toMatchObject({ restartEngine: true, reason: "INCOMPLETE_BOOK", frames: [{ kind: "gap", cause: "INCOMPLETE_BOOK" }] });
    expect(source.push(row(1))).toMatchObject({ restartEngine: true, frames: [{ kind: "gap" }, { kind: "book" }] });
    expect(source.push(row(2, [], [101]))).toMatchObject({ restartEngine: true, reason: "INCOMPLETE_BOOK" });
    expect(source.push(row(3))).toMatchObject({ restartEngine: true, frames: [{ kind: "gap" }, { kind: "book" }] });
  });

  test.each([101, 102])("a locked or crossed book closes trust and recovery starts a fresh lifecycle (%s)", (bestBid) => {
    const source = createHistoricalTopNFrames({ depthLimit: 3 });
    const ended = [];
    const runner = createHistoricalSourceRunner({ createEngine: () => createMemoryEngine({ tickSize: 1 }),
      onSegmentEnd: ({ engine, reason }) => ended.push({ engine, reason }) });
    const first = runner.applyTransition(source.push(row(0)));
    runner.applyTransition(source.push(row(1, undefined, undefined, {
      asks: [{ price: "101", size: "1" }, ...levels([102, 103])],
    })));
    const invalid = source.push(row(2, [bestBid, 99, 98]));
    expect(invalid).toMatchObject({ restartEngine: true, reason: "CROSSED_BOOK",
      frames: [{ kind: "gap", cause: "CROSSED_BOOK" }] });
    expect(runner.applyTransition(invalid)).toBeNull();
    expect(ended).toEqual([{ engine: first, reason: "CROSSED_BOOK" }]);
    expect(first.events().events.some(({ type }) => type === "verdict")).toBe(false);
    const recovered = runner.applyTransition(source.push(row(3)));
    expect(recovered).not.toBe(first);
    expect(recovered.level("ask", 101)).toMatchObject({ seeded: true, cancelled: 0, traded: 0 });
    expect(runner.segment).toBe(2);
  });

  test("a crossed RESET cannot resume a suspected source gap", () => {
    const source = createHistoricalTopNFrames({ depthLimit: 3 });
    source.push(row(0));
    source.push(row(1, undefined, undefined, { continuity: "GAP_SUSPECTED" }));
    expect(source.push(row(2, [102, 99, 98], undefined, { continuity: "RESET" })))
      .toMatchObject({ reason: "AWAITING_SOURCE_RESET", frames: [{ kind: "gap" }] });
    expect(source.push(row(3))).toMatchObject({ reason: "AWAITING_SOURCE_RESET", frames: [{ kind: "gap" }] });
    expect(source.push(row(4, undefined, undefined, { continuity: "RESET" })))
      .toMatchObject({ reason: "SOURCE_RESET", frames: [{ kind: "gap" }, { kind: "book" }] });
  });

  test("a quote-confirmed trade before its same-millisecond reduction explains the visible shrink", () => {
    const source = createHistoricalTopNFrames({ depthLimit: 3 });
    const runner = createHistoricalSourceRunner({ createEngine: () => createMemoryEngine({ tickSize: 1 }) });
    const at = Number(BigInt(T) / 1_000_000n);
    runner.applyTransition(source.push(row(0)));
    runner.applyTransition(source.push(row(1)));
    runner.applyTransition({ restartEngine: false, frames: [tradeFrame(at, "101", "5", "buy", "execution")] });
    const engine = runner.applyTransition(source.push(row(2, undefined, [102, 103, 104])));
    expect(engine.level("ask", 101)).toMatchObject({ size: 0, tradedVisible: 5, cancelled: 0,
      hiddenTraded: 0, endedBy: "filled" });
    expect(engine.events().events.filter(({ type }) => type === "verdict"))
      .toEqual([expect.objectContaining({ ts: at, key: 101, endedBy: "filled", explained: 5 })]);
  });

  test("a reduction larger than its anchored trade keeps the unexplained remainder separate", () => {
    const source = createHistoricalTopNFrames({ depthLimit: 3 });
    const runner = createHistoricalSourceRunner({ createEngine: () => createMemoryEngine({ tickSize: 1 }) });
    const at = Number(BigInt(T) / 1_000_000n);
    runner.applyTransition(source.push(row(0)));
    runner.applyTransition({ restartEngine: false, frames: [tradeFrame(at, "101", "2", "buy", "partial")] });
    const engine = runner.applyTransition(source.push(row(1, undefined, undefined, {
      asks: [{ price: "101", size: "1" }, ...levels([102, 103])],
    })));
    expect(engine.level("ask", 101)).toMatchObject({ size: 1, tradedVisible: 2, cancelled: 2,
      hiddenTraded: 0, endedBy: null });
  });

  test("an unexplained emptying stays pending until source time supplies the grace period", () => {
    const source = createHistoricalTopNFrames({ depthLimit: 3 });
    const runner = createHistoricalSourceRunner({ pruneEveryMs: 1,
      createEngine: () => createMemoryEngine({ tickSize: 1 }) });
    const at = Number(BigInt(T) / 1_000_000n);
    const later = (ordinal, ms) => row(ordinal, undefined, [102, 103, 104], {
      event_ns: String(BigInt(T) + BigInt(ms) * 1_000_000n),
    });
    runner.applyTransition(source.push(row(0)));
    let engine = runner.applyTransition(source.push(later(1, 10)));
    expect(engine.level("ask", 101).endedBy).toBeNull();
    engine = runner.applyTransition(source.push(later(2, 1509)));
    expect(engine.events().events.some(({ type }) => type === "verdict")).toBe(false);
    engine = runner.applyTransition(source.push(later(3, 1510)));
    expect(engine.events().events.filter(({ type }) => type === "verdict"))
      .toEqual([expect.objectContaining({ ts: at + 1510, key: 101, endedBy: "pulled" })]);
  });
});
