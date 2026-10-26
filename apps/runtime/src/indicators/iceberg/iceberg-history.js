const { MAX_ICEBERG_ID_LENGTH: MAX_ID_LENGTH, ICEBERG_KINDS, ICEBERG_CONFIDENCES, ICEBERG_SIDES, ICEBERG_STATUSES, ICEBERG_ORIGINS } = require("../../server/iceberg-wire-fields");
const { MAX_WIRE_MAGNITUDE: MAX_MAGNITUDE, MAX_EQUITY_TRADE_SIZE: MAX_EQUITY_SIZE, MAX_VALID_EPOCH_MS: MAX_EPOCH_MS } = require("../../server/wire-fields");

const ICEBERG_HISTORY_VERSION = 1;
const DEFAULT_MAX_ICEBERGS = 5_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_SPANS = 64;
const KINDS = new Set(ICEBERG_KINDS);
const CONFIDENCES = new Set(ICEBERG_CONFIDENCES);
const SIDES = new Set(ICEBERG_SIDES);
const STATUSES = new Set(ICEBERG_STATUSES);
const ORIGINS = new Set(ICEBERG_ORIGINS);
const SETTLED = new Set(["filled", "pulled", "replaced", "interrupted", "ended"]);
const WIRE_FIELDS = Object.freeze(["id", "kind", "confidence", "side", "price", "display", "tranches", "executed", "startedAt", "markedAt", "updatedAt", "status", "origin"]);

function isEpoch(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_EPOCH_MS;
}

function wireIcebergOf(update) {
  return Object.freeze({
    id: update.id,
    kind: update.kind,
    confidence: update.confidence,
    side: update.side,
    price: update.price,
    display: update.display,
    tranches: update.tranches,
    executed: update.executed,
    startedAt: update.startedAt,
    markedAt: update.kind === "native" ? update.firstRefillAt : update.markedAt,
    updatedAt: update.updatedAt,
    status: update.status,
    origin: "runtime",
  });
}

function validWireIceberg(entry, sizeCeiling = MAX_EQUITY_SIZE) {
  if (entry === null || typeof entry !== "object") return false;
  const keys = Object.keys(entry);
  if (keys.length !== WIRE_FIELDS.length || !WIRE_FIELDS.every((field) => Object.hasOwn(entry, field))) return false;
  if (typeof entry.id !== "string" || entry.id.length === 0 || entry.id.length > MAX_ID_LENGTH) return false;
  if (!KINDS.has(entry.kind) || !CONFIDENCES.has(entry.confidence) || !SIDES.has(entry.side) || !STATUSES.has(entry.status) || !ORIGINS.has(entry.origin)) return false;
  if (!Number.isFinite(entry.price) || entry.price <= 0 || entry.price > MAX_MAGNITUDE) return false;
  if (!Number.isFinite(entry.display) || entry.display < 0 || entry.display > sizeCeiling) return false;
  if (!Number.isFinite(entry.executed) || entry.executed < 0 || entry.executed > sizeCeiling) return false;
  if (!Number.isSafeInteger(entry.tranches) || entry.tranches < 1) return false;
  if (!isEpoch(entry.startedAt) || !isEpoch(entry.markedAt) || !isEpoch(entry.updatedAt)) return false;
  return entry.markedAt >= entry.startedAt && entry.updatedAt >= entry.markedAt;
}

function sameIceberg(a, b) {
  return WIRE_FIELDS.every((field) => a[field] === b[field]);
}

