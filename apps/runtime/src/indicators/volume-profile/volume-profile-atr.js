"use strict";



const {
  DEFAULT_REFERENCE_WINDOW_MS,
  resolveAtrTicksPerRow,
} = require("./volume-profile-engine");

const BAR_INTERVAL_MS = 60_000;


const MIN_BARS_FOR_ATR = 5;

function assertInstrumentKey(instrument) {
  if (typeof instrument !== "string" || instrument.trim().length === 0) {
    throw new Error(
      "volume-profile-atr: instrument must be a non-empty string",
    );
  }
}


function trueRangeAverage(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let total = 0;
  let counted = 0;
  let previousClose = null;
  for (const row of rows) {
    const high = row?.high;
    const low = row?.low;
    if (!Number.isFinite(high) || !Number.isFinite(low) || high < low) {


      previousClose = Number.isFinite(row?.close) ? row.close : previousClose;
      continue;
    }
    let range = high - low;
    if (previousClose !== null) {
      range = Math.max(
        range,
        Math.abs(high - previousClose),
        Math.abs(low - previousClose),
      );
    }
    total += range;
    counted += 1;
    previousClose = Number.isFinite(row?.close) ? row.close : previousClose;
  }
  if (counted === 0) return null;
  return { atr: total / counted, barCount: counted };
}


function createVolumeProfileAtrReference({
  windowMs = DEFAULT_REFERENCE_WINDOW_MS,
  cacheTtlMs = 5 * 60 * 1000,
  nowFn = Date.now,
} = {}) {
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new Error(
      "volume-profile-atr: windowMs must be a positive safe integer",
    );
  }
  if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs <= 0) {
    throw new Error(
      "volume-profile-atr: cacheTtlMs must be a positive safe integer",
    );
  }
  if (typeof nowFn !== "function") {
    throw new Error("volume-profile-atr: nowFn must be a function");
  }

  const cache = new Map();
  const inFlight = new Map();

  function readFrom(result, rangeResult) {
    if (!result || result.available === false) return null;
    const rows = Array.isArray(result.rows) ? result.rows : [];
    if (rows.length < MIN_BARS_FOR_ATR) return null;
    const measured = trueRangeAverage(rows);
    if (measured === null || !(measured.atr > 0)) return null;



    const span =
      rangeResult?.available &&
      Number.isFinite(rangeResult.minPrice) &&
      Number.isFinite(rangeResult.maxPrice) &&
      rangeResult.maxPrice >= rangeResult.minPrice
        ? rangeResult.maxPrice - rangeResult.minPrice
        : null;
    return {
      ...measured,
      barIntervalMs: BAR_INTERVAL_MS,
      windowMs,
      referenceRange: span !== null && span > 0 ? span : null,
    };
  }


  async function getReading(instrument, { readCandles, readPriceRange } = {}) {
    assertInstrumentKey(instrument);
    if (typeof readCandles !== "function") {
      throw new Error("volume-profile-atr: readCandles must be a function");
    }

    const cached = cache.get(instrument);
    const now = nowFn();
    if (cached && now - cached.fetchedAtMs < cacheTtlMs) return cached.reading;

    const pending = inFlight.get(instrument);
    if (pending) return pending;



    const anchorMs = now - (now % BAR_INTERVAL_MS);

    const promise = (async () => {
      let result;
      let rangeResult = null;
      const [candlesOutcome, rangeOutcome] = await Promise.allSettled([
        Promise.resolve().then(() =>
          readCandles({
            intervalMs: BAR_INTERVAL_MS,
            windowMs,
            nowMs: anchorMs,
          }),
        ),
        typeof readPriceRange === "function"
          ? Promise.resolve().then(() =>
              readPriceRange({
                fromTs: Math.max(0, anchorMs - windowMs),
                toTs: anchorMs,
              }),
            )
          : Promise.resolve(null),
      ]);
      if (candlesOutcome.status === "rejected") {
        console.error(
          `volume-profile-atr: reference read failed for ${instrument}`,
          candlesOutcome.reason?.message ?? candlesOutcome.reason,
        );
        return cached?.reading ?? null;
      }
      result = candlesOutcome.value;
      if (rangeOutcome.status === "fulfilled") {
        rangeResult = rangeOutcome.value;
      } else {
        console.error(
          `volume-profile-atr: reference window read failed for ${instrument}`,
          rangeOutcome.reason?.message ?? rangeOutcome.reason,
        );
      }
      const reading = readFrom(result, rangeResult);
      // A transient failure keeps the previous reading rather than dropping the
      // instrument back to range-derived sizing and shifting every bin.
      if (reading === null) return cached?.reading ?? null;
      cache.set(instrument, { reading, fetchedAtMs: nowFn(), anchorMs });
      return reading;
    })().finally(() => {
      inFlight.delete(instrument);
    });

    inFlight.set(instrument, promise);
    return promise;
  }

  function invalidate(instrument) {
    if (instrument === undefined) {
      cache.clear();
      return;
    }
    cache.delete(instrument);
  }

  return Object.freeze({
    getReading,
    invalidate,
    windowMs,
    barIntervalMs: BAR_INTERVAL_MS,
  });
}

/**
 * Resolves an instrument's bin width in TICKS from its volatility reading.
 *
 * `binSizeMultiplier` is the user's sizing control: 1 is the volatility-derived
 * default, above 1 is coarser bins, below 1 is finer.
 *
 * Returns null when no reading is available, so a caller can fall back to sizing
 * from the window's own range instead of failing the profile outright.
 */
function resolveTicksPerRowFromReading({
  reading,
  tickSize,
  sessionMs,
  binSizeMultiplier,
  referenceRange = null,
}) {
  if (!reading || !Number.isFinite(reading.atr) || reading.atr <= 0)
    return null;
  if (!Number.isFinite(sessionMs) || sessionMs <= 0) return null;
  return resolveAtrTicksPerRow({
    tickSize,
    referenceAtr: reading.atr,
    barIntervalMs: reading.barIntervalMs ?? BAR_INTERVAL_MS,
    sessionMs,
    ...(binSizeMultiplier === undefined ? {} : { binSizeMultiplier }),
    referenceRange,
  });
}

module.exports = {
  createVolumeProfileAtrReference,
  resolveTicksPerRowFromReading,
  trueRangeAverage,
  BAR_INTERVAL_MS,
  MIN_BARS_FOR_ATR,
};
