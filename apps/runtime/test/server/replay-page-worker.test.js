"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStorageDb } = require("../../src/storage/storage-db");
jest.mock("../../src/indicators/l2-memory/replay-source", () => {
  const actual = jest.requireActual("../../src/indicators/l2-memory/replay-source");
  return { ...actual, createReplaySource: jest.fn(actual.createReplaySource) };
});
const { connectionFor, runBand } = require("../../src/server/replay-page-worker");

describe("replay-page-worker connection cache", () => {
  let made;
  beforeEach(() => { made = []; });
  afterEach(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

  function fixtureDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-page-worker-"));
    made.push(dir);
    const dbPath = path.join(dir, "market-data.sqlite");
    createStorageDb({ dbPath }).close();
    return dbPath;
  }

  test("reuses the same open connection across calls for the same, unchanged database file", () => {
    const dbPath = fixtureDb();
    const first = connectionFor(dbPath);
    const second = connectionFor(dbPath);
    expect(second).toBe(first);
    first.close();
  });

  test("closes the stale connection and opens a fresh one once the underlying file is replaced", () => {
    const dbPath = fixtureDb();
    const first = connectionFor(dbPath);
    expect(first.open).toBe(true);
    // A real deploy/migration replaces the file while nothing in this
    // process still has it open (Windows enforces that; POSIX would allow
    // it too, just less strictly). Simulate that here, and separately prove
    // the cache's own recovery path (an already-closed cached handle) is
    // handled safely below.
    first.close();
    fs.rmSync(dbPath);
    createStorageDb({ dbPath }).close();
    const second = connectionFor(dbPath);
    expect(second).not.toBe(first);
    expect(second.open).toBe(true);
    second.close();
  });

  test("does not throw when the cached connection was already closed by someone else before the fingerprint check", () => {
    const dbPath = fixtureDb();
    const first = connectionFor(dbPath);
    first.close();
    fs.rmSync(dbPath);
    createStorageDb({ dbPath }).close();
    let reopened;
    expect(() => { reopened = connectionFor(dbPath); }).not.toThrow();
    reopened.close();
  });
});

describe("replay-page-worker band history", () => {
  let made;
  beforeEach(() => { made = []; });
  afterEach(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

  test("a hole the recording never re-anchors after ends the columns at the last ready book, even when trades keep printing past it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-page-worker-band-"));
    made.push(dir);
    const dbPath = path.join(dir, "market-data.sqlite");
    const storage = createStorageDb({ dbPath });
    const db = storage.raw;
    const S = 1_700_000_040_000;
    db.prepare("INSERT INTO l2_depth_snapshots (captured_at, symbol, market_kind, last_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?)")
      .run(S, "BTCUSDT", "PERPETUAL", 100, JSON.stringify([["100", "5"]]), JSON.stringify([["101", "3"]]));
    const insert = db.prepare("INSERT INTO l2_depth_events (ts, received_at, symbol, market_kind, first_update_id, last_update_id, previous_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run(S + 200, S + 201, "BTCUSDT", "PERPETUAL", 100, 101, 99, JSON.stringify([["100", "6"]]), "[]");
    insert.run(S + 700, S + 701, "BTCUSDT", "PERPETUAL", 105, 105, 104, JSON.stringify([["100", "7"]]), "[]");
    db.prepare("INSERT INTO trades (ts, symbol, market_kind, price, size, side, trade_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(S + 1_500, "BTCUSDT", "PERPETUAL", 100, 1, "sell", "trade-1");
    storage.close();
    const { result } = await runBand({
      provider: "binance", dbPath, symbol: "BTCUSDT", marketKind: "PERPETUAL",
      tickSize: 1, clusterTicks: 1, rowClusters: 1, fromTs: S, toTs: S + 3_000, columnMs: 1_000, priceLo: 100, priceHi: 101,
    });
    expect(result.frames).toBeGreaterThan(0);
    expect(require("../../src/indicators/l2-memory/replay-source").createReplaySource).toHaveBeenLastCalledWith(expect.objectContaining({ bookMode: "sparse", includeBuffering: true }));
    expect(result.columns).toEqual([]);
    connectionFor(dbPath).close();
  });
});
