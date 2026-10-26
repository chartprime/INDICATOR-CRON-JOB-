"use strict";

const { selectionFrame, dxfeedSelectionFrame } = require("./frames");
const { MAX_VALID_EPOCH_MS, MAX_WIRE_MAGNITUDE, decimalToFiniteNumber } = require("./wire-fields");
const { CANDLE_MS, SIDES, DOMINANTS, FACTS, MAX_SCORE } = require("../indicators/initiative/initiative-engine");

const MAX_INITIATIVE_BANDS = 500;
const MAX_INITIATIVE_ID_LENGTH = 96;
const MAX_INITIATIVE_SCORE = MAX_SCORE;
const MAX_INITIATIVE_VALUE = 1_000_000;
const MAX_INITIATIVE_WINDOW = 1_000;
const INITIATIVE_CANDLE_MS = CANDLE_MS;
const INITIATIVE_SIDES = SIDES;
const INITIATIVE_DOMINANTS = DOMINANTS;
const INITIATIVE_FACTS = FACTS;
const INITIATIVE_ORIGINS = Object.freeze(["runtime", "host", "stored"]);
const INITIATIVE_FACT_KEYS = Object.freeze({
  efficiency: Object.freeze(["yes", "value"]),
  closes: Object.freeze(["yes", "value"]),
  burst: Object.freeze(["yes", "value"]),
  delta: Object.freeze(["yes", "rank", "share"]),
  prints: Object.freeze(["yes", "rank", "perCandle"]),
});
const SORTED_FACTS = Object.freeze([...INITIATIVE_FACTS].sort());

function identityFields(identity, field) {
  if (identity?.provider === "BINANCE") return selectionFrame(identity.symbol, identity.marketKind);
  if (identity?.provider === "DXFEED") return dxfeedSelectionFrame(identity.symbol, identity.assetClass);
  throw new Error(`${field}: invalid provider`);
}

function epochMs(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_VALID_EPOCH_MS) throw new Error(`${field}: must be a non-negative epoch-ms integer`);
  return value;
}

function counter(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field}: must be a non-negative integer`);
  return value;
}

function bounded(value, low, high, field) {
  if (!Number.isSafeInteger(value) || value < low || value > high) throw new Error(`${field}: must be an integer from ${low} to ${high}`);
  return value;
}

function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw new Error(`${field}: must be one of ${allowed.join(", ")}`);
  return value;
}

function unit(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${field}: must be a number from 0 to 1`);
  return value;
}

function unitOrNull(value, field) {
  return value === null ? null : unit(value, field);
}

function amountOrNull(value, field) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_INITIATIVE_VALUE) throw new Error(`${field}: must be null or a number from 0 to ${MAX_INITIATIVE_VALUE}`);
  return value;
}

function yes(value, field) {
  if (typeof value !== "boolean") throw new Error(`${field}: must be a boolean`);
  return value;
}

function exactKeys(value, keys, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field}: must carry exactly ${keys.join(", ")}`);
  const sorted = [...keys].sort();
  const own = Object.keys(value).sort();
  if (own.length !== sorted.length || own.some((key, i) => key !== sorted[i])) throw new Error(`${field}: must carry exactly ${keys.join(", ")}`);
}

function facts(value, windowCandles, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field}: must be the five facts`);
  const keys = Object.keys(value).sort();
  if (keys.length !== SORTED_FACTS.length || keys.some((key, i) => key !== SORTED_FACTS[i])) throw new Error(`${field}: must carry exactly ${INITIATIVE_FACTS.join(", ")}`);
  for (const key of INITIATIVE_FACTS) exactKeys(value[key], INITIATIVE_FACT_KEYS[key], `${field}.${key}`);
  const closes = bounded(value.closes.value, 0, MAX_INITIATIVE_WINDOW, `${field}.closes.value`);
  if (closes > windowCandles) throw new Error(`${field}.closes.value: must not exceed windowCandles`);
  return Object.freeze({
    efficiency: Object.freeze({ yes: yes(value.efficiency.yes, `${field}.efficiency.yes`), value: unitOrNull(value.efficiency.value, `${field}.efficiency.value`) }),
    closes: Object.freeze({ yes: yes(value.closes.yes, `${field}.closes.yes`), value: closes }),
    burst: Object.freeze({ yes: yes(value.burst.yes, `${field}.burst.yes`), value: amountOrNull(value.burst.value, `${field}.burst.value`) }),
    delta: Object.freeze({ yes: yes(value.delta.yes, `${field}.delta.yes`), rank: unitOrNull(value.delta.rank, `${field}.delta.rank`), share: unitOrNull(value.delta.share, `${field}.delta.share`) }),
    prints: Object.freeze({ yes: yes(value.prints.yes, `${field}.prints.yes`), rank: unitOrNull(value.prints.rank, `${field}.prints.rank`), perCandle: amountOrNull(value.prints.perCandle, `${field}.prints.perCandle`) }),
  });
}

