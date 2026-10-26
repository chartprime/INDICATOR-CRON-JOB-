"use strict";

const http = require("node:http");
const { createLiveStorageRoute, LIVE_STORAGE_PATH_PREFIX, SERVICE_SECRET_HEADER, CLIENT_HEADER, CONTRACT_VERSION_HEADER, CORRELATION_ID_HEADER, CONTRACT_VERSION, coalesceKey, validatePayload } = require("../../src/server/live-storage-route");

const SECRET = "s".repeat(32);
const CLIENT = "laptop-1";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

// A real storage reader always exposes readAsync, and live-storage-route's
// dispatch() always prefers it when present -- so every one of the ten
// methods below actually runs through it, exactly like production. A fake
// that only defined the individual readXxx methods previously let every
// test bypass that path entirely, which is exactly how ROUTES mapping three
// entries to the wrong (Async-suffixed) method name went undetected until a
// real deploy.
function fakeStorageReader(overrides = {}) {
  const methods = {
    readRecentCandles: jest.fn(() => ({ rows: [], coversFullWindow: true })),
    readRecentTrades: jest.fn(() => ({ rows: [], available: true })),
    readLargeTrades: jest.fn(() => ({ rows: [], available: true })),
    readAggressivePrints: jest.fn(() => ({ rows: [], available: true, hasMore: false, nextCursor: null })),
    readVolumeProfile: jest.fn(() => ({ buckets: [], available: true })),
    readPriceRange: jest.fn(() => ({ minPrice: 1, maxPrice: 2, tradeCount: 3, available: true })),
    readMinuteRollup: jest.fn(() => ({ rows: [], available: true })),
    readDailyNotional: jest.fn(() => ({ rows: [], available: true })),
    readSlicedNotional: jest.fn(() => ({ rows: [], available: true })),
    readRecordingAge: jest.fn(() => ({ latestTs: null, ageMs: null, available: true })),
    ...overrides,
  };
  const readAsync = jest.fn((method, symbol, marketKind, options) => {
    const implementation = methods[method];
    if (typeof implementation !== "function") return Promise.reject(new Error(`storage-reader: unsupported async method ${method}`));
    return Promise.resolve().then(() => implementation(symbol, marketKind, options));
  });
  return { reader: { ...methods, readAsync }, methods };
}

async function server({ storageReader, ...options } = {}) {
  const reader = storageReader ?? fakeStorageReader().reader;
  const route = createLiveStorageRoute({
    serviceSecret: SECRET,
    log: () => {},
    ...options,
    storageReader: reader,
  });
  const httpServer = http.createServer((request, response) => {
    if (route.handle(request, response)) return;
    response.writeHead(404);
    response.end();
  });
  await listen(httpServer);
  return { route, server: httpServer, reader, base: `http://127.0.0.1:${httpServer.address().port}` };
}

