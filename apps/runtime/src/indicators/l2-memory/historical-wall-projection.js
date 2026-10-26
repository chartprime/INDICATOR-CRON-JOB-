"use strict";

const { createWallService } = require("./wall-service");
const { sampleLiquidityColumn } = require("../passive_liquidity/liquidity-sampler");
const { historicalWallProfile } = require("./historical-wall-profile");

const SHA = /^[a-f0-9]{64}$/;
const UINT64 = 18_446_744_073_709_551_615n;
const MAX_PENDING_EVENTS = 65_536;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const ENGINE_TYPES = new Set(["segment", "appeared", "shrank", "emptied", "verdict", "hidden", "coverage_exit", "trade"]);
const TYPES = new Set(["segment_open", "segment_close", "lifecycle_start", "level_size", "quote", "observation_end",
  "engine_level_state", ...[...ENGINE_TYPES].map((type) => `engine_${type}`)]);

function exact(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,19})$/.test(value) || BigInt(value) > UINT64) {
    throw new Error("historical-wall-projection: exact nanoseconds required");
  }
  return BigInt(value);
}
function immutable(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function safe(value) {
  if (typeof value === "number") return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  if (Array.isArray(value)) return value.every(safe);
  if (value && typeof value === "object") return Object.values(value).every(safe);
  return value === null || typeof value === "string" || typeof value === "boolean";
}

function createHistoricalWallProjection({ derivationId, instrumentId, tickSize, sampleMs = 1000, rowClusters = 1, windowRows = 128,
  referenceRows = 128, fold = "sum", trackerOptions } = {}) {
  const tick = Number(tickSize);
  if (!SHA.test(derivationId ?? "") || typeof instrumentId !== "string" || !instrumentId || instrumentId.length > 128) {
    throw new Error("historical-wall-projection: identity required");
  }
  const settings = historicalWallProfile({ tickSize, sampleMs, rowClusters, windowRows, referenceRows, fold, trackerOptions });
  const records = new Map();
  let segment = null, nextSeq = 0, head = 0, pending = [], lastKnown = null, lastSource = null, lastSample = null;
  let quote = null, closed = false, failed = false, sealedBefore = null, pendingBytes = 0;
  const trades = [], wallTrades = [];
  const engine = {
    priceFor: (key) => key * tick,
    eventHead: () => head,
    events: (from) => {
      if (from !== head - pending.length) throw new Error("historical-wall-projection: event consumer lost its prefix");
      const events = pending; pending = []; pendingBytes = 0;
      return { events, nextSeq: head, missed: 0 };
    },
  };
  const service = createWallService({ ...settings.profile.tracker, engine,
    onTrades: (values) => trades.push(...values), onWallTrade: (value) => wallTrades.push(value) });

  function consume(rows) {
    if (failed || closed) throw new Error("historical-wall-projection: failed or closed projection");
    try {
      if (!Array.isArray(rows) || rows.length === 0 || rows.length > 20_000
          || Buffer.byteLength(JSON.stringify(rows)) > 8 * 1024 * 1024) throw new Error("historical-wall-projection: capture budget exceeded");
      for (const row of rows) {
        const known = exact(row.known_ns);
        if (!Array.isArray(row.known_key) || row.known_key.length !== 4) throw new Error("historical-wall-projection: source prefix required");
        const source = row.known_key.map(exact);
        const firstDifference = lastSource === null ? -1 : source.findIndex((part, index) => part !== lastSource[index]);
        if (row.schema !== "historical-l2-level-event/1" || row.derivation_id !== derivationId || row.instrument_id !== instrumentId
            || !SHA.test(row.segment_id ?? "") || row.event_seq !== nextSeq || !TYPES.has(row.event_type)
            || lastKnown !== null && known < lastKnown || source[0] > known || row.source_ns !== row.known_key[0]
            || lastSample !== null && known <= lastSample || sealedBefore !== null && known < sealedBefore
            || firstDifference !== -1 && source[firstDifference] < lastSource[firstDifference] || !row.payload || !safe(row.payload)) {
          throw new Error("historical-wall-projection: incomplete, changed or unordered event prefix");
        }
        if (segment === null) {
          if (row.event_type !== "segment_open" || row.payload.tick_size !== tickSize) throw new Error("historical-wall-projection: segment seed required");
          segment = row.segment_id;
        } else if (row.segment_id !== segment || row.event_type === "segment_open") throw new Error("historical-wall-projection: segment changed");
        const address = `${row.side}:${row.price_key}`;
        if (row.event_type === "engine_level_state") {
          const state = row.payload.state;
          if (!state || state.side !== row.side || state.key !== row.price_key || !["bid", "ask"].includes(state.side)
              || !Number.isSafeInteger(state.key) || state.key < 0 || !Number.isSafeInteger(state.firstSeenEngineMs)
              || state.firstSeenEngineMs < 0 || BigInt(state.firstSeenEngineMs) * 1_000_000n > known
              || !["size", "traded", "cancelled", "absorbed"].every((name) => Number.isSafeInteger(state[name]) && state[name] >= 0)) {
            throw new Error("historical-wall-projection: invalid engine level state");
          }
          if (!records.has(address) && records.size >= 8192) throw new Error("historical-wall-projection: level budget exceeded");
          records.set(address, immutable(JSON.parse(JSON.stringify(state))));
        } else if (row.event_type === "observation_end") records.delete(address);
        else if (row.event_type === "quote") {
          if (!["bid", "ask"].every((side) => Number.isSafeInteger(row.payload[side]) && row.payload[side] > 0)
              || row.payload.bid >= row.payload.ask) throw new Error("historical-wall-projection: invalid quote");
          quote = { ...row.payload };
        } else if (row.event_type === "segment_close") {
          closed = true; records.clear(); quote = null; service.clear(); pending = []; pendingBytes = 0;
        }
        if (row.event_type.startsWith("engine_") && row.event_type !== "engine_level_state") {
          const event = row.payload;
          if (event.type !== row.event_type.slice(7) || event.seq !== head || event.ts !== row.observed_engine_ms
              || !Number.isSafeInteger(event.ts) || event.ts < 0 || BigInt(event.ts) * 1_000_000n > known) {
            throw new Error("historical-wall-projection: incomplete engine event prefix");
          }
          const encoded = JSON.stringify(event), bytes = Buffer.byteLength(encoded);
          if (pending.length >= MAX_PENDING_EVENTS || pendingBytes + bytes > MAX_PENDING_BYTES) {
            throw new Error("historical-wall-projection: pending engine event budget exceeded");
          }
          pending.push(immutable(JSON.parse(encoded))); pendingBytes += bytes; head += 1;
        }
        if (closed && row !== rows.at(-1)) throw new Error("historical-wall-projection: rows follow closure");
        nextSeq += 1; lastKnown = known; lastSource = source;
      }
    } catch (error) { failed = true; throw error; }
  }

  function sealBefore(nextRow) {
    if (failed || closed) throw new Error("historical-wall-projection: failed or closed projection");
    try {
      const known = exact(nextRow.known_ns);
      if (lastKnown === null || known <= lastKnown || sealedBefore !== null && known < sealedBefore
          || nextRow.schema !== "historical-l2-level-event/1" || nextRow.derivation_id !== derivationId
          || nextRow.instrument_id !== instrumentId || nextRow.segment_id !== segment || nextRow.event_seq !== nextSeq) {
        throw new Error("historical-wall-projection: contiguous next record required to seal knowledge prefix");
      }
      sealedBefore = known;
    } catch (error) { failed = true; throw error; }
  }

  function sample(knownNs) {
    if (failed || closed) throw new Error("historical-wall-projection: failed or closed projection");
    try {
      const known = exact(knownNs), ts = Number(known / 1_000_000n);
      if (lastKnown === null || known < lastKnown || known !== lastKnown && (sealedBefore === null || known >= sealedBefore)
          || lastSample !== null && known <= lastSample || !quote) {
        throw new Error("historical-wall-projection: sample must follow the complete current prefix");
      }
      const values = [...records.values()];
      const snapshot = { bestBidKey: quote.bid, bestAskKey: quote.ask,
        bids: values.filter((record) => record.side === "bid"), asks: values.filter((record) => record.side === "ask") };
      const column = sampleLiquidityColumn(snapshot, { ts, rowClusters, windowRows, fold });
      service.update({ ts, column, snapshot, rowClusters, referenceRows });
      const lifecycle = service.drainLifecycle();
      if (lifecycle.dropped) throw new Error("historical-wall-projection: lifecycle budget exceeded");
      const output = { schema: "historical-l2-wall-view/2", profile_id: settings.id, derivation_id: derivationId, instrument_id: instrumentId,
        segment_id: segment, known_ns: knownNs, observed_through_ns: String(lastKnown),
        through_known_key: lastSource.map(String), through_event_seq: nextSeq - 1, row_width: tick * rowClusters,
        walls: service.walls(), lifecycle: lifecycle.records, trades: trades.splice(0), wall_trades: wallTrades.splice(0) };
      if (!safe(output) || Buffer.byteLength(JSON.stringify(output)) > 4 * 1024 * 1024) throw new Error("historical-wall-projection: output budget exceeded");
      lastSample = known;
      return immutable(output);
    } catch (error) { failed = true; throw error; }
  }
  return Object.freeze({ consume, sample, sealBefore, settings, get closed() { return closed; }, get nextSeq() { return nextSeq; } });
}

module.exports = { createHistoricalWallProjection };
