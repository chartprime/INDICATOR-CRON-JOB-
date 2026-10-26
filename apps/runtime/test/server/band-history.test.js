"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStorageDb } = require("../../src/storage/storage-db");
const { createReplaySource } = require("../../src/indicators/l2-memory/replay-source");
const { runBandHistory, bandRowsFor, validateBandOptions, MAX_BAND_ROWS, MAX_BAND_WINDOW_MS, MAX_BAND_CELLS } = require("../../src/server/band-history");

const T = 1_700_000_000_000;

// The book of the replay-page-reader fixture, one price per row at a $1 tick:
// a bid of 5 at 100 and 2 at 99, an ask of 3 at 101; at T+200 the 100 bid
// becomes 6, at T+1,500 the 101 ask becomes 4, a sell of 1 prints at 100 at
// T+2,100, and at T+2,200 the 100 bid is back to 5.
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "band-history-"));
  const dbPath = path.join(dir, "market-data.sqlite");
  const storage = createStorageDb({ dbPath });
  const db = storage.raw;
  db.prepare("INSERT INTO l2_depth_snapshots (captured_at, symbol, market_kind, last_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?)")
    .run(T, "BTCUSDT", "PERPETUAL", 100, JSON.stringify([["100", "5"], ["99", "2"]]), JSON.stringify([["101", "3"]]));
  const insert = db.prepare("INSERT INTO l2_depth_events (ts, received_at, symbol, market_kind, first_update_id, last_update_id, previous_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run(T + 200, T + 201, "BTCUSDT", "PERPETUAL", 100, 101, 99, JSON.stringify([["100", "6"]]), "[]");
  insert.run(T + 1_500, T + 1_501, "BTCUSDT", "PERPETUAL", 102, 102, 101, "[]", JSON.stringify([["101", "4"]]));
  db.prepare("INSERT INTO trades (ts, symbol, market_kind, price, size, side, trade_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(T + 2_100, "BTCUSDT", "PERPETUAL", 100, 1, "sell", "trade-1");
  insert.run(T + 2_200, T + 2_201, "BTCUSDT", "PERPETUAL", 103, 103, 102, JSON.stringify([["100", "5"]]), "[]");
  storage.close();
  return { dir, dbPath };
}

describe("band-history", () => {
  let made;
  beforeEach(() => { made = []; });
  afterEach(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

  function sourceFor(dbPath, fromTs, toTs) {
    return createReplaySource({ dbPath, symbol: "BTCUSDT", marketKind: "PERPETUAL", fromTs, toTs });
  }

  test("sparse and full replay produce identical price-band columns and traded flow", async () => {
    const { dir, dbPath } = fixture();
    made.push(dir);
    const options = { tickSize: 1, clusterTicks: 1, rowClusters: 1, fromTs: T, toTs: T + 3_000, columnMs: 1_000, priceLo: 99, priceHi: 101 };
    const full = await runBandHistory({ ...options, source: sourceFor(dbPath, T, T + 3_000) });
    const sparse = await runBandHistory({ ...options, source: createReplaySource({ dbPath, symbol: "BTCUSDT", marketKind: "PERPETUAL", fromTs: T, toTs: T + 3_000, bookMode: "sparse", includeBuffering: true }) });
    expect(sparse.columns).toEqual(full.columns);
    expect(sparse.frames).toBe(full.frames);
    expect(sparse.reason).toBe(full.reason);
  });

  test("bandRowsFor turns a price band into the browser's row indices at the grid's row width", () => {
    expect(bandRowsFor({ priceLo: 99, priceHi: 101, tickSize: 1, clusterTicks: 1, rowClusters: 1 })).toEqual({ rowWidth: 1, rowLo: 99, rowHi: 101 });
    expect(bandRowsFor({ priceLo: 80_001, priceHi: 80_009, tickSize: 0.01, clusterTicks: 100, rowClusters: 4 })).toEqual({ rowWidth: 4, rowLo: 20_000, rowHi: 20_002 });
  });

  test("overlapping one column preserves raw recorded flow at a split boundary", async () => {
    const { dir, dbPath } = fixture();
    made.push(dir);
    const storage = createStorageDb({ dbPath });
    const insert = storage.raw.prepare("INSERT INTO l2_depth_events (ts, received_at, symbol, market_kind, first_update_id, last_update_id, previous_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run(T + 3_500, T + 3_501, "BTCUSDT", "PERPETUAL", 104, 104, 103, "[]", "[]");
    insert.run(T + 4_500, T + 4_501, "BTCUSDT", "PERPETUAL", 105, 105, 104, "[]", "[]");
    storage.close();
    const options = { tickSize: 1, clusterTicks: 1, rowClusters: 1, columnMs: 1_000, priceLo: 99, priceHi: 101 };
    const read = (fromTs, toTs) => runBandHistory({ ...options, fromTs, toTs, source: sourceFor(dbPath, fromTs, toTs) });
    const full = await read(T, T + 5_000);
    const newer = await read(T + 3_000, T + 5_000);
    const older = await read(T, T + 4_000);
    const columns = new Map([...newer.columns, ...older.columns].map((entry) => [entry.ts, entry]));
    expect([...columns.values()].sort((a, b) => a.ts - b.ts)).toEqual(full.columns);
    expect(columns.get(T + 3_000).sell).toEqual([0, 1, 0]);
  });

  test("returns the resting size and the traded volume of the requested rows only, one column per boundary, dense over the rows", async () => {
    const { dir, dbPath } = fixture();
    made.push(dir);
    const result = await runBandHistory({
      source: sourceFor(dbPath, T, T + 3_000), tickSize: 1, clusterTicks: 1, rowClusters: 1,
      fromTs: T, toTs: T + 3_000, columnMs: 1_000, priceLo: 99, priceHi: 101,
    });
    expect(result).toMatchObject({ available: true, rowWidth: 1, rowLo: 99, rowHi: 101, columnMs: 1_000, reason: null });
    expect(result.frames).toBeGreaterThan(0);
    expect(result.columns.map((column) => column.ts)).toEqual([T + 1_000, T + 2_000]);
    const [first, second] = result.columns;
    expect(first).toEqual({ ts: T + 1_000, bid: [2, 6, 0], ask: [0, 0, 3], buy: [0, 0, 0], sell: [0, 0, 0] });
    expect(second).toEqual({ ts: T + 2_000, bid: [2, 6, 0], ask: [0, 0, 4], buy: [0, 0, 0], sell: [0, 0, 0] });
  });

  test("a narrower band keeps its own rows and nothing outside them", async () => {
    const { dir, dbPath } = fixture();
    made.push(dir);
    const result = await runBandHistory({
      source: sourceFor(dbPath, T, T + 3_000), tickSize: 1, clusterTicks: 1, rowClusters: 1,
      fromTs: T, toTs: T + 3_000, columnMs: 1_000, priceLo: 100, priceHi: 100,
    });
    expect(result.columns.map((column) => [column.bid, column.ask, column.sell])).toEqual([[[6], [0], [0]], [[6], [0], [0]]]);
  });

  test("a window the recording does not cover has no columns and says so, never a flat book invented past the last frame", async () => {
    const { dir, dbPath } = fixture();
    made.push(dir);
    const empty = await runBandHistory({
      source: sourceFor(dbPath, T + 60_000, T + 63_000), tickSize: 1, clusterTicks: 1, rowClusters: 1,
      fromTs: T + 60_000, toTs: T + 63_000, columnMs: 1_000, priceLo: 99, priceHi: 101,
    });
    expect(empty).toMatchObject({ available: true, columns: [], frames: 0, reason: "NO_DATA_IN_WINDOW" });
    const past = await runBandHistory({
      source: sourceFor(dbPath, T, T + 30_000), tickSize: 1, clusterTicks: 1, rowClusters: 1,
      fromTs: T, toTs: T + 30_000, columnMs: 1_000, priceLo: 99, priceHi: 101,
    });
    expect(past.columns.at(-1).ts).toBe(T + 2_000);
  });

  test("a hole in the recording leaves no columns: the book after the last ready frame is not carried through the outage, trades inside it write nothing, and columns resume once the book is live again", async () => {
    const S = T - (T % 60_000);
    const book = { bids: [["100", "5"]], asks: [["101", "3"]], lastUpdateId: 1 };
    const frames = [
      { kind: "anchor", ts: S, lastUpdateId: 1 },
      { kind: "book", ts: S + 500, status: "READY", book, delta: { bids: [["100", "5"]], asks: [["101", "3"]] } },
      { kind: "trade", ts: S + 900_000, price: 100, size: 1, side: "sell", tradeId: "t1" },
      { kind: "anchor", ts: S + 1_800_000, lastUpdateId: 2 },
      { kind: "book", ts: S + 1_800_500, status: "READY", book: { ...book, lastUpdateId: 2 }, delta: { bids: [], asks: [] } },
      { kind: "book", ts: S + 1_900_000, status: "READY", book: { ...book, lastUpdateId: 3 }, delta: { bids: [], asks: [] } },
    ];
    const source = { frames: async function* () { yield* frames; }, close() {} };
    const result = await runBandHistory({
      source, tickSize: 1, clusterTicks: 1, rowClusters: 1,
      fromTs: S, toTs: S + 2_000_000, columnMs: 60_000, priceLo: 100, priceHi: 101,
    });
    expect(result.frames).toBe(frames.length);
    expect(result.columns.map((column) => column.ts)).toEqual([S + 1_860_000]);
    expect(result.columns[0]).toMatchObject({ bid: [5, 0], ask: [0, 3], sell: [0, 0] });
  });

  test("bounds: rows, window and cells are the numbers the route enforces", () => {
    expect(MAX_BAND_ROWS).toBe(256);
    expect(MAX_BAND_WINDOW_MS).toBe(2 * 60 * 60 * 1_000);
    expect(MAX_BAND_CELLS).toBe(100_000);
  });

  test("rejects unsafe price-row arithmetic before admitting a replay worker", () => {
    const base = { fromTs: T, toTs: T + 1_000, columnMs: 1_000, clusterTicks: 1, rowClusters: 1, priceLo: 100, priceHi: 101 };
    expect(validateBandOptions({ ...base, tickSize: 1e-20 })).toBe("PRICE_BAND_OUT_OF_RANGE");
    expect(validateBandOptions({ ...base, tickSize: Number.MAX_VALUE, clusterTicks: 100_000, rowClusters: 100_000 })).toBe("PRICE_BAND_OUT_OF_RANGE");
  });
});
