"use strict";
const { createHash } = require("node:crypto");
const { requireValue, token, integer, timestamp, decimalText, compareDecimal, subtractDecimal, decimal, ContractError } = require("./exact");
const { instrument } = require("./identity");
const VERSION = "market-observation/1";
const FAMILIES = Object.freeze(["trade", "quote", "candle", "depth", "order", "derivative", "liquidation", "reference", "status", "statistic", "trade_minute", "trade_level", "trade_slice", "trade_prints"]);
const DERIVED_FAMILIES = Object.freeze(["trade_minute", "trade_level", "trade_slice", "trade_prints"]);
const DERIVED_INTERVAL_NS = Object.freeze({ trade_minute: 60000000000n, trade_level: 60000000000n, trade_slice: 2000000000n, trade_prints: 60000000000n });
const MAX_PRINT_RANK = 64;
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
function hash(value) { return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex"); }
function object(value) { requireValue(value && typeof value === "object" && !Array.isArray(value), "INVALID_OBJECT"); }
function ns(value) { requireValue(typeof value === "string", "CANONICAL_TIME_STRING_REQUIRED"); timestamp(value); }
function amount(value, nullable = false) {
  if (nullable && value === null) return;
  decimalText(value); requireValue(compareDecimal(value, decimal("0")) >= 0, "NEGATIVE_QUANTITY");
}
function price(value, nullable = false) { if (nullable && value === null) return; decimalText(value); }
function flag(value) { requireValue(typeof value === "boolean", "INVALID_BOOLEAN"); }
function side(value) { requireValue(["BUY", "SELL", "UNKNOWN"].includes(value), "INVALID_SIDE"); }
function addDecimal(a, b) { return subtractDecimal(a, { coefficient: (-BigInt(b.coefficient)).toString(), scale: b.scale }); }
function bucket(family, d) {
  ns(d.openNs); ns(d.closeNs);
  requireValue(BigInt(d.closeNs) - BigInt(d.openNs) === DERIVED_INTERVAL_NS[family], "INVALID_BUCKET_INTERVAL");
  requireValue(BigInt(d.openNs) % DERIVED_INTERVAL_NS[family] === 0n, "BUCKET_NOT_GRID_ALIGNED");
  token(d.method);
}
function count(value) { integer(value); requireValue(BigInt(value) > 0n, "EMPTY_BUCKET"); }
function validateData(family, d) {
  requireValue(d && typeof d === "object" && !Array.isArray(d), "INVALID_PAYLOAD");
  switch (family) {
    case "trade":
    case "liquidation":
      requireValue(["NEW", "CORRECTION", "CANCEL"].includes(d.action), "INVALID_TRADE_ACTION");
      token(d.entityId); side(d.side); flag(d.validTick);
      price(d.price, d.action === "CANCEL"); amount(d.size, d.action === "CANCEL");
      requireValue(d.action === "NEW" ? d.replaces === null : d.replaces === d.entityId, "INVALID_CORRECTION_TARGET");
      break;
    case "quote":
      for (const s of ["bid", "ask"]) { object(d[s]); price(d[s].price, true); amount(d[s].size, true); requireValue((d[s].price === null) === (d[s].size === null), "PARTIAL_QUOTE_SIDE"); }
      requireValue(d.depthLimit === 1, "INVALID_QUOTE_DEPTH");
      break;
    case "candle":
      ns(d.openNs); ns(d.closeNs); requireValue(BigInt(d.openNs) < BigInt(d.closeNs), "INVALID_BAR_INTERVAL");
      for (const p of ["open", "high", "low", "close"]) price(d[p]);
      requireValue(compareDecimal(d.low, d.high) <= 0 && [d.open, d.close].every(p => compareDecimal(d.low, p) <= 0 && compareDecimal(p, d.high) <= 0), "INVALID_OHLC");
      amount(d.volume); amount(d.buyVolume, true); flag(d.closed);
      if (d.buyVolume !== null) requireValue(compareDecimal(d.buyVolume, d.volume) <= 0, "INVALID_BUY_VOLUME");
      token(d.method); break;
    case "depth":
      requireValue(["SNAPSHOT", "SET_LEVELS"].includes(d.action), "INVALID_DEPTH_ACTION");
      requireValue(d.depthLimit === null || (Number.isSafeInteger(d.depthLimit) && d.depthLimit > 0), "INVALID_DEPTH_LIMIT");
      requireValue(["FULL_CAPTURED", "TOP_N", "INCREMENTAL"].includes(d.model), "INVALID_DEPTH_MODEL");
      requireValue(d.model !== "TOP_N" || d.depthLimit !== null, "TOP_N_LIMIT_REQUIRED");
      token(d.batchId); flag(d.batchEnd); flag(d.reset);
      for (const s of ["bids", "asks"]) {
        requireValue(Array.isArray(d[s]) && d[s].length <= 10000, "INVALID_LEVELS");
        if (d.depthLimit !== null) requireValue(d[s].length <= d.depthLimit, "DEPTH_LIMIT_EXCEEDED");
        for (const level of d[s]) { object(level); price(level.price); amount(level.size); }
      }
      for (const k of ["firstSequence", "lastSequence", "previousSequence"]) if (d[k] !== null) integer(d[k]);
      break;
    case "order":
      token(d.index); token(d.source); token(d.scope); token(d.action); integer(d.eventFlags);
      requireValue(BigInt(d.eventFlags) <= 0xffffffffn, "INVALID_EVENT_FLAGS");
      requireValue(["BUY", "SELL", "UNKNOWN"].includes(d.side), "INVALID_SIDE");
      flag(d.remove); price(d.price, d.remove); amount(d.size, d.remove);
      if (d.orderId !== null) token(d.orderId); break;
    case "derivative":
      price(d.fundingRate, true); price(d.markPrice, true); price(d.indexPrice, true); amount(d.openInterest, true);
      if (d.fundingTimeNs !== null) ns(d.fundingTimeNs);
      requireValue([d.fundingRate, d.markPrice, d.indexPrice, d.openInterest].some(x => x !== null), "EMPTY_DERIVATIVE"); break;
    case "reference":
      ns(d.validFromNs); ns(d.validToNs); requireValue(BigInt(d.validFromNs) < BigInt(d.validToNs), "INVALID_REFERENCE_INTERVAL");
      token(d.referenceVersion); token(d.sourceSymbol); price(d.tickSize); requireValue(compareDecimal(d.tickSize, decimal("0")) > 0, "INVALID_TICK_SIZE");
      amount(d.multiplier); break;
    case "status": token(d.code); token(d.scope); break;
    case "statistic": token(d.name); price(d.value); token(d.unit); token(d.updateAction); break;
    case "trade_minute":
      bucket(family, d);
      for (const k of ["volume", "buyVolume", "sellVolume", "undefinedVolume", "buyNotional", "sellNotional"]) amount(d[k]);
      requireValue(compareDecimal(addDecimal(addDecimal(d.buyVolume, d.sellVolume), d.undefinedVolume), d.volume) === 0, "SIDE_VOLUMES_DO_NOT_SUM_TO_VOLUME");
      count(d.tradeCount); break;
    case "trade_level":
      bucket(family, d);
      price(d.tickSize); requireValue(compareDecimal(d.tickSize, decimal("0")) > 0, "INVALID_TICK_SIZE");
      integer(d.priceBucket, true);
      for (const k of ["volume", "buyVolume", "sellVolume"]) amount(d[k]);
      requireValue(compareDecimal(addDecimal(d.buyVolume, d.sellVolume), d.volume) <= 0, "SIDE_VOLUMES_EXCEED_VOLUME");
      count(d.tradeCount); break;
    case "trade_slice":
      bucket(family, d);
      ns(d.lastTradeNs);
      requireValue(BigInt(d.openNs) <= BigInt(d.lastTradeNs) && BigInt(d.lastTradeNs) < BigInt(d.closeNs), "LAST_TRADE_OUTSIDE_SLICE");
      amount(d.buyNotional); amount(d.sellNotional);
      count(d.tradeCount); break;
    case "trade_prints":
      bucket(family, d);
      requireValue(["BUY", "SELL"].includes(d.side), "INVALID_SIDE");
      integer(d.rank); requireValue(BigInt(d.rank) >= 1n && BigInt(d.rank) <= BigInt(MAX_PRINT_RANK), "INVALID_PRINT_RANK");
      ns(d.tradeNs);
      requireValue(BigInt(d.openNs) <= BigInt(d.tradeNs) && BigInt(d.tradeNs) < BigInt(d.closeNs), "PRINT_OUTSIDE_BUCKET");
      price(d.price); amount(d.size); requireValue(compareDecimal(d.size, decimal("0")) > 0, "EMPTY_PRINT");
      token(d.tradeEntityId); break;
    default: requireValue(false, "UNKNOWN_FAMILY");
  }
}
function validateRecord(r) {
  requireValue(r?.schemaVersion === VERSION && FAMILIES.includes(r.family), "INVALID_SCHEMA");
  for (const key of ["instrument", "source", "lineage", "time", "order", "quality"]) requireValue(r[key] && typeof r[key] === "object" && !Array.isArray(r[key]), "MISSING_ENVELOPE_FIELD");
  requireValue(instrument(r.instrument).id === r.instrument.id, "INVALID_INSTRUMENT_ID");
  for (const k of ["provider", "dataset", "schema", "population", "methodVersion", "datasetVersion", "sourceSymbol", "mappingVersion", "mappingReference", "streamId"]) token(r.source[k]);
  token(r.lineage.object); token(r.lineage.sha256); requireValue(/^[a-f0-9]{64}$/.test(r.lineage.sha256), "INVALID_RAW_HASH"); integer(r.lineage.row);
  ns(r.time.eventNs); ns(r.time.ingestNs);
  if (r.time.receiveNs !== null) ns(r.time.receiveNs);
  requireValue(["ns", "us", "ms", "s"].includes(r.time.precision), "INVALID_PRECISION");
  requireValue(["EXCHANGE", "PROVIDER", "RECEIVE_FALLBACK"].includes(r.time.origin), "INVALID_TIME_ORIGIN");
  if (r.order.sequence !== null) integer(r.order.sequence);
  integer(r.order.ordinal); integer(r.order.position); token(r.order.domain);
  requireValue(["UNVERIFIED", "VALIDATED", "GAP", "SNAPSHOT_PENDING"].includes(r.quality.state), "INVALID_QUALITY");
  requireValue(Array.isArray(r.quality.flags) && r.quality.flags.every(f => typeof f === "string" && f.length <= 128), "INVALID_QUALITY_FLAGS");
  validateData(r.family, r.data);
  requireValue(r.id === recordId(r), "INVALID_RECORD_ID");
  return r;
}
function recordId(r) {
  return hash([r.schemaVersion, r.source.provider, r.source.dataset, r.source.schema, r.source.population, r.source.datasetVersion, r.source.methodVersion, r.source.mappingVersion, r.instrument.id, r.family, r.lineage.sha256, r.lineage.row, r.order.ordinal]);
}
function createRecord(r) {
  const result = structuredClone({ ...r, schemaVersion: VERSION });
  for (const k of ["source", "instrument", "lineage", "order"]) object(result[k]);
  result.id = recordId(result); return validateRecord(result);
}
function quarantine(operation, lineage) {
  try { return { ok: true, records: operation().map(validateRecord) }; }
  catch (error) {
    if (!(error instanceof ContractError)) throw error;
    return { ok: false, records: [], quarantine: { schemaVersion: VERSION, reason: error.code, lineage: structuredClone(lineage) } };
  }
}
module.exports = { VERSION, FAMILIES, DERIVED_FAMILIES, DERIVED_INTERVAL_NS, hash, validateData, validateRecord, createRecord, quarantine };
