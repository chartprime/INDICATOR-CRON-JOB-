"use strict";

const { selectionFrame, dxfeedSelectionFrame } = require("./frames");
const { MAX_VALID_EPOCH_MS, MAX_WIRE_MAGNITUDE, decimalToFiniteNumber, sizeCeilingFor } = require("./wire-fields");
const { MAX_ICEBERG_ID_LENGTH, ICEBERG_KINDS, ICEBERG_CONFIDENCES, ICEBERG_SIDES, ICEBERG_STATUSES, ICEBERG_ORIGINS } = require("./iceberg-wire-fields");

const MAX_ICEBERG_ORDERS = 500;
const MAX_WATCHED_SPANS = 64;

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

function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw new Error(`${field}: must be one of ${allowed.join(", ")}`);
  return value;
}

function wireIceberg(entry, field, ceiling) {
  if (entry === null || typeof entry !== "object") throw new Error(`${field}: must be an iceberg`);
  if (typeof entry.id !== "string" || entry.id.length === 0 || entry.id.length > MAX_ICEBERG_ID_LENGTH) {
    throw new Error(`${field}.id: must be a string of 1 to ${MAX_ICEBERG_ID_LENGTH} characters`);
  }
  const startedAt = epochMs(entry.startedAt, `${field}.startedAt`);
  const markedAt = epochMs(entry.markedAt, `${field}.markedAt`);
  const updatedAt = epochMs(entry.updatedAt, `${field}.updatedAt`);
  if (markedAt < startedAt) throw new Error(`${field}.markedAt: must not precede startedAt`);
  if (updatedAt < markedAt) throw new Error(`${field}.updatedAt: must not precede markedAt`);
  if (!Number.isSafeInteger(entry.tranches) || entry.tranches < 1) throw new Error(`${field}.tranches: must be a positive integer`);
  return Object.freeze({
    id: entry.id,
    kind: oneOf(entry.kind, ICEBERG_KINDS, `${field}.kind`),
    confidence: oneOf(entry.confidence, ICEBERG_CONFIDENCES, `${field}.confidence`),
    side: oneOf(entry.side, ICEBERG_SIDES, `${field}.side`),
    price: decimalToFiniteNumber(entry.price, `${field}.price`, { ceiling: MAX_WIRE_MAGNITUDE }),
    display: decimalToFiniteNumber(entry.display, `${field}.display`, { allowZero: true, ceiling }),
    tranches: entry.tranches,
    executed: decimalToFiniteNumber(entry.executed, `${field}.executed`, { allowZero: true, ceiling }),
    startedAt,
    markedAt,
    updatedAt,
    status: oneOf(entry.status, ICEBERG_STATUSES, `${field}.status`),
    origin: oneOf(entry.origin, ICEBERG_ORIGINS, `${field}.origin`),
  });
}

function watchedSpans(value, field) {
  if (!Array.isArray(value) || value.length > MAX_WATCHED_SPANS) throw new Error(`${field}: must be an array of at most ${MAX_WATCHED_SPANS} spans`);
  let last = -1;
  return Object.freeze(value.map((span, index) => {
    if (!Array.isArray(span) || span.length !== 2) throw new Error(`${field}[${index}]: must be a from, to pair`);
    const from = epochMs(span[0], `${field}[${index}][0]`);
    const to = epochMs(span[1], `${field}[${index}][1]`);
    if (from >= to || from < last) throw new Error(`${field}[${index}]: spans must run forward, ascending and disjoint`);
    last = to;
    return Object.freeze([from, to]);
  }));
}

function icebergOrdersFrame(identity, { ts, seq, reset, icebergs, watched = [], liveSince }) {
  const wire = identityFields(identity, "icebergOrdersFrame");
  epochMs(ts, "icebergOrdersFrame.ts");
  counter(seq, "icebergOrdersFrame.seq");
  epochMs(liveSince, "icebergOrdersFrame.liveSince");
  if (typeof reset !== "boolean") throw new Error("icebergOrdersFrame.reset: must be a boolean");
  if (!Array.isArray(icebergs) || icebergs.length > MAX_ICEBERG_ORDERS) {
    throw new Error(`icebergOrdersFrame.icebergs: must be an array of at most ${MAX_ICEBERG_ORDERS} icebergs`);
  }
  if (!reset && icebergs.length === 0) throw new Error("icebergOrdersFrame: an increment must carry at least one iceberg");
  const ceiling = sizeCeilingFor(identity);
  const ids = new Set();
  let previousMark = -1;
  const wireIcebergs = icebergs.map((entry, index) => {
    const checked = wireIceberg(entry, `icebergOrdersFrame.icebergs[${index}]`, ceiling);
    if (ids.has(checked.id)) throw new Error(`icebergOrdersFrame.icebergs[${index}].id: ids must be unique within a frame`);
    if (checked.markedAt < previousMark) throw new Error(`icebergOrdersFrame.icebergs[${index}]: icebergs must be in mark order`);
    ids.add(checked.id);
    previousMark = checked.markedAt;
    return checked;
  });
  return Object.freeze({ ...wire, type: "iceberg_orders", ts, seq, reset, icebergs: Object.freeze(wireIcebergs), watched: watchedSpans(watched, "icebergOrdersFrame.watched"), liveSince });
}

function icebergOrdersFrames(identity, ts, icebergs, { chunk = MAX_ICEBERG_ORDERS, watched = [], liveSince } = {}) {
  if (!Number.isSafeInteger(chunk) || chunk <= 0 || chunk > MAX_ICEBERG_ORDERS) {
    throw new Error(`icebergOrdersFrames: chunk must be an integer from 1 to ${MAX_ICEBERG_ORDERS}`);
  }
  if (!Array.isArray(icebergs)) throw new Error("icebergOrdersFrames: icebergs must be an array");
  const frames = [];
  for (let start = 0; start < icebergs.length || frames.length === 0; start += chunk) {
    frames.push(icebergOrdersFrame(identity, { ts, seq: frames.length, reset: start === 0, icebergs: icebergs.slice(start, start + chunk), watched, liveSince }));
  }
  return frames;
}

module.exports = {
  ICEBERG_ORIGINS,
  icebergOrdersFrame,
  icebergOrdersFrames,
  MAX_ICEBERG_ORDERS,
  MAX_ICEBERG_ID_LENGTH,
  MAX_WATCHED_SPANS,
  ICEBERG_KINDS,
  ICEBERG_CONFIDENCES,
  ICEBERG_SIDES,
  ICEBERG_STATUSES,
};
