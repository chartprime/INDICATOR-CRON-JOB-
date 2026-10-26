"use strict";

const { MAX_WIRE_MAGNITUDE } = require("../../server/frames");

const DEFAULT_FLOOR_PERCENTILE = 0.9;
const DEFAULT_MIN_FLOOR = 0;
const DEFAULT_WARMUP_SAMPLES = 100;
const DEFAULT_CALIBRATION_SIZE = 2_000;
const DEFAULT_RECALIBRATE_MS = 10_000;
const DEFAULT_GAP_MS = 5_000;
const DEFAULT_GAP_BANDS = 1;
const DEFAULT_KEEP_ENDED_MS = 20 * 60_000;
const DEFAULT_MAX_EVENTS = 200;

function assertNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`aggressive-orders-tracker: ${field} must be a non-negative safe integer`);
}
function assertPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`aggressive-orders-tracker: ${field} must be a positive safe integer`);
}

function ringPercentile(ring, filled, p) {
  if (filled === 0) return 0;
  const sorted = Float64Array.from(ring.subarray(0, filled)).sort();
  return sorted[Math.min(filled - 1, Math.max(0, Math.round(p * (filled - 1))))];
}

function createAggressiveOrdersTracker({
  rowClusters = 1,
  floor = null,
  floorPercentile = DEFAULT_FLOOR_PERCENTILE,
  minFloor = DEFAULT_MIN_FLOOR,
  warmupSamples = DEFAULT_WARMUP_SAMPLES,
  calibrationSize = DEFAULT_CALIBRATION_SIZE,
  recalibrateMs = DEFAULT_RECALIBRATE_MS,
  gapMs = DEFAULT_GAP_MS,
  gapBands = DEFAULT_GAP_BANDS,
  keepEndedMs = DEFAULT_KEEP_ENDED_MS,
  maxEvents = DEFAULT_MAX_EVENTS,
} = {}) {
  assertPositiveInteger(rowClusters, "rowClusters");
  if (floor !== null && (!Number.isFinite(floor) || floor <= 0)) throw new Error("aggressive-orders-tracker: floor must be a positive finite number or null");
  if (floor !== null && floor > MAX_WIRE_MAGNITUDE) throw new Error(`aggressive-orders-tracker: floor must not exceed the wire magnitude ${MAX_WIRE_MAGNITUDE}`);
  if (!(floorPercentile > 0 && floorPercentile <= 1)) throw new Error("aggressive-orders-tracker: floorPercentile must be in (0, 1]");
  if (!Number.isFinite(minFloor) || minFloor < 0) throw new Error("aggressive-orders-tracker: minFloor must be a non-negative finite number");
  if (minFloor > MAX_WIRE_MAGNITUDE) throw new Error(`aggressive-orders-tracker: minFloor must not exceed the wire magnitude ${MAX_WIRE_MAGNITUDE}`);
  assertNonNegativeInteger(warmupSamples, "warmupSamples");
  assertPositiveInteger(calibrationSize, "calibrationSize");
  assertPositiveInteger(recalibrateMs, "recalibrateMs");
  assertPositiveInteger(gapMs, "gapMs");
  assertNonNegativeInteger(gapBands, "gapBands");
  assertPositiveInteger(keepEndedMs, "keepEndedMs");
  assertPositiveInteger(maxEvents, "maxEvents");

  let clusters = rowClusters;
  const lastTotals = { buy: new Map(), sell: new Map() };
  let started = false;
  const ring = new Float64Array(calibrationSize);
  let ringFilled = 0;
  let ringNext = 0;
  let calibrated = 0;
  let calibratedAt = -Infinity;
  let samplesSeen = 0;

  const live = { buy: [], sell: [] };
  let ended = [];
  let nextId = 1;
  let changed = false;

  function currentFloor() {
    if (floor !== null) return floor;
    if (samplesSeen < warmupSamples) return 0;
    return Math.min(MAX_WIRE_MAGNITUDE, Math.max(minFloor, calibrated));
  }

  function observe(value) {
    ring[ringNext] = value;
    ringNext = (ringNext + 1) % calibrationSize;
    if (ringFilled < calibrationSize) ringFilled += 1;
    samplesSeen += 1;
  }

  function recalibrate(ts) {
    if (floor !== null || ts - calibratedAt < recalibrateMs || ringFilled < warmupSamples) return;
    calibrated = ringPercentile(ring, ringFilled, floorPercentile);
    calibratedAt = ts;
  }

  function deltasFor(side, records) {
    const totals = new Map();
    const printed = new Map();
    const last = lastTotals[side];
    for (const record of records) {
      const now = record.traded ?? 0;
      totals.set(record.key, now);
      const before = last.get(record.key);
      const delta = before === undefined ? (started ? now : 0) : now >= before ? now - before : now;
      if (delta > 0) printed.set(record.key, (printed.get(record.key) ?? 0) + delta);
    }
    lastTotals[side] = totals;
    return printed;
  }

  function update({ ts, snapshot, rowClusters: perUpdate }) {
    if (perUpdate !== undefined) {
      assertPositiveInteger(perUpdate, "rowClusters");
      clusters = perUpdate;
    }
    changed = false;
    const printed = {
      buy: deltasFor("buy", snapshot.asks),
      sell: deltasFor("sell", snapshot.bids),
    };
    started = true;
    for (const side of ["buy", "sell"]) {
      const still = [];
      for (const cluster of live[side]) {
        if (ts - cluster.lastTs < gapMs) {
          still.push(cluster);
          continue;
        }
        observe(cluster.volume);
        if (cluster.floor !== null) {
          cluster.endTs = cluster.lastTs;
          ended.push(cluster);
          changed = true;
        }
      }
      live[side] = still;
    }
    recalibrate(ts);
    const entry = currentFloor();
    for (const side of ["buy", "sell"]) {
      for (const cluster of live[side]) cluster.tick = 0;
      const fresh = [];
      for (const [key, volume] of [...printed[side].entries()].sort((a, b) => a[0] - b[0])) {
        const cluster = live[side].find((candidate) => key >= candidate.key && key < candidate.key + candidate.keys);
        if (cluster) {
          cluster.volume += volume;
          cluster.tick += volume;
          cluster.lastTs = ts;
          if (cluster.floor !== null) changed = true;
          continue;
        }
        const last = fresh.at(-1);
        if (last && key - (last.key + last.keys - 1) - 1 <= gapBands) {
          last.keys = key - last.key + 1;
          last.volume += volume;
          last.tick += volume;
        } else {
          fresh.push({ id: nextId, side, key, keys: 1, startTs: ts, endTs: null, lastTs: ts, volume, peak: 0, tick: volume, floor: null });
          nextId += 1;
        }
      }
      live[side].push(...fresh);
      for (const cluster of live[side]) {
        if (cluster.tick > cluster.peak) {
          cluster.peak = cluster.tick;
          if (cluster.floor !== null) changed = true;
        }
        if (cluster.floor === null && entry > 0 && cluster.volume >= entry) {
          cluster.floor = entry;
          changed = true;
        }
      }
    }
    const before = ended.length;
    ended = ended.filter((cluster) => ts - cluster.endTs <= keepEndedMs);
    if (ended.length > maxEvents) ended = ended.slice(ended.length - maxEvents);
    if (ended.length !== before) changed = true;
    return changed;
  }

  function rowsOf(cluster) {
    const row = Math.floor(cluster.key / clusters);
    const span = Math.floor((cluster.key + cluster.keys - 1) / clusters) - row + 1;
    return { row, span };
  }

  function view(cluster) {
    const { row, span } = rowsOf(cluster);
    return Object.freeze({
      side: cluster.side,
      row,
      span,
      startTs: cluster.startTs,
      endTs: cluster.endTs,
      volume: Math.min(MAX_WIRE_MAGNITUDE, cluster.volume),
      peak: Math.min(MAX_WIRE_MAGNITUDE, cluster.peak),
      floor: Math.min(MAX_WIRE_MAGNITUDE, cluster.floor),
    });
  }

  function events() {
    const open = [...live.buy, ...live.sell].filter((cluster) => cluster.floor !== null).sort((a, b) => b.startTs - a.startTs || b.id - a.id);
    const recent = ended.slice().sort((a, b) => b.endTs - a.endTs || b.id - a.id);
    return [...open, ...recent].slice(0, maxEvents).sort((a, b) => a.startTs - b.startTs || a.id - b.id).map(view);
  }

  function adopt(list) {
    if (!Array.isArray(list)) throw new Error("aggressive-orders-tracker: adopt expects an array of events");
    let seed = 0;
    for (const item of list) {
      if (item.side !== "buy" && item.side !== "sell") throw new Error("aggressive-orders-tracker: adopted event needs a side");
      const endTs = Math.max(item.startTs, item.endTs ?? item.startTs);
      const itemFloor = Number.isFinite(item.floor) && item.floor > 0 ? item.floor : currentFloor();
      ended.push({
        id: nextId, side: item.side, key: item.row * clusters, keys: (item.span ?? 1) * clusters, startTs: item.startTs, endTs, lastTs: endTs,
        volume: item.volume ?? 0, peak: item.peak ?? item.volume ?? 0, tick: 0, floor: itemFloor,
      });
      nextId += 1;
      if (itemFloor > seed) seed = itemFloor;
    }
    if (floor === null && samplesSeen < warmupSamples && seed > 0) {
      calibrated = seed;
      samplesSeen = warmupSamples;
    }
    ended.sort((a, b) => a.endTs - b.endTs);
    if (ended.length > maxEvents) ended = ended.slice(ended.length - maxEvents);
    changed = true;
  }

  function clear() {
    live.buy = [];
    live.sell = [];
    ended = [];
    lastTotals.buy = new Map();
    lastTotals.sell = new Map();
    started = false;
  }

  return Object.freeze({
    update,
    events,
    adopt,
    clear,
    get floor() {
      return currentFloor();
    },
    get samplesSeen() {
      return samplesSeen;
    },
    get liveCount() {
      return live.buy.length + live.sell.length;
    },
  });
}

module.exports = {
  createAggressiveOrdersTracker,
  ringPercentile,
  DEFAULT_FLOOR_PERCENTILE,
  DEFAULT_WARMUP_SAMPLES,
  DEFAULT_CALIBRATION_SIZE,
  DEFAULT_RECALIBRATE_MS,
  DEFAULT_GAP_MS,
  DEFAULT_GAP_BANDS,
  DEFAULT_KEEP_ENDED_MS,
  DEFAULT_MAX_EVENTS,
};
