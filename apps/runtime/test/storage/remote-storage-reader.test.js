const {
  createRemoteStorageReader, FALLBACK_SHAPES, CONTRACT_VERSION_HEADER, CONTRACT_VERSION,
  DEFAULT_TIMEOUT_MS, TIMEOUT_MS_BY_ROUTE, MAX_RESPONSE_BYTES_BY_ROUTE, DEFAULT_MAX_RESPONSE_BYTES,
} = require("../../src/storage/remote-storage-reader");

function jsonResponse(body, { status = 200, contractVersion = CONTRACT_VERSION } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", [CONTRACT_VERSION_HEADER]: contractVersion } });
}

describe("createRemoteStorageReader construction", () => {
  test("requires a non-empty baseUrl", () => {
    expect(() => createRemoteStorageReader({ token: "tok" })).toThrow(/baseUrl/);
    expect(() => createRemoteStorageReader({ baseUrl: "", token: "tok" })).toThrow(/baseUrl/);
  });

  test("requires a non-empty token", () => {
    expect(() => createRemoteStorageReader({ baseUrl: "http://10.88.0.1:8003" })).toThrow(/token/);
  });

  test("requires a positive integer timeoutMs", () => {
    expect(() => createRemoteStorageReader({ baseUrl: "http://x", token: "t", timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => createRemoteStorageReader({ baseUrl: "http://x", token: "t", timeoutMs: -1 })).toThrow(/timeoutMs/);
  });

  test("requires a positive integer maxResponseBytes", () => {
    expect(() => createRemoteStorageReader({ baseUrl: "http://x", token: "t", maxResponseBytes: 0 })).toThrow(/maxResponseBytes/);
  });

  test("exposes dbPath as undefined and a frozen remote descriptor, never a local file path", () => {
    const reader = createRemoteStorageReader({ baseUrl: "http://10.88.0.1:8003", token: "tok" });
    expect(reader.dbPath).toBeUndefined();
    expect(reader.remote).toEqual({ baseUrl: "http://10.88.0.1:8003", token: "tok", timeoutMs: 5_000 });
    expect(Object.isFrozen(reader.remote)).toBe(true);
  });
});

describe("createRemoteStorageReader requests", () => {
  test("posts to <baseUrl>/<route> with the bearer token and a JSON body", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ rows: [{ ts: 1 }], coversFullWindow: true }));
    const reader = createRemoteStorageReader({ baseUrl: "http://10.88.0.1:8003", token: "secret-tok", fetchImpl });
    const result = await reader.readRecentCandles("BTCUSDT", "SPOT", { intervalMs: 60_000, windowMs: 120_000 });
    expect(result).toEqual({ rows: [{ ts: 1 }], coversFullWindow: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://10.88.0.1:8003/recent-candles",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: expect.objectContaining({
          authorization: "Bearer secret-tok", "content-type": "application/json",
          [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION,
          "x-terminal-correlation-id": expect.stringMatching(/^[0-9a-f-]{36}$/),
        }),
        body: JSON.stringify({ symbol: "BTCUSDT", marketKind: "SPOT", options: { intervalMs: 60_000, windowMs: 120_000 } }),
      }),
    );
  });

  test("strips a trailing slash from baseUrl so the route never doubles up", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ rows: [], available: false }));
    const reader = createRemoteStorageReader({ baseUrl: "http://10.88.0.1:8003/", token: "t", fetchImpl });
    await reader.readLargeTrades("BTCUSDT", "SPOT", {});
    expect(fetchImpl).toHaveBeenCalledWith("http://10.88.0.1:8003/large-trades", expect.anything());
  });

  test("never follows a redirect silently", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ rows: [], available: false }));
    const reader = createRemoteStorageReader({ baseUrl: "http://10.88.0.1:8003", token: "t", fetchImpl });
    await reader.readLargeTrades("BTCUSDT", "SPOT", {});
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: "error" }));
  });

  test("readLargeTrades and readLargeTradesAsync hit the same route", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ rows: [], available: true }));
    const reader = createRemoteStorageReader({ baseUrl: "http://x", token: "t", fetchImpl });
    await reader.readLargeTrades("BTCUSDT", "SPOT", {});
    await reader.readLargeTradesAsync("BTCUSDT", "SPOT", {});
    expect(fetchImpl.mock.calls[0][0]).toBe("http://x/large-trades");
    expect(fetchImpl.mock.calls[1][0]).toBe("http://x/large-trades");
  });
});

