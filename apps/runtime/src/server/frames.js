const {
  listAllowedCandleIntervals,
  candleIntervalMsFor,
  isAllowedSymbol,
  isAllowedMarketKind,
} = require("../providers/binance/binance-config");
const { isAllowedAssetClass, isAllowedDxFeedSymbol } = require("../providers/dxfeed/dxfeed-instrument-catalog");
const { PRINT_WINDOW_COLUMNS } = require("../indicators/passive_liquidity/column-flow");
const { floorAbove } = require("../indicators/passive_liquidity/bounded-prints");
const {
  MAX_WIRE_MAGNITUDE,
  MAX_BAR_VOLUME,
  MAX_EQUITY_TRADE_SIZE,
  MAX_PROFILE_VOLUME,
  MAX_VALID_EPOCH_MS,
  decimalToFiniteNumber,
  sizeCeilingForAssetClass,
  timestampToWireNumber,
  buildProfileWireFields,
  buildVpinWireFields,
  vpinReadingsToWire,
} = require("./wire-fields");

const INTERVAL_MS = Object.freeze(
  Object.fromEntries(listAllowedCandleIntervals().map((interval) => [interval, candleIntervalMsFor(interval)])),
);
const MAX_TRADE_ID_LENGTH = 128;
const MAX_REASON_LENGTH = 256;
const BOOK_DEPTH_LEVELS = 20;
const MAX_SNAPSHOT_BARS = 10_080;
const MAX_SNAPSHOT_TRADES = 100;
const MAX_SNAPSHOT_MARKERS = 5_000;
const MAX_MARKER_HISTORY_ROWS = 5_000;
const MAX_LIQUIDITY_COLUMNS = 120;
const MAX_LIQUIDITY_ROWS = 2048;
const MAX_LIQUIDITY_LEVELS = 400;
const MAX_AGGRESSIVE_EVENTS = 200;
const MAX_LIQUIDITY_PRINTS = 64;
const MAX_AGGRESSIVE_POOL_PRINTS = 20_000;
const LIQUIDITY_COLUMN_KEYS = Object.freeze(["ts", "lo", "hi", "bid", "ask", "buy", "sell", "prints", "prints_floor"]);
const DXFEED_CANDLE_INTERVAL_MS = 60_000;
const VPIN_STATUSES = new Set(["DISABLED", "IDLE", "WARMING", "READY", "UNAVAILABLE"]);

for (const interval of listAllowedCandleIntervals()) {
  if (!Number.isInteger(INTERVAL_MS[interval])) {
    throw new Error(`frames.js: INTERVAL_MS is missing an entry for allowed interval "${interval}"`);
  }
}

function toWireSymbol(symbol) {
  if (!isAllowedSymbol(symbol)) {
    throw new Error(`toWireSymbol: unsupported symbol shape "${symbol}"`);
  }
  return `${symbol.slice(0, -4)}-USDT`;
}

function fromWireSymbol(wireSymbol) {
  if (typeof wireSymbol !== "string" || !wireSymbol.endsWith("-USDT")) {
    throw new Error(`fromWireSymbol: unsupported symbol shape "${wireSymbol}"`);
  }
  const symbol = `${wireSymbol.slice(0, -5)}USDT`;
  if (!isAllowedSymbol(symbol)) {
    throw new Error(`fromWireSymbol: unsupported symbol shape "${wireSymbol}"`);
  }
  return symbol;
}

function dxfeedToWireSymbol(symbol, assetClass) {
  if (!isAllowedDxFeedSymbol(symbol, assetClass)) {
    throw new Error(`dxfeedToWireSymbol: unsupported symbol/assetClass "${symbol}"/"${assetClass}"`);
  }
  return symbol;
}

function dxfeedFromWireSymbol(wireSymbol, assetClass) {
  if (!isAllowedDxFeedSymbol(wireSymbol, assetClass)) {
    throw new Error(`dxfeedFromWireSymbol: unsupported symbol/assetClass "${wireSymbol}"/"${assetClass}"`);
  }
  return wireSymbol;
}

function decimalToFiniteNumberOrUndefined(value, field) {
  if (value === null || value === undefined) return undefined;
  return decimalToFiniteNumber(value, field, { allowZero: true });
}

function assertMarketKind(marketKind, field) {
  if (!isAllowedMarketKind(marketKind)) {
    throw new Error(`${field}: unsupported market kind`);
  }
}

function assertAssetClass(assetClass, field) {
  if (!isAllowedAssetClass(assetClass)) {
    throw new Error(`${field}: unsupported asset class`);
  }
}

