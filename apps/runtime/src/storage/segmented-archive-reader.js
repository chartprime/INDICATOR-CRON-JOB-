"use strict";

const { createArchiveStorageReader } = require("./archive-storage-reader");

const MODULE = "segmented-archive-reader";
const MINUTE_MS = 60_000;
const MAX_SEGMENTS = 64;

function validateSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > MAX_SEGMENTS) {
    throw new Error(`${MODULE}: segments must be a non-empty array of at most ${MAX_SEGMENTS}`);
  }
  let previousTo = -1;
  return segments.map((segment, index) => {
    const { instrumentId, fromTs, toTs } = segment ?? {};
    if (typeof instrumentId !== "string" || instrumentId.length === 0 || instrumentId.length > 256) {
      throw new Error(`${MODULE}: segments[${index}].instrumentId must be a non-empty string`);
    }
    if (!Number.isSafeInteger(fromTs) || fromTs < 0 || !Number.isSafeInteger(toTs) || toTs <= fromTs) {
      throw new Error(`${MODULE}: segments[${index}] must be a non-empty [fromTs, toTs) window`);
    }
    if (fromTs % MINUTE_MS !== 0 || toTs % MINUTE_MS !== 0) {
      throw new Error(`${MODULE}: segments[${index}] must start and end on a minute`);
    }
    if (fromTs < previousTo) {
      throw new Error(`${MODULE}: segments must be ordered and must not overlap`);
    }
    previousTo = toTs;
    return Object.freeze({ instrumentId, fromTs, toTs });
  });
}

