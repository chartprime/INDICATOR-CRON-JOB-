"use strict";

const {
  createRemoteDxFeedStorageReader,
  FALLBACK_SHAPES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  DEFAULT_RATE_LIMIT_BACKOFF_MS,
  MAX_RETRY_AFTER_MS,
  retryAfterMs,
  TIMEOUT_MS_BY_ROUTE,
  MAX_RESPONSE_BYTES_BY_ROUTE,
  DEFAULT_MAX_RESPONSE_BYTES,
} = require("../../../src/storage/dxfeed/remote-dxfeed-storage-reader");
const {
  CONTRACT_VERSION_HEADER,
  CONTRACT_VERSION,
} = require("../../../src/storage/remote-storage-reader");

function jsonResponse(body, { status = 200, contractVersion = CONTRACT_VERSION } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", [CONTRACT_VERSION_HEADER]: contractVersion },
  });
}

describe("createRemoteDxFeedStorageReader", () => {
  test("only the host replay deadline triggers a smaller band, not a generic storage failure", async () => {
    for (const [detail, expected] of [["replay-page-reader: timeout", "READ_TIMEOUT"], ["STORAGE_READ_FAILED", "STORAGE_UNAVAILABLE"]]) {
      const reader = createRemoteDxFeedStorageReader({ baseUrl: "http://host/live-storage", token: "secret", log: () => {}, fetchImpl: async () => jsonResponse({ error: "SERVICE_UNAVAILABLE", detail }, { status: 503 }) });
      const result = await reader.readBandHistory("AAPL", "EQUITY", {});
      expect(result.available).toBe(false);
      expect(result.reason).toBe(expected);
      await reader.close();
    }
  });
test("the volume-profile timeout outlasts the relay's upstream wait plus its byte cap at the measured link rate", () => {
    const { UPSTREAM_TIMEOUT_MS_BY_ROUTE, DEFAULT_UPSTREAM_TIMEOUT_MS } = require("../../../src/server/live-storage-relay");
    const linkBytesPerSecond = 200_000;
    const relayWaitMs = UPSTREAM_TIMEOUT_MS_BY_ROUTE["volume-profile"] ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    const transferMs = ((MAX_RESPONSE_BYTES_BY_ROUTE["volume-profile"] ?? DEFAULT_MAX_RESPONSE_BYTES) / linkBytesPerSecond) * 1_000;
    expect(TIMEOUT_MS_BY_ROUTE["volume-profile"]).toBeGreaterThanOrEqual(relayWaitMs + transferMs);
    expect(DEFAULT_TIMEOUT_MS).toBeLessThan(TIMEOUT_MS_BY_ROUTE["volume-profile"]);
  });

  test("a volume-profile read that runs out of time, on the host or here, says READ_TIMEOUT; another failure, a caller's abort or another route does not", async () => {
    for (const [detail, expected] of [["QUERY_TIMEOUT", "READ_TIMEOUT"], ["STORAGE_READ_FAILED", undefined]]) {
      const reader = createRemoteDxFeedStorageReader({ baseUrl: "http://host/live-storage", token: "secret", log: () => {}, fetchImpl: async () => jsonResponse({ error: "SERVICE_UNAVAILABLE", detail }, { status: 503 }) });
      const result = await reader.readVolumeProfileAsync.bind(null, "AAPL", "EQUITY")({});
      expect(result.available).toBe(false);
      expect(result.reason).toBe(expected);
      await reader.close();
    }
    const elsewhere = createRemoteDxFeedStorageReader({ baseUrl: "http://host/live-storage", token: "secret", log: () => {}, fetchImpl: async () => jsonResponse({ error: "SERVICE_UNAVAILABLE", detail: "QUERY_TIMEOUT" }, { status: 503 }) });
    expect((await elsewhere.readPriceRange.bind(null, "AAPL", "EQUITY")({})).reason).toBeUndefined();
    await elsewhere.close();
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    const hanging = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    const reader = createRemoteDxFeedStorageReader({ baseUrl: "http://host/live-storage", token: "secret", log: () => {}, fetchImpl: hanging });
    try {
      const slow = reader.readVolumeProfileAsync.bind(null, "AAPL", "EQUITY")({});
      await jest.advanceTimersByTimeAsync(TIMEOUT_MS_BY_ROUTE["volume-profile"]);
      expect(await slow).toMatchObject({ available: false, reason: "READ_TIMEOUT" });
      const controller = new AbortController();
      const abandoned = reader.readVolumeProfileAsync.bind(null, "AAPL", "EQUITY")({}, { signal: controller.signal });
      await jest.advanceTimersByTimeAsync(1);
      controller.abort();
      expect((await abandoned).reason).toBeUndefined();
    } finally {
      await reader.close();
      jest.useRealTimers();
    }
  });

  test("queued reads are bounded, expire without fetching, and cancellation frees a queue slot immediately", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    let reader;
    try {
      const fetchImpl = jest.fn((url, { signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
      reader = createRemoteDxFeedStorageReader({ baseUrl: "http://host/live-storage", token: "secret", fetchImpl, log: () => {}, warn: () => {}, maxConcurrentRequests: 1, maxPendingRequests: 1, queueTimeoutMs: 100 });
      const active = reader.readBandHistory("AAPL", "EQUITY", {});
      const controller = new AbortController();
      const queued = reader.readBandHistory("AAPL", "EQUITY", {}, { signal: controller.signal });
      expect(await reader.readBandHistory("AAPL", "EQUITY", {})).toMatchObject({ available: false, reason: "QUEUE_FULL" });
      controller.abort();
      expect(await queued).toMatchObject({ available: false });
      const replacement = reader.readBandHistory("AAPL", "EQUITY", {});
      await jest.advanceTimersByTimeAsync(100);
      expect(await replacement).toMatchObject({ available: false, reason: "QUEUE_TIMEOUT" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await reader.close();
      await active;
    } finally { if (reader) await reader.close(); jest.useRealTimers(); }
  });

  test("non-success diagnostics retain the bounded backend reason and correlation without exposing credentials", async () => {
    const log = jest.fn();
    const reader = createRemoteDxFeedStorageReader({ baseUrl: "http://host/live-storage", token: "secret", log, fetchImpl: jest.fn(async () => jsonResponse({ error: "SERVICE_UNAVAILABLE", detail: "replay-page-reader: timeout secret" }, { status: 503 })) });
    expect(await reader.readBandHistory("AAPL", "EQUITY", {})).toMatchObject({ available: false });
    expect(log).toHaveBeenCalledWith(expect.any(String), "band-history", 503, expect.objectContaining({ correlationId: expect.any(String), error: "SERVICE_UNAVAILABLE", detail: "replay-page-reader: timeout [REDACTED]" }));
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
    await reader.close();
  });
  const READER = createRemoteDxFeedStorageReader;
  const SYMBOL = "/NQZ26:XCME";
  const KIND = "FUTURE";

  test("parses Retry-After defensively and caps hostile delays", () => {
    expect(retryAfterMs("2")).toBe(2_000);
    expect(retryAfterMs("999999")).toBe(MAX_RETRY_AFTER_MS);
    expect(retryAfterMs("invalid")).toBe(DEFAULT_RATE_LIMIT_BACKOFF_MS);
    expect(retryAfterMs(null)).toBe(DEFAULT_RATE_LIMIT_BACKOFF_MS);
    expect(retryAfterMs("Thu, 01 Jan 1970 00:00:02 GMT", 1_000)).toBe(1_000);
  });

  test("a 429 pauses queued reads for Retry-After, then retries the refused read instead of reporting it unavailable", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const fetchImpl = jest.fn()
        .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "2" } }))
        .mockImplementation(async () => jsonResponse({ rows: [], available: true }));
      const warn = jest.fn();
      const reader = createRemoteDxFeedStorageReader({
        baseUrl: "http://host/live-storage", token: "secret", fetchImpl, log: () => {}, warn, maxConcurrentRequests: 1,
        meter: { record: () => {} },
      });
      const first = reader.readLargeTrades("AAPL", "EQUITY", {});
      const second = reader.readLargeTrades("TSLA", "EQUITY", {});
      await jest.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "remote-dxfeed-storage-reader: rate limited, pausing queued reads", "large-trades", { retryAfterMs: 2_000 },
      );
      await jest.advanceTimersByTimeAsync(1_999);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await expect(first).resolves.toEqual({ rows: [], available: true });
      await expect(second).resolves.toEqual({ rows: [], available: true });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      await reader.close();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a 429 honours the body's retryAfterMs, the only hint the gateway used to send", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const fetchImpl = jest.fn()
        .mockResolvedValueOnce(jsonResponse({ error: "OVERLOADED", retryAfterMs: 7_500 }, { status: 429 }))
        .mockResolvedValue(jsonResponse({ rows: [], available: true }));
      const reader = createRemoteDxFeedStorageReader({
        baseUrl: "http://host/live-storage", token: "secret", fetchImpl, log: () => {}, warn: () => {},
        meter: { record: () => {} },
      });
      const read = reader.readLargeTrades("AAPL", "EQUITY", {});
      await jest.advanceTimersByTimeAsync(7_499);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await expect(read).resolves.toEqual({ rows: [], available: true });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      await reader.close();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a read still refused past the retry budget returns the fallback marked RATE_LIMITED", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const fetchImpl = jest.fn(async () => jsonResponse({ error: "OVERLOADED", retryAfterMs: 4_000 }, { status: 429 }));
      const reader = createRemoteDxFeedStorageReader({
        baseUrl: "http://host/live-storage", token: "secret", fetchImpl, log: () => {}, warn: () => {},
        rateLimitRetryBudgetMs: 5_000, meter: { record: () => {} },
      });
      const read = reader.readTradesSince(SYMBOL, KIND, {});
      await jest.advanceTimersByTimeAsync(4_000);
      await expect(read).resolves.toEqual({ ...FALLBACK_SHAPES["trades-since"](), reason: "RATE_LIMITED" });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      await reader.close();
    } finally {
      jest.useRealTimers();
    }
  });

  test("close releases a read waiting out a 429 with the fallback", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ error: "OVERLOADED", retryAfterMs: 30_000 }, { status: 429 }));
    const reader = createRemoteDxFeedStorageReader({
      baseUrl: "http://host/live-storage", token: "secret", fetchImpl, log: () => {}, warn: () => {},
      meter: { record: () => {} },
    });
    const read = reader.readTradesSince(SYMBOL, KIND, {});
    await new Promise((resolve) => setImmediate(resolve));
    await reader.close();
    await expect(read).resolves.toMatchObject({ available: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("every request attempt is counted by the host-read meter with its status", async () => {
    const record = jest.fn();
    const fetchImpl = jest.fn(async () => jsonResponse({ rows: [], nextCursor: null, available: true }));
    const reader = createRemoteDxFeedStorageReader({
      baseUrl: "http://host/live-storage", token: "secret", fetchImpl, log: () => {}, meter: { record },
    });
    await reader.readTradesSince(SYMBOL, KIND, {});
    expect(record).toHaveBeenCalledWith("trades-since", 200);
    await reader.close();
  });

  test("bounds remote fan-out so eager warm-up cannot stampede the host", async () => {
    const releases = [];
    let active = 0;
    let peak = 0;
    const fetchImpl = jest.fn(() => new Promise((resolve) => {
      active += 1;
      peak = Math.max(peak, active);
      releases.push(() => {
        active -= 1;
        resolve(jsonResponse({ rows: [], available: true }));
      });
    }));
    const reader = createRemoteDxFeedStorageReader({
      baseUrl: "http://host/live-storage", token: "secret", fetchImpl, log: () => {},
    });
    const reads = Array.from({ length: 6 }, (_, index) => reader.readLargeTrades(`SYM${index}`, "EQUITY", {}));
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(DEFAULT_MAX_CONCURRENT_REQUESTS);
    while (releases.length > 0 || fetchImpl.mock.calls.length < reads.length) {
      const release = releases.shift();
      if (release) release();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await Promise.all(reads);
    expect(peak).toBe(DEFAULT_MAX_CONCURRENT_REQUESTS);
  });

  test("rejects an invalid remote concurrency limit", () => {
    expect(() => createRemoteDxFeedStorageReader({
      baseUrl: "http://host/live-storage", token: "secret", maxConcurrentRequests: 0,
    })).toThrow(/maxConcurrentRequests/);
  });

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
    expect(Object.keys(TIMEOUT_MS_BY_ROUTE)).toEqual(["recent-candles", "aggressive-prints", "band-history", "volume-profile"]);
    expect(DEFAULT_TIMEOUT_MS).toBeLessThan(TIMEOUT_MS_BY_ROUTE["recent-candles"]);
  });

  // Same measurement as the Binance reader's (2026-09-23): days older than the
  // newest four pass 5 s on the host and were read as STORAGE_UNAVAILABLE.
  test("the print timeout outlasts the relay's upstream wait plus the route's byte cap at the measured link rate", () => {
    const { UPSTREAM_TIMEOUT_MS_BY_ROUTE, DEFAULT_UPSTREAM_TIMEOUT_MS } = require("../../../src/server/live-storage-relay");
    const linkBytesPerSecond = 200_000;
    const relayWaitMs = UPSTREAM_TIMEOUT_MS_BY_ROUTE["aggressive-prints"] ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    const transferMs = ((MAX_RESPONSE_BYTES_BY_ROUTE["aggressive-prints"] ?? DEFAULT_MAX_RESPONSE_BYTES) / linkBytesPerSecond) * 1_000;
    expect(TIMEOUT_MS_BY_ROUTE["aggressive-prints"]).toBeGreaterThanOrEqual(relayWaitMs + transferMs);
    expect(DEFAULT_TIMEOUT_MS).toBeLessThan(TIMEOUT_MS_BY_ROUTE["aggressive-prints"]);
  });

  test("the band-history timeout outlasts the relay's upstream wait plus its byte cap at the measured link rate", () => {
    const { UPSTREAM_TIMEOUT_MS_BY_ROUTE, DEFAULT_UPSTREAM_TIMEOUT_MS } = require("../../../src/server/live-storage-relay");
    const linkBytesPerSecond = 200_000;
    const relayWaitMs = UPSTREAM_TIMEOUT_MS_BY_ROUTE["band-history"] ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    const transferMs = ((MAX_RESPONSE_BYTES_BY_ROUTE["band-history"] ?? DEFAULT_MAX_RESPONSE_BYTES) / linkBytesPerSecond) * 1_000;
    expect(MAX_RESPONSE_BYTES_BY_ROUTE["band-history"]).toBeGreaterThanOrEqual(4_000_000);
    expect(TIMEOUT_MS_BY_ROUTE["band-history"]).toBeGreaterThanOrEqual(relayWaitMs + transferMs);
    expect(DEFAULT_TIMEOUT_MS).toBeLessThan(TIMEOUT_MS_BY_ROUTE["band-history"]);
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

  test("sends provider and dxFeed identity fields and preserves the native candle shape", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({
      rows: [{ ts_open: 1 }], available: true, startsAtRequestedWindow: true,
    }));
    const reader = createRemoteDxFeedStorageReader({ baseUrl: "http://host/live-storage/", token: "secret", fetchImpl });
    await expect(reader.readRecentCandles("AAPL", "EQUITY", { windowMs: 60_000, nowMs: 120_000 })).resolves.toEqual({
      rows: [{ ts_open: 1 }], available: true, startsAtRequestedWindow: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://host/live-storage/recent-candles",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: expect.objectContaining({
          authorization: "Bearer secret",
          "content-type": "application/json",
          [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION,
          "x-terminal-correlation-id": expect.stringMatching(/^[0-9a-f-]{36}$/),
        }),
        body: JSON.stringify({
          provider: "dxfeed", symbol: "AAPL", assetClass: "EQUITY",
          options: { windowMs: 60_000, nowMs: 120_000 },
        }),
      }),
    );
  });

  describe("time-covered large trades against the host relay's 2 MB cap", () => {
    // The host returns every bucket's top prints over the whole window with no row limit, about 564 bytes a row, and
    // its relay refuses a body over 2 MB (live 2026-09-23: NQ 1-day and 7-day windows both 503 UPSTREAM_BODY_TOO_LARGE,
    // so no dxFeed instrument ever warmed its large-trade markers).
    const MINUTE = 60_000;
    const NOW = 1_790_174_880_000;
    const RELAY_CAP = 2_000_000;
    const PAD = "x".repeat(420);

    function hostFetch({ failSlice = null } = {}) {
      const requests = [];
      const fetchImpl = jest.fn(async (_url, init) => {
        const { options } = JSON.parse(init.body);
        requests.push(options);
        if (failSlice !== null && requests.length === failSlice) return new Response("", { status: 503 });
        const rows = [];
        for (let bucket = Math.ceil(options.fromMs / options.bucketMs) * options.bucketMs; bucket <= options.nowMs; bucket += options.bucketMs) {
          for (let i = 0; i < 2 * options.perBucketSideLimit; i += 1) rows.push({ row: { id: bucket + i, event_time: bucket + i, size: 3, pad: PAD } });
        }
        const body = JSON.stringify({ rows, available: true });
        if (body.length > RELAY_CAP) {
          return jsonResponse({ error: "READER_UNAVAILABLE", detail: "UPSTREAM_BODY_TOO_LARGE" }, { status: 503 });
        }
        return new Response(body, { status: 200, headers: { "content-type": "application/json", [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION } });
      });
      return { fetchImpl, requests };
    }

    const options = { nowMs: NOW, limit: 5_000, fromMs: NOW - 7 * 24 * 60 * MINUTE, bucketMs: MINUTE, perBucketSideLimit: 4 };

    test("reads a week of dense markers in newest-first slices that each fit under the cap, up to the limit", async () => {
      const { fetchImpl, requests } = hostFetch();
      const reader = createRemoteDxFeedStorageReader({ baseUrl: "http://host/live-storage", token: "secret", fetchImpl, log: () => {} });
      const result = await reader.readLargeTradesAsync(SYMBOL, KIND, options);
      expect(result.available).toBe(true);
      expect(result.rows.length).toBeGreaterThanOrEqual(options.limit);
      const times = result.rows.map(({ row }) => row.event_time);
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(requests[0].nowMs).toBe(NOW);
      for (let i = 1; i < requests.length; i += 1) expect(requests[i].nowMs).toBe(requests[i - 1].fromMs - 1);
      for (const request of requests) expect(request.fromMs % MINUTE === 0 || request.fromMs === options.fromMs).toBe(true);
      expect(requests.length).toBeLessThan(10);
    });

    test("keeps what earlier slices returned when a later one fails, and falls back when the first does", async () => {
      const partial = hostFetch({ failSlice: 2 });
      const reader = createRemoteDxFeedStorageReader({ baseUrl: "http://host/live-storage", token: "secret", fetchImpl: partial.fetchImpl, log: () => {} });
      const kept = await reader.readLargeTradesAsync(SYMBOL, KIND, options);
      expect(kept.available).toBe(true);
      expect(kept.rows.length).toBeGreaterThan(0);
      const failed = hostFetch({ failSlice: 1 });
      const second = createRemoteDxFeedStorageReader({ baseUrl: "http://host/live-storage", token: "secret", fetchImpl: failed.fetchImpl, log: () => {} });
      await expect(second.readLargeTradesAsync(SYMBOL, KIND, options)).resolves.toEqual(FALLBACK_SHAPES["large-trades"]());
    });
  });

  test("sends eventType only inside bounded recent-events options", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ rows: [{ id: 1 }], available: true }));
    const reader = createRemoteDxFeedStorageReader({ baseUrl: "http://host/live-storage", token: "secret", fetchImpl });
    await expect(reader.readRecent("/NQZ26:XCME", "FUTURE", "TIMEANDSALE", { limit: 100 })).resolves.toEqual({
      rows: [{ id: 1 }], available: true,
    });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      provider: "dxfeed", symbol: "/NQZ26:XCME", assetClass: "FUTURE",
      options: { limit: 100, eventType: "TIMEANDSALE" },
    });
  });

  test("readTradesSince sends fromTs/toTs/cursor/limit and preserves the nextCursor shape", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({
      rows: [{ id: 1 }], nextCursor: { ts: 1_000, id: 7 }, available: true,
    }));
    const reader = createRemoteDxFeedStorageReader({ baseUrl: "http://host/live-storage", token: "secret", fetchImpl });
    const options = { fromTs: 0, toTs: 3_600_000, cursor: { ts: 500, id: 3 }, limit: 100 };
    await expect(reader.readTradesSince("AAPL", "EQUITY", options)).resolves.toEqual({
      rows: [{ id: 1 }], nextCursor: { ts: 1_000, id: 7 }, available: true,
    });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      provider: "dxfeed", symbol: "AAPL", assetClass: "EQUITY", options,
    });
  });

  test.each([
    ["recent-events", "readRecent", ["AAPL", "EQUITY", "TIMEANDSALE", {}]],
    ["recent-candles", "readRecentCandles", ["AAPL", "EQUITY", {}]],
    ["large-trades", "readLargeTrades", ["AAPL", "EQUITY", {}]],
    ["aggressive-prints", "readAggressivePrints", ["AAPL", "EQUITY", {}]],
    ["volume-profile", "readVolumeProfile", ["AAPL", "EQUITY", {}]],
    ["price-range", "readPriceRange", ["AAPL", "EQUITY", {}]],
    ["minute-rollup", "readMinuteRollup", ["AAPL", "EQUITY", {}]],
    ["daily-notional", "readDailyNotional", ["AAPL", "EQUITY", {}]],
    ["sliced-notional", "readSlicedNotional", ["AAPL", "EQUITY", {}]],
    ["trades-since", "readTradesSince", ["AAPL", "EQUITY", { fromTs: 0, toTs: 1, cursor: null, limit: 100 }]],
  ])("%s returns its exact fallback after transport failure", async (route, method, args) => {
    const reader = createRemoteDxFeedStorageReader({
      baseUrl: "http://host/live-storage", token: "secret", log: () => {},
      fetchImpl: jest.fn(async () => { throw new Error("down"); }),
    });
    await expect(reader[method](...args)).resolves.toEqual(FALLBACK_SHAPES[route]());
  });

  test("rejects the Binance candle response shape", async () => {
    const reader = createRemoteDxFeedStorageReader({
      baseUrl: "http://host/live-storage", token: "secret", log: () => {},
      fetchImpl: jest.fn(async () => jsonResponse({ rows: [], coversFullWindow: true })),
    });
    await expect(reader.readRecentCandles("AAPL", "EQUITY", {})).resolves.toEqual({
      rows: [], available: false, startsAtRequestedWindow: false,
    });
  });

  test("rejects a malformed trades-since nextCursor (partial or wrong-typed) as an unavailable fallback", async () => {
    for (const nextCursor of [{ ts: 1 }, { ts: "1", id: 2 }, "not-an-object"]) {
      const reader = createRemoteDxFeedStorageReader({
        baseUrl: "http://host/live-storage", token: "secret", log: () => {},
        fetchImpl: jest.fn(async () => jsonResponse({ rows: [], nextCursor, available: true })),
      });
      await expect(reader.readTradesSince("AAPL", "EQUITY", { fromTs: 0, toTs: 1, cursor: null, limit: 100 }))
        .resolves.toEqual({ rows: [], nextCursor: null, available: false });
    }
  });

  test("close aborts an in-flight read and prevents future network calls", async () => {
    let signal;
    const fetchImpl = jest.fn((url, init) => {
      signal = init.signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    });
    const reader = createRemoteDxFeedStorageReader({
      baseUrl: "http://host/live-storage", token: "secret", timeoutMs: 10_000, fetchImpl, log: () => {},
    });
    const pending = reader.readLargeTrades("AAPL", "EQUITY", {});
    await Promise.resolve();
    await reader.close();
    expect(signal.aborted).toBe(true);
    await expect(pending).resolves.toEqual({ rows: [], available: false });
    await expect(reader.readLargeTrades("AAPL", "EQUITY", {})).resolves.toEqual({ rows: [], available: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("an aggressive-history caller can abort the underlying network request", async () => {
    let networkSignal;
    const fetchImpl = jest.fn((_url, init) => {
      networkSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
    });
    const reader = createRemoteDxFeedStorageReader({
      baseUrl: "http://host/live-storage", token: "secret", timeoutMs: 10_000, fetchImpl, log: () => {},
    });
    const controller = new AbortController();
    const pending = reader.readAggressivePrintsAsync("AAPL", "EQUITY", {}, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(pending).resolves.toEqual({ rows: [], available: false, hasMore: false, nextCursor: null });
    expect(networkSignal.aborted).toBe(true);
  });
});

describe("createRemoteDxFeedStorageReader band-history", () => {
  test("readBandHistory posts to the band-history route and returns the host's columns; a wrong shape or a failure is the unavailable fallback", async () => {
    const body = { available: true, rowWidth: 4, rowLo: 20_000, rowHi: 20_002, columnMs: 10_000, columns: [{ ts: 10_000, bid: [1, 2, 3], ask: [0, 0, 0], buy: [0, 0, 0], sell: [0, 1, 0] }], frames: 9, reason: null };
    const fetchImpl = jest.fn(async () => jsonResponse(body));
    const reader = createRemoteDxFeedStorageReader({ baseUrl: "http://x", token: "t", fetchImpl, log: () => {} });
    const options = { fromTs: 0, toTs: 60_000, tickSize: 0.01, clusterTicks: 100, rowClusters: 4, priceLo: 80_000, priceHi: 80_010, columnMs: 10_000 };
    await expect(reader.readBandHistory("AAPL", "EQUITY", options)).resolves.toEqual(body);
    expect(fetchImpl.mock.calls[0][0]).toBe("http://x/band-history");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ symbol: "AAPL", options });
    const wrong = createRemoteDxFeedStorageReader({ baseUrl: "http://x", token: "t", log: () => {}, fetchImpl: jest.fn(async () => jsonResponse({ available: true, columns: "no" })) });
    await expect(wrong.readBandHistory("AAPL", "EQUITY", options)).resolves.toEqual({ columns: [], available: false, reason: "STORAGE_UNAVAILABLE" });
    await reader.close();
    await wrong.close();
  });
});