function tradeIdToWireString(value, field) {
  if (
    (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") ||
    (typeof value === "number" && !Number.isSafeInteger(value))
  ) {
    throw new Error(`${field}: trade id is outside the supported wire range`);
  }
  const converted = String(value);
  const hasControlCharacter = [...converted].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (
    converted.length === 0 ||
    converted.trim() !== converted ||
    converted.length > MAX_TRADE_ID_LENGTH ||
    hasControlCharacter
  ) {
    throw new Error(`${field}: trade id is outside the supported wire range`);
  }
  return converted;
}

function assertSide(side, field) {
  if (side !== "buy" && side !== "sell") {
    throw new Error(`${field}: side must be buy or sell`);
  }
}

function assertBarShape({ intervalMs, tsOpen, open, high, low, close, volume, buyVolume, tradeCount, closed }, field) {
  timestampToWireNumber(tsOpen, `${field}.ts_open`);
  if (tsOpen % intervalMs !== 0) {
    throw new Error(`${field}: ts_open must align to interval_ms`);
  }
  if (low > Math.min(open, close) || high < Math.max(open, close) || low > high) {
    throw new Error(`${field}: OHLC values are internally inconsistent`);
  }
  if (buyVolume !== undefined && buyVolume > volume) {
    throw new Error(`${field}: buy volume cannot exceed total volume`);
  }
  if (!Number.isSafeInteger(tradeCount) || tradeCount < 0) {
    throw new Error(`${field}: trade_count must be a non-negative safe integer`);
  }
  if (typeof closed !== "boolean") {
    throw new Error(`${field}: closed must be boolean`);
  }
}

function tradeEnvelopeToFrame(envelope) {
  const { tradeId, price, quantity, isBuyerMaker } = envelope.payload;
  assertMarketKind(envelope.marketKind, "tradeEnvelopeToFrame.marketKind");
  if (typeof isBuyerMaker !== "boolean") {
    throw new Error("tradeEnvelopeToFrame.isBuyerMaker: expected boolean");
  }
  const tsExchange = timestampToWireNumber(Date.parse(envelope.eventTime), "tradeEnvelopeToFrame.eventTime");
  const wireTradeId = tradeIdToWireString(tradeId, "tradeEnvelopeToFrame.tradeId");
  return Object.freeze({
    type: "trade",
    provider: "BINANCE",
    symbol: toWireSymbol(envelope.providerSymbol),
    marketKind: envelope.marketKind,
    ts_exchange: tsExchange,
    price: decimalToFiniteNumber(price, "tradeEnvelopeToFrame.price"),
    size: decimalToFiniteNumber(quantity, "tradeEnvelopeToFrame.quantity"),
    side: isBuyerMaker ? "sell" : "buy",
    trade_id: wireTradeId,
  });
}

function klineEnvelopeToFrame(envelope) {
  const { interval, openTime, open, high, low, close, baseVolume, takerBuyBaseVolume, numberOfTrades, isClosed } =
    envelope.payload;
  const intervalMs = INTERVAL_MS[interval];
  if (!Number.isInteger(intervalMs)) {
    throw new Error(`klineEnvelopeToFrame: unrecognized interval "${interval}"`);
  }
  assertMarketKind(envelope.marketKind, "klineEnvelopeToFrame.marketKind");
  const wireOpen = decimalToFiniteNumber(open, "klineEnvelopeToFrame.open");
  const wireHigh = decimalToFiniteNumber(high, "klineEnvelopeToFrame.high");
  const wireLow = decimalToFiniteNumber(low, "klineEnvelopeToFrame.low");
  const wireClose = decimalToFiniteNumber(close, "klineEnvelopeToFrame.close");
  const wireVolume = decimalToFiniteNumber(baseVolume, "klineEnvelopeToFrame.baseVolume", { allowZero: true });
  const buyVolume = decimalToFiniteNumberOrUndefined(takerBuyBaseVolume, "klineEnvelopeToFrame.takerBuyBaseVolume");
  assertBarShape({
    intervalMs,
    tsOpen: openTime,
    open: wireOpen,
    high: wireHigh,
    low: wireLow,
    close: wireClose,
    volume: wireVolume,
    buyVolume,
    tradeCount: numberOfTrades,
    closed: isClosed,
  }, "klineEnvelopeToFrame");
  return Object.freeze({
    type: "bar",
    provider: "BINANCE",
    symbol: toWireSymbol(envelope.providerSymbol),
    marketKind: envelope.marketKind,
    interval_ms: intervalMs,
    ts_open: openTime,
    open: wireOpen,
    high: wireHigh,
    low: wireLow,
    close: wireClose,
    volume: wireVolume,
    trade_count: numberOfTrades,
    closed: isClosed,
    ...(buyVolume !== undefined ? { buy_volume: buyVolume } : {}),
  });
}

function restKlineRowToBarFrame(row, symbol, marketKind, interval) {
  const intervalMs = INTERVAL_MS[interval];
  if (!Number.isInteger(intervalMs)) {
    throw new Error(`restKlineRowToBarFrame: unrecognized interval "${interval}"`);
  }
  assertMarketKind(marketKind, "restKlineRowToBarFrame.marketKind");
  if (!Number.isSafeInteger(row?.openTime) || row.openTime % intervalMs !== 0) {
    throw new Error("restKlineRowToBarFrame: openTime must align to the requested interval");
  }
  timestampToWireNumber(row.openTime, "restKlineRowToBarFrame.openTime");
  if (!Number.isSafeInteger(row.closeTime) || row.closeTime !== row.openTime + intervalMs - 1) {
    throw new Error("restKlineRowToBarFrame: closeTime must match the requested interval");
  }
  if (row.closeTime > Date.now()) {
    return null;
  }
  const wireOpen = decimalToFiniteNumber(row.open, "restKlineRowToBarFrame.open");
  const wireHigh = decimalToFiniteNumber(row.high, "restKlineRowToBarFrame.high");
  const wireLow = decimalToFiniteNumber(row.low, "restKlineRowToBarFrame.low");
  const wireClose = decimalToFiniteNumber(row.close, "restKlineRowToBarFrame.close");
  const wireVolume = decimalToFiniteNumber(row.volume, "restKlineRowToBarFrame.volume", { allowZero: true });
  const buyVolume = decimalToFiniteNumberOrUndefined(row.takerBuyBaseVolume, "restKlineRowToBarFrame.takerBuyBaseVolume");
  assertBarShape({
    intervalMs,
    tsOpen: row.openTime,
    open: wireOpen,
    high: wireHigh,
    low: wireLow,
    close: wireClose,
    volume: wireVolume,
    buyVolume,
    tradeCount: row.numberOfTrades,
    closed: true,
  }, "restKlineRowToBarFrame");
  return Object.freeze({
    type: "bar",
    provider: "BINANCE",
    symbol: toWireSymbol(symbol),
    marketKind,
    interval_ms: intervalMs,
    ts_open: row.openTime,
    open: wireOpen,
    high: wireHigh,
    low: wireLow,
    close: wireClose,
    volume: wireVolume,
    trade_count: row.numberOfTrades,
    closed: true,
    reconstructed: true,
    ...(buyVolume !== undefined ? { buy_volume: buyVolume } : {}),
  });
}

function storageCandleRowToBarFrame(row, symbol, marketKind, interval) {
  const intervalMs = INTERVAL_MS[interval];
  if (!Number.isInteger(intervalMs)) {
    throw new Error(`storageCandleRowToBarFrame: unrecognized interval "${interval}"`);
  }
  assertMarketKind(marketKind, "storageCandleRowToBarFrame.marketKind");
  const wireOpen = decimalToFiniteNumber(row.open, "storageCandleRowToBarFrame.open");
  const wireHigh = decimalToFiniteNumber(row.high, "storageCandleRowToBarFrame.high");
  const wireLow = decimalToFiniteNumber(row.low, "storageCandleRowToBarFrame.low");
  const wireClose = decimalToFiniteNumber(row.close, "storageCandleRowToBarFrame.close");
  const wireVolume = decimalToFiniteNumber(row.volume, "storageCandleRowToBarFrame.volume", { allowZero: true });
  const buyVolume = decimalToFiniteNumberOrUndefined(
    row.taker_buy_base_volume,
    "storageCandleRowToBarFrame.takerBuyBaseVolume",
  );
  assertBarShape({
    intervalMs,
    tsOpen: row.ts_open,
    open: wireOpen,
    high: wireHigh,
    low: wireLow,
    close: wireClose,
    volume: wireVolume,
    buyVolume,
    tradeCount: row.trade_count,
    closed: true,
  }, "storageCandleRowToBarFrame");
  return Object.freeze({
    type: "bar",
    provider: "BINANCE",
    symbol: toWireSymbol(symbol),
    marketKind,
    interval_ms: intervalMs,
    ts_open: row.ts_open,
    open: wireOpen,
    high: wireHigh,
    low: wireLow,
    close: wireClose,
    volume: wireVolume,
    trade_count: row.trade_count,
    closed: true,
    ...(buyVolume !== undefined ? { buy_volume: buyVolume } : {}),
  });
}

function storageTradeRowToTradeFrame(row, symbol, marketKind) {
  assertMarketKind(marketKind, "storageTradeRowToTradeFrame.marketKind");
  assertSide(row.side, "storageTradeRowToTradeFrame.side");
  return Object.freeze({
    type: "trade",
    provider: "BINANCE",
    symbol: toWireSymbol(symbol),
    marketKind,
    ts_exchange: timestampToWireNumber(row.ts, "storageTradeRowToTradeFrame.ts"),
    price: decimalToFiniteNumber(row.price, "storageTradeRowToTradeFrame.price"),
    size: decimalToFiniteNumber(row.size, "storageTradeRowToTradeFrame.size"),
    side: row.side,
    trade_id: tradeIdToWireString(row.trade_id, "storageTradeRowToTradeFrame.tradeId"),
  });
}

function markerFrame(trade, symbol, marketKind) {
  assertMarketKind(marketKind, "markerFrame.marketKind");
  assertSide(trade.side, "markerFrame.side");
  return Object.freeze({
    type: "marker",
    provider: "BINANCE",
    symbol: toWireSymbol(symbol),
    marketKind,
    ts_exchange: timestampToWireNumber(trade.ts_exchange, "markerFrame.ts_exchange"),
    price: decimalToFiniteNumber(trade.price, "markerFrame.price"),
    size: decimalToFiniteNumber(trade.size, "markerFrame.size"),
    side: trade.side,
    trade_id: tradeIdToWireString(trade.trade_id, "markerFrame.tradeId"),
  });
}

// L2 Passive Liquidity heatmap: resting size per price row over time for the
// active pair. Each column is a delta against the column before it (see
// indicators/passive_liquidity/liquidity-history.js); `reset` marks the start
// of a fresh history whose first column is complete.
function liquiditySideEntries(entries, span, field, ceiling) {
  if (!Array.isArray(entries) || entries.length > span) {
    throw new Error(`${field}: must be an array of at most ${span} [offset, size] pairs`);
  }
  let previousOffset = -1;
  return Object.freeze(entries.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error(`${field}[${index}]: must be an [offset, size] pair`);
    }
    const [offset, size] = entry;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= span || offset <= previousOffset) {
      throw new Error(`${field}[${index}].offset: must be an increasing integer within the column window`);
    }
    previousOffset = offset;
    return Object.freeze([offset, decimalToFiniteNumber(size, `${field}[${index}].size`, { allowZero: true, ceiling })]);
  }));
}

function liquidityPrints(prints, column, columnMs, field, ceiling) {
  if (!Array.isArray(prints) || prints.length > MAX_LIQUIDITY_PRINTS) {
    throw new Error(`${field}: must be an array of at most ${MAX_LIQUIDITY_PRINTS} prints`);
  }
  let previousTs = -1;
  return Object.freeze(prints.map((print, index) => {
    const at = `${field}[${index}]`;
    if (!print || typeof print !== "object") throw new Error(`${at}: must be a print`);
    if (!Number.isSafeInteger(print.ts) || print.ts < column.ts - PRINT_WINDOW_COLUMNS * columnMs || print.ts > column.ts + columnMs || print.ts < previousTs) {
      throw new Error(`${at}.ts: must be a non-decreasing epoch-ms integer at most ${PRINT_WINDOW_COLUMNS} column widths before the column ts and one after`);
    }
    previousTs = print.ts;
    if (print.side !== "buy" && print.side !== "sell") throw new Error(`${at}.side: must be buy or sell`);
    const id = print.id === null || print.id === undefined ? null : tradeIdToWireString(print.id, `${at}.id`);
    return Object.freeze({
      ts: print.ts,
      price: decimalToFiniteNumber(print.price, `${at}.price`),
      size: decimalToFiniteNumber(print.size, `${at}.size`, { ceiling }),
      side: print.side,
      id,
    });
  }));
}

function liquidityColumnFlow(column, span, columnMs, field, ceiling) {
  const out = {};
  if (column.buy !== undefined) out.buy = liquiditySideEntries(column.buy, span, `${field}.buy`, ceiling);
  if (column.sell !== undefined) out.sell = liquiditySideEntries(column.sell, span, `${field}.sell`, ceiling);
  if (column.prints !== undefined) out.prints = liquidityPrints(column.prints, column, columnMs, `${field}.prints`, ceiling);
  if (column.printsFloor !== undefined) out.prints_floor = decimalToFiniteNumber(column.printsFloor, `${field}.printsFloor`, { allowZero: true, ceiling: floorAbove(ceiling) });
  return out;
}

// Large resting levels (walls) the tracker reports alongside the columns:
// where each wall sat, when it appeared, and whether price ate it or it was
// withdrawn. Present only when the set changed (or on a reset).
// filled: most of what left it traded; partial: a meaningful share did;
// hit: price reached it and it left mostly by cancelling; pulled: withdrawn
// before price got there; moved: pulled or hit and re-placed moments later
// (the successor shares its chain id).
const LIQUIDITY_LEVEL_VERDICTS = new Set(["filled", "partial", "hit", "pulled", "moved"]);