function createSegmentedArchiveReader({ segments, fetchPage, maxPages, pageLimit }) {
  const plan = validateSegments(segments);
  const readers = plan.map((segment) => ({
    segment,
    reader: createArchiveStorageReader({
      fetchPage,
      instrumentIdFor: () => segment.instrumentId,
      tickSizeFor: () => null,
      ...(maxPages === undefined ? {} : { maxPages }),
      ...(pageLimit === undefined ? {} : { pageLimit }),
    }),
  }));

  function overlapping(fromTs, toTs) {
    return readers
      .map(({ segment, reader }) => ({
        reader,
        fromTs: Math.max(fromTs, segment.fromTs),
        toTs: Math.min(toTs, segment.toTs),
      }))
      .filter((part) => part.toTs > part.fromTs);
  }

  async function each(fromTs, toTs, read) {
    const parts = overlapping(fromTs, toTs);
    if (parts.length === 0 || parts[0].fromTs !== fromTs || parts.at(-1).toTs !== toTs) return null;
    for (let index = 1; index < parts.length; index += 1) {
      if (parts[index].fromTs !== parts[index - 1].toTs) return null;
    }
    const answers = [];
    for (const part of parts) answers.push(await read(part));
    return answers;
  }

  async function readPriceRange(symbol, assetClass, { fromTs, toTs }) {
    const answers = await each(fromTs, toTs, ({ reader, fromTs: from, toTs: to }) =>
      reader.readPriceRange(symbol, assetClass, { fromTs: from, toTs: to }));
    if (answers === null || answers.some((answer) => !answer.available)) {
      return { minPrice: null, maxPrice: null, tradeCount: 0, available: false };
    }
    let minPrice = null;
    let maxPrice = null;
    let tradeCount = 0;
    for (const answer of answers) {
      if (answer.minPrice !== null && (minPrice === null || answer.minPrice < minPrice)) minPrice = answer.minPrice;
      if (answer.maxPrice !== null && (maxPrice === null || answer.maxPrice > maxPrice)) maxPrice = answer.maxPrice;
      tradeCount += answer.tradeCount;
    }
    return { minPrice, maxPrice, tradeCount, available: true };
  }

  async function readVolumeProfile(symbol, assetClass, { fromTs, toTs, originPrice, rowWidth }) {
    const answers = await each(fromTs, toTs, ({ reader, fromTs: from, toTs: to }) =>
      reader.readVolumeProfile(symbol, assetClass, { fromTs: from, toTs: to, originPrice, rowWidth }));
    if (answers === null || answers.some((answer) => !answer.available)) return { buckets: [], available: false };
    const merged = new Map();
    for (const answer of answers) {
      for (const bucket of answer.buckets) {
        const entry = merged.get(bucket.bucket) ?? { bucket: bucket.bucket, volume: 0, buyVolume: 0, sellVolume: 0 };
        entry.volume += bucket.volume;
        entry.buyVolume += bucket.buyVolume;
        entry.sellVolume += bucket.sellVolume;
        merged.set(bucket.bucket, entry);
      }
    }
    return { buckets: [...merged.values()].sort((left, right) => left.bucket - right.bucket), available: true };
  }

  async function readMinuteRollup(symbol, assetClass, { fromTs, toTs, tickSize }) {
    const answers = await each(fromTs, toTs, ({ reader, fromTs: from, toTs: to }) =>
      reader.readMinuteRollup(symbol, assetClass, { fromTs: from, toTs: to, tickSize }));
    if (answers === null || answers.some((answer) => !answer.available)) return { rows: [], available: false };
    const rows = answers.flatMap((answer) => answer.rows)
      .sort((left, right) => (left.minuteTs - right.minuteTs) || (left.priceBucket - right.priceBucket));
    return { rows, available: true };
  }

  async function readMinuteFlow(symbol, assetClass, { fromTs, toTs }) {
    const answers = await each(fromTs, toTs, ({ reader, fromTs: from, toTs: to }) =>
      reader.readMinuteFlow(symbol, assetClass, { fromTs: from, toTs: to }));
    if (answers === null || answers.some((answer) => !answer.available)) return { rows: [], available: false };
    const rows = answers.flatMap((answer) => answer.rows).sort((left, right) => left.minuteTs - right.minuteTs);
    return { rows, available: true };
  }

  async function readSlicedNotional(symbol, assetClass, { fromTs, toTs, sliceMs }) {
    if (!Number.isSafeInteger(sliceMs) || sliceMs <= 0 || MINUTE_MS % sliceMs !== 0) {
      throw new Error(`${MODULE}: sliceMs must divide a minute so no slice straddles a contract boundary`);
    }
    const answers = await each(fromTs, toTs, ({ reader, fromTs: from, toTs: to }) =>
      reader.readSlicedNotional(symbol, assetClass, { fromTs: from, toTs: to, sliceMs }));
    if (answers === null || answers.some((answer) => !answer.available)) return { rows: [], available: false };
    const rows = answers.flatMap((answer) => answer.rows).sort((left, right) => left.sliceTs - right.sliceTs);
    return { rows, available: true };
  }

  async function readDailyNotional(symbol, assetClass, { fromTs, toTs }) {
    const answers = await each(fromTs, toTs, ({ reader, fromTs: from, toTs: to }) =>
      reader.readDailyNotional(symbol, assetClass, { fromTs: from, toTs: to }));
    if (answers === null || answers.some((answer) => !answer.available)) return { rows: [], available: false };
    const days = new Map();
    for (const answer of answers) {
      for (const row of answer.rows) days.set(row.dayTs, (days.get(row.dayTs) ?? 0) + row.notional);
    }
    const rows = [...days.entries()].sort((left, right) => left[0] - right[0])
      .map(([dayTs, notional]) => ({ dayTs, notional }));
    return { rows, available: true };
  }

  async function readLargeTradesAsync(symbol, assetClass, options) {
    const { nowMs, fromMs, limit } = options;
    const answers = await each(fromMs, nowMs + 1, ({ reader, fromTs: from, toTs: to }) =>
      reader.readLargeTradesAsync(symbol, assetClass, { ...options, fromMs: from, nowMs: to - 1 }));
    if (answers === null || answers.some((answer) => !answer.available)) return { rows: [], available: false };
    const rows = answers.flatMap((answer) => answer.rows)
      .sort((left, right) => (left.row.event_time - right.row.event_time) || (left.row.id - right.row.id));
    return { rows: rows.length > limit ? rows.slice(-limit) : rows, available: true };
  }

  function unavailableTrades() {
    return Promise.resolve({ rows: [], nextCursor: null, available: false });
  }

  function close() {
    for (const { reader } of readers) reader.close();
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

module.exports = { createSegmentedArchiveReader, MAX_SEGMENTS };
