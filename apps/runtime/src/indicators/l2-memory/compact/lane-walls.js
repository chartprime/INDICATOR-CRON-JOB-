"use strict";

const { createLargeLevelTracker } = require("../../passive_liquidity/large-level-tracker");
const { MAX_LANES } = require("./lane-geometry");

const LANE_ID_BASE = 10_000_000;

function packRecords(records) {
  const out = new Float64Array(records.length * 4);
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    out[i * 4] = record.key;
    out[i * 4 + 1] = record.size;
    out[i * 4 + 2] = record.traded ?? 0;
    out[i * 4 + 3] = record.cancelled ?? 0;
  }
  return out;
}

function unpackRecords(packed) {
  const out = new Array(packed.length / 4);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = { key: packed[i * 4], size: packed[i * 4 + 1], traded: packed[i * 4 + 2], cancelled: packed[i * 4 + 3] };
  }
  return out;
}

function laneWallId(lane, id) {
  return lane * LANE_ID_BASE + id;
}

function createLaneWallTrackers({ lanes, trackerOptions }) {
  if (!Array.isArray(lanes)) throw new Error("lane-walls: lanes must be an array");
  if (!trackerOptions || typeof trackerOptions !== "object") throw new Error("lane-walls: trackerOptions are required");
  const trackers = new Map();
  for (const lane of lanes) {
    if (!Number.isSafeInteger(lane.k) || lane.k < 1 || lane.k > MAX_LANES) throw new Error(`lane-walls: lane k must be an integer from 1 to ${MAX_LANES}`);
    if (!Number.isSafeInteger(lane.rowClusters) || lane.rowClusters <= 0) throw new Error("lane-walls: each lane needs positive integer rowClusters");
    trackers.set(lane.k, { k: lane.k, rowClusters: lane.rowClusters, tracker: createLargeLevelTracker(trackerOptions) });
  }

  function update({ lane, ts, column, bids, asks, referenceRows = Infinity }) {
    const entry = trackers.get(lane);
    if (entry === undefined) throw new Error(`lane-walls: no tracker for lane ${lane}`);
    return entry.tracker.update({ ts, column, snapshot: { bids, asks }, rowClusters: entry.rowClusters, referenceRows });
  }

  function walls(lane) {
    const entry = trackers.get(lane);
    if (entry === undefined) throw new Error(`lane-walls: no tracker for lane ${lane}`);
    return entry.tracker.levels({ withId: true }).map((level) => Object.freeze({ ...level, id: laneWallId(lane, level.id), lane, detail: null }));
  }

  function clear() {
    for (const entry of trackers.values()) entry.tracker.clear();
  }

  return Object.freeze({ update, walls, clear, lanes: () => [...trackers.keys()] });
}

module.exports = { createLaneWallTrackers, packRecords, unpackRecords, laneWallId, LANE_ID_BASE };
