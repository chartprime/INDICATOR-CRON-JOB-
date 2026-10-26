"use strict";

const { createHash } = require("node:crypto");
const { createHistoricalEventTap } = require("./historical-event-tap");
const { frameProblem } = require("./input-frames");

const SCHEMA = "historical-l2-level-event/1";
const UINT64 = 18_446_744_073_709_551_615n;
const INTEGER_FIELDS = new Set(["key", "size", "peakSize", "lastChangeTs", "added", "cancelled", "reclaimed",
  "traded", "tradedVisible", "hiddenTraded", "absorbed", "swept", "hiddenSwept", "hiddenWindows", "refills",
  "reloads", "lastSlice", "lastHiddenTs", "emptiedAt", "tests", "closestDistance", "firstSeenEngineMs"]);

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function key(value) {
  if (!Array.isArray(value) || value.length !== 4 || value.some((item) => typeof item !== "string"
      || !/^(0|[1-9]\d*)$/.test(item) || BigInt(item) > UINT64)) throw new Error("historical-level-events: exact cursor required");
  return value.map(BigInt);
}
function compare(a, b) {
  for (let index = 0; index < 4; index += 1) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}
function decimal(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(\.\d{1,12})?$/.test(value)) {
    throw new Error("historical-level-events: exact decimal string required");
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole + fraction.padEnd(12, "0"));
}
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function createHistoricalLevelEvents({ derivationId, instrumentId, seedKey, tickSize, depthLimit = 10,
  maxTrackedLevels = 8192, maxRowsPerCapture = 20_000, maxBytesPerCapture = 8 * 1024 * 1024 } = {}) {
  const seed = key(seedKey);
  const tick = decimal(tickSize);
  if (typeof derivationId !== "string" || !/^[a-f0-9]{64}$/.test(derivationId)
      || typeof instrumentId !== "string" || !instrumentId || instrumentId.length > 128 || tick <= 0n
      || !Number.isSafeInteger(depthLimit) || depthLimit < 1 || depthLimit > 10
      || !Number.isSafeInteger(maxTrackedLevels) || maxTrackedLevels < 20 || maxTrackedLevels > 8192
      || !Number.isSafeInteger(maxRowsPerCapture) || maxRowsPerCapture < 1 || maxRowsPerCapture > 20_000
      || !Number.isSafeInteger(maxBytesPerCapture) || maxBytesPerCapture < 256 || maxBytesPerCapture > 16 * 1024 * 1024) {
    throw new Error("historical-level-events: invalid identity, geometry or budget");
  }
  const segmentId = digest([SCHEMA, derivationId, instrumentId, seed.map(String)]);
  const tap = createHistoricalEventTap({ derivationId, instrumentId, seedKey });
  const records = new Map();
  let previous = { bid: new Map(), ask: new Map() };
  let lastKey = seed;
  let lastKnown = seed[0];
  let engineIdentity = null;
  let outputSeq = 0;
  let failed = false;
  let closed = false;
  let lastBest = null;
  let captureBytes = 0;

  function priceKey(price) {
    const scaled = decimal(price);
    if (scaled <= 0n || scaled % tick || scaled / tick > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("historical-level-events: off-grid or inexact price");
    }
    return Number(scaled / tick);
  }
  function normalize(values, side) {
    if (!Array.isArray(values) || !values.length || values.length > depthLimit) throw new Error("historical-level-events: bounded book required");
    const result = new Map();
    let prior = null;
    for (const [price, quantity] of values) {
      const at = priceKey(price);
      const size = decimal(quantity);
      if (size <= 0n || size % 1_000_000_000_000n || size / 1_000_000_000_000n > BigInt(Number.MAX_SAFE_INTEGER)
          || prior !== null && (side === "bid" ? at >= prior : at <= prior)) {
        throw new Error("historical-level-events: sorted integer-quantity book required");
      }
      result.set(at, { price, size: Number(size / 1_000_000_000_000n) });
      prior = at;
    }
    return result;
  }
  function emit(rows, context, type, record, payload, event = null, quality = null) {
    if (rows.length >= maxRowsPerCapture) throw new Error("historical-level-events: capture budget exceeded");
    const seq = outputSeq++;
    const row = { schema: SCHEMA, derivation_id: derivationId, instrument_id: instrumentId, segment_id: segmentId,
      event_id: digest([SCHEMA, segmentId, seq]), event_seq: seq, event_type: type,
      source_ns: String(context.source[0]), known_ns: String(context.known), known_key: context.source.map(String),
      observed_engine_ms: event?.observed_engine_ms ?? Number(context.source[0] / 1_000_000n),
      engine_seq: event?.event_seq ?? null, side: record?.side ?? null, price_key: record?.key ?? null,
      observation_id: record?.id ?? null, lifecycle_id: record?.life?.id ?? null,
      record_evidence_gap: record?.evidenceGap ?? false,
      evidence_quality: quality ?? (record && (!record.life || record.evidenceGap) ? "resting_unknown" : "observed_depth_inference"), payload };
    const bytes = Buffer.byteLength(JSON.stringify(row));
    captureBytes += bytes;
    if (bytes > 16_384 || captureBytes > maxBytesPerCapture) throw new Error("historical-level-events: row or capture byte budget exceeded");
    rows.push(freeze(row));
  }
  function ensure(side, at, context) {
    const id = `${side}:${at}`;
    let record = records.get(id);
    if (!record) {
      if (records.size >= maxTrackedLevels) throw new Error("historical-level-events: tracked level budget exceeded");
      record = { id: digest([SCHEMA, segmentId, "observation", side, at, context.source.map(String)]),
        side, key: at, life: null, ending: null, view: null, evidenceGap: false };
      records.set(id, record);
    }
    return record;
  }
  function begin(record, context, seeded) {
    if (record.life && !record.life.ended || record.ending !== null) throw new Error("historical-level-events: lifecycle active or ending unresolved");
    const previousId = record.life?.id ?? null;
    record.life = { id: digest([SCHEMA, record.id, "lifecycle", context.source.map(String)]),
      firstKey: context.source.map(String), ageUnknown: seeded, ended: false, verdict: null };
    return previousId;
  }
  function engineRows(engine, context, coverage, rows, touched) {
    for (const event of tap.drain(engine, { knownKey: context.source.map(String), knownNs: String(context.known), coverage })) {
      const payload = JSON.parse(event.payload);
      let record = event.side === null ? null : records.get(`${event.side}:${event.price_key}`);
      if (event.event_type === "trade") record = record ?? ensure(event.side, event.price_key, context);
      if (record && (!record.life || event.evidence_quality === "resting_unknown")) record.evidenceGap = true;
      if (event.event_type === "appeared") {
        record = record ?? ensure(event.side, event.price_key, context);
        const previousId = begin(record, context, false);
        emit(rows, context, "lifecycle_start", record, { age_unknown: false, first_key: record.life.firstKey,
          previous_lifecycle_id: previousId, size: payload.size, refill: payload.refill });
      } else if (event.event_type === "emptied") {
        if (!record?.life || record.life.ended) throw new Error("historical-level-events: emptying has no active lifecycle");
        record.life.ended = true;
        record.ending = record.life;
      } else if (event.event_type === "verdict") {
        if (!record?.ending || record.ending.verdict !== null) throw new Error("historical-level-events: verdict has no pending ending");
        record.ending.verdict = payload.endedBy;
        emit(rows, context, "engine_verdict", { ...record, life: record.ending }, payload, event, event.evidence_quality);
        record.ending = null;
        touched.add(`${record.side}:${record.key}`);
        continue;
      }
      if (event.side !== null && !record) throw new Error("historical-level-events: engine event lost its observation");
      emit(rows, context, `engine_${event.event_type}`, record, payload, event,
        !record?.life && event.side !== null ? "resting_unknown" : event.evidence_quality);
      if (record) touched.add(`${record.side}:${record.key}`);
      if (event.event_type === "coverage_exit") {
        emit(rows, context, "observation_end", record, { cause: "DEPTH_EXIT", pending_verdict: record.ending?.id ?? null });
        records.delete(`${record.side}:${record.key}`);
      }
    }
  }
  function context(engine, sourceKey, knownNs) {
    const source = key(sourceKey);
    if (typeof knownNs !== "string" || !/^(0|[1-9]\d*)$/.test(knownNs)) throw new Error("historical-level-events: exact knowledge time required");
    const known = BigInt(knownNs);
    if (known > UINT64 || known < source[0] || known < lastKnown || compare(source, lastKey) < 0
        || !engine || engineIdentity && engineIdentity !== engine || engine.clusterTicks !== 1
        || engine.tickSize !== Number(tickSize)) throw new Error("historical-level-events: engine identity, geometry or knowledge order changed");
    return { source, known };
  }
  function coverage(before, after = before) {
    return Object.fromEntries(["bid", "ask"].map((side) => {
      const keys = [...before[side].keys(), ...after[side].keys()];
      if (!keys.length) throw new Error("historical-level-events: observed coverage required");
      return [side, [Math.min(...keys), Math.max(...keys)]];
    }));
  }
  function capture(engine, { sourceKey, knownNs, bookFrame = null, pruned = false } = {}) {
    if (failed || closed) throw new Error("historical-level-events: failed or closed observer");
    try {
      captureBytes = 0;
      const at = context(engine, sourceKey, knownNs);
      if (!engineIdentity && (!bookFrame || compare(at.source, seed) !== 0)) throw new Error("historical-level-events: initial seed required");
      if (engineIdentity && (bookFrame ? compare(at.source, lastKey) <= 0 : compare(at.source, lastKey) !== 0)) {
        throw new Error("historical-level-events: input cursor must advance; prune keeps its source cursor");
      }
      if (typeof pruned !== "boolean" || !engine.live) throw new Error("historical-level-events: qualified live segment required");
      let next = previous;
      if (bookFrame) {
        if (frameProblem(bookFrame) || bookFrame.kind !== "book" || bookFrame.status !== "READY"
            || bookFrame.ts !== Number(at.source[0] / 1_000_000n)) throw new Error("historical-level-events: qualified source book required");
        next = { bid: normalize(bookFrame.book.bids, "bid"), ask: normalize(bookFrame.book.asks, "ask") };
        if ([...next.bid.keys()][0] >= [...next.ask.keys()][0]) throw new Error("historical-level-events: crossed source book");
        for (const [side, values] of [["bid", bookFrame.book.bids], ["ask", bookFrame.book.asks]]) {
          if (JSON.stringify(engine.ladder({ side, depth: depthLimit })) !== JSON.stringify(values.map(([price, size]) => [Number(price), Number(size)]))) {
            throw new Error("historical-level-events: source and engine books disagree");
          }
        }
      }
      const rows = [];
      const touched = new Set();
      if (!engineIdentity) emit(rows, at, "segment_open", null, { seed_key: seed.map(String), tick_size: tickSize, depth_limit: depthLimit });
      engineRows(engine, at, coverage(previous, next), rows, touched);
      if (bookFrame) {
        for (const side of ["bid", "ask"]) {
          const plural = side === "bid" ? "bids" : "asks";
          const lost = new Set((bookFrame.coverage?.unobserved[plural] ?? []).map(priceKey));
          const seeded = new Set((bookFrame.coverage?.preexisting[plural] ?? []).map(([price]) => priceKey(price)));
          for (const [price, level] of next[side]) {
            let record = records.get(`${side}:${price}`);
            if (!record?.life) {
              if (engineIdentity && !seeded.has(price)) throw new Error("historical-level-events: observed appearance missing from engine events");
              record = record ?? ensure(side, price, at);
              begin(record, at, true);
              emit(rows, at, "lifecycle_start", record, { age_unknown: true, first_key: record.life.firstKey,
                previous_lifecycle_id: null, size: level.size, refill: false });
            }
          }
          for (const price of new Set([...previous[side].keys(), ...next[side].keys()])) {
            if (lost.has(price)) continue;
            const before = previous[side].get(price);
            const after = next[side].get(price);
            if (before?.size === after?.size) continue;
            const record = records.get(`${side}:${price}`);
            if (!record?.life) throw new Error("historical-level-events: size change has no observed lifecycle");
            emit(rows, at, "level_size", record, { source_price: (after ?? before).price,
              previous_size: !engineIdentity || seeded.has(price) ? null : before?.size ?? 0, size: after?.size ?? 0 });
            touched.add(`${side}:${price}`);
          }
        }
        const best = { bid: [...next.bid.keys()][0], ask: [...next.ask.keys()][0] };
        if (JSON.stringify(best) !== JSON.stringify(lastBest)) {
          emit(rows, at, "quote", null, best);
          for (const side of ["bid", "ask"]) {
            touched.add(`${side}:${best[side]}`);
            if (lastBest) touched.add(`${side}:${lastBest[side]}`);
          }
          lastBest = best;
        }
      }
      if (pruned) for (const id of records.keys()) touched.add(id);
      for (const id of touched) {
        const record = records.get(id);
        if (!record) continue;
        const view = engine.level(record.side, record.key);
        if (!view) {
          emit(rows, at, "observation_end", record, { cause: "RECORD_EXPIRED", pending_verdict: record.ending?.id ?? null });
          records.delete(id);
          continue;
        }
        const { ageMs, ...state } = view;
        state.firstSeenEngineMs = engine.stats.lastTs - ageMs;
        for (const [field, value] of Object.entries(state)) if (typeof value === "number" && (!Number.isFinite(value)
            || INTEGER_FIELDS.has(field) && (!Number.isSafeInteger(value) || value < 0))) throw new Error("historical-level-events: inexact engine state");
        if (JSON.stringify(state) !== JSON.stringify(record.view)) {
          record.view = state;
          emit(rows, at, "engine_level_state", record, { representation: "engine-number; source sizes exact integer profile", state });
        }
      }
      engineIdentity = engine;
      previous = next;
      lastKey = at.source;
      lastKnown = at.known;
      return Object.freeze(rows);
    } catch (error) { failed = true; throw error; }
  }
  function close(engine, { sourceKey, knownNs, cause } = {}) {
    if (failed || closed || !engineIdentity) throw new Error("historical-level-events: failed, closed or unseeded observer");
    try {
      captureBytes = 0;
      const at = context(engine, sourceKey, knownNs);
      if (typeof cause !== "string" || !cause || cause.length > 128) throw new Error("historical-level-events: closure cause required");
      const rows = [];
      engineRows(engine, at, coverage(previous), rows, new Set());
      for (const record of records.values()) emit(rows, at, "observation_end", record,
        { cause, pending_verdict: record.ending?.id ?? null });
      emit(rows, at, "segment_close", null, { cause, records: records.size,
        unresolved_endings: [...records.values()].filter((record) => record.ending).length });
      records.clear();
      closed = true;
      return Object.freeze(rows);
    } catch (error) { failed = true; throw error; }
  }
  return Object.freeze({ capture, close, segmentId, get nextSeq() { return outputSeq; }, get trackedLevels() { return records.size; } });
}

module.exports = { SCHEMA, createHistoricalLevelEvents };
