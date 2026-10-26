const { createAggressivePool, warmAggressivePool, DEFAULT_WINDOW_MS, DEFAULT_MAX_PRINTS } = require("../../src/server/aggressive-pool");
const { MAX_AGGRESSIVE_POOL_PRINTS, snapshotFrame } = require("../../src/server/frames");

const T = 1_700_000_000_000;

function trade(id, ts, size, side = "buy") {
  return { type: "trade", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", trade_id: String(id), ts_exchange: ts, price: 80_000, size, side };
}

describe("aggressive-pool", () => {
  test("defaults and argument checks", () => {
    expect(DEFAULT_WINDOW_MS).toBe(4 * 3_600_000);
    expect(DEFAULT_MAX_PRINTS).toBe(20_000);
    expect(() => createAggressivePool({ windowMs: 0 })).toThrow(/windowMs/);
    expect(() => createAggressivePool({ maxPrints: 0 })).toThrow(/maxPrints/);
    expect(() => createAggressivePool({ floorShare: 1 })).toThrow(/floorShare/);
  });

  test("keeps every live print until the gate is calibrated, then only the biggest share, deduped by id, in time order", () => {
    let at = T;
    const pool = createAggressivePool({ floorWindow: 100, floorMinSamples: 50, floorShare: 0.1, now: () => at });
    for (let i = 1; i <= 49; i += 1) expect(pool.record(trade(i, T + i, i))).toBe(true);
    expect(pool.gate()).toBe(0);
    expect(pool.record(trade(50, T + 50, 50))).toBe(true);
    expect(pool.gate()).toBe(45);
    expect(pool.record(trade(51, T + 51, 3))).toBe(false);
    expect(pool.record(trade(52, T + 52, 45))).toBe(true);
    expect(pool.record(trade(52, T + 53, 99))).toBe(false);
    expect(pool.record(trade(53, T + 40, 60))).toBe(true);
    const snap = pool.snapshot();
    const order = snap.prints.map((p) => p.trade_id);
    expect(order.slice(-3)).toEqual(["49", "50", "52"]);
    expect(order.indexOf("53")).toBe(order.indexOf("40") + 1);
    expect(snap.floor).toBe(pool.gate());
    expect(snap.floor).toBeGreaterThanOrEqual(45);
    expect(pool.size).toBe(52);
  });

  test("forgets prints older than the window and reports where its coverage starts", () => {
    let at = T;
    const pool = createAggressivePool({ windowMs: 10_000, now: () => at });
    pool.record(trade(1, T - 20_000, 5));
    pool.record(trade(2, T - 5_000, 5));
    at = T + 1_000;
    const snap = pool.snapshot();
    expect(snap.prints.map((p) => p.trade_id)).toEqual(["2"]);
    expect(snap.from).toBe(T - 9_000);
  });

  test("over the count cap retention and snapshot stay bounded with a truthful floor", () => {
    const pool = createAggressivePool({ maxPrints: 3, floorMinSamples: 1_000, now: () => T });
    for (const [id, size] of [[1, 9], [2, 1], [3, 7], [4, 2], [5, 8]]) pool.record(trade(id, T + id, size));
    expect(pool.size).toBe(3);
    expect(pool.floor).toBe(7);
    const snap = pool.snapshot();
    expect(snap.prints.map((p) => [p.trade_id, p.size])).toEqual([["1", 9], ["3", 7], ["5", 8]]);
    expect(snap.floor).toBe(7);
    expect(snap.prints.some((p) => p.size < snap.floor)).toBe(false);
    expect(pool.record(trade(6, T + 6, 1))).toBe(false);
    expect(pool.size).toBeLessThanOrEqual(3);
    expect(pool.floor).toBe(7);
  });

  test("the pool's cap is the frame's, and a full pool with a tie at the cut still ships in a snapshot", () => {
    // The bound lives in two files; the snapshot frame refuses a pool over it, so a pool that ever held more turned every
    // connecting client away (2026-09-19). The cut used to sit one place low and keep every tie at the boundary.
    expect(DEFAULT_MAX_PRINTS).toBe(MAX_AGGRESSIVE_POOL_PRINTS);
    const pool = createAggressivePool({ floorMinSamples: 1_000_000, now: () => T });
    // Half the prints at one size, then half at the next, three over the cap: the old cut kept every tie and shipped
    // 20,003; now the cut moves to the sixes, the floor says so, and the frame takes it.
    for (let id = 1; id <= DEFAULT_MAX_PRINTS + 3; id += 1) pool.record(trade(id, T + id, id <= DEFAULT_MAX_PRINTS / 2 ? 5 : 6));
    const snap = pool.snapshot();
    expect(snap.floor).toBe(6);
    expect(snap.prints.length).toBeLessThanOrEqual(DEFAULT_MAX_PRINTS);
    expect(snap.prints.every((p) => p.size >= snap.floor)).toBe(true);
    const frame = snapshotFrame([], [], "BTCUSDT", "PERPETUAL", [], undefined, undefined, snap);
    expect(frame.aggressive_prints).toHaveLength(snap.prints.length);
  });

  test("a tie too large to fit is omitted rather than claiming complete coverage of a partial size group", () => {
    const pool = createAggressivePool({ maxPrints: 3, floorMinSamples: 1_000, now: () => T });
    for (const [id, size] of [[1, 10], [2, 10], [3, 10], [4, 10], [5, 10]]) pool.record(trade(id, T + id, size));
    expect(pool.size).toBe(0);
    let snap = pool.snapshot();
    expect(snap.prints).toEqual([]);
    expect(snap.floor).toBeGreaterThan(10);
    expect(pool.record(trade(8, T + 8, 10))).toBe(false);

    expect(pool.record(trade(6, T + 6, 12))).toBe(true);
    expect(pool.record(trade(7, T + 7, 11))).toBe(true);
    expect(pool.size).toBeLessThanOrEqual(3);
    snap = pool.snapshot();
    expect(snap.prints.map((p) => [p.trade_id, p.size])).toEqual([["6", 12], ["7", 11]]);
    expect(snap.floor).toBeGreaterThan(10);
  });

  test("a full pool never produces a snapshot the snapshot frame refuses, and its floor never claims a dropped size", () => {
    const { snapshotFrame } = require("../../src/server/frames");
    const pool = createAggressivePool({ floorMinSamples: 1_000_000, now: () => T + 100_000 });
    const trades = [];
    for (let i = 0; i < DEFAULT_MAX_PRINTS + 1_500; i += 1) trades.push(trade(i, T + i, 0.01 + (i % 400) * 0.001));
    pool.seed(trades, { fromMs: T });
    expect(pool.size).toBeLessThanOrEqual(DEFAULT_MAX_PRINTS);
    const snap = pool.snapshot();
    expect(snap.prints.length).toBeLessThanOrEqual(DEFAULT_MAX_PRINTS);
    expect(snap.prints.every((p) => p.size >= snap.floor)).toBe(true);
    const keptIds = new Set(snap.prints.map((p) => p.trade_id));
    const droppedSizes = new Set(trades.filter((t) => !keptIds.has(t.trade_id)).map((t) => t.size));
    expect(droppedSizes.size).toBeGreaterThan(0);
    for (const size of droppedSizes) expect(size).toBeLessThan(snap.floor);
    expect(() => snapshotFrame([], [], "BTCUSDT", "PERPETUAL", [], undefined, undefined, snap)).not.toThrow();
  });

  test("seeding calibrates from the first chunk and drops what falls under the gate it finds", () => {
    const pool = createAggressivePool({ floorWindow: 100, floorMinSamples: 50, floorShare: 0.1, now: () => T + 100_000 });
    const first = Array.from({ length: 60 }, (_unused, i) => trade(100 + i, T + 50_000 + i, i + 1));
    expect(pool.seed(first, { fromMs: T + 50_000, calibrate: true })).toBe(60);
    expect(pool.gate()).toBe(54);
    expect(pool.snapshot().prints.map((p) => p.size)).toEqual([54, 55, 56, 57, 58, 59, 60]);
    expect(pool.seed([trade(1, T + 10_000, 70), trade(2, T + 20_000, 5)], { fromMs: T + 10_000 })).toBe(1);
    const snap = pool.snapshot();
    expect(snap.prints[0].trade_id).toBe("1");
    expect(snap.from).toBe(T + 10_000);
    expect(snap.floor).toBe(54);
  });
});

describe("aggressive-pool seed ordering", () => {
  test("ascending and descending source order yield identical pool content, floor and coverage", () => {
    const forward = createAggressivePool({ floorWindow: 100, floorMinSamples: 1_000, now: () => T });
    const backward = createAggressivePool({ floorWindow: 100, floorMinSamples: 1_000, now: () => T });
    const ascending = Array.from({ length: 500 }, (_unused, i) => trade(i, T - 500_000 + i * 1_000, (i % 7) + 1));
    const descending = [...ascending].reverse();
    forward.seed(ascending, { fromMs: T - 500_000 });
    backward.seed(descending, { fromMs: T - 500_000 });
    const forwardSnap = forward.snapshot();
    const backwardSnap = backward.snapshot();
    expect(backwardSnap.prints.map((p) => p.trade_id)).toEqual(forwardSnap.prints.map((p) => p.trade_id));
    expect(backwardSnap.floor).toBe(forwardSnap.floor);
    expect(backwardSnap.from).toBe(forwardSnap.from);
    for (let i = 1; i < backwardSnap.prints.length; i += 1) {
      expect(backwardSnap.prints[i].ts_exchange).toBeGreaterThan(backwardSnap.prints[i - 1].ts_exchange);
    }
  });

  test("seeding a large newest-first page is not quadratic: descending costs about the same as ascending, not many times more", () => {
    const rowCount = 20_000;
    const descending = Array.from({ length: rowCount }, (_unused, i) => trade(i, T - i * 10, 5));
    const ascending = [...descending].reverse();
    const timeSeed = (rows) => {
      const pool = createAggressivePool({ floorWindow: 100, floorMinSamples: 1_000_000, now: () => T });
      const startedAt = process.hrtime.bigint();
      pool.seed(rows, { fromMs: T - rowCount * 10 });
      expect(pool.size).toBe(rowCount);
      return Number(process.hrtime.bigint() - startedAt) / 1e6;
    };
    // Warm up the JIT, then take the best of three for each order -- a
    // per-row splice-near-front pattern measured about 12x slower on
    // descending than ascending input on the repository's pinned Node
    // runtime; a bulk merge measured about 1x either way. This is a
    // regression guard against reintroducing the O(n^2) pattern (relative
    // comparison), not an absolute production throughput claim.
    timeSeed(descending);
    timeSeed(ascending);
    const descendingMs = Math.min(timeSeed(descending), timeSeed(descending), timeSeed(descending));
    const ascendingMs = Math.min(timeSeed(ascending), timeSeed(ascending), timeSeed(ascending));
    expect(descendingMs).toBeLessThan(ascendingMs * 4 + 5);
  });
});

describe("warmAggressivePool", () => {
  test("reads the newest stretch at no floor, then hourly chunks at the gate it found, back to the window start, reporting progress", async () => {
    const pool = createAggressivePool({ floorWindow: 100, floorMinSamples: 50, floorShare: 0.1, now: () => T });
    const reads = [];
    const read = async (fromMs, toMs, minSize) => {
      reads.push([fromMs - T, toMs - T, minSize]);
      if (minSize === 0) return { frames: Array.from({ length: 60 }, (_unused, i) => trade(`c${i}`, toMs - 1_000 - i, i + 1)) };
      return { frames: [trade(`big${fromMs}`, fromMs + 1, 99), trade(`small${fromMs}`, fromMs + 2, 1)] };
    };
    const progress = [];
    const result = await warmAggressivePool({ pool, read, nowMs: T, windowMs: 3 * 3_600_000, calibrationMs: 15 * 60_000, chunkMs: 3_600_000, onProgress: (p) => progress.push(p) });
    expect(reads).toEqual([
      [-900_000, 0, 0],
      [-4_500_000, -900_000, 54],
      [-8_100_000, -4_500_000, 54],
      [-10_800_000, -8_100_000, 54],
    ]);
    expect(result).toEqual({ chunks: 4, prints: 60 + 3, complete: true });
    expect(progress.map((p) => [p.chunks, p.complete])).toEqual([[1, false], [4, true]]);
    const snap = pool.snapshot();
    expect(snap.from).toBe(T - 10_800_000);
    expect(snap.prints.filter((p) => p.size === 1)).toHaveLength(0);
    expect(snap.prints.filter((p) => p.size === 99)).toHaveLength(3);
  });

  test("stops when storage cannot answer or the caller withdraws, and says it is incomplete", async () => {
    const pool = createAggressivePool({ now: () => T });
    const result = await warmAggressivePool({ pool, read: async () => ({ frames: [], available: false }), nowMs: T });
    expect(result).toEqual({ chunks: 0, prints: 0, complete: false });
    let calls = 0;
    const withdrawn = await warmAggressivePool({ pool, read: async () => ({ frames: [] }), nowMs: T, shouldContinue: () => (calls += 1) < 2 });
    expect(withdrawn).toEqual({ chunks: 1, prints: 0, complete: false });
    await expect(warmAggressivePool({ pool: null, read: async () => ({ frames: [] }), nowMs: T })).rejects.toThrow(/pool/);
  });

  test("a slice with more qualifying rows than one bounded read can hold is paged until exhausted, not silently truncated", async () => {
    // A reader capped at 2 rows per call, backed by 5 real rows in the one
    // calibration slice -- the exact shape of the audited bug (a bounded
    // storage read whose remainder was never fetched, yet the warm-up still
    // declared the window complete).
    const pool = createAggressivePool({ floorWindow: 100, floorMinSamples: 1_000, floorShare: 0.1, now: () => T });
    const source = [trade("r1", T - 1, 5), trade("r2", T - 2, 5), trade("r3", T - 3, 5), trade("r4", T - 4, 5), trade("r5", T - 5, 5)];
    const reads = [];
    const read = async (fromMs, toMs, minSize, cursor) => {
      reads.push(cursor);
      const startIndex = cursor === null ? 0 : source.findIndex((t) => t.trade_id === cursor.id) + 1;
      const page = source.slice(startIndex, startIndex + 2);
      const hasMore = startIndex + 2 < source.length;
      const last = page.at(-1);
      return { frames: page, hasMore, nextCursor: hasMore && last ? { ts: last.ts_exchange, id: last.trade_id } : null };
    };
    const result = await warmAggressivePool({ pool, read, nowMs: T, windowMs: 3_600_000, calibrationMs: 3_600_000, chunkMs: 3_600_000 });
    expect(reads).toEqual([null, { ts: T - 2, id: "r2" }, { ts: T - 4, id: "r4" }]);
    expect(result).toEqual({ chunks: 1, prints: 5, complete: true });
    expect(pool.snapshot().prints.map((p) => p.trade_id).sort()).toEqual(["r1", "r2", "r3", "r4", "r5"]);
  });

  test("a slice that never stops paging is abandoned as incomplete instead of looping forever", async () => {
    const pool = createAggressivePool({ now: () => T });
    let pages = 0;
    const read = async () => {
      pages += 1;
      return { frames: [], hasMore: true, nextCursor: { ts: T - pages, id: `p${pages}` } };
    };
    const result = await warmAggressivePool({ pool, read, nowMs: T, windowMs: 3_600_000, calibrationMs: 3_600_000, maxPagesPerSlice: 3 });
    expect(result).toEqual({ chunks: 0, prints: 0, complete: false });
    expect(pages).toBe(3);
  });
});
