const {
  l2ViewFrame,
  l2WallsFrame,
  l2EventsFrame,
  l2LadderFrame,
  parseCapabilities,
  capabilitiesMessage,
  MAX_L2_WALLS,
  MAX_L2_LEGACY_WALLS,
  MAX_L2_LANE_WALLS,
  MAX_L2_LANE,
  MAX_L2_EVENTS,
  MAX_L2_LADDER_LEVELS,
} = require("../../src/server/l2-frames");

const BINANCE = { provider: "BINANCE", symbol: "BTCUSDT", marketKind: "PERPETUAL" };
const DXFEED = { provider: "DXFEED", symbol: "/NQU26:XCME", assetClass: "FUTURE" };
const SEGMENT = { id: "PERPETUAL:BTCUSDT:1000:LIVE", state: "LIVE" };

function column(ts, extra = {}) {
  return { ts, lo: 100, hi: 102, bid: [[0, 1.5]], ask: [[2, 2]], ...extra };
}

function view(overrides = {}) {
  return { lane: 2, tier: "recent", ts: 4_000, seq: 7, reset: false, rowWidth: 0.5, columnMs: 4_000, columns: [column(4_000)], segment: SEGMENT, ...overrides };
}

function detail(overrides = {}) {
  return {
    lifeMs: 9_000, firstShrinkTs: null, firstShrinkExact: false, reachedAtFirstShrink: null, traded: 0, absorbed: 0, swept: 0,
    hidden: 0, cleared: 0, fillRatio: 0, crossSide: 3, crossSideShare: 0.25, endDistanceRows: null, endDistancePct: null,
    clearedByTrades: false, continuity: null, repeats: 1, repeatsComplete: false, evidenceGap: false, ...overrides,
  };
}

function wall(id, overrides = {}) {
  return {
    id, side: "bid", row: 200, span: 1, startTs: 1_000, endTs: null, size: 12, peak: 12, endedBy: null, ratio: 4, chain: 0,
    fill: 0, eaten: 0, absorbing: false, detail: detail(), ...overrides,
  };
}

describe("l2ViewFrame", () => {
  test("the shared fixtures are valid, so every refusal below is caused by its own override", () => {
    expect(() => l2ViewFrame(BINANCE, view())).not.toThrow();
    expect(() => l2WallsFrame(BINANCE, { ts: 10_000, seq: 3, reset: false, rowWidth: 0.5, walls: [wall(5)], removed: [4], segment: SEGMENT })).not.toThrow();
  });

  test("carries a lane column in the liquidity encoding, with its lane, tier and segment", () => {
    const frame = l2ViewFrame(BINANCE, view());
    expect(frame).toMatchObject({ type: "l2_view", provider: "BINANCE", marketKind: "PERPETUAL", lane: 2, tier: "recent", seq: 7, reset: false, column_ms: 4_000, segment: SEGMENT });
    expect(frame.columns).toHaveLength(1);
    expect(l2ViewFrame(DXFEED, view()).assetClass).toBe("FUTURE");
  });

  test.each([
    ["lane 0 (lane 0 stays on liquidity)", { lane: 0 }],
    ["lane 7", { lane: 7 }],
    ["a fractional lane", { lane: 1.5 }],
    ["an unknown tier", { tier: "coarse" }],
    ["a column with prints", { columns: [column(4_000, { prints: [] })] }],
    ["a segment with an unknown state", { segment: { id: "x", state: "HALT" } }],
    ["a segment with an empty id", { segment: { id: "", state: "LIVE" } }],
    ["a segment id over 160 characters", { segment: { id: "x".repeat(161), state: "LIVE" } }],
  ])("refuses %s", (_label, overrides) => {
    expect(() => l2ViewFrame(BINANCE, view(overrides))).toThrow();
  });

  test("refuses an unknown provider", () => {
    expect(() => l2ViewFrame({ provider: "OTHER", symbol: "X" }, view())).toThrow(/provider/);
  });
});

