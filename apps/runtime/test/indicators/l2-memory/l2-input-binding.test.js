"use strict";

const { createL2InputBinding, pairKey } = require("../../../src/indicators/l2-memory/l2-input-binding");
const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");
const { bookFrame, tradeFrame, gapFrame } = require("../../../src/indicators/l2-memory/input-frames");

const T = 1_780_000_000_000;
const seed = (ts) => bookFrame(ts, "READY", { bids: [["99", "5"]], asks: [["101", "3"]] }, null);

function spyEngine() {
  const engine = createMemoryEngine({ tickSize: 1 });
  const pruned = [];
  const applied = [];
  return {
    pruned,
    applied,
    engine: {
      apply: (frame) => {
        applied.push(frame.kind);
        engine.apply(frame);
      },
      prune: (ts) => pruned.push(ts),
      get seeded() {
        return engine.seeded;
      },
      get live() {
        return engine.live;
      },
    },
  };
}

describe("createL2InputBinding", () => {
  test("refuses a binding without an engine factory or a valid prune policy", () => {
    expect(() => createL2InputBinding({ prune: { mode: "timer", everyMs: 1 } })).toThrow(/createEngine/);
    expect(() => createL2InputBinding({ createEngine: () => null })).toThrow(/prune.mode/);
    expect(() => createL2InputBinding({ createEngine: () => null, prune: { mode: "sometimes", everyMs: 1 } })).toThrow(/prune.mode/);
    expect(() => createL2InputBinding({ createEngine: () => null, prune: { mode: "book", everyMs: 0 } })).toThrow(/everyMs/);
  });

  test("creates an engine only when the factory can, keeps it per scope and symbol, and applies frames only to engines it holds", () => {
    let ready = false;
    const factory = jest.fn(() => (ready ? createMemoryEngine({ tickSize: 1 }) : null));
    const binding = createL2InputBinding({ createEngine: factory, prune: { mode: "book", everyMs: 60_000 } });
    expect(binding.engineFor("PERPETUAL", "BTCUSDT")).toBeNull();
    expect(binding.apply("PERPETUAL", "BTCUSDT", seed(T))).toBe(false);
    ready = true;
    const perp = binding.engineFor("PERPETUAL", "BTCUSDT");
    const spot = binding.engineFor("SPOT", "BTCUSDT");
    expect(perp).not.toBeNull();
    expect(spot).not.toBe(perp);
    expect(binding.engineFor("PERPETUAL", "BTCUSDT")).toBe(perp);
    expect(factory).toHaveBeenCalledTimes(3);
    expect(binding.apply("PERPETUAL", "BTCUSDT", seed(T))).toBe(true);
    expect(perp.seeded).toBe(true);
    expect(spot.seeded).toBe(false);
    expect(binding.getEngine("PERPETUAL", "BTCUSDT")).toBe(perp);
    expect(binding.getEngine("PERPETUAL", "ETHUSDT")).toBeNull();
    expect([...binding.entries()].map(([key]) => key)).toEqual([pairKey("PERPETUAL", "BTCUSDT"), pairKey("SPOT", "BTCUSDT")]);
  });

  test("routes book, trade, gap and anchor frames into the engine", () => {
    const binding = createL2InputBinding({ createEngine: () => createMemoryEngine({ tickSize: 1 }), prune: { mode: "book", everyMs: 60_000 } });
    const engine = binding.engineFor("FUTURE", "/NQZ26:XCME");
    binding.apply("FUTURE", "/NQZ26:XCME", seed(T));
    binding.apply("FUTURE", "/NQZ26:XCME", tradeFrame(T + 1, 101, 1, "buy", 1));
    expect(engine.stats.trades).toBe(1);
    binding.apply("FUTURE", "/NQZ26:XCME", gapFrame("SEQUENCE_GAP"));
    expect(engine.live).toBe(false);
    expect(engine.segment.cause).toBe("SEQUENCE_GAP");
    binding.apply("FUTURE", "/NQZ26:XCME", seed(T + 2));
    expect(engine.live).toBe(true);
    binding.apply("FUTURE", "/NQZ26:XCME", { kind: "anchor", ts: T + 3 });
    expect(engine.segment.cause).toBe("ANCHOR");
    expect(() => binding.apply("FUTURE", "/NQZ26:XCME", { kind: "depth", ts: T })).toThrow(/unknown/);
  });

  test("book-mode prune runs after a READY book at most once per interval, per pair, on the book's own time", () => {
    const spies = new Map();
    const binding = createL2InputBinding({
      createEngine: (scope, symbol) => {
        const spy = spyEngine();
        spies.set(symbol, spy);
        return spy.engine;
      },
      prune: { mode: "book", everyMs: 60_000 },
    });
    binding.engineFor("FUTURE", "A");
    binding.engineFor("FUTURE", "B");
    binding.apply("FUTURE", "A", seed(T));
    binding.apply("FUTURE", "A", seed(T + 30_000));
    binding.apply("FUTURE", "A", bookFrame(T + 70_000, "UNAVAILABLE", null, null));
    binding.apply("FUTURE", "A", tradeFrame(T + 80_000, 100, 1, "sell"));
    binding.apply("FUTURE", "A", seed(new Date(T + 61_000).toISOString()));
    binding.apply("FUTURE", "B", seed(T + 5_000));
    expect(spies.get("A").pruned).toEqual([T, T + 61_000]);
    expect(spies.get("B").pruned).toEqual([T + 5_000]);
  });

  test("timer-mode prune prunes every engine on the wall clock while started, once, and never after stop", () => {
    jest.useFakeTimers({ now: T });
    try {
      const spy = spyEngine();
      const binding = createL2InputBinding({ createEngine: () => spy.engine, prune: { mode: "timer", everyMs: 30_000 } });
      binding.engineFor("PERPETUAL", "BTCUSDT");
      binding.apply("PERPETUAL", "BTCUSDT", seed(T));
      expect(spy.pruned).toEqual([]);
      binding.start();
      binding.start();
      jest.advanceTimersByTime(60_000);
      expect(spy.pruned).toEqual([T + 30_000, T + 60_000]);
      binding.stop();
      expect(binding.stopped).toBe(true);
      jest.advanceTimersByTime(60_000);
      expect(spy.pruned).toHaveLength(2);
      binding.start();
      jest.advanceTimersByTime(60_000);
      expect(spy.pruned).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test("release forgets one pair and its prune clock; clear forgets every pair", () => {
    const spy = spyEngine();
    const binding = createL2InputBinding({ createEngine: () => spy.engine, prune: { mode: "book", everyMs: 60_000 } });
    binding.engineFor("FUTURE", "A");
    binding.apply("FUTURE", "A", seed(T));
    binding.release("FUTURE", "A");
    expect(binding.getEngine("FUTURE", "A")).toBeNull();
    binding.engineFor("FUTURE", "A");
    binding.apply("FUTURE", "A", seed(T + 1_000));
    expect(spy.pruned).toEqual([T, T + 1_000]);
    binding.engineFor("FUTURE", "B");
    binding.clear();
    expect([...binding.entries()]).toEqual([]);
  });

  test("a stopped binding cannot create or apply another engine input", () => {
    const factory = jest.fn(() => createMemoryEngine({ tickSize: 1 }));
    const binding = createL2InputBinding({ createEngine: factory, prune: { mode: "book", everyMs: 60_000 } });
    const engine = binding.engineFor("FUTURE", "A");
    binding.apply("FUTURE", "A", seed(T));
    binding.stop();
    expect(binding.apply("FUTURE", "A", tradeFrame(T + 1, 101, 1, "buy"))).toBe(false);
    expect(engine.stats.trades).toBe(0);
    expect(binding.engineFor("FUTURE", "B")).toBeNull();
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