async function post(base, routeName, body, { secret = SECRET, client = CLIENT, headers = {}, signal } = {}) {
  const response = await fetch(`${base}${LIVE_STORAGE_PATH_PREFIX}${routeName}`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(secret === null ? {} : { [SERVICE_SECRET_HEADER]: secret }),
      ...(client === null ? {} : { [CLIENT_HEADER]: client }),
      [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text === "" ? null : JSON.parse(text) };
}

function validBody(overrides = {}) {
  return { symbol: "BTCUSDT", marketKind: "SPOT", options: { intervalMs: 60_000, windowMs: 60_000, nowMs: 1_700_000_000_000 }, ...overrides };
}

function fakeDxfeedStorageReader(overrides = {}) {
  const methods = {
    readRecent: jest.fn(() => ({ rows: [], available: true })),
    readRecentCandles: jest.fn(() => ({ rows: [], available: true, startsAtRequestedWindow: true })),
    readLargeTrades: jest.fn(() => ({ rows: [], available: true })),
    readAggressivePrints: jest.fn(() => ({ rows: [], available: true, hasMore: false, nextCursor: null })),
    readVolumeProfile: jest.fn(() => ({ buckets: [], available: true })),
    readPriceRange: jest.fn(() => ({ minPrice: 1, maxPrice: 2, tradeCount: 3, available: true })),
    readMinuteRollup: jest.fn(() => ({ rows: [], available: true })),
    readDailyNotional: jest.fn(() => ({ rows: [], available: true })),
    readSlicedNotional: jest.fn(() => ({ rows: [], available: true })),
    readTradesSince: jest.fn(() => ({ rows: [], nextCursor: null, available: true })),
    ...overrides,
  };
  const readAsync = jest.fn((method, symbol, assetClass, options) => {
    const implementation = methods[method];
    if (typeof implementation !== "function") return Promise.reject(new Error(`dxfeed-storage-reader: unsupported async method ${method}`));
    return Promise.resolve().then(() => implementation(symbol, assetClass, options));
  });
  return { reader: { ...methods, readAsync }, methods };
}

function dxfeedValidBody(overrides = {}) {
  return { symbol: "AAPL", provider: "dxfeed", assetClass: "EQUITY", options: {}, ...overrides };
}

describe("server/live-storage-route", () => {
  let current;
  afterEach(async () => {
    if (current) { current.route.dispose(); await close(current.server); current = null; }
  });

  async function waitFor(predicate) {
    for (let i = 0; i < 100; i += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error("route condition not reached");
  }

  test("band cancellation is subscriber-aware and the last departing client releases admission even if a reader ignores abort", async () => {
    let readerSignal;
    const replayPageReader = { readAsync: jest.fn((method, symbol, kind, options, context) => {
      readerSignal = context.signal;
      return new Promise(() => {});
    }) };
    current = await server({ replayPageReader, maxConcurrentQueries: 1 });
    const body = validBody({ options: { fromTs: 0, toTs: 3_600_000, tickSize: 1, clusterTicks: 1, rowClusters: 1, priceLo: 100, priceHi: 101, columnMs: 10_000 } });
    const first = new AbortController();
    const second = new AbortController();
    const firstRead = post(current.base, "band-history", body, { signal: first.signal }).catch(() => null);
    await waitFor(() => replayPageReader.readAsync.mock.calls.length === 1);
    const secondRead = post(current.base, "band-history", body, { signal: second.signal }).catch(() => null);
    await waitFor(() => current.route.stats().coalesced === 1);
    first.abort();
    await firstRead;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readerSignal.aborted).toBe(false);
    expect(current.route.stats().inFlight).toBe(1);
    second.abort();
    await secondRead;
    await waitFor(() => readerSignal.aborted && current.route.stats().inFlight === 0);
    expect(current.route.stats().failed).toBe(0);
  });

  test("band and direct replay reads share one combined admission cap", async () => {
    let resolveRead;
    const replayPageReader = { readAsync: jest.fn(() => new Promise((resolve) => { resolveRead = resolve; })) };
    current = await server({ replayPageReader, maxConcurrentQueries: 1 });
    const replay = post(current.base, "replay-page", validBody({ options: { fromTs: 0, toTs: 1_000, tickSize: 1, clusterTicks: 1, rowClusters: 1, windowRows: 10 } }));
    await waitFor(() => replayPageReader.readAsync.mock.calls.length === 1);
    const band = await post(current.base, "band-history", validBody({ options: { fromTs: 0, toTs: 3_600_000, tickSize: 1, clusterTicks: 1, rowClusters: 1, priceLo: 100, priceHi: 101, columnMs: 10_000 } }));
    expect(band).toMatchObject({ status: 429, body: { detail: "CONCURRENT_QUERY_LIMIT_EXCEEDED" } });
    expect(replayPageReader.readAsync).toHaveBeenCalledTimes(1);
    resolveRead({ available: true, frames: [], complete: true });
    expect((await replay).status).toBe(200);
  });

  test("echoes a valid correlation ID and publishes bounded route telemetry", async () => {
    let clock = 100;
    current = await server({ telemetryNow: () => clock });
    const resultPromise = post(current.base, "recording-age", validBody({ options: { nowMs: 1 } }), {
      headers: { [CORRELATION_ID_HEADER]: "selection-42.request-1" },
    });
    clock = 107;
    const result = await resultPromise;
    expect(result.headers.get(CORRELATION_ID_HEADER)).toBe("selection-42.request-1");
    expect(current.route.stats().telemetry.routes["recording-age"]).toMatchObject({
      requests: 1, successes: 1, clientErrors: 0, serverErrors: 0,
      stages: {
        serializationMs: { count: 1 },
        responseWriteMs: { count: 1 },
      },
    });
  });

  test("every route dispatches to the matching storage-reader method with symbol/marketKind/options", async () => {
    current = await server();
    const cases = [
      ["recent-candles", "readRecentCandles", { intervalMs: 60_000, windowMs: 60_000, nowMs: 1 }],
      ["recent-trades", "readRecentTrades", { windowMs: 1_000, nowMs: 1, limit: 5 }],
      ["large-trades", "readLargeTrades", { limit: 5, nowMs: 1 }],
      ["aggressive-prints", "readAggressivePrints", { fromMs: 0, toMs: 1, limit: 5 }],
      ["volume-profile", "readVolumeProfile", { fromTs: 0, toTs: 1, originPrice: 1, rowWidth: 1 }],
      ["price-range", "readPriceRange", { fromTs: 0, toTs: 1 }],
      ["minute-rollup", "readMinuteRollup", { fromTs: 0, toTs: 3_600_000, tickSize: 0.5 }],
      ["daily-notional", "readDailyNotional", { fromTs: 0, toTs: 3_600_000 }],
      ["sliced-notional", "readSlicedNotional", { fromTs: 0, toTs: 1, sliceMs: 1_000 }],
      ["recording-age", "readRecordingAge", { nowMs: 1 }],
    ];
    for (const [routeName, methodName, options] of cases) {
      const { status } = await post(current.base, routeName, validBody({ options }));
      expect(status).toBe(200);
      expect(current.reader[methodName]).toHaveBeenCalledWith("BTCUSDT", "SPOT", options);
    }
  });

  test("replay pages dispatch only through the dedicated reader with provider and cancellation context", async () => {
    const replayPageReader = {
      readAsync: jest.fn(async () => ({ frames: [], complete: true, nextCursor: null, stats: {} })),
    };
    current = await server({ replayPageReader });
    const options = {
      fromTs: 1, toTs: 2, tickSize: 0.01, clusterTicks: 1, rowClusters: 2, windowRows: 3, cursor: null,
    };
    const result = await post(current.base, "replay-page", validBody({ options }));
    expect(result).toMatchObject({ status: 200, body: { frames: [], complete: true, nextCursor: null } });
    expect(replayPageReader.readAsync).toHaveBeenCalledWith(
      "readReplayPage", "BTCUSDT", "SPOT", options,
      expect.objectContaining({ provider: "binance", signal: expect.any(AbortSignal) }),
    );
  });

  test("band-history dispatches through the replay reader with provider context; large replies are not retained in the route cache", async () => {
    const answer = { available: true, rowWidth: 4, rowLo: 20_000, rowHi: 20_010, columnMs: 10_000, columns: [], frames: 3, reason: null, stats: {} };
    const replayPageReader = { readAsync: jest.fn(async () => answer) };
    current = await server({ replayPageReader });
    const options = { fromTs: 0, toTs: 3_600_000, tickSize: 0.01, clusterTicks: 100, rowClusters: 4, priceLo: 80_000, priceHi: 80_040, columnMs: 10_000 };
    const first = await post(current.base, "band-history", validBody({ options }));
    expect(first).toMatchObject({ status: 200, body: { available: true, rowLo: 20_000, columns: [] } });
    expect(replayPageReader.readAsync).toHaveBeenCalledWith(
      "readBandHistory", "BTCUSDT", "SPOT", options,
      expect.objectContaining({ provider: "binance", signal: expect.any(AbortSignal) }),
    );
    const second = await post(current.base, "band-history", validBody({ options }));
    expect(second.status).toBe(200);
    expect(replayPageReader.readAsync).toHaveBeenCalledTimes(2);
    expect(current.reader.readAsync).not.toHaveBeenCalled();
  });

  test("band-history is bounded before a worker is admitted: rows, window, column width, price band, cells, unknown options", async () => {
    const replayPageReader = { readAsync: jest.fn(async () => ({ available: true, columns: [], reason: null })) };
    current = await server({ replayPageReader });
    const good = { fromTs: 0, toTs: 3_600_000, tickSize: 0.01, clusterTicks: 100, rowClusters: 4, priceLo: 80_000, priceHi: 80_040, columnMs: 10_000 };
    const cases = [
      [{ ...good, priceHi: 82_000 }, "BAND_ROWS_OUT_OF_RANGE:1..256"],
      [{ ...good, toTs: 3 * 3_600_000 }, "TIME_RANGE_OUT_OF_RANGE:fromTs/toTs"],
      [{ ...good, columnMs: 500 }, "COLUMN_MS_OUT_OF_RANGE"],
      [{ ...good, columnMs: 1_000, priceHi: 80_240, toTs: 7_200_000 }, "BAND_CELLS_OUT_OF_RANGE:100000"],
      [{ ...good, priceHi: 79_000 }, "PRICE_BAND_OUT_OF_RANGE"],
      [{ ...good, windowRows: 3 }, "UNKNOWN_OPTIONS:windowRows"],
      [{ ...good, rowClusters: 0 }, "ROWCLUSTERS_OUT_OF_RANGE"],
    ];
    for (const [options, detail] of cases) {
      const { status, body } = await post(current.base, "band-history", validBody({ options }));
      expect([status, body.detail]).toEqual([400, detail]);
    }
    expect(replayPageReader.readAsync).not.toHaveBeenCalled();
  });

  test("band-history without a replay reader is 503, and for provider dxfeed it goes to the replay reader with the dxfeed identity", async () => {
    current = await server();
    const { status, body } = await post(current.base, "band-history", validBody({ options: { fromTs: 0, toTs: 3_600_000, tickSize: 0.01, clusterTicks: 100, rowClusters: 4, priceLo: 80_000, priceHi: 80_040, columnMs: 10_000 } }));
    expect([status, body.detail]).toEqual([503, "REPLAY_NOT_CONFIGURED"]);
    current.server.close();
    const replayPageReader = { readAsync: jest.fn(async () => ({ available: true, columns: [], reason: null })) };
    const { reader: dxfeedReader } = fakeDxfeedStorageReader();
    current = await server({ replayPageReader, dxfeedStorageReader: dxfeedReader });
    const options = { fromTs: 0, toTs: 60_000, tickSize: 0.01, clusterTicks: 1, rowClusters: 1, priceLo: 150, priceHi: 150.1, columnMs: 10_000 };
    const dx = await post(current.base, "band-history", dxfeedValidBody({ options }));
    expect(dx.status).toBe(200);
    expect(replayPageReader.readAsync).toHaveBeenCalledWith("readBandHistory", "AAPL", "EQUITY", options, expect.objectContaining({ provider: "dxfeed" }));
  });

  test("replay geometry, cursors, and windows are bounded before a worker is admitted", async () => {
    const replayPageReader = { readAsync: jest.fn() };
    current = await server({ replayPageReader });
    const base = { fromTs: 1, toTs: 2, tickSize: 0.01, clusterTicks: 1, rowClusters: 2, windowRows: 3, cursor: null };
    for (const options of [
      { ...base, tickSize: 0 }, { ...base, clusterTicks: 0 }, { ...base, windowRows: 100_001 },
      { ...base, cursor: 4 }, { ...base, unexpected: true }, { ...base, bookMode: "tiny" },
    ]) {
      expect((await post(current.base, "replay-page", validBody({ options }))).status).toBe(400);
    }
    expect((await post(current.base, "replay-page", validBody({ options: { ...base, bookMode: "tiny" } }))).body)
      .toEqual({ error: "MALFORMED_REQUEST", detail: "BOOK_MODE_INVALID" });
    expect(replayPageReader.readAsync).not.toHaveBeenCalled();
  });

  test("every book mode the replay truncator knows is accepted by the route and passed through untouched", async () => {
    const { BOOK_MODES } = require("../../src/indicators/l2-memory/replay-truncate");
    const replayPageReader = {
      readAsync: jest.fn(async () => ({ frames: [], complete: true, nextCursor: null, stats: {} })),
    };
    current = await server({ replayPageReader });
    expect(BOOK_MODES).toEqual(["full", "sparse"]);
    for (const bookMode of BOOK_MODES) {
      const options = { fromTs: 1, toTs: 2, tickSize: 0.01, clusterTicks: 1, rowClusters: 2, windowRows: 3, cursor: null, bookMode };
      expect((await post(current.base, "replay-page", validBody({ options }))).status).toBe(200);
      expect(replayPageReader.readAsync).toHaveBeenCalledWith("readReplayPage", "BTCUSDT", "SPOT", options, expect.anything());
    }
  });

  test("an unknown route falls through (the server sees 404, not this route's own error)", async () => {
    current = await server();
    const { status } = await post(current.base, "not-a-route", validBody());
    expect(status).toBe(404);
  });

  test("a non-POST method is rejected", async () => {
    current = await server();
    const response = await fetch(`${current.base}${LIVE_STORAGE_PATH_PREFIX}recording-age`, {
      headers: { [SERVICE_SECRET_HEADER]: SECRET, [CLIENT_HEADER]: CLIENT },
    });
    expect(response.status).toBe(400);
  });

  test("a missing or wrong service secret is rejected before the body is even read", async () => {
    current = await server();
    expect((await post(current.base, "recording-age", validBody(), { secret: null })).status).toBe(401);
    expect((await post(current.base, "recording-age", validBody(), { secret: "wrong-secret-wrong-secret-wrong" })).status).toBe(401);
  });

  test("a missing or malformed client identity header is rejected", async () => {
    current = await server();
    expect((await post(current.base, "recording-age", validBody(), { client: null })).status).toBe(401);
    expect((await post(current.base, "recording-age", validBody(), { client: "has a space" })).status).toBe(401);
  });

  test("malformed bodies are rejected with 400, not a crash", async () => {
    current = await server();
    expect((await post(current.base, "recording-age", "not-json")).status).toBe(400);
    expect((await post(current.base, "recording-age", { symbol: "BTCUSDT" })).status).toBe(400);
    expect((await post(current.base, "recording-age", { symbol: 5, marketKind: "SPOT" })).status).toBe(400);
    expect((await post(current.base, "recording-age", { symbol: "BTCUSDT", marketKind: "SPOT", options: [] })).status).toBe(400);
    expect((await post(current.base, "recording-age", { symbol: "BTCUSDT", marketKind: "SPOT", extra: 1 })).status).toBe(400);
  });

  test("unbounded row and time-window requests are rejected before SQLite work", async () => {
    current = await server();
    expect((await post(current.base, "aggressive-prints", validBody({ options: { fromMs: 0, toMs: 1, limit: 20_001 } }))).status).toBe(400);
    expect((await post(current.base, "price-range", validBody({ options: { fromTs: 0, toTs: 9 * 24 * 60 * 60 * 1_000 } }))).status).toBe(400);
    expect((await post(current.base, "recent-trades", validBody({ options: { windowMs: 10_000, nowMs: 10_000 } }))).status).toBe(400);
    expect((await post(current.base, "recent-trades", validBody({ options: { windowMs: 10_000, nowMs: 10_000, limit: null } }))).status).toBe(400);
    expect(current.reader.readAggressivePrints).not.toHaveBeenCalled();
    expect(current.reader.readPriceRange).not.toHaveBeenCalled();
    expect(current.reader.readRecentTrades).not.toHaveBeenCalled();
  });

  // These are the actual real-world shapes market-data-server.js sends today --
  // caught live on a real deploy because the service's own ceilings, picked
  // without checking real usage, were tighter than what already-working code
  // has always legitimately asked for.
  test("large-trades' real shape (fromMs with no toMs, paired against nowMs; a 45k row limit) is accepted", async () => {
    current = await server();
    const options = { nowMs: 1_700_000_000_000, fromMs: 1_700_000_000_000 - 7 * 24 * 60 * 60 * 1_000, bucketMs: 3_600_000, perBucketSideLimit: 3, limit: 45_000 };
    const { status } = await post(current.base, "large-trades", validBody({ options }));
    expect(status).toBe(200);
    expect(current.reader.readLargeTrades).toHaveBeenCalledWith("BTCUSDT", "SPOT", options);
  });

  test("large-trades' simple top-N shape (no fromMs at all) is accepted", async () => {
    current = await server();
    const options = { nowMs: 1_700_000_000_000, limit: 45_000 };
    const { status } = await post(current.base, "large-trades", validBody({ options }));
    expect(status).toBe(200);
  });

  test("aggressive-prints' real 20k row limit is accepted", async () => {
    current = await server();
    const options = { fromMs: 0, toMs: 900_000, minSize: 0, limit: 20_000, cursor: null };
    const { status } = await post(current.base, "aggressive-prints", validBody({ options }));
    expect(status).toBe(200);
  });

  test("VPIN's real 21-day daily-notional calibration window is accepted", async () => {
    current = await server();
    const options = { fromTs: 0, toTs: 21 * 24 * 60 * 60 * 1_000 };
    const { status } = await post(current.base, "daily-notional", validBody({ options }));
    expect(status).toBe(200);
  });

  test("VPIN's 21-day minute-rollup fallback window is accepted", async () => {
    current = await server();
    const options = { fromTs: 0, toTs: 21 * 24 * 60 * 60 * 1_000, tickSize: 0.01 };
    const { status } = await post(current.base, "minute-rollup", validBody({ options }));
    expect(status).toBe(200);
  });

  test("larger ceilings are not accidentally applied to unrelated routes", async () => {
    current = await server();
    expect((await post(current.base, "recent-trades", validBody({ options: { limit: 5_001 } }))).status).toBe(400);
    expect((await post(current.base, "volume-profile", validBody({
      options: { fromTs: 0, toTs: 9 * 24 * 60 * 60 * 1_000, originPrice: 1, rowWidth: 1 },
    }))).status).toBe(400);
  });

  test("an unproven symbol or market kind is rejected with 400 rather than reaching the storage reader", async () => {
    current = await server();
    expect((await post(current.base, "recording-age", validBody({ symbol: "DOGEUSDT" }))).status).toBe(400);
    expect((await post(current.base, "recording-age", validBody({ marketKind: "FUTURE" }))).status).toBe(400);
    expect(current.reader.readRecordingAge).not.toHaveBeenCalled();
  });

  test("validatePayload defaults provider to binance and requires the matching identity field", () => {
    expect(validatePayload({ symbol: "BTCUSDT", marketKind: "SPOT" })).toBeNull();
    expect(validatePayload({ symbol: "BTCUSDT", provider: "binance", marketKind: "SPOT" })).toBeNull();
    expect(validatePayload({ symbol: "AAPL", provider: "dxfeed", assetClass: "EQUITY" })).toBeNull();
    expect(validatePayload({ symbol: "AAPL", provider: "dxfeed", marketKind: "SPOT" })).not.toBeNull();
    expect(validatePayload({ symbol: "BTCUSDT", provider: "dxfeed" })).not.toBeNull();
    expect(validatePayload({ symbol: "BTCUSDT", provider: "other", marketKind: "SPOT" })).toBe("PROVIDER_NOT_RECOGNIZED");
  });

  test("a dxfeed-provider request dispatches through the real readAsync path to the configured dxfeedStorageReader, not the binance one", async () => {
    const { reader: dxfeedReader } = fakeDxfeedStorageReader();
    current = await server({ dxfeedStorageReader: dxfeedReader });
    const { status } = await post(current.base, "daily-notional", dxfeedValidBody({ options: { fromTs: 0, toTs: 3_600_000 } }));
    expect(status).toBe(200);
    expect(dxfeedReader.readDailyNotional).toHaveBeenCalledWith("AAPL", "EQUITY", { fromTs: 0, toTs: 3_600_000 });
    expect(current.reader.readDailyNotional).not.toHaveBeenCalled();
  });

  test("dxfeed recent-events admits only catalog event types and dispatches through the worker contract", async () => {
    const { reader: dxfeedReader } = fakeDxfeedStorageReader();
    current = await server({ dxfeedStorageReader: dxfeedReader });
    const validOptions = { eventType: "TIMEANDSALE", limit: 100 };
    const accepted = await post(current.base, "recent-events", dxfeedValidBody({ options: validOptions }));
    expect(accepted.status).toBe(200);
    expect(dxfeedReader.readAsync).toHaveBeenCalledWith(
      "readRecent", "AAPL", "EQUITY", validOptions, expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const rejected = await post(current.base, "recent-events", dxfeedValidBody({ options: { eventType: "dxfeed_time_and_sales", limit: 100 } }));
    expect(rejected.status).toBe(400);
    expect(rejected.body).toEqual({ error: "MALFORMED_REQUEST", detail: "Unproven dxFeed eventType" });
    expect(dxfeedReader.readAsync).toHaveBeenCalledTimes(1);
    const unsupportedOrder = await post(current.base, "recent-events", dxfeedValidBody({ options: { eventType: "ORDER", limit: 100 } }));
    expect(unsupportedOrder.status).toBe(400);
    expect(dxfeedReader.readAsync).toHaveBeenCalledTimes(1);
  });

  test("the dxfeed-only recent-events route is rejected for Binance", async () => {
    current = await server();
    const result = await post(current.base, "recent-events", validBody({ options: { eventType: "TIMEANDSALE", limit: 100 } }));
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "MALFORMED_REQUEST", detail: "ROUTE_NOT_AVAILABLE_FOR_PROVIDER" });
  });

  test("dxfeed recent-events retains the route row ceiling", async () => {
    const { reader: dxfeedReader } = fakeDxfeedStorageReader();
    current = await server({ dxfeedStorageReader: dxfeedReader });
    const result = await post(current.base, "recent-events", dxfeedValidBody({
      options: { eventType: "TIMEANDSALE", limit: 5_001 },
    }));
    expect(result.status).toBe(400);
    expect(dxfeedReader.readAsync).not.toHaveBeenCalled();
  });

  test("dxfeed recent-events rejects unknown query options rather than becoming a generic storage surface", async () => {
    const { reader: dxfeedReader } = fakeDxfeedStorageReader();
    current = await server({ dxfeedStorageReader: dxfeedReader });
    const result = await post(current.base, "recent-events", dxfeedValidBody({
      options: { eventType: "TIMEANDSALE", limit: 100, table: "dxfeed_time_and_sales" },
    }));
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "MALFORMED_REQUEST", detail: "UNKNOWN_OPTIONS:table" });
    expect(dxfeedReader.readAsync).not.toHaveBeenCalled();
  });

  test("dxfeed trades-since dispatches through readAsync with the cursor/fromTs/toTs/limit shape VPIN's warmup worker sends", async () => {
    const { reader: dxfeedReader } = fakeDxfeedStorageReader();
    current = await server({ dxfeedStorageReader: dxfeedReader });
    const options = { fromTs: 0, toTs: 3_600_000, cursor: null, limit: 100 };
    const first = await post(current.base, "trades-since", dxfeedValidBody({ options }));
    expect(first.status).toBe(200);
    expect(dxfeedReader.readAsync).toHaveBeenCalledWith(
      "readTradesSince", "AAPL", "EQUITY", options, expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const paged = { fromTs: 0, toTs: 3_600_000, cursor: { ts: 1_000, id: 7 }, limit: 100 };
    const second = await post(current.base, "trades-since", dxfeedValidBody({ options: paged }));
    expect(second.status).toBe(200);
    expect(dxfeedReader.readAsync).toHaveBeenCalledWith(
      "readTradesSince", "AAPL", "EQUITY", paged, expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  test("the dxfeed-only trades-since route is rejected for Binance", async () => {
    current = await server();
    const result = await post(current.base, "trades-since", validBody({ options: { fromTs: 0, toTs: 1, limit: 100 } }));
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "MALFORMED_REQUEST", detail: "ROUTE_NOT_AVAILABLE_FOR_PROVIDER" });
  });

  test("trades-since bounds the requested window and limit before a worker is admitted", async () => {
    const { reader: dxfeedReader } = fakeDxfeedStorageReader();
    current = await server({ dxfeedStorageReader: dxfeedReader });
    for (const options of [
      { fromTs: 0, toTs: 9 * 24 * 60 * 60 * 1_000, cursor: null, limit: 100 },
      { fromTs: 0, toTs: 1, cursor: null, limit: 5_001 },
    ]) {
      expect((await post(current.base, "trades-since", dxfeedValidBody({ options }))).status).toBe(400);
    }
    expect(dxfeedReader.readAsync).not.toHaveBeenCalled();
  });

  test("a dxfeed-provider request is 503 when no dxfeedStorageReader is configured", async () => {
    current = await server();
    const { status, body } = await post(current.base, "daily-notional", dxfeedValidBody({ options: { fromTs: 0, toTs: 1 } }));
    expect(status).toBe(503);
    expect(body).toEqual({ error: "SERVICE_UNAVAILABLE", detail: "DXFEED_NOT_CONFIGURED" });
  });

  test("a binance-only route is rejected for provider: dxfeed even though the route itself exists", async () => {
    const { reader: dxfeedReader } = fakeDxfeedStorageReader();
    current = await server({ dxfeedStorageReader: dxfeedReader });
    const { status, body } = await post(current.base, "recent-trades", dxfeedValidBody({ options: { limit: 5 } }));
    expect(status).toBe(400);
    expect(body).toEqual({ error: "MALFORMED_REQUEST", detail: "ROUTE_NOT_AVAILABLE_FOR_PROVIDER" });
  });

  test("an unproven dxfeed symbol/assetClass pair is rejected with 400 rather than reaching the dxfeed reader", async () => {
    const { reader: dxfeedReader } = fakeDxfeedStorageReader();
    current = await server({ dxfeedStorageReader: dxfeedReader });
    expect((await post(current.base, "daily-notional", dxfeedValidBody({ symbol: "NOTREAL" }))).status).toBe(400);
    expect((await post(current.base, "daily-notional", dxfeedValidBody({ assetClass: "CRYPTO" }))).status).toBe(400);
    expect(dxfeedReader.readDailyNotional).not.toHaveBeenCalled();
  });

  test("a storage-reader method throwing on bad options becomes 400, not an unhandled crash", async () => {
    const { reader } = fakeStorageReader({
      readRecentCandles: jest.fn(() => { throw new Error("storage-reader: intervalMs must match the stored one-minute candle interval"); }),
    });
    current = await server({ storageReader: reader });
    const { status, body } = await post(current.base, "recent-candles", validBody({ options: { intervalMs: 5_000, windowMs: 60_000, nowMs: 1 } }));
    expect(status).toBe(400);
    expect(body.error).toBe("MALFORMED_REQUEST");
  });

  test("a dxfeed-storage-reader method throwing on bad options becomes 400 too, not a false 503 -- its error prefix differs from binance's", async () => {
    const { reader: dxfeedReader } = fakeDxfeedStorageReader({
      readAggressivePrints: jest.fn(() => { throw new Error("dxfeed-storage-reader: cursor must contain a row id and timestamp inside the requested window"); }),
    });
    current = await server({ dxfeedStorageReader: dxfeedReader });
    const { status, body } = await post(current.base, "aggressive-prints", dxfeedValidBody({ options: { fromMs: 0, toMs: 1, minSize: 0, limit: 5, cursor: { ts: 0, id: -1 } } }));
    expect(status).toBe(400);
    expect(body.error).toBe("MALFORMED_REQUEST");
  });

  test("a rate-limited client is rejected with 429 and a retry hint", async () => {
    current = await server({ rateLimit: { max: 1, windowMs: 60_000 } });
    expect((await post(current.base, "recording-age", validBody())).status).toBe(200);
    const second = await post(current.base, "recording-age", validBody());
    expect(second.status).toBe(429);
    expect(second.body.retryAfterMs).toBeGreaterThan(0);
    expect(second.headers.get("retry-after")).toBe(String(Math.ceil(second.body.retryAfterMs / 1_000)));
  });

  test("dispose stops accepting new requests with 503", async () => {
    current = await server();
    current.route.dispose();
    const { status, body } = await post(current.base, "recording-age", validBody());
    expect(status).toBe(503);
    expect(body.error).toBe("SERVICE_UNAVAILABLE");
  });

  test("two concurrent requests in the same coalesce bucket share one real read", async () => {
    let resolveFirst;
    const gate = new Promise((resolve) => { resolveFirst = resolve; });
    let signalCalled;
    const called = new Promise((resolve) => { signalCalled = resolve; });
    const { reader } = fakeStorageReader({
      readRecordingAge: jest.fn(async () => { signalCalled(); await gate; return { latestTs: 1, ageMs: 1, available: true }; }),
    });
    current = await server({ storageReader: reader });
    const options = { nowMs: 1_700_000_000_123 };
    const first = post(current.base, "recording-age", validBody({ options }));
    await called;
    const second = post(current.base, "recording-age", validBody({ options: { nowMs: 1_700_000_000_456 } }));
    // Give the second request's real loopback round trip time to actually reach
    // this route's own coalescing check before the gate opens -- otherwise the
    // first read can settle (and remove itself from the in-flight map) before
    // the second request ever gets a chance to find it there.
    await new Promise((resolve) => setTimeout(resolve, 100));
    resolveFirst();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.status).toBe(200);
    expect(secondResult.status).toBe(200);
    expect(reader.readRecordingAge).toHaveBeenCalledTimes(1);
  });

  test("two sequential requests (first already settled) each trigger their own real read", async () => {
    current = await server();
    await post(current.base, "recording-age", validBody());
    await post(current.base, "recording-age", validBody());
    expect(current.reader.readRecordingAge).toHaveBeenCalledTimes(2);
  });

  test("the configured bucket controls coalescing and nested cursor identity is preserved", () => {
    const first = coalesceKey("aggressive-prints", "BTCUSDT", "SPOT", { nowMs: 1_234, cursor: { ts: 10, id: 1 } }, 100);
    const sameBucket = coalesceKey("aggressive-prints", "BTCUSDT", "SPOT", { cursor: { id: 1, ts: 10 }, nowMs: 1_299 }, 100);
    const nextBucket = coalesceKey("aggressive-prints", "BTCUSDT", "SPOT", { nowMs: 1_300, cursor: { ts: 10, id: 1 } }, 100);
    const nextCursor = coalesceKey("aggressive-prints", "BTCUSDT", "SPOT", { nowMs: 1_234, cursor: { ts: 10, id: 2 } }, 100);
    const firstRange = coalesceKey("aggressive-prints", "BTCUSDT", "SPOT", { fromMs: 1_234, toMs: 2_234 }, 100);
    const shiftedRange = coalesceKey("aggressive-prints", "BTCUSDT", "SPOT", { fromMs: 1_235, toMs: 2_234 }, 100);
    expect(first).toBe(sameBucket);
    expect(first).not.toBe(nextBucket);
    expect(first).not.toBe(nextCursor);
    expect(firstRange).not.toBe(shiftedRange);
  });

  test("coalesceKey isolates otherwise-identical requests by provider, defaulting to binance", () => {
    const binanceKey = coalesceKey("daily-notional", "BTCUSDT", "SPOT", { fromTs: 0, toTs: 1 }, 100);
    const explicitBinanceKey = coalesceKey("daily-notional", "BTCUSDT", "SPOT", { fromTs: 0, toTs: 1 }, 100, "binance");
    const dxfeedKey = coalesceKey("daily-notional", "BTCUSDT", "SPOT", { fromTs: 0, toTs: 1 }, 100, "dxfeed");
    expect(binanceKey).toBe(explicitBinanceKey);
    expect(binanceKey).not.toBe(dxfeedKey);
  });

  test("distinct work is concurrency bounded while an identical request still coalesces", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { reader } = fakeStorageReader({ readRecordingAge: jest.fn(async () => { await gate; return { available: true }; }) });
    current = await server({ storageReader: reader, maxConcurrentQueries: 1 });
    const first = post(current.base, "recording-age", validBody({ options: { nowMs: 1_000 } }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const duplicate = post(current.base, "recording-age", validBody({ options: { nowMs: 1_001 } }));
    const rejected = await post(current.base, "recording-age", validBody({ options: { nowMs: 2_000 } }));
    release();
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    expect(rejected.status).toBe(429);
    expect(rejected.body.error).toBe("OVERLOADED");
    expect(firstResult.status).toBe(200);
    expect(duplicateResult.status).toBe(200);
    expect(reader.readRecordingAge).toHaveBeenCalledTimes(1);
  });

  test("a query deadline aborts the underlying asynchronous read and returns 503", async () => {
    let capturedSignal;
    const readAsync = jest.fn((_method, _symbol, _marketKind, _options, { signal }) => new Promise((_resolve, reject) => {
      capturedSignal = signal;
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    current = await server({ storageReader: { readAsync }, queryTimeoutMs: 25 });
    const result = await post(current.base, "recording-age", validBody({ options: { nowMs: 1 } }));
    expect(result.status).toBe(503);
    expect(result.body.error).toBe("SERVICE_UNAVAILABLE");
    expect(capturedSignal.aborted).toBe(true);
    expect(current.route.stats().inFlight).toBe(0);
    expect(current.route.stats().telemetry.routes["recording-age"].failureReasons).toEqual({ route_timeout: 1 });
  });

  // Property: sliced-notional is a slow aggregate like the two calibration
  // routes -- the remote VPIN warm-up reads 28 six-hour aggregates through it
  // -- so it keeps the long query deadline and its result is cached for a
  // repeat of the same window. Oracle: a short default deadline that a
  // 60 ms read would otherwise trip, and the reader's call count.
  test("sliced-notional keeps the slow-aggregate deadline and caches a repeated window", async () => {
    const { reader } = fakeStorageReader({
      readSlicedNotional: jest.fn(() => new Promise((resolve) => setTimeout(() => resolve({ rows: [{ sliceTs: 5, buyNotional: 1, sellNotional: 2 }], available: true }), 60))),
    });
    current = await server({ storageReader: reader, queryTimeoutMs: 25 });
    const options = { fromTs: 0, toTs: 21_600_000, sliceMs: 2_000 };
    const first = await post(current.base, "sliced-notional", validBody({ options }));
    expect(first.status).toBe(200);
    expect(first.body.rows).toHaveLength(1);
    const second = await post(current.base, "sliced-notional", validBody({ options }));
    expect(second.body).toEqual(first.body);
    expect(reader.readSlicedNotional).toHaveBeenCalledTimes(1);
    expect(current.route.stats().cached).toBe(1);
  });

  test("a replay reader deadline is separately classified and logged with its correlation ID", async () => {
    const log = jest.fn();
    const error = Object.assign(new Error("replay-page-reader: timeout"), {
      code: "SERVICE_UNAVAILABLE", telemetryReason: "reader_timeout",
    });
    current = await server({ replayPageReader: { readAsync: jest.fn(async () => { throw error; }) }, log });
    const result = await post(current.base, "replay-page", validBody({ options: {
      fromTs: 0, toTs: 1, tickSize: 1, clusterTicks: 1, rowClusters: 1, windowRows: 1, cursor: null,
    } }), { headers: { [CORRELATION_ID_HEADER]: "replay-timeout-1" } });
    expect(result).toMatchObject({ status: 503, body: { error: "SERVICE_UNAVAILABLE", detail: "replay-page-reader: timeout" } });
    expect(current.route.stats().telemetry.routes["replay-page"].failureReasons).toEqual({ reader_timeout: 1 });
    expect(log).toHaveBeenCalledWith("live-storage-route: service unavailable", "replay-page", "replay-timeout-1",
      "reader_timeout", "replay-page-reader: timeout");
  });

  // VPIN's 21-day daily-notional calibration read takes ~25s against the real
  // host database -- confirmed live, not assumed. No timeout number alone
  // fixes that, so daily-notional/minute-rollup get a per-hour result cache
  // plus their own extended deadline, both scoped away from every other
  // route.
  test("a cache hit answers without a second real read, for a request separated in time (not concurrent)", async () => {
    const { reader } = fakeStorageReader();
    current = await server({ storageReader: reader });
    const options = { fromTs: 0, toTs: 3_600_000 };
    const first = await post(current.base, "daily-notional", validBody({ options }));
    const second = await post(current.base, "daily-notional", validBody({ options }));
    expect(first.body).toEqual(second.body);
    expect(reader.readDailyNotional).toHaveBeenCalledTimes(1);
    expect(current.route.stats().cached).toBe(1);
  });

  // Property: a slow-route request is served for exactly the window it
  // asked for. Oracle: the options the storage reader receives. The route
  // used to floor toTs to the hour and shift fromTs with it, so a minute
  // window ending at 14:22 was answered with 13:22's rows and the VP cache
  // refused every pre-warm chunk over the gateway (seen live 2026-09-20).
  test("minute-rollup and daily-notional windows off the hour reach the reader unshifted", async () => {
    const { reader } = fakeStorageReader();
    current = await server({ storageReader: reader });
    const hour = 60 * 60 * 1_000;
    const rollup = { fromTs: 14 * hour + 7 * 60_000, toTs: 14 * hour + 22 * 60_000, tickSize: 0.5 };
    const daily = { fromTs: 3 * hour + 1, toTs: 27 * hour + 299_999 };
    expect((await post(current.base, "minute-rollup", validBody({ options: rollup }))).status).toBe(200);
    expect((await post(current.base, "daily-notional", validBody({ options: daily }))).status).toBe(200);
    expect(reader.readMinuteRollup).toHaveBeenCalledWith("BTCUSDT", "SPOT", rollup);
    expect(reader.readDailyNotional).toHaveBeenCalledWith("BTCUSDT", "SPOT", daily);
  });

  test("requests whose window falls in a different cache bucket are not conflated", async () => {
    const { reader } = fakeStorageReader();
    current = await server({ storageReader: reader });
    const hour = 60 * 60 * 1_000;
    await post(current.base, "daily-notional", validBody({ options: { fromTs: 0, toTs: hour } }));
    await post(current.base, "daily-notional", validBody({ options: { fromTs: 0, toTs: 2 * hour } }));
    expect(reader.readDailyNotional).toHaveBeenCalledTimes(2);
  });

  test("minute-rollup cache entries are isolated by tickSize, not only by time range", async () => {
    current = await server();
    const window = { fromTs: 0, toTs: 3_600_000 };
    expect((await post(current.base, "minute-rollup", validBody({ options: { ...window, tickSize: 0.5 } }))).status).toBe(200);
    expect((await post(current.base, "minute-rollup", validBody({ options: { ...window, tickSize: 1 } }))).status).toBe(200);
    expect(current.reader.readMinuteRollup).toHaveBeenCalledTimes(2);
  });

  test("concurrent cache-miss requests for the same bucket still coalesce into one real read", async () => {
    let resolveFirst;
    const gate = new Promise((resolve) => { resolveFirst = resolve; });
    let signalCalled;
    const called = new Promise((resolve) => { signalCalled = resolve; });
    const { reader } = fakeStorageReader({
      readDailyNotional: jest.fn(async () => { signalCalled(); await gate; return { rows: [], available: true }; }),
    });
    current = await server({ storageReader: reader });
    const options = { fromTs: 0, toTs: 3_600_000 };
    const first = post(current.base, "daily-notional", validBody({ options }));
    await called;
    const second = post(current.base, "daily-notional", validBody({ options }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    resolveFirst();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.status).toBe(200);
    expect(secondResult.status).toBe(200);
    expect(reader.readDailyNotional).toHaveBeenCalledTimes(1);
  });

  test("a failed or unavailable result is never cached, so the next request retries for real", async () => {
    let callCount = 0;
    const { reader } = fakeStorageReader({
      readDailyNotional: jest.fn(() => {
        callCount += 1;
        return callCount === 1 ? { rows: [], available: false } : { rows: [], available: true };
      }),
    });
    current = await server({ storageReader: reader });
    const options = { fromTs: 0, toTs: 3_600_000 };
    const first = await post(current.base, "daily-notional", validBody({ options }));
    expect(first.body.available).toBe(false);
    const second = await post(current.base, "daily-notional", validBody({ options }));
    expect(second.body.available).toBe(true);
    expect(reader.readDailyNotional).toHaveBeenCalledTimes(2);
  });

  test("the extended query deadline is scoped to the slow aggregate routes only", async () => {
    const readAsync = jest.fn((method) => new Promise((resolve) => {
      setTimeout(() => resolve(method === "readDailyNotional" ? { rows: [], available: true } : { latestTs: 1, ageMs: 1, available: true }), 60);
    }));
    current = await server({ storageReader: { readAsync }, queryTimeoutMs: 25 });
    const fast = await post(current.base, "recording-age", validBody({ options: { nowMs: 1 } }));
    expect(fast.status).toBe(503);
    const slow = await post(current.base, "daily-notional", validBody({ options: { fromTs: 0, toTs: 3_600_000 } }));
    expect(slow.status).toBe(200);
  });

  test("the result cache is bounded and evicts the oldest entry rather than growing unboundedly", async () => {
    const { reader } = fakeStorageReader();
    current = await server({ storageReader: reader, maxCacheEntries: 2 });
    const hour = 60 * 60 * 1_000;
    await post(current.base, "daily-notional", validBody({ options: { fromTs: 0, toTs: hour } }));
    await post(current.base, "daily-notional", validBody({ options: { fromTs: 0, toTs: 2 * hour } }));
    await post(current.base, "daily-notional", validBody({ options: { fromTs: 0, toTs: 3 * hour } }));
    expect(reader.readDailyNotional).toHaveBeenCalledTimes(3);
    await post(current.base, "daily-notional", validBody({ options: { fromTs: 0, toTs: hour } }));
    expect(reader.readDailyNotional).toHaveBeenCalledTimes(4);
  });

  test("a slow-route cache entry expires after its TTL, so a storage correction is not served forever", async () => {
    const { reader } = fakeStorageReader();
    let clock = 0;
    current = await server({ storageReader: reader, slowCacheTtlMs: 1_000, now: () => clock });
    const options = { fromTs: 0, toTs: 3_600_000 };
    await post(current.base, "daily-notional", validBody({ options }));
    clock = 999;
    await post(current.base, "daily-notional", validBody({ options }));
    expect(reader.readDailyNotional).toHaveBeenCalledTimes(1);
    clock = 1_000;
    await post(current.base, "daily-notional", validBody({ options }));
    expect(reader.readDailyNotional).toHaveBeenCalledTimes(2);
  });

  test("cache eviction is least-recently-used: re-reading an entry protects it from eviction", async () => {
    const { reader } = fakeStorageReader();
    current = await server({ storageReader: reader, maxCacheEntries: 2 });
    const hour = 60 * 60 * 1_000;
    const first = { fromTs: 0, toTs: hour };
    const second = { fromTs: 0, toTs: 2 * hour };
    const third = { fromTs: 0, toTs: 3 * hour };
    await post(current.base, "daily-notional", validBody({ options: first }));
    await post(current.base, "daily-notional", validBody({ options: second }));
    // Touch `first` again before inserting a third entry, so it is now the
    // most-recently-used and `second` -- not `first` -- is the one evicted.
    await post(current.base, "daily-notional", validBody({ options: first }));
    await post(current.base, "daily-notional", validBody({ options: third }));
    expect(reader.readDailyNotional).toHaveBeenCalledTimes(3);
    await post(current.base, "daily-notional", validBody({ options: first }));
    expect(reader.readDailyNotional).toHaveBeenCalledTimes(3);
    await post(current.base, "daily-notional", validBody({ options: second }));
    expect(reader.readDailyNotional).toHaveBeenCalledTimes(4);
  });
});

describe("server/live-storage-route heatmap-columns (P4c.3)", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { openPyramidStore } = require("../../src/indicators/l2-memory/pyramid/pyramid-store");
  const { createPyramidReader } = require("../../src/indicators/l2-memory/pyramid/pyramid-reader");
  const { WINDOW_MS, foldLevels, decodeWindow } = require("../../src/indicators/l2-memory/pyramid/pyramid-levels");
  const W0 = Math.floor(1_700_000_000_000 / WINDOW_MS) * WINDOW_MS;
  const GEOMETRY = { tickSize: 0.1, clusterTicks: 5, clusterWidth: 0.5, rowClusters: 6, rowWidth: 3, windowRows: 1023, sizeDigits: 4, snapshotDepth: 1000, columnMs: 1_000, replayWarmupMs: 30 * 60_000, rowBp: 0.5, windowBp: 600, referenceBp: 50 };
  let current = null;
  let dir = null;

  function base(ts) {
    return Array.from({ length: 30 }, (_, i) => Object.freeze({
      ts: ts + i * 10_000, lo: 100, hi: 103,
      bid: Float64Array.from([1, 2, 3, i]), ask: Float64Array.from([4, 0, 1, 2]),
      buy: [[1, 0.5]], sell: [], prints: [{ ts: ts + i * 10_000, price: 301, size: 0.5, side: "buy", id: `p${i}` }], printsFloor: 0.25,
    }));
  }

  function seed(pairKey, windows) {
    const store = openPyramidStore({ dir, pairKey });
    store.pin(GEOMETRY);
    for (let w = 0; w < windows; w += 1) store.putWindow({ windowTs: W0 + w * WINDOW_MS, state: "COVERED", columns: 30, frames: 50, builtAt: 1, levels: foldLevels(base(W0 + w * WINDOW_MS)) });
    store.close();
  }

  function heatmapBody(options, overrides = {}) {
    return { symbol: "BTCUSDT", marketKind: "PERPETUAL", options: { levelMs: 30_000, fromTs: W0, toTs: W0 + 3 * WINDOW_MS, ...options }, ...overrides };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "heatmap-route-"));
  });

  afterEach(async () => {
    if (current) {
      current.route.dispose();
      await close(current.server);
      current = null;
    }
  });

  test("without a pyramid reader the route says it is not configured", async () => {
    current = await server();
    const response = await post(current.base, "heatmap-columns", heatmapBody());
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "SERVICE_UNAVAILABLE", detail: "HEATMAP_NOT_CONFIGURED" });
  });

  test("refuses a level off the pyramid, a span over eight days, an unknown option and a row factor that is not a power of two", async () => {
    current = await server({ heatmapReader: createPyramidReader({ dir }) });
    const refusals = await Promise.all([
      post(current.base, "heatmap-columns", heatmapBody({ levelMs: 1_000 })),
      post(current.base, "heatmap-columns", heatmapBody({ toTs: W0 + 9 * 86_400_000 })),
      post(current.base, "heatmap-columns", heatmapBody({ toTs: W0 })),
      post(current.base, "heatmap-columns", heatmapBody({ cursor: "x" })),
      post(current.base, "heatmap-columns", heatmapBody({ rowFactor: 3 })),
    ]);
    expect(refusals.map((r) => [r.status, r.body.detail])).toEqual([
      [400, "LEVEL_NOT_A_PYRAMID_LEVEL"],
      [400, "TIME_RANGE_OUT_OF_RANGE:fromTs/toTs"],
      [400, "TIME_RANGE_OUT_OF_RANGE:fromTs/toTs"],
      [400, "UNKNOWN_OPTIONS:cursor"],
      [400, "ROW_FACTOR_OUT_OF_RANGE"],
    ]);
  });

  test("a pair with no pyramid answers unavailable, not an error", async () => {
    current = await server({ heatmapReader: createPyramidReader({ dir }) });
    const response = await post(current.base, "heatmap-columns", heatmapBody());
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ available: false, reason: "NO_PYRAMID" });
  });

  test("pages a pair's windows with its pinned geometry, oldest first, and hands the next window when the byte budget ends a page", async () => {
    seed("binance:PERPETUAL:BTCUSDT", 3);
    const oneWindow = JSON.stringify(require("../../src/indicators/l2-memory/pyramid/pyramid-levels").encodeWindow(foldLevels(base(W0)).get(30_000))).length;
    current = await server({ heatmapReader: createPyramidReader({ dir, pageBytes: oneWindow * 2 }) });
    const first = await post(current.base, "heatmap-columns", heatmapBody());
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ available: true, levelMs: 30_000, rowFactor: 1, geometry: { rowWidth: 3, rowClusters: 6 }, span: { oldest: W0, newest: W0 + 2 * WINDOW_MS }, next: W0 + 2 * WINDOW_MS });
    expect(first.body.windows.map((w) => [w.ts, w.state, w.columns.length])).toEqual([[W0, "COVERED", 10], [W0 + WINDOW_MS, "COVERED", 10]]);
    expect(Array.from(decodeWindow(first.body.windows[0].columns)[2].bid)).toEqual([1, 2, 3, 8]);
    const rest = await post(current.base, "heatmap-columns", heatmapBody({ fromTs: first.body.next }));
    expect(rest.body.windows.map((w) => w.ts)).toEqual([W0 + 2 * WINDOW_MS]);
    expect(rest.body.next).toBeNull();
  });

  test("a row factor sums rows into wider ones, keeps the prints, and says the rows are wider", async () => {
    seed("binance:PERPETUAL:BTCUSDT", 1);
    current = await server({ heatmapReader: createPyramidReader({ dir }) });
    const response = await post(current.base, "heatmap-columns", heatmapBody({ levelMs: 300_000, rowFactor: 2 }));
    expect(response.body.geometry).toMatchObject({ rowWidth: 6, rowClusters: 12 });
    const [five] = decodeWindow(response.body.windows[0].columns);
    expect([five.lo, five.hi, Array.from(five.bid), Array.from(five.ask)]).toEqual([50, 51, [3, 32], [4, 3]]);
    expect(five.buy).toEqual([[0, 15]]);
    expect(five.prints).toHaveLength(30);
  });

  test("serves dxFeed pairs from their own store, and refuses a dxFeed symbol the catalog does not prove", async () => {
    seed("dxfeed:FUTURE:/NQZ26:XCME", 1);
    current = await server({ heatmapReader: createPyramidReader({ dir }), dxfeedStorageReader: null });
    const served = await post(current.base, "heatmap-columns", heatmapBody({}, { symbol: "/NQZ26:XCME", provider: "dxfeed", assetClass: "FUTURE", marketKind: undefined }));
    expect(served.status).toBe(200);
    expect(served.body.windows).toHaveLength(1);
    const refused = await post(current.base, "heatmap-columns", heatmapBody({}, { symbol: "/ZZZ:XCME", provider: "dxfeed", assetClass: "FUTURE", marketKind: undefined }));
    expect(refused.status).toBe(400);
  });
});

