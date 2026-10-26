const { liquidityFrame, MAX_LIQUIDITY_COLUMNS, MAX_LIQUIDITY_ROWS, MAX_LIQUIDITY_LEVELS, MAX_AGGRESSIVE_EVENTS, MAX_LIQUIDITY_PRINTS, MAX_WIRE_MAGNITUDE } = require("../../src/server/frames");
const { floorAbove } = require("../../src/indicators/passive_liquidity/bounded-prints");

const T = 1_700_000_000_000;
const COLUMN = Object.freeze({ ts: T, lo: 39_800, hi: 40_200, bid: [[0, 1.5], [200, 0.5]], ask: [[201, 2]] });
const BASE = Object.freeze({ ts: T, seq: 1, reset: true, rowWidth: 2, columnMs: 1000, columns: [COLUMN] });

describe("server/frames liquidityFrame", () => {
  test("wraps columns into the wire shape", () => {
    expect(liquidityFrame("BTCUSDT", "PERPETUAL", BASE)).toEqual({
      type: "liquidity",
      provider: "BINANCE",
      symbol: "BTC-USDT",
      marketKind: "PERPETUAL",
      ts: T,
      seq: 1,
      reset: true,
      row_width: 2,
      column_ms: 1000,
      columns: [{ ts: T, lo: 39_800, hi: 40_200, bid: [[0, 1.5], [200, 0.5]], ask: [[201, 2]] }],
    });
  });

  test("an empty column list is valid only with reset", () => {
    expect(liquidityFrame("BTCUSDT", "SPOT", { ...BASE, seq: 0, columns: [] }).columns).toEqual([]);
    expect(() => liquidityFrame("BTCUSDT", "SPOT", { ...BASE, reset: false, columns: [] })).toThrow(/columns/);
  });

  test("columns must be in time order, no later than the frame, within the row cap", () => {
    const later = { ...COLUMN, ts: T + 1 };
    expect(() => liquidityFrame("BTCUSDT", "SPOT", { ...BASE, columns: [later] })).toThrow(/columns\[0\]\.ts/);
    expect(() => liquidityFrame("BTCUSDT", "SPOT", { ...BASE, ts: T + 5, seq: 2, columns: [later, COLUMN] })).toThrow(/columns\[1\]\.ts/);
    expect(() => liquidityFrame("BTCUSDT", "SPOT", { ...BASE, columns: [{ ...COLUMN, lo: 0, hi: MAX_LIQUIDITY_ROWS }] })).toThrow(/rows/);
    expect(() => liquidityFrame("BTCUSDT", "SPOT", { ...BASE, columns: [{ ...COLUMN, lo: 5, hi: 4 }] })).toThrow(/lo\/hi/);
    expect(liquidityFrame("BTCUSDT", "SPOT", { ...BASE, columns: [{ ...COLUMN, lo: 0, hi: MAX_LIQUIDITY_ROWS - 1, bid: [], ask: [] }] }).columns[0].hi).toBe(MAX_LIQUIDITY_ROWS - 1);
  });

  test("entries are increasing offsets inside the window with non-negative sizes", () => {
    const withBid = (bid) => liquidityFrame("BTCUSDT", "SPOT", { ...BASE, columns: [{ ...COLUMN, bid }] });
    expect(() => withBid([[401, 1]])).toThrow(/offset/);
    expect(() => withBid([[-1, 1]])).toThrow(/offset/);
    expect(() => withBid([[5, 1], [5, 2]])).toThrow(/offset/);
    expect(() => withBid([[5, 1], [2, 2]])).toThrow(/offset/);
    expect(() => withBid([[5, -1]])).toThrow(/size/);
    expect(() => withBid([[5, Infinity]])).toThrow(/size/);
    expect(() => withBid([[5]])).toThrow(/pair/);
    expect(() => withBid("nope")).toThrow(/array/);
    expect(withBid([[5, 0]]).columns[0].bid).toEqual([[5, 0]]);
  });

  test("a column's flow is optional, validated, and renamed to the wire shape", () => {
    const print = { ts: T - 500, price: 80_000, size: 2.5, side: "buy", id: 123 };
    const flowed = { ...COLUMN, buy: [[0, 2.5]], sell: [[200, 1]], prints: [print], printsFloor: 2 };
    const frame = liquidityFrame("BTCUSDT", "SPOT", { ...BASE, columns: [flowed] });
    expect(frame.columns[0]).toEqual({ ...COLUMN, buy: [[0, 2.5]], sell: [[200, 1]], prints: [{ ts: T - 500, price: 80_000, size: 2.5, side: "buy", id: "123" }], prints_floor: 2 });
    expect(Object.keys(liquidityFrame("BTCUSDT", "SPOT", BASE).columns[0])).toEqual(["ts", "lo", "hi", "bid", "ask"]);
    const bad = (patch) => () => liquidityFrame("BTCUSDT", "SPOT", { ...BASE, columns: [{ ...flowed, ...patch }] });
    expect(bad({ buy: [[401, 1]] })).toThrow(/buy\[0\]\.offset/);
    expect(bad({ sell: [[0, -1]] })).toThrow(/sell\[0\]\.size/);
    expect(bad({ prints: Array.from({ length: MAX_LIQUIDITY_PRINTS + 1 }, () => print) })).toThrow(/at most 64 prints/);
    expect(bad({ prints: [{ ...print, ts: T + 1_001 }] })).toThrow(/prints\[0\]\.ts/);
    // A print from the second before the column's own, credited late (2026-09-20), is on the wire; two back is not.
    expect(liquidityFrame("BTCUSDT", "SPOT", { ...BASE, columns: [{ ...flowed, prints: [{ ...print, ts: T - 2_000 }] }] }).columns[0].prints[0].ts).toBe(T - 2_000);
    expect(bad({ prints: [{ ...print, ts: T - 2_001 }] })).toThrow(/prints\[0\]\.ts/);
    expect(liquidityFrame("BTCUSDT", "SPOT", { ...BASE, columns: [{ ...flowed, prints: [{ ...print, ts: T + 1_000 }] }] }).columns[0].prints[0].ts).toBe(T + 1_000);
    expect(bad({ prints: [{ ...print, ts: T }, { ...print, ts: T - 1 }] })).toThrow(/prints\[1\]\.ts/);
    expect(bad({ prints: [{ ...print, side: "both" }] })).toThrow(/prints\[0\]\.side/);
    expect(bad({ prints: [{ ...print, size: 0 }] })).toThrow(/prints\[0\]\.size/);
    expect(bad({ prints: [{ ...print, price: "x" }] })).toThrow(/prints\[0\]\.price/);
    expect(bad({ printsFloor: -1 })).toThrow(/printsFloor/);
    expect(liquidityFrame("BTCUSDT", "SPOT", { ...BASE, columns: [{ ...flowed, prints: [], printsFloor: floorAbove(MAX_WIRE_MAGNITUDE) }] }).columns[0].prints_floor).toBeGreaterThan(MAX_WIRE_MAGNITUDE);
    expect(liquidityFrame("BTCUSDT", "SPOT", { ...BASE, columns: [{ ...flowed, prints: [{ ...print, id: null }] }] }).columns[0].prints[0].id).toBeNull();
  });

  test("levels are optional, validated, and renamed to the wire shape", () => {
    expect(liquidityFrame("BTCUSDT", "SPOT", BASE).levels).toBeUndefined();
    const active = { side: "bid", row: 40_000, span: 1, startTs: T - 5_000, endTs: null, size: 7, peak: 9, endedBy: null };
    const eaten = { side: "ask", row: 40_010, span: 3, startTs: T - 9_000, endTs: T - 1_000, size: 0, peak: 12, endedBy: "filled" };
    const frame = liquidityFrame("BTCUSDT", "SPOT", { ...BASE, levels: [active, eaten] });
    expect(frame.levels).toEqual([
      { side: "bid", row: 40_000, span: 1, start_ts: T - 5_000, end_ts: null, size: 7, peak: 9, ended_by: null, ratio: 0, chain: 0, fill: 0, eaten: 0, absorbing: false },
      { side: "ask", row: 40_010, span: 3, start_ts: T - 9_000, end_ts: T - 1_000, size: 0, peak: 12, ended_by: "filled", ratio: 0, chain: 0, fill: 0, eaten: 0, absorbing: false },
    ]);
    const withLevels = (levels) => liquidityFrame("BTCUSDT", "SPOT", { ...BASE, levels });
    expect(() => withLevels("nope")).toThrow(/levels/);
    expect(() => withLevels(new Array(MAX_LIQUIDITY_LEVELS + 1).fill(active))).toThrow(/levels/);
    expect(() => withLevels([{ ...active, side: "buy" }])).toThrow(/side/);
    expect(() => withLevels([{ ...active, row: -1 }])).toThrow(/row/);
    expect(() => withLevels([{ ...active, span: 0 }])).toThrow(/span/);
    expect(() => withLevels([{ ...active, startTs: T + 1 }])).toThrow(/startTs/);
    expect(() => withLevels([{ ...eaten, endTs: T + 1 }])).toThrow(/endTs/);
    expect(() => withLevels([{ ...eaten, endTs: eaten.startTs - 1 }])).toThrow(/endTs/);
    expect(() => withLevels([{ ...eaten, endedBy: null }])).toThrow(/endedBy/);
    expect(() => withLevels([{ ...active, endedBy: "pulled" }])).toThrow(/endedBy/);
    expect(() => withLevels([{ ...active, endedBy: "gone", endTs: T }])).toThrow(/endedBy/);
    expect(() => withLevels([{ ...active, peak: 6 }])).toThrow(/peak/);
    expect(() => withLevels([{ ...active, size: -1 }])).toThrow(/size/);
    expect(withLevels([{ ...active, ratio: 2.5 }]).levels[0].ratio).toBe(2.5);
    expect(() => withLevels([{ ...active, ratio: -1 }])).toThrow(/ratio/);
    // The other verdicts, and the trace id.
    expect(withLevels([{ ...eaten, endedBy: "hit" }]).levels[0].ended_by).toBe("hit");
    expect(withLevels([{ ...eaten, endedBy: "moved", chain: 3 }]).levels[0]).toMatchObject({ ended_by: "moved", chain: 3 });
    expect(withLevels([{ ...active, chain: 3 }]).levels[0].chain).toBe(3);
    expect(() => withLevels([{ ...active, chain: -1 }])).toThrow(/chain/);
    expect(() => withLevels([{ ...active, chain: 1.5 }])).toThrow(/chain/);
    // The share that traded, and whether a resting wall is being traded into.
    expect(withLevels([{ ...eaten, endedBy: "partial", fill: 0.33 }]).levels[0]).toMatchObject({ ended_by: "partial", fill: 0.33 });
    expect(withLevels([{ ...active, absorbing: true, fill: 1 }]).levels[0]).toMatchObject({ absorbing: true, fill: 1 });
    expect(() => withLevels([{ ...active, fill: 1.5 }])).toThrow(/fill/);
    expect(() => withLevels([{ ...active, fill: -0.1 }])).toThrow(/fill/);
    // The share of its peak that traded rides along beside it.
    expect(withLevels([{ ...eaten, eaten: 0.52 }]).levels[0]).toMatchObject({ eaten: 0.52 });
    expect(() => withLevels([{ ...active, eaten: 1.5 }])).toThrow(/eaten/);
    expect(() => withLevels([{ ...active, eaten: -0.1 }])).toThrow(/eaten/);
    expect(() => withLevels([{ ...active, absorbing: "yes" }])).toThrow(/absorbing/);
    expect(() => withLevels([{ ...eaten, absorbing: true }])).toThrow(/absorbing/);
  });

  test("aggressive-order clusters are optional, validated, and renamed to the wire shape", () => {
    expect(liquidityFrame("BTCUSDT", "SPOT", BASE).aggressive).toBeUndefined();
    const withEvents = (aggressive) => liquidityFrame("BTCUSDT", "SPOT", { ...BASE, aggressive });
    const live = { side: "buy", row: 40_000, span: 1, startTs: T - 5_000, endTs: null, volume: 12, peak: 12, floor: 10 };
    const done = { side: "sell", row: 40_010, span: 3, startTs: T - 9_000, endTs: T - 1_000, volume: 60, peak: 25, floor: 10 };
    const frame = liquidityFrame("BTCUSDT", "SPOT", { ...BASE, aggressive: [live, done] });
    expect(frame.aggressive).toEqual([
      { side: "buy", row: 40_000, span: 1, start_ts: T - 5_000, end_ts: null, volume: 12, peak: 12, floor: 10 },
      { side: "sell", row: 40_010, span: 3, start_ts: T - 9_000, end_ts: T - 1_000, volume: 60, peak: 25, floor: 10 },
    ]);
    expect(withEvents([]).aggressive).toEqual([]);
    expect(() => withEvents("nope")).toThrow(/aggressive/);
    expect(() => withEvents(new Array(MAX_AGGRESSIVE_EVENTS + 1).fill(live))).toThrow(/aggressive/);
    expect(() => withEvents([{ ...live, side: "bid" }])).toThrow(/side/);
    expect(() => withEvents([{ ...live, row: -1 }])).toThrow(/row/);
    expect(() => withEvents([{ ...live, span: 0 }])).toThrow(/span/);
    expect(() => withEvents([{ ...live, startTs: T + 1 }])).toThrow(/startTs/);
    expect(() => withEvents([{ ...done, endTs: done.startTs - 1 }])).toThrow(/endTs/);
    expect(() => withEvents([{ ...live, peak: 13 }])).toThrow(/peak/);
    expect(() => withEvents([{ ...live, volume: -1 }])).toThrow(/volume/);
    expect(() => withEvents([{ ...live, floor: "ten" }])).toThrow(/floor/);
  });

  test("rejects a bad envelope", () => {
    expect(() => liquidityFrame("BTCUSDT", "MARGIN", BASE)).toThrow(/marketKind/);
    expect(() => liquidityFrame("BTCUSDT", "SPOT", { ...BASE, ts: -1 })).toThrow(/ts/);
    expect(() => liquidityFrame("BTCUSDT", "SPOT", { ...BASE, seq: -1 })).toThrow(/seq/);
    expect(() => liquidityFrame("BTCUSDT", "SPOT", { ...BASE, seq: 0 })).toThrow(/seq/);
    expect(() => liquidityFrame("BTCUSDT", "SPOT", { ...BASE, reset: "yes" })).toThrow(/reset/);
    expect(() => liquidityFrame("BTCUSDT", "SPOT", { ...BASE, rowWidth: 0 })).toThrow(/rowWidth/);
    expect(() => liquidityFrame("BTCUSDT", "SPOT", { ...BASE, columnMs: 0 })).toThrow(/columnMs/);
    expect(() => liquidityFrame("BTCUSDT", "SPOT", { ...BASE, seq: MAX_LIQUIDITY_COLUMNS + 1, columns: new Array(MAX_LIQUIDITY_COLUMNS + 1).fill(COLUMN) })).toThrow(/columns/);
  });
});