function liquidityLevels(levels, ts, ceiling) {
  if (!Array.isArray(levels) || levels.length > MAX_LIQUIDITY_LEVELS) {
    throw new Error(`liquidityFrame.levels: must be an array of at most ${MAX_LIQUIDITY_LEVELS} levels`);
  }
  return Object.freeze(levels.map((level, index) => {
    const field = `liquidityFrame.levels[${index}]`;
    if (level.side !== "bid" && level.side !== "ask") throw new Error(`${field}.side: must be "bid" or "ask"`);
    if (!Number.isSafeInteger(level.row) || level.row < 0) throw new Error(`${field}.row: must be a non-negative integer`);
    if (!Number.isSafeInteger(level.span) || level.span < 1) throw new Error(`${field}.span: must be a positive integer`);
    if (!Number.isSafeInteger(level.startTs) || level.startTs < 0 || level.startTs > ts) {
      throw new Error(`${field}.startTs: must be an epoch-ms integer no later than the frame ts`);
    }
    const ended = level.endTs !== null && level.endTs !== undefined;
    if (ended && (!Number.isSafeInteger(level.endTs) || level.endTs < level.startTs || level.endTs > ts)) {
      throw new Error(`${field}.endTs: must be null or an epoch-ms integer between startTs and the frame ts`);
    }
    if (level.endedBy !== null && level.endedBy !== undefined && !LIQUIDITY_LEVEL_VERDICTS.has(level.endedBy)) {
      throw new Error(`${field}.endedBy: must be "filled", "partial", "hit", "pulled", "moved", or null`);
    }
    if (ended !== Boolean(level.endedBy)) throw new Error(`${field}.endedBy: set exactly when endTs is set`);
    const size = decimalToFiniteNumber(level.size, `${field}.size`, { allowZero: true, ceiling });
    const peak = decimalToFiniteNumber(level.peak, `${field}.peak`, { allowZero: true, ceiling });
    if (peak < size) throw new Error(`${field}.peak: must be no smaller than size`);
    const ratio = decimalToFiniteNumber(level.ratio ?? 0, `${field}.ratio`, { allowZero: true });
    const chain = level.chain ?? 0;
    if (!Number.isSafeInteger(chain) || chain < 0) throw new Error(`${field}.chain: must be a non-negative integer`);
    const fill = level.fill ?? 0;
    if (typeof fill !== "number" || !Number.isFinite(fill) || fill < 0 || fill > 1) throw new Error(`${field}.fill: must be a number from 0 to 1`);
    const eaten = level.eaten ?? 0;
    if (typeof eaten !== "number" || !Number.isFinite(eaten) || eaten < 0 || eaten > 1) throw new Error(`${field}.eaten: must be a number from 0 to 1`);
    const absorbing = level.absorbing ?? false;
    if (typeof absorbing !== "boolean") throw new Error(`${field}.absorbing: must be a boolean`);
    if (absorbing && ended) throw new Error(`${field}.absorbing: only a resting wall absorbs`);
    return Object.freeze({
      side: level.side,
      row: level.row,
      span: level.span,
      start_ts: level.startTs,
      end_ts: ended ? level.endTs : null,
      size,
      peak,
      ended_by: level.endedBy ?? null,
      ratio,
      chain,
      fill,
      eaten,
      absorbing,
    });
  }));
}

function aggressiveEvents(events, ts, ceiling) {
  if (!Array.isArray(events) || events.length > MAX_AGGRESSIVE_EVENTS) {
    throw new Error(`liquidityFrame.aggressive: must be an array of at most ${MAX_AGGRESSIVE_EVENTS} events`);
  }
  return Object.freeze(events.map((event, index) => {
    const field = `liquidityFrame.aggressive[${index}]`;
    if (event.side !== "buy" && event.side !== "sell") throw new Error(`${field}.side: must be "buy" or "sell"`);
    if (!Number.isSafeInteger(event.row) || event.row < 0) throw new Error(`${field}.row: must be a non-negative integer`);
    if (!Number.isSafeInteger(event.span) || event.span < 1) throw new Error(`${field}.span: must be a positive integer`);
    if (!Number.isSafeInteger(event.startTs) || event.startTs < 0 || event.startTs > ts) {
      throw new Error(`${field}.startTs: must be an epoch-ms integer no later than the frame ts`);
    }
    const ended = event.endTs !== null && event.endTs !== undefined;
    if (ended && (!Number.isSafeInteger(event.endTs) || event.endTs < event.startTs || event.endTs > ts)) {
      throw new Error(`${field}.endTs: must be null or an epoch-ms integer between startTs and the frame ts`);
    }
    const volume = decimalToFiniteNumber(event.volume, `${field}.volume`, { allowZero: true, ceiling });
    const peak = decimalToFiniteNumber(event.peak, `${field}.peak`, { allowZero: true, ceiling });
    if (peak > volume) throw new Error(`${field}.peak: must be no larger than volume`);
    const floor = decimalToFiniteNumber(event.floor, `${field}.floor`, { allowZero: true, ceiling });
    return Object.freeze({
      side: event.side,
      row: event.row,
      span: event.span,
      start_ts: event.startTs,
      end_ts: ended ? event.endTs : null,
      volume,
      peak,
      floor,
    });
  }));
}

const LIQUIDITY_BACKFILL_STATUSES = new Set(["RUNNING", "COMPLETE", "FAILED"]);

function liquidityBackfill(backfill) {
  if (!backfill || typeof backfill !== "object" || !LIQUIDITY_BACKFILL_STATUSES.has(backfill.status)) {
    throw new Error("liquidityFrame.backfill.status: must be RUNNING, COMPLETE, or FAILED");
  }
  if (backfill.reason !== null && typeof backfill.reason !== "string") {
    throw new Error("liquidityFrame.backfill.reason: must be a string or null");
  }
  return Object.freeze({ status: backfill.status, reason: backfill.reason });
}

/** The validated body of a liquidity frame, without its identity. */
function liquidityWireBody({ ts, seq, reset, rowWidth, columnMs, columns, levels, aggressive, backfill }, sizeCeiling = MAX_WIRE_MAGNITUDE) {
  if (!Number.isSafeInteger(ts) || ts < 0 || ts > MAX_VALID_EPOCH_MS) {
    throw new Error("liquidityFrame.ts: must be a non-negative epoch-ms integer");
  }
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new Error("liquidityFrame.seq: must be a non-negative integer");
  }
  if (typeof reset !== "boolean") {
    throw new Error("liquidityFrame.reset: must be a boolean");
  }
  if (!Number.isSafeInteger(columnMs) || columnMs <= 0) {
    throw new Error("liquidityFrame.columnMs: must be a positive integer");
  }
  if (!Array.isArray(columns) || columns.length > MAX_LIQUIDITY_COLUMNS || (!reset && columns.length === 0)) {
    throw new Error(`liquidityFrame.columns: must be an array of at most ${MAX_LIQUIDITY_COLUMNS} columns (empty only with reset)`);
  }
  if (seq < columns.length) {
    throw new Error("liquidityFrame.seq: must count at least this frame's columns");
  }
  let previousTs = -1;
  const wireColumns = columns.map((column, index) => {
    const field = `liquidityFrame.columns[${index}]`;
    if (!column || !Number.isSafeInteger(column.ts) || column.ts < 0 || column.ts > ts || column.ts <= previousTs) {
      throw new Error(`${field}.ts: must be an increasing epoch-ms integer no later than the frame ts`);
    }
    previousTs = column.ts;
    if (!Number.isSafeInteger(column.lo) || column.lo < 0 || !Number.isSafeInteger(column.hi) || column.hi < column.lo) {
      throw new Error(`${field}.lo/hi: must be non-negative integers with lo <= hi`);
    }
    const span = column.hi - column.lo + 1;
    if (span > MAX_LIQUIDITY_ROWS) {
      throw new Error(`${field}: window spans more than ${MAX_LIQUIDITY_ROWS} rows`);
    }
    return Object.freeze({
      ts: column.ts,
      lo: column.lo,
      hi: column.hi,
      bid: liquiditySideEntries(column.bid, span, `${field}.bid`, sizeCeiling),
      ask: liquiditySideEntries(column.ask, span, `${field}.ask`, sizeCeiling),
      ...liquidityColumnFlow(column, span, columnMs, field, sizeCeiling),
    });
  });
  return {
    ts,
    seq,
    reset,
    row_width: decimalToFiniteNumber(rowWidth, "liquidityFrame.rowWidth"),
    column_ms: columnMs,
    columns: Object.freeze(wireColumns),
    ...(levels === undefined ? {} : { levels: liquidityLevels(levels, ts, sizeCeiling) }),
    ...(aggressive === undefined ? {} : { aggressive: aggressiveEvents(aggressive, ts, sizeCeiling) }),
    ...(backfill === undefined ? {} : { backfill: liquidityBackfill(backfill) }),
  };
}

/** The L2 Passive Liquidity heatmap frame for a Binance pair. */
function liquidityFrame(symbol, marketKind, body) {
  assertMarketKind(marketKind, "liquidityFrame.marketKind");
  return Object.freeze({
    type: "liquidity",
    provider: "BINANCE",
    symbol: toWireSymbol(symbol),
    marketKind,
    ...liquidityWireBody(body),
  });
}

/** The same frame for a dxFeed instrument: identity by asset class, body unchanged; sizes are contracts or shares. */
function dxfeedLiquidityFrame(symbol, assetClass, body) {
  assertAssetClass(assetClass, "dxfeedLiquidityFrame.assetClass");
  return Object.freeze({
    type: "liquidity",
    provider: "DXFEED",
    symbol: dxfeedToWireSymbol(symbol, assetClass),
    assetClass,
    ...liquidityWireBody(body, sizeCeilingForAssetClass(assetClass)),
  });
}

