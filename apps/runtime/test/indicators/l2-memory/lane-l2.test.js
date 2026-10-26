"use strict";

const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");
const { createLiquidityPublisher } = require("../../../src/indicators/passive_liquidity/liquidity-publisher");
const { MAX_L2_EVENTS, MAX_L2_WALLS, MAX_L2_LANE_WALLS } = require("../../../src/server/l2-frames");

const T = 1_780_000_000_000;
const MID = 1_000;
const KIND = "PERPETUAL";
const SYMBOL = "BTCUSDT";
const OPTIONS = Object.freeze({
  backfillEnabled: false, storeEnabled: false, deepS: 0, coarseS: 0, laneWindowPct: null,
  levelMinUsd: 40_000, wallSettleMs: 0, referenceBp: 50, windowBp: 400,
});

// A one-tick-per-row book around 1000 with thin 5-lot levels: 100 lots at a
// row is a wall (40,000 notional floor at price 1000), and the reference band
// the near-price filter uses is 5 rows either side of mid.
function harness({ startAt = T, publisherOptions = {} } = {}) {
  const engine = Object.create(createMemoryEngine({ tickSize: 1 }));
  const book = { bid: new Map(), ask: new Map() };
  for (let i = 1; i <= 30; i += 1) {
    book.bid.set(MID - i, 5);
    book.ask.set(MID + i, 5);
  }
  const tuples = (side) => [...book[side].entries()].map(([price, size]) => [String(price), String(size)]);
  const best = (side) => (side === "bid" ? Math.max(...book.bid.keys()) : Math.min(...book.ask.keys()));
  let now = startAt;
  engine.apply({ kind: "book", ts: now, status: "READY", book: { bids: tuples("bid"), asks: tuples("ask") } });
  const publisher = createLiquidityPublisher({
    memory: { getEngine: () => engine, rowClusters: () => 1 },
    now: () => now,
    log: () => {},
    ...OPTIONS,
    ...publisherOptions,
  });

  function set(changes) {
    now += 10;
    const delta = { bids: [], asks: [] };
    for (const [side, price, size] of changes) {
      if (size === 0) book[side].delete(price);
      else book[side].set(price, size);
      delta[side === "bid" ? "bids" : "asks"].push([String(price), String(size)]);
    }
    engine.apply({ kind: "book", ts: now, status: "READY", book: { bestBid: best("bid"), bestAsk: best("ask") }, delta });
  }

  function trade(price, size, side) {
    now += 1;
    engine.apply({ kind: "trade", ts: now, price: String(price), size: String(size), side });
  }

  function tick() {
    now = Math.floor(now / 1_000) * 1_000 + 1_000;
    publisher.tick(KIND, SYMBOL, now);
    return publisher.takeL2(KIND, SYMBOL);
  }

  return {
    engine, publisher, set, trade, tick, now: () => now,
    gap: () => { now += 10; engine.apply({ kind: "book", ts: now, status: "UNAVAILABLE" }); },
    ready: () => { now += 10; engine.apply({ kind: "book", ts: now, status: "READY", book: { bids: tuples("bid"), asks: tuples("ask") } }); },
    snapshot: () => publisher.l2Snapshot(KIND, SYMBOL),
  };
}