function byMark(a, b) {
  return a.markedAt - b.markedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function byAge(a, b) {
  return a.updatedAt - b.updatedAt || byMark(a, b);
}

function createIcebergHistory({ maxAgeMs, maxIcebergs = DEFAULT_MAX_ICEBERGS, maxBytes = DEFAULT_MAX_BYTES, minProbableRatio = 1, maxSpans = DEFAULT_MAX_SPANS, sizeCeiling = MAX_EQUITY_SIZE } = {}) {
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) throw new Error("iceberg-history: maxAgeMs must be a positive safe integer");
  if (!Number.isSafeInteger(maxIcebergs) || maxIcebergs <= 0) throw new Error("iceberg-history: maxIcebergs must be a positive safe integer");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("iceberg-history: maxBytes must be a positive safe integer");
  if (!Number.isFinite(minProbableRatio) || minProbableRatio < 1) throw new Error("iceberg-history: minProbableRatio must be a number of at least 1");
  if (!Number.isSafeInteger(maxSpans) || maxSpans <= 0) throw new Error("iceberg-history: maxSpans must be a positive safe integer");
  if (!Number.isFinite(sizeCeiling) || sizeCeiling <= 0) throw new Error("iceberg-history: sizeCeiling must be a positive number");
  let icebergs = new Map();
  let sorted = null;
  let dirty = false;
  let revision = 0;
  let spans = [];
  let trimmedBefore = 0;
  const counters = { added: 0, updated: 0, ignored: 0, pruned: 0, trimmed: 0, belowFloor: 0 };

  function ordered() {
    if (sorted === null) sorted = Object.freeze([...icebergs.values()].sort(byMark));
    return sorted;
  }

  function touch() {
    sorted = null;
    dirty = true;
    revision += 1;
  }

  function spanOf(from, to) {
    return isEpoch(from) && isEpoch(to) && from < to ? [from, to] : null;
  }

  function merged(list) {
    const out = [];
    for (const [from, to] of [...list].sort((a, b) => a[0] - b[0])) {
      const last = out[out.length - 1];
      if (last !== undefined && from <= last[1]) {
        if (to > last[1]) last[1] = to;
        continue;
      }
      out.push([from, to]);
    }
    while (out.length > maxSpans) out.shift();
    return out;
  }

  function sameSpans(a, b) {
    return a.length === b.length && a.every((span, index) => span[0] === b[index][0] && span[1] === b[index][1]);
  }

  function clipSpansBefore(ts) {
    const next = [];
    for (const [from, to] of spans) {
      if (to <= ts) continue;
      next.push([Math.max(from, ts), to]);
    }
    if (sameSpans(next, spans)) return;
    spans = next;
    touch();
  }

  function watch(from, to) {
    if (spanOf(from, to) === null) throw new Error("iceberg-history: watch expects an epoch-ms span with from before to");
    const span = spanOf(Math.max(from, trimmedBefore), to);
    if (span === null) return;
    const next = merged([...spans, span]);
    if (sameSpans(next, spans)) return;
    spans = next;
    touch();
  }

  function coverage() {
    return Object.freeze(spans.map((span) => Object.freeze([...span])));
  }

  function coverageUntil(until) {
    return Object.freeze(spans.filter(([from]) => from < until).map(([from, to]) => Object.freeze([from, Math.min(to, until)])));
  }

  function uncovered(from, to) {
    if (spanOf(from, to) === null) throw new Error("iceberg-history: uncovered expects an epoch-ms span with from before to");
    const gaps = [];
    let cursor = from;
    for (const [start, end] of spans) {
      if (end <= cursor) continue;
      if (start >= to) break;
      if (start > cursor) gaps.push(Object.freeze([cursor, start]));
      cursor = Math.max(cursor, end);
      if (cursor >= to) break;
    }
    if (cursor < to) gaps.push(Object.freeze([cursor, to]));
    return Object.freeze(gaps);
  }

  function loadCoverage(list) {
    if (!Array.isArray(list)) return false;
    const valid = [];
    for (const entry of list) {
      if (!Array.isArray(entry) || entry.length !== 2) return false;
      const span = spanOf(entry[0], entry[1]);
      if (span === null) return false;
      valid.push(span);
    }
    spans = merged(valid);
    return true;
  }

  function findNear(like, toleranceMs) {
    if (!like || typeof like !== "object" || !Number.isSafeInteger(toleranceMs) || toleranceMs < 0) throw new Error("iceberg-history: findNear expects an iceberg-like record and a non-negative tolerance");
    for (const entry of icebergs.values()) {
      if (entry.kind === like.kind && entry.side === like.side && entry.price === like.price && Math.abs(entry.markedAt - like.markedAt) <= toleranceMs) return entry;
    }
    return null;
  }

  function oldest(count) {
    if (count > 1) return [...icebergs.values()].sort(byAge).slice(0, count);
    let first = null;
    for (const entry of icebergs.values()) if (first === null || byAge(entry, first) < 0) first = entry;
    return first === null ? [] : [first];
  }

  function dropOldest(count) {
    if (count <= 0) return 0;
    const victims = oldest(count);
    let newestMark = -1;
    for (const victim of victims) {
      icebergs.delete(victim.id);
      if (victim.markedAt > newestMark) newestMark = victim.markedAt;
    }
    if (victims.length > 0) {
      touch();
      counters.trimmed += victims.length;
      trimmedBefore = Math.max(trimmedBefore, newestMark + 1);
      clipSpansBefore(newestMark + 1);
    }
    return victims.length;
  }

  function heldFrom() {
    if (icebergs.size < maxIcebergs) return trimmedBefore;
    let oldestEnd = Number.POSITIVE_INFINITY;
    for (const entry of icebergs.values()) if (entry.updatedAt < oldestEnd) oldestEnd = entry.updatedAt;
    return Math.max(trimmedBefore, oldestEnd + 1);
  }

  function record(entry) {
    if (!validWireIceberg(entry, sizeCeiling)) throw new Error("iceberg-history: record expects a valid wire iceberg");
    if (!SETTLED.has(entry.status)) {
      counters.ignored += 1;
      return { added: 0, updated: 0, ignored: 1 };
    }
    const known = icebergs.get(entry.id);
    if (known === undefined) {
      icebergs.set(entry.id, Object.freeze({ ...entry }));
      counters.added += 1;
      touch();
      dropOldest(icebergs.size - maxIcebergs);
      return { added: 1, updated: 0, ignored: 0 };
    }
    if (sameIceberg(known, entry)) return { added: 0, updated: 0, ignored: 0 };
    if (entry.updatedAt < known.updatedAt) {
      counters.ignored += 1;
      return { added: 0, updated: 0, ignored: 1 };
    }
    icebergs.set(entry.id, Object.freeze({ ...entry }));
    counters.updated += 1;
    touch();
    return { added: 0, updated: 1, ignored: 0 };
  }

  function prune(at) {
    const cutoff = at - maxAgeMs;
    let dropped = 0;
    for (const [id, entry] of icebergs) {
      if (entry.updatedAt >= cutoff) continue;
      icebergs.delete(id);
      dropped += 1;
    }
    if (dropped > 0) {
      touch();
      counters.pruned += dropped;
    }
    clipSpansBefore(cutoff);
    return dropped;
  }

  function serializedBytes() {
    return JSON.stringify(toJSON()).length;
  }

  function trimToBytes(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("iceberg-history: trimToBytes expects a positive safe integer");
    const target = bytes * 0.9;
    let dropped = 0;
    while (icebergs.size > 0 && serializedBytes() > target) {
      const step = Math.max(1, Math.ceil(icebergs.size * 0.1));
      dropped += dropOldest(step);
    }
    return dropped;
  }

  function list() {
    return ordered();
  }

  function toJSON() {
    return { version: ICEBERG_HISTORY_VERSION, icebergs: ordered().map((entry) => ({ ...entry })) };
  }

  function load(saved) {
    if (!saved || typeof saved !== "object" || saved.version !== ICEBERG_HISTORY_VERSION || !Array.isArray(saved.icebergs)) return false;
    const next = new Map();
    let thin = 0;
    for (const saved_ of saved.icebergs) {
      const entry = saved_ !== null && typeof saved_ === "object" && saved_.origin === undefined ? { ...saved_, origin: "runtime" } : saved_;
      if (!validWireIceberg(entry, sizeCeiling) || !SETTLED.has(entry.status) || next.has(entry.id)) return false;
      if (entry.kind === "probable" && entry.confidence !== "weak" && entry.executed < minProbableRatio * entry.display) {
        thin += 1;
        continue;
      }
      next.set(entry.id, Object.freeze({ ...entry }));
    }
    icebergs = next;
    sorted = null;
    dirty = false;
    dropOldest(icebergs.size - maxIcebergs);
    counters.belowFloor += thin;
    dirty = thin > 0;
    return true;
  }

  function markSaved() {
    dirty = false;
  }

  function clear() {
    if (icebergs.size === 0) return;
    icebergs = new Map();
    touch();
  }

  return Object.freeze({
    record,
    prune,
    trimToBytes,
    list,
    toJSON,
    load,
    watch,
    coverage,
    coverageUntil,
    uncovered,
    heldFrom,
    loadCoverage,
    findNear,
    markSaved,
    clear,
    get size() {
      return icebergs.size;
    },
    get dirty() {
      return dirty;
    },
    get maxBytes() {
      return maxBytes;
    },
    get sizeCeiling() {
      return sizeCeiling;
    },
    get revision() {
      return revision;
    },
    stats() {
      return Object.freeze({ ...counters, icebergs: icebergs.size });
    },
  });
}

module.exports = { createIcebergHistory, wireIcebergOf, validWireIceberg, ICEBERG_HISTORY_VERSION, WIRE_FIELDS, ORIGINS, MAX_ID_LENGTH, DEFAULT_MAX_ICEBERGS, DEFAULT_MAX_BYTES, DEFAULT_MAX_SPANS };