function assertVpinStatus(vpinStatus, field) {
  if (!VPIN_STATUSES.has(vpinStatus)) throw new Error(`${field}: vpin status is invalid`);
}

function aggressivePoolFields(pool, matches, field, ceiling = MAX_WIRE_MAGNITUDE) {
  if (pool === undefined) return {};
  if (!pool || !Array.isArray(pool.prints) || pool.prints.length > MAX_AGGRESSIVE_POOL_PRINTS) {
    throw new Error(`${field}.aggressivePrints: must be an array of at most ${MAX_AGGRESSIVE_POOL_PRINTS} trade frames`);
  }
  const ids = new Set();
  let previousTs = -1;
  for (const print of pool.prints) {
    if (!print || print.type !== "trade" || !matches(print) || ids.has(print.trade_id) || print.ts_exchange < previousTs) {
      throw new Error(`${field}.aggressivePrints: must be pair-matched, unique trade frames in time order`);
    }
    ids.add(print.trade_id);
    previousTs = print.ts_exchange;
  }
  if (!Number.isFinite(pool.floor) || pool.floor < 0 || pool.floor > floorAbove(ceiling)) {
    throw new Error(`${field}.aggressivePrints.floor: must be a non-negative finite number no greater than the size ceiling (value ${pool.floor}, ceiling ${ceiling})`);
  }
  if (!Number.isSafeInteger(pool.from) || pool.from < 0 || pool.from > MAX_VALID_EPOCH_MS) throw new Error(`${field}.aggressivePrints.from: must be a non-negative epoch-ms integer`);
  return { aggressive_prints: Object.freeze([...pool.prints]), aggressive_prints_floor: pool.floor, aggressive_prints_from: pool.from };
}

function snapshotFrame(bars, trades, symbol, marketKind, markers = [], vpinReadings = undefined, vpinStatus = undefined, aggressivePrints = undefined) {
  assertMarketKind(marketKind, "snapshotFrame.marketKind");
  assertSnapshotCollections(bars, trades, markers, "snapshotFrame");
  if (vpinStatus !== undefined) assertVpinStatus(vpinStatus, "snapshotFrame");
  const wireSymbol = toWireSymbol(symbol);
  let previousOpenTime = -1;
  for (const bar of bars) {
    if (
      bar.closed !== true ||
      bar.symbol !== wireSymbol ||
      bar.provider !== "BINANCE" ||
      bar.marketKind !== marketKind ||
      bar.ts_open <= previousOpenTime
    ) {
      throw new Error("snapshotFrame: every bar must already be closed, pair-matched, and strictly chronological");
    }
    previousOpenTime = bar.ts_open;
  }
  const tradeIds = new Set();
  for (const trade of trades) {
    if (
      trade.symbol !== wireSymbol ||
      trade.provider !== "BINANCE" ||
      trade.marketKind !== marketKind ||
      tradeIds.has(trade.trade_id)
    ) {
      throw new Error("snapshotFrame: trades must be pair-matched and unique");
    }
    tradeIds.add(trade.trade_id);
  }
  const markerTradeIds = new Set();
  for (const marker of markers) {
    if (
      marker.symbol !== wireSymbol ||
      marker.provider !== "BINANCE" ||
      marker.marketKind !== marketKind ||
      markerTradeIds.has(marker.trade_id)
    ) {
      throw new Error("snapshotFrame: markers must be pair-matched and unique");
    }
    markerTradeIds.add(marker.trade_id);
  }
  return Object.freeze({
    type: "snapshot",
    provider: "BINANCE",
    symbol: wireSymbol,
    marketKind,
    bars: Object.freeze([...bars]),
    trades: Object.freeze([...trades]),
    markers: Object.freeze([...markers]),
    ...(vpinReadings !== undefined ? { vpin_readings: vpinReadingsToWire(vpinReadings, "snapshotFrame.vpinReadings") } : {}),
    ...(vpinStatus !== undefined && vpinStatus !== "IDLE" ? { vpin_status: vpinStatus } : {}),
    ...aggressivePoolFields(aggressivePrints, (print) => print.symbol === wireSymbol && print.provider === "BINANCE" && print.marketKind === marketKind, "snapshotFrame"),
  });
}

function healthFrame(symbol, marketKind, { stale, recoveryState, recordingStale, recordingLatestTs }, reason) {
  assertMarketKind(marketKind, "healthFrame.marketKind");
  if (recoveryState !== "READY" && recoveryState !== "RECOVERING" && recoveryState !== "UNAVAILABLE") {
    throw new Error("healthFrame: recoveryState is invalid");
  }
  if (typeof stale !== "boolean" || (recoveryState !== "READY" && stale !== true)) {
    throw new Error("healthFrame: stale is inconsistent with recoveryState");
  }
  if (reason !== undefined && (typeof reason !== "string" || reason.length === 0 || reason.trim() !== reason || reason.length > MAX_REASON_LENGTH)) {
    throw new Error("healthFrame: reason is outside the supported wire range");
  }
  if (recordingStale !== undefined && typeof recordingStale !== "boolean") {
    throw new Error("healthFrame: recordingStale must be a boolean when present");
  }
  if (recordingLatestTs !== undefined && (!Number.isSafeInteger(recordingLatestTs) || recordingLatestTs < 0)) {
    throw new Error("healthFrame: recordingLatestTs must be a non-negative safe integer when present");
  }
  if (recordingLatestTs !== undefined && recordingStale === undefined) {
    throw new Error("healthFrame: recordingLatestTs needs recordingStale beside it");
  }
  return Object.freeze({
    type: "health",
    provider: "BINANCE",
    symbol: toWireSymbol(symbol),
    marketKind,
    recoveryState,
    stale,
    ...(reason !== undefined ? { reason } : {}),
    ...(recordingStale !== undefined ? { recordingStale } : {}),
    ...(recordingLatestTs !== undefined ? { recordingLatestTs } : {}),
  });
}

function toBookLevels(tuples, levels, ceiling = MAX_WIRE_MAGNITUDE) {
  if (!Number.isInteger(levels) || levels < 0 || levels > BOOK_DEPTH_LEVELS) {
    throw new Error(`toBookLevels: levels must be a non-negative integer no greater than ${BOOK_DEPTH_LEVELS}, got ${levels}`);
  }
  return Object.freeze(
    tuples.slice(0, levels).map(([price, quantity]) => Object.freeze({
      price: decimalToFiniteNumber(price, "toBookLevels.price"),
      size: decimalToFiniteNumber(quantity, "toBookLevels.quantity", { ceiling }),
    })),
  );
}

const CROSSED_BOOK_REASON = "CROSSED_BOOK";
const WIRE_RANGE_REASON = "WIRE_VALUE_OUT_OF_RANGE";

function crossedBookError(message) {
  const error = new Error(message);
  error.code = CROSSED_BOOK_REASON;
  return error;
}

function bookFailureReason(error) {
  return error?.code === CROSSED_BOOK_REASON ? CROSSED_BOOK_REASON : WIRE_RANGE_REASON;
}

function bookFrame(symbol, marketKind, orderBookState, levels = BOOK_DEPTH_LEVELS, { stale = false } = {}) {
  assertMarketKind(marketKind, "bookFrame.marketKind");
  if (orderBookState.status === "READY") {
    if (!Number.isSafeInteger(orderBookState.book.lastUpdateId) || orderBookState.book.lastUpdateId < 0) {
      throw new Error("bookFrame: lastUpdateId must be a non-negative safe integer");
    }
    if (typeof stale !== "boolean") {
      throw new Error("bookFrame: stale must be boolean");
    }
    const bids = toBookLevels(orderBookState.book.bids, levels);
    const asks = toBookLevels(orderBookState.book.asks, levels);
    if (
      bids.some((level, index) => index > 0 && level.price >= bids[index - 1].price) ||
      asks.some((level, index) => index > 0 && level.price <= asks[index - 1].price) ||
      (bids.length > 0 && asks.length > 0 && bids[0].price >= asks[0].price)
    ) {
      throw crossedBookError("bookFrame: book levels are not strictly ordered or the book is crossed");
    }
    return Object.freeze({
      type: "book",
      provider: "BINANCE",
      symbol: toWireSymbol(symbol),
      marketKind,
      status: "READY",
      bids,
      asks,
      lastUpdateId: orderBookState.book.lastUpdateId,
      stale,
    });
  }
  if (
    orderBookState.status !== "UNAVAILABLE" ||
    typeof orderBookState.reason !== "string" ||
    orderBookState.reason.length === 0 ||
    orderBookState.reason.trim() !== orderBookState.reason ||
    orderBookState.reason.length > MAX_REASON_LENGTH
  ) {
    throw new Error(`bookFrame: expected READY or UNAVAILABLE with a reason, got status="${orderBookState.status}" reason="${orderBookState.reason}"`);
  }
  return Object.freeze({
    type: "book",
    provider: "BINANCE",
    symbol: toWireSymbol(symbol),
    marketKind,
    status: "UNAVAILABLE",
    reason: orderBookState.reason,
  });
}

function selectionFrame(symbol, marketKind) {
  assertMarketKind(marketKind, "selectionFrame.marketKind");
  return Object.freeze({
    type: "selection",
    provider: "BINANCE",
    symbol: toWireSymbol(symbol),
    marketKind,
  });
}