describe("createRemoteStorageReader failure handling — never throws, always the method's own fallback shape", () => {
  test("a network error falls back without throwing", async () => {
    const fetchImpl = jest.fn(async () => { throw new Error("ECONNREFUSED"); });
    const reader = createRemoteStorageReader({ baseUrl: "http://x", token: "t", fetchImpl, log: () => {} });
    await expect(reader.readLargeTrades("BTCUSDT", "SPOT", {})).resolves.toEqual({ rows: [], available: false });
  });

  test("a non-2xx status falls back", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ error: "SERVICE_UNAVAILABLE" }, { status: 503 }));
    const reader = createRemoteStorageReader({ baseUrl: "http://x", token: "t", fetchImpl, log: () => {} });
    await expect(reader.readVolumeProfile("BTCUSDT", "SPOT", {})).resolves.toEqual({ buckets: [], available: false });
  });

  test("a malformed (non-JSON) body falls back", async () => {
    const fetchImpl = jest.fn(async () => new Response("not json", { status: 200 }));
    const reader = createRemoteStorageReader({ baseUrl: "http://x", token: "t", fetchImpl, log: () => {} });
    await expect(reader.readRecordingAge("BTCUSDT", "SPOT", {})).resolves.toEqual({ latestTs: null, ageMs: null, available: false });
  });

  test("accepts a measured-size candle response while retaining the default cap for other routes", async () => {
    const largeValue = "x".repeat(2_100_000);
    const fetchImpl = jest.fn(async (url) => jsonResponse(url.endsWith("recent-candles")
      ? { rows: [largeValue], coversFullWindow: true }
      : { rows: [largeValue], available: true }));
    const reader = createRemoteStorageReader({ baseUrl: "http://x", token: "t", fetchImpl, log: () => {} });
    await expect(reader.readRecentCandles("BTCUSDT", "SPOT", {})).resolves.toMatchObject({ coversFullWindow: true });
    await expect(reader.readLargeTrades("BTCUSDT", "SPOT", {})).resolves.toEqual({ rows: [], available: false });
  });

  test("a 2xx response with the wrong contract version or result shape falls back", async () => {
    const wrongVersion = createRemoteStorageReader({
      baseUrl: "http://x", token: "t", log: () => {},
      fetchImpl: jest.fn(async () => jsonResponse({ rows: [], available: true }, { contractVersion: "live-storage/2" })),
    });
    await expect(wrongVersion.readLargeTrades("BTCUSDT", "SPOT", {})).resolves.toEqual({ rows: [], available: false });

    const wrongShape = createRemoteStorageReader({
      baseUrl: "http://x", token: "t", log: () => {},
      fetchImpl: jest.fn(async () => jsonResponse({ rows: "not-an-array", available: true })),
    });
    await expect(wrongShape.readLargeTrades("BTCUSDT", "SPOT", {})).resolves.toEqual({ rows: [], available: false });
  });

  const READER = createRemoteStorageReader;
  const SYMBOL = "BTCUSDT";
  const KIND = "SPOT";

  // Measured 2026-09-20: the laptop <-> Poland path moves ~200 KB/s over the
  // public IP and over WireGuard alike, while the host serves 7 days of 1m
  // candles in under 0.75 s. A 2.48 MB candle body therefore needs ~12 s of
  // transfer and the old flat 5 s timeout cut it off every time, logged as
  // "malformed". Property: the candle route's timeout covers its byte cap at
  // that link rate. Oracle: the two per-route tables against each other.
  test("the candle timeout covers the candle byte cap at the measured 200 KB/s link rate; other routes keep the default", () => {
    const linkBytesPerSecond = 200_000;
    const worstCaseMs = (MAX_RESPONSE_BYTES_BY_ROUTE["recent-candles"] / linkBytesPerSecond) * 1_000;
    expect(TIMEOUT_MS_BY_ROUTE["recent-candles"]).toBeGreaterThanOrEqual(worstCaseMs);
    expect(Object.keys(TIMEOUT_MS_BY_ROUTE)).toEqual(["recent-candles", "aggressive-prints", "band-history", "heatmap-columns", "wall-history", "event-history", "volume-profile", "iceberg-history"]);
    expect(DEFAULT_TIMEOUT_MS).toBeLessThan(TIMEOUT_MS_BY_ROUTE["recent-candles"]);
  });

  // Measured 2026-09-23: a day of BTC spot prints at a 5 BTC floor answers in
  // 0.8-2.2 s for the four newest days and past 5 s for every older day, three
  // tries each, so the flat 5 s timeout turned the whole older week into
  // STORAGE_UNAVAILABLE. Property: the print route waits at least as long as
  // the host's relay itself waits on its reader, plus the route's byte cap at
  // the measured link rate. Oracle: the relay's own timeout table.
  test("the print timeout outlasts the relay's upstream wait plus the route's byte cap at the measured link rate", () => {
    const { UPSTREAM_TIMEOUT_MS_BY_ROUTE, DEFAULT_UPSTREAM_TIMEOUT_MS } = require("../../src/server/live-storage-relay");
    const linkBytesPerSecond = 200_000;
    const relayWaitMs = UPSTREAM_TIMEOUT_MS_BY_ROUTE["aggressive-prints"] ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    const transferMs = ((MAX_RESPONSE_BYTES_BY_ROUTE["aggressive-prints"] ?? DEFAULT_MAX_RESPONSE_BYTES) / linkBytesPerSecond) * 1_000;
    expect(TIMEOUT_MS_BY_ROUTE["aggressive-prints"]).toBeGreaterThanOrEqual(relayWaitMs + transferMs);
    expect(DEFAULT_TIMEOUT_MS).toBeLessThan(TIMEOUT_MS_BY_ROUTE["aggressive-prints"]);
  });

  test("the band-history timeout outlasts the relay's upstream wait plus its byte cap at the measured link rate", () => {
    const { UPSTREAM_TIMEOUT_MS_BY_ROUTE, DEFAULT_UPSTREAM_TIMEOUT_MS } = require("../../src/server/live-storage-relay");
    const linkBytesPerSecond = 200_000;
    const relayWaitMs = UPSTREAM_TIMEOUT_MS_BY_ROUTE["band-history"] ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    const transferMs = ((MAX_RESPONSE_BYTES_BY_ROUTE["band-history"] ?? DEFAULT_MAX_RESPONSE_BYTES) / linkBytesPerSecond) * 1_000;
    expect(MAX_RESPONSE_BYTES_BY_ROUTE["band-history"]).toBeGreaterThanOrEqual(4_000_000);
    expect(TIMEOUT_MS_BY_ROUTE["band-history"]).toBeGreaterThanOrEqual(relayWaitMs + transferMs);
    expect(DEFAULT_TIMEOUT_MS).toBeLessThan(TIMEOUT_MS_BY_ROUTE["band-history"]);
  });

  test("the volume-profile timeout outlasts the relay's upstream wait plus its byte cap at the measured link rate", () => {
    const { UPSTREAM_TIMEOUT_MS_BY_ROUTE, DEFAULT_UPSTREAM_TIMEOUT_MS } = require("../../src/server/live-storage-relay");
    const linkBytesPerSecond = 200_000;
    const relayWaitMs = UPSTREAM_TIMEOUT_MS_BY_ROUTE["volume-profile"] ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    const transferMs = ((MAX_RESPONSE_BYTES_BY_ROUTE["volume-profile"] ?? DEFAULT_MAX_RESPONSE_BYTES) / linkBytesPerSecond) * 1_000;
    expect(TIMEOUT_MS_BY_ROUTE["volume-profile"]).toBeGreaterThanOrEqual(relayWaitMs + transferMs);
    expect(DEFAULT_TIMEOUT_MS).toBeLessThan(TIMEOUT_MS_BY_ROUTE["volume-profile"]);
  });

  test("a volume-profile read that runs out of time, on the host or here, says READ_TIMEOUT; another failure, a caller's abort or another route does not", async () => {
    for (const [detail, expected] of [["QUERY_TIMEOUT", "READ_TIMEOUT"], ["STORAGE_READ_FAILED", undefined]]) {
      const reader = READER({ baseUrl: "http://host/live-storage", token: "secret", log: () => {}, fetchImpl: async () => jsonResponse({ error: "SERVICE_UNAVAILABLE", detail }, { status: 503 }) });
      const result = await reader.readVolumeProfileAsync.bind(null, SYMBOL, KIND)({});
      expect(result.available).toBe(false);
      expect(result.reason).toBe(expected);
      await reader.close();
    }
    const elsewhere = READER({ baseUrl: "http://host/live-storage", token: "secret", log: () => {}, fetchImpl: async () => jsonResponse({ error: "SERVICE_UNAVAILABLE", detail: "QUERY_TIMEOUT" }, { status: 503 }) });
    expect((await elsewhere.readPriceRange.bind(null, SYMBOL, KIND)({})).reason).toBeUndefined();
    await elsewhere.close();
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    const hanging = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    const reader = READER({ baseUrl: "http://host/live-storage", token: "secret", log: () => {}, fetchImpl: hanging });
    try {
      const slow = reader.readVolumeProfileAsync.bind(null, SYMBOL, KIND)({});
      await jest.advanceTimersByTimeAsync(TIMEOUT_MS_BY_ROUTE["volume-profile"]);
      expect(await slow).toMatchObject({ available: false, reason: "READ_TIMEOUT" });
      const controller = new AbortController();
      const abandoned = reader.readVolumeProfileAsync.bind(null, SYMBOL, KIND)({}, { signal: controller.signal });
      await jest.advanceTimersByTimeAsync(1);
      controller.abort();
      expect((await abandoned).reason).toBeUndefined();
    } finally {
      await reader.close();
      jest.useRealTimers();
    }
  });

  test("the heatmap-columns timeout outlasts the relay's upstream wait plus its byte cap at the measured link rate (P4c.4)", () => {
    const { UPSTREAM_TIMEOUT_MS_BY_ROUTE, DEFAULT_UPSTREAM_TIMEOUT_MS, MAX_UPSTREAM_RESPONSE_BYTES } = require("../../src/server/live-storage-relay");
    const { DEFAULT_PAGE_BYTES } = require("../../src/indicators/l2-memory/pyramid/pyramid-reader");
    const linkBytesPerSecond = 200_000;
    const relayWaitMs = UPSTREAM_TIMEOUT_MS_BY_ROUTE["heatmap-columns"] ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    const transferMs = (MAX_RESPONSE_BYTES_BY_ROUTE["heatmap-columns"] / linkBytesPerSecond) * 1_000;
    expect(TIMEOUT_MS_BY_ROUTE["heatmap-columns"]).toBeGreaterThanOrEqual(relayWaitMs + transferMs);
    expect(MAX_RESPONSE_BYTES_BY_ROUTE["heatmap-columns"]).toBeGreaterThan(DEFAULT_PAGE_BYTES);
    expect(MAX_UPSTREAM_RESPONSE_BYTES).toBeGreaterThan(DEFAULT_PAGE_BYTES);
  });

  test("a route-specific timeout outlives the default one, and only for that route", async () => {
    jest.useFakeTimers();
    try {
      const signals = new Map();
      const fetchImpl = jest.fn((url, init) => {
        signals.set(url.split("/").pop(), init.signal);
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
      });
      const reader = READER({ baseUrl: "http://x", token: "t", timeoutMs: 20, timeoutMsByRoute: { "recent-candles": 60 }, fetchImpl, log: () => {} });
      const candles = reader.readRecentCandles(SYMBOL, KIND, {});
      const trades = reader.readLargeTrades(SYMBOL, KIND, {});
      await jest.advanceTimersByTimeAsync(25);
      expect(signals.get("large-trades").aborted).toBe(true);
      expect(signals.get("recent-candles").aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(40);
      expect(signals.get("recent-candles").aborted).toBe(true);
      await expect(candles).resolves.toEqual(FALLBACK_SHAPES["recent-candles"]());
      await expect(trades).resolves.toEqual(FALLBACK_SHAPES["large-trades"]());
    } finally {
      jest.useRealTimers();
    }
  });

  test("readVolumeProfileAsync hands the caller's abort signal to the fetch, so an abandoned profile piece stops on the host too", async () => {
    let fetchSignal = null;
    const fetchImpl = jest.fn((_url, init) => {
      fetchSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    });
    const reader = READER({ baseUrl: "http://x", token: "t", fetchImpl, log: () => {} });
    const controller = new AbortController();
    const read = reader.readVolumeProfileAsync(SYMBOL, KIND, { fromTs: 0, toTs: 1, originPrice: 0, rowWidth: 1 }, { signal: controller.signal });
    expect(fetchSignal.aborted).toBe(false);
    controller.abort();
    expect(fetchSignal.aborted).toBe(true);
    await expect(read).resolves.toEqual(FALLBACK_SHAPES["volume-profile"]({}));
  });

  test("a body that is still streaming when the timeout fires is logged as a timeout, not as malformed", async () => {
    const log = jest.fn();
    const fetchImpl = jest.fn(async (_url, init) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"rows":['));
          init.signal.addEventListener("abort", () => controller.error(Object.assign(new Error("aborted"), { name: "AbortError" })));
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "application/json", [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION } });
    });
    const reader = READER({ baseUrl: "http://x", token: "t", timeoutMs: 20, timeoutMsByRoute: {}, fetchImpl, log });
    await expect(reader.readLargeTrades(SYMBOL, KIND, {})).resolves.toEqual(FALLBACK_SHAPES["large-trades"]());
    expect(log).toHaveBeenCalledWith(expect.stringContaining("not received within the timeout"), "large-trades", 20);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("malformed"), expect.anything());
  });

  test("timeoutMsByRoute must name a real route with a positive integer", () => {
    expect(() => READER({ baseUrl: "http://x", token: "t", timeoutMsByRoute: { "no-such-route": 1_000 } })).toThrow(/timeoutMsByRoute/);
    expect(() => READER({ baseUrl: "http://x", token: "t", timeoutMsByRoute: { "recent-candles": 0 } })).toThrow(/timeoutMsByRoute/);
  });

  test("a request that never resolves is aborted at timeoutMs and falls back", async () => {
    let capturedSignal;
    const fetchImpl = jest.fn((url, init) => {
      capturedSignal = init.signal;
      return new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    });
    const reader = createRemoteStorageReader({ baseUrl: "http://x", token: "t", timeoutMs: 20, fetchImpl, log: () => {} });
    const result = await reader.readDailyNotional("BTCUSDT", "SPOT", {});
    expect(result).toEqual({ rows: [], available: false });
    expect(capturedSignal.aborted).toBe(true);
  });

  test("an aggressive-history caller can abort the underlying network request", async () => {
    let networkSignal;
    const fetchImpl = jest.fn((_url, init) => {
      networkSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
    });
    const reader = createRemoteStorageReader({ baseUrl: "http://x", token: "t", timeoutMs: 10_000, fetchImpl, log: () => {} });
    const controller = new AbortController();
    const pending = reader.readAggressivePrintsAsync("BTCUSDT", "SPOT", {}, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(pending).resolves.toEqual({ rows: [], available: false, hasMore: false, nextCursor: null });
    expect(networkSignal.aborted).toBe(true);
  });

  test("readRecentTrades falls back with nextCursor only when a limit was requested", async () => {
    const fetchImpl = jest.fn(async () => { throw new Error("down"); });
    const reader = createRemoteStorageReader({ baseUrl: "http://x", token: "t", fetchImpl, log: () => {} });
    await expect(reader.readRecentTrades("BTCUSDT", "SPOT", {})).resolves.toEqual({ rows: [], available: false });
    await expect(reader.readRecentTrades("BTCUSDT", "SPOT", { limit: 50 })).resolves.toEqual({
      rows: [], nextCursor: null, available: false,
    });
  });

  test("every declared fallback shape is reachable and matches FALLBACK_SHAPES exactly", async () => {
    const fetchImpl = jest.fn(async () => { throw new Error("down"); });
    const reader = createRemoteStorageReader({ baseUrl: "http://x", token: "t", fetchImpl, log: () => {} });
    const cases = [
      ["recent-candles", () => reader.readRecentCandles("BTCUSDT", "SPOT", {})],
      ["large-trades", () => reader.readLargeTrades("BTCUSDT", "SPOT", {})],
      ["aggressive-prints", () => reader.readAggressivePrints("BTCUSDT", "SPOT", {})],
      ["volume-profile", () => reader.readVolumeProfile("BTCUSDT", "SPOT", {})],
      ["price-range", () => reader.readPriceRange("BTCUSDT", "SPOT", {})],
      ["minute-rollup", () => reader.readMinuteRollup("BTCUSDT", "SPOT", {})],
      ["daily-notional", () => reader.readDailyNotional("BTCUSDT", "SPOT", {})],
      ["sliced-notional", () => reader.readSlicedNotional("BTCUSDT", "SPOT", {})],
      ["recording-age", () => reader.readRecordingAge("BTCUSDT", "SPOT", {})],
    ];
    for (const [route, run] of cases) {
      await expect(run()).resolves.toEqual(FALLBACK_SHAPES[route]({}));
    }
  });
});

