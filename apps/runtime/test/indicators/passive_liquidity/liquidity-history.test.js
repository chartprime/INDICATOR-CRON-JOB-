const { createLiquidityHistory, createDeepFolder, coarsenColumn, encodeColumn, encodeAfter, decodeColumn, sizeAt } = require("../../../src/indicators/passive_liquidity/liquidity-history");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

function column(ts, lo, bid, ask) {
  return { ts, lo, hi: lo + bid.length - 1, bid: Float64Array.from(bid), ask: Float64Array.from(ask) };
}

describe("liquidity-history", () => {
  test("retained side-buffer accounting follows eviction, row shifts and clear", () => {
    const history = createLiquidityHistory({ maxColumns: 2 });
    history.push(column(1, 10, [1, 2], [3, 4]));
    expect(history.sideBufferBytes).toBe(32);
    history.push(column(2, 20, [1], [2]));
    history.push(column(3, 30, [1, 2, 3], [4, 5, 6]));
    expect(history.sideBufferBytes).toBe(64);
    history.clear();
    expect(history.sideBufferBytes).toBe(0);
  });
  test("the delta cache releases evicted predecessor chains while the latest columns remain live", () => {
    const result = JSON.parse(execFileSync(process.execPath, ["--expose-gc", path.join(__dirname, "../../fixtures/liquidity-cache-gc.cjs")], {
      timeout: 10_000, encoding: "utf8",
    }));
    expect(result.retained).toBe(2);
    expect(result.controlFirstAlive).toBe(false);
    expect(result.cachedFirstAlive).toBe(false);
    expect(result.bufferBytes).toBeLessThan(2 * 1024 * 1024);
  });

  test("cached encoding preserves resets, rebases and predecessor identity", () => {
    const a = column(1, 10, [1, 0, 3], [0, 4, 0]);
    const b = column(2, 11, [0, 3, 4], [4, 0, 0]);
    const alternate = column(1, 11, [9, 9, 9], [8, 8, 8]);
    const wire = encodeAfter(a, b);
    expect(wire).toEqual(encodeColumn(a, b));
    expect(encodeAfter(a, b)).toBe(wire);
    expect(encodeAfter(alternate, b)).toEqual(encodeColumn(alternate, b));
    expect(encodeAfter(null, b)).toEqual(encodeColumn(null, b));
    expect(encodeAfter(a, b)).toEqual(wire);
    const decoded = decodeColumn(a, wire);
    expect([...decoded.bid, ...decoded.ask]).toEqual([...b.bid, ...b.ask]);
  });

  test("sizeAt reads absolute rows and treats the outside as zero", () => {
    const c = column(1, 10, [1, 2, 3], [0, 0, 5]);
    expect(sizeAt(c, "bid", 10)).toBe(1);
    expect(sizeAt(c, "bid", 12)).toBe(3);
    expect(sizeAt(c, "ask", 12)).toBe(5);
    expect(sizeAt(c, "bid", 9)).toBe(0);
    expect(sizeAt(c, "bid", 13)).toBe(0);
    expect(sizeAt(null, "bid", 10)).toBe(0);
  });

  test("the first column is sent in full: every non-zero row", () => {
    const wire = encodeColumn(null, column(1, 10, [1, 0, 3], [0, 4, 0]));
    expect(wire).toEqual({ ts: 1, lo: 10, hi: 12, bid: [[0, 1], [2, 3]], ask: [[1, 4]] });
  });

  test("a later column lists only the rows that changed, including rows that went to zero", () => {
    const prev = column(1, 10, [1, 0, 3], [0, 4, 0]);
    const next = column(2, 10, [1, 2, 0], [0, 4, 0]);
    expect(encodeColumn(prev, next)).toEqual({ ts: 2, lo: 10, hi: 12, bid: [[1, 2], [2, 0]], ask: [] });
  });

  test("a shifted window re-sends rows that were outside the previous one and drops rows that left", () => {
    const prev = column(1, 10, [1, 2, 3], [0, 0, 0]);
    const next = column(2, 11, [2, 3, 4], [0, 0, 0]); // rows 11..13; row 13 is new, row 10 left (implicitly zero)
    expect(encodeColumn(prev, next)).toEqual({ ts: 2, lo: 11, hi: 13, bid: [[2, 4]], ask: [] });
  });

  test("push keeps at most maxColumns, counts seq forever, and enforces time order", () => {
    const history = createLiquidityHistory({ maxColumns: 2 });
    expect(history.latest()).toBeNull();
    expect(history.push(column(1, 0, [1], [0]))).toBe(1);
    expect(history.push(column(2, 0, [1], [0]))).toBe(2);
    expect(history.push(column(3, 0, [1], [0]))).toBe(3);
    expect(history.length).toBe(2);
    expect(history.seq).toBe(3);
    expect(history.latest().ts).toBe(3);
    expect(() => history.push(column(3, 0, [1], [0]))).toThrow(/time order/);
  });

  test("push hands the column it lets go of to onEvict, oldest first, before the caller's next push", () => {
    const gone = [];
    const history = createLiquidityHistory({ maxColumns: 2, onEvict: (c) => gone.push(c.ts) });
    history.push(column(1, 0, [1], [0]));
    history.push(column(2, 0, [1], [0]));
    expect(gone).toEqual([]);
    history.push(column(3, 0, [1], [0]));
    history.push(column(4, 0, [1], [0]));
    expect(gone).toEqual([1, 2]);
    expect(history.toArray().map((c) => c.ts)).toEqual([3, 4]);
    // clear() forgets without evicting: nothing was let go of, the caller threw it away.
    history.clear();
    expect(gone).toEqual([1, 2]);
  });

  test("snapshotChunks replays the retained history as full-then-delta chunks that chain by seq", () => {
    const history = createLiquidityHistory({ maxColumns: 3 });
    history.push(column(1, 0, [1, 0], [0, 0]));
    history.push(column(2, 0, [1, 2], [0, 0]));
    history.push(column(3, 0, [0, 2], [3, 0]));
    history.push(column(4, 0, [0, 2], [3, 1])); // evicts ts 1
    const chunks = history.snapshotChunks(2);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].seq).toBe(3);
    expect(chunks[0].columns).toEqual([
      { ts: 2, lo: 0, hi: 1, bid: [[0, 1], [1, 2]], ask: [] },
      { ts: 3, lo: 0, hi: 1, bid: [[0, 0]], ask: [[0, 3]] },
    ]);
    expect(chunks[1].seq).toBe(4);
    expect(chunks[1].columns).toEqual([{ ts: 4, lo: 0, hi: 1, bid: [], ask: [[1, 1]] }]);
  });

  test("an empty history still yields one (empty) chunk so the client can reset", () => {
    const history = createLiquidityHistory({ maxColumns: 3 });
    expect(history.snapshotChunks(10)).toEqual([{ columns: [], seq: 0 }]);
    history.push(column(1, 0, [1], [0]));
    history.clear();
    expect(history.length).toBe(0);
    expect(history.seq).toBe(0);
  });

  test("rejects malformed columns", () => {
    const history = createLiquidityHistory();
    expect(() => history.push({ ts: 1, lo: 2, hi: 1, bid: new Float64Array(0), ask: new Float64Array(0) })).toThrow(/lo <= hi/);
    expect(() => history.push({ ts: 1, lo: 0, hi: 1, bid: new Float64Array(1), ask: new Float64Array(2) })).toThrow(/Float64Arrays/);
    expect(() => createLiquidityHistory({ maxColumns: 0 })).toThrow(/maxColumns/);
  });

  test("coarsenColumn sums every fine row into the coarse row it falls in, both sides and the flow, on the coarse row index, and leaves the prints behind", () => {
    // Rows 11..15 on rows of two: coarse rows 5 (11), 6 (12, 13) and 7 (14, 15); the flow's offsets are fine rows off 11.
    const fine = { ...column(1, 11, [1, 2, 3, 4, 5], [0, 0, 0, 0, 7]), buy: [[1, 2], [3, 4]], sell: [[4, 1]], prints: [{ ts: 1, price: 5, size: 1, side: "buy", id: "p" }], printsFloor: 1 };
    const coarse = coarsenColumn(fine, 2);
    expect([coarse.ts, coarse.lo, coarse.hi]).toEqual([1, 5, 7]);
    expect([...coarse.bid]).toEqual([1, 5, 9]);
    expect([...coarse.ask]).toEqual([0, 0, 7]);
    expect(coarse.buy).toEqual([[1, 2], [2, 4]]);
    expect(coarse.sell).toEqual([[2, 1]]);
    expect(coarse.prints).toBeUndefined();
    expect(coarsenColumn(column(1, 10, [1, 2], [0, 0]), 1)).toMatchObject({ lo: 10, hi: 11 });
    expect(() => coarsenColumn(fine, 0)).toThrow(/rows/);
  });

  test("the deep folder returns a window's column when the next window opens: the largest size each row held, on the first column's rows", () => {
    const folder = createDeepFolder({ deepColumnMs: 10_000 });
    const column = (ts, lo, bid) => ({ ts, lo, hi: lo + bid.length - 1, bid: Float64Array.from(bid), ask: new Float64Array(bid.length) });
    expect(folder.feed(column(1_000, 10, [1, 5, 0]))).toBeNull();
    expect(folder.feed(column(2_000, 10, [3, 2, 0]))).toBeNull();
    expect(folder.feed(column(3_000, 11, [9, 4, 7]))).toBeNull();
    const finished = folder.feed(column(10_000, 10, [8, 8, 8]));
    expect(finished).toMatchObject({ ts: 0, lo: 10, hi: 12 });
    expect(Array.from(finished.bid)).toEqual([3, 9, 4]);
    expect(Object.isFrozen(finished)).toBe(true);
    expect(folder.feed(column(20_000, 10, [0, 0, 0]))).toMatchObject({ ts: 10_000 });
    expect(() => createDeepFolder({ deepColumnMs: 0 })).toThrow(/deepColumnMs/);
  });
  test("a column's flow (traded volume per row, the big prints, their floor) rides the wire form and comes back on decode", () => {
    const flowed = { ...column(2, 10, [1, 2, 0], [0, 0, 5]), buy: [[1, 3.5]], sell: [[0, 1]], prints: [{ ts: 1_900, price: 11, size: 3.5, side: "buy", id: "t1" }], printsFloor: 2 };
    const wire = encodeColumn(column(1, 10, [1, 0, 0], [0, 0, 5]), flowed);
    expect(wire.buy).toEqual([[1, 3.5]]);
    expect(wire.sell).toEqual([[0, 1]]);
    expect(wire.prints).toEqual([{ ts: 1_900, price: 11, size: 3.5, side: "buy", id: "t1" }]);
    expect(wire.printsFloor).toBe(2);
    const back = decodeColumn(null, wire);
    expect(back.buy).toEqual([[1, 3.5]]);
    expect(back.prints).toHaveLength(1);
    expect(back.printsFloor).toBe(2);
    const plain = encodeColumn(null, column(3, 10, [1], [0]));
    expect("buy" in plain).toBe(false);
    expect("prints" in decodeColumn(null, plain)).toBe(false);
  });

  test("the deep folder sums traded volume per row, keeps the largest prints of the window at the highest floor seen, and drops rows outside its own window", () => {
    const folder = createDeepFolder({ deepColumnMs: 10_000, maxPrints: 2 });
    const c = (ts, lo, bid, flow) => ({ ...column(ts, lo, bid, bid.map(() => 0)), ...flow });
    expect(folder.feed(c(1_000, 10, [1, 1, 1], { buy: [[0, 2]], sell: [], prints: [{ ts: 900, price: 10, size: 2, side: "buy", id: "a" }], printsFloor: 1 }))).toBeNull();
    expect(folder.feed(c(2_000, 11, [1, 1, 1], { buy: [[0, 3], [2, 9]], sell: [[1, 4]], prints: [{ ts: 1_900, price: 11, size: 3, side: "buy", id: "b" }, { ts: 1_950, price: 12, size: 4, side: "sell", id: "c" }], printsFloor: 3 }))).toBeNull();
    const finished = folder.feed(c(10_000, 10, [0, 0, 0], {}));
    expect(finished).toMatchObject({ ts: 0, lo: 10, hi: 12, buy: [[0, 2], [1, 3]], sell: [[2, 4]], printsFloor: 3 });
    expect(finished.prints.map((p) => p.id)).toEqual(["b", "c"]);
    const last = folder.flush();
    expect(last).toMatchObject({ ts: 10_000 });
    expect("buy" in last).toBe(false);
    expect(folder.flush()).toBeNull();
    expect(() => createDeepFolder({ deepColumnMs: 10_000, maxPrints: 0 })).toThrow(/maxPrints/);
  });

  test("the deep folder does not claim complete print coverage when an equal-size group exceeds its cap", () => {
    const folder = createDeepFolder({ deepColumnMs: 10_000, maxPrints: 2 });
    for (let i = 1; i <= 3; i += 1) {
      const input = { ...column(i * 1_000, 10, [1], [0]), buy: [[0, 5]], prints: [{ ts: i * 1_000, price: 10, size: 5, side: "buy", id: String(i) }], printsFloor: 0 };
      expect(folder.feed(input)).toBeNull();
    }
    const result = folder.flush();
    expect(result.buy).toEqual([[0, 15]]);
    expect(result.prints).toEqual([]);
    expect(result.printsFloor).toBeGreaterThan(5);
  });

  test("a second snapshot reuses the first one's wire for every column, and the new oldest column is sent in full once the one before it is gone", () => {
    // Gate E GE-13: every store save and every new client re-encoded the whole
    // ring, which froze a live runtime for 0.5-2 s a minute.
    const history = createLiquidityHistory({ maxColumns: 3 });
    history.push(column(1_000, 0, [1, 0, 1], [0, 1, 0]));
    history.push(column(2_000, 0, [2, 0, 1], [0, 2, 0]));
    history.push(column(3_000, 0, [3, 0, 1], [0, 3, 0]));
    const [first] = history.snapshotChunks(Number.MAX_SAFE_INTEGER);
    const [again] = history.snapshotChunks(Number.MAX_SAFE_INTEGER);
    again.columns.forEach((wire, i) => expect(wire).toBe(first.columns[i]));

    history.push(column(4_000, 0, [4, 0, 1], [0, 4, 0]));
    const [after] = history.snapshotChunks(Number.MAX_SAFE_INTEGER);
    expect(after.columns.map((wire) => wire.ts)).toEqual([2_000, 3_000, 4_000]);
    expect(after.columns[0]).toEqual({ ts: 2_000, lo: 0, hi: 2, bid: [[0, 2], [2, 1]], ask: [[1, 2]] });
    expect(after.columns[1]).toBe(first.columns[2]);
    let prev = null;
    const decoded = [];
    for (const wire of after.columns) {
      prev = decodeColumn(prev, wire);
      decoded.push([...prev.bid, ...prev.ask]);
    }
    expect(decoded).toEqual([[2, 0, 1, 0, 2, 0], [3, 0, 1, 0, 3, 0], [4, 0, 1, 0, 4, 0]]);
  });
});

