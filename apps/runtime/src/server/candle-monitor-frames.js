"use strict";

const { selectionFrame, dxfeedSelectionFrame } = require("./frames");
const { MAX_VALID_EPOCH_MS, MAX_WIRE_MAGNITUDE } = require("./wire-fields");
const { CANDLE_MS, RAW_CAP } = require("../indicators/exhaustion/exhaustion-engine");
const { ENTRY_KEYS } = require("../indicators/candle-monitor/candle-monitor");

const MAX_CANDLE_MONITOR_ENTRIES = CANDLE_MS.length;
const CANDLE_MONITOR_TRADE_KEYS = Object.freeze(["price", "size"]);
const SORTED_ENTRY_KEYS = Object.freeze([...ENTRY_KEYS].sort());

function identityFields(identity, field) {
  if (identity?.provider === "BINANCE") return selectionFrame(identity.symbol, identity.marketKind);
  if (identity?.provider === "DXFEED") return dxfeedSelectionFrame(identity.symbol, identity.assetClass);
  throw new Error(`${field}: invalid provider`);
}

function epochMs(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_VALID_EPOCH_MS) throw new Error(`${field}: must be a non-negative epoch-ms integer`);
  return value;
}

function amount(value, field, { low = 0, ceiling }) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > ceiling) throw new Error(`${field}: must be a finite number from ${low} to ${ceiling}`);
  return value;
}

function trade(value, field) {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${field}: must be null or a trade`);
  const keys = Object.keys(value).sort();
  if (keys.length !== CANDLE_MONITOR_TRADE_KEYS.length || keys.some((key, index) => key !== CANDLE_MONITOR_TRADE_KEYS[index])) throw new Error(`${field}: must carry exactly price and size`);
  return Object.freeze({
    price: amount(value.price, `${field}.price`, { low: Number.MIN_VALUE, ceiling: MAX_WIRE_MAGNITUDE }),
    size: amount(value.size, `${field}.size`, { low: Number.MIN_VALUE, ceiling: RAW_CAP }),
  });
}

function wireEntry(entry, field) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${field}: must be an object`);
  const keys = Object.keys(entry).sort();
  if (keys.length !== SORTED_ENTRY_KEYS.length || keys.some((key, index) => key !== SORTED_ENTRY_KEYS[index])) throw new Error(`${field}: must carry exactly ${ENTRY_KEYS.join(", ")}`);
  if (!CANDLE_MS.includes(entry.candleMs)) throw new Error(`${field}.candleMs: must be a chart candle length`);
  return Object.freeze({
    candleMs: entry.candleMs,
    candleTs: epochMs(entry.candleTs, `${field}.candleTs`),
    buy: amount(entry.buy, `${field}.buy`, { ceiling: RAW_CAP }),
    sell: amount(entry.sell, `${field}.sell`, { ceiling: RAW_CAP }),
    biggestBuy: trade(entry.biggestBuy, `${field}.biggestBuy`),
    biggestSell: trade(entry.biggestSell, `${field}.biggestSell`),
  });
}

function candleMonitorFrame(identity, { ts, entries }) {
  const wire = identityFields(identity, "candleMonitorFrame");
  epochMs(ts, "candleMonitorFrame.ts");
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_CANDLE_MONITOR_ENTRIES) {
    throw new Error(`candleMonitorFrame.entries: must be one to ${MAX_CANDLE_MONITOR_ENTRIES} entries`);
  }
  let previous = -1;
  const wireEntries = entries.map((entry, index) => {
    const checked = wireEntry(entry, `candleMonitorFrame.entries[${index}]`);
    if (checked.candleMs <= previous) throw new Error(`candleMonitorFrame.entries[${index}].candleMs: entries must rise by candle length, one per length`);
    if (checked.candleTs % checked.candleMs !== 0) throw new Error(`candleMonitorFrame.entries[${index}].candleTs: must open on its candle length`);
    previous = checked.candleMs;
    return checked;
  });
  return Object.freeze({ ...wire, type: "candle_monitor", ts, entries: Object.freeze(wireEntries) });
}

module.exports = { candleMonitorFrame, MAX_CANDLE_MONITOR_ENTRIES, CANDLE_MONITOR_ENTRY_KEYS: ENTRY_KEYS, CANDLE_MONITOR_TRADE_KEYS };