describe("createRemoteStorageReader rate limiting — a 429 means wait, not storage down", () => {
  const quiet = { log: () => {}, warn: () => {}, meter: { record: () => {} } };

  test("a 429 waits the host's retryAfterMs and retries the same read, which then succeeds", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const fetchImpl = jest.fn()
        .mockResolvedValueOnce(jsonResponse({ error: "OVERLOADED", retryAfterMs: 3_000 }, { status: 429 }))
        .mockResolvedValue(jsonResponse({ rows: [{ id: 1 }], available: true }));
      const reader = createRemoteStorageReader({ baseUrl: "http://x", token: "t", fetchImpl, ...quiet });
      const read = reader.readRecentTrades("BTCUSDT", "SPOT", {});
      await jest.advanceTimersByTimeAsync(2_999);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await expect(read).resolves.toEqual({ rows: [{ id: 1 }], available: true });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test("while paused, a second read waits instead of spending another request", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const fetchImpl = jest.fn()
        .mockResolvedValueOnce(jsonResponse({ error: "OVERLOADED", retryAfterMs: 2_000 }, { status: 429 }))
        .mockResolvedValue(jsonResponse({ rows: [], available: true }));
      const reader = createRemoteStorageReader({ baseUrl: "http://x", token: "t", fetchImpl, ...quiet });
      const first = reader.readRecentTrades("BTCUSDT", "SPOT", {});
      await jest.advanceTimersByTimeAsync(0);
      const second = reader.readLargeTrades("BTCUSDT", "SPOT", {});
      await jest.advanceTimersByTimeAsync(1_000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1_000);
      await Promise.all([first, second]);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a read still refused past the retry budget returns its fallback marked RATE_LIMITED", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const fetchImpl = jest.fn(async () => jsonResponse({ error: "OVERLOADED", retryAfterMs: 4_000 }, { status: 429 }));
      const reader = createRemoteStorageReader({ baseUrl: "http://x", token: "t", fetchImpl, rateLimitRetryBudgetMs: 5_000, ...quiet });
      const read = reader.readVolumeProfile("BTCUSDT", "SPOT", {});
      await jest.advanceTimersByTimeAsync(4_000);
      await expect(read).resolves.toEqual({ ...FALLBACK_SHAPES["volume-profile"]({}), reason: "RATE_LIMITED" });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test("the host-read meter sees every attempt, including the refused one", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const record = jest.fn();
      const fetchImpl = jest.fn()
        .mockResolvedValueOnce(jsonResponse({ error: "OVERLOADED", retryAfterMs: 1_000 }, { status: 429 }))
        .mockResolvedValue(jsonResponse({ rows: [], available: true }));
      const reader = createRemoteStorageReader({ baseUrl: "http://x", token: "t", fetchImpl, log: () => {}, warn: () => {}, meter: { record } });
      const read = reader.readRecentTrades("BTCUSDT", "SPOT", {});
      await jest.advanceTimersByTimeAsync(1_000);
      await read;
      expect(record.mock.calls).toEqual([["recent-trades", 429], ["recent-trades", 200]]);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("createRemoteStorageReader close", () => {
  test("close stops further network calls; every read resolves to its fallback shape", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ rows: [], available: true }));
    const reader = createRemoteStorageReader({ baseUrl: "http://x", token: "t", fetchImpl });
    await reader.close();
    const result = await reader.readLargeTrades("BTCUSDT", "SPOT", {});
    expect(result).toEqual({ rows: [], available: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("createRemoteStorageReader band-history", () => {
  test("readBandHistory posts to the band-history route and returns the host's columns; a wrong shape or a failure is the unavailable fallback", async () => {
    const body = { available: true, rowWidth: 4, rowLo: 20_000, rowHi: 20_002, columnMs: 10_000, columns: [{ ts: 10_000, bid: [1, 2, 3], ask: [0, 0, 0], buy: [0, 0, 0], sell: [0, 1, 0] }], frames: 9, reason: null };
    const fetchImpl = jest.fn(async () => jsonResponse(body));
    const reader = createRemoteStorageReader({ baseUrl: "http://x", token: "t", fetchImpl, log: () => {} });
    const options = { fromTs: 0, toTs: 60_000, tickSize: 0.01, clusterTicks: 100, rowClusters: 4, priceLo: 80_000, priceHi: 80_010, columnMs: 10_000 };
    await expect(reader.readBandHistory("BTCUSDT", "SPOT", options)).resolves.toEqual(body);
    expect(fetchImpl.mock.calls[0][0]).toBe("http://x/band-history");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ symbol: "BTCUSDT", options });
    const wrong = createRemoteStorageReader({ baseUrl: "http://x", token: "t", log: () => {}, fetchImpl: jest.fn(async () => jsonResponse({ available: true, columns: "no" })) });
    await expect(wrong.readBandHistory("BTCUSDT", "SPOT", options)).resolves.toEqual({ columns: [], available: false, reason: "STORAGE_UNAVAILABLE" });
    await reader.close();
    await wrong.close();
  });
});

describe("createRemoteStorageReader heatmap-columns (P4c.4)", () => {
  const page = { available: true, geometry: { rowWidth: 4 }, levelMs: 30_000, rowFactor: 1, span: { oldest: 0, newest: 300_000 }, windows: [{ ts: 0, state: "COVERED", columns: [] }], next: null };
  const options = { levelMs: 30_000, fromTs: 0, toTs: 600_000 };

  test("posts a Binance pair with marketKind and a dxFeed pair with provider and assetClass, the shape the host route accepts", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(page));
    const reader = createRemoteStorageReader({ baseUrl: "http://x", token: "t", fetchImpl, log: () => {} });
    await expect(reader.readHeatmapColumns("BTCUSDT", "PERPETUAL", options)).resolves.toEqual(page);
    expect(fetchImpl.mock.calls[0][0]).toBe("http://x/heatmap-columns");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ symbol: "BTCUSDT", marketKind: "PERPETUAL", options });
    await reader.readHeatmapColumns("/NQZ26:XCME", "FUTURE", options, { provider: "dxfeed" });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ provider: "dxfeed", symbol: "/NQZ26:XCME", assetClass: "FUTURE", options });
    await reader.close();
  });

  test("an honest unavailable answer passes through; a page with a malformed window or geometry is the unavailable fallback", async () => {
    const answers = [{ available: false, reason: "NO_PYRAMID" }, { ...page, windows: [{ ts: "x", state: "COVERED", columns: [] }] }, { ...page, geometry: { rowWidth: 0 } }];
    const fetchImpl = jest.fn(async () => jsonResponse(answers.shift()));
    const reader = createRemoteStorageReader({ baseUrl: "http://x", token: "t", fetchImpl, log: () => {} });
    await expect(reader.readHeatmapColumns("BTCUSDT", "PERPETUAL", options)).resolves.toEqual({ available: false, reason: "NO_PYRAMID" });
    const fallback = { available: false, reason: "STORAGE_UNAVAILABLE", windows: [], next: null };
    await expect(reader.readHeatmapColumns("BTCUSDT", "PERPETUAL", options)).resolves.toEqual(fallback);
    await expect(reader.readHeatmapColumns("BTCUSDT", "PERPETUAL", options)).resolves.toEqual(fallback);
    await reader.close();
  });
});

