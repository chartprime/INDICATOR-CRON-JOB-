"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStorageDb } = require("../../src/storage/storage-db");
const { createDxFeedStorageDb } = require("../../src/storage/dxfeed/dxfeed-storage-db");
const { createReplayPageReader, sign, verify } = require("../../src/server/replay-page-reader");
const { readTelemetry } = require("../../src/storage/read-telemetry");

const T = 1_700_000_000_000;
const SECRET = "cursor-secret-that-is-long-enough";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-page-"));
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

function options(cursor = null) {
  return {
    fromTs: T, toTs: T + 3_000, tickSize: 1, clusterTicks: 1,
    rowClusters: 1, windowRows: 5, cursor,
  };
}

describe("replay-page-reader", () => {
  let made;
  beforeEach(() => { made = []; });
  afterEach(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

  function readerFor(dbPath, overrides = {}) {
    return createReplayPageReader({
      dbPath, dxfeedDbPath: dbPath, cursorSecret: SECRET, maxFrames: 3,
      tickSizeResolver: { getBinanceTickSize: async () => 1, getDxFeedTickSize: () => 0.25 },
      ...overrides,
    });
  }

  test("signs bounded independently replayable pages and advances only at timestamp boundaries", async () => {
    const data = fixture();
    made.push(data.dir);
    const reader = readerFor(data.dbPath);
    const first = await reader.readAsync("readReplayPage", "BTCUSDT", "PERPETUAL", options(), { provider: "binance" });
    expect(readTelemetry(first)).toMatchObject({
      poolQueueMs: expect.any(Number),
      workerStartupMs: expect.any(Number), readerSetupMs: expect.any(Number),
      queryMs: expect.any(Number), workerTotalMs: expect.any(Number),
    });
    expect(first.complete).toBe(false);
    expect(first.stats).toMatchObject({ timestampGroupsExamined: expect.any(Number), encodedBytes: expect.any(Number) });
    expect(first.frames).toHaveLength(3);
    expect(first.frames[0].kind).toBe("anchor");
    expect(typeof first.nextCursor).toBe("string");
    const second = await reader.readAsync("readReplayPage", "BTCUSDT", "PERPETUAL", options(first.nextCursor), { provider: "binance" });
    expect(second.complete).toBe(true);
    expect(second.nextCursor).toBeNull();
    expect(second.frames[0].kind).toBe("anchor");
    expect(second.frames.some((frame) => frame.kind === "trade")).toBe(true);
    expect(second.frames.some((frame) => frame.kind === "book" && frame.ts === T + 2_200)).toBe(true);
    await reader.close();
  });

  test("classifies its inner deadline independently from the route deadline", async () => {
    const data = fixture();
    made.push(data.dir);
    const reader = readerFor(data.dbPath, { timeoutMs: 1 });
    await expect(reader.readAsync("readReplayPage", "BTCUSDT", "PERPETUAL", options(), { provider: "binance" }))
      .rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", telemetryReason: "reader_timeout" });
    await reader.close();
  });

  // Property: in sparse book mode the worker keeps the whole book only on the
  // first READY frame of each page (the client marks itself unavailable on the
  // page's anchor, so that frame is a resync) and sends best prices after it.
  // Oracle: the same pages in the default full mode, and the anchor position.
  test("sparse book mode sends the whole book once per page and best prices after it, through the real worker", async () => {
    const data = fixture();
    made.push(data.dir);
    const reader = readerFor(data.dbPath);
    try {
      const sparse = { ...options(), bookMode: "sparse" };
      const first = await reader.readAsync("readReplayPage", "BTCUSDT", "PERPETUAL", sparse, { provider: "binance" });
      expect(first.frames.map((frame) => frame.kind)).toEqual(["anchor", "book", "book"]);
      expect(first.frames[1].book).toMatchObject({ lastUpdateId: 101, bids: expect.any(Array), asks: expect.any(Array) });
      expect(first.frames[2].book).toEqual({ lastUpdateId: 102, bestBid: "100", bestAsk: "101" });
      const second = await reader.readAsync("readReplayPage", "BTCUSDT", "PERPETUAL", { ...sparse, cursor: first.nextCursor }, { provider: "binance" });
      expect(second.complete).toBe(true);
      const book = second.frames.find((frame) => frame.kind === "book");
      expect(Array.isArray(book.book.bids)).toBe(true);

      const full = await reader.readAsync("readReplayPage", "BTCUSDT", "PERPETUAL", options(), { provider: "binance" });
      expect(full.frames.map((frame) => frame.kind)).toEqual(first.frames.map((frame) => frame.kind));
      expect(Array.isArray(full.frames[2].book.bids)).toBe(true);
      expect(first.frames.map((frame) => frame.delta)).toEqual(full.frames.map((frame) => frame.delta));
      expect(first.stats.encodedBytes).toBeLessThan(full.stats.encodedBytes);
    } finally {
      await reader.close();
    }
  });

  test("bookMode is not part of the cursor identity, so a page can be resumed in either mode", async () => {
    const data = fixture();
    made.push(data.dir);
    const reader = readerFor(data.dbPath);
    try {
      const first = await reader.readAsync("readReplayPage", "BTCUSDT", "PERPETUAL", { ...options(), bookMode: "sparse" }, { provider: "binance" });
      const resumedFull = await reader.readAsync("readReplayPage", "BTCUSDT", "PERPETUAL", options(first.nextCursor), { provider: "binance" });
      expect(resumedFull.complete).toBe(true);
      await expect(reader.readAsync("readReplayPage", "BTCUSDT", "PERPETUAL", { ...options(), bookMode: "tiny" }, { provider: "binance" }))
        .rejects.toThrow(/^replay-page-reader: bookMode must be one of full, sparse$/);
    } finally {
      await reader.close();
    }
  });

  test("rejects cursor tampering, request mismatch, and storage replacement", async () => {
    const data = fixture();
    made.push(data.dir);
    const reader = readerFor(data.dbPath);
    const first = await reader.readAsync("readReplayPage", "BTCUSDT", "PERPETUAL", options(), { provider: "binance" });
    await expect(reader.readAsync("readReplayPage", "BTCUSDT", "PERPETUAL", options(`${first.nextCursor}x`), { provider: "binance" }))
      .rejects.toThrow(/invalid cursor/);
    await expect(reader.readAsync("readReplayPage", "BTCUSDT", "PERPETUAL", { ...options(first.nextCursor), windowRows: 6 }, { provider: "binance" }))
      .rejects.toThrow(/request mismatch/);
    // The pool's workers hold the database open for reuse across pages, so
    // on Windows the file can't be replaced out from under a live reader --
    // close it first, exactly like a real deploy would stop the service
    // before swapping the file. A fresh reader is stateless with respect to
    // cursors (they are self-contained signed tokens), so this still proves
    // the same thing: a cursor minted against old storage is rejected once
    // the storage it names has actually changed.
    await reader.close();
    fs.rmSync(data.dbPath);
    const replacement = createStorageDb({ dbPath: data.dbPath });
    replacement.close();
    const readerAfterReplacement = readerFor(data.dbPath);
    await expect(readerAfterReplacement.readAsync("readReplayPage", "BTCUSDT", "PERPETUAL", options(first.nextCursor), { provider: "binance" }))
      .rejects.toThrow(/storage identity changed/);
    await readerAfterReplacement.close();
  });

  test("does not cross-validate a Binance tickSize against a live catalog (terminal-live-storage.service has no network egress)", async () => {
    const data = fixture();
    made.push(data.dir);
    const reader = readerFor(data.dbPath, {
      tickSizeResolver: { getBinanceTickSize: async () => { throw new Error("must not be called"); }, getDxFeedTickSize: () => 0.25 },
    });
    const page = await reader.readAsync("readReplayPage", "BTCUSDT", "PERPETUAL", { ...options(), tickSize: 0.01 }, { provider: "binance" });
    expect(page.complete).toBe(false);
    await reader.close();
  });

  test("an aborted request kills its worker without shrinking the pool -- the next request still succeeds", async () => {
    const data = fixture();
    made.push(data.dir);
    // Abort and timeout share the same "kill this worker and replace it"
    // path (see `crashed: true` in replay-page-reader.js), so an
    // already-aborted signal exercises that path deterministically instead
    // of racing a real clock against real disk I/O.
    const reader = readerFor(data.dbPath, { poolSize: 1 });
    const controller = new AbortController();
    const pending = reader.readAsync("readReplayPage", "BTCUSDT", "PERPETUAL", options(), { provider: "binance", signal: controller.signal });
    // Give the in-flight call's internal `await acquireWorker()` a chance to
    // resolve and attach the abort listener before firing it -- an
    // AbortSignal that is already aborted when a listener is attached never
    // fires that listener, so this ordering matters.
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    // Proves the pool replaced its killed worker rather than being left
    // permanently empty: the same reader, same one-worker pool, must still
    // be able to serve a normal request right after.
    const recovered = await reader.readAsync("readReplayPage", "BTCUSDT", "PERPETUAL", options(), { provider: "binance" });
    expect(recovered.frames.length).toBeGreaterThan(0);
    await reader.close();
  });

  test("with a pool smaller than the concurrent request count, extra requests queue for an idle worker instead of failing", async () => {
    const data = fixture();
    made.push(data.dir);
    const reader = readerFor(data.dbPath, { poolSize: 1 });
    const [a, b, c] = await Promise.all([
      reader.readAsync("readReplayPage", "BTCUSDT", "PERPETUAL", options(), { provider: "binance" }),
      reader.readAsync("readReplayPage", "BTCUSDT", "PERPETUAL", options(), { provider: "binance" }),
      reader.readAsync("readReplayPage", "BTCUSDT", "PERPETUAL", options(), { provider: "binance" }),
    ]);
    for (const result of [a, b, c]) expect(result.frames.length).toBeGreaterThan(0);
    await reader.close();
  });

  test("a cancelled queued band read never consumes the next worker slot", async () => {
    const data = fixture();
    made.push(data.dir);
    const reader = readerFor(data.dbPath, { poolSize: 1 });
    const first = reader.readAsync("readReplayPage", "BTCUSDT", "PERPETUAL", options(), { provider: "binance" });
    const controller = new AbortController();
    const band = reader.readAsync("readBandHistory", "BTCUSDT", "PERPETUAL", {
      fromTs: T, toTs: T + 3_000, tickSize: 1, clusterTicks: 1, rowClusters: 1,
      priceLo: 99, priceHi: 101, columnMs: 1_000,
    }, { provider: "binance", signal: controller.signal });
    controller.abort();
    await expect(band).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", telemetryReason: "reader_aborted" });
    expect((await first).frames.length).toBeGreaterThan(0);
    expect((await reader.readAsync("readReplayPage", "BTCUSDT", "PERPETUAL", options(), { provider: "binance" })).frames.length).toBeGreaterThan(0);
    await reader.close();
  });

  test("cursor signatures are deterministic and authenticated", () => {
    const payload = { z: 1, nested: { b: 2, a: 1 } };
    const cursor = sign(payload, SECRET);
    expect(sign({ nested: { a: 1, b: 2 }, z: 1 }, SECRET)).toBe(cursor);
    expect(verify(cursor, SECRET)).toEqual({ nested: { a: 1, b: 2 }, z: 1 });
    expect(() => verify(cursor, `${SECRET}x`)).toThrow(/invalid cursor/);
  });

  test("a band history runs through the real pooled worker and returns the band's rows per column, telemetry attached", async () => {
    const { dir, dbPath } = fixture();
    made.push(dir);
    const reader = readerFor(dbPath);
    const result = await reader.readAsync("readBandHistory", "BTCUSDT", "PERPETUAL", {
      fromTs: T, toTs: T + 3_000, tickSize: 1, clusterTicks: 1, rowClusters: 1, priceLo: 99, priceHi: 101, columnMs: 1_000,
    }, { provider: "binance" });
    expect(result).toMatchObject({ available: true, rowWidth: 1, rowLo: 99, rowHi: 101, columnMs: 1_000, reason: null });
    expect(result.columns.map((column) => column.ts)).toEqual([T + 1_000, T + 2_000]);
    expect(result.columns[1]).toEqual({ ts: T + 2_000, bid: [2, 6, 0], ask: [0, 0, 4], buy: [0, 0, 0], sell: [0, 0, 0] });
    expect(readTelemetry(result)).toMatchObject({ queryMs: expect.any(Number), workerTotalMs: expect.any(Number) });
    await expect(reader.readAsync("readBandHistory", "BTCUSDT", "PERPETUAL", {
      fromTs: T, toTs: T + 3_000, tickSize: 1, clusterTicks: 1, rowClusters: 1, priceLo: 99, priceHi: 400, columnMs: 1_000,
    }, { provider: "binance" })).rejects.toThrow(/BAND_ROWS_OUT_OF_RANGE/);
    await reader.close();
  });

  test("assembles and truncates dxFeed order capture in the isolated worker", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-page-dxfeed-"));
    made.push(dir);
    const dxfeedDbPath = path.join(dir, "dxfeed.sqlite");
    const storage = createDxFeedStorageDb({ dbPath: dxfeedDbPath });
    const base = {
      provider: "DXFEED", venue: "XCME", assetClass: "FUTURE", symbol: "/NQZ26:XCME",
      stale: 0, recoveryState: "READY", time: T - 1_000, action: "NEW", actionTime: T - 1_000,
      scope: "ORDER", source: "GLBX", marketMaker: null,
    };
    storage.insert("dxfeed_order_book_capture", {
      ...base, eventTime: T - 1_000, receivedAt: T - 999, orderIndex: "1", eventFlags: 4,
      orderId: 1, price: 100, size: 5, side: "BUY",
    });
    storage.insert("dxfeed_order_book_capture", {
      ...base, eventTime: T - 1_000, receivedAt: T - 998, orderIndex: "2", eventFlags: 8,
      orderId: 2, price: 101, size: 3, side: "SELL",
    });
    storage.insert("dxfeed_order_book_capture", {
      ...base, eventTime: T + 1_000, receivedAt: T + 1_001, time: T + 1_000, actionTime: T + 1_000,
      orderIndex: "3", eventFlags: 0, orderId: 3, price: 101.25, size: 2, side: "SELL",
    });
    storage.close();
    const reader = createReplayPageReader({
      dbPath: dxfeedDbPath, dxfeedDbPath, cursorSecret: SECRET,
      tickSizeResolver: { getBinanceTickSize: async () => 1, getDxFeedTickSize: () => 0.25 },
    });
    const page = await reader.readAsync("readReplayPage", "/NQZ26:XCME", "FUTURE", {
      fromTs: T, toTs: T + 2_000, tickSize: 0.25, clusterTicks: 1,
      rowClusters: 1, windowRows: 10, cursor: null,
    }, { provider: "dxfeed" });
    expect(page).toMatchObject({ complete: true, nextCursor: null });
    expect(page.frames).toHaveLength(1);
    expect(page.frames[0]).toMatchObject({
      kind: "book", ts: T + 1_000,
      book: { bids: [[100, 5]], asks: [[101, 3], [101.25, 2]] },
    });
    await reader.close();
  });

  test("still rejects a dxFeed tickSize that does not match its (local, synchronous) catalog", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-page-dxfeed-"));
    made.push(dir);
    const dxfeedDbPath = path.join(dir, "dxfeed.sqlite");
    createDxFeedStorageDb({ dbPath: dxfeedDbPath }).close();
    const reader = createReplayPageReader({
      dbPath: dxfeedDbPath, dxfeedDbPath, cursorSecret: SECRET,
      tickSizeResolver: { getBinanceTickSize: async () => 1, getDxFeedTickSize: () => 0.25 },
    });
    await expect(reader.readAsync("readReplayPage", "/NQZ26:XCME", "FUTURE", {
      fromTs: T, toTs: T + 2_000, tickSize: 1, clusterTicks: 1,
      rowClusters: 1, windowRows: 10, cursor: null,
    }, { provider: "dxfeed" })).rejects.toThrow(/instrument catalog/);
    await reader.close();
  });
});
