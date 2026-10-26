const { createBinanceKlineBackfill, DEFAULT_MAX_PAGES } = require("../../../src/providers/binance/binance-kline-backfill");
const { MAX_KLINES_PER_REQUEST } = require("../../../src/providers/binance/binance-http-client");

const ONE_MINUTE_MS = 60_000;
const NOW_MS = 1_800_000_030_000;

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), { status });
}

// A real REST kline row, closed well in the past by construction (the
// caller picks openTime, which always resolves to a closeTime before
// "now" in these tests unless a test explicitly wants the opposite).
function row(openTime) {
  return [
    openTime, "64200.00", "64300.50", "64150.25", "64275.99", "12.34500000",
    openTime + ONE_MINUTE_MS - 1, "792345.11", 418, "6.0", "385000.0", "0",
  ];
}

function fullPage(startOpenTime, count = MAX_KLINES_PER_REQUEST) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push(row(startOpenTime + i * ONE_MINUTE_MS));
  }
  return rows;
}

describe("binance-kline-backfill", () => {
  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(NOW_MS);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("rejects an unrecognized market kind, symbol, or interval before any network call", async () => {
    const fetchImpl = jest.fn();
    const backfill = createBinanceKlineBackfill({ fetchImpl, telemetry: () => {} });
    await expect(
      backfill.fetchRecentBars("COIN_M", "BTCUSDT", { interval: "1m", intervalMs: ONE_MINUTE_MS }),
    ).rejects.toThrow(/unrecognized/);
    await expect(
      backfill.fetchRecentBars("SPOT", "DOGEUSDT", { interval: "1m", intervalMs: ONE_MINUTE_MS }),
    ).rejects.toThrow(/unrecognized/);
    await expect(
      backfill.fetchRecentBars("SPOT", "BTCUSDT", { interval: "3m", intervalMs: 180_000 }),
    ).rejects.toThrow(/unrecognized/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects a missing/invalid intervalMs or days before any network call", async () => {
    const fetchImpl = jest.fn();
    const backfill = createBinanceKlineBackfill({ fetchImpl, telemetry: () => {} });
    await expect(backfill.fetchRecentBars("SPOT", "BTCUSDT", { interval: "1m" })).rejects.toThrow(/intervalMs/);
    await expect(
      backfill.fetchRecentBars("SPOT", "BTCUSDT", { interval: "1m", intervalMs: ONE_MINUTE_MS, days: 0 }),
    ).rejects.toThrow(/days/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects a duration that does not match the requested interval before any network call", async () => {
    const fetchImpl = jest.fn();
    const backfill = createBinanceKlineBackfill({ fetchImpl, telemetry: () => {} });
    await expect(
      backfill.fetchRecentBars("SPOT", "BTCUSDT", { interval: "1m", intervalMs: 300_000 }),
    ).rejects.toThrow(/must match the requested interval/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects invalid pagination controls before any network call", async () => {
    const fetchImpl = jest.fn();
    const backfill = createBinanceKlineBackfill({ fetchImpl, telemetry: () => {} });
    await expect(
      backfill.fetchRecentBars("SPOT", "BTCUSDT", { interval: "1m", intervalMs: ONE_MINUTE_MS, pageDelayMs: -1 }),
    ).rejects.toThrow(/pageDelayMs/);
    await expect(
      backfill.fetchRecentBars("SPOT", "BTCUSDT", { interval: "1m", intervalMs: ONE_MINUTE_MS, maxPages: 0 }),
    ).rejects.toThrow(/maxPages/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("a single short page is complete only when its final row reaches the current closed-candle boundary", async () => {
    const fetchImpl = jest.fn(async (url) => {
      const startTime = Number(new URL(url).searchParams.get("startTime"));
      return jsonResponse(fullPage(startTime, 60));
    });
    const backfill = createBinanceKlineBackfill({ fetchImpl, telemetry: () => {} });
    const result = await backfill.fetchRecentBars("SPOT", "BTCUSDT", {
      interval: "1m",
      intervalMs: ONE_MINUTE_MS,
      days: 1 / 24,
    });
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(60);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("an endpoints override sends every spot page to the mirror origin", async () => {
    const fetchImpl = jest.fn(async (url) => {
      const startTime = Number(new URL(url).searchParams.get("startTime"));
      return jsonResponse(fullPage(startTime, 60));
    });
    const backfill = createBinanceKlineBackfill({
      fetchImpl,
      telemetry: () => {},
      endpoints: { spotWsBaseUrl: "wss://stream.binance.com", spotRestBaseUrl: "https://data-api.binance.vision" },
    });
    const result = await backfill.fetchRecentBars("SPOT", "BTCUSDT", { interval: "1m", intervalMs: ONE_MINUTE_MS, days: 1 / 24 });
    expect(result.ok).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toMatch(/^https:\/\/data-api\.binance\.vision\/api\/v3\/klines\?symbol=BTCUSDT/);
  });

  test("paginates across pages until the cursor itself proves it reached the closed-candle boundary", async () => {
    let call = 0;
    const fetchImpl = jest.fn(async (url) => {
      call += 1;
      const startTime = Number(new URL(url).searchParams.get("startTime"));
      if (call === 1) {
        return jsonResponse(fullPage(startTime, MAX_KLINES_PER_REQUEST));
      }
      return jsonResponse(fullPage(startTime, 500));
    });
    const backfill = createBinanceKlineBackfill({ fetchImpl, telemetry: () => {} });
    const result = await backfill.fetchRecentBars("SPOT", "BTCUSDT", {
      interval: "1m",
      intervalMs: ONE_MINUTE_MS,
      days: 25 / 24,
      pageDelayMs: 0,
    });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.rows).toHaveLength(MAX_KLINES_PER_REQUEST + 500);
  });

  test("each page requests startTime advanced past the previous page's last bar, not the same window twice", async () => {
    const startTimes = [];
    const fetchImpl = jest.fn(async (url) => {
      const startTime = Number(new URL(url).searchParams.get("startTime"));
      startTimes.push(startTime);
      if (startTimes.length === 1) {
        return jsonResponse(fullPage(startTime, MAX_KLINES_PER_REQUEST));
      }
      return jsonResponse([]);
    });
    const backfill = createBinanceKlineBackfill({ fetchImpl, telemetry: () => {} });
    await backfill.fetchRecentBars("SPOT", "BTCUSDT", { interval: "1m", intervalMs: ONE_MINUTE_MS, days: 7 });
    expect(startTimes).toHaveLength(2);
    expect(startTimes[1]).toBe(startTimes[0] + MAX_KLINES_PER_REQUEST * ONE_MINUTE_MS);
  });

  test("an empty page before the requested boundary is an honest incomplete result", async () => {
    let call = 0;
    const fetchImpl = jest.fn(async (url) => {
      call += 1;
      if (call === 1) {
        const startTime = Number(new URL(url).searchParams.get("startTime"));
        return jsonResponse(fullPage(startTime, MAX_KLINES_PER_REQUEST));
      }
      return jsonResponse([]);
    });
    const backfill = createBinanceKlineBackfill({ fetchImpl, telemetry: () => {} });
    const result = await backfill.fetchRecentBars("SPOT", "BTCUSDT", {
      interval: "1m",
      intervalMs: ONE_MINUTE_MS,
      days: 7,
      pageDelayMs: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("INCOMPLETE_PAGE");
    expect(result.rows).toHaveLength(MAX_KLINES_PER_REQUEST);
    expect(call).toBe(2);
  });

  test("a short page that stops before the requested boundary is not accepted as complete", async () => {
    const fetchImpl = jest.fn(async (url) => {
      const startTime = Number(new URL(url).searchParams.get("startTime"));
      return jsonResponse(fullPage(startTime, 10));
    });
    const backfill = createBinanceKlineBackfill({ fetchImpl, telemetry: () => {} });

    const result = await backfill.fetchRecentBars("SPOT", "BTCUSDT", {
      interval: "1m",
      intervalMs: ONE_MINUTE_MS,
      days: 1 / 24,
    });

    expect(result).toMatchObject({ ok: false, reason: "INCOMPLETE_PAGE" });
    expect(result.rows).toHaveLength(10);
  });

  test("a page beginning after the requested cursor is rejected instead of silently hiding a leading gap", async () => {
    const fetchImpl = jest.fn(async (url) => {
      const startTime = Number(new URL(url).searchParams.get("startTime"));
      return jsonResponse(fullPage(startTime + ONE_MINUTE_MS, 59));
    });
    const backfill = createBinanceKlineBackfill({ fetchImpl, telemetry: () => {} });

    const result = await backfill.fetchRecentBars("SPOT", "BTCUSDT", {
      interval: "1m",
      intervalMs: ONE_MINUTE_MS,
      days: 1 / 24,
    });

    expect(result).toEqual({ ok: false, reason: "PAGE_START_MISMATCH", rows: [] });
  });

  test("provider rows beyond the current forming candle cannot manufacture false completion", async () => {
    const fetchImpl = jest.fn(async (url) => {
      const startTime = Number(new URL(url).searchParams.get("startTime"));
      return jsonResponse(fullPage(startTime, 62));
    });
    const backfill = createBinanceKlineBackfill({ fetchImpl, telemetry: () => {} });

    const result = await backfill.fetchRecentBars("SPOT", "BTCUSDT", {
      interval: "1m",
      intervalMs: ONE_MINUTE_MS,
      days: 1 / 24,
    });

    expect(result).toEqual({ ok: false, reason: "PAGE_TIME_RANGE_INVALID", rows: [] });
  });

  test("the closed-candle boundary is re-read per page, so a backfill that crosses a minute boundary mid-run finishes instead of failing PAGE_TIME_RANGE_INVALID", async () => {
    // Regression: closedBoundary was snapshotted once at function entry.
    // A multi-page backfill slow enough for the wall clock to cross a
    // minute would then see the freshly-closed bar on its final page as
    // "beyond the boundary" and abort with PAGE_TIME_RANGE_INVALID,
    // dropping that whole last page -- even though it had simply caught
    // up to the present.
    let clock = NOW_MS;
    Date.now.mockImplementation(() => clock);
    const boundaryAtStart = Math.floor(NOW_MS / ONE_MINUTE_MS) * ONE_MINUTE_MS;

    let call = 0;
    const fetchImpl = jest.fn(async (url) => {
      call += 1;
      const startTime = Number(new URL(url).searchParams.get("startTime"));
      if (call === 1) {
        clock = NOW_MS + ONE_MINUTE_MS; // a minute elapses while page 1 is in flight
        return jsonResponse(fullPage(startTime, MAX_KLINES_PER_REQUEST));
      }
      // now available: the bar that closed during page 1, then the new forming bar
      return jsonResponse(fullPage(startTime, 3));
    });

    const backfill = createBinanceKlineBackfill({ fetchImpl, telemetry: () => {} });
    const result = await backfill.fetchRecentBars("SPOT", "BTCUSDT", {
      interval: "1m",
      intervalMs: ONE_MINUTE_MS,
      days: 1001 / 1440,
      pageDelayMs: 0,
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.rows).toHaveLength(MAX_KLINES_PER_REQUEST + 2);
    expect(result.rows.at(-1).openTime).toBe(boundaryAtStart);
  });

  test("partial failure is honest: a mid-sequence page failure returns what was already fetched, not nothing", async () => {
    let call = 0;
    const fetchImpl = jest.fn(async (url) => {
      call += 1;
      if (call === 1) {
        const startTime = Number(new URL(url).searchParams.get("startTime"));
        return jsonResponse(fullPage(startTime, MAX_KLINES_PER_REQUEST));
      }
      return jsonResponse({ msg: "rate limited" }, { status: 429 });
    });
    const backfill = createBinanceKlineBackfill({ fetchImpl, telemetry: () => {} });
    const result = await backfill.fetchRecentBars("SPOT", "BTCUSDT", {
      interval: "1m",
      intervalMs: ONE_MINUTE_MS,
      days: 7,
      pageDelayMs: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("RATE_LIMITED");
    expect(result.rows).toHaveLength(MAX_KLINES_PER_REQUEST);
  });

  test("the very first page failing returns ok:false with zero rows, not a throw", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({}, { status: 500 }));
    const backfill = createBinanceKlineBackfill({ fetchImpl, telemetry: () => {} });
    const result = await backfill.fetchRecentBars("SPOT", "BTCUSDT", {
      interval: "1m",
      intervalMs: ONE_MINUTE_MS,
      days: 1,
    });
    expect(result).toEqual({ ok: false, reason: "HTTP_ERROR", rows: [] });
  });

  test("a malformed/hostile page fails honestly (MALFORMED_KLINE_PAGE) without corrupting already-accumulated bars", async () => {
    let call = 0;
    const fetchImpl = jest.fn(async (url) => {
      call += 1;
      if (call === 1) {
        const startTime = Number(new URL(url).searchParams.get("startTime"));
        return jsonResponse(fullPage(startTime, MAX_KLINES_PER_REQUEST));
      }
      return jsonResponse([["not", "a", "real", "row"]]);
    });
    const backfill = createBinanceKlineBackfill({ fetchImpl, telemetry: () => {} });
    const result = await backfill.fetchRecentBars("SPOT", "BTCUSDT", {
      interval: "1m",
      intervalMs: ONE_MINUTE_MS,
      days: 7,
      pageDelayMs: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("MALFORMED_KLINE_PAGE");
    expect(result.rows).toHaveLength(MAX_KLINES_PER_REQUEST);
  });

  test("a provider page that never advances the cursor stops instead of looping forever", async () => {
    // Simulates a provider bug that ignores pagination and always
    // returns the same page regardless of the requested startTime --
    // the second call's computed nextCursor then exactly equals the
    // cursor already reached, which must stop the walk rather than
    // request the identical page forever.
    let firstRequestedStartTime = null;
    const fetchImpl = jest.fn(async (url) => {
      if (firstRequestedStartTime === null) {
        firstRequestedStartTime = Number(new URL(url).searchParams.get("startTime"));
      }
      return jsonResponse(fullPage(firstRequestedStartTime, MAX_KLINES_PER_REQUEST));
    });
    const backfill = createBinanceKlineBackfill({ fetchImpl, telemetry: () => {} });
    const result = await backfill.fetchRecentBars("SPOT", "BTCUSDT", {
      interval: "1m",
      intervalMs: ONE_MINUTE_MS,
      days: 7,
      pageDelayMs: 0,
      maxPages: 5,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("PAGE_START_MISMATCH");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("the page-count safety cap stops a pathological loop that would otherwise run forever, and reports the truncation honestly rather than a false ok:true", async () => {
    let call = 0;
    const fetchImpl = jest.fn(async (url) => {
      call += 1;
      const startTime = Number(new URL(url).searchParams.get("startTime"));
      return jsonResponse(fullPage(startTime, MAX_KLINES_PER_REQUEST));
    });
    const backfill = createBinanceKlineBackfill({ fetchImpl, telemetry: () => {} });
    const result = await backfill.fetchRecentBars("SPOT", "BTCUSDT", {
      interval: "1m",
      intervalMs: ONE_MINUTE_MS,
      days: 3650, // absurdly large window -- would run indefinitely without the cap
      pageDelayMs: 0,
      maxPages: 4,
    });
    expect(call).toBe(4);
    expect(result.rows).toHaveLength(MAX_KLINES_PER_REQUEST * 4);
    // Every full page kept coming back with no error and no caught-up
    // signal (never a short/empty page) -- the cap alone cut this off
    // while cursor was still nowhere near "now", which must not look
    // like a clean success to a caller deciding whether to warn.
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("MAX_PAGES_REACHED");
  });

  test("a short page on the last allowed page is complete when it reaches the requested boundary", async () => {
    let call = 0;
    const fetchImpl = jest.fn(async (url) => {
      call += 1;
      const startTime = Number(new URL(url).searchParams.get("startTime"));
      if (call < 2) {
        return jsonResponse(fullPage(startTime, MAX_KLINES_PER_REQUEST));
      }
      return jsonResponse(fullPage(startTime, 500));
    });
    const backfill = createBinanceKlineBackfill({ fetchImpl, telemetry: () => {} });
    const result = await backfill.fetchRecentBars("SPOT", "BTCUSDT", {
      interval: "1m",
      intervalMs: ONE_MINUTE_MS,
      days: 25 / 24,
      pageDelayMs: 0,
      maxPages: 2,
    });
    expect(call).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test("uses DEFAULT_MAX_PAGES comfortably above the ~11 pages a real 7-day/1m backfill needs", () => {
    expect(DEFAULT_MAX_PAGES).toBeGreaterThan(11);
  });

  test("a still-forming boundary row is excluded so every successful row is closed by construction", async () => {
    const fetchImpl = jest.fn(async (url) => {
      const startTime = Number(new URL(url).searchParams.get("startTime"));
      return jsonResponse(fullPage(startTime, 61));
    });
    const backfill = createBinanceKlineBackfill({ fetchImpl, telemetry: () => {} });
    const result = await backfill.fetchRecentBars("SPOT", "BTCUSDT", {
      interval: "1m",
      intervalMs: ONE_MINUTE_MS,
      days: 1 / 24,
    });
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(60);
    expect(result.rows.at(-1).openTime).toBeLessThan(Math.floor(Date.now() / ONE_MINUTE_MS) * ONE_MINUTE_MS);
  });

  test("rejects lookback and page limits that cannot be represented safely", async () => {
    const backfill = createBinanceKlineBackfill({ fetchImpl: jest.fn(), telemetry: () => {} });
    await expect(backfill.fetchRecentBars("SPOT", "BTCUSDT", {
      interval: "1m", intervalMs: ONE_MINUTE_MS, days: Number.MAX_SAFE_INTEGER,
    })).rejects.toThrow(/epoch range/);
    await expect(backfill.fetchRecentBars("SPOT", "BTCUSDT", {
      interval: "1m", intervalMs: ONE_MINUTE_MS, maxPages: 10_001,
    })).rejects.toThrow(/maxPages/);
  });
});

// L1L2-V2-019. binance-http-client parses Retry-After into retryAfterMs on a
// 429/418, and the depth-snapshot path honours it. This path used to keep only
// result.reason and drop the rest, so scheduleBackfillRetry fell back to a purely
// local backoff and could retry sooner than Binance asked -- on the one code path
// that runs while the API is already pushing back, and where repeated 429s
// escalate to a 418 IP ban.
describe("rate-limit Retry-After propagation (L1L2-V2-019)", () => {
  test("propagates the provider's Retry-After alongside the failure reason", async () => {
    const fetchImpl = jest.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "30" } }));
    const backfill = createBinanceKlineBackfill({ fetchImpl });
    const result = await backfill.fetchRecentBars("SPOT", "BTCUSDT", {
      interval: "1m", intervalMs: ONE_MINUTE_MS, days: 1, pageDelayMs: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("RATE_LIMITED");
    expect(result.retryAfterMs).toBe(30_000);
  });

  test("omits retryAfterMs entirely when the provider did not send one", async () => {
    const fetchImpl = jest.fn(async () => new Response("{}", { status: 500 }));
    const backfill = createBinanceKlineBackfill({ fetchImpl });
    const result = await backfill.fetchRecentBars("SPOT", "BTCUSDT", {
      interval: "1m", intervalMs: ONE_MINUTE_MS, days: 1, pageDelayMs: 0,
    });
    expect(result.ok).toBe(false);
    expect(Object.hasOwn(result, "retryAfterMs")).toBe(false);
  });
});