describe("createRemoteStorageReader wall-history and event-history (P4e3 step 3)", () => {
  const wall = { side: "bid", row: 10, span: 1, startTs: 0, endTs: 20_000, size: 0, peak: 5, endedBy: "hit", ratio: 2, chain: 0, fill: 0, eaten: 0, absorbing: false };
  const wallPage = { available: true, generation: "g", geometry: { rowWidth: 4 }, span: { oldest: 0, newest: 300_000 }, walls: [wall], next: { endTs: 20_000, id: 3 } };
  const events = { version: 1, columnMs: 1_000, deepColumnMs: 10_000, fill: { from: 0, until: 300_000 }, trades: [], wallTrades: [] };
  const eventPage = { available: true, generation: "g", geometry: { rowWidth: 4 }, span: { oldest: 0, newest: 300_000 }, windows: [{ ts: 0, events }], next: null };
  const options = { fromTs: 0, toTs: 600_000 };

  test("posts both routes the way the host accepts them, with the cursor, and passes a well-formed page through", async () => {
    const answers = [wallPage, eventPage];
    const fetchImpl = jest.fn(async () => jsonResponse(answers.shift()));
    const reader = createRemoteStorageReader({ baseUrl: "http://x", token: "t", fetchImpl, log: () => {} });
    await expect(reader.readWallHistory("BTCUSDT", "PERPETUAL", { ...options, limit: 100, after: { endTs: 1, id: 2 } })).resolves.toEqual(wallPage);
    expect(fetchImpl.mock.calls[0][0]).toBe("http://x/wall-history");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ symbol: "BTCUSDT", marketKind: "PERPETUAL", options: { ...options, limit: 100, after: { endTs: 1, id: 2 } } });
    await expect(reader.readEventHistory("/NQZ26:XCME", "FUTURE", options, { provider: "dxfeed" })).resolves.toEqual(eventPage);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ provider: "dxfeed", symbol: "/NQZ26:XCME", assetClass: "FUTURE", options });
    expect(MAX_RESPONSE_BYTES_BY_ROUTE["event-history"]).toBeGreaterThan(require("../../src/indicators/l2-memory/pyramid/pyramid-reader").DEFAULT_PAGE_BYTES);
    await reader.close();
  });

  test("sends the size filter untouched, passes a filtered page and its echo through, and answers the unavailable fallback when an older host refuses the filter", async () => {
    const filter = { minUsd: 5_000_000, alwaysOutcomes: ["filled", "partial"] };
    const filtered = { ...wallPage, filter };
    const answers = [filtered, { status: 400, body: { error: "MALFORMED_REQUEST", detail: "UNKNOWN_OPTIONS:alwaysOutcomes,minUsd" } }];
    const fetchImpl = jest.fn(async () => {
      const answer = answers.shift();
      return answer.status === 400 ? jsonResponse(answer.body, { status: 400 }) : jsonResponse(answer);
    });
    const reader = createRemoteStorageReader({ baseUrl: "http://x", token: "t", fetchImpl, log: () => {}, warn: () => {} });
    await expect(reader.readWallHistory("BTCUSDT", "PERPETUAL", { ...options, ...filter })).resolves.toEqual(filtered);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).options).toEqual({ ...options, ...filter });
    await expect(reader.readWallHistory("BTCUSDT", "PERPETUAL", { ...options, ...filter })).resolves.toEqual({ available: false, reason: "STORAGE_UNAVAILABLE", walls: [], next: null });
    await reader.close();
  });

  test("an honest unavailable answer passes through; a wall with a bad side or cursor, or a window without its event arrays, is the unavailable fallback", async () => {
    const answers = [
      { available: false, reason: "NO_PYRAMID" },
      { ...wallPage, walls: [{ ...wall, side: "up" }] },
      { ...wallPage, next: { endTs: 1 } },
      { ...wallPage, walls: [{ ...wall, endTs: null }] },
      { available: false, reason: "NOT_PINNED" },
      { ...eventPage, windows: [{ ts: 0, events: { ...events, trades: "x" } }] },
      { ...eventPage, windows: [{ ts: "0", events }] },
      { ...eventPage, next: "soon" },
    ];
    const fetchImpl = jest.fn(async () => jsonResponse(answers.shift()));
    const reader = createRemoteStorageReader({ baseUrl: "http://x", token: "t", fetchImpl, log: () => {} });
    const wallFallback = { available: false, reason: "STORAGE_UNAVAILABLE", walls: [], next: null };
    const eventFallback = { available: false, reason: "STORAGE_UNAVAILABLE", windows: [], next: null };
    await expect(reader.readWallHistory("BTCUSDT", "PERPETUAL", options)).resolves.toEqual({ available: false, reason: "NO_PYRAMID" });
    for (let i = 0; i < 3; i += 1) await expect(reader.readWallHistory("BTCUSDT", "PERPETUAL", options)).resolves.toEqual(wallFallback);
    await expect(reader.readEventHistory("BTCUSDT", "PERPETUAL", options)).resolves.toEqual({ available: false, reason: "NOT_PINNED" });
    for (let i = 0; i < 3; i += 1) await expect(reader.readEventHistory("BTCUSDT", "PERPETUAL", options)).resolves.toEqual(eventFallback);
    await reader.close();
  });
});