function profileFrame(engineState, symbol, marketKind) {
  assertMarketKind(marketKind, "profileFrame.marketKind");
  const wireFields = buildProfileWireFields(engineState, "profileFrame");
  return Object.freeze({
    type: "profile",
    provider: "BINANCE",
    symbol: toWireSymbol(symbol),
    marketKind,
    ...wireFields,
  });
}

function dxfeedProfileFrame({ engineState, symbol, assetClass }) {
  assertAssetClass(assetClass, "dxfeedProfileFrame.assetClass");
  const wireFields = buildProfileWireFields(engineState, "dxfeedProfileFrame");
  return Object.freeze({
    type: "profile",
    provider: "DXFEED",
    symbol: dxfeedToWireSymbol(symbol, assetClass),
    assetClass,
    ...wireFields,
  });
}

function vpinFrame(reading, symbol, marketKind) {
  assertMarketKind(marketKind, "vpinFrame.marketKind");
  const wireFields = buildVpinWireFields(reading, "vpinFrame");
  return Object.freeze({
    type: "vpin",
    provider: "BINANCE",
    symbol: toWireSymbol(symbol),
    marketKind,
    ...wireFields,
  });
}

function dxfeedVpinFrame({ reading, symbol, assetClass }) {
  assertAssetClass(assetClass, "dxfeedVpinFrame.assetClass");
  const wireFields = buildVpinWireFields(reading, "dxfeedVpinFrame");
  return Object.freeze({
    type: "vpin",
    provider: "DXFEED",
    symbol: dxfeedToWireSymbol(symbol, assetClass),
    assetClass,
    ...wireFields,
  });
}

function dxfeedTradeFrame({ symbol, assetClass, tsExchange, price, size, side, tradeId, auction = false }) {
  assertAssetClass(assetClass, "dxfeedTradeFrame.assetClass");
  assertSide(side, "dxfeedTradeFrame.side");
  if (typeof auction !== "boolean") throw new Error("dxfeedTradeFrame.auction must be a boolean");
  return Object.freeze({
    type: "trade",
    provider: "DXFEED",
    symbol: dxfeedToWireSymbol(symbol, assetClass),
    assetClass,
    ts_exchange: timestampToWireNumber(tsExchange, "dxfeedTradeFrame.tsExchange"),
    price: decimalToFiniteNumber(price, "dxfeedTradeFrame.price"),
    size: decimalToFiniteNumber(size, "dxfeedTradeFrame.size", { ceiling: assetClass === "EQUITY" ? MAX_EQUITY_TRADE_SIZE : MAX_WIRE_MAGNITUDE }),
    side,
    trade_id: tradeIdToWireString(tradeId, "dxfeedTradeFrame.tradeId"),
    ...(auction ? { auction: true } : {}),
  });
}

function dxfeedMarkerFrame({ symbol, assetClass, tsExchange, price, size, side, tradeId }) {
  assertAssetClass(assetClass, "dxfeedMarkerFrame.assetClass");
  assertSide(side, "dxfeedMarkerFrame.side");
  return Object.freeze({
    type: "marker",
    provider: "DXFEED",
    symbol: dxfeedToWireSymbol(symbol, assetClass),
    assetClass,
    ts_exchange: timestampToWireNumber(tsExchange, "dxfeedMarkerFrame.tsExchange"),
    price: decimalToFiniteNumber(price, "dxfeedMarkerFrame.price"),
    size: decimalToFiniteNumber(size, "dxfeedMarkerFrame.size", { ceiling: assetClass === "EQUITY" ? MAX_EQUITY_TRADE_SIZE : MAX_WIRE_MAGNITUDE }),
    side,
    trade_id: tradeIdToWireString(tradeId, "dxfeedMarkerFrame.tradeId"),
  });
}

function wholeVolume(side, volume) {
  return side !== undefined && Math.abs(side - volume) <= 1e-9 * Math.max(1, volume);
}

function completedSides(volume, buy, sell) {
  if (buy === undefined && sell !== undefined) {
    return wholeVolume(sell, volume) ? { buy: 0, sell } : { buy: undefined, sell: undefined };
  }
  if (sell === undefined && wholeVolume(buy, volume)) return { buy, sell: 0 };
  return { buy, sell };
}

function dxfeedBarFrame({ symbol, assetClass, tsOpen, open, high, low, close, volume, buyVolume, sellVolume, tradeCount, closed }) {
  assertAssetClass(assetClass, "dxfeedBarFrame.assetClass");
  const wireOpen = decimalToFiniteNumber(open, "dxfeedBarFrame.open");
  const wireHigh = decimalToFiniteNumber(high, "dxfeedBarFrame.high");
  const wireLow = decimalToFiniteNumber(low, "dxfeedBarFrame.low");
  const wireClose = decimalToFiniteNumber(close, "dxfeedBarFrame.close");
  const wireVolume = decimalToFiniteNumber(volume, "dxfeedBarFrame.volume", { allowZero: true, ceiling: MAX_BAR_VOLUME });
  const sides = completedSides(
    wireVolume,
    buyVolume === null || buyVolume === undefined
      ? undefined
      : decimalToFiniteNumber(buyVolume, "dxfeedBarFrame.buyVolume", { allowZero: true, ceiling: MAX_BAR_VOLUME }),
    sellVolume === null || sellVolume === undefined
      ? undefined
      : decimalToFiniteNumber(sellVolume, "dxfeedBarFrame.sellVolume", { allowZero: true, ceiling: MAX_BAR_VOLUME }),
  );
  const wireBuyVolume = sides.buy;
  const wireSellVolume = sides.sell;
  assertBarShape({
    intervalMs: DXFEED_CANDLE_INTERVAL_MS,
    tsOpen,
    open: wireOpen,
    high: wireHigh,
    low: wireLow,
    close: wireClose,
    volume: wireVolume,
    buyVolume: wireBuyVolume,
    tradeCount,
    closed,
  }, "dxfeedBarFrame");
  if (wireSellVolume !== undefined && wireSellVolume > wireVolume) throw new Error("dxfeedBarFrame: sell volume cannot exceed total volume");
  if (wireBuyVolume !== undefined && wireSellVolume !== undefined && wireBuyVolume + wireSellVolume > wireVolume + 1e-9) {
    throw new Error("dxfeedBarFrame: directional volume cannot exceed total volume");
  }
  return Object.freeze({
    type: "bar",
    provider: "DXFEED",
    symbol: dxfeedToWireSymbol(symbol, assetClass),
    assetClass,
    interval_ms: DXFEED_CANDLE_INTERVAL_MS,
    ts_open: tsOpen,
    open: wireOpen,
    high: wireHigh,
    low: wireLow,
    close: wireClose,
    volume: wireVolume,
    trade_count: tradeCount,
    closed,
    ...(wireBuyVolume !== undefined ? { buy_volume: wireBuyVolume } : {}),
    ...(wireSellVolume !== undefined ? { sell_volume: wireSellVolume } : {}),
  });
}

function storageDxFeedCandleRowToBarFrame(row, symbol, assetClass) {
  return dxfeedBarFrame({
    symbol,
    assetClass,
    tsOpen: row.ts_open,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    buyVolume: row.buy_volume,
    sellVolume: row.sell_volume,
    tradeCount: row.trade_count,
    closed: true,
  });
}

function dxfeedHealthFrame(symbol, assetClass, { stale, recoveryState, printsQuiet }, reason) {
  assertAssetClass(assetClass, "dxfeedHealthFrame.assetClass");
  if (recoveryState !== "READY" && recoveryState !== "RECOVERING" && recoveryState !== "UNAVAILABLE") {
    throw new Error("dxfeedHealthFrame: recoveryState is invalid");
  }
  if (typeof stale !== "boolean" || (recoveryState !== "READY" && stale !== true)) {
    throw new Error("dxfeedHealthFrame: stale is inconsistent with recoveryState");
  }
  if (printsQuiet !== undefined && typeof printsQuiet !== "boolean") {
    throw new Error("dxfeedHealthFrame: printsQuiet must be a boolean when provided");
  }
  if (reason !== undefined && (typeof reason !== "string" || reason.length === 0 || reason.trim() !== reason || reason.length > MAX_REASON_LENGTH)) {
    throw new Error("dxfeedHealthFrame: reason is outside the supported wire range");
  }
  return Object.freeze({
    type: "health",
    provider: "DXFEED",
    symbol: dxfeedToWireSymbol(symbol, assetClass),
    assetClass,
    recoveryState,
    stale,
    ...(printsQuiet !== undefined ? { printsQuiet } : {}),
    ...(reason !== undefined ? { reason } : {}),
  });
}