describe("lane-l2 collector (report 61 P4a)", () => {
  test("the first output is fresh and later ones are not", () => {
    const h = harness();
    expect(h.tick().fresh).toBe(true);
    expect(h.tick().fresh).toBe(false);
  });

  test("the segment is the engine's, named by the pair and the segment's own start, whenever collection began", () => {
    const early = harness();
    early.tick();
    const late = harness();
    late.tick();
    late.tick();
    late.tick();
    const expected = { id: `${KIND}:${SYMBOL}:${T}:LIVE`, state: "LIVE" };
    expect(early.tick().segment).toEqual(expected);
    expect(late.tick().segment).toEqual(expected);
  });

  test("a feed gap and its recovery are events with distinct ids, and the current segment follows them", () => {
    const h = harness();
    const first = h.tick();
    h.gap();
    const during = h.tick();
    h.ready();
    const recoveredAt = h.now();
    const after = h.tick();
    const segments = [...(during?.events?.events ?? []), ...(after?.events?.events ?? [])].filter((event) => event.event === "segment");
    expect(segments.map((event) => [event.state, event.segment])).toEqual([
      ["GAP", `${KIND}:${SYMBOL}:${T}:GAP`],
      ["LIVE", `${KIND}:${SYMBOL}:${recoveredAt}:LIVE`],
    ]);
    expect(new Set([first.segment.id, ...segments.map((event) => event.segment)]).size).toBe(3);
    expect(after.segment).toEqual({ id: `${KIND}:${SYMBOL}:${recoveredAt}:LIVE`, state: "LIVE" });
  });

  test("trades near the mid are events and trades beyond the reference band are not", () => {
    const h = harness();
    h.tick();
    h.trade(MID + 1, 1, "buy");
    h.trade(MID + 20, 1, "buy");
    const trades = h.tick().events.events.filter((event) => event.event === "trade");
    expect(trades.map((event) => event.price)).toEqual([MID + 1]);
    expect(trades[0]).toMatchObject({ side: "ask", aggressor: "buy", size: 1, late: false });
  });

  test("a wall's life reaches the events and the wall itself reaches walls, with its id", () => {
    const h = harness();
    h.tick();
    h.set([["bid", 997, 100]]);
    const born = h.tick();
    const [wall] = born.walls.walls;
    expect(wall).toMatchObject({ side: "bid", row: 997, size: 100 });
    expect(born.events.events).toEqual(expect.arrayContaining([expect.objectContaining({ event: "wall_born", wall: wall.id, row: 997 })]));
    h.set([["bid", 997, 0]]);
    const ended = [h.tick(), h.tick(), h.tick()];
    const ends = ended.flatMap((out) => out.events?.events ?? []).filter((event) => event.event === "wall_end");
    expect(ends).toEqual([expect.objectContaining({ wall: wall.id })]);
    const lastWall = ended.flatMap((out) => out.walls?.walls ?? []).filter((entry) => entry.id === wall.id).pop();
    expect(lastWall.endedBy).not.toBeNull();
  });

  test("walls: nothing is sent when nothing changed; a size change is sent at once", () => {
    const h = harness();
    h.tick();
    h.set([["bid", 997, 100]]);
    h.tick();
    expect(h.tick().walls).toBeNull();
    h.set([["bid", 997, 90]]);
    const changed = h.tick().walls;
    expect(changed).toMatchObject({ reset: false, removed: [] });
    expect(changed.walls.map((wall) => wall.size)).toEqual([90]);
  });

  test("walls: a wall that grows is sent at once, though nothing in its detail moved", () => {
    const h = harness();
    h.tick();
    h.set([["bid", 990, 100]]);
    const born = h.tick().walls.walls[0];
    h.set([["bid", 990, 130]]);
    const grown = h.tick().walls;
    expect(grown.walls).toHaveLength(1);
    expect(grown.walls[0]).toMatchObject({ id: born.id, size: 130, peak: 130 });
    const withoutLife = (detail) => {
      const rest = { ...detail };
      delete rest.lifeMs;
      return rest;
    };
    expect(withoutLife(grown.walls[0].detail)).toEqual(withoutLife(born.detail));
    expect(grown.walls[0].endTs).toBeNull();
  });

  test("walls: a change in cross-side volume alone waits up to 10 s; the snapshot sends what clients hold", () => {
    const h = harness();
    h.tick();
    h.set([["bid", 997, 100]]);
    const born = h.tick();
    const id = born.walls.walls[0].id;
    const crossSide = (value) => value.detail.crossSide;
    const sentBefore = crossSide(born.walls.walls[0]);
    const held = [];
    for (let second = 1; second <= 12; second += 1) {
      h.trade(MID - 1, 2, "sell");
      const out = h.tick();
      held.push(out.walls ? out.walls.walls.filter((wall) => wall.id === id).length : 0);
      if (second === 5) {
        const snapshotWall = h.snapshot().walls.walls.find((wall) => wall.id === id);
        expect(crossSide(snapshotWall)).toBe(sentBefore);
      }
    }
    expect(held.slice(0, 9)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(held.slice(9)).toContain(1);
  });

  test("a burst over the frame cap keeps segments and wall lifecycle ahead of trades, and counts what it dropped", () => {
    const h = harness();
    h.tick();
    h.set([["bid", 997, 100]]);
    const burst = MAX_L2_EVENTS + 120;
    for (let n = 0; n < burst; n += 1) h.trade(MID + 1, 0.01, "buy");
    h.gap();
    h.ready();
    const out = h.tick();
    const kinds = out.events.events.map((event) => event.event);
    expect(out.events.events).toHaveLength(MAX_L2_EVENTS);
    expect(kinds.filter((kind) => kind === "segment")).toHaveLength(2);
    expect(kinds).toContain("wall_born");
    expect(kinds.length + out.events.missed).toBeGreaterThanOrEqual(burst + 3);
    expect(out.events.missed).toBeGreaterThanOrEqual(burst + 3 - MAX_L2_EVENTS);
    expect(kinds.filter((kind) => kind === "trade").length).toBe(MAX_L2_EVENTS - kinds.filter((kind) => kind !== "trade").length);
    const times = out.events.events.map((event) => event.ts);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  test("a segment burst over the event cap still reports the engine's current segment", () => {
    const h = harness();
    h.tick();
    for (let n = 0; n < MAX_L2_EVENTS / 2 + 5; n += 1) {
      h.gap();
      h.ready();
    }
    const current = h.engine.segment;
    const out = h.tick();
    const segments = out.events.events.filter((event) => event.event === "segment");
    expect(out.events.missed).toBeGreaterThan(0);
    expect(segments.at(-1)).toMatchObject({ state: current.state, ts: current.startTs });
    expect(out.segment).toEqual({ id: `${KIND}:${SYMBOL}:${current.startTs}:${current.state}`, state: current.state });
  });

  test("the snapshot's event ring is time-ordered and states the last seq sent", () => {
    const h = harness();
    h.tick();
    h.trade(MID + 1, 1, "buy");
    const first = h.tick();
    h.set([["bid", 997, 100]]);
    h.trade(MID - 1, 1, "sell");
    const second = h.tick();
    const snap = h.snapshot();
    expect(snap.events.seq).toBe(second.events.seq);
    expect(snap.events.seq).toBe(first.events.events.length + second.events.events.length);
    const times = snap.events.events.map((event) => event.ts);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  test("the ladder is the engine's exact book, 50 levels a side at most", () => {
    const h = harness();
    const out = h.tick();
    expect(out.ladder.depth).toBe(50);
    expect(out.ladder.bids[0]).toEqual([MID - 1, 5]);
    expect(out.ladder.asks[0]).toEqual([MID + 1, 5]);
    expect(out.ladder.bids).toHaveLength(30);
  });

  test("an L2 collection that throws never costs the heatmap its frame, and the next output starts fresh", () => {
    const h = harness();
    h.tick();
    Object.defineProperty(h.engine, "ladder", {
      configurable: true,
      value: () => {
        throw new Error("ladder unavailable");
      },
    });
    const at = Math.floor(h.now() / 1_000) * 1_000 + 1_000;
    const frame = h.publisher.tick(KIND, SYMBOL, at);
    expect(frame).not.toBeNull();
    expect(h.publisher.takeL2(KIND, SYMBOL)).toBeNull();
    delete h.engine.ladder;
    const next = h.publisher.tick(KIND, SYMBOL, at + 1_000);
    expect(next).not.toBeNull();
    expect(h.publisher.takeL2(KIND, SYMBOL).fresh).toBe(true);
  });

  test("the running publisher sends a tick's L2 output even when sending its heatmap frame threw", () => {
    jest.useFakeTimers();
    const logs = [];
    const h = harness({ publisherOptions: { log: (line) => logs.push(line) } });
    try {
      const published = [];
      h.publisher.start({
        activePair: () => ({ marketKind: KIND, symbol: SYMBOL }),
        publish: () => {
          throw new Error("socket gone");
        },
        publishL2: (out) => published.push(out),
      });
      jest.advanceTimersByTime(1_100);
      expect(published).toHaveLength(1);
      expect(published[0].fresh).toBe(true);
      expect(logs.join("\n")).toMatch(/tick failed for PERPETUAL:BTCUSDT: socket gone/);
    } finally {
      h.publisher.stop();
      jest.useRealTimers();
    }
  });

  test("the running publisher finishes the heatmap tick before any L2 work: collection and send run as their own task", async () => {
    const h = harness();
    const order = [];
    try {
      await new Promise((resolve) => {
        h.publisher.start({
          activePair: () => ({ marketKind: KIND, symbol: SYMBOL }),
          publish: () => {
            if (order.includes("heatmap")) return;
            order.push("heatmap");
            queueMicrotask(() => order.push("after heatmap task"));
          },
          publishL2: (out) => {
            order.push(out.fresh ? "l2" : "l2 again");
            resolve();
          },
        });
      });
      expect(order.slice(0, 3)).toEqual(["heatmap", "after heatmap task", "l2"]);
    } finally {
      h.publisher.stop();
    }
  }, 5_000);

  test("a snapshot taken between the tick and its deferred L2 task already contains that tick, and the increment it precedes is no newer", () => {
    const h = harness();
    h.tick();
    h.set([["bid", 997, 100]]);
    h.publisher.tick(KIND, SYMBOL, Math.floor(h.now() / 1_000) * 1_000 + 1_000);
    const snap = h.snapshot();
    const out = h.publisher.takeL2(KIND, SYMBOL);
    expect(snap.walls.walls.map((wall) => wall.row)).toContain(997);
    expect(out.walls.seq).toBeLessThanOrEqual(snap.walls.seq);
    expect(out.events.seq).toBeLessThanOrEqual(snap.events.seq);
  });

  test("a failing L2 publish is logged and never stops the heatmap", () => {
    jest.useFakeTimers();
    const logs = [];
    const h = harness({ publisherOptions: { log: (line) => logs.push(line) } });
    try {
      const frames = [];
      h.publisher.start({
        activePair: () => ({ marketKind: KIND, symbol: SYMBOL }),
        publish: (frame) => frames.push(frame),
        publishL2: () => {
          throw new Error("channel down");
        },
      });
      jest.advanceTimersByTime(1_100);
      expect(frames.length).toBeGreaterThan(0);
      expect(logs.join("\n")).toMatch(/L2 publish failed for PERPETUAL:BTCUSDT: channel down/);
    } finally {
      h.publisher.stop();
      jest.useRealTimers();
    }
  });

  test("with l2 off nothing is collected and the heatmap frame is unchanged", () => {
    const on = harness();
    const off = harness({ publisherOptions: { l2: false } });
    for (const h of [on, off]) h.set([["bid", 997, 100]]);
    const frameOn = on.publisher.tick(KIND, SYMBOL, T + 1_000);
    const frameOff = off.publisher.tick(KIND, SYMBOL, T + 1_000);
    expect(frameOn).toEqual(frameOff);
    expect(off.publisher.takeL2(KIND, SYMBOL)).toBeNull();
    expect(off.publisher.l2Snapshot(KIND, SYMBOL)).toBeNull();
  });

  test("the snapshot's ts covers every event in the ring, not only the last batch's: a trade stamped ahead of the host clock in an earlier batch still fits the frame", () => {
    const { snapshotFramesOf } = require("../../../src/server/l2-channel");
    const h = harness();
    h.tick();
    const ahead = h.now() + 2_500;
    h.engine.apply({ kind: "trade", ts: ahead, price: String(MID + 1), size: "1", side: "buy" });
    const first = h.tick();
    expect(first.events.events.map((event) => event.ts)).toEqual([ahead]);
    h.set([["bid", 997, 100], ["ask", MID + 1, 4]]);
    const second = h.tick();
    expect(second.events.events.map((event) => [event.event, event.ts < ahead])).toEqual([["wall_born", true]]);
    const snap = h.snapshot();
    expect(snap.ts).toBe(ahead);
    expect(() => snapshotFramesOf("l2_events", { provider: "BINANCE", symbol: SYMBOL, marketKind: KIND }, snap)).not.toThrow();
  });

  test("walls from the wider lanes ride on l2_walls beside lane 0's, each with its lane and its own ids, and leave with the pair", () => {
    const wider = { ts: T, levels: [{ id: 10_000_001, lane: 1, side: "ask", row: 520, span: 1, startTs: T - 5_000, endTs: null, size: 300, peak: 300, endedBy: null, ratio: 0, chain: 0, fill: 0, eaten: 0, absorbing: false, detail: null }] };
    let held = [];
    const laneWallsClient = { enabled: true, configure: () => {}, forget: () => {}, post: () => false, wallsOf: () => held, stop: () => {}, stats: () => ({}) };
    const h = harness({ publisherOptions: { laneWallsClient } });
    h.tick();
    h.set([["bid", 997, 100]]);
    const first = h.tick();
    expect(first.lanedWalls.walls.map((wall) => [wall.id, wall.lane ?? 0])).toEqual([[1, 0]]);
    expect(first.walls.walls.map((wall) => wall.id)).toEqual([1]);
    held = wider.levels;
    const second = h.tick();
    expect(second.lanedWalls).toMatchObject({ seq: first.lanedWalls.seq + 1, reset: false, removed: [] });
    expect(second.lanedWalls.walls.map((wall) => [wall.id, wall.lane, wall.row])).toEqual([[10_000_001, 1, 520]]);
    expect(second.walls).toBeNull();
    const snap = h.snapshot();
    expect(snap.lanedWalls.walls.map((wall) => wall.id).sort((a, b) => a - b)).toEqual([1, 10_000_001]);
    expect(snap.walls).toMatchObject({ seq: first.walls.seq, reset: true });
    expect(snap.walls.walls.map((wall) => wall.id)).toEqual([1]);
    held = [];
    const third = h.tick();
    expect(third.lanedWalls).toMatchObject({ reset: false, walls: [], removed: [10_000_001] });
    expect(third.walls).toBeNull();
  });

  test("with lane 0's list full and every wider lane at its own cap, the walls snapshot and the diff still fit one frame", () => {
    let held = [];
    const laneWallsClient = { enabled: true, configure: () => {}, forget: () => {}, post: () => false, wallsOf: () => held, stop: () => {}, stats: () => ({}) };
    const h = harness({ publisherOptions: { laneWallsClient } });
    h.tick();
    const past = Array.from({ length: 400 }, (_, i) => ({ side: "ask", row: MID + 40 + i, span: 1, startTs: T - 600_000 - i * 1_000, endTs: T - 300_000 - i * 1_000, size: 0, peak: 30, endedBy: "pulled", ratio: 3, chain: 0 }));
    h.publisher.activeStateForTests().tracker.adopt(past);
    held = Array.from({ length: 6 * MAX_L2_LANE_WALLS }, (_, i) => ({ id: 10_000_000 * (1 + (i % 6)) + 1 + Math.floor(i / 6), lane: 1 + (i % 6), side: "bid", row: 100 + i, span: 1, startTs: T - 5_000, endTs: null, size: 300, peak: 300, endedBy: null, ratio: 0, chain: 0, fill: 0, eaten: 0, absorbing: false, detail: null }));
    const diff = h.tick();
    expect(diff.lanedWalls.walls.length).toBeLessThanOrEqual(MAX_L2_WALLS);
    expect(diff.walls === null || diff.walls.walls.length <= 400).toBe(true);
    const snap = h.snapshot();
    expect(snap.lanedWalls.walls.length).toBe(400 + 6 * MAX_L2_LANE_WALLS);
    expect(snap.lanedWalls.walls.length).toBeLessThanOrEqual(MAX_L2_WALLS);
    expect(snap.walls.walls).toHaveLength(400);
    const { snapshotFramesOf } = require("../../../src/server/l2-channel");
    const identity = { provider: "BINANCE", symbol: SYMBOL, marketKind: KIND };
    expect(() => snapshotFramesOf("l2_walls_lanes", identity, snap)).not.toThrow();
    expect(snapshotFramesOf("l2_walls_lanes", identity, snap)[0].walls).toHaveLength(400 + 6 * MAX_L2_LANE_WALLS);
    expect(snapshotFramesOf("l2_walls", identity, snap)[0].walls).toHaveLength(400);
    expect(snapshotFramesOf("l2_walls", identity, snap)[0].walls.every((entry) => !("lane" in entry))).toBe(true);
  });
});
