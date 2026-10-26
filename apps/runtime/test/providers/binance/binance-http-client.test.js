const {
  fetchDepthSnapshot,
  fetchKlines,
  fetchExchangeInfo,
  MAX_KLINES_PER_REQUEST,
  parseRetryAfterMs,
} = require("../../../src/providers/binance/binance-http-client");

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("binance-http-client fetchDepthSnapshot", () => {
  test("rejects an unrecognized or missing market kind before any network call", async () => {
    const fetchImpl = jest.fn();
    await expect(fetchDepthSnapshot("COIN_M", "BTCUSDT", { fetchImpl })).rejects.toThrow(
      /unrecognized/,
    );
    await expect(fetchDepthSnapshot(undefined, "BTCUSDT", { fetchImpl })).rejects.toThrow(
      /missing/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects an unrecognized or missing symbol before any network call", async () => {
    const fetchImpl = jest.fn();
    await expect(fetchDepthSnapshot("SPOT", "DOGEUSDT", { fetchImpl })).rejects.toThrow(
      /unrecognized/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("builds the correct spot depth-snapshot request URL", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ lastUpdateId: 1, bids: [], asks: [] }));
    await fetchDepthSnapshot("SPOT", "BTCUSDT", { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=5000",
      expect.objectContaining({ method: "GET" }),
    );
  });

  test("never follows a redirect silently, rejecting it at the fetch layer instead", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ lastUpdateId: 1, bids: [], asks: [] }));
    await fetchDepthSnapshot("SPOT", "BTCUSDT", { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: "error" }),
    );
  });

  test("builds the correct USD-M depth-snapshot request URL", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ lastUpdateId: 1, bids: [], asks: [] }));
    await fetchDepthSnapshot("PERPETUAL", "ETHUSDT", { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://fapi.binance.com/fapi/v1/depth?symbol=ETHUSDT&limit=1000",
      expect.objectContaining({ method: "GET" }),
    );
  });

  test("returns the parsed body on a 2xx response", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse(
        { lastUpdateId: 42, bids: [["100.00", "1.0"]], asks: [] },
        { headers: { "x-mbx-used-weight-1m": "5" } },
      ),
    );
    const result = await fetchDepthSnapshot("SPOT", "BTCUSDT", { fetchImpl });
    expect(result).toEqual({
      ok: true,
      value: {
        status: 200,
        headers: { "content-type": "text/plain;charset=UTF-8", "x-mbx-used-weight-1m": "5" },
        body: { lastUpdateId: 42, bids: [["100.00", "1.0"]], asks: [] },
      },
    });
  });

  test("classifies a 429 as RATE_LIMITED and surfaces a real Retry-After header as retryAfterMs", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ msg: "too many requests" }, { status: 429, headers: { "retry-after": "30" } }),
    );
    const result = await fetchDepthSnapshot("SPOT", "BTCUSDT", { fetchImpl });
    expect(result).toEqual({ ok: false, reason: "RATE_LIMITED", retryAfterMs: 30_000 });
  });

  test("classifies a 418 as RATE_LIMITED the same way as 429, with no retryAfterMs when the header is absent", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({}, { status: 418 }));
    const result = await fetchDepthSnapshot("SPOT", "BTCUSDT", { fetchImpl });
    expect(result).toEqual({ ok: false, reason: "RATE_LIMITED" });
    expect(result.retryAfterMs).toBeUndefined();
  });

  test("cancels an unsuccessful response body before returning its failure classification", async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("too many requests"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await fetchDepthSnapshot("SPOT", "BTCUSDT", {
      fetchImpl: async () => new Response(stream, { status: 429 }),
    });
    expect(result).toEqual({ ok: false, reason: "RATE_LIMITED" });
    expect(cancelled).toBe(true);
  });

  test("supports the HTTP-date Retry-After form as well as Binance's integer-seconds form", () => {
    const nowMs = Date.parse("Wed, 21 Oct 2026 07:27:00 GMT");
    expect(parseRetryAfterMs({ "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }, nowMs)).toBe(60_000);
  });

  test("ignores a malformed Retry-After header rather than propagating garbage", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({}, { status: 429, headers: { "retry-after": "not-a-deadline" } }),
    );
    const result = await fetchDepthSnapshot("SPOT", "BTCUSDT", { fetchImpl });
    expect(result).toEqual({ ok: false, reason: "RATE_LIMITED" });
    expect(result.retryAfterMs).toBeUndefined();
  });

  test("classifies an unrelated non-2xx status as HTTP_ERROR", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({}, { status: 500 }));
    const result = await fetchDepthSnapshot("SPOT", "BTCUSDT", { fetchImpl });
    expect(result).toEqual({ ok: false, reason: "HTTP_ERROR" });
  });

  test("rejects a response once its streamed byte total exceeds the ceiling, without buffering it whole", async () => {
    const bigChunk = new Uint8Array(1024).fill(65);
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(bigChunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = jest.fn(async () => new Response(stream, { status: 200 }));
    const result = await fetchDepthSnapshot("SPOT", "BTCUSDT", {
      fetchImpl,
      maxResponseBytes: 2048,
    });
    expect(result).toEqual({ ok: false, reason: "RESPONSE_TOO_LARGE" });
    expect(cancelled).toBe(true);
  });

  test("accepts a response body exactly at maxResponseBytes, the boundary-exact case", async () => {
    const body = JSON.stringify({ lastUpdateId: 1, bids: [], asks: [] });
    const bodyBytes = new TextEncoder().encode(body);
    const fetchImpl = jest.fn(async () => new Response(bodyBytes, { status: 200 }));
    const result = await fetchDepthSnapshot("SPOT", "BTCUSDT", {
      fetchImpl,
      maxResponseBytes: bodyBytes.length,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects a stream chunk that is not a genuine Uint8Array rather than reading through it", async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue("not-a-uint8array");
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = jest.fn(async () => new Response(stream, { status: 200 }));
    const result = await fetchDepthSnapshot("SPOT", "BTCUSDT", { fetchImpl });
    expect(result).toEqual({ ok: false, reason: "INVALID_RESPONSE" });
    expect(cancelled).toBe(true);
  });

  test("reports MALFORMED_RESPONSE_BODY for a body that is not valid JSON", async () => {
    const fetchImpl = jest.fn(
      async () => new Response("not json", { status: 200 }),
    );
    const result = await fetchDepthSnapshot("SPOT", "BTCUSDT", { fetchImpl });
    expect(result).toEqual({ ok: false, reason: "MALFORMED_RESPONSE_BODY" });
  });

  test("reports MALFORMED_RESPONSE_BODY for a body that is not valid UTF-8", async () => {
    const invalidUtf8 = new Uint8Array([0xff, 0xfe, 0xfd]);
    const fetchImpl = jest.fn(async () => new Response(invalidUtf8, { status: 200 }));
    const result = await fetchDepthSnapshot("SPOT", "BTCUSDT", { fetchImpl });
    expect(result).toEqual({ ok: false, reason: "MALFORMED_RESPONSE_BODY" });
  });

  test("rejects a genuine Response with no body stream (e.g. an empty 200) as INVALID_RESPONSE", async () => {
    const fetchImpl = jest.fn(async () => new Response(null, { status: 200 }));
    const result = await fetchDepthSnapshot("SPOT", "BTCUSDT", { fetchImpl });
    expect(result).toEqual({ ok: false, reason: "INVALID_RESPONSE" });
  });

  test("rejects a plain object masquerading as a Response outright", async () => {
    const fetchImpl = jest.fn(async () => ({
      status: 200,
      headers: new Headers(),
      body: null,
    }));
    const result = await fetchDepthSnapshot("SPOT", "BTCUSDT", { fetchImpl });
    expect(result).toEqual({ ok: false, reason: "INVALID_RESPONSE" });
  });

  test("rejects a Proxy-wrapped Response outright", async () => {
    const fetchImpl = jest.fn(async () => new Proxy(jsonResponse({}), {}));
    const result = await fetchDepthSnapshot("SPOT", "BTCUSDT", { fetchImpl });
    expect(result).toEqual({ ok: false, reason: "INVALID_RESPONSE" });
  });

  test("reports NETWORK_ERROR when fetchImpl rejects for a non-abort reason", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const result = await fetchDepthSnapshot("SPOT", "BTCUSDT", { fetchImpl });
    expect(result).toEqual({ ok: false, reason: "NETWORK_ERROR" });
  });

  test("reports FETCH_UNAVAILABLE when no fetch implementation is provided", async () => {
    // null, not undefined -- an undefined fetchImpl falls back to the
    // default-parameter value (globalThis.fetch), which is the desired
    // production behavior; null is how a caller explicitly signals "no
    // fetch is available" (e.g. an older runtime with no global fetch).
    const result = await fetchDepthSnapshot("SPOT", "BTCUSDT", { fetchImpl: null });
    expect(result).toEqual({ ok: false, reason: "FETCH_UNAVAILABLE" });
  });

  test("times out a never-settling request", async () => {
    jest.useFakeTimers();
    try {
      let fetchInvoked;
      const fetchInvokedPromise = new Promise((resolve) => {
        fetchInvoked = resolve;
      });
      const fetchImpl = jest.fn(() => {
        fetchInvoked();
        return new Promise(() => {});
      });

      const resultPromise = fetchDepthSnapshot("SPOT", "BTCUSDT", {
        fetchImpl,
        timeoutMs: 5000,
      });
      await fetchInvokedPromise;
      await jest.advanceTimersByTimeAsync(5000);

      await expect(resultPromise).resolves.toEqual({ ok: false, reason: "TIMEOUT" });
    } finally {
      jest.useRealTimers();
    }
  });

  test("aborts the underlying fetch signal on timeout", async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = jest.fn(
        (url, { signal }) =>
          new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => {
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          }),
      );

      const resultPromise = fetchDepthSnapshot("SPOT", "BTCUSDT", {
        fetchImpl,
        timeoutMs: 5000,
      });
      await jest.advanceTimersByTimeAsync(5000);

      await expect(resultPromise).resolves.toEqual({ ok: false, reason: "TIMEOUT" });
    } finally {
      jest.useRealTimers();
    }
  });

  test("a completed fetch does not later abort after the deadline would have fired", async () => {
    jest.useFakeTimers();
    try {
      let capturedSignal;
      const fetchImpl = jest.fn(async (_url, { signal }) => {
        capturedSignal = signal;
        return jsonResponse({ lastUpdateId: 1, bids: [], asks: [] });
      });
      const result = await fetchDepthSnapshot("SPOT", "BTCUSDT", {
        fetchImpl,
        timeoutMs: 5000,
      });
      expect(result.ok).toBe(true);
      expect(capturedSignal.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(10_000);
      expect(capturedSignal.aborted).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

function klineRow(openTime) {
  return [openTime, "100.00", "101.00", "99.00", "100.50", "12.5", openTime + 59_999, "1250.00", 42, "6.0", "600.0", "0"];
}

describe("binance-http-client fetchKlines", () => {
  // fetchKlines shares fetchDepthSnapshot's own timedGetJson/
  // performGetRequest plumbing (timeout, abort, streaming, malformed
  // JSON, rate-limit classification, hostile-Response rejection --
  // already exhaustively covered above). These tests only cover what's
  // actually new: URL construction and fetchKlines' own input
  // validation, plus one passthrough check that the shared path is
  // really wired in, not a from-scratch relitigation of every mechanic.

  test("rejects an unrecognized or missing market kind before any network call", async () => {
    const fetchImpl = jest.fn();
    await expect(
      fetchKlines("COIN_M", "BTCUSDT", { interval: "1m", startTime: 0, fetchImpl }),
    ).rejects.toThrow(/unrecognized/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects an unrecognized or missing symbol before any network call", async () => {
    const fetchImpl = jest.fn();
    await expect(
      fetchKlines("SPOT", "DOGEUSDT", { interval: "1m", startTime: 0, fetchImpl }),
    ).rejects.toThrow(/unrecognized/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects a missing or empty interval before any network call", async () => {
    const fetchImpl = jest.fn();
    await expect(fetchKlines("SPOT", "BTCUSDT", { startTime: 0, fetchImpl })).rejects.toThrow(/interval/);
    await expect(fetchKlines("SPOT", "BTCUSDT", { interval: "", startTime: 0, fetchImpl })).rejects.toThrow(
      /interval/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects an unsupported interval before any network call", async () => {
    const fetchImpl = jest.fn();
    await expect(
      fetchKlines("SPOT", "BTCUSDT", { interval: "3m", startTime: 0, fetchImpl }),
    ).rejects.toThrow(/allowed Binance candle interval/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects a missing, negative, or non-integer startTime before any network call", async () => {
    const fetchImpl = jest.fn();
    await expect(fetchKlines("SPOT", "BTCUSDT", { interval: "1m", fetchImpl })).rejects.toThrow(/startTime/);
    await expect(fetchKlines("SPOT", "BTCUSDT", { interval: "1m", startTime: -1, fetchImpl })).rejects.toThrow(
      /startTime/,
    );
    await expect(fetchKlines("SPOT", "BTCUSDT", { interval: "1m", startTime: 1.5, fetchImpl })).rejects.toThrow(
      /startTime/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects a limit of zero, negative, non-integer, or above MAX_KLINES_PER_REQUEST", async () => {
    const fetchImpl = jest.fn();
    for (const limit of [0, -1, 1.5, MAX_KLINES_PER_REQUEST + 1]) {
      await expect(
        fetchKlines("SPOT", "BTCUSDT", { interval: "1m", startTime: 0, limit, fetchImpl }),
      ).rejects.toThrow(/limit/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("builds the correct spot klines request URL, defaulting limit to MAX_KLINES_PER_REQUEST", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse([klineRow(1_000_000)]));
    await fetchKlines("SPOT", "BTCUSDT", { interval: "1m", startTime: 1_000_000, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=1000000&limit=${MAX_KLINES_PER_REQUEST}`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  test("builds the correct USD-M klines request URL with an explicit limit", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse([klineRow(2_000_000)]));
    await fetchKlines("PERPETUAL", "ETHUSDT", { interval: "5m", startTime: 2_000_000, limit: 100, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://fapi.binance.com/fapi/v1/klines?symbol=ETHUSDT&interval=5m&startTime=2000000&limit=100",
      expect.objectContaining({ method: "GET" }),
    );
  });

  test("returns the parsed raw kline rows on a 2xx response", async () => {
    const rows = [klineRow(1_000_000), klineRow(1_060_000)];
    const fetchImpl = jest.fn(async () => jsonResponse(rows));
    const result = await fetchKlines("SPOT", "BTCUSDT", { interval: "1m", startTime: 1_000_000, fetchImpl });
    expect(result).toEqual({ ok: true, value: { status: 200, headers: expect.any(Object), body: rows } });
  });

  test("a rate-limit response is classified the same way fetchDepthSnapshot's shared path already is", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ msg: "too many requests" }, { status: 429 }));
    const result = await fetchKlines("SPOT", "BTCUSDT", { interval: "1m", startTime: 0, fetchImpl });
    expect(result).toEqual({ ok: false, reason: "RATE_LIMITED" });
  });
});

describe("binance-http-client fetchExchangeInfo", () => {
  test("rejects an unrecognized market kind before any network call", async () => {
    const fetchImpl = jest.fn();
    await expect(fetchExchangeInfo("COIN_M", "BTCUSDT", { fetchImpl })).rejects.toThrow(/unrecognized/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects an unrecognized or missing symbol before any network call", async () => {
    const fetchImpl = jest.fn();
    await expect(fetchExchangeInfo("SPOT", "DOGEUSDT", { fetchImpl })).rejects.toThrow(/unrecognized/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("builds the correct spot exchangeInfo request URL", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ symbols: [] }));
    await fetchExchangeInfo("SPOT", "BTCUSDT", { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.binance.com/api/v3/exchangeInfo?symbol=BTCUSDT",
      expect.objectContaining({ method: "GET" }),
    );
  });

  test("builds the correct USD-M exchangeInfo request URL", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ symbols: [] }));
    await fetchExchangeInfo("PERPETUAL", "ETHUSDT", { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://fapi.binance.com/fapi/v1/exchangeInfo?symbol=ETHUSDT",
      expect.objectContaining({ method: "GET" }),
    );
  });

  test("returns the parsed exchangeInfo body on a 2xx response", async () => {
    const body = { symbols: [{ symbol: "BTCUSDT", filters: [] }] };
    const fetchImpl = jest.fn(async () => jsonResponse(body));
    const result = await fetchExchangeInfo("SPOT", "BTCUSDT", { fetchImpl });
    expect(result).toEqual({ ok: true, value: { status: 200, headers: expect.any(Object), body } });
  });
});

test("HTTP helpers reject invalid resource controls before invoking fetch", async () => {
  const fetchImpl = jest.fn();
  await expect(fetchDepthSnapshot("SPOT", "BTCUSDT", { fetchImpl, timeoutMs: 0 })).rejects.toThrow(/timeoutMs/);
  await expect(fetchDepthSnapshot("SPOT", "BTCUSDT", { fetchImpl, maxResponseBytes: Number.NaN })).rejects.toThrow(/maxResponseBytes/);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("a genuine but already-locked response body fails closed instead of throwing", async () => {
  const response = jsonResponse({ lastUpdateId: 1, bids: [], asks: [] });
  const reader = response.body.getReader();
  try {
    await expect(fetchDepthSnapshot("SPOT", "BTCUSDT", { fetchImpl: async () => response })).resolves.toEqual({
      ok: false,
      reason: "INVALID_RESPONSE",
    });
  } finally {
    reader.releaseLock();
  }
});

test("a genuine Response with a hostile property override fails closed instead of throwing", async () => {
  const response = jsonResponse({ lastUpdateId: 1, bids: [], asks: [] });
  Object.defineProperty(response, "headers", {
    configurable: true,
    get() {
      throw new Error("hostile getter");
    },
  });

  await expect(fetchDepthSnapshot("SPOT", "BTCUSDT", { fetchImpl: async () => response })).resolves.toEqual({
    ok: false,
    reason: "INVALID_RESPONSE",
  });
});
