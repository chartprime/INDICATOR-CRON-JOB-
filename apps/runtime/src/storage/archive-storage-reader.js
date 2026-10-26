"use strict";

const { bucketIndexOf, toPriceSubunits } = require("./price-bucketing");
const { tradeMagnitude } = require("../indicators/large-trade/large-trade-detection");
const { isEquityChartTime } = require("../providers/shared/market-calendar");

const MODULE = "archive-storage-reader";
const MS_NS = 1_000_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const SLICE_MS = 2_000;
const DEFAULT_PAGE_LIMIT = 10_000;
const DEFAULT_MAX_PAGES_PER_REQUEST = 512;
const MEMO_ENTRIES = 8;
const SLICE_MEMO_ENTRIES = 2;
const DECIMAL_SCALE = 1_000_000_000_000n;
const EXACT_DECIMAL = /^(0|[1-9][0-9]{0,25})(?:\.([0-9]{1,12}))?$/;

const FAMILY = Object.freeze({
  minute: "trade_minute_1m",
  level: "trade_level_1m",
  slice: "trade_slice_2s",
  prints: "trade_prints_1m",
});

const REQUEST_WINDOW_MS = Object.freeze({
  [FAMILY.minute]: 31 * DAY_MS,
  [FAMILY.level]: 7 * DAY_MS,
  [FAMILY.slice]: 7 * DAY_MS,
  [FAMILY.prints]: 31 * DAY_MS,
});

class ArchiveReadUnavailable extends Error {}

function finite(value, field) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${MODULE}: ${field} is not a finite number`);
  return parsed;
}

function integer(value, field) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${MODULE}: ${field} is not a safe integer`);
  return parsed;
}

function nonNegativeDecimal(value, field) {
  if (typeof value !== "string") throw new Error(`${MODULE}: ${field} is not exact decimal text`);
  const match = EXACT_DECIMAL.exec(value);
  if (match === null) throw new Error(`${MODULE}: ${field} is not a non-negative exact decimal`);
  const fraction = (match[2] ?? "").padEnd(12, "0");
  return {
    atoms: BigInt(match[1]) * DECIMAL_SCALE + BigInt(fraction || "0"),
    value: finite(value, field),
  };
}

function msOf(ns, field) {
  const parsed = typeof ns === "bigint" ? ns : BigInt(String(ns));
  const ms = Number(parsed / BigInt(MS_NS));
  if (!Number.isSafeInteger(ms)) throw new Error(`${MODULE}: ${field} is outside the representable millisecond range`);
  return ms;
}

