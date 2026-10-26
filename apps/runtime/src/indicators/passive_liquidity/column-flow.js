"use strict";

const { quantizeSize, rowOf, DEFAULT_SIZE_DIGITS } = require("./liquidity-sampler");
const { createPrintFloor } = require("./print-floor");
const { selectPrintsWithFloor } = require("./bounded-prints");
const { MAX_WIRE_MAGNITUDE } = require("../../server/wire-fields");

const DEFAULT_MAX_PRINTS = 64;
const PRINT_WINDOW_COLUMNS = 2;
const DEFAULT_FLOOR_SHARE = 0.02;
const DEFAULT_FLOOR_WINDOW = 4096;
const DEFAULT_FLOOR_MIN_SAMPLES = 200;

function assertPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`column-flow: ${field} must be a positive safe integer`);
}

function createColumnFlow({
  keyFor,
  rowClusters,
  columnMs,
  maxPrints = DEFAULT_MAX_PRINTS,
  floorShare = DEFAULT_FLOOR_SHARE,
  floorWindow = DEFAULT_FLOOR_WINDOW,
  floorMinSamples = DEFAULT_FLOOR_MIN_SAMPLES,
  sizeDigits = DEFAULT_SIZE_DIGITS,
} = {}) {
  if (typeof keyFor !== "function") throw new Error("column-flow: keyFor must be a function");
  assertPositiveInteger(rowClusters, "rowClusters");
  assertPositiveInteger(columnMs, "columnMs");
  assertPositiveInteger(maxPrints, "maxPrints");
  assertPositiveInteger(floorWindow, "floorWindow");
  assertPositiveInteger(floorMinSamples, "floorMinSamples");
  if (!(floorShare > 0 && floorShare < 1)) throw new Error("column-flow: floorShare must be in (0, 1)");

  const printFloor = createPrintFloor({ window: floorWindow, share: floorShare, minSamples: floorMinSamples });
  let pending = [];
  let late = 0;
  let dropped = 0;
  let clipped = 0;

  function push(print) {
    if (!(print.size > 0) || !(print.price > 0) || (print.side !== "buy" && print.side !== "sell")) return;
    const size = Math.min(print.size, MAX_WIRE_MAGNITUDE);
    if (size < print.size) clipped += 1;
    pending.push(size === print.size ? print : { ...print, size });
    printFloor.push(size);
  }

  function floor() {
    return printFloor.value();
  }

  function prune(ts) {
    pending = pending.filter((print) => {
      if (print.ts > ts - PRINT_WINDOW_COLUMNS * columnMs) return true;
      dropped += 1;
      return false;
    });
  }

  function take(column) {
    const kept = [];
    const later = [];
    for (const print of pending) {
      if (print.ts > column.ts) later.push(print);
      else if (print.ts > column.ts - PRINT_WINDOW_COLUMNS * columnMs) {
        if (print.ts <= column.ts - columnMs) late += 1;
        kept.push(print);
      } else dropped += 1;
    }
    pending = later;
    const span = column.hi - column.lo + 1;
    const buy = new Float64Array(span);
    const sell = new Float64Array(span);
    for (const print of kept) {
      const row = rowOf(keyFor(print.price), rowClusters);
      if (row < column.lo || row > column.hi) continue;
      (print.side === "buy" ? buy : sell)[row - column.lo] += print.size;
    }
    const entries = (side) => {
      const out = [];
      for (let i = 0; i < span; i += 1) {
        if (!(side[i] > 0)) continue;
        const size = quantizeSize(side[i], sizeDigits);
        if (size > MAX_WIRE_MAGNITUDE) clipped += 1;
        out.push([i, Math.min(size, MAX_WIRE_MAGNITUDE)]);
      }
      return out;
    };
    const selected = selectPrintsWithFloor(kept, floor(), maxPrints);
    return Object.freeze({
      ...column,
      buy: entries(buy),
      sell: entries(sell),
      prints: selected.prints.map((print) => Object.freeze({ ts: print.ts, price: print.price, size: print.size, side: print.side, id: print.id })),
      printsFloor: selected.floor,
    });
  }

  return Object.freeze({
    push,
    take,
    floor,
    prune,
    get pending() {
      return pending.length;
    },
    get late() {
      return late;
    },
    get dropped() {
      return dropped;
    },
    get clipped() {
      return clipped;
    },
  });
}

module.exports = { createColumnFlow, PRINT_WINDOW_COLUMNS, DEFAULT_MAX_PRINTS, DEFAULT_FLOOR_SHARE, DEFAULT_FLOOR_WINDOW, DEFAULT_FLOOR_MIN_SAMPLES };