describe("l2WallsFrame", () => {
  const base = { ts: 10_000, seq: 3, reset: false, rowWidth: 0.5, segment: SEGMENT };

  test("an increment carries changed walls with their id and detail, and removed ids", () => {
    const frame = l2WallsFrame(BINANCE, { ...base, walls: [wall(5)], removed: [4] });
    expect(frame).toMatchObject({ type: "l2_walls", seq: 3, reset: false, removed: [4], segment: SEGMENT });
    expect(frame.walls[0]).toMatchObject({ id: 5, side: "bid", start_ts: 1_000, end_ts: null });
    expect(frame.walls[0].detail).toMatchObject({ cross_side: 3, cross_side_share: 0.25, repeats: 1 });
  });

  test("life_ms is null while a wall is active and exact once it ended", () => {
    const active = l2WallsFrame(BINANCE, { ...base, walls: [wall(5)] }).walls[0].detail;
    const ended = l2WallsFrame(BINANCE, { ...base, walls: [wall(5, { endTs: 9_000, endedBy: "pulled" })] }).walls[0].detail;
    expect(active.life_ms).toBeNull();
    expect(ended.life_ms).toBe(9_000);
  });

  test("a wall may carry no detail (restored before the engine saw it)", () => {
    expect(l2WallsFrame(BINANCE, { ...base, walls: [wall(5, { detail: null })] }).walls[0].detail).toBeNull();
  });

  test("a reset carries the whole set, which may be empty", () => {
    expect(l2WallsFrame(BINANCE, { ...base, reset: true, walls: [] }).walls).toEqual([]);
  });

  test.each([
    ["a reset that also removes", { reset: true, walls: [wall(5)], removed: [4] }],
    ["an increment that changes nothing", { walls: [], removed: [] }],
    ["a duplicate id", { walls: [wall(5), wall(5, { row: 300 })] }],
    ["an id both upserted and removed", { walls: [wall(5)], removed: [5] }],
    ["a zero id", { walls: [wall(0)] }],
    ["a duplicate removed id", { walls: [], removed: [4, 4] }],
    ["more walls than the cap", { reset: true, walls: Array.from({ length: MAX_L2_WALLS + 1 }, (_, i) => wall(i + 1)) }],
    ["a fill ratio above 1", { walls: [wall(5, { detail: detail({ fillRatio: 1.2 }) })] }],
    ["a negative traded size", { walls: [wall(5, { detail: detail({ traded: -1 }) })] }],
    ["zero repeats", { walls: [wall(5, { detail: detail({ repeats: 0 }) })] }],
    ["a negative seq", { seq: -1, walls: [wall(5)] }],
  ])("refuses %s", (_label, overrides) => {
    expect(() => l2WallsFrame(BINANCE, { ...base, ...overrides })).toThrow();
  });
});

describe("l2EventsFrame", () => {
  const events = [
    { event: "segment", ts: 1_000, segment: "PERPETUAL:BTCUSDT:1000", state: "LIVE", cause: null },
    { event: "wall_born", ts: 1_000, wall: 5, side: "bid", row: 200, span: 1, size: 12 },
    { event: "wall_trade", ts: 1_100, wall: 5, mode: "absorbed", price: 100, size: 2 },
    { event: "wall_hidden", ts: 1_150, wall: 5, volume: 1 },
    { event: "wall_shrink", ts: 1_200, wall: 5, exact: true, reached: true },
    { event: "trade", ts: 1_300, side: "ask", aggressor: "buy", mode: "swept", price: 101, size: 0.5, late: false },
    { event: "hidden", ts: 1_400, side: "bid", price: 100, volume: 0.25 },
    { event: "wall_end", ts: 1_500, wall: 5, endedBy: "filled", distanceRows: 0 },
  ];

  test("carries every event kind in time order with snake_case fields", () => {
    const frame = l2EventsFrame(BINANCE, { ts: 2_000, seq: 20, reset: false, events, missed: 3 });
    expect(frame.events.map((event) => event.event)).toEqual(events.map((event) => event.event));
    expect(frame.events[7]).toEqual({ event: "wall_end", ts: 1_500, wall: 5, ended_by: "filled", distance_rows: 0 });
    expect(frame.missed).toBe(3);
  });

  test("an increment may carry only a missed count", () => {
    expect(l2EventsFrame(BINANCE, { ts: 2_000, seq: 20, reset: false, events: [], missed: 12 }).events).toEqual([]);
  });

  test.each([
    ["an unknown kind", { events: [{ event: "iceberg", ts: 1_000 }] }],
    ["an event after the frame ts", { events: [{ ...events[6], ts: 2_001 }] }],
    ["events out of time order", { events: [events[2], events[1]] }],
    ["a seq that counts fewer events than the frame holds", { seq: 7 }],
    ["an empty increment with nothing missed", { events: [], missed: 0 }],
    ["more events than the cap", { seq: MAX_L2_EVENTS + 1, events: Array.from({ length: MAX_L2_EVENTS + 1 }, () => events[6]) }],
    ["a wall trade with an unknown mode", { events: [{ ...events[2], mode: "iceberg" }] }],
    ["a trade whose aggressor is a book side", { events: [{ ...events[5], aggressor: "bid" }] }],
    ["an unknown verdict", { events: [{ ...events[7], endedBy: "vanished" }] }],
    ["a segment with an unknown state", { events: [{ ...events[0], state: "STALE" }] }],
    ["a negative missed count", { missed: -1 }],
  ])("refuses %s", (_label, overrides) => {
    expect(() => l2EventsFrame(BINANCE, { ts: 2_000, seq: 20, reset: false, events, missed: 0, ...overrides })).toThrow();
  });
});

