const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_FINALITY_DELAY_MS = 2_000;
const DEFAULT_MAX_TRADES_PER_BAR = 100_000;
const { isAllowedAssetClass, isAllowedDxFeedSymbol } = require("./dxfeed-instrument-catalog");
const { assessLiveEventTime } = require("../shared/live-event-time-policy");

function bucketKey(symbol, assetClass) {
  return `${assetClass}:${symbol}`;
}

function bucketOpenTime(tsExchange, intervalMs) {
  return Math.floor(tsExchange / intervalMs) * intervalMs;
}

function snapshotBucket(bucket, closed) {
  return {
    ts_open: bucket.tsOpen,
    open: bucket.open,
    high: bucket.high,
    low: bucket.low,
    close: bucket.close,
    volume: bucket.volume,
    buy_volume: bucket.buyVolume,
    sell_volume: bucket.sellVolume,
    trade_count: bucket.tradeCount,
    closed,
  };
}

function newBucket(symbol, assetClass, tsOpen, price, size, side, tsExchange, timeNanoPart, sequence, tradeId) {
  return {
    symbol,
    assetClass,
    tsOpen,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: size,
    buyVolume: side === null ? null : side === "buy" ? size : 0,
    sellVolume: side === null ? null : side === "sell" ? size : 0,
    tradeCount: 1,
    firstTsExchange: tsExchange,
    firstTimeNanoPart: timeNanoPart,
    firstSequence: sequence,
    lastTsExchange: tsExchange,
    lastTimeNanoPart: timeNanoPart,
    lastSequence: sequence,
    tradeIds: new Set([tradeId]),
  };
}

function compareOrder(tsExchange, timeNanoPart, sequence, otherTs, otherNanoPart, otherSequence) {
  if (tsExchange !== otherTs) return tsExchange - otherTs;
  if (timeNanoPart === undefined || otherNanoPart === undefined) return 0;
  if (timeNanoPart !== otherNanoPart) return timeNanoPart - otherNanoPart;
  return sequence - otherSequence;
}

function compareEventOrder(bucket, tsExchange, timeNanoPart, sequence) {
  return compareOrder(tsExchange, timeNanoPart, sequence, bucket.lastTsExchange, bucket.lastTimeNanoPart, bucket.lastSequence);
}

function compareFirstOrder(bucket, tsExchange, timeNanoPart, sequence) {
  return compareOrder(tsExchange, timeNanoPart, sequence, bucket.firstTsExchange, bucket.firstTimeNanoPart, bucket.firstSequence);
}

function addVolume(bucket, size, side) {
  bucket.volume += size;
  if (bucket.buyVolume !== null) {
    if (side === null) bucket.buyVolume = null;
    else if (side === "buy") bucket.buyVolume += size;
  }
  if (bucket.sellVolume !== null) {
    if (side === null) bucket.sellVolume = null;
    else if (side === "sell") bucket.sellVolume += size;
  }
}