function dxfeedBookFrame(symbol, assetClass, orderBookState, levels = BOOK_DEPTH_LEVELS, { stale = false } = {}) {
  assertAssetClass(assetClass, "dxfeedBookFrame.assetClass");
  if (orderBookState.status === "READY") {
    if (!Number.isSafeInteger(orderBookState.book.lastUpdateId) || orderBookState.book.lastUpdateId < 0) {
      throw new Error("dxfeedBookFrame: lastUpdateId must be a non-negative safe integer");
    }
    if (typeof stale !== "boolean") {
      throw new Error("dxfeedBookFrame: stale must be boolean");
    }
    const bids = toBookLevels(orderBookState.book.bids, levels, sizeCeilingForAssetClass(assetClass));
    const asks = toBookLevels(orderBookState.book.asks, levels, sizeCeilingForAssetClass(assetClass));
    if (
      bids.some((level, index) => index > 0 && level.price >= bids[index - 1].price) ||
      asks.some((level, index) => index > 0 && level.price <= asks[index - 1].price) ||
      (bids.length > 0 && asks.length > 0 && bids[0].price >= asks[0].price)
    ) {
      throw crossedBookError("dxfeedBookFrame: book levels are not strictly ordered or the book is crossed");
    }
    return Object.freeze({
      type: "book",
      provider: "DXFEED",
      symbol: dxfeedToWireSymbol(symbol, assetClass),
      assetClass,
      status: "READY",
      bids,
      asks,
      lastUpdateId: orderBookState.book.lastUpdateId,
      stale,
    });
  }
  if (
    orderBookState.status !== "UNAVAILABLE" ||
    typeof orderBookState.reason !== "string" ||
    orderBookState.reason.length === 0 ||
    orderBookState.reason.trim() !== orderBookState.reason ||
    orderBookState.reason.length > MAX_REASON_LENGTH
  ) {
    throw new Error(`dxfeedBookFrame: expected READY or UNAVAILABLE with a reason, got status="${orderBookState.status}" reason="${orderBookState.reason}"`);
  }
  return Object.freeze({
    type: "book",
    provider: "DXFEED",
    symbol: dxfeedToWireSymbol(symbol, assetClass),
    assetClass,
    status: "UNAVAILABLE",
    reason: orderBookState.reason,
  });
}

function dxfeedSelectionFrame(symbol, assetClass) {
  assertAssetClass(assetClass, "dxfeedSelectionFrame.assetClass");
  return Object.freeze({
    type: "selection",
    provider: "DXFEED",
    symbol: dxfeedToWireSymbol(symbol, assetClass),
    assetClass,
  });
}

function dxfeedSnapshotFrame(bars, trades, symbol, assetClass, markers = [], barHistory, vpinReadings = undefined, vpinStatus = undefined, aggressivePrints = undefined) {
  assertAssetClass(assetClass, "dxfeedSnapshotFrame.assetClass");
  assertSnapshotCollections(bars, trades, markers, "dxfeedSnapshotFrame");
  if (vpinStatus !== undefined) assertVpinStatus(vpinStatus, "dxfeedSnapshotFrame");
  const wireSymbol = dxfeedToWireSymbol(symbol, assetClass);
  if (barHistory !== undefined) {
    const validAvailability = barHistory?.availability === "AVAILABLE" || barHistory?.availability === "UNAVAILABLE";
    const validCoverage = barHistory?.coverage === "START_COVERED" || barHistory?.coverage === "START_NOT_COVERED" || barHistory?.coverage === "NO_ROWS";
    const hasEarliest = barHistory?.earliestObservedTsOpen !== undefined;
    const validEarliest = !hasEarliest || (
      Number.isSafeInteger(barHistory.earliestObservedTsOpen) &&
      barHistory.earliestObservedTsOpen >= barHistory.requestedStartTsOpen
    );
    const consistentEmptyState = barHistory?.coverage === "NO_ROWS" ? !hasEarliest : hasEarliest;
    const consistentAvailability = barHistory?.availability !== "UNAVAILABLE" || barHistory?.coverage === "NO_ROWS";
    if (
      !barHistory ||
      !validAvailability ||
      !validCoverage ||
      !Number.isSafeInteger(barHistory.requestedStartTsOpen) ||
      barHistory.requestedStartTsOpen < 0 ||
      !validEarliest ||
      !consistentEmptyState ||
      !consistentAvailability
    ) {
      throw new Error("dxfeedSnapshotFrame: barHistory is invalid");
    }
  }
  let previousOpenTime = -1;
  for (const bar of bars) {
    if (
      bar.closed !== true ||
      bar.symbol !== wireSymbol ||
      bar.provider !== "DXFEED" ||
      bar.assetClass !== assetClass ||
      bar.ts_open <= previousOpenTime
    ) {
      throw new Error("dxfeedSnapshotFrame: every bar must already be closed, pair-matched, and strictly chronological");
    }
    previousOpenTime = bar.ts_open;
  }
  const tradeIds = new Set();
  for (const trade of trades) {
    if (
      trade.symbol !== wireSymbol ||
      trade.provider !== "DXFEED" ||
      trade.assetClass !== assetClass ||
      tradeIds.has(trade.trade_id)
    ) {
      throw new Error("dxfeedSnapshotFrame: trades must be pair-matched and unique");
    }
    tradeIds.add(trade.trade_id);
  }
  const markerTradeIds = new Set();
  for (const marker of markers) {
    if (
      marker.symbol !== wireSymbol ||
      marker.provider !== "DXFEED" ||
      marker.assetClass !== assetClass ||
      markerTradeIds.has(marker.trade_id)
    ) {
      throw new Error("dxfeedSnapshotFrame: markers must be pair-matched and unique");
    }
    markerTradeIds.add(marker.trade_id);
  }
  return Object.freeze({
    type: "snapshot",
    provider: "DXFEED",
    symbol: wireSymbol,
    assetClass,
    bars: Object.freeze([...bars]),
    trades: Object.freeze([...trades]),
    markers: Object.freeze([...markers]),
    ...(barHistory !== undefined ? { bar_history: Object.freeze({ ...barHistory, interpretation: "OBSERVED_NONEMPTY_BARS_ONLY" }) } : {}),
    ...(vpinReadings !== undefined ? { vpin_readings: vpinReadingsToWire(vpinReadings, "dxfeedSnapshotFrame.vpinReadings") } : {}),
    ...(vpinStatus !== undefined && vpinStatus !== "IDLE" ? { vpin_status: vpinStatus } : {}),
    ...aggressivePoolFields(aggressivePrints, (print) => print.symbol === wireSymbol && print.provider === "DXFEED" && print.assetClass === assetClass, "dxfeedSnapshotFrame", sizeCeilingForAssetClass(assetClass)),
  });
}

function assertSnapshotCollections(bars, trades, markers, field) {
  if (!Array.isArray(bars) || bars.length > MAX_SNAPSHOT_BARS) {
    throw new Error(`${field}: bars must be an array with at most ${MAX_SNAPSHOT_BARS} entries`);
  }
  if (!Array.isArray(trades) || trades.length > MAX_SNAPSHOT_TRADES) {
    throw new Error(`${field}: trades must be an array with at most ${MAX_SNAPSHOT_TRADES} entries`);
  }
  if (!Array.isArray(markers) || markers.length > MAX_SNAPSHOT_MARKERS) {
    throw new Error(`${field}: markers must be an array with at most ${MAX_SNAPSHOT_MARKERS} entries`);
  }
}

const MAX_AGGRESSIVE_HISTORY_TRADES = 10_000;
const AGGRESSIVE_HISTORY_REASONS = Object.freeze(["CAP_REACHED", "STORAGE_UNAVAILABLE", "READ_FAILED", "CONVERSION_INCOMPLETE", "OVERLOADED"]);

function aggressiveHistoryFrame(identity, { requestId, fromTs, toTs, minSize, complete, reason = null, nextCursor = null, retryAfterMs = null, trades }) {
  if (!["BINANCE", "DXFEED"].includes(identity?.provider)) throw new Error("aggressiveHistoryFrame: invalid provider");
  if (!Number.isSafeInteger(requestId) || requestId < 0) throw new Error("aggressiveHistoryFrame: requestId must be a non-negative safe integer");
  if (!Number.isSafeInteger(fromTs) || fromTs < 0) throw new Error("aggressiveHistoryFrame: fromTs must be a non-negative safe integer");
  if (!Number.isSafeInteger(toTs) || toTs <= fromTs) throw new Error("aggressiveHistoryFrame: toTs must be a safe integer after fromTs");
  if (typeof minSize !== "number" || !Number.isFinite(minSize) || minSize < 0) throw new Error("aggressiveHistoryFrame: minSize must be a non-negative finite number");
  if (typeof complete !== "boolean") throw new Error("aggressiveHistoryFrame: complete must be a boolean");
  if (complete ? reason !== null : !AGGRESSIVE_HISTORY_REASONS.includes(reason)) {
    throw new Error(`aggressiveHistoryFrame: reason must be null when complete, else one of ${AGGRESSIVE_HISTORY_REASONS.join(", ")}`);
  }
  if (reason === "CAP_REACHED") {
    if (typeof nextCursor !== "string" || nextCursor.length === 0 || nextCursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(nextCursor)) {
      throw new Error("aggressiveHistoryFrame: CAP_REACHED requires a bounded base64url nextCursor");
    }
  } else if (nextCursor !== null) {
    throw new Error("aggressiveHistoryFrame: nextCursor is only valid when CAP_REACHED");
  }
  if (reason === "OVERLOADED") {
    if (retryAfterMs !== null && (!Number.isSafeInteger(retryAfterMs) || retryAfterMs <= 0 || retryAfterMs > 24 * 60 * 60 * 1000)) {
      throw new Error("aggressiveHistoryFrame: retryAfterMs must be a positive safe integer no greater than one day or null");
    }
  } else if (retryAfterMs !== null) {
    throw new Error("aggressiveHistoryFrame: retryAfterMs is only valid when OVERLOADED");
  }
  if (!Array.isArray(trades) || trades.length > MAX_AGGRESSIVE_HISTORY_TRADES) {
    throw new Error(`aggressiveHistoryFrame: trades must be an array of at most ${MAX_AGGRESSIVE_HISTORY_TRADES} trade frames`);
  }
  const selection = identity.provider === "BINANCE"
    ? selectionFrame(identity.symbol, identity.marketKind)
    : dxfeedSelectionFrame(identity.symbol, identity.assetClass);
  let previousTs = -1;
  for (const [index, trade] of trades.entries()) {
    if (trade?.type !== "trade" || trade.provider !== identity.provider || trade.symbol !== selection.symbol) {
      throw new Error(`aggressiveHistoryFrame.trades[${index}]: must be a trade frame of the same instrument`);
    }
    if (trade.ts_exchange < previousTs) throw new Error(`aggressiveHistoryFrame.trades[${index}]: trades must be oldest first`);
    previousTs = trade.ts_exchange;
  }
  return Object.freeze({
    ...selection,
    type: "aggressive_history",
    request_id: requestId,
    from_ts: fromTs,
    to_ts: toTs,
    min_size: minSize,
    complete,
    reason,
    next_cursor: nextCursor,
    retry_after_ms: retryAfterMs,
    trades: Object.freeze([...trades]),
  });
}