describe("l2LadderFrame", () => {
  const book = { ts: 5_000, depth: 3, bids: [[100, 1], [99.5, 2], [99, 3]], asks: [[100.5, 1], [101, 2]], segment: SEGMENT };

  test("carries the exact book, bids descending and asks ascending", () => {
    const frame = l2LadderFrame(DXFEED, book);
    expect(frame).toMatchObject({ type: "l2_ladder", provider: "DXFEED", depth: 3, bids: book.bids, asks: book.asks, segment: SEGMENT });
  });

  test.each([
    ["bids not descending", { bids: [[99, 1], [100, 1]] }],
    ["asks not ascending", { asks: [[101, 1], [100.5, 1]] }],
    ["a repeated price", { bids: [[100, 1], [100, 2]] }],
    ["a crossed book", { bids: [[101, 1]], asks: [[100.5, 1]] }],
    ["a locked book", { bids: [[100.5, 1]], asks: [[100.5, 1]] }],
    ["more levels than depth", { depth: 2 }],
    ["depth above the cap", { depth: MAX_L2_LADDER_LEVELS + 1 }],
    ["a zero size", { bids: [[100, 0]] }],
    ["a level that is not a pair", { bids: [[100, 1, 2]] }],
  ])("refuses %s", (_label, overrides) => {
    expect(() => l2LadderFrame(DXFEED, { ...book, ...overrides })).toThrow();
  });
});

describe("parseCapabilities", () => {
  test("reads a set of true flags, including marker_history", () => {
    expect([...parseCapabilities({ type: "capabilities", marker_history: true, l2_walls: true })].sort()).toEqual(["l2_walls", "marker_history"]);
  });

  test("an empty declaration is the empty set (a client opting out)", () => {
    expect(parseCapabilities({ type: "capabilities" }).size).toBe(0);
  });

  test.each([
    ["an unknown flag", { type: "capabilities", l2_depth: true }],
    ["a false flag", { type: "capabilities", l2_view: false }],
    ["a string flag", { type: "capabilities", l2_view: "true" }],
    ["another message type", { type: "select", l2_view: true }],
    ["a non-object", "capabilities"],
    ["null", null],
  ])("refuses %s", (_label, message) => {
    expect(parseCapabilities(message)).toBeNull();
  });

  test("capabilitiesMessage writes the flags in one canonical order", () => {
    expect(JSON.stringify(capabilitiesMessage(new Set(["l2_ladder", "marker_history", "l2_view"]))))
      .toBe(JSON.stringify({ type: "capabilities", marker_history: true, l2_view: true, l2_ladder: true }));
  });

  test("l2WallsFrame for a client that declared no lanes is today's lane-0 frame: no lane field, the old wall keys exactly, at most 400 walls, and a wider lane's wall is refused (PR #31 review)", () => {
    const base = { ts: 10_000, seq: 3, reset: false, rowWidth: 0.5, segment: SEGMENT };
    const frame = l2WallsFrame(BINANCE, { ...base, walls: [wall(5), wall(6, { lane: 0 })] });
    expect(frame.walls.map((entry) => Object.keys(entry).sort())).toEqual([0, 1].map(() => ["absorbing", "chain", "detail", "eaten", "end_ts", "ended_by", "fill", "id", "peak", "ratio", "row", "side", "size", "span", "start_ts"]));
    expect(() => l2WallsFrame(BINANCE, { ...base, walls: [wall(5, { lane: 1 })] })).toThrow(/lane/);
    expect(() => l2WallsFrame(BINANCE, { ...base, walls: Array.from({ length: MAX_L2_LEGACY_WALLS + 1 }, (_, i) => wall(i + 1)) })).toThrow(/at most 400/);
    expect(() => l2WallsFrame(BINANCE, { ...base, walls: [], removed: Array.from({ length: MAX_L2_LEGACY_WALLS + 1 }, (_, i) => i + 1) })).toThrow(/at most 400/);
    expect(MAX_L2_LEGACY_WALLS).toBe(400);
    expect(parseCapabilities({ type: "capabilities", l2_walls: true, l2_walls_lanes: true })).toEqual(new Set(["l2_walls", "l2_walls_lanes"]));
    expect(JSON.stringify(capabilitiesMessage(new Set(["l2_walls_lanes", "l2_walls"])))).toBe(JSON.stringify({ type: "capabilities", l2_walls: true, l2_walls_lanes: true }));
  });

  test("l2WallsFrame: a wall carries its lane, 0 when the tracker gave none, and a lane past the widest is refused", () => {
    const base = { ts: 10_000, seq: 3, reset: false, rowWidth: 0.5, segment: SEGMENT, lanes: true };
    const frame = l2WallsFrame(BINANCE, { ...base, walls: [wall(5), wall(6, { lane: 2 })] });
    expect(frame.walls.map((entry) => [entry.id, entry.lane])).toEqual([[5, 0], [6, 2]]);
    expect(() => l2WallsFrame(BINANCE, { ...base, walls: [wall(5, { lane: 7 })] })).toThrow(/lane/);
    expect(() => l2WallsFrame(BINANCE, { ...base, walls: [wall(5, { lane: -1 })] })).toThrow(/lane/);
    expect(() => l2WallsFrame(BINANCE, { ...base, walls: [wall(5, { lane: 1.5 })] })).toThrow(/lane/);
  });
});

describe("the walls cap (P4e2 change 5)", () => {
  test("leaves room for lane 0's whole list and a hundred walls on each wider lane, on walls and on removed ids alike", () => {
    expect(MAX_L2_WALLS).toBe(400 + MAX_L2_LANE * MAX_L2_LANE_WALLS);
    expect(require("../../src/server/l2-frames").MAX_L2_REMOVED).toBe(MAX_L2_WALLS);
  });
});