function assertWindow(fromTs, toTs) {
  if (!Number.isSafeInteger(fromTs) || fromTs < 0) {
    throw new Error(`${MODULE}: fromTs must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(toTs) || toTs < fromTs) {
    throw new Error(`${MODULE}: toTs must be a safe integer not before fromTs`);
  }
}

function multipleOf(value, unit, field) {
  if (!Number.isSafeInteger(value) || value <= 0 || value % unit !== 0) {
    throw new Error(`${MODULE}: ${field} must be a positive multiple of ${unit}`);
  }
  return value / unit;
}

function equityChartRows(rows) {
  return rows.filter((row) => isEquityChartTime(msOf(row.trade_ns ?? row.open_ns, row.trade_ns === undefined ? "open_ns" : "trade_ns")));
}

function strongerPrint(candidate, incumbent) {
  if (candidate.magnitude !== incumbent.magnitude) return candidate.magnitude > incumbent.magnitude;
  if (candidate.tradeNs !== incumbent.tradeNs) return candidate.tradeNs > incumbent.tradeNs;
  return candidate.rank < incumbent.rank;
}

function offerPrint(kept, candidate, limit) {
  if (kept.length < limit) {
    kept.push(candidate);
    return;
  }
  let weakest = 0;
  for (let index = 1; index < kept.length; index += 1) {
    if (strongerPrint(kept[weakest], kept[index])) weakest = index;
  }
  if (strongerPrint(candidate, kept[weakest])) kept[weakest] = candidate;
}

function createArchiveStorageReader({
  fetchPage,
  instrumentIdFor,
  tickSizeFor,
  maxPages = DEFAULT_MAX_PAGES_PER_REQUEST,
  pageLimit = DEFAULT_PAGE_LIMIT,
}) {
  if (typeof fetchPage !== "function") throw new Error(`${MODULE}: fetchPage must be a function`);
  if (typeof instrumentIdFor !== "function") throw new Error(`${MODULE}: instrumentIdFor must be a function`);
  if (typeof tickSizeFor !== "function") throw new Error(`${MODULE}: tickSizeFor must be a function`);
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new Error(`${MODULE}: maxPages must be a positive integer`);
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1) throw new Error(`${MODULE}: pageLimit must be a positive integer`);

  let closed = false;
  const levelMemo = new Map();
  const sliceMemo = new Map();

  async function foldFamily(symbol, assetClass, family, fromTs, toTs, onRows) {
    assertWindow(fromTs, toTs);
    if (closed) throw new ArchiveReadUnavailable("READER_CLOSED");
    if (fromTs === toTs) return;
    const instrumentId = instrumentIdFor(symbol, assetClass);
    if (typeof instrumentId !== "string" || instrumentId.length === 0) throw new ArchiveReadUnavailable("NO_INSTRUMENT");
    const span = REQUEST_WINDOW_MS[family];
    for (let chunkFrom = fromTs; chunkFrom < toTs; chunkFrom += span) {
      const chunkTo = Math.min(toTs, chunkFrom + span);
      let cursor = null;
      let pointerToken = null;
      let finished = false;
      for (let page = 0; page < maxPages; page += 1) {
        const answer = await fetchPage({
          instrumentId,
          family,
          from: String(BigInt(chunkFrom) * BigInt(MS_NS)),
          to: String(BigInt(chunkTo) * BigInt(MS_NS)),
          limit: pageLimit,
          cursor,
          pointerToken,
        });
        if (answer === null || answer === undefined || !Array.isArray(answer.rows)) {
          throw new ArchiveReadUnavailable("NO_PAGE");
        }
        onRows(assetClass === "EQUITY" ? equityChartRows(answer.rows) : answer.rows);
        pointerToken = answer.pointerToken ?? pointerToken;
        cursor = answer.nextCursor ?? null;
        if (cursor === null) {
          finished = true;
          break;
        }
      }
      if (!finished) throw new ArchiveReadUnavailable("PAGE_BUDGET_EXHAUSTED");
    }
  }

  async function answer(read, unavailable) {
    try {
      return await read();
    } catch (error) {
      if (error instanceof ArchiveReadUnavailable) return unavailable();
      throw error;
    }
  }

  function levels(symbol, assetClass, fromTs, toTs) {
    assertWindow(fromTs, toTs);
    const key = `${instrumentIdFor(symbol, assetClass)}|${fromTs}|${toTs}`;
    const cached = levelMemo.get(key);
    if (cached !== undefined) return cached;
    const pending = (async () => {
      const byTick = new Map();
      await foldFamily(symbol, assetClass, FAMILY.level, fromTs, toTs, (rows) => {
        for (const row of rows) {
          const tickSize = finite(row.tick_size, "tick_size");
          const priceBucket = integer(row.price_bucket, "price_bucket");
          const key2 = `${tickSize}:${priceBucket}`;
          let entry = byTick.get(key2);
          if (entry === undefined) {
            entry = { tickSize, priceBucket, volume: 0, buyVolume: 0, sellVolume: 0, tradeCount: 0 };
            byTick.set(key2, entry);
          }
          entry.volume += finite(row.volume, "volume");
          entry.buyVolume += finite(row.buy_volume, "buy_volume");
          entry.sellVolume += finite(row.sell_volume, "sell_volume");
          entry.tradeCount += integer(row.trade_count, "trade_count");
        }
      });
      return [...byTick.values()];
    })();
    levelMemo.set(key, pending);
    if (levelMemo.size > MEMO_ENTRIES) levelMemo.delete(levelMemo.keys().next().value);
    pending.catch(() => levelMemo.delete(key));
    return pending;
  }

  function readPriceRange(symbol, assetClass, { fromTs, toTs }) {
    return answer(async () => {
      let minPrice = null;
      let maxPrice = null;
      let tradeCount = 0;
      for (const level of await levels(symbol, assetClass, fromTs, toTs)) {
        const price = level.priceBucket * level.tickSize;
        if (minPrice === null || price < minPrice) minPrice = price;
        if (maxPrice === null || price > maxPrice) maxPrice = price;
        tradeCount += level.tradeCount;
      }
      return { minPrice, maxPrice, tradeCount, available: true };
    }, () => ({ minPrice: null, maxPrice: null, tradeCount: 0, available: false }));
  }

  async function readVolumeProfile(symbol, assetClass, { fromTs, toTs, originPrice, rowWidth }) {
    if (!Number.isFinite(originPrice)) throw new Error(`${MODULE}: originPrice must be a finite number`);
    if (!Number.isFinite(rowWidth) || rowWidth <= 0) throw new Error(`${MODULE}: rowWidth must be a positive finite number`);
    if (toPriceSubunits(rowWidth, "rowWidth", MODULE) <= 0) {
      throw new Error(`${MODULE}: rowWidth is finer than the representable price grid`);
    }
    return answer(async () => {
      const buckets = new Map();
      for (const level of await levels(symbol, assetClass, fromTs, toTs)) {
        if (rowWidth < level.tickSize) {
          throw new Error(`${MODULE}: rowWidth ${rowWidth} is finer than the archived tick ${level.tickSize}`);
        }
        const bucket = bucketIndexOf(level.priceBucket * level.tickSize, originPrice, rowWidth, MODULE);
        let entry = buckets.get(bucket);
        if (entry === undefined) {
          entry = { bucket, volume: 0, buyVolume: 0, sellVolume: 0 };
          buckets.set(bucket, entry);
        }
        entry.volume += level.volume;
        entry.buyVolume += level.buyVolume;
        entry.sellVolume += level.sellVolume;
      }
      return { buckets: [...buckets.values()].sort((left, right) => left.bucket - right.bucket), available: true };
    }, () => ({ buckets: [], available: false }));
  }

  async function readMinuteRollup(symbol, assetClass, { fromTs, toTs, tickSize }) {
    if (!Number.isFinite(tickSize) || tickSize <= 0) throw new Error(`${MODULE}: tickSize must be a positive finite number`);
    const tickSubunits = toPriceSubunits(tickSize, "tickSize", MODULE);
    return answer(async () => {
      const merged = new Map();
      await foldFamily(symbol, assetClass, FAMILY.level, fromTs, toTs, (rows) => {
        for (const row of rows) {
          const archivedTick = finite(row.tick_size, "tick_size");
          if (tickSize < archivedTick) {
            throw new Error(`${MODULE}: tickSize ${tickSize} is finer than the archived tick ${archivedTick}`);
          }
          const minuteTs = msOf(row.open_ns, "open_ns");
          const price = integer(row.price_bucket, "price_bucket") * archivedTick;
          const priceBucket = Math.floor(toPriceSubunits(price, "price", MODULE) / tickSubunits);
          const key = `${minuteTs}:${priceBucket}`;
          let entry = merged.get(key);
          if (entry === undefined) {
            entry = { minuteTs, priceBucket, volume: 0, buyVolume: 0, sellVolume: 0, tradeCount: 0 };
            merged.set(key, entry);
          }
          entry.volume += finite(row.volume, "volume");
          entry.buyVolume += finite(row.buy_volume, "buy_volume");
          entry.sellVolume += finite(row.sell_volume, "sell_volume");
          entry.tradeCount += integer(row.trade_count, "trade_count");
        }
      });
      const rows = [...merged.values()].sort(
        (left, right) => (left.minuteTs - right.minuteTs) || (left.priceBucket - right.priceBucket));
      return { rows, available: true };
    }, () => ({ rows: [], available: false }));
  }

  function slices(symbol, assetClass, fromTs, toTs, sliceMs) {
    const key = `${instrumentIdFor(symbol, assetClass)}|${fromTs}|${toTs}|${sliceMs}`;
    const cached = sliceMemo.get(key);
    if (cached !== undefined) return cached;
    const pending = (async () => {
      const merged = new Map();
      await foldFamily(symbol, assetClass, FAMILY.slice, fromTs, toTs, (rows) => {
        for (const row of rows) {
          const bucket = Math.floor(msOf(row.open_ns, "open_ns") / sliceMs);
          let entry = merged.get(bucket);
          if (entry === undefined) {
            entry = { bucket, sliceTs: 0, buyNotional: 0, sellNotional: 0 };
            merged.set(bucket, entry);
          }
          entry.sliceTs = Math.max(entry.sliceTs, msOf(row.last_trade_ns, "last_trade_ns"));
          entry.buyNotional += finite(row.buy_notional, "buy_notional");
          entry.sellNotional += finite(row.sell_notional, "sell_notional");
        }
      });
      return [...merged.values()]
        .sort((left, right) => left.bucket - right.bucket)
        .map(({ sliceTs, buyNotional, sellNotional }) => ({ sliceTs, buyNotional, sellNotional }));
    })();
    sliceMemo.set(key, pending);
    if (sliceMemo.size > SLICE_MEMO_ENTRIES) sliceMemo.delete(sliceMemo.keys().next().value);
    pending.catch(() => sliceMemo.delete(key));
    return pending;
  }

  async function readSlicedNotional(symbol, assetClass, { fromTs, toTs, sliceMs }) {
    multipleOf(sliceMs, SLICE_MS, "sliceMs");
    assertWindow(fromTs, toTs);
    return answer(async () => ({ rows: await slices(symbol, assetClass, fromTs, toTs, sliceMs), available: true }),
      () => ({ rows: [], available: false }));
  }

  function readMinuteFlow(symbol, assetClass, { fromTs, toTs }) {
    return answer(async () => {
      const minutes = new Map();
      await foldFamily(symbol, assetClass, FAMILY.minute, fromTs, toTs, (rows) => {
        for (const row of rows) {
          const minuteTs = msOf(row.open_ns, "open_ns");
          const volume = nonNegativeDecimal(row.volume, "volume");
          const buy = nonNegativeDecimal(row.buy_volume, "buy_volume");
          const sell = nonNegativeDecimal(row.sell_volume, "sell_volume");
          const unknown = nonNegativeDecimal(row.undefined_volume, "undefined_volume");
          if (buy.atoms + sell.atoms + unknown.atoms !== volume.atoms) {
            throw new Error(`${MODULE}: minute side volumes do not equal total volume`);
          }
          const tradeCount = integer(row.trade_count, "trade_count");
          if (tradeCount < 0) throw new Error(`${MODULE}: trade_count is negative`);
          let entry = minutes.get(minuteTs);
          if (entry === undefined) {
            entry = { minuteTs, volume: 0, buyVolume: 0, sellVolume: 0, unknownVolume: 0, tradeCount: 0 };
            minutes.set(minuteTs, entry);
          }
          entry.volume += volume.value;
          entry.buyVolume += buy.value;
          entry.sellVolume += sell.value;
          entry.unknownVolume += unknown.value;
          entry.tradeCount += tradeCount;
        }
      });
      const rows = [...minutes.values()].sort((left, right) => left.minuteTs - right.minuteTs);
      return { rows, available: true };
    }, () => ({ rows: [], available: false }));
  }

  function readDailyNotional(symbol, assetClass, { fromTs, toTs }) {
    return answer(async () => {
      const days = new Map();
      await foldFamily(symbol, assetClass, FAMILY.minute, fromTs, toTs, (rows) => {
        for (const row of rows) {
          const dayTs = Math.floor(msOf(row.open_ns, "open_ns") / DAY_MS) * DAY_MS;
          const notional = finite(row.buy_notional, "buy_notional") + finite(row.sell_notional, "sell_notional");
          days.set(dayTs, (days.get(dayTs) ?? 0) + notional);
        }
      });
      const rows = [...days.entries()].sort((left, right) => left[0] - right[0])
        .map(([dayTs, notional]) => ({ dayTs, notional }));
      return { rows, available: true };
    }, () => ({ rows: [], available: false }));
  }

  async function readLargeTradesAsync(symbol, assetClass, { nowMs, limit, fromMs, bucketMs, perBucketSideLimit }) {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error(`${MODULE}: nowMs must be a non-negative safe integer`);
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error(`${MODULE}: limit must be a positive safe integer`);
    if (!Number.isSafeInteger(fromMs) || fromMs < 0 || fromMs > nowMs) {
      throw new Error(`${MODULE}: fromMs must be a non-negative safe integer not after nowMs`);
    }
    multipleOf(bucketMs, MINUTE_MS, "bucketMs");
    if (!Number.isSafeInteger(perBucketSideLimit) || perBucketSideLimit < 1) {
      throw new Error(`${MODULE}: perBucketSideLimit must be a positive integer`);
    }
    return answer(async () => {
      const buckets = new Map();
      await foldFamily(symbol, assetClass, FAMILY.prints, fromMs, nowMs + 1, (rows) => {
        for (const row of rows) {
          if (row.side !== "BUY" && row.side !== "SELL") continue;
          const tradeNs = BigInt(String(row.trade_ns));
          const tradeMs = msOf(tradeNs, "trade_ns");
          if (tradeMs < fromMs || tradeMs > nowMs) continue;
          const price = finite(row.price, "price");
          const size = finite(row.size, "size");
          const key = `${Math.floor(tradeMs / bucketMs)}:${row.side}`;
          let kept = buckets.get(key);
          if (kept === undefined) {
            kept = [];
            buckets.set(key, kept);
          }
          offerPrint(kept, {
            magnitude: tradeMagnitude("DXFEED", assetClass, price, size),
            tradeNs,
            rank: integer(row.rank, "rank"),
            row: {
              symbol,
              asset_class: assetClass,
              event_kind: "NEW",
              valid_tick: 1,
              aggressor_side: row.side,
              event_time: tradeMs,
              time: tradeMs,
              time_nano_part: Number(tradeNs % BigInt(MS_NS)),
              sequence: 0,
              price,
              size,
              id: integer(row.rank, "rank"),
            },
          }, perBucketSideLimit);
        }
      });
      const rows = [...buckets.values()].flat()
        .sort((left, right) => (left.row.event_time - right.row.event_time) || (left.rank - right.rank))
        .map(({ row }) => ({ row }));
      return { rows: rows.length > limit ? rows.slice(-limit) : rows, available: true };
    }, () => ({ rows: [], available: false }));
  }

  function unavailableTrades() {
    return Promise.resolve({ rows: [], nextCursor: null, available: false });
  }

  function close() {
    closed = true;
    levelMemo.clear();
    sliceMemo.clear();
  }

  return {
    readPriceRange,
    readVolumeProfile,
    readMinuteRollup,
    readMinuteFlow,
    readSlicedNotional,
    readDailyNotional,
    readLargeTradesAsync,
    readTradesSince: unavailableTrades,
    readRecentTrades: unavailableTrades,
    close,
  };
}

module.exports = { createArchiveStorageReader, FAMILY, SLICE_MS, REQUEST_WINDOW_MS };