describe("createRemoteStorageReader iceberg-history", () => {
  const iceberg = { id: "/NQZ26:XCME|1|1000", kind: "native", confidence: "certain", origin: "runtime", side: "bid", price: 31188, display: 10, tranches: 4, executed: 32, startedAt: 1000, markedAt: 1500, updatedAt: 9000, status: "filled" };
  const page = { available: true, generation: "g", rulesVersion: 1, span: { from: 0, to: 300_000 }, watched: [[0, 100_000], [150_000, 300_000]], icebergs: [iceberg], next: { markedAt: 1500, id: iceberg.id } };
  const options = { fromTs: 0, toTs: 600_000 };

  test("posts the route the way the host accepts it, with the cursor, for both providers, and passes a well-formed page through", async () => {
    const answers = [page, { ...page, next: null }];
    const fetchImpl = jest.fn(async () => jsonResponse(answers.shift()));
    const reader = createRemoteStorageReader({ baseUrl: "http://x", token: "t", fetchImpl, log: () => {} });
    await expect(reader.readIcebergHistory("BTCUSDT", "PERPETUAL", { ...options, limit: 100, after: { markedAt: 1, id: "a" } })).resolves.toEqual(page);
    expect(fetchImpl.mock.calls[0][0]).toBe("http://x/iceberg-history");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ symbol: "BTCUSDT", marketKind: "PERPETUAL", options: { ...options, limit: 100, after: { markedAt: 1, id: "a" } } });
    await expect(reader.readIcebergHistory("/NQZ26:XCME", "FUTURE", options, { provider: "dxfeed" })).resolves.toEqual({ ...page, next: null });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ provider: "dxfeed", symbol: "/NQZ26:XCME", assetClass: "FUTURE", options });
    await reader.close();
  });

  test("an honest unavailable answer passes through; a page without a generation, with a span that is not a pair, an iceberg without an id or a cursor without one, is the unavailable fallback", async () => {
    const answers = [
      { available: false, reason: "NOT_BUILT" },
      { ...page, generation: 7 },
      { ...page, watched: [[1, 2, 3]] },
      { ...page, icebergs: [{ ...iceberg, id: 1 }] },
      { ...page, next: { markedAt: 1 } },
    ];
    const fetchImpl = jest.fn(async () => jsonResponse(answers.shift()));
    const reader = createRemoteStorageReader({ baseUrl: "http://x", token: "t", fetchImpl, log: () => {} });
    await expect(reader.readIcebergHistory("BTCUSDT", "PERPETUAL", options)).resolves.toEqual({ available: false, reason: "NOT_BUILT" });
    for (let i = 0; i < 4; i += 1) await expect(reader.readIcebergHistory("BTCUSDT", "PERPETUAL", options)).resolves.toEqual(FALLBACK_SHAPES["iceberg-history"]());
    await reader.close();
  });
});