function wireBand(entry, field) {
  if (entry === null || typeof entry !== "object") throw new Error(`${field}: must be a band`);
  if (typeof entry.id !== "string" || entry.id.length === 0 || entry.id.length > MAX_INITIATIVE_ID_LENGTH) {
    throw new Error(`${field}.id: must be a string of 1 to ${MAX_INITIATIVE_ID_LENGTH} characters`);
  }
  const pivotTs = epochMs(entry.pivotTs, `${field}.pivotTs`);
  const frozenTs = epochMs(entry.frozenTs, `${field}.frozenTs`);
  const legExtremeTs = epochMs(entry.legExtremeTs, `${field}.legExtremeTs`);
  const legEndTs = entry.legEndTs === null ? null : epochMs(entry.legEndTs, `${field}.legEndTs`);
  const updatedAt = epochMs(entry.updatedAt, `${field}.updatedAt`);
  if (frozenTs <= pivotTs) throw new Error(`${field}.frozenTs: must follow pivotTs`);
  if (legExtremeTs < frozenTs) throw new Error(`${field}.legExtremeTs: must not precede frozenTs`);
  if (legEndTs !== null && legEndTs < frozenTs) throw new Error(`${field}.legEndTs: must be null or not precede frozenTs`);
  if (updatedAt < frozenTs) throw new Error(`${field}.updatedAt: must not precede frozenTs`);
  const windowCandles = bounded(entry.windowCandles, 1, MAX_INITIATIVE_WINDOW, `${field}.windowCandles`);
  return Object.freeze({
    id: entry.id,
    candleMs: oneOf(entry.candleMs, INITIATIVE_CANDLE_MS, `${field}.candleMs`),
    side: oneOf(entry.side, INITIATIVE_SIDES, `${field}.side`),
    dominant: oneOf(entry.dominant, INITIATIVE_DOMINANTS, `${field}.dominant`),
    dominantShare: unit(entry.dominantShare, `${field}.dominantShare`),
    score: bounded(entry.score, 0, MAX_INITIATIVE_SCORE, `${field}.score`),
    facts: facts(entry.facts, windowCandles, `${field}.facts`),
    pivotTs,
    pivotPrice: decimalToFiniteNumber(entry.pivotPrice, `${field}.pivotPrice`, { ceiling: MAX_WIRE_MAGNITUDE }),
    frozenTs,
    frozenPrice: decimalToFiniteNumber(entry.frozenPrice, `${field}.frozenPrice`, { ceiling: MAX_WIRE_MAGNITUDE }),
    windowCandles,
    atr: decimalToFiniteNumber(entry.atr, `${field}.atr`, { ceiling: MAX_WIRE_MAGNITUDE }),
    legExtremePrice: decimalToFiniteNumber(entry.legExtremePrice, `${field}.legExtremePrice`, { ceiling: MAX_WIRE_MAGNITUDE }),
    legExtremeTs,
    legEndTs,
    updatedAt,
    origin: oneOf(entry.origin, INITIATIVE_ORIGINS, `${field}.origin`),
  });
}

function byPivot(a, b) {
  return a.pivotTs - b.pivotTs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function initiativeBandsFrame(identity, { ts, seq, reset, bands, liveSince, loading = null }) {
  const wire = identityFields(identity, "initiativeBandsFrame");
  epochMs(ts, "initiativeBandsFrame.ts");
  counter(seq, "initiativeBandsFrame.seq");
  epochMs(liveSince, "initiativeBandsFrame.liveSince");
  if (loading !== null) epochMs(loading, "initiativeBandsFrame.loading");
  if (typeof reset !== "boolean") throw new Error("initiativeBandsFrame.reset: must be a boolean");
  if (!Array.isArray(bands) || bands.length > MAX_INITIATIVE_BANDS) {
    throw new Error(`initiativeBandsFrame.bands: must be an array of at most ${MAX_INITIATIVE_BANDS} bands`);
  }
  if (!reset && bands.length === 0) throw new Error("initiativeBandsFrame: an increment must carry at least one band");
  const ids = new Set();
  let previous = null;
  const wireBands = bands.map((entry, index) => {
    const checked = wireBand(entry, `initiativeBandsFrame.bands[${index}]`);
    if (ids.has(checked.id)) throw new Error(`initiativeBandsFrame.bands[${index}].id: ids must be unique within a frame`);
    if (previous !== null && byPivot(previous, checked) > 0) throw new Error(`initiativeBandsFrame.bands[${index}]: bands must be in pivot order`);
    ids.add(checked.id);
    previous = checked;
    return checked;
  });
  return Object.freeze({ ...wire, type: "initiative_bands", ts, seq, reset, bands: Object.freeze(wireBands), liveSince, loading });
}

function initiativeBandsFrames(identity, ts, bands, { chunk = MAX_INITIATIVE_BANDS, liveSince, loading = null } = {}) {
  if (!Number.isSafeInteger(chunk) || chunk <= 0 || chunk > MAX_INITIATIVE_BANDS) {
    throw new Error(`initiativeBandsFrames: chunk must be an integer from 1 to ${MAX_INITIATIVE_BANDS}`);
  }
  if (!Array.isArray(bands)) throw new Error("initiativeBandsFrames: bands must be an array");
  const frames = [];
  for (let start = 0; start < bands.length || frames.length === 0; start += chunk) {
    frames.push(initiativeBandsFrame(identity, { ts, seq: frames.length, reset: start === 0, bands: bands.slice(start, start + chunk), liveSince, loading }));
  }
  return frames;
}

module.exports = {
  initiativeBandsFrame,
  initiativeBandsFrames,
  byPivot,
  MAX_INITIATIVE_BANDS,
  MAX_INITIATIVE_ID_LENGTH,
  MAX_INITIATIVE_SCORE,
  MAX_INITIATIVE_VALUE,
  MAX_INITIATIVE_WINDOW,
  INITIATIVE_CANDLE_MS,
  INITIATIVE_SIDES,
  INITIATIVE_DOMINANTS,
  INITIATIVE_FACTS,
  INITIATIVE_FACT_KEYS,
  INITIATIVE_ORIGINS,
};
