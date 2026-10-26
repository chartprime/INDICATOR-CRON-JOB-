const CANDLE_INTERVAL_MS = 60_000;
const NAN_TOKEN = "NaN";
const MAX_DESCRIBED_LENGTH = 40;

function describeValue(value) {
  const text = typeof value === "string" ? JSON.stringify(value) : String(value);
  return text.length > MAX_DESCRIBED_LENGTH ? `${text.slice(0, MAX_DESCRIBED_LENGTH)}...` : text;
}

function positive(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`dxfeed candle: ${field} must be positive and finite (got ${describeValue(value)})`);
  }
  return value;
}

function nonNegative(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`dxfeed candle: ${field} must be non-negative and finite (got ${describeValue(value)})`);
  }
  return value;
}

function isAbsent(value) {
  return value === undefined || value === null || value === NAN_TOKEN || (typeof value === "number" && Number.isNaN(value));
}

function isEmptyNativeCandle(raw) {
  return ["open", "high", "low", "close"].every((field) => isAbsent(raw?.[field]))
    && (isAbsent(raw?.volume) || raw.volume === 0)
    && (isAbsent(raw?.count) || raw.count === 0);
}

function optionalNonNegative(value, field) {
  if (isAbsent(value)) return null;
  return nonNegative(value, field);
}

function adaptNativeDxFeedCandle(raw, { symbol }) {
  if (!raw || typeof raw !== "object" || raw.eventType !== "Candle" || raw.eventSymbol !== `${symbol}{=m}`) {
    throw new Error("dxfeed candle: identity mismatch");
  }
  if (!Number.isSafeInteger(raw.time) || raw.time < 0 || raw.time % CANDLE_INTERVAL_MS !== 0) {
    throw new Error("dxfeed candle: time must align to one minute");
  }
  const open = positive(raw.open, "open");
  const high = positive(raw.high, "high");
  const low = positive(raw.low, "low");
  const close = positive(raw.close, "close");
  const volume = positive(raw.volume, "volume");
  const buyVolume = optionalNonNegative(raw.askVolume, "askVolume");
  const sellVolume = optionalNonNegative(raw.bidVolume, "bidVolume");
  if (low > Math.min(open, close) || high < Math.max(open, close) || low > high) {
    throw new Error("dxfeed candle: OHLC is inconsistent");
  }
  if (buyVolume !== null && sellVolume !== null && buyVolume + sellVolume > volume + 1e-9) {
    throw new Error("dxfeed candle: directional volume exceeds total volume");
  }
  if (!Number.isSafeInteger(raw.count) || raw.count <= 0) {
    throw new Error("dxfeed candle: count must be a positive safe integer");
  }
  return Object.freeze({
    ts_open: raw.time, open, high, low, close, volume,
    buy_volume: buyVolume, sell_volume: sellVolume, trade_count: raw.count, closed: true,
  });
}

module.exports = { adaptNativeDxFeedCandle, isEmptyNativeCandle, CANDLE_INTERVAL_MS };
