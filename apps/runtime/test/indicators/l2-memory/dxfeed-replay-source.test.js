const os = require("node:os");
const path = require("node:path");
const { safeRm } = require("../../helpers/temp-files");
const { createDxFeedStorageDb, ORDER_BOOK_ARRIVAL_INDEX } = require("../../../src/storage/dxfeed/dxfeed-storage-db");
const { createDxFeedReplaySource, arrivalScanHint, SNAPSHOT_BEGIN_BIT } = require("../../../src/indicators/l2-memory/dxfeed-replay-source");
const { runBackfillInProcess } = require("../../../src/indicators/l2-memory/liquidity-backfill");

const SNAPSHOT_END_BIT = 0x08;
const T = 1_700_000_000_000;
const SYMBOL = "/NQZ26:XCME";

function tempDbPath() {
  return path.join(os.tmpdir(), `terminal-l1-l2-dxfeed-replay-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function order(storage, { ts, receivedAt = ts, index, flags = 0, action = "NEW", price, size, side, assetClass = "FUTURE", source = "GLBX" }) {
  storage.insert("dxfeed_order_book_capture", {
    eventTime: ts, receivedAt, provider: "DXFEED", venue: "XCME", assetClass, symbol: SYMBOL, stale: 0, recoveryState: "READY",
    orderIndex: String(index), eventFlags: flags, time: ts, action, actionTime: ts, orderId: Number(index), price, size, side, scope: "ORDER", source, marketMaker: null,
  });
}

function print(storage, { ts, receivedAt = ts, price, size, aggressor, assetClass = "FUTURE" }) {
  storage.insert("dxfeed_time_and_sales", {
    eventTime: ts, receivedAt, provider: "DXFEED", venue: "XCME", assetClass, symbol: SYMBOL, stale: 0, recoveryState: "READY", price, size,
    time: ts, timeNanoPart: 0, sequence: 1, exchangeCode: "G", extendedTradingHours: 0, aggressorSide: aggressor, spreadLeg: 0, validTick: 1, eventKind: "NEW",
    providerIndex: null, providerTradeId: null, bidPrice: null, askPrice: null,
  });
}

// Rows are stored in arrival order, as the collector writes them: a test that
// adds orders between the early rows and the later snapshot inserts them
// between seedHead and seedTail, never after the later snapshot.

/** A book snapshotted 10 s before T (bid 100 x 5, ask 101 x 3), one ask added at T + 1 s, a buy print at T + 1.5 s. */
function seedHead(storage) {
  order(storage, { ts: T - 10_000, index: 1, flags: SNAPSHOT_BEGIN_BIT, price: 100, size: 5, side: "BUY" });
  order(storage, { ts: T - 10_000, index: 2, flags: SNAPSHOT_END_BIT, price: 101, size: 3, side: "SELL" });
  order(storage, { ts: T + 1_000, index: 3, price: 101.25, size: 2, side: "SELL" });
  print(storage, { ts: T + 1_500, price: 101, size: 1, aggressor: "BUY" });
}

/** A fresh snapshot at T + 5 s. */
function seedTail(storage) {
  order(storage, { ts: T + 5_000, index: 4, flags: SNAPSHOT_BEGIN_BIT, price: 100, size: 4, side: "BUY" });
  order(storage, { ts: T + 5_000, index: 5, flags: SNAPSHOT_END_BIT, price: 101, size: 2, side: "SELL" });
}

function seed(storage) {
  seedHead(storage);
  seedTail(storage);
}

describe("dxfeed-replay-source", () => {
  let dbPath;
  let storage;
  beforeEach(() => {
    dbPath = tempDbPath();
    storage = createDxFeedStorageDb({ dbPath });
  });
  afterEach(() => {
    storage.close();
    safeRm(dbPath);
  });

  test("validates its options", () => {
    expect(() => createDxFeedReplaySource({ db: storage.raw, symbol: "", assetClass: "FUTURE", fromTs: T, toTs: T })).toThrow(/symbol/);
    expect(() => createDxFeedReplaySource({ db: storage.raw, symbol: SYMBOL, assetClass: "SPOT", fromTs: T, toTs: T })).toThrow(/assetClass/);
    expect(() => createDxFeedReplaySource({ db: storage.raw, symbol: SYMBOL, assetClass: "FUTURE", fromTs: T + 1, toTs: T })).toThrow(/toTs/);
    expect(() => createDxFeedReplaySource({ db: storage.raw, symbol: "/UNKNOWN:XCME", assetClass: "FUTURE", fromTs: T, toTs: T })).toThrow(/source/);
    expect(() => createDxFeedReplaySource({ symbol: SYMBOL, assetClass: "FUTURE", fromTs: T, toTs: T })).toThrow(/exactly one/);
  });

  test("resolves the governed order source by futures root for a retired historical contract", () => {
    expect(() => createDxFeedReplaySource({
      db: storage.raw, symbol: "/NQU26:XCME", assetClass: "FUTURE", fromTs: T, toTs: T,
    })).not.toThrow();
  });

  test("rebuilds the book from the snapshot before the window and yields books, the aggressor tape and anchors in order", () => {
    seed(storage);
    const source = createDxFeedReplaySource({ db: storage.raw, symbol: SYMBOL, assetClass: "FUTURE", fromTs: T, toTs: T + 10_000, coalesceMs: 0 });
    const frames = [...source.frames()];
    expect(frames.map((f) => [f.kind, f.ts])).toEqual([
      ["book", T + 1_000], // the first book inside the window: the snapshot plus the new ask
      ["trade", T + 1_500],
      ["anchor", T + 5_000],
      ["book", T + 5_000],
    ]);
    expect(frames[0].book).toMatchObject({ bids: [[100, 5]], asks: [[101, 3], [101.25, 2]] });
    // The first book after a snapshot carries the whole book as its delta.
    expect(frames[0].delta).toEqual({ bids: [[100, 5]], asks: [[101, 3], [101.25, 2]] });
    expect(frames[1]).toMatchObject({ kind: "trade", price: 101, size: 1, side: "buy" });
    expect(frames[3].book).toMatchObject({ bids: [[100, 4]], asks: [[101, 2]] });
    expect(frames[3].delta).toEqual({ bids: [[100, 4]], asks: [[101, 2]] });
    expect(source.stats).toMatchObject({ orderRows: 5, tapeRows: 1, booksEmitted: 2, anchors: 1, unavailable: 0 });
    source.close();
    expect(() => storage.raw.prepare("select 1").get()).not.toThrow(); // a borrowed connection is not closed
  });

  test("with no snapshot before the window it starts at the first one inside it, and yields nothing when there is none", () => {
    seed(storage);
    const inside = createDxFeedReplaySource({ db: storage.raw, symbol: SYMBOL, assetClass: "FUTURE", fromTs: T - 20_000, toTs: T - 9_000, coalesceMs: 0 });
    expect([...inside.frames()].map((f) => [f.kind, f.ts])).toEqual([["book", T - 10_000]]);
    const none = createDxFeedReplaySource({ db: storage.raw, symbol: SYMBOL, assetClass: "FUTURE", fromTs: T - 60_000, toTs: T - 30_000 });
    expect([...none.frames()]).toEqual([]);
    const other = createDxFeedReplaySource({ db: storage.raw, symbol: "/ESZ26:XCME", assetClass: "FUTURE", fromTs: T, toTs: T + 10_000 });
    expect([...other.frames()]).toEqual([]);
  });

  test("reads the pair through the arrival index when the capture has it, with the same frames as the table scan it replaces", () => {
    seedHead(storage);
    for (let i = 0; i < 50; i += 1) {
      storage.insert("dxfeed_order_book_capture", {
        eventTime: T + 2_000 + i, receivedAt: T + 2_000 + i, provider: "DXFEED", venue: "XCME", assetClass: "FUTURE", symbol: "/ESZ26:XCME", stale: 0, recoveryState: "READY",
        orderIndex: String(100 + i), eventFlags: i === 0 ? SNAPSHOT_BEGIN_BIT : 0, time: T + 2_000 + i, action: "NEW", actionTime: T + 2_000 + i, orderId: 100 + i,
        price: 5_000 + i, size: 1, side: "BUY", scope: "ORDER", source: "GLBX", marketMaker: null,
      });
    }
    seedTail(storage);
    const replay = () => {
      const source = createDxFeedReplaySource({ db: storage.raw, symbol: SYMBOL, assetClass: "FUTURE", fromTs: T, toTs: T + 10_000, coalesceMs: 0 });
      const frames = [...source.frames()];
      return { frames, stats: { ...source.stats } };
    };

    expect(arrivalScanHint(storage.raw)).toBe(`INDEXED BY ${ORDER_BOOK_ARRIVAL_INDEX}`);
    const plan = storage.raw.prepare(
      `EXPLAIN QUERY PLAN SELECT id FROM dxfeed_order_book_capture ${arrivalScanHint(storage.raw)} WHERE id >= ? AND id < ? AND symbol = ? AND asset_class = ? AND source = ? ORDER BY id`,
    ).all(1, 100, SYMBOL, "FUTURE", "GLBX").map((row) => row.detail).join(" ; ");
    expect(plan).toContain(`INDEX ${ORDER_BOOK_ARRIVAL_INDEX} (symbol=? AND asset_class=? AND source=? AND rowid>? AND rowid<?)`);
    expect(plan).not.toContain("TEMP B-TREE");
    const indexed = replay();

    storage.raw.exec(`DROP INDEX ${ORDER_BOOK_ARRIVAL_INDEX}`);
    expect(arrivalScanHint(storage.raw)).toBe("NOT INDEXED");
    const scanned = replay();

    expect(indexed.frames.map((f) => [f.kind, f.ts])).toEqual([["book", T + 1_000], ["trade", T + 1_500], ["anchor", T + 5_000], ["book", T + 5_000]]);
    expect(indexed).toEqual(scanned);
  });

  test("with the arrival index no statement it prepares scans the whole capture table, so opening a replay costs the same on a 250 M-row capture as on this one", () => {
    seed(storage);
    const prepared = [];
    const conn = new Proxy(storage.raw, {
      get(target, key) {
        if (key === "prepare") return (sql) => { prepared.push(sql); return target.prepare(sql); };
        const value = target[key];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const source = createDxFeedReplaySource({ db: conn, symbol: SYMBOL, assetClass: "FUTURE", fromTs: T, toTs: T + 10_000, coalesceMs: 0 });
    expect([...source.frames()].length).toBeGreaterThan(0);

    const captureReads = prepared.filter((sql) => /FROM dxfeed_order_book_capture\b/.test(sql) && !/sqlite_master/.test(sql));
    expect(captureReads.length).toBeGreaterThanOrEqual(4);
    for (const sql of captureReads) {
      const params = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => 0);
      const plan = storage.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => row.detail).join(" ; ");
      expect({ sql, plan }).toEqual({ sql, plan: expect.not.stringMatching(/\bSCAN dxfeed_order_book_capture\b/) });
    }
  });

  test("never mixes a same-symbol capture from another asset class into the replay", () => {
    seed(storage);
    order(storage, { ts: T - 5_000, index: 90, flags: SNAPSHOT_BEGIN_BIT, price: 999, size: 9, side: "BUY", assetClass: "EQUITY" });
    order(storage, { ts: T - 5_000, index: 91, flags: SNAPSHOT_END_BIT, price: 1_000, size: 9, side: "SELL", assetClass: "EQUITY" });
    print(storage, { ts: T + 1_250, price: 999, size: 999, aggressor: "BUY", assetClass: "EQUITY" });

    const source = createDxFeedReplaySource({ db: storage.raw, symbol: SYMBOL, assetClass: "FUTURE", fromTs: T, toTs: T + 2_000, coalesceMs: 0 });
    const frames = [...source.frames()];

    expect(frames).toEqual([
      expect.objectContaining({ kind: "book", ts: T + 1_000, book: expect.objectContaining({ bids: [[100, 5]], asks: [[101, 3], [101.25, 2]] }) }),
      expect.objectContaining({ kind: "trade", ts: T + 1_500, price: 101, size: 1, side: "buy" }),
    ]);
  });

  test("uses the configured order source, so a foreign-source snapshot cannot become the replayed book", () => {
    seed(storage);
    // This is newer than the GLBX anchor. Before source filtering, replay
    // selected it as the start snapshot and showed a different venue's book.
    order(storage, { ts: T - 5_000, index: 90, flags: SNAPSHOT_BEGIN_BIT, price: 999, size: 9, side: "BUY", source: "OTHER" });
    order(storage, { ts: T - 5_000, index: 91, flags: SNAPSHOT_END_BIT, price: 1_000, size: 9, side: "SELL", source: "OTHER" });

    const source = createDxFeedReplaySource({ db: storage.raw, symbol: SYMBOL, assetClass: "FUTURE", source: "GLBX", fromTs: T, toTs: T + 2_000, coalesceMs: 0 });
    const frames = [...source.frames()];

    expect(frames[0]).toMatchObject({ kind: "book", ts: T + 1_000, book: { bids: [[100, 5]], asks: [[101, 3], [101.25, 2]] } });
    expect(frames.some((frame) => frame.kind === "book" && frame.book.bids.some(([price]) => price === 999))).toBe(false);
  });

  test("coalesces books to one per coalesceMs of exchange time", () => {
    seedHead(storage);
    for (let i = 0; i < 5; i += 1) order(storage, { ts: T + 2_000 + i * 50, index: 10 + i, price: 102 + i * 0.25, size: 1, side: "SELL" });
    seedTail(storage);
    const source = createDxFeedReplaySource({ db: storage.raw, symbol: SYMBOL, assetClass: "FUTURE", fromTs: T, toTs: T + 3_000, coalesceMs: 250 });
    const books = [...source.frames()].filter((f) => f.kind === "book").map((f) => f.ts);
    expect(books).toEqual([T + 1_000, T + 2_000]); // the five orders 50 ms apart after T + 2 s fold into the one at T + 2 s
  });

  test("emits a replacement snapshot even when it lands inside the preceding coalesce interval", () => {
    order(storage, { ts: T - 10_000, index: 1, flags: SNAPSHOT_BEGIN_BIT, price: 100, size: 5, side: "BUY" });
    order(storage, { ts: T - 10_000, index: 2, flags: SNAPSHOT_END_BIT, price: 101, size: 3, side: "SELL" });
    order(storage, { ts: T + 1_000, index: 3, price: 101.25, size: 2, side: "SELL" });
    order(storage, { ts: T + 1_100, index: 90, flags: SNAPSHOT_BEGIN_BIT, price: 100, size: 7, side: "BUY" });
    order(storage, { ts: T + 1_100, index: 91, flags: SNAPSHOT_END_BIT, price: 101, size: 6, side: "SELL" });
    print(storage, { ts: T + 1_500, price: 101, size: 1, aggressor: "BUY" });
    seedTail(storage);

    const source = createDxFeedReplaySource({ db: storage.raw, symbol: SYMBOL, assetClass: "FUTURE", fromTs: T, toTs: T + 2_000, coalesceMs: 250 });
    const frames = [...source.frames()];

    expect(frames.map((frame) => [frame.kind, frame.ts])).toEqual([
      ["book", T + 1_000],
      ["anchor", T + 1_100],
      ["book", T + 1_100],
      ["trade", T + 1_500],
    ]);
    expect(frames[2]).toMatchObject({ kind: "book", book: { bids: [[100, 7]], asks: [[101, 6]] } });
  });

  test("replays orders in arrival order, because a removal carries the order's own time, not the time it happened", () => {
    order(storage, { ts: T - 1_000, index: 1, flags: SNAPSHOT_BEGIN_BIT, price: 100, size: 5, side: "BUY" });
    order(storage, { ts: T - 1_000, index: 2, flags: SNAPSHOT_END_BIT, price: 101, size: 3, side: "SELL" });
    order(storage, { ts: T + 1_000, index: 3, price: 101.5, size: 2, side: "SELL" });
    order(storage, { ts: T + 2_000, index: 3, action: "REPLACE", price: 101.25, size: 2, side: "SELL" });
    // dxFeed stamps the removal with the order's original time. Sorted by that
    // time it would land before the REPLACE, and the REPLACE would resurrect a
    // cancelled order at 101.25 for the rest of the replay.
    order(storage, { ts: T + 1_000, receivedAt: T + 3_000, index: 3, action: "DELETE", price: 101.25, size: 2, side: "SELL" });
    order(storage, { ts: T + 3_500, receivedAt: T + 3_500, index: 4, price: 99.75, size: 4, side: "BUY" });

    const source = createDxFeedReplaySource({ db: storage.raw, symbol: SYMBOL, assetClass: "FUTURE", fromTs: T, toTs: T + 5_000, coalesceMs: 0 });
    const books = [...source.frames()].filter((frame) => frame.kind === "book");

    expect(books.map((frame) => frame.ts)).toEqual([T + 1_000, T + 2_000, T + 2_000, T + 3_500]);
    expect(books.at(-1)).toMatchObject({ book: { bids: [[100, 5], [99.75, 4]], asks: [[101, 3]] } });
  });

  test("deltas are the levels the assembler saw change, and sparse mode ships the whole book only when the engine must seed or resync", () => {
    seedHead(storage);
    order(storage, { ts: T + 2_000, index: 6, price: 99.5, size: 7, side: "BUY" });
    order(storage, { ts: T + 3_000, index: 6, action: "DELETE", price: 99.5, size: null, side: "BUY" });
    seedTail(storage);
    order(storage, { ts: T + 6_000, index: 7, price: 101.5, size: 1, side: "SELL" });

    const full = [...createDxFeedReplaySource({ db: storage.raw, symbol: SYMBOL, assetClass: "FUTURE", fromTs: T, toTs: T + 7_000, coalesceMs: 0 }).frames()].filter((f) => f.kind === "book");
    const sparse = [...createDxFeedReplaySource({ db: storage.raw, symbol: SYMBOL, assetClass: "FUTURE", fromTs: T, toTs: T + 7_000, coalesceMs: 0, bookMode: "sparse" }).frames()].filter((f) => f.kind === "book");

    expect(sparse.map((f) => [f.ts, f.delta])).toEqual(full.map((f) => [f.ts, f.delta]));
    expect(full.map((f) => f.delta)).toEqual([
      { bids: [[100, 5]], asks: [[101, 3], [101.25, 2]] },
      { bids: [[99.5, 7]], asks: [] },
      { bids: [[99.5, 0]], asks: [] },
      { bids: [[100, 4]], asks: [[101, 2]] },
      { bids: [], asks: [[101.5, 1]] },
    ]);
    expect(sparse.map((f) => Array.isArray(f.book.bids))).toEqual([true, false, false, true, false]);
    expect(sparse[1].book).toEqual({ bestBid: 100, bestAsk: 101 });
    expect(full.every((f) => Array.isArray(f.book.bids))).toBe(true);
    expect(() => createDxFeedReplaySource({ db: storage.raw, symbol: SYMBOL, assetClass: "FUTURE", fromTs: T, toTs: T, bookMode: "thin" })).toThrow(/bookMode/);
  });

  test("an arrival-ordered clock never runs backwards, so the stale order time of a removal cannot rewind the replay", () => {
    order(storage, { ts: T - 1_000, index: 1, flags: SNAPSHOT_BEGIN_BIT, price: 100, size: 5, side: "BUY" });
    order(storage, { ts: T - 1_000, index: 2, flags: SNAPSHOT_END_BIT, price: 101, size: 3, side: "SELL" });
    order(storage, { ts: T + 2_000, index: 3, price: 101.5, size: 2, side: "SELL" });
    order(storage, { ts: T + 500, receivedAt: T + 2_100, index: 3, action: "DELETE", price: 101.5, size: 2, side: "SELL" });

    const source = createDxFeedReplaySource({ db: storage.raw, symbol: SYMBOL, assetClass: "FUTURE", fromTs: T, toTs: T + 5_000, coalesceMs: 0 });
    const frames = [...source.frames()];
    const stamps = frames.map((frame) => frame.ts);

    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
    expect(stamps.every((ts) => ts >= T + 2_000)).toBe(true);
    // The removal is shown the moment it arrives, not held back until a newer order time turns up.
    expect(frames.map((frame) => [frame.kind, frame.ts])).toEqual([["book", T + 2_000], ["book", T + 2_000]]);
    expect(frames[1].delta).toEqual({ bids: [], asks: [[101.5, 0]] });
  });

  test("the liquidity backfill replays a dxFeed instrument through it and samples columns from the full-depth book", async () => {
    seed(storage);
    const columns = [];
    const result = await runBackfillInProcess({
      db: storage.raw, symbol: SYMBOL, marketKind: "FUTURE", fromTs: T, toTs: T + 6_000, columnMs: 1_000,
      rowClusters: 1, windowRows: 20, tickSize: 0.25, clusterTicks: 1,
      aggressiveOptions: { floor: 1, gapBands: 0 },
      onColumn: (column) => columns.push(column),
    });
    expect(result.reason).toBeNull();
    expect(result.columns).toBe(columns.length);
    expect(columns.length).toBeGreaterThan(0);
    // The buy print at 101 on the ask is a buyer cluster on the 101 row (key = 101 / 0.25).
    expect(result.aggressive).toEqual([expect.objectContaining({ side: "buy", row: 404, span: 1, volume: 1 })]);
  });

  /** A book that goes bad mid-window: snapshot 10 s before T, one clean book at T + 1 s, a bid through the ask at T + 2 s, prints either side of it, a fresh snapshot at T + 6 s. */
  function seedLostBook(storage) {
    order(storage, { ts: T - 10_000, index: 1, flags: SNAPSHOT_BEGIN_BIT, price: 100, size: 5, side: "BUY" });
    order(storage, { ts: T - 10_000, index: 2, flags: SNAPSHOT_END_BIT, price: 101, size: 3, side: "SELL" });
    order(storage, { ts: T + 1_000, index: 3, price: 101.25, size: 2, side: "SELL" });
    order(storage, { ts: T + 2_000, index: 4, price: 102, size: 1, side: "BUY" });
    print(storage, { ts: T + 3_000, price: 101, size: 1, aggressor: "BUY" });
    print(storage, { ts: T + 4_500, price: 101, size: 1, aggressor: "BUY" });
    order(storage, { ts: T + 6_000, index: 5, flags: SNAPSHOT_BEGIN_BIT, price: 100, size: 4, side: "BUY" });
    order(storage, { ts: T + 6_000, index: 6, flags: SNAPSHOT_END_BIT, price: 101, size: 2, side: "SELL" });
  }

  test("says when the book is lost and re-anchors on the next stored snapshot, so one replay spans a collector restart", () => {
    seedLostBook(storage);
    const source = createDxFeedReplaySource({ db: storage.raw, symbol: SYMBOL, assetClass: "FUTURE", fromTs: T, toTs: T + 8_000, coalesceMs: 0 });
    const frames = [...source.frames()];
    expect(frames.map((f) => [f.kind, f.ts])).toEqual([
      ["book", T + 1_000],
      ["anchor", T + 2_000],
      ["trade", T + 3_000],
      ["trade", T + 4_500],
      ["anchor", T + 6_000],
      ["book", T + 6_000],
    ]);
    // The first book after the re-anchor carries the whole book, never a delta against the book that was lost.
    expect(frames[5].book).toMatchObject({ bids: [[100, 4]], asks: [[101, 2]] });
    expect(frames[5].delta).toEqual({ bids: [[100, 4]], asks: [[101, 2]] });
    expect(source.stats).toMatchObject({ booksEmitted: 2, anchors: 1, unavailable: 1 });
    source.close();
    // A book lost before the window is the caller's history, not a frame: the window still opens on the re-anchor.
    const later = createDxFeedReplaySource({ db: storage.raw, symbol: SYMBOL, assetClass: "FUTURE", fromTs: T + 5_000, toTs: T + 8_000, coalesceMs: 0 });
    expect([...later.frames()].map((f) => [f.kind, f.ts])).toEqual([["anchor", T + 6_000], ["book", T + 6_000]]);
    later.close();
  });

  test("the backfill stops sampling where the book was lost instead of repeating it to the end of the window", async () => {
    seedLostBook(storage);
    const columns = [];
    const result = await runBackfillInProcess({
      db: storage.raw, symbol: SYMBOL, marketKind: "FUTURE", fromTs: T, toTs: T + 6_000, columnMs: 1_000,
      rowClusters: 1, windowRows: 20, tickSize: 0.25, clusterTicks: 1,
      onColumn: (column) => columns.push(column),
    });
    expect(result.reason).toBeNull();
    // Measured on the recording of 2026-09-15: half of NQ's backfilled columns (35 of 70) were one frozen book
    // repeated for six minutes after a crossed book, with real prints laid over liquidity that had gone.
    const stamps = columns.map((column) => column.ts);
    // Sampled while the book was whole, and again once the fresh snapshot rebuilt it; nothing in between.
    expect(stamps).toContain(T + 1_000);
    expect(stamps).toContain(T + 6_000);
    for (const dead of [T + 3_000, T + 4_000, T + 5_000]) expect(stamps).not.toContain(dead);
  });
});
