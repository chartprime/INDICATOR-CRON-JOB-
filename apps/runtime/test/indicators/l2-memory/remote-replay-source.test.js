const { createSource, validFrame, MAX_PAGES } = require("../../../src/indicators/l2-memory/remote-replay-source");

const T = 1_700_000_000_000;
const FRAME = { kind: "trade", ts: T, price: 100, size: 2, side: "buy", tradeId: "1" };

function response(body, status = 200, version = "live-storage/1") {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-live-storage-contract-version": version },
  });
}

async function drain(source) {
  const frames = [];
  for await (const frame of source.frames()) frames.push(frame);
  return frames;
}

describe("remote-replay-source", () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  test("walks authenticated pages and keeps the token out of frames and stats", async () => {
    const calls = [];
    global.fetch = jest.fn(async (url, request) => {
      calls.push({ url, request, body: JSON.parse(request.body) });
      return calls.length === 1
        ? response({ frames: [FRAME], complete: false, nextCursor: "signed.cursor", stats: {} })
        : response({ frames: [{ ...FRAME, ts: T + 1, tradeId: "2" }], complete: true, nextCursor: null, stats: {} });
    });
    const source = createSource({
      symbol: "BTCUSDT", marketKind: "PERPETUAL", fromTs: T, toTs: T + 1,
      tickSize: 0.1, clusterTicks: 2, rowClusters: 3, windowRows: 4,
      remote: { baseUrl: "https://storage.example/live-storage/", token: "secret-token" },
    });
    const frames = [];
    for await (const frame of source.frames()) frames.push(frame);
    expect(frames).toEqual([FRAME, { ...FRAME, ts: T + 1, tradeId: "2" }]);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://storage.example/live-storage/replay-page");
    expect(calls[0].request.headers.authorization).toBe("Bearer secret-token");
    expect(calls[0].request.headers["x-terminal-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0].body.options.cursor).toBeNull();
    expect(calls[1].body.options.cursor).toBe("signed.cursor");
    expect(calls.map((call) => call.body.options.bookMode)).toEqual(["sparse", "sparse"]);
    expect(JSON.stringify({ frames, stats: source.stats })).not.toContain("secret-token");
    expect(source.stats).toEqual({ pages: 2, frames: 2, bookMode: "sparse" });
  });

  test("a host that does not know bookMode is asked again for full books, once, and the mode is recorded", async () => {
    const calls = [];
    global.fetch = jest.fn(async (_url, request) => {
      const body = JSON.parse(request.body);
      calls.push(body.options);
      if (body.options.bookMode !== undefined) {
        return response({ error: "MALFORMED_REQUEST", detail: "UNKNOWN_OPTIONS:bookMode" }, 400);
      }
      return calls.length === 2
        ? response({ frames: [FRAME], complete: false, nextCursor: "c1", stats: {} })
        : response({ frames: [], complete: true, nextCursor: null, stats: {} });
    });
    const source = createSource({
      symbol: "BTCUSDT", marketKind: "SPOT", fromTs: T, toTs: T + 1, tickSize: 0.01,
      clusterTicks: 1, rowClusters: 1, windowRows: 1, remote: { baseUrl: "https://x", token: "y" },
    });
    expect(await drain(source)).toEqual([FRAME]);
    expect(calls.map((options) => options.bookMode)).toEqual(["sparse", undefined, undefined]);
    expect(source.stats).toEqual({ pages: 2, frames: 1, bookMode: "full" });
  });

  test("any other 400 is a failure, not a reason to retry", async () => {
    global.fetch = jest.fn(async () => response({ error: "MALFORMED_REQUEST", detail: "UNKNOWN_OPTIONS:somethingElse" }, 400));
    const source = createSource({
      symbol: "BTCUSDT", marketKind: "SPOT", fromTs: T, toTs: T, tickSize: 0.01,
      clusterTicks: 1, rowClusters: 1, windowRows: 1, remote: { baseUrl: "https://x", token: "y" },
    });
    await expect(drain(source)).rejects.toThrow(/HTTP_400/);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test("a book frame may carry the whole book or only its best prices, never a half of each", () => {
    const base = { kind: "book", ts: T, status: "READY", delta: { bids: [["100", "1"]], asks: [] } };
    expect(validFrame({ ...base, book: { lastUpdateId: 7, bids: [["100", "1"]], asks: [["101", "2"]] } })).toBe(true);
    expect(validFrame({ ...base, book: { lastUpdateId: 7, bestBid: "100", bestAsk: "101" } })).toBe(true);
    expect(validFrame({ ...base, book: { bestBid: null, bestAsk: null } })).toBe(true);
    expect(validFrame({ ...base, book: { bestBid: "0", bestAsk: "101" } })).toBe(false);
    expect(validFrame({ ...base, book: { bestBid: "100", bestAsk: "nope" } })).toBe(false);
    expect(validFrame({ ...base, book: { bids: [["100", "1"]] } })).toBe(false);
    expect(validFrame({ ...base, book: {} })).toBe(false);
  });

  test("uses the dxFeed identity fields", async () => {
    global.fetch = jest.fn(async (_url, request) => {
      expect(JSON.parse(request.body)).toMatchObject({ provider: "dxfeed", assetClass: "FUTURE", symbol: "/NQZ26:XCME" });
      return response({ frames: [], complete: true, nextCursor: null, stats: {} });
    });
    const source = createSource({
      symbol: "/NQZ26:XCME", marketKind: "FUTURE", fromTs: T, toTs: T,
      tickSize: 0.25, clusterTicks: 1, rowClusters: 1, windowRows: 10,
      remote: { baseUrl: "https://storage.example/live-storage", token: "x" },
    });
    await drain(source);
  });

  test("rejects malformed pages, contract mismatches, stalled cursors, and excess pages", async () => {
    expect(validFrame({ ...FRAME, ts: -1 })).toBe(false);
    global.fetch = jest.fn(async () => response({ frames: [{}], complete: true, nextCursor: null, stats: {} }));
    const options = {
      symbol: "BTCUSDT", marketKind: "SPOT", fromTs: T, toTs: T, tickSize: 0.01,
      clusterTicks: 1, rowClusters: 1, windowRows: 1, remote: { baseUrl: "https://x", token: "y" },
    };
    await expect(drain(createSource(options))).rejects.toThrow(/PAGE_INVALID/);
    global.fetch = jest.fn(async () => response({ frames: [], complete: true, nextCursor: null }, 200, "wrong"));
    await expect(drain(createSource(options))).rejects.toThrow(/CONTRACT_MISMATCH/);
    global.fetch = jest.fn(async () => response({ frames: [], complete: false, nextCursor: "same", stats: {} }));
    await expect(drain(createSource(options))).rejects.toThrow(/CURSOR_STALLED/);
    expect(MAX_PAGES).toBeLessThanOrEqual(2_048);
  });

  test("close aborts an in-flight page", async () => {
    global.fetch = jest.fn((_url, request) => new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const source = createSource({
      symbol: "BTCUSDT", marketKind: "SPOT", fromTs: T, toTs: T, tickSize: 0.01,
      clusterTicks: 1, rowClusters: 1, windowRows: 1, remote: { baseUrl: "https://x", token: "y", timeoutMs: 60_000 },
    });
    const pending = source.frames().next();
    source.close();
    await expect(pending).rejects.toThrow(/aborted/i);
  });

  describe("a 429 mid-chunk (Block 8: an ES deep chunk was skipped on REMOTE_REPLAY_HTTP_429)", () => {
    const base = {
      symbol: "/ESZ26:XCME", marketKind: "FUTURE", fromTs: T, toTs: T + 1, tickSize: 0.25,
      clusterTicks: 1, rowClusters: 1, windowRows: 1,
    };

    test("waits the host's retryAfterMs and asks for the same cursor again, so the chunk completes", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick"] });
      try {
        const cursors = [];
        let calls = 0;
        const fetchImpl = jest.fn(async (_url, request) => {
          calls += 1;
          cursors.push(JSON.parse(request.body).options.cursor);
          if (calls === 1) return response({ frames: [FRAME], complete: false, nextCursor: "c1", stats: {} });
          if (calls === 2) return response({ error: "OVERLOADED", retryAfterMs: 5_000 }, 429);
          return response({ frames: [{ ...FRAME, ts: T + 1, tradeId: "2" }], complete: true, nextCursor: null, stats: {} });
        });
        const source = createSource({ ...base, remote: { baseUrl: "https://x", token: "y" }, fetchImpl, meter: { record: () => {} } });
        const drained = drain(source);
        await jest.advanceTimersByTimeAsync(4_999);
        expect(calls).toBe(2);
        await jest.advanceTimersByTimeAsync(1);
        await expect(drained).resolves.toHaveLength(2);
        expect(cursors).toEqual([null, "c1", "c1"]);
        expect(source.stats.rateLimitedMs).toBe(5_000);
      } finally {
        jest.useRealTimers();
      }
    });

    test("gives up with REMOTE_REPLAY_HTTP_429 only after the wait budget is spent", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick"] });
      try {
        const fetchImpl = jest.fn(async () => response({ error: "OVERLOADED", retryAfterMs: 30_000 }, 429));
        const source = createSource({
          ...base, remote: { baseUrl: "https://x", token: "y", rateLimitBudgetMs: 45_000 }, fetchImpl, meter: { record: () => {} },
        });
        const drained = drain(source);
        const outcome = expect(drained).rejects.toThrow("REMOTE_REPLAY_HTTP_429");
        await jest.advanceTimersByTimeAsync(30_000);
        await outcome;
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    test("close ends a wait at once", async () => {
      const fetchImpl = jest.fn(async () => response({ error: "OVERLOADED", retryAfterMs: 50_000 }, 429));
      const source = createSource({ ...base, remote: { baseUrl: "https://x", token: "y" }, fetchImpl, meter: { record: () => {} } });
      const pending = source.frames().next();
      await new Promise((resolve) => setImmediate(resolve));
      source.close();
      await expect(pending).rejects.toThrow(/closed/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  describe("a transient 503 mid-chunk", () => {
    const base = {
      symbol: "AAPL", marketKind: "EQUITY", fromTs: T, toTs: T + 1, tickSize: 0.01,
      clusterTicks: 1, rowClusters: 1, windowRows: 1,
    };

    test("retries the same cursor after a bounded wait and keeps both pages", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick"] });
      try {
        const cursors = [];
        const fetchImpl = jest.fn(async (_url, request) => {
          cursors.push(JSON.parse(request.body).options.cursor);
          if (cursors.length === 1) return response({ frames: [FRAME], complete: false, nextCursor: "c1" });
          if (cursors.length === 2) return response({ error: "OVERLOADED", retryAfterMs: 100 }, 503);
          return response({ frames: [{ ...FRAME, ts: T + 1 }], complete: true, nextCursor: null });
        });
        const source = createSource({ ...base, remote: { baseUrl: "https://x", token: "y" }, fetchImpl, meter: { record: () => {} } });
        const drained = drain(source);
        await jest.advanceTimersByTimeAsync(999);
        expect(cursors).toEqual([null, "c1"]);
        await jest.advanceTimersByTimeAsync(1);
        await expect(drained).resolves.toHaveLength(2);
        expect(cursors).toEqual([null, "c1", "c1"]);
      } finally {
        jest.useRealTimers();
      }
    });

    test("stops retrying when the transient-wait budget is exhausted", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick"] });
      try {
        const fetchImpl = jest.fn(async () => response({ error: "UNAVAILABLE" }, 503));
        const source = createSource({ ...base, remote: { baseUrl: "https://x", token: "y", rateLimitBudgetMs: 1_500 }, fetchImpl, meter: { record: () => {} } });
        const drained = drain(source);
        const outcome = expect(drained).rejects.toThrow("REMOTE_REPLAY_HTTP_503");
        await jest.advanceTimersByTimeAsync(1_000);
        await outcome;
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