function analyticsStatusFrame(identity, indicator, status) {
  if (!["PROFILE", "VPIN"].includes(indicator) || !["READY", "UNAVAILABLE", "WARMING", "EMPTY", "CLOSED"].includes(status)) {
    throw new Error("analyticsStatusFrame: invalid indicator or status");
  }
  if (!["BINANCE", "DXFEED"].includes(identity?.provider)) throw new Error("analyticsStatusFrame: invalid provider");
  const selection = identity.provider === "BINANCE"
    ? selectionFrame(identity.symbol, identity.marketKind)
    : dxfeedSelectionFrame(identity.symbol, identity.assetClass);
  return Object.freeze({ ...selection, type: "analytics_status", indicator, status });
}

function markerHistoryRow(marker, selection, index) {
  const field = `markerHistoryFrame.markers[${index}]`;
  const sameIdentity = marker?.provider === selection.provider && marker?.symbol === selection.symbol &&
    (selection.provider === "BINANCE"
      ? marker.marketKind === selection.marketKind
      : marker.assetClass === selection.assetClass);
  if (marker?.type !== "marker" || !sameIdentity) {
    throw new Error(`${field}: must be a marker frame of the same instrument`);
  }
  return Object.freeze([marker.ts_exchange, marker.price, marker.size, marker.side === "buy" ? "b" : "s", marker.trade_id]);
}

function markerHistoryFrame(identity, { reset, seq, markers }) {
  if (!["BINANCE", "DXFEED"].includes(identity?.provider)) throw new Error("markerHistoryFrame: invalid provider");
  if (typeof reset !== "boolean") throw new Error("markerHistoryFrame: reset must be a boolean");
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error("markerHistoryFrame: seq must be a non-negative safe integer");
  if (!Array.isArray(markers) || markers.length > MAX_MARKER_HISTORY_ROWS) {
    throw new Error(`markerHistoryFrame: markers must be an array of at most ${MAX_MARKER_HISTORY_ROWS} marker frames`);
  }
  const selection = identity.provider === "BINANCE"
    ? selectionFrame(identity.symbol, identity.marketKind)
    : dxfeedSelectionFrame(identity.symbol, identity.assetClass);
  const ids = new Set();
  let previousTs = -1;
  const rows = markers.map((marker, index) => {
    const row = markerHistoryRow(marker, selection, index);
    if (ids.has(marker.trade_id) || marker.ts_exchange < previousTs) {
      throw new Error(`markerHistoryFrame.markers[${index}]: markers must be unique and oldest first`);
    }
    ids.add(marker.trade_id);
    previousTs = marker.ts_exchange;
    return row;
  });
  return Object.freeze({ ...selection, type: "marker_history", reset, seq, rows: Object.freeze(rows) });
}

function markerHistoryFrames(identity, markers, { chunkRows = MAX_MARKER_HISTORY_ROWS } = {}) {
  if (!Number.isSafeInteger(chunkRows) || chunkRows <= 0 || chunkRows > MAX_MARKER_HISTORY_ROWS) {
    throw new Error(`markerHistoryFrames: chunkRows must be an integer from 1 to ${MAX_MARKER_HISTORY_ROWS}`);
  }
  const frames = [];
  for (let start = 0; start < markers.length; start += chunkRows) {
    frames.push(markerHistoryFrame(identity, { reset: start === 0, seq: frames.length, markers: markers.slice(start, start + chunkRows) }));
  }
  return frames;
}

const FRAME_KIND_CONTROL = "control";
const FRAME_KIND_LATEST_STATE = "latest-state";
const FRAME_KIND_INCREMENTAL = "incremental";
const FRAME_KIND_BULK_HISTORY = "bulk-history";
const FRAME_KIND_BY_TYPE = Object.freeze({
  selection: FRAME_KIND_CONTROL,
  health: FRAME_KIND_CONTROL,
  analytics_status: FRAME_KIND_CONTROL,
  book: FRAME_KIND_LATEST_STATE,
  bar: FRAME_KIND_LATEST_STATE,
  vpin: FRAME_KIND_LATEST_STATE,
  snapshot: FRAME_KIND_LATEST_STATE,
  trade: FRAME_KIND_INCREMENTAL,
  marker: FRAME_KIND_INCREMENTAL,
  liquidity: FRAME_KIND_INCREMENTAL,
  l2_view: FRAME_KIND_INCREMENTAL,
  l2_walls: FRAME_KIND_INCREMENTAL,
  l2_events: FRAME_KIND_INCREMENTAL,
  l2_ladder: FRAME_KIND_LATEST_STATE,
  iceberg_orders: FRAME_KIND_INCREMENTAL,
  exhaustion_shades: FRAME_KIND_INCREMENTAL,
  initiative_bands: FRAME_KIND_INCREMENTAL,
  candle_monitor: FRAME_KIND_LATEST_STATE,
  aggressive_history: FRAME_KIND_BULK_HISTORY,
  band_history: FRAME_KIND_BULK_HISTORY,
  delta_profile: FRAME_KIND_BULK_HISTORY,
  marker_history: FRAME_KIND_BULK_HISTORY,
});

function frameKindOf(frame) {
  if (frame?.type === "profile") {
    return frame.delivery_scope === "LIVE" ? FRAME_KIND_LATEST_STATE : FRAME_KIND_BULK_HISTORY;
  }
  return FRAME_KIND_BY_TYPE[frame?.type] ?? FRAME_KIND_INCREMENTAL;
}

const MAX_BAND_HISTORY_COLUMNS = 7_200;
const MAX_BAND_HISTORY_ROWS = 256;
const BAND_HISTORY_REASONS = Object.freeze(["STORAGE_UNAVAILABLE", "READ_FAILED", "READ_TIMEOUT", "OVERLOADED", "GEOMETRY_UNAVAILABLE", "BAND_TOO_WIDE", "BAD_REQUEST"]);
const BAND_HISTORY_ROWLESS_REASONS = new Set(["GEOMETRY_UNAVAILABLE", "BAND_TOO_WIDE", "BAD_REQUEST"]);

