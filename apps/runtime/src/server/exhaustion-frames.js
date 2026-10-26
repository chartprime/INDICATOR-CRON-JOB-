"use strict";

const { selectionFrame, dxfeedSelectionFrame } = require("./frames");
const { MAX_VALID_EPOCH_MS, MAX_WIRE_MAGNITUDE, decimalToFiniteNumber } = require("./wire-fields");
const { CANDLE_MS, SIDES, STATUSES, READINGS, RAW_KEYS, RAW_CAP } = require("../indicators/exhaustion/exhaustion-engine");

const MAX_EXHAUSTION_SHADES = 500;
const MAX_EXHAUSTION_ID_LENGTH = 96;
const MAX_EXHAUSTION_INTENSITY = 3;
const MAX_EXHAUSTION_SCORE = 6;
const MAX_EXHAUSTION_VALUE = 1_000_000;
const MAX_EXHAUSTION_RAW = RAW_CAP;
const EXHAUSTION_BOOK_BANDS = Object.freeze([0, 1, 2]);
const EXHAUSTION_RAW_KEYS = RAW_KEYS;
const SORTED_RAW_KEYS = Object.freeze([...EXHAUSTION_RAW_KEYS].sort());
const EXHAUSTION_CANDLE_MS = CANDLE_MS;
const EXHAUSTION_SIDES = SIDES;
const EXHAUSTION_STATUSES = STATUSES;
const EXHAUSTION_ORIGINS = Object.freeze(["runtime", "host", "stored"]);
const EXHAUSTION_READINGS = READINGS;
const EXHAUSTION_FINAL_STATUSES = Object.freeze(["held", "broke", "interrupted"]);
const FINAL_STATUSES = new Set(EXHAUSTION_FINAL_STATUSES);
const SORTED_READINGS = Object.freeze([...EXHAUSTION_READINGS].sort());

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

function readings(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field}: must be the six readings`);
  exactReadingKeys(value, field);
  for (const key of EXHAUSTION_READINGS) if (typeof value[key] !== "boolean") throw new Error(`${field}.${key}: must be a boolean`);
  return Object.freeze(Object.fromEntries(EXHAUSTION_READINGS.map((key) => [key, value[key]])));
}

function exactReadingKeys(value, field) {
  const keys = Object.keys(value).sort();
  if (keys.length !== SORTED_READINGS.length || keys.some((key, i) => key !== SORTED_READINGS[i])) throw new Error(`${field}: must carry exactly ${EXHAUSTION_READINGS.join(", ")}`);
}

function rawValues(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field}: must be the twelve raw keys`);
  const keys = Object.keys(value).sort();
  if (keys.length !== SORTED_RAW_KEYS.length || keys.some((key, i) => key !== SORTED_RAW_KEYS[i])) throw new Error(`${field}: must carry exactly ${EXHAUSTION_RAW_KEYS.join(", ")}`);
  for (const key of EXHAUSTION_RAW_KEYS) {
    const entry = value[key];
    if (entry !== null && (typeof entry !== "number" || !Number.isFinite(entry) || Math.abs(entry) > MAX_EXHAUSTION_RAW)) throw new Error(`${field}.${key}: must be null or a finite number within ${MAX_EXHAUSTION_RAW}`);
  }
  if (value.bookBand !== null && !EXHAUSTION_BOOK_BANDS.includes(value.bookBand)) throw new Error(`${field}.bookBand: must be null or one of ${EXHAUSTION_BOOK_BANDS.join(", ")}`);
  return Object.freeze(Object.fromEntries(EXHAUSTION_RAW_KEYS.map((key) => [key, value[key]])));
}

