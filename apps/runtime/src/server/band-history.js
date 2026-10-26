"use strict";

const { createMemoryEngine } = require("../indicators/l2-memory/memory-engine");
const { quantizeSize, rowOf, DEFAULT_SIZE_DIGITS } = require("../indicators/passive_liquidity/liquidity-sampler");

const MAX_BAND_ROWS = 256;
const MAX_BAND_WINDOW_MS = 2 * 60 * 60 * 1_000;
const MAX_BAND_CELLS = 100_000;
const MIN_COLUMN_MS = 1_000;
const MAX_COLUMN_MS = 60_000;
const PRUNE_EVERY_MS = 30_000;
const DEFAULT_YIELD_EVERY = 400;

function bandRowsFor({ priceLo, priceHi, tickSize, clusterTicks, rowClusters }) {
  const rowWidth = tickSize * clusterTicks * rowClusters;
  const rowLo = Math.floor(Math.round(priceLo / tickSize) / clusterTicks / rowClusters);
  const rowHi = Math.floor(Math.round(priceHi / tickSize) / clusterTicks / rowClusters);
  return { rowWidth, rowLo, rowHi };
}

function validateBandOptions(options) {
  const allowed = new Set(["fromTs", "toTs", "tickSize", "clusterTicks", "rowClusters", "priceLo", "priceHi", "columnMs"]);
  const unknown = Object.keys(options).filter((key) => !allowed.has(key));
  if (unknown.length > 0) return `UNKNOWN_OPTIONS:${unknown.sort().join(",")}`;
  const { fromTs, toTs, tickSize, clusterTicks, rowClusters, priceLo, priceHi, columnMs } = options;
  if (!Number.isSafeInteger(fromTs) || !Number.isSafeInteger(toTs) || fromTs < 0 || toTs <= fromTs ||
      toTs - fromTs > MAX_BAND_WINDOW_MS) return "TIME_RANGE_OUT_OF_RANGE:fromTs/toTs";
  if (!Number.isFinite(tickSize) || tickSize <= 0) return "TICK_SIZE_OUT_OF_RANGE";
  for (const field of ["clusterTicks", "rowClusters"]) {
    if (!Number.isSafeInteger(options[field]) || options[field] <= 0 || options[field] > 100_000) return `${field.toUpperCase()}_OUT_OF_RANGE`;
  }
  if (!Number.isSafeInteger(columnMs) || columnMs < MIN_COLUMN_MS || columnMs > MAX_COLUMN_MS || columnMs % MIN_COLUMN_MS !== 0) return "COLUMN_MS_OUT_OF_RANGE";
  if (!Number.isFinite(priceLo) || !Number.isFinite(priceHi) || priceLo <= 0 || priceHi < priceLo) return "PRICE_BAND_OUT_OF_RANGE";
  const { rowWidth, rowLo, rowHi } = bandRowsFor({ priceLo, priceHi, tickSize, clusterTicks, rowClusters });
  if (!Number.isFinite(rowWidth) || rowWidth <= 0 || !Number.isSafeInteger(rowLo) || !Number.isSafeInteger(rowHi) || rowLo < 0 || rowHi < rowLo) return "PRICE_BAND_OUT_OF_RANGE";
  const rows = rowHi - rowLo + 1;
  if (rows > MAX_BAND_ROWS) return `BAND_ROWS_OUT_OF_RANGE:1..${MAX_BAND_ROWS}`;
  if (rows * Math.ceil((toTs - fromTs) / columnMs) > MAX_BAND_CELLS) return `BAND_CELLS_OUT_OF_RANGE:${MAX_BAND_CELLS}`;
  return null;
}

async function runBandHistory({
  source, tickSize, clusterTicks, rowClusters, fullDepth = false, snapshotDepth = Infinity,
  fromTs, toTs, columnMs, priceLo, priceHi, sizeDigits = DEFAULT_SIZE_DIGITS, yieldEvery = DEFAULT_YIELD_EVERY,
}) {
  const problem = validateBandOptions({ fromTs, toTs, tickSize, clusterTicks, rowClusters, priceLo, priceHi, columnMs });
  if (problem !== null) throw new Error(`band-history: ${problem}`);
  const { rowWidth, rowLo, rowHi } = bandRowsFor({ priceLo, priceHi, tickSize, clusterTicks, rowClusters });
  const rows = rowHi - rowLo + 1;
  const engine = createMemoryEngine({ tickSize, clusterTicks, snapshotDepth, fullDepth });
  const columns = [];
  let pending = [];
  let nextTs = Math.ceil(fromTs / columnMs) * columnMs;
  let lastFrameTs = null;
  let lastReadyBookTs = -Infinity;
  let lastPruneTs = null;
  let frames = 0;

  function rowIndex(key) {
    const row = rowOf(key, rowClusters);
    return row >= rowLo && row <= rowHi ? row - rowLo : -1;
  }

  function sampleUpTo(limitTs) {
    while (nextTs <= limitTs) {
      for (const print of engine.drainPrints()) pending.push(print);
      const buy = new Array(rows).fill(0);
      const sell = new Array(rows).fill(0);
      const later = [];
      for (const print of pending) {
        if (print.ts > nextTs) { later.push(print); continue; }
        const index = rowIndex(engine.keyFor(print.price));
        if (index < 0 || !(print.size > 0)) continue;
        (print.side === "buy" ? buy : sell)[index] += print.size;
      }
      pending = later;
      if (engine.seeded && engine.live !== false) {
        const snapshot = engine.liteSnapshot();
        const bid = new Array(rows).fill(0);
        const ask = new Array(rows).fill(0);
        for (const level of snapshot.bids) { const index = rowIndex(level.key); if (index >= 0) bid[index] += level.size; }
        for (const level of snapshot.asks) { const index = rowIndex(level.key); if (index >= 0) ask[index] += level.size; }
        columns.push({
          ts: nextTs,
          bid: bid.map((size) => quantizeSize(size, sizeDigits)),
          ask: ask.map((size) => quantizeSize(size, sizeDigits)),
          buy: buy.map((size) => quantizeSize(size, sizeDigits)),
          sell: sell.map((size) => quantizeSize(size, sizeDigits)),
        });
      }
      nextTs += columnMs;
    }
  }

  try {
    for await (const frame of source.frames()) {
      if (frame.ts >= nextTs) sampleUpTo(Math.min(toTs, frame.ts - 1));
      if (frame.kind === "anchor" || (frame.kind === "book" && frame.status !== "READY")) {
        while (columns.length > 0 && columns[columns.length - 1].ts > lastReadyBookTs) columns.pop();
      } else if (frame.kind === "book") {
        lastReadyBookTs = frame.ts;
      }
      engine.apply(frame);
      lastFrameTs = frame.ts;
      frames += 1;
      if (lastPruneTs === null || frame.ts - lastPruneTs >= PRUNE_EVERY_MS) {
        engine.prune(frame.ts);
        lastPruneTs = frame.ts;
      }
      if (frames % yieldEvery === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    if (lastFrameTs !== null) sampleUpTo(Math.min(toTs, lastFrameTs));
  } finally {
    source.close();
  }
  return {
    available: true,
    rowWidth,
    rowLo,
    rowHi,
    columnMs,
    columns,
    frames,
    reason: frames === 0 ? "NO_DATA_IN_WINDOW" : null,
    stats: source.stats ?? null,
  };
}

module.exports = {
  runBandHistory, bandRowsFor, validateBandOptions,
  MAX_BAND_ROWS, MAX_BAND_WINDOW_MS, MAX_BAND_CELLS, MIN_COLUMN_MS, MAX_COLUMN_MS,
};
