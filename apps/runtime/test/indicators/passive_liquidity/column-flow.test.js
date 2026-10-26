const { createColumnFlow, DEFAULT_MAX_PRINTS } = require("../../../src/indicators/passive_liquidity/column-flow");

const keyFor = (price) => Math.floor(Math.round(price / 0.5));
const flowFor = (options) => createColumnFlow({ keyFor, columnMs: 1_000, ...options });
const column = (ts, lo = 100, hi = 110) => ({ ts, lo, hi, bid: new Float64Array(hi - lo + 1), ask: new Float64Array(hi - lo + 1) });

describe("column-flow", () => {
  test("a book gap discards expired pending flow without fabricating a column or dropping recoverable late flow", () => {
    const flow = flowFor({ rowClusters: 2 });
    for (let ts = 1_000; ts <= 30_000; ts += 1_000) {
      flow.push({ ts, price: 100, size: 1, side: "buy", id: String(ts) });
      flow.prune(ts);
      expect(flow.pending).toBeLessThanOrEqual(2);
    }
    expect(flow.dropped).toBe(28);
    const resumed = flow.take(column(30_000));
    expect(resumed.buy).toEqual([[0, 2]]);
    expect(resumed.prints.map((print) => print.ts)).toEqual([29_000, 30_000]);
    expect(flow.pending).toBe(0);
  });
  test("validates its options", () => {
    expect(() => createColumnFlow({ rowClusters: 2, columnMs: 1_000 })).toThrow(/keyFor/);
    expect(() => createColumnFlow({ keyFor, rowClusters: 2 })).toThrow(/columnMs/);
    expect(() => flowFor({ rowClusters: 0 })).toThrow(/rowClusters/);
    expect(() => flowFor({ rowClusters: 2, floorShare: 1 })).toThrow(/floorShare/);
    expect(() => flowFor({ rowClusters: 2, maxPrints: 0 })).toThrow(/maxPrints/);
  });

  test("sums each print's size into its row on the aggressor's side, quantised like the book, and drops rows outside the window", () => {
    const flow = flowFor({ rowClusters: 2 });
    flow.push({ ts: 900, price: 100.0, size: 1.234, side: "buy", id: "a" });
    flow.push({ ts: 950, price: 100.4, size: 2, side: "buy", id: "b" });
    flow.push({ ts: 990, price: 101.0, size: 0.5, side: "sell", id: "c" });
    flow.push({ ts: 995, price: 500, size: 9, side: "sell", id: "far" });
    const out = flow.take(column(1_000));
    expect(out.buy).toEqual([[0, 3.2]]);
    expect(out.sell).toEqual([[1, 0.5]]);
    expect(out.prints.map((p) => p.id)).toEqual(["a", "b", "c", "far"]);
    expect(out.printsFloor).toBe(0);
    expect(Object.isFrozen(out)).toBe(true);
    expect(out.ts).toBe(1_000);
  });

  test("a print from the second before the column's own is kept and counted late: it reached the flow after its own column was taken", () => {
    // 2026-09-20: trades reach the runtime 480-680 ms after they print and the column is taken on the first tick after
    // its second ends, so every print in the last half of a second used to arrive too late and was thrown away --
    // 60% of the tape on a quiet ETH perp, 95% in a burst. The 09:00 print is 14:04:00's 1,818 ETH: it belongs to
    // the column just taken, and the next column is where it can still be credited.
    const flow = flowFor({ rowClusters: 1 });
    flow.push({ ts: 9_000, price: 100, size: 2, side: "buy", id: "late" });
    flow.push({ ts: 9_001, price: 100, size: 1, side: "buy", id: "in" });
    const out = flow.take(column(10_000, 195, 205));
    expect(out.prints.map((p) => p.id)).toEqual(["late", "in"]);
    expect(out.buy).toEqual([[5, 3]]);
    expect(flow.pending).toBe(0);
    expect(flow.late).toBe(1);
    expect(flow.dropped).toBe(0);
  });

  test("a print older than that is dropped and counted, at the boundary exactly: two columns back is out, one past it is in", () => {
    const flow = flowFor({ rowClusters: 1 });
    flow.push({ ts: 1, price: 100, size: 1, side: "buy", id: "stale" });
    flow.push({ ts: 8_000, price: 100, size: 1, side: "buy", id: "edge-out" });
    flow.push({ ts: 8_001, price: 100, size: 1, side: "buy", id: "edge-in" });
    const out = flow.take(column(10_000, 195, 205));
    expect(out.prints.map((p) => p.id)).toEqual(["edge-in"]);
    expect(out.buy).toEqual([[5, 1]]);
    expect(flow.pending).toBe(0);
    expect(flow.late).toBe(1);
    expect(flow.dropped).toBe(2);
    // The counts are for the life of the flow, not the column.
    flow.push({ ts: 10_500, price: 100, size: 1, side: "buy", id: "own" });
    flow.take(column(11_000, 195, 205));
    expect([flow.late, flow.dropped]).toEqual([1, 2]);
  });

  test("a print later than the column's time waits for the next column", () => {
    const flow = flowFor({ rowClusters: 1 });
    flow.push({ ts: 1_000, price: 100, size: 1, side: "buy", id: "on" });
    flow.push({ ts: 1_001, price: 100, size: 1, side: "buy", id: "after" });
    expect(flow.take(column(1_000)).prints.map((p) => p.id)).toEqual(["on"]);
    expect(flow.pending).toBe(1);
    expect(flow.take(column(2_000)).prints.map((p) => p.id)).toEqual(["after"]);
    expect(flow.pending).toBe(0);
  });

  test("keeps at most maxPrints per column, the largest, in time order", () => {
    const flow = flowFor({ rowClusters: 1, maxPrints: 3 });
    for (let i = 0; i < 10; i += 1) flow.push({ ts: 100 + i, price: 100, size: (i * 7) % 10 + 1, side: "sell", id: String(i) });
    const out = flow.take(column(1_000, 195, 205));
    expect(out.prints.map((p) => [p.id, p.size])).toEqual([["1", 8], ["4", 9], ["7", 10]]);
    expect(out.printsFloor).toBe(8);
    expect(out.buy).toEqual([]);
    expect(out.sell).toEqual([[5, 55]]);
  });

  test("an oversized equal-size group is omitted, so the floor never claims complete coverage of only part of it", () => {
    const flow = flowFor({ rowClusters: 1, maxPrints: 2 });
    for (let i = 0; i < 3; i += 1) flow.push({ ts: 100 + i, price: 100, size: 10, side: "buy", id: String(i) });
    const out = flow.take(column(1_000, 195, 205));
    expect(out.buy).toEqual([[5, 30]]);
    expect(out.prints).toEqual([]);
    expect(out.printsFloor).toBeGreaterThan(10);
  });

  test("the print floor is the size only the top share of recent prints reach, once enough have been seen", () => {
    const flow = flowFor({ rowClusters: 1, floorShare: 0.1, floorWindow: 100, floorMinSamples: 50 });
    for (let i = 1; i <= 49; i += 1) flow.push({ ts: i, price: 100, size: i, side: "buy", id: String(i) });
    expect(flow.floor()).toBe(0);
    flow.push({ ts: 50, price: 100, size: 50, side: "buy", id: "50" });
    expect(flow.floor()).toBe(45);
    const out = flow.take(column(1_000));
    expect(out.printsFloor).toBe(45);
    expect(out.prints.map((p) => p.size)).toEqual([45, 46, 47, 48, 49, 50]);
    for (let i = 1; i <= 100; i += 1) flow.push({ ts: 1_000 + i, price: 100, size: 1000 + i, side: "buy", id: `big${i}` });
    expect(flow.floor()).toBe(1090);
  });

  test("ignores prints it cannot place", () => {
    const flow = flowFor({ rowClusters: 1 });
    flow.push({ ts: 1, price: 100, size: 0, side: "buy", id: "zero" });
    flow.push({ ts: 1, price: 100, size: 1, side: "mixed", id: "side" });
    flow.push({ ts: 1, price: -1, size: 1, side: "buy", id: "price" });
    expect(flow.take(column(1_000)).prints).toEqual([]);
    expect(DEFAULT_MAX_PRINTS).toBe(64);
  });

  test("a print over the wire magnitude is capped at it, in the print, the row sum and the floor, and counted", () => {
    const { MAX_WIRE_MAGNITUDE } = require("../../../src/server/wire-fields");
    const flow = flowFor({ rowClusters: 2 });
    flow.push({ ts: 900, price: 100, size: 17_000_000, side: "sell", id: "auction" });
    flow.push({ ts: 950, price: 100, size: 1, side: "sell", id: "b" });
    flow.push({ ts: 960, price: 100, size: MAX_WIRE_MAGNITUDE, side: "buy", id: "c" });
    flow.push({ ts: 970, price: 100, size: MAX_WIRE_MAGNITUDE, side: "buy", id: "d" });
    const out = flow.take(column(1_000));
    expect(out.sell).toEqual([[0, MAX_WIRE_MAGNITUDE]]);
    expect(out.buy).toEqual([[0, MAX_WIRE_MAGNITUDE]]);
    expect(out.prints.map((print) => [print.id, print.size])).toEqual([["auction", MAX_WIRE_MAGNITUDE], ["b", 1], ["c", MAX_WIRE_MAGNITUDE], ["d", MAX_WIRE_MAGNITUDE]]);
    expect(out.printsFloor).toBeLessThanOrEqual(MAX_WIRE_MAGNITUDE);
    expect(flow.clipped).toBe(2);
    expect(flowFor({ rowClusters: 2 }).clipped).toBe(0);
  });
});