function createDxFeedBarAggregator({ intervalMs = DEFAULT_INTERVAL_MS, finalityDelayMs = DEFAULT_FINALITY_DELAY_MS, maxTradesPerBar = DEFAULT_MAX_TRADES_PER_BAR } = {}) {
  if (!Number.isSafeInteger(maxTradesPerBar) || maxTradesPerBar <= 0) throw new Error("dxfeed-bar-aggregator: invalid maxTradesPerBar");
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("dxfeed-bar-aggregator: intervalMs must be a positive integer");
  }
  if (!Number.isInteger(finalityDelayMs) || finalityDelayMs < 0) {
    throw new Error("dxfeed-bar-aggregator: finalityDelayMs must be a non-negative integer");
  }
  const buckets = new Map();
  const finalizedThrough = new Map();

  function ingest({ symbol, assetClass, tsExchange, price, size, side, timeNanoPart, sequence, tradeId, nowMs }) {
    if (typeof symbol !== "string" || symbol.trim().length === 0) {
      throw new Error("dxfeed-bar-aggregator: symbol must be a non-empty string");
    }
    if (!isAllowedAssetClass(assetClass)) {
      throw new Error("dxfeed-bar-aggregator: assetClass is unsupported");
    }
    if (!isAllowedDxFeedSymbol(symbol, assetClass)) {
      throw new Error("dxfeed-bar-aggregator: symbol/assetClass pair is unsupported");
    }
    if (!Number.isSafeInteger(tsExchange) || tsExchange <= 0) {
      throw new Error("dxfeed-bar-aggregator: tsExchange must be a positive safe integer");
    }
    if (nowMs !== undefined) {
      const eventTimeAssessment = assessLiveEventTime(tsExchange, nowMs);
      if (!eventTimeAssessment.ok) {
        return { closedBar: null, liveBar: null, dropped: true, dropReason: eventTimeAssessment.reason };
      }
    }
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      throw new Error("dxfeed-bar-aggregator: price must be a positive finite number");
    }
    if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
      throw new Error("dxfeed-bar-aggregator: size must be a positive finite number");
    }
    if (side !== "buy" && side !== "sell" && side !== null) {
      throw new Error('dxfeed-bar-aggregator: side must be "buy", "sell", or null');
    }
    if (typeof tradeId !== "string" || tradeId.trim().length === 0) {
      throw new Error("dxfeed-bar-aggregator: tradeId must be a non-empty string");
    }
    if ((timeNanoPart === undefined) !== (sequence === undefined)) {
      throw new Error("dxfeed-bar-aggregator: timeNanoPart and sequence must be supplied together");
    }
    if (
      timeNanoPart !== undefined &&
      (!Number.isSafeInteger(timeNanoPart) || timeNanoPart < 0 || !Number.isSafeInteger(sequence) || sequence < 0)
    ) {
      throw new Error("dxfeed-bar-aggregator: timeNanoPart and sequence must be non-negative safe integers");
    }

    const key = bucketKey(symbol, assetClass);
    const tsOpen = bucketOpenTime(tsExchange, intervalMs);
    const latestFinalizedOpen = finalizedThrough.get(key);
    if (latestFinalizedOpen !== undefined && tsOpen <= latestFinalizedOpen) {
      return { closedBar: null, liveBar: null, dropped: true, dropReason: "LATE_AFTER_FINALITY" };
    }
    const existing = buckets.get(key);

    if (existing?.tradeIds.has(tradeId)) {
      return { closedBar: null, liveBar: snapshotBucket(existing, false), dropped: true, dropReason: "DUPLICATE_TRADE" };
    }

    if (existing && compareEventOrder(existing, tsExchange, timeNanoPart, sequence) < 0) {
      if (tsOpen !== existing.tsOpen) {
        return { closedBar: null, liveBar: snapshotBucket(existing, false), dropped: true, dropReason: "OUT_OF_ORDER_TRADE" };
      }
      if (existing.tradeIds.size >= maxTradesPerBar) {
        buckets.delete(key);
        finalizedThrough.set(key, existing.tsOpen);
        const error = new Error("dxfeed-bar-aggregator: trade-ID capacity exceeded");
        error.code = "DXFEED_BAR_CAPACITY_EXCEEDED";
        throw error;
      }
      existing.high = Math.max(existing.high, price);
      existing.low = Math.min(existing.low, price);
      if (compareFirstOrder(existing, tsExchange, timeNanoPart, sequence) < 0) {
        existing.open = price;
        existing.firstTsExchange = tsExchange;
        existing.firstTimeNanoPart = timeNanoPart;
        existing.firstSequence = sequence;
      }
      addVolume(existing, size, side);
      existing.tradeCount += 1;
      existing.tradeIds.add(tradeId);
      return { closedBar: null, liveBar: snapshotBucket(existing, false), dropped: false, dropReason: null };
    }

    if (!existing) {
      const bucket = newBucket(symbol, assetClass, tsOpen, price, size, side, tsExchange, timeNanoPart, sequence, tradeId);
      buckets.set(key, bucket);
      return { closedBar: null, liveBar: snapshotBucket(bucket, false), dropped: false, dropReason: null };
    }

    if (tsOpen === existing.tsOpen) {
      if (existing.tradeIds.size >= maxTradesPerBar) {
        buckets.delete(key);
        finalizedThrough.set(key, existing.tsOpen);
        const error = new Error("dxfeed-bar-aggregator: trade-ID capacity exceeded");
        error.code = "DXFEED_BAR_CAPACITY_EXCEEDED";
        throw error;
      }
      existing.high = Math.max(existing.high, price);
      existing.low = Math.min(existing.low, price);
      existing.close = price;
      addVolume(existing, size, side);
      existing.tradeCount += 1;
      existing.lastTsExchange = tsExchange;
      existing.lastTimeNanoPart = timeNanoPart;
      existing.lastSequence = sequence;
      existing.tradeIds.add(tradeId);
      return { closedBar: null, liveBar: snapshotBucket(existing, false), dropped: false, dropReason: null };
    }

    const closedBar = snapshotBucket(existing, true);
    finalizedThrough.set(key, existing.tsOpen);
    const bucket = newBucket(symbol, assetClass, tsOpen, price, size, side, tsExchange, timeNanoPart, sequence, tradeId);
    buckets.set(key, bucket);
    return { closedBar, liveBar: snapshotBucket(bucket, false), dropped: false, dropReason: null };
  }

  function currentBar(symbol, assetClass) {
    const bucket = buckets.get(bucketKey(symbol, assetClass));
    return bucket ? snapshotBucket(bucket, false) : null;
  }

  function seedFinalizedThrough(symbol, assetClass, tsOpen) {
    if (!isAllowedAssetClass(assetClass) || !isAllowedDxFeedSymbol(symbol, assetClass)) {
      throw new Error("dxfeed-bar-aggregator: symbol/assetClass pair is unsupported");
    }
    if (!Number.isSafeInteger(tsOpen) || tsOpen < 0 || tsOpen % intervalMs !== 0) {
      throw new Error("dxfeed-bar-aggregator: finalized watermark must be an aligned non-negative safe integer");
    }
    const key = bucketKey(symbol, assetClass);
    const previous = finalizedThrough.get(key);
    if (previous !== undefined && previous >= tsOpen) return previous;
    finalizedThrough.set(key, tsOpen);
    const bucket = buckets.get(key);
    if (bucket && bucket.tsOpen <= tsOpen) buckets.delete(key);
    return tsOpen;
  }

  function finalizeThrough(nowMs, canFinalize = () => true) {
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
      throw new Error("dxfeed-bar-aggregator: finalizeThrough nowMs must be a positive safe integer");
    }
    const finalized = [];
    for (const [key, bucket] of buckets) {
      if (!canFinalize(bucket.symbol, bucket.assetClass)) continue;
      if (nowMs < bucket.tsOpen + intervalMs + finalityDelayMs) continue;
      const bar = snapshotBucket(bucket, true);
      finalizedThrough.set(key, bucket.tsOpen);
      buckets.delete(key);
      finalized.push(Object.freeze({ symbol: bucket.symbol, assetClass: bucket.assetClass, bar }));
    }
    return Object.freeze(finalized);
  }

  function reset(symbol, assetClass) {
    const key = bucketKey(symbol, assetClass);
    buckets.delete(key);
    finalizedThrough.delete(key);
  }

  return Object.freeze({ ingest, currentBar, finalizeThrough, seedFinalizedThrough, reset });
}

module.exports = { createDxFeedBarAggregator, DEFAULT_INTERVAL_MS, DEFAULT_FINALITY_DELAY_MS, DEFAULT_MAX_TRADES_PER_BAR };
