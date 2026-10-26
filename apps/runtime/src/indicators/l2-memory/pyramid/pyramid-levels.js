"use strict";

const zlib = require("node:zlib");
const { createDeepFolder, encodeAfter, decodeColumn } = require("../../passive_liquidity/liquidity-history");

const WINDOW_MS = 300_000;
const BASE_COLUMN_MS = 1_000;
const LEVELS_MS = Object.freeze([10_000, 30_000, 60_000, 300_000]);
const BASE_LEVEL_MS = LEVELS_MS[0];
const WINDOW_COLUMNS = WINDOW_MS / BASE_LEVEL_MS;
const WINDOW_STATES = Object.freeze({ COVERED: "COVERED", PARTIAL: "PARTIAL", NO_DATA: "NO_DATA", FAILED: "FAILED" });

function windowStart(ts) {
  return Math.floor(ts / WINDOW_MS) * WINDOW_MS;
}

function isLevel(levelMs) {
  return LEVELS_MS.includes(levelMs);
}

function foldLevels(base) {
  const levels = new Map([[BASE_LEVEL_MS, base.slice()]]);
  for (const levelMs of LEVELS_MS.slice(1)) {
    const folder = createDeepFolder({ deepColumnMs: levelMs });
    const out = [];
    for (const column of base) {
      const done = folder.feed(column);
      if (done) out.push(done);
    }
    const last = folder.flush();
    if (last) out.push(last);
    levels.set(levelMs, out);
  }
  return levels;
}

function windowState(baseColumns) {
  if (baseColumns >= WINDOW_COLUMNS) return WINDOW_STATES.COVERED;
  return baseColumns > 0 ? WINDOW_STATES.PARTIAL : WINDOW_STATES.NO_DATA;
}

function windowCoverage(base, windowTs) {
  if (base.length !== WINDOW_COLUMNS) return base.length === 0 ? WINDOW_STATES.NO_DATA : WINDOW_STATES.PARTIAL;
  for (let i = 0; i < base.length; i += 1) {
    if (base[i].ts !== windowTs + i * BASE_LEVEL_MS) return WINDOW_STATES.PARTIAL;
  }
  return WINDOW_STATES.COVERED;
}

function encodeWindow(columns) {
  const wires = [];
  let prev = null;
  for (const column of columns) {
    wires.push(encodeAfter(prev, column));
    prev = column;
  }
  return wires;
}

function decodeWindow(wires) {
  const columns = [];
  let prev = null;
  for (const wire of wires) {
    prev = decodeColumn(prev, wire);
    columns.push(prev);
  }
  return columns;
}

function packWindow(columns) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(encodeWindow(columns)), "utf8"));
}

function unpackWindowText(blob) {
  return zlib.gunzipSync(blob).toString("utf8");
}

module.exports = {
  WINDOW_MS,
  BASE_COLUMN_MS,
  LEVELS_MS,
  BASE_LEVEL_MS,
  WINDOW_COLUMNS,
  WINDOW_STATES,
  windowStart,
  isLevel,
  foldLevels,
  windowState,
  windowCoverage,
  encodeWindow,
  decodeWindow,
  packWindow,
  unpackWindowText,
};
