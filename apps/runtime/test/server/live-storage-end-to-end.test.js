"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStorageDb } = require("../../src/storage/storage-db");
const { createStorageReader } = require("../../src/storage/storage-reader");
const { createDxFeedStorageDb } = require("../../src/storage/dxfeed/dxfeed-storage-db");
const { createDxFeedStorageReader } = require("../../src/storage/dxfeed/dxfeed-storage-reader");
const { createRemoteDxFeedStorageReader } = require("../../src/storage/dxfeed/remote-dxfeed-storage-reader");
const { createRemoteStorageReader } = require("../../src/storage/remote-storage-reader");
const { createService } = require("../../scripts/serve/run-live-storage-service");
const { createGateway } = require("../../scripts/serve/run-archive-gateway");
const { safeRm } = require("../helpers/temp-files");
const { MIN_TOKEN_LENGTH } = require("../../src/server/archive-auth");
const { createSource: createRemoteReplaySource } = require("../../src/indicators/l2-memory/remote-replay-source");

const DEV_SECRET = "d".repeat(MIN_TOKEN_LENGTH);
const SERVICE_SECRET = "internal-service-secret-under-test-e2e";

function tempDbPath() {
  return path.join(os.tmpdir(), `terminal-l1-l2-live-storage-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function tempDxfeedDbPath() {
  return path.join(os.tmpdir(), `terminal-l1-l2-live-storage-e2e-dxfeed-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function seedTrade(storageDb, ts, overrides = {}) {
  storageDb.insert("trades", {
    ts, symbol: "BTCUSDT", marketKind: "SPOT", price: 100, size: 1, side: "buy",
    tradeId: `t-${ts}-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  });
}

function seedDepth(storageDb) {
  const db = storageDb.raw;
  db.prepare("INSERT INTO l2_depth_snapshots (captured_at, symbol, market_kind, last_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?)")
    .run(1_000, "BTCUSDT", "SPOT", 100, JSON.stringify([["100", "5"]]), JSON.stringify([["101", "3"]]));
  const insertEvent = db.prepare("INSERT INTO l2_depth_events (ts, received_at, symbol, market_kind, first_update_id, last_update_id, previous_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insertEvent.run(2_000, 2_001, "BTCUSDT", "SPOT", 101, 101, null, JSON.stringify([["100", "6"]]), "[]");
  insertEvent.run(2_500, 2_501, "BTCUSDT", "SPOT", 102, 102, null, "[]", JSON.stringify([["101", "4"]]));
}

// Equity studies are regular-session only (report 57 W1, GE-14): RTH is a
// real 10:00 EDT minute, PRE_MARKET is 08:00 EDT the same day. The tape read
// returns both; the study reads return only the regular-session print.
const RTH = Date.parse("2026-09-23T14:00:00Z");
const PRE_MARKET = Date.parse("2026-09-23T12:00:00Z");

function seedDxfeedTimeAndSale(storageDb, eventTime, overrides = {}) {
  storageDb.insert("dxfeed_time_and_sales", {
    eventTime, receivedAt: eventTime, provider: "DXFEED", venue: "NTV", assetClass: "EQUITY",
    symbol: "AAPL", stale: 0, recoveryState: "READY", price: 100, size: 5,
    time: eventTime, timeNanoPart: 0, sequence: eventTime, exchangeCode: "L", extendedTradingHours: 1,
    aggressorSide: "BUY", spreadLeg: 0, validTick: 0, eventKind: "NEW", providerIndex: null,
    providerTradeId: null, bidPrice: null, askPrice: null,
    ...overrides,
  });
}

function seedDxfeedOrderBookCapture(storageDb, windowFromTs) {
  const base = {
    provider: "DXFEED", venue: "XCME", assetClass: "FUTURE", symbol: "/NQZ26:XCME",
    stale: 0, recoveryState: "READY", time: windowFromTs - 1_000, action: "NEW", actionTime: windowFromTs - 1_000,
    scope: "ORDER", source: "GLBX", marketMaker: null,
  };
  storageDb.insert("dxfeed_order_book_capture", {
    ...base, eventTime: windowFromTs - 1_000, receivedAt: windowFromTs - 999, orderIndex: "1", eventFlags: 4,
    orderId: 1, price: 100, size: 5, side: "BUY",
  });
  storageDb.insert("dxfeed_order_book_capture", {
    ...base, eventTime: windowFromTs - 1_000, receivedAt: windowFromTs - 998, orderIndex: "2", eventFlags: 8,
    orderId: 2, price: 101, size: 3, side: "SELL",
  });
  storageDb.insert("dxfeed_order_book_capture", {
    ...base, eventTime: windowFromTs + 1_000, receivedAt: windowFromTs + 1_001,
    time: windowFromTs + 1_000, actionTime: windowFromTs + 1_000,
    orderIndex: "3", eventFlags: 0, orderId: 3, price: 101.25, size: 2, side: "SELL",
  });
}

// A real sqlite fixture, a real live-storage service, a real gateway relaying
// to it, and the real remote-storage-reader client -- proving the client
// built in the prior session and the service built in this one actually
// agree on the wire, not just that each side's own mocks are self-consistent.
describe("live-storage end to end: real client -> real gateway relay -> real service -> real sqlite", () => {
  let dbPath;
  let service;
  let gateway;

  afterEach(async () => {
    if (gateway) { await gateway.stop(); gateway = null; }
    if (service) { await service.stop(); service = null; }
    if (dbPath && fs.existsSync(dbPath)) {
      try { safeRm(dbPath, { force: true }); } catch { /* best-effort */ }
    }
    dbPath = null;
  });

  async function startStack() {
    dbPath = tempDbPath();
    const writer = createStorageDb({ dbPath });
    seedTrade(writer, 1_000);
    seedTrade(writer, 5_000);
    seedDepth(writer);
    writer.close();

    const storageReader = createStorageReader({ dbPath });
    service = createService({
      port: 0, host: "127.0.0.1", dbPath, storageReader,
      tickSizeResolver: { getBinanceTickSize: async () => 1, getDxFeedTickSize: () => 0.01 },
      env: { TT_LIVE_STORAGE_SERVICE_SECRET: SERVICE_SECRET }, log: () => {},
    });
    await service.start();
    const serviceUrl = `http://127.0.0.1:${service.server.address().port}`;

    gateway = createGateway({
      port: 0, host: "127.0.0.1", log: () => {},
      env: {
        TT_ARCHIVE_CLIENT_TOKENS: `laptop-1:${DEV_SECRET}`,
        TT_LIVE_STORAGE_INTERNAL_URL: serviceUrl,
        TT_LIVE_STORAGE_SERVICE_SECRET: SERVICE_SECRET,
      },
    });
    await gateway.start();
    const gatewayUrl = `http://127.0.0.1:${gateway.server.address().port}`;

    return createRemoteStorageReader({ baseUrl: `${gatewayUrl}/live-storage`, token: DEV_SECRET });
  }

  test("a real recording-age read reaches the real sqlite fixture through the gateway relay", async () => {
    const client = await startStack();
    const result = await client.readRecordingAge("BTCUSDT", "SPOT", { nowMs: 65_000 });
    expect(result).toEqual({ latestTs: 5_000, ageMs: 60_000, available: true });
    expect(service.health().route.telemetry.routes["recording-age"].stages).toMatchObject({
      workerStartupMs: { count: 1 }, readerSetupMs: { count: 1 },
      queryMs: { count: 1 }, workerTotalMs: { count: 1 },
    });
    await client.close();
  });

  test("a real recent-trades read returns the seeded rows with a working cursor", async () => {
    const client = await startStack();
    const result = await client.readRecentTrades("BTCUSDT", "SPOT", { windowMs: 10_000, nowMs: 10_000, limit: 100 });
    expect(result.available).toBe(true);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((row) => row.ts_exchange).sort((a, b) => a - b)).toEqual([1_000, 5_000]);
  });

  test("a real remote replay page traverses gateway and service worker without a laptop database", async () => {
    const client = await startStack();
    const source = createRemoteReplaySource({
      symbol: "BTCUSDT", marketKind: "SPOT", fromTs: 1_000, toTs: 3_000,
      tickSize: 1, clusterTicks: 1, rowClusters: 1, windowRows: 5,
      remote: client.remote,
    });
    const frames = [];
    for await (const frame of source.frames()) frames.push(frame);
    expect(frames.map((frame) => frame.kind)).toEqual(["anchor", "trade", "book", "book"]);
    expect(frames[2]).toMatchObject({ kind: "book", ts: 2_000, book: { bids: [["100", "6"]], asks: [["101", "3"]] } });
    expect(frames[3]).toMatchObject({ kind: "book", ts: 2_500, book: { bestBid: "100", bestAsk: "101" }, delta: { asks: [["101", "4"]] } });
    expect(frames[3].book.bids).toBeUndefined();
    expect(source.stats).toEqual({ pages: 1, frames: 4, bookMode: "sparse" });
    source.close();
    await client.close();
  });

  test("a symbol nobody recorded returns the same unavailable-but-known shape as the local reader would", async () => {
    const client = await startStack();
    const result = await client.readRecordingAge("ETHUSDT", "SPOT", { nowMs: 65_000 });
    expect(result).toEqual({ latestTs: null, ageMs: null, available: true });
  });

  // These three routes are the ones ROUTES mapped to the wrong (Async-suffixed)
  // storage-reader method name after readAsync was added -- a mismatch no
  // fake-storage-reader unit test could catch, since fakes never exercised
  // readAsync. Only a real reader talking through the real worker dispatch
  // catches it, which is exactly what caught it live on the host.
  test("a real large-trades read reaches the real sqlite fixture through the worker dispatch path", async () => {
    const client = await startStack();
    const result = await client.readLargeTradesAsync("BTCUSDT", "SPOT", { nowMs: 10_000, limit: 5 });
    expect(result.available).toBe(true);
    expect(result.rows).toHaveLength(2);
  });

  test("a real aggressive-prints read reaches the real sqlite fixture through the worker dispatch path", async () => {
    const client = await startStack();
    const result = await client.readAggressivePrintsAsync("BTCUSDT", "SPOT", { fromMs: 0, toMs: 10_000, limit: 5 });
    expect(result.available).toBe(true);
    expect(result.rows).toHaveLength(2);
  });

  test("a real volume-profile read reaches the real sqlite fixture through the worker dispatch path", async () => {
    const client = await startStack();
    const result = await client.readVolumeProfileAsync("BTCUSDT", "SPOT", { fromTs: 0, toTs: 10_000, originPrice: 100, rowWidth: 1 });
    expect(result.available).toBe(true);
    expect(result.buckets.length).toBeGreaterThan(0);
    expect(result.buckets.reduce((sum, bucket) => sum + bucket.tradeCount, 0)).toBe(2);
  });

  test("stopping the live-storage service mid-session degrades the client to its fallback shape instead of hanging", async () => {
    const client = await startStack();
    await client.readRecordingAge("BTCUSDT", "SPOT", { nowMs: 65_000 });
    await service.stop();
    service = null;
    const result = await client.readRecordingAge("BTCUSDT", "SPOT", { nowMs: 65_000 });
    expect(result).toEqual({ latestTs: null, ageMs: null, available: false });
  }, 15_000);

  test("the real dxfeed client reaches recent events and aggregates through gateway, service, worker, and sqlite", async () => {
    dbPath = tempDbPath();
    createStorageDb({ dbPath }).close();
    const dxfeedDbPath = tempDxfeedDbPath();
    const dxfeedWriter = createDxFeedStorageDb({ dbPath: dxfeedDbPath });
    seedDxfeedTimeAndSale(dxfeedWriter, RTH + 1_000, { price: 100, size: 5 });
    seedDxfeedTimeAndSale(dxfeedWriter, PRE_MARKET, { price: 90, size: 7 });
    dxfeedWriter.close();

    const storageReader = createStorageReader({ dbPath });
    const dxfeedStorageReader = createDxFeedStorageReader({ dbPath: dxfeedDbPath });
    service = createService({
      port: 0, host: "127.0.0.1", storageReader, dxfeedStorageReader,
      env: { TT_LIVE_STORAGE_SERVICE_SECRET: SERVICE_SECRET }, log: () => {},
    });
    await service.start();
    const serviceUrl = `http://127.0.0.1:${service.server.address().port}`;

    gateway = createGateway({
      port: 0, host: "127.0.0.1", log: () => {},
      env: {
        TT_ARCHIVE_CLIENT_TOKENS: `laptop-1:${DEV_SECRET}`,
        TT_LIVE_STORAGE_INTERNAL_URL: serviceUrl,
        TT_LIVE_STORAGE_SERVICE_SECRET: SERVICE_SECRET,
      },
    });
    await gateway.start();
    const gatewayUrl = `http://127.0.0.1:${gateway.server.address().port}`;
    const client = createRemoteDxFeedStorageReader({ baseUrl: `${gatewayUrl}/live-storage`, token: DEV_SECRET });

    await expect(client.readRecent("AAPL", "EQUITY", "TIMEANDSALE", { limit: 10 })).resolves.toEqual({
      rows: [
        expect.objectContaining({ symbol: "AAPL", event_time: RTH + 1_000, size: 5 }),
        expect.objectContaining({ symbol: "AAPL", event_time: PRE_MARKET, size: 7 }),
      ],
      available: true,
    });
    await expect(client.readDailyNotional("AAPL", "EQUITY", { fromTs: PRE_MARKET, toTs: RTH + 3_600_000 })).resolves.toEqual({
      rows: [{ dayTs: RTH - (RTH % 86_400_000), notional: 500 }], available: true,
    });
    const tradesSince = await client.readTradesSince("AAPL", "EQUITY", { fromTs: PRE_MARKET, toTs: RTH + 3_600_000, cursor: null, limit: 10 });
    expect(tradesSince.available).toBe(true);
    expect(tradesSince.rows).toEqual([expect.objectContaining({ symbol: "AAPL", event_time: RTH + 1_000, size: 5 })]);
    expect(tradesSince.nextCursor).toEqual({ ts: RTH + 1_000, id: expect.any(Number) });
    await client.close();

    for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dxfeedDbPath}${suffix}`, { force: true });
  });

  // Report 57 W2, FA-8: the aggressive-print pool reads its first hour with no
  // size floor, 10,000 rows a page. A real AAPL hour holds about 120,000
  // prints, and a dxFeed row read whole is about 550 bytes, so the first page
  // was about 5.5 MB against a 2 MB relay cap: the remote read always came
  // back "unavailable" and the bubble history for a dense equity never
  // loaded. A full page must make it through every hop.
  test("a full 10,000-row dxFeed aggressive-prints page crosses gateway, service and remote client intact (FA-8)", async () => {
    dbPath = tempDbPath();
    createStorageDb({ dbPath }).close();
    const dxfeedDbPath = tempDxfeedDbPath();
    const dxfeedWriter = createDxFeedStorageDb({ dbPath: dxfeedDbPath });
    const insert = dxfeedWriter.raw.transaction(() => {
      for (let index = 0; index < 10_500; index += 1) {
        seedDxfeedTimeAndSale(dxfeedWriter, RTH + index * 100, {
          price: 254.37 + (index % 50) / 100, size: 100 + (index % 7), sequence: 600_000 + index,
          aggressorSide: index % 2 === 0 ? "BUY" : "SELL", exchangeSaleConditions: "@  o",
        });
      }
    });
    insert();
    dxfeedWriter.close();

    const storageReader = createStorageReader({ dbPath });
    const dxfeedStorageReader = createDxFeedStorageReader({ dbPath: dxfeedDbPath });
    service = createService({
      port: 0, host: "127.0.0.1", storageReader, dxfeedStorageReader,
      env: { TT_LIVE_STORAGE_SERVICE_SECRET: SERVICE_SECRET }, log: () => {},
    });
    await service.start();
    gateway = createGateway({
      port: 0, host: "127.0.0.1", log: () => {},
      env: {
        TT_ARCHIVE_CLIENT_TOKENS: `laptop-1:${DEV_SECRET}`,
        TT_LIVE_STORAGE_INTERNAL_URL: `http://127.0.0.1:${service.server.address().port}`,
        TT_LIVE_STORAGE_SERVICE_SECRET: SERVICE_SECRET,
      },
    });
    await gateway.start();
    const client = createRemoteDxFeedStorageReader({ baseUrl: `http://127.0.0.1:${gateway.server.address().port}/live-storage`, token: DEV_SECRET });

    const page = await client.readAggressivePrintsAsync("AAPL", "EQUITY", { fromMs: RTH, toMs: RTH + 10_500 * 100, minSize: 0, limit: 10_000 });
    expect(page.available).toBe(true);
    expect(page.rows).toHaveLength(10_000);
    expect(page.hasMore).toBe(true);
    expect(page.rows[0]).toMatchObject({ symbol: "AAPL", asset_class: "EQUITY", event_kind: "NEW", aggressor_side: expect.stringMatching(/BUY|SELL/) });
    await client.close();
    for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dxfeedDbPath}${suffix}`, { force: true });
  }, 60_000);

  test("a real dxfeed remote replay page traverses gateway, service, and the replay worker against the real order-book fixture", async () => {
    dbPath = tempDbPath();
    createStorageDb({ dbPath }).close();
    const dxfeedDbPath = tempDxfeedDbPath();
    const dxfeedWriter = createDxFeedStorageDb({ dbPath: dxfeedDbPath });
    seedDxfeedOrderBookCapture(dxfeedWriter, 100_000);
    dxfeedWriter.close();

    const storageReader = createStorageReader({ dbPath });
    const dxfeedStorageReader = createDxFeedStorageReader({ dbPath: dxfeedDbPath });
    service = createService({
      port: 0, host: "127.0.0.1", dbPath, dxfeedDbPath, storageReader, dxfeedStorageReader,
      tickSizeResolver: { getBinanceTickSize: async () => 1, getDxFeedTickSize: () => 0.25 },
      env: { TT_LIVE_STORAGE_SERVICE_SECRET: SERVICE_SECRET }, log: () => {},
    });
    await service.start();
    const serviceUrl = `http://127.0.0.1:${service.server.address().port}`;

    gateway = createGateway({
      port: 0, host: "127.0.0.1", log: () => {},
      env: {
        TT_ARCHIVE_CLIENT_TOKENS: `laptop-1:${DEV_SECRET}`,
        TT_LIVE_STORAGE_INTERNAL_URL: serviceUrl,
        TT_LIVE_STORAGE_SERVICE_SECRET: SERVICE_SECRET,
      },
    });
    await gateway.start();
    const gatewayUrl = `http://127.0.0.1:${gateway.server.address().port}`;

    const source = createRemoteReplaySource({
      symbol: "/NQZ26:XCME", marketKind: "FUTURE", fromTs: 100_000, toTs: 102_000,
      tickSize: 0.25, clusterTicks: 1, rowClusters: 1, windowRows: 10,
      remote: { baseUrl: `${gatewayUrl}/live-storage`, token: DEV_SECRET },
    });
    const frames = [];
    for await (const frame of source.frames()) frames.push(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: "book", ts: 101_000,
      book: { bids: [[100, 5]], asks: [[101, 3], [101.25, 2]] },
    });
    expect(source.stats).toEqual({ pages: 1, frames: 1, bookMode: "sparse" });
    source.close();

    for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dxfeedDbPath}${suffix}`, { force: true });
  });
});