describe("server/live-storage-route wall-history and event-history (P4e3 step 3)", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { openPyramidStore } = require("../../src/indicators/l2-memory/pyramid/pyramid-store");
  const { createPyramidReader } = require("../../src/indicators/l2-memory/pyramid/pyramid-reader");
  const { WINDOW_MS, foldLevels } = require("../../src/indicators/l2-memory/pyramid/pyramid-levels");
  const W0 = Math.floor(1_700_000_000_000 / WINDOW_MS) * WINDOW_MS;
  const GEOMETRY = { tickSize: 0.1, clusterTicks: 5, clusterWidth: 0.5, rowClusters: 6, rowWidth: 3, windowRows: 1023, sizeDigits: 4, snapshotDepth: 1000, columnMs: 1_000, replayWarmupMs: 30 * 60_000, rowBp: 0.5, windowBp: 600, referenceBp: 50, pinnedPrice: 300 };
  const wall = (side, row, startTs, endTs) => ({ side, row, span: 1, startTs, endTs, size: 0, peak: 5, endedBy: "hit", ratio: 2, chain: 0, fill: 0.5, eaten: 0.2, absorbing: false });
  const eventsOf = (windowTs, trades) => ({ version: 1, columnMs: 1_000, deepColumnMs: 10_000, fill: { from: windowTs, until: windowTs + WINDOW_MS }, trades, wallTrades: [] });
  const WALLS = [wall("bid", 10, W0 - 5_000, W0 + 20_000), wall("ask", 12, W0 + 1_000, W0 + 40_000), wall("bid", 11, W0 + WINDOW_MS, W0 + WINDOW_MS + 5_000)];
  const bare = (walls) => walls.map((entry) => {
    expect(Number.isSafeInteger(entry.id) && entry.id > 0).toBe(true);
    const copy = { ...entry };
    delete copy.id;
    return copy;
  });
  let current = null;
  let dir = null;

  function seed(pairKey, { pin = true } = {}) {
    const store = openPyramidStore({ dir, pairKey });
    if (pin) store.pin(GEOMETRY);
    for (let w = 0; w < 2; w += 1) {
      const windowTs = W0 + w * WINDOW_MS;
      store.putWindow({ windowTs, state: "COVERED", columns: 30, frames: 50, builtAt: 1, levels: foldLevels([]), walls: WALLS.filter((entry) => entry.endTs >= windowTs && entry.endTs < windowTs + WINDOW_MS), events: eventsOf(windowTs, [[windowTs, 10_000, 10 + w, "buy", "absorbed", 2, 1]]) });
    }
    store.close();
  }

  function body(route, options, overrides = {}) {
    return { symbol: "BTCUSDT", marketKind: "PERPETUAL", options: { fromTs: W0, toTs: W0 + 3 * WINDOW_MS, ...options }, ...overrides };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-route-"));
  });

  afterEach(async () => {
    if (current) {
      current.route.dispose();
      await close(current.server);
      current = null;
    }
  });

  test("without a pyramid reader both routes say the heatmap is not configured", async () => {
    current = await server();
    for (const route of ["wall-history", "event-history"]) {
      const response = await post(current.base, route, body(route, {}));
      expect([route, response.status, response.body]).toEqual([route, 503, { error: "SERVICE_UNAVAILABLE", detail: "HEATMAP_NOT_CONFIGURED" }]);
    }
  });

  test("refuses a span over eight days or ending before it starts, an unknown option, a page limit off the range and a cursor that is not { endTs, id }", async () => {
    current = await server({ heatmapReader: createPyramidReader({ dir }) });
    const refusals = await Promise.all([
      post(current.base, "wall-history", body("wall-history", { toTs: W0 + 9 * 86_400_000 })),
      post(current.base, "wall-history", body("wall-history", { toTs: W0 })),
      post(current.base, "wall-history", body("wall-history", { levelMs: 30_000 })),
      post(current.base, "wall-history", body("wall-history", { limit: 0 })),
      post(current.base, "wall-history", body("wall-history", { limit: 401 })),
      post(current.base, "wall-history", body("wall-history", { after: { endTs: W0 } })),
      post(current.base, "wall-history", body("wall-history", { after: "x" })),
      post(current.base, "event-history", body("event-history", { limit: 10 })),
      post(current.base, "event-history", body("event-history", { toTs: W0 - 1 })),
    ]);
    expect(refusals.map((r) => [r.status, r.body.detail])).toEqual([
      [400, "TIME_RANGE_OUT_OF_RANGE:fromTs/toTs"],
      [400, "TIME_RANGE_OUT_OF_RANGE:fromTs/toTs"],
      [400, "UNKNOWN_OPTIONS:levelMs"],
      [400, "LIMIT_OUT_OF_RANGE:1..400"],
      [400, "LIMIT_OUT_OF_RANGE:1..400"],
      [400, "CURSOR_INVALID"],
      [400, "CURSOR_INVALID"],
      [400, "UNKNOWN_OPTIONS:limit"],
      [400, "TIME_RANGE_OUT_OF_RANGE:fromTs/toTs"],
    ]);
  });

  test("filters a pair's walls by their size in dollars with an exempt list of outcomes, keeps the cursor right across the dropped walls, and refuses a malformed filter", async () => {
    seed("binance:PERPETUAL:BTCUSDT");
    seed("dxfeed:FUTURE:/NQZ26:XCME");
    current = await server({ heatmapReader: createPyramidReader({ dir }), dxfeedStorageReader: null });
    const dxfeed = { symbol: "/NQZ26:XCME", provider: "dxfeed", assetClass: "FUTURE", marketKind: undefined };
    const futures = await post(current.base, "wall-history", body("wall-history", { minUsd: 1 }, dxfeed));
    expect([futures.status, futures.body.error]).toEqual([400, "MALFORMED_REQUEST"]);
    expect((await post(current.base, "wall-history", body("wall-history", {}, dxfeed))).body.walls).toHaveLength(3);
    const sized = await post(current.base, "wall-history", body("wall-history", { minUsd: 180 }));
    expect(sized.status).toBe(200);
    expect(bare(sized.body.walls)).toEqual([WALLS[1]]);
    expect(sized.body.next).toBeNull();
    expect(sized.body.filter).toEqual({ minUsd: 180, alwaysOutcomes: [] });
    const unfiltered = await post(current.base, "wall-history", body("wall-history", {}));
    expect(Object.hasOwn(unfiltered.body, "filter")).toBe(false);
    const exempt = await post(current.base, "wall-history", body("wall-history", { minUsd: 180, alwaysOutcomes: ["hit"] }));
    expect(bare(exempt.body.walls)).toEqual(WALLS);
    expect(new Set(exempt.body.walls.map((entry) => entry.id)).size).toBe(3);
    expect(exempt.body.filter).toEqual({ minUsd: 180, alwaysOutcomes: ["hit"] });
    const none = await post(current.base, "wall-history", body("wall-history", { minUsd: 1_000_000, alwaysOutcomes: [] }));
    expect(none.body).toMatchObject({ available: true, walls: [], next: null });
    const paged = await post(current.base, "wall-history", body("wall-history", { minUsd: 170, limit: 1 }));
    expect(bare(paged.body.walls)).toEqual([WALLS[1]]);
    expect(paged.body.next).toEqual({ endTs: W0 + 40_000, id: expect.any(Number) });
    expect(paged.body.next.id).toBe(paged.body.walls[0].id);
    const rest = await post(current.base, "wall-history", body("wall-history", { minUsd: 170, limit: 1, after: paged.body.next }));
    expect(bare(rest.body.walls)).toEqual([WALLS[2]]);
    expect(rest.body.next).toBeNull();
    const refusals = await Promise.all([
      post(current.base, "wall-history", body("wall-history", { minUsd: -1 })),
      post(current.base, "wall-history", body("wall-history", { minUsd: "1" })),
      post(current.base, "wall-history", body("wall-history", { minUsd: 1e13 })),
      post(current.base, "wall-history", body("wall-history", { alwaysOutcomes: ["hit"] })),
      post(current.base, "wall-history", body("wall-history", { minUsd: 1, alwaysOutcomes: ["lost"] })),
      post(current.base, "wall-history", body("wall-history", { minUsd: 1, alwaysOutcomes: ["hit", "hit"] })),
      post(current.base, "event-history", body("event-history", { minUsd: 1 })),
    ]);
    expect(refusals.map((r) => [r.status, r.body.detail])).toEqual([
      [400, "MIN_USD_OUT_OF_RANGE"],
      [400, "MIN_USD_OUT_OF_RANGE"],
      [400, "MIN_USD_OUT_OF_RANGE"],
      [400, "ALWAYS_OUTCOMES_NEEDS_MIN_USD"],
      [400, "ALWAYS_OUTCOMES_INVALID"],
      [400, "ALWAYS_OUTCOMES_INVALID"],
      [400, "UNKNOWN_OPTIONS:minUsd"],
    ]);
  });

  test("a Binance page carries the pair's size percentiles, a dxFeed page does not, and the reader scans once per ten minutes and again after a re-pin", async () => {
    seed("binance:PERPETUAL:BTCUSDT");
    seed("dxfeed:FUTURE:/NQZ26:XCME");
    let clock = 1_000;
    const reader = createPyramidReader({ dir, now: () => clock });
    current = await server({ heatmapReader: reader, dxfeedStorageReader: null });
    const dxfeed = { symbol: "/NQZ26:XCME", provider: "dxfeed", assetClass: "FUTURE", marketKind: undefined };
    const first = await post(current.base, "wall-history", body("wall-history", {}));
    expect(first.body.sizeBands).toEqual({ n: 3, p50: 172.5, p75: 187.5, p90: 187.5, p95: 187.5, p99: 187.5 });
    expect(Object.hasOwn((await post(current.base, "wall-history", body("wall-history", {}, dxfeed))).body, "sizeBands")).toBe(false);
    await post(current.base, "wall-history", body("wall-history", { minUsd: 100 }));
    expect(reader.stats().sizeScans).toBe(1);
    clock += 599_000;
    await post(current.base, "wall-history", body("wall-history", {}));
    expect(reader.stats().sizeScans).toBe(1);
    clock += 2_000;
    await post(current.base, "wall-history", body("wall-history", {}));
    expect(reader.stats().sizeScans).toBe(2);
    const store = openPyramidStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT" });
    store.pin({ ...GEOMETRY, rowClusters: 7 });
    store.close();
    const repinned = await post(current.base, "wall-history", body("wall-history", {}));
    expect(reader.stats().sizeScans).toBe(3);
    expect(Object.hasOwn(repinned.body, "sizeBands")).toBe(false);
  });

  test("a pair with no pyramid, or one not pinned yet, answers unavailable with the reason, not an error", async () => {
    seed("binance:SPOT:ETHUSDT", { pin: false });
    current = await server({ heatmapReader: createPyramidReader({ dir }) });
    const missing = await post(current.base, "wall-history", body("wall-history", {}));
    expect([missing.status, missing.body]).toEqual([200, { available: false, reason: "NO_PYRAMID" }]);
    const unpinned = await post(current.base, "event-history", body("event-history", {}, { symbol: "ETHUSDT", marketKind: "SPOT" }));
    expect([unpinned.status, unpinned.body]).toEqual([200, { available: false, reason: "NOT_PINNED" }]);
    const missingEvents = await post(current.base, "event-history", body("event-history", {}));
    expect([missingEvents.status, missingEvents.body]).toEqual([200, { available: false, reason: "NO_PYRAMID" }]);
    const unpinnedWalls = await post(current.base, "wall-history", body("wall-history", {}, { symbol: "ETHUSDT", marketKind: "SPOT" }));
    expect([unpinnedWalls.status, unpinnedWalls.body]).toEqual([200, { available: false, reason: "NOT_PINNED" }]);
  });

  test("pages a pair's walls by the time they ended with the pinned geometry, and follows the cursor to the rest", async () => {
    seed("binance:PERPETUAL:BTCUSDT");
    current = await server({ heatmapReader: createPyramidReader({ dir }) });
    const first = await post(current.base, "wall-history", body("wall-history", { limit: 2 }));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ available: true, geometry: { rowWidth: 3, rowClusters: 6, pinnedPrice: 300 }, span: { oldest: W0, newest: W0 + WINDOW_MS }, walls: [WALLS[0], WALLS[1]], next: { endTs: W0 + 40_000, id: expect.any(Number) } });
    expect(first.body.generation).toMatch(/^[0-9a-f-]{36}$/);
    const rest = await post(current.base, "wall-history", body("wall-history", { limit: 2, after: first.body.next }));
    expect(rest.body).toMatchObject({ walls: [WALLS[2]], next: null });
    const later = await post(current.base, "wall-history", body("wall-history", { fromTs: W0 + 30_000 }));
    expect(bare(later.body.walls)).toEqual([WALLS[1], WALLS[2]]);
  });

  test("pages a pair's event windows within the byte budget, and serves dxFeed pairs from their own store while refusing a symbol the catalog does not prove", async () => {
    seed("binance:PERPETUAL:BTCUSDT");
    seed("dxfeed:FUTURE:/NQZ26:XCME");
    const oneWindow = JSON.stringify(eventsOf(W0, [[W0, 10_000, 10, "buy", "absorbed", 2, 1]])).length;
    current = await server({ heatmapReader: createPyramidReader({ dir, pageBytes: oneWindow + 1 }), dxfeedStorageReader: null });
    const first = await post(current.base, "event-history", body("event-history", {}));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ available: true, geometry: { rowWidth: 3 }, windows: [{ ts: W0, events: eventsOf(W0, [[W0, 10_000, 10, "buy", "absorbed", 2, 1]]) }], next: W0 + WINDOW_MS });
    const rest = await post(current.base, "event-history", body("event-history", { fromTs: first.body.next }));
    expect(rest.body.windows.map((w) => [w.ts, w.events.trades[0][2]])).toEqual([[W0 + WINDOW_MS, 11]]);
    expect(rest.body.next).toBeNull();
    const served = await post(current.base, "wall-history", body("wall-history", {}, { symbol: "/NQZ26:XCME", provider: "dxfeed", assetClass: "FUTURE", marketKind: undefined }));
    expect([served.status, served.body.walls.length]).toEqual([200, 3]);
    const refused = await post(current.base, "event-history", body("event-history", {}, { symbol: "/ZZZ:XCME", provider: "dxfeed", assetClass: "FUTURE", marketKind: undefined }));
    expect(refused.status).toBe(400);
  });
});

