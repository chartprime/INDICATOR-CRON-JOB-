const { fetchKlines, MAX_KLINES_PER_REQUEST } = require("./binance-http-client");
const { parseKlineRows } = require("./binance-event-normalizer");
const { assertAllowedMarketKind, assertAllowedSymbol, safeTelemetrySymbol, safeTelemetryMarketKind } = require("./binance-subscription-guard");
const { isAllowedCandleInterval, candleIntervalMsFor, restBaseUrlFor, DEFAULT_BINANCE_ENDPOINTS } = require("./binance-config");
const { emitTelemetry } = require("../../platform/telemetry");

const DEFAULT_DAYS = 7;
const DEFAULT_PAGE_DELAY_MS = 250;
const DEFAULT_MAX_PAGES = 60;
const MAX_BACKFILL_PAGES = 10_000;

/** Resolves true after `ms`, or false at once when `signal` aborts first. */
function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * `now` is the clock candles are classified against and `finalizeGraceMs` the
 * time after a candle's close before it counts as final: the stream transport
 * uses the machine clock with no grace, the REST transport its synchronised
 * exchange clock with the same grace as its live polling, so a candle the
 * exchange still has open is never stored as closed history.
 */
function createBinanceKlineBackfill({
  fetchImpl = globalThis.fetch,
  fetchKlinesImpl = fetchKlines,
  telemetry,
  endpoints = DEFAULT_BINANCE_ENDPOINTS,
  now = () => Date.now(),
  finalizeGraceMs = 0,
} = {}) {
  if (typeof fetchKlinesImpl !== "function") throw new Error("createBinanceKlineBackfill: fetchKlinesImpl must be a function");
  if (typeof now !== "function") throw new Error("createBinanceKlineBackfill: now must be a function");
  if (!Number.isSafeInteger(finalizeGraceMs) || finalizeGraceMs < 0) {
    throw new Error("createBinanceKlineBackfill: finalizeGraceMs must be a non-negative safe integer");
  }

  async function fetchRecentBars(
    marketKind,
    symbol,
    { days = DEFAULT_DAYS, interval, intervalMs, pageDelayMs = DEFAULT_PAGE_DELAY_MS, maxPages = DEFAULT_MAX_PAGES, signal } = {},
  ) {
    assertAllowedMarketKind(marketKind);
    assertAllowedSymbol(symbol);
    if (!isAllowedCandleInterval(interval)) {
      throw new Error(`fetchRecentBars: unrecognized interval "${interval}"`);
    }
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
      throw new Error("fetchRecentBars: intervalMs must be a positive integer");
    }
    if (intervalMs !== candleIntervalMsFor(interval)) {
      throw new Error("fetchRecentBars: intervalMs must match the requested interval");
    }
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error("fetchRecentBars: days must be a positive number");
    }
    if (!Number.isInteger(pageDelayMs) || pageDelayMs < 0) {
      throw new Error("fetchRecentBars: pageDelayMs must be a non-negative integer");
    }
    if (!Number.isInteger(maxPages) || maxPages <= 0 || maxPages > MAX_BACKFILL_PAGES) {
      throw new Error(`fetchRecentBars: maxPages must be a positive integer <= ${MAX_BACKFILL_PAGES}`);
    }
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw new Error("fetchRecentBars: signal must be an AbortSignal when provided");
    }

    const rows = [];
    let retryAfterMs;
    const startedAtMs = now();
    // The first open time that is not final: a candle is final once its close
    // time plus the grace has passed on the clock given to this backfill.
    const closedBoundaryAt = (atMs) => Math.floor((atMs + 1 - finalizeGraceMs) / intervalMs) * intervalMs;
    const lookbackMs = days * 24 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(lookbackMs) || lookbackMs > startedAtMs) {
      throw new Error("fetchRecentBars: days resolves outside the supported epoch range");
    }
    let cursor = closedBoundaryAt(startedAtMs - lookbackMs);
    let pagesFetched = 0;
    let failureReason = null;
    let caughtUp = false;

    while (pagesFetched < maxPages) {
      if (signal?.aborted) {
        failureReason = "ABORTED";
        break;
      }
      const closedBoundary = closedBoundaryAt(now());
      if (cursor >= closedBoundary) {
        caughtUp = true;
        break;
      }

      const result = await fetchKlinesImpl(marketKind, symbol, {
        interval,
        startTime: cursor,
        limit: MAX_KLINES_PER_REQUEST,
        fetchImpl,
        baseUrl: restBaseUrlFor(marketKind, endpoints),
        signal,
      });
      pagesFetched += 1;

      if (!result.ok) {
        failureReason = result.reason;
        if (Number.isSafeInteger(result.retryAfterMs) && result.retryAfterMs >= 0) {
          retryAfterMs = result.retryAfterMs;
        }
        emitTelemetry(telemetry, "market_data.binance_kline_backfill.page_failed", {
          symbol: safeTelemetrySymbol(symbol),
          marketKind: safeTelemetryMarketKind(marketKind),
          reason: result.reason,
          pagesFetched,
          barsSoFar: rows.length,
        });
        break;
      }

      const page = parseKlineRows(result.value.body, intervalMs);
      if (!page) {
        failureReason = "MALFORMED_KLINE_PAGE";
        emitTelemetry(telemetry, "market_data.binance_kline_backfill.page_failed", {
          symbol: safeTelemetrySymbol(symbol),
          marketKind: safeTelemetryMarketKind(marketKind),
          reason: failureReason,
          pagesFetched,
          barsSoFar: rows.length,
        });
        break;
      }

      if (page.length === 0) {
        failureReason = "INCOMPLETE_PAGE";
        break;
      }

      if (page[0].openTime !== cursor) {
        failureReason = "PAGE_START_MISMATCH";
        break;
      }
      if (page[page.length - 1].openTime > closedBoundary) {
        failureReason = "PAGE_TIME_RANGE_INVALID";
        break;
      }

      const closedPage = page[page.length - 1].openTime === closedBoundary
        ? page.slice(0, -1)
        : page;
      if (closedPage.length === 0) {
        failureReason = "INCOMPLETE_PAGE";
        break;
      }

      for (const row of closedPage) {
        rows.push(row);
      }

      const lastRow = closedPage[closedPage.length - 1];
      const nextCursor = lastRow.openTime + intervalMs;
      if (nextCursor <= cursor) {
        failureReason = "NON_ADVANCING_PAGE";
        break;
      }
      cursor = nextCursor;

      if (cursor >= closedBoundary) {
        caughtUp = true;
        break;
      }
      if (page.length < MAX_KLINES_PER_REQUEST) {
        failureReason = "INCOMPLETE_PAGE";
        break;
      }
      if (cursor < closedBoundary && !(await delay(pageDelayMs, signal))) {
        failureReason = "ABORTED";
        break;
      }
    }

    if (failureReason === null && !caughtUp && cursor < closedBoundaryAt(now())) {
      failureReason = "MAX_PAGES_REACHED";
    }

    emitTelemetry(telemetry, "market_data.binance_kline_backfill.completed", {
      symbol: safeTelemetrySymbol(symbol),
      marketKind: safeTelemetryMarketKind(marketKind),
      barsFetched: rows.length,
      pagesFetched,
      ok: failureReason === null,
    });

    return {
      ok: failureReason === null,
      rows: Object.freeze(rows),
      ...(failureReason !== null ? { reason: failureReason } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }

  return Object.freeze({ fetchRecentBars });
}

module.exports = { createBinanceKlineBackfill, DEFAULT_DAYS, DEFAULT_MAX_PAGES };