function bandHistoryFrame(identity, { requestId, fromTs, toTs, priceLo, priceHi, columnMs, rowWidth, rowLo, rowHi, complete, reason = null, retryAfterMs = null, columns }) {
  if (!["BINANCE", "DXFEED"].includes(identity?.provider)) throw new Error("bandHistoryFrame: invalid provider");
  if (!Number.isSafeInteger(requestId) || requestId < 0) throw new Error("bandHistoryFrame: requestId must be a non-negative safe integer");
  if (!Number.isSafeInteger(fromTs) || fromTs < 0) throw new Error("bandHistoryFrame: fromTs must be a non-negative safe integer");
  if (!Number.isSafeInteger(toTs) || toTs <= fromTs) throw new Error("bandHistoryFrame: toTs must be a safe integer after fromTs");
  if (typeof priceLo !== "number" || !Number.isFinite(priceLo) || priceLo <= 0) throw new Error("bandHistoryFrame: priceLo must be a positive finite number");
  if (typeof priceHi !== "number" || !Number.isFinite(priceHi) || priceHi < priceLo) throw new Error("bandHistoryFrame: priceHi must be a finite number at or above priceLo");
  if (!Number.isSafeInteger(columnMs) || columnMs <= 0) throw new Error("bandHistoryFrame: columnMs must be a positive safe integer");
  if (typeof complete !== "boolean") throw new Error("bandHistoryFrame: complete must be a boolean");
  if (complete ? reason !== null : !BAND_HISTORY_REASONS.includes(reason)) {
    throw new Error(`bandHistoryFrame: reason must be null when complete, else one of ${BAND_HISTORY_REASONS.join(", ")}`);
  }
  if (reason === "OVERLOADED") {
    if (retryAfterMs !== null && (!Number.isSafeInteger(retryAfterMs) || retryAfterMs <= 0 || retryAfterMs > 24 * 60 * 60 * 1000)) {
      throw new Error("bandHistoryFrame: retryAfterMs must be a positive safe integer no greater than one day or null");
    }
  } else if (retryAfterMs !== null) {
    throw new Error("bandHistoryFrame: retryAfterMs is only valid when OVERLOADED");
  }
  const geometryKnown = !BAND_HISTORY_ROWLESS_REASONS.has(reason);
  if (geometryKnown) {
    if (typeof rowWidth !== "number" || !Number.isFinite(rowWidth) || rowWidth <= 0) throw new Error("bandHistoryFrame: rowWidth must be a positive finite number");
    if (!Number.isSafeInteger(rowLo) || !Number.isSafeInteger(rowHi) || rowHi < rowLo) throw new Error("bandHistoryFrame: rowLo/rowHi must be safe integers with rowHi at or above rowLo");
    if (rowHi - rowLo + 1 > MAX_BAND_HISTORY_ROWS) throw new Error(`bandHistoryFrame: the band must span at most ${MAX_BAND_HISTORY_ROWS} rows`);
  } else if (rowWidth !== null || rowLo !== null || rowHi !== null) {
    throw new Error("bandHistoryFrame: rowWidth, rowLo and rowHi must be null when the geometry is unavailable");
  }
  if (!Array.isArray(columns) || columns.length > MAX_BAND_HISTORY_COLUMNS) {
    throw new Error(`bandHistoryFrame: columns must be an array of at most ${MAX_BAND_HISTORY_COLUMNS} columns`);
  }
  if (!complete && columns.length > 0) throw new Error("bandHistoryFrame: an incomplete reply carries no columns");
  const rows = geometryKnown ? rowHi - rowLo + 1 : 0;
  const ceiling = identity.provider === "DXFEED" ? sizeCeilingForAssetClass(identity.assetClass) : MAX_WIRE_MAGNITUDE;
  let previousTs = -1;
  const frozenColumns = columns.map((column, index) => {
    if (!Number.isSafeInteger(column?.ts) || column.ts <= previousTs) throw new Error(`bandHistoryFrame.columns[${index}]: ts must be a safe integer, strictly ascending`);
    previousTs = column.ts;
    for (const side of ["bid", "ask", "buy", "sell"]) {
      const values = column[side];
      if (!Array.isArray(values) || values.length !== rows) throw new Error(`bandHistoryFrame.columns[${index}].${side}: must hold one value per row`);
      for (const value of values) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > ceiling) {
          throw new Error(`bandHistoryFrame.columns[${index}].${side}: values must be finite, non-negative and within the size ceiling (value ${value}, ceiling ${ceiling})`);
        }
      }
    }
    return Object.freeze({ ts: column.ts, bid: Object.freeze([...column.bid]), ask: Object.freeze([...column.ask]), buy: Object.freeze([...column.buy]), sell: Object.freeze([...column.sell]) });
  });
  const selection = identity.provider === "BINANCE"
    ? selectionFrame(identity.symbol, identity.marketKind)
    : dxfeedSelectionFrame(identity.symbol, identity.assetClass);
  return Object.freeze({
    ...selection,
    type: "band_history",
    request_id: requestId,
    from_ts: fromTs,
    to_ts: toTs,
    price_lo: priceLo,
    price_hi: priceHi,
    column_ms: columnMs,
    row_width: geometryKnown ? rowWidth : null,
    row_lo: geometryKnown ? rowLo : null,
    row_hi: geometryKnown ? rowHi : null,
    complete,
    reason,
    retry_after_ms: retryAfterMs,
    columns: Object.freeze(frozenColumns),
  });
}

const MAX_DELTA_PROFILE_ROWS = 8_192;
const DELTA_PROFILE_REASONS = Object.freeze(["ROWS_CAPPED", "STORAGE_UNAVAILABLE", "READ_FAILED", "OVERLOADED", "BAD_REQUEST"]);

function deltaProfileFrame(identity, { requestId, fromTs, toTs, rowWidth, complete, reason = null, retryAfterMs = null, pending, rows }) {
  if (!["BINANCE", "DXFEED"].includes(identity?.provider)) throw new Error("deltaProfileFrame: invalid provider");
  if (!Number.isSafeInteger(requestId) || requestId < 0) throw new Error("deltaProfileFrame: requestId must be a non-negative safe integer");
  if (!Number.isSafeInteger(fromTs) || fromTs < 0) throw new Error("deltaProfileFrame: fromTs must be a non-negative safe integer");
  if (!Number.isSafeInteger(toTs) || toTs <= fromTs) throw new Error("deltaProfileFrame: toTs must be a safe integer after fromTs");
  if (typeof rowWidth !== "number" || !Number.isFinite(rowWidth) || rowWidth <= 0) throw new Error("deltaProfileFrame: rowWidth must be a positive finite number");
  if (typeof complete !== "boolean") throw new Error("deltaProfileFrame: complete must be a boolean");
  if (complete ? reason !== null : !DELTA_PROFILE_REASONS.includes(reason)) {
    throw new Error(`deltaProfileFrame: reason must be null when complete, else one of ${DELTA_PROFILE_REASONS.join(", ")}`);
  }
  if (reason === "OVERLOADED") {
    if (retryAfterMs !== null && (!Number.isSafeInteger(retryAfterMs) || retryAfterMs <= 0 || retryAfterMs > 24 * 60 * 60 * 1000)) {
      throw new Error("deltaProfileFrame: retryAfterMs must be a positive safe integer no greater than one day or null");
    }
  } else if (retryAfterMs !== null) {
    throw new Error("deltaProfileFrame: retryAfterMs is only valid when OVERLOADED");
  }
  if (!Number.isSafeInteger(pending) || pending < 0) throw new Error("deltaProfileFrame: pending must be a non-negative safe integer");
  if (!Array.isArray(rows) || rows.length > MAX_DELTA_PROFILE_ROWS) {
    throw new Error(`deltaProfileFrame: rows must be an array of at most ${MAX_DELTA_PROFILE_ROWS} rows`);
  }
  if (!complete && rows.length > 0) throw new Error("deltaProfileFrame: an incomplete piece carries no rows");
  let previousPrice = 0;
  const frozenRows = rows.map((row, index) => {
    if (!Array.isArray(row) || row.length !== 3) throw new Error(`deltaProfileFrame.rows[${index}]: must be [price, buy, sell]`);
    const [price, buy, sell] = row;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= previousPrice) {
      throw new Error(`deltaProfileFrame.rows[${index}]: price must be a positive finite number, strictly ascending`);
    }
    for (const volume of [buy, sell]) {
      if (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0 || volume > MAX_PROFILE_VOLUME) {
        throw new Error(`deltaProfileFrame.rows[${index}]: volumes must be finite, non-negative and within the profile volume ceiling`);
      }
    }
    previousPrice = price;
    return Object.freeze([price, buy, sell]);
  });
  const selection = identity.provider === "BINANCE"
    ? selectionFrame(identity.symbol, identity.marketKind)
    : dxfeedSelectionFrame(identity.symbol, identity.assetClass);
  return Object.freeze({
    ...selection,
    type: "delta_profile",
    request_id: requestId,
    from_ts: fromTs,
    to_ts: toTs,
    row_width: rowWidth,
    complete,
    reason,
    retry_after_ms: retryAfterMs,
    pending,
    rows: Object.freeze(frozenRows),
  });
}

module.exports = {
  analyticsStatusFrame,
  aggressiveHistoryFrame,
  deltaProfileFrame,
  MAX_DELTA_PROFILE_ROWS,
  DELTA_PROFILE_REASONS,
  bandHistoryFrame,
  MAX_BAND_HISTORY_COLUMNS,
  MAX_BAND_HISTORY_ROWS,
  BAND_HISTORY_REASONS,
  markerHistoryFrame,
  markerHistoryFrames,
  MAX_MARKER_HISTORY_ROWS,
  MAX_SNAPSHOT_MARKERS,
  MAX_AGGRESSIVE_HISTORY_TRADES,
  AGGRESSIVE_HISTORY_REASONS,
  bookFailureReason,
  INTERVAL_MS,
  BOOK_DEPTH_LEVELS,
  MAX_WIRE_MAGNITUDE,
  toWireSymbol,
  fromWireSymbol,
  tradeEnvelopeToFrame,
  klineEnvelopeToFrame,
  restKlineRowToBarFrame,
  storageCandleRowToBarFrame,
  storageTradeRowToTradeFrame,
  markerFrame,
  profileFrame,
  vpinFrame,
  liquidityFrame,
  liquidityWireBody,
  liquidityLevels,
  MAX_LIQUIDITY_COLUMNS,
  MAX_LIQUIDITY_ROWS,
  MAX_LIQUIDITY_PRINTS,
  MAX_AGGRESSIVE_POOL_PRINTS,
  LIQUIDITY_COLUMN_KEYS,
  MAX_LIQUIDITY_LEVELS,
  MAX_AGGRESSIVE_EVENTS,
  snapshotFrame,
  healthFrame,
  bookFrame,
  selectionFrame,
  dxfeedToWireSymbol,
  dxfeedFromWireSymbol,
  dxfeedTradeFrame,
  dxfeedMarkerFrame,
  dxfeedProfileFrame,
  buildProfileWireFields,
  vpinReadingsToWire,
  dxfeedVpinFrame,
  dxfeedBarFrame,
  storageDxFeedCandleRowToBarFrame,
  dxfeedHealthFrame,
  dxfeedBookFrame,
  dxfeedSelectionFrame,
  dxfeedLiquidityFrame,
  dxfeedSnapshotFrame,
  DXFEED_CANDLE_INTERVAL_MS,
  frameKindOf,
  FRAME_KIND_CONTROL,
  FRAME_KIND_LATEST_STATE,
  FRAME_KIND_INCREMENTAL,
  FRAME_KIND_BULK_HISTORY,
};
