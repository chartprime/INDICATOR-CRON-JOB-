"use strict";

const { createHash } = require("node:crypto");

const SCHEMA = "historical-l2-engine-event/1";
const TYPES = new Set(["segment", "appeared", "shrank", "emptied", "verdict", "hidden", "coverage_exit", "trade"]);

function exactKey(value) {
  if (!Array.isArray(value) || value.length !== 4 || value.some((part) =>
    !(typeof part === "string" && /^(0|[1-9]\d*)$/.test(part))
      && !(typeof part === "number" && Number.isSafeInteger(part) && part >= 0))) {
    throw new Error("historical-event-tap: exact four-field source key required");
  }
  const key = value.map((part) => BigInt(part));
  if (key.some((part) => part > 18_446_744_073_709_551_615n)) {
    throw new Error("historical-event-tap: source key exceeds unsigned 64-bit range");
  }
  return key;
}

function compare(a, b) {
  for (let index = 0; index < 4; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function createHistoricalEventTap({ derivationId, instrumentId, seedKey, maxEventsPerDrain = 8192 } = {}) {
  if (typeof derivationId !== "string" || !/^[a-f0-9]{64}$/.test(derivationId)
      || typeof instrumentId !== "string" || !instrumentId || instrumentId.length > 128
      || !Number.isSafeInteger(maxEventsPerDrain) || maxEventsPerDrain < 1 || maxEventsPerDrain > 8192) {
    throw new Error("historical-event-tap: invalid identity or drain budget");
  }
  const seed = exactKey(seedKey);
  const segmentId = digest([SCHEMA, derivationId, instrumentId, seed.map(String)]);
  let engineIdentity = null;
  let fromSeq = 0;
  let lastKey = seed;
  let lastKnown = seed[0];
  let restingUnknown = new Set();

  function drain(engine, { knownKey, knownNs, coverage } = {}) {
    const key = exactKey(knownKey);
    if (typeof knownNs !== "string" || !/^(0|[1-9]\d*)$/.test(knownNs)) {
      throw new Error("historical-event-tap: exact knowledge nanoseconds required");
    }
    const at = BigInt(knownNs);
    if (at > 18_446_744_073_709_551_615n || compare(key, lastKey) < 0 || at < lastKnown || at < key[0]) {
      throw new Error("historical-event-tap: knowledge or source cursor regresses");
    }
    if (!engine || typeof engine.events !== "function" || engineIdentity && engine !== engineIdentity) {
      throw new Error("historical-event-tap: one engine per source-anchored segment required");
    }
    for (const side of ["bid", "ask"]) {
      const bounds = coverage?.[side];
      if (!Array.isArray(bounds) || bounds.length !== 2 || !bounds.every(Number.isSafeInteger)
          || bounds[0] > bounds[1]) throw new Error("historical-event-tap: observed coverage bounds required");
    }
    const batch = engine.events(fromSeq);
    if (batch.missed || batch.events.length > maxEventsPerDrain
        || batch.nextSeq !== fromSeq + batch.events.length
        || !engineIdentity && (batch.events[0]?.seq !== 0 || batch.events[0]?.type !== "segment"
          || batch.events[0]?.state !== "LIVE")) {
      throw new Error("historical-event-tap: missing or over-budget engine events");
    }
    const unknown = new Set(restingUnknown);
    const rows = batch.events.map((event, index) => {
      if (event.seq !== fromSeq + index || !TYPES.has(event.type) || !Number.isSafeInteger(event.ts)
          || event.ts < 0 || BigInt(event.ts) * 1_000_000n > at
          || event.key !== undefined && (!Number.isSafeInteger(event.key) || !["bid", "ask"].includes(event.side))) {
        throw new Error("historical-event-tap: invalid event identity or time");
      }
      const level = `${event.side}:${event.key}`;
      const inRange = event.key === undefined || event.key >= coverage[event.side][0] && event.key <= coverage[event.side][1];
      if (event.type === "trade" && !inRange) unknown.add(level);
      if (event.type === "appeared") unknown.delete(level);
      if (unknown.size > 8192) throw new Error("historical-event-tap: unknown resting evidence budget exceeded");
      const observed = inRange && !unknown.has(level);
      const payload = JSON.stringify(event);
      if (Buffer.byteLength(payload) > 16_384 || Object.values(event).some((value) =>
        typeof value === "number" && !Number.isFinite(value))) throw new Error("historical-event-tap: invalid payload");
      if (event.type === "coverage_exit") unknown.delete(level);
      return Object.freeze({ schema: SCHEMA, derivation_id: derivationId, instrument_id: instrumentId,
        segment_id: segmentId, event_id: digest([SCHEMA, segmentId, event.seq]), event_seq: event.seq,
        event_type: event.type, observed_engine_ms: event.ts, known_ns: knownNs, known_key: Object.freeze(key.map(String)),
        side: event.side ?? null, price_key: event.key ?? null,
        evidence_quality: observed ? "observed_depth_inference" : "resting_unknown", payload });
    });
    engineIdentity = engine;
    fromSeq = batch.nextSeq;
    lastKey = key;
    lastKnown = at;
    restingUnknown = unknown;
    return Object.freeze(rows);
  }

  return Object.freeze({ drain, segmentId, get nextSeq() { return fromSeq; } });
}

module.exports = { SCHEMA, createHistoricalEventTap };