describe("liquidity-history merge (the live chain survives a rebuild)", () => {
  test("merge inserts columns by time, skips the ones already held, evicts past the cap and leaves seq where the live chain is", () => {
    const gone = [];
    const history = createLiquidityHistory({ maxColumns: 4, onEvict: (c) => gone.push(c.ts) });
    history.push(column(10, 0, [1], [0]));
    history.push(column(20, 0, [1], [0]));
    expect(history.seq).toBe(2);
    expect(history.merge([column(5, 0, [2], [0]), column(10, 0, [9], [0]), column(15, 0, [3], [0]), column(1, 0, [4], [0])])).toBe(3);
    expect(history.toArray().map((c) => [c.ts, c.bid[0]])).toEqual([[5, 2], [10, 1], [15, 3], [20, 1]]);
    expect(gone).toEqual([1]);
    expect(history.seq).toBe(2);
    expect(history.sideBufferBytes).toBe(4 * 16);
    expect(history.push(column(30, 0, [1], [0]))).toBe(3);
    expect(history.merge([])).toBe(0);
    expect(history.merge([column(15, 0, [3], [0])])).toBe(0);
    expect(() => history.merge([{ ts: 7 }])).toThrow(/column/);
  });

  test("counts the merges that added columns, so a store can tell a rebuilt tier from one that only kept its seq; clear starts the count over (PR #47 review)", () => {
    const history = createLiquidityHistory({ maxColumns: 10 });
    history.push(column(10, 0, [1], [0]));
    expect(history.merges).toBe(0);
    history.merge([column(5, 0, [1], [0])]);
    expect(history.merges).toBe(1);
    history.merge([]);
    history.merge([column(5, 0, [1], [0])]);
    expect(history.merges).toBe(1);
    history.merge([column(3, 0, [1], [0]), column(4, 0, [1], [0])]);
    expect(history.merges).toBe(2);
    expect(history.seq).toBe(1);
    history.clear();
    expect(history.merges).toBe(0);
  });

  test("rebase lifts seq to the retained count so a snapshot after a merge chains from its own first chunk", () => {
    const history = createLiquidityHistory({ maxColumns: 10 });
    history.push(column(10, 0, [1], [0]));
    history.merge([column(1, 0, [1], [0]), column(2, 0, [1], [0])]);
    expect(history.seq).toBe(1);
    expect(history.rebase()).toBe(3);
    expect(history.seq).toBe(3);
    expect(history.snapshotChunks(2).map((chunk) => chunk.seq)).toEqual([2, 3]);
    expect(history.rebase()).toBe(3);
  });
});