function readingValues(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field}: must be the six reading values`);
  exactReadingKeys(value, field);
  for (const key of EXHAUSTION_READINGS) {
    const entry = value[key];
    if (entry !== null && (typeof entry !== "number" || !Number.isFinite(entry) || Math.abs(entry) > MAX_EXHAUSTION_VALUE)) throw new Error(`${field}.${key}: must be null or a finite number within ${MAX_EXHAUSTION_VALUE} either side of zero`);
  }
  return Object.freeze(Object.fromEntries(EXHAUSTION_READINGS.map((key) => [key, value[key]])));
}

function wireShade(entry, field) {
  if (entry === null || typeof entry !== "object") throw new Error(`${field}: must be a shade`);
  if (typeof entry.id !== "string" || entry.id.length === 0 || entry.id.length > MAX_EXHAUSTION_ID_LENGTH) {
    throw new Error(`${field}.id: must be a string of 1 to ${MAX_EXHAUSTION_ID_LENGTH} characters`);
  }
  const status = oneOf(entry.status, EXHAUSTION_STATUSES, `${field}.status`);
  const startTs = epochMs(entry.startTs, `${field}.startTs`);
  const endTs = epochMs(entry.endTs, `${field}.endTs`);
  const extremeTs = epochMs(entry.extremeTs, `${field}.extremeTs`);
  const legStartTs = epochMs(entry.legStartTs, `${field}.legStartTs`);
  const updatedAt = epochMs(entry.updatedAt, `${field}.updatedAt`);
  if (endTs <= startTs) throw new Error(`${field}.endTs: must follow startTs`);
  if (legStartTs > extremeTs) throw new Error(`${field}.legStartTs: must not follow extremeTs`);
  if (extremeTs >= endTs) throw new Error(`${field}.extremeTs: must precede endTs`);
  if (updatedAt < startTs) throw new Error(`${field}.updatedAt: must not precede startTs`);
  const final = FINAL_STATUSES.has(status);
  if (final) {
    if (epochMs(entry.judgedAt, `${field}.judgedAt`) < endTs) throw new Error(`${field}.judgedAt: must not precede endTs`);
  } else if (entry.judgedAt !== null) {
    throw new Error(`${field}.judgedAt: must be null until the shade is judged`);
  }
  return Object.freeze({
    id: entry.id,
    candleMs: oneOf(entry.candleMs, EXHAUSTION_CANDLE_MS, `${field}.candleMs`),
    side: oneOf(entry.side, EXHAUSTION_SIDES, `${field}.side`),
    status,
    intensity: bounded(entry.intensity, 1, MAX_EXHAUSTION_INTENSITY, `${field}.intensity`),
    score: bounded(entry.score, 0, MAX_EXHAUSTION_SCORE, `${field}.score`),
    readings: readings(entry.readings, `${field}.readings`),
    values: readingValues(entry.values, `${field}.values`),
    raw: rawValues(entry.raw, `${field}.raw`),
    startTs,
    endTs,
    extremeTs,
    extremePrice: decimalToFiniteNumber(entry.extremePrice, `${field}.extremePrice`, { ceiling: MAX_WIRE_MAGNITUDE }),
    legStartTs,
    legStartPrice: decimalToFiniteNumber(entry.legStartPrice, `${field}.legStartPrice`, { ceiling: MAX_WIRE_MAGNITUDE }),
    legSize: decimalToFiniteNumber(entry.legSize, `${field}.legSize`, { ceiling: MAX_WIRE_MAGNITUDE }),
    efficiency: decimalToFiniteNumber(entry.efficiency, `${field}.efficiency`, { ceiling: 1 }),
    atr: decimalToFiniteNumber(entry.atr, `${field}.atr`, { ceiling: MAX_WIRE_MAGNITUDE }),
    judgedAt: final ? entry.judgedAt : null,
    updatedAt,
    origin: oneOf(entry.origin, EXHAUSTION_ORIGINS, `${field}.origin`),
  });
}

function byStart(a, b) {
  return a.startTs - b.startTs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function exhaustionShadesFrame(identity, { ts, seq, reset, shades, liveSince, loading = null }) {
  const wire = identityFields(identity, "exhaustionShadesFrame");
  epochMs(ts, "exhaustionShadesFrame.ts");
  counter(seq, "exhaustionShadesFrame.seq");
  epochMs(liveSince, "exhaustionShadesFrame.liveSince");
  if (loading !== null) epochMs(loading, "exhaustionShadesFrame.loading");
  if (typeof reset !== "boolean") throw new Error("exhaustionShadesFrame.reset: must be a boolean");
  if (!Array.isArray(shades) || shades.length > MAX_EXHAUSTION_SHADES) {
    throw new Error(`exhaustionShadesFrame.shades: must be an array of at most ${MAX_EXHAUSTION_SHADES} shades`);
  }
  if (!reset && shades.length === 0) throw new Error("exhaustionShadesFrame: an increment must carry at least one shade");
  const ids = new Set();
  let previous = null;
  const wireShades = shades.map((entry, index) => {
    const checked = wireShade(entry, `exhaustionShadesFrame.shades[${index}]`);
    if (ids.has(checked.id)) throw new Error(`exhaustionShadesFrame.shades[${index}].id: ids must be unique within a frame`);
    if (previous !== null && byStart(previous, checked) > 0) throw new Error(`exhaustionShadesFrame.shades[${index}]: shades must be in start order`);
    ids.add(checked.id);
    previous = checked;
    return checked;
  });
  return Object.freeze({ ...wire, type: "exhaustion_shades", ts, seq, reset, shades: Object.freeze(wireShades), liveSince, loading });
}

function exhaustionShadesFrames(identity, ts, shades, { chunk = MAX_EXHAUSTION_SHADES, liveSince, loading = null } = {}) {
  if (!Number.isSafeInteger(chunk) || chunk <= 0 || chunk > MAX_EXHAUSTION_SHADES) {
    throw new Error(`exhaustionShadesFrames: chunk must be an integer from 1 to ${MAX_EXHAUSTION_SHADES}`);
  }
  if (!Array.isArray(shades)) throw new Error("exhaustionShadesFrames: shades must be an array");
  const frames = [];
  for (let start = 0; start < shades.length || frames.length === 0; start += chunk) {
    frames.push(exhaustionShadesFrame(identity, { ts, seq: frames.length, reset: start === 0, shades: shades.slice(start, start + chunk), liveSince, loading }));
  }
  return frames;
}

module.exports = {
  exhaustionShadesFrame,
  exhaustionShadesFrames,
  byStart,
  MAX_EXHAUSTION_SHADES,
  MAX_EXHAUSTION_ID_LENGTH,
  MAX_EXHAUSTION_INTENSITY,
  MAX_EXHAUSTION_SCORE,
  MAX_EXHAUSTION_RAW,
  EXHAUSTION_RAW_KEYS,
  EXHAUSTION_BOOK_BANDS,
  MAX_EXHAUSTION_VALUE,
  EXHAUSTION_CANDLE_MS,
  EXHAUSTION_SIDES,
  EXHAUSTION_STATUSES,
  EXHAUSTION_FINAL_STATUSES,
  EXHAUSTION_ORIGINS,
  EXHAUSTION_READINGS,
};