describe("server/live-storage-route iceberg-history", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { openIcebergHostStore, ICEBERG_RULES_VERSION } = require("../../src/indicators/iceberg/iceberg-host-store");
  const { createIcebergHostReader } = require("../../src/indicators/iceberg/iceberg-host-reader");
  const T = 1_700_000_000_000;
  const settled = (id, markedAt) => ({ id, kind: "native", confidence: "certain", origin: "runtime", side: "bid", price: 31188, display: 10, tranches: 4, executed: 32, startedAt: markedAt - 500, markedAt, updatedAt: markedAt + 1000, status: "filled" });
  let current = null;
  let dir = null;

  function body(options, overrides = {}) {
    return { symbol: "BTCUSDT", marketKind: "PERPETUAL", options: { fromTs: T, toTs: T + 60_000, ...options }, ...overrides };
  }

  function seed(pairKey) {
    const store = openIcebergHostStore({ dir, pairKey });
    store.checkpoint({ cursor: T + 50_000, start: T, settledThrough: T + 40_000, cuts: null, coverage: [[T, T + 50_000]], gaps: [[T + 10_000, T + 12_000, "NO_CAPTURE"]] }, [settled("a", T + 1_000), settled("b", T + 2_000), settled("c", T + 3_000)]);
    const generation = store.generation();
    store.close();
    return generation;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "iceberg-route-"));
  });

  afterEach(async () => {
    if (current) {
      current.route.dispose();
      await close(current.server);
      current = null;
    }
  });

  test("without an iceberg reader the route says the history is not configured", async () => {
    current = await server();
    const response = await post(current.base, "iceberg-history", body({}));
    expect([response.status, response.body]).toEqual([503, { error: "SERVICE_UNAVAILABLE", detail: "ICEBERG_HISTORY_NOT_CONFIGURED" }]);
  });

  test("refuses a span over eight days or ending before it starts, an unknown option, a page limit off the range and a cursor that is not { markedAt, id }", async () => {
    current = await server({ icebergReader: createIcebergHostReader({ dir }) });
    const refusals = await Promise.all([
      post(current.base, "iceberg-history", body({ toTs: T + 9 * 86_400_000 })),
      post(current.base, "iceberg-history", body({ toTs: T })),
      post(current.base, "iceberg-history", body({ levelMs: 30_000 })),
      post(current.base, "iceberg-history", body({ limit: 0 })),
      post(current.base, "iceberg-history", body({ limit: 2001 })),
      post(current.base, "iceberg-history", body({ after: { markedAt: T } })),
      post(current.base, "iceberg-history", body({ after: { markedAt: T, id: "" } })),
      post(current.base, "iceberg-history", body({ after: "x" })),
    ]);
    expect(refusals.map((r) => [r.status, r.body.detail])).toEqual([
      [400, "TIME_RANGE_OUT_OF_RANGE:fromTs/toTs"],
      [400, "TIME_RANGE_OUT_OF_RANGE:fromTs/toTs"],
      [400, "UNKNOWN_OPTIONS:levelMs"],
      [400, "LIMIT_OUT_OF_RANGE:1..2000"],
      [400, "LIMIT_OUT_OF_RANGE:1..2000"],
      [400, "CURSOR_INVALID"],
      [400, "CURSOR_INVALID"],
      [400, "CURSOR_INVALID"],
    ]);
  });

  test("a pair with no history, or one not built yet, answers unavailable with the reason, not an error", async () => {
    current = await server({ icebergReader: createIcebergHostReader({ dir }) });
    const missing = await post(current.base, "iceberg-history", body({}));
    expect([missing.status, missing.body]).toEqual([200, { available: false, reason: "NO_HISTORY" }]);
    openIcebergHostStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT" }).close();
    const empty = await post(current.base, "iceberg-history", body({}));
    expect([empty.status, empty.body]).toEqual([200, { available: false, reason: "NOT_BUILT" }]);
  });

  test("pages a pair's icebergs by their mark with the host's generation and watched spans, follows the cursor, and serves a dxFeed pair the same way", async () => {
    const generation = seed("binance:PERPETUAL:BTCUSDT");
    seed("dxfeed:FUTURE:/NQZ26:XCME");
    current = await server({ icebergReader: createIcebergHostReader({ dir }) });
    const first = await post(current.base, "iceberg-history", body({ limit: 2 }));
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ available: true, generation, rulesVersion: ICEBERG_RULES_VERSION, span: { from: T, to: T + 40_000 }, watched: [[T, T + 10_000], [T + 12_000, T + 40_000]], icebergs: [settled("a", T + 1_000), settled("b", T + 2_000)], next: { markedAt: T + 2_000, id: "b" } });
    const rest = await post(current.base, "iceberg-history", body({ limit: 2, after: first.body.next }));
    expect(rest.body).toMatchObject({ icebergs: [settled("c", T + 3_000)], next: null });
    const futures = await post(current.base, "iceberg-history", { provider: "dxfeed", symbol: "/NQZ26:XCME", assetClass: "FUTURE", options: { fromTs: T, toTs: T + 60_000, limit: 10 } });
    expect([futures.status, futures.body.available, futures.body.icebergs.length]).toEqual([200, true, 3]);
  });
});
